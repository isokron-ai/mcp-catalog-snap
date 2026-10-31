/**
 * Black-box CLI tests: spawn dist/cli.js (built by `pretest`) and assert on
 * exit codes and output. Uses snapshot files only — no servers.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { buildSnapshot, serializeSnapshot, type RawCapture } from '../src/snapshot.js';
import { VERSION } from '../src/version.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function run(args: string[], cwd?: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: cwd ?? tmpdir(), timeout: 30_000 });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

const raw: RawCapture = {
  server: { name: 'demo', version: '1.0.0' },
  protocolVersion: '2025-06-18',
  tools: [
    { name: 'a', description: 'A.', inputSchema: { type: 'object', properties: { x: { type: 'string', description: 'x' } } } },
    { name: 'b', description: 'B.', inputSchema: { type: 'object' } },
  ],
  prompts: [],
  resourceTemplates: [],
};

describe('cli', () => {
  let dir: string;
  let a: string;
  let b: string;
  let c: string;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcs-cli-'));
    a = join(dir, 'a.json');
    b = join(dir, 'b.json');
    c = join(dir, 'c.json');
    writeFileSync(a, serializeSnapshot(buildSnapshot(raw, { capturedAt: '2026-01-01T00:00:00.000Z' })));
    writeFileSync(b, serializeSnapshot(buildSnapshot({ ...raw, server: { name: 'demo', version: '1.0.1' } })));
    const mutated = JSON.parse(JSON.stringify(raw)) as RawCapture;
    (mutated.tools[1] as { description: string }).description = 'B, reworded.';
    writeFileSync(c, serializeSnapshot(buildSnapshot(mutated)));
  });

  it('--version and help exit 0', () => {
    expect(run(['--version'])).toMatchObject({ code: 0, stdout: `${VERSION}\n` });
    expect(run(['version']).stdout).toBe(`${VERSION}\n`);
    const h = run(['help']);
    expect(h.code).toBe(0);
    expect(h.stdout).toContain('Usage:');
    expect(h.stdout).toContain(`mcp-catalog-snap ${VERSION}`);
    expect(run([]).code).toBe(0);
  });

  it('unknown command exits 2 with help on stderr', () => {
    const r = run(['frobnicate']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unknown command "frobnicate"');
    expect(r.stderr).toContain('Usage:');
  });

  it('diff of identical catalogs exits 0 (different capture time / server version is not drift)', () => {
    const r = run(['diff', a, b]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('catalog: identical');
  });

  it('diff of a mutated description exits 1 and names the path', () => {
    const r = run(['diff', a, c]);
    expect(r.code).toBe(1);
    expect(r.stdout).toContain('~ b  [description-only]');
    expect(r.stdout).toContain('- "B."');
    expect(r.stdout).toContain('+ "B, reworded."');
    expect(r.stdout).toContain('DRIFT: 1 reason(s)');
  });

  it('diff --ignore-descriptions waives it (exit 0) and --json is parseable', () => {
    expect(run(['diff', a, c, '--ignore-descriptions']).code).toBe(0);
    const r = run(['diff', a, c, '--json']);
    expect(r.code).toBe(1);
    const parsed = JSON.parse(r.stdout) as { drift: boolean; verdict: { reasons: string[] } };
    expect(parsed.drift).toBe(true);
    expect(parsed.verdict.reasons).toEqual(['tool description changed: b (/description)']);
  });

  it('diff with a missing or malformed file exits 2', () => {
    expect(run(['diff', a]).code).toBe(2);
    expect(run(['diff', a, join(dir, 'missing.json')]).code).toBe(2);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{"format":"x"}');
    const r = run(['diff', a, bad]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('unsupported format');
  });

  it('hash FILE prints the stored fingerprint', () => {
    const r = run(['hash', a]);
    expect(r.code).toBe(0);
    const stored = (JSON.parse(readFileSync(a, 'utf8')) as { sha256: string }).sha256;
    expect(r.stdout.trim()).toBe(stored);
  });

  it('check / snapshot / hash with no target and no config exit 2 with a hint', () => {
    for (const cmd of ['check', 'snapshot', 'hash']) {
      const r = run([cmd], dir);
      expect(r.code, cmd).toBe(2);
      expect(r.stderr, cmd).toMatch(/\.mcp-catalog\.json/);
    }
    expect(run(['check', '--config', join(dir, 'nope.json')], dir).stderr).toContain('config not found');
  });

  it('rejects --url together with a -- command, and a bad --timeout', () => {
    expect(run(['check', '--url', 'http://127.0.0.1:1/mcp', '--', 'node']).code).toBe(2);
    const r = run(['hash', '--timeout', 'soon', '--', 'node']);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('--timeout expects a positive number');
  });

  it('fails cleanly (exit 2) when a Streamable HTTP endpoint is unreachable', () => {
    const r = run(['hash', '--url', 'http://127.0.0.1:9/mcp', '--timeout', '3000']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/^error: /);
  });
});
