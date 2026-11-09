/**
 * Annotation-aware drift (dogfood CS-1/2). A read-only baseline checked
 * against a server whose read-only mode failed open (github-mcp-server
 * issue 3747: `GITHUB_READ_ONLY=yes` ignored) printed "+19 added" with no
 * write/destructive marker, and `--allow-additions` passed it (exit 0).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { diffCatalogs, evaluate, toolSafety } from '../src/diff.js';
import { normalizeCatalog } from '../src/snapshot.js';

import { runActionCheck } from './helpers/action.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const HOSTILE = fileURLToPath(new URL('./fixtures/servers/hostile-stdio.mjs', import.meta.url));
const SRV = ['--', process.execPath, HOSTILE];

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', HOME: cwd, MODE: 'readonly', ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function baseline(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-ro-'));
  expect(cli(['snapshot', '--name', 'gh', ...SRV], dir, { READ_ONLY: '1' }).code).toBe(0);
  return dir;
}

describe('toolSafety', () => {
  it('readOnlyHint true is read-only; otherwise destructiveHint absent counts as destructive (spec default)', () => {
    expect(toolSafety({ name: 'a', inputSchema: {}, annotations: { readOnlyHint: true } })).toBe('read-only');
    expect(toolSafety({ name: 'a', inputSchema: {}, annotations: { readOnlyHint: false, destructiveHint: false } })).toBe('write');
    expect(toolSafety({ name: 'a', inputSchema: {}, annotations: { destructiveHint: true } })).toBe('destructive');
    expect(toolSafety({ name: 'a', inputSchema: {} })).toBe('destructive');
    expect(toolSafety({ name: 'a', inputSchema: {}, annotations: { readOnlyHint: 'true' } })).toBe('destructive');
  });

  it('diff marks added tools and tools that became less safe; allowAdditions waives only read-only additions', () => {
    const t = (name: string, annotations?: unknown) => ({ name, inputSchema: { type: 'object' }, ...(annotations ? { annotations } : {}) });
    const before = normalizeCatalog({ tools: [t('get', { readOnlyHint: true }), t('list', { readOnlyHint: true })], prompts: [], resourceTemplates: [] });
    const after = normalizeCatalog({
      tools: [t('get', { readOnlyHint: true }), t('list', { readOnlyHint: false }), t('search', { readOnlyHint: true }), t('merge', { readOnlyHint: false, destructiveHint: false }), t('rm')],
      prompts: [],
      resourceTemplates: [],
    });
    const d = diffCatalogs(before, after);
    expect(d.safety).toEqual({
      added: [
        { key: 'merge', safety: 'write' },
        { key: 'rm', safety: 'destructive' },
        { key: 'search', safety: 'read-only' },
      ],
      lessSafe: [{ key: 'list', before: 'read-only', after: 'destructive' }],
    });
    const v = evaluate(d, { allowAdditions: true });
    expect(v.drift).toBe(true);
    expect(v.reasons).toEqual(
      expect.arrayContaining(['tool added (destructive, not read-only): rm', 'tool added (write, not read-only): merge', 'tool became less safe: list (read-only -> destructive)']),
    );
    expect(v.waived).toEqual(['tool added: search']);
    const w = evaluate(d, { allowAdditions: true, allowWriteAdditions: true });
    expect(w.reasons.some((r) => r.startsWith('tool added'))).toBe(false);
    expect(w.reasons.some((r) => r.startsWith('tool became less safe'))).toBe(true);
  });
});

describe('CLI: read-only mode failing open', () => {
  it('check --allow-additions fails, marks each write/destructive tool and leads with a SAFETY line', () => {
    const dir = baseline();
    const r = cli(['check', '--name', 'gh', '--allow-additions', ...SRV], dir);
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^SAFETY: 3 added tool\(s\) are not read-only \(2 destructive\)/m);
    expect(r.stdout).toMatch(/^ {2}\+ delete_file {2}\[destructive\]$/m);
    expect(r.stdout).toMatch(/^ {2}\+ create_issue {2}\[destructive\]$/m);
    expect(r.stdout).toMatch(/^ {2}\+ merge_pull_request {2}\[write\]$/m);
    expect(r.stdout).toMatch(/^ {2}\+ search_code {2}\[read-only\]$/m);
    expect(r.stdout).toMatch(/tool added \(destructive, not read-only\): delete_file/);
    expect(r.stdout).not.toMatch(/DRIFT:.*search_code/);
  });

  it('--allow-write-additions is the separate explicit waiver; a less-safe annotation still drifts', () => {
    const dir = baseline();
    expect(cli(['check', '--name', 'gh', '--allow-additions', '--allow-write-additions', ...SRV], dir).code).toBe(0);
    const r = cli(['check', '--name', 'gh', '--allow-additions', '--allow-write-additions', ...SRV], dir, { LESS_SAFE: '1' });
    expect(r.code).toBe(1);
    expect(r.stdout).toMatch(/^SAFETY: 1 tool\(s\) became less safe/m);
    expect(r.stdout).toMatch(/tool became less safe: list_issues \(read-only -> destructive\)/);
  });

  it('diff and check --json carry the safety classification', () => {
    const dir = baseline();
    writeFileSync(join(dir, 'live.json'), cli(['snapshot', '--no-write', ...SRV], dir).stdout);
    const d = cli(['diff', join(dir, '.mcp-catalog', 'gh.json'), join(dir, 'live.json')], dir);
    expect(d.code).toBe(1);
    expect(d.stdout).toMatch(/^SAFETY: 3 added tool\(s\) are not read-only/m);
    const j = JSON.parse(cli(['check', '--name', 'gh', '--json', ...SRV], dir).stdout) as { servers: { diff: { safety: { added: { key: string; safety: string }[] } } }[] };
    expect(j.servers[0]!.diff.safety.added).toContainEqual({ key: 'delete_file', safety: 'destructive' });
  });

  it('the Action summary and log call it out', () => {
    const dir = baseline();
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ snapshotDir: '.mcp-catalog', servers: [{ name: 'gh', command: [process.execPath, HOSTILE], env: { MODE: 'readonly' } }] }));
    const r = runActionCheck(dir, { INPUT_ALLOW_ADDITIONS: 'true' });
    expect(r.code).toBe(1);
    expect(r.summary).toMatch(/^### Not read-only: 3 added tool\(s\) can write \(2 destructive\)/m);
    expect(r.log).toMatch(/^::error title=MCP catalog: tools that can write were added::/m);
    expect(readFileSync(/^report=(.*)$/m.exec(r.outputs)![1]!, 'utf8')).toMatch(/"destructive"/);
  });
});
