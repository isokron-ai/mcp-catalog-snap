/**
 * Dogfood: the committed snapshots under examples/.mcp-catalog are checked
 * against the real published packages (kronicle-lite@0.2.0, sea-lite@0.1.1,
 * both pinned devDependencies so `npx -y pkg@ver` resolves locally).
 */

import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { fingerprint } from '../src/canonical.js';
import { cmdCheck, EXIT_DRIFT, EXIT_OK, type IO } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { parseSnapshot, snapshotSelfConsistent, type Snapshot } from '../src/snapshot.js';

const EXAMPLES = fileURLToPath(new URL('../examples/', import.meta.url));
const CONFIG = join(EXAMPLES, '.mcp-catalog.json');

function mkIO(): IO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

function readExample(name: string): Snapshot {
  const p = join(EXAMPLES, '.mcp-catalog', `${name}.json`);
  return parseSnapshot(readFileSync(p, 'utf8'), p);
}

describe('examples/ dogfood snapshots', () => {
  beforeAll(() => {
    // keep the servers' default data dir out of $HOME during tests
    process.env['KRONICLE_LITE_DATA_DIR'] = mkdtempSync(join(tmpdir(), 'mcs-examples-data-'));
  });

  it('config lists both servers, launched via npx with pinned versions', () => {
    const cfg = loadConfig(CONFIG);
    expect(cfg.servers.map((s) => s.name)).toEqual(['kronicle-lite', 'sea-lite']);
    for (const s of cfg.servers) {
      expect(s.target.kind).toBe('stdio');
      expect((s.target as { args: string[] }).args[1]).toMatch(/@\d+\.\d+\.\d+$/);
    }
  });

  it('each committed snapshot is self-consistent and carries the pinned fingerprints', () => {
    const kl = readExample('kronicle-lite');
    const sl = readExample('sea-lite');
    expect(snapshotSelfConsistent(kl)).toBe(true);
    expect(snapshotSelfConsistent(sl)).toBe(true);
    expect(kl.server.name).toBe('kronicle-lite');
    expect(sl.server.name).toBe('sea-lite');
    expect(kl.sha256).toBe('38506578bae09476f1d2b2a6722b35a9cc5b3925013d765b1ed4cac21ecab698');
    expect(sl.sha256).toBe('9610edb6b384416ddcb8e3f968c5cda3a3eb673b2238d11fe72891ee3e33d3d5');
    expect(kl.catalog.tools.length).toBe(9);
    expect(sl.catalog.tools.length).toBe(12);
  });

  it('check passes against the live published servers (exit 0)', async () => {
    const io = mkIO();
    const code = await cmdCheck({ childStderr: 'ignore', config: CONFIG, cwd: EXAMPLES, json: true }, io);
    expect(io.stderr.join('\n')).toBe('');
    expect(code).toBe(EXIT_OK);
    const report = JSON.parse(io.stdout.join('\n')) as { ok: boolean; servers: Array<{ server: string; drift: boolean; fingerprint: { snapshot: string; live: string } }> };
    expect(report.ok).toBe(true);
    expect(report.servers.map((s) => s.server)).toEqual(['kronicle-lite', 'sea-lite']);
    for (const s of report.servers) expect(s.fingerprint.live).toBe(s.fingerprint.snapshot);
  });

  it('check fails (exit 1) when a description in the stored snapshot is mutated', async () => {
    const work = mkdtempSync(join(tmpdir(), 'mcs-examples-'));
    cpSync(EXAMPLES, work, { recursive: true });
    const path = join(work, '.mcp-catalog', 'sea-lite.json');
    const snap = parseSnapshot(readFileSync(path, 'utf8'), path);
    const tool = snap.catalog.tools.find((t) => t.name === 'sea_claim')!;
    tool.description = `${tool.description} Reworded.`;
    snap.sha256 = fingerprint(snap.catalog);
    writeFileSync(path, `${JSON.stringify(snap, null, 2)}\n`);

    const io = mkIO();
    const code = await cmdCheck({ childStderr: 'ignore', config: join(work, '.mcp-catalog.json'), cwd: work }, io);
    expect(code).toBe(EXIT_DRIFT);
    const out = io.stdout.join('\n');
    expect(out).toContain('== kronicle-lite');
    expect(out).toContain('== sea-lite');
    expect(out).toContain('~ sea_claim  [description-only]');
    expect(out).toContain('tool description changed: sea_claim (/description)');
    expect(out).toContain('1/2 server(s) drifted');

    const waived = mkIO();
    expect(await cmdCheck({ childStderr: 'ignore', config: join(work, '.mcp-catalog.json'), cwd: work, ignoreDescriptions: true }, waived)).toBe(EXIT_OK);
  });

  it('--server limits the run to one configured server', async () => {
    const io = mkIO();
    expect(await cmdCheck({ childStderr: 'ignore', config: CONFIG, cwd: EXAMPLES, server: 'sea-lite', json: true }, io)).toBe(EXIT_OK);
    const report = JSON.parse(io.stdout.join('\n')) as { servers: Array<{ server: string }> };
    expect(report.servers.map((s) => s.server)).toEqual(['sea-lite']);
    const bad = mkIO();
    expect(await cmdCheck({ childStderr: 'ignore', config: CONFIG, cwd: EXAMPLES, server: 'nope' }, bad)).toBe(2);
    expect(bad.stderr.join('\n')).toContain('server "nope" is not in');
  });
});
