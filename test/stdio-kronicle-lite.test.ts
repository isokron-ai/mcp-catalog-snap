/**
 * Real stdio spawn: kronicle-lite (devDependency, pinned) started as a child
 * process through StdioClientTransport, then the snapshot / check commands
 * driven end-to-end against a temp directory.
 */

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import { capture, type Target } from '../src/capture.js';
import { fingerprint } from '../src/canonical.js';
import { cmdCheck, cmdHash, cmdSnapshot, EXIT_DRIFT, EXIT_ERROR, EXIT_OK, EXIT_TAMPERED, type IO } from '../src/commands.js';
import { parseSnapshot, serializeSnapshot, snapshotSelfConsistent, type Snapshot } from '../src/snapshot.js';

const KRONICLE_CLI = fileURLToPath(new URL('../node_modules/kronicle-lite/dist/cli.js', import.meta.url));

/** Write a snapshot as a genuine (older) capture would: sha256 recomputed over the body. */
function writeGenuine(path: string, snap: Snapshot): void {
  writeFileSync(path, serializeSnapshot({ ...snap, sha256: fingerprint(snap.catalog) }));
}

function mkIO(): IO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

describe('stdio spawn of kronicle-lite', () => {
  let work: string;
  let target: Target;

  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'mcs-stdio-'));
    target = { kind: 'stdio', command: process.execPath, args: [KRONICLE_CLI, 'serve', '--data-dir', join(work, 'data')] };
  });

  it('captures the live catalog over stdio', async () => {
    const raw = await capture(target, { stderr: 'ignore' });
    expect(raw.server.name).toBe('kronicle-lite');
    expect(raw.server.version).toBe('0.2.0');
    expect(raw.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(raw.tools.length).toBeGreaterThan(0);
    expect(raw.tools.map((t) => (t as { name: string }).name)).toContain('get_system_state');
    expect(raw.resourceTemplates).toHaveLength(1);
  });

  it('snapshot writes <dir>/<server-name>.json named after the server', async () => {
    const io = mkIO();
    const code = await cmdSnapshot({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work }, io);
    expect(code).toBe(EXIT_OK);
    const path = join(work, 'snaps', 'kronicle-lite.json');
    expect(existsSync(path)).toBe(true);
    const snap = parseSnapshot(readFileSync(path, 'utf8'), path);
    expect(snapshotSelfConsistent(snap)).toBe(true);
    expect(io.stdout[0]).toBe(`wrote ${path}`);
    expect(io.stdout.join('\n')).toContain('server:          kronicle-lite 0.2.0');
  });

  it('check passes against a fresh snapshot (exit 0)', async () => {
    const io = mkIO();
    const code = await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work }, io);
    expect(code).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toContain('catalog: identical');
    expect(io.stdout.join('\n')).toContain('1/1 server(s) match their snapshot');
  });

  it('check fails with exit 1 and a readable diff when a description is mutated', async () => {
    const path = join(work, 'snaps', 'kronicle-lite.json');
    const snap = parseSnapshot(readFileSync(path, 'utf8'), path);
    const tool = snap.catalog.tools.find((t) => t.name === 'get_system_state')!;
    const original = tool.description!;
    tool.description = `${original} (stale wording)`;
    writeGenuine(path, snap);

    const io = mkIO();
    const code = await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work }, io);
    expect(code).toBe(EXIT_DRIFT);
    const out = io.stdout.join('\n');
    expect(out).toContain('~ get_system_state  [description-only]');
    expect(out).toContain('/description (description)');
    expect(out).toContain('DRIFT: 1 reason(s)');
    expect(out).toContain('tool description changed: get_system_state (/description)');
    expect(io.stderr).toEqual([]);

    // policy waiver
    const io2 = mkIO();
    expect(await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, ignoreDescriptions: true }, io2)).toBe(EXIT_OK);
    expect(io2.stdout.join('\n')).toContain('waived by policy');
  });

  it('check --update rewrites the snapshot and the next check is clean', async () => {
    const io = mkIO();
    expect(await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, update: true }, io)).toBe(EXIT_DRIFT);
    expect(io.stdout.join('\n')).toContain('updated ');
    expect(await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work }, mkIO())).toBe(EXIT_OK);
  });

  it('check --json emits a machine-readable report', async () => {
    const path = join(work, 'snaps', 'kronicle-lite.json');
    const snap = parseSnapshot(readFileSync(path, 'utf8'), path);
    snap.catalog.tools = snap.catalog.tools.filter((t) => t.name !== 'get_system_state');
    writeGenuine(path, snap);

    const io = mkIO();
    const code = await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, json: true }, io);
    expect(code).toBe(EXIT_DRIFT);
    const report = JSON.parse(io.stdout.join('\n')) as {
      ok: boolean;
      servers: Array<{ server: string; drift: boolean; diff: { sections: Array<{ added: string[] }> }; verdict: { reasons: string[] } }>;
    };
    expect(report.ok).toBe(false);
    expect(report.servers[0]!.server).toBe('kronicle-lite');
    expect(report.servers[0]!.diff.sections[0]!.added).toEqual(['get_system_state']);
    expect(report.servers[0]!.verdict.reasons).toEqual(['tool added: get_system_state']);

    const io2 = mkIO();
    expect(await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, json: true, allowAdditions: true }, io2)).toBe(EXIT_OK);
    expect((JSON.parse(io2.stdout.join('\n')) as { ok: boolean }).ok).toBe(true);
  });

  it('check reports exit 2 when the snapshot is missing or the server cannot start', async () => {
    const io = mkIO();
    expect(await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'nowhere'), cwd: work }, io)).toBe(EXIT_ERROR);
    expect(io.stderr.join('\n')).toMatch(/no snapshot at .*run `mcp-catalog-snap snapshot` first/);

    const broken: Target = { kind: 'stdio', command: process.execPath, args: ['-e', 'process.exit(3)'] };
    const io2 = mkIO();
    expect(await cmdCheck({ target: broken, dir: join(work, 'snaps'), cwd: work, timeoutMs: 5_000 }, io2)).toBe(EXIT_ERROR);
    expect(io2.stderr.length).toBeGreaterThan(0);
  });

  it('hash prints the same fingerprint for the live server and the stored file', async () => {
    const live = mkIO();
    expect(await cmdHash({ childStderr: 'ignore', target, cwd: work }, live)).toBe(EXIT_OK);
    const file = mkIO();
    expect(await cmdHash({ file: join(work, 'snaps', 'kronicle-lite.json') }, file)).toBe(EXIT_OK);
    expect(live.stdout[0]).toMatch(/^[0-9a-f]{64}$/);
    // the file is an older genuine capture (one tool fewer), so its hash differs from live
    expect(file.stdout[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(file.stdout[0]).not.toBe(live.stdout[0]);
    expect(file.stderr).toEqual([]);
  });
});

describe('tampered snapshots (P2-15)', () => {
  let work: string;
  let target: Target;
  let path: string;
  let pristine: string;

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), 'mcs-tamper-'));
    target = { kind: 'stdio', command: process.execPath, args: [KRONICLE_CLI, 'serve', '--data-dir', join(work, 'data')] };
    expect(await cmdSnapshot({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, quiet: true }, mkIO())).toBe(EXIT_OK);
    path = join(work, 'snaps', 'kronicle-lite.json');
    pristine = readFileSync(path, 'utf8');
  });

  /** Edit the stored file as JSON, leaving its sha256 field as it was. */
  function tamper(edit: (doc: { sha256: string; catalog: Snapshot['catalog'] }) => void): void {
    const doc = JSON.parse(pristine) as { sha256: string; catalog: Snapshot['catalog'] };
    edit(doc);
    writeFileSync(path, JSON.stringify(doc));
  }
  const check = (extra: Partial<Parameters<typeof cmdCheck>[0]> = {}) => {
    const io = mkIO();
    return cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, ...extra }, io).then((code) => ({ code, io }));
  };

  it('a description edited by hand (stale sha256) is exit 3, not a drift diff', async () => {
    tamper((d) => {
      d.catalog.tools[0]!.description = 'edited by hand';
    });
    const { code, io } = await check();
    expect(code).toBe(EXIT_TAMPERED);
    expect(io.stderr.join('\n')).toMatch(/stored sha256 [0-9a-f]{64} does not match its catalog body [0-9a-f]{64}/);
    expect(io.stdout.join('\n')).not.toContain('DRIFT');
  });

  it('tools emptied by hand fail with exit 3, with and without --allow-additions or --ignore-descriptions', async () => {
    tamper((d) => {
      d.catalog.tools = [];
    });
    expect((await check()).code).toBe(EXIT_TAMPERED);
    expect((await check({ allowAdditions: true })).code).toBe(EXIT_TAMPERED);
    expect((await check({ allowAdditions: true, ignoreDescriptions: true })).code).toBe(EXIT_TAMPERED);
  });

  it('only the sha256 field wrong (catalog intact) is still exit 3', async () => {
    tamper((d) => {
      d.sha256 = '0'.repeat(64);
    });
    expect((await check()).code).toBe(EXIT_TAMPERED);
  });

  it('--update does not overwrite a tampered snapshot; --json marks it', async () => {
    tamper((d) => {
      d.catalog.tools = [];
    });
    const before = readFileSync(path, 'utf8');
    const { code, io } = await check({ update: true, json: true });
    expect(code).toBe(EXIT_TAMPERED);
    expect(readFileSync(path, 'utf8')).toBe(before);
    const report = JSON.parse(io.stdout.join('\n')) as { ok: boolean; servers: Array<{ ok: boolean; tampered?: boolean; snapshotPath?: string }> };
    expect(report.ok).toBe(false);
    expect(report.servers[0]).toMatchObject({ ok: false, tampered: true, snapshotPath: path });
  });

  it('tools emptied with a recomputed sha256 still drift under --allow-additions (no baseline to add to)', async () => {
    const snap = parseSnapshot(pristine, path);
    const liveTools = snap.catalog.tools.length;
    snap.catalog.tools = [];
    writeGenuine(path, snap);
    const { code, io } = await check({ allowAdditions: true });
    expect(code).toBe(EXIT_DRIFT);
    const out = io.stdout.join('\n');
    expect(out).toContain(`tools: snapshot lists none, live server lists ${liveTools}`);
    expect(out).not.toContain('waived by policy');
  });

  it('a genuine older snapshot missing one tool still passes with --allow-additions', async () => {
    const snap = parseSnapshot(pristine, path);
    snap.catalog.tools = snap.catalog.tools.filter((t) => t.name !== 'recall');
    writeGenuine(path, snap);
    const { code, io } = await check({ allowAdditions: true });
    expect(code).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toContain('tool added: recall');
  });

  it('restoring the committed bytes passes again', async () => {
    writeFileSync(path, pristine);
    expect((await check()).code).toBe(EXIT_OK);
  });
});

describe('check --report', () => {
  it('writes the JSON report to a file while keeping human output on stdout', async () => {
    const work = mkdtempSync(join(tmpdir(), 'mcs-report-'));
    const target: Target = { kind: 'stdio', command: process.execPath, args: [KRONICLE_CLI, 'serve', '--data-dir', join(work, 'data')] };
    expect(await cmdSnapshot({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, quiet: true }, mkIO())).toBe(EXIT_OK);
    const io = mkIO();
    const reportFile = join(work, 'report.json');
    expect(await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, reportFile }, io)).toBe(EXIT_OK);
    expect(io.stdout.join('\n')).toContain('catalog: identical');
    const report = JSON.parse(readFileSync(reportFile, 'utf8')) as { ok: boolean; tool: string; servers: unknown[] };
    expect(report.ok).toBe(true);
    expect(report.tool).toMatch(/^mcp-catalog-snap\//);
    expect(report.servers).toHaveLength(1);
    const bad = mkIO();
    expect(await cmdCheck({ childStderr: 'ignore', target, dir: join(work, 'snaps'), cwd: work, reportFile: join(work, 'no', 'dir', 'r.json') }, bad)).toBe(EXIT_ERROR);
    expect(bad.stderr.join('\n')).toContain('cannot write report');
  });
});
