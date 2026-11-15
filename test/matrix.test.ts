/**
 * K-G7: flag matrix. One capture per flag set in one run, a format-2
 * snapshot per set, and a report of which tools, annotations and schemas
 * appear or change per set. The fake server is shaped like
 * kubernetes-mcp-server: toolsets, --read-only (which swaps pods_run for a
 * read-only variant of the same name) and --disable-destructive.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { Target } from '../src/capture.js';
import { cmdMatrix, EXIT_ERROR, EXIT_OK, type IO } from '../src/commands.js';
import { parseConfig } from '../src/config.js';
import { MATRIX_FORMAT, MATRIX_REPORT_FILE, applyFlagSet, buildMatrix, parseFlagSets, renderMatrix, variantId, type MatrixReport } from '../src/matrix.js';
import { buildSnapshot, parseSnapshot, snapshotSelfConsistent, type RawCapture } from '../src/snapshot.js';

const FLAGS = fileURLToPath(new URL('./fixtures/servers/flags-stdio.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

function mkIO(): IO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

const server: Target = { kind: 'stdio', command: process.execPath, args: [FLAGS] };
const K8S_SETS = [
  { name: 'default' },
  { name: 'read-only', args: ['--read-only'] },
  { name: 'no-destructive', args: ['--disable-destructive'] },
  { name: 'helm', args: ['--toolsets', 'core,config,helm'] },
];

describe('parseFlagSets / applyFlagSet', () => {
  it('accepts an array or {flagSets: [...]}, expanding ${VAR}', () => {
    const sets = parseFlagSets([{ name: 'a', args: ['--x', '${V}'], env: { E: '${V}' } }], 'f', { V: 'v' });
    expect(sets).toEqual([{ name: 'a', args: ['--x', 'v'], env: { E: 'v' } }]);
    expect(parseFlagSets({ flagSets: [{ name: 'b' }] }, 'f')).toEqual([{ name: 'b' }]);
  });

  it('refuses bad input with the place it is in', () => {
    expect(() => parseFlagSets({}, 'f')).toThrow(/f: expected an array of flag sets/);
    expect(() => parseFlagSets([], 'f')).toThrow(/no flag sets/);
    expect(() => parseFlagSets([{ name: 'a' }, { name: 'A' }], 'f')).toThrow(/duplicate flag set name "A"/);
    for (const name of ['', '_matrix', '../x', 'a/b', 'x'.repeat(65), 7]) {
      expect(() => parseFlagSets([{ name }], 'f')).toThrow(/f\[0\]\.name must be/);
    }
    expect(() => parseFlagSets([{ name: 'a', argv: [] }], 'f')).toThrow(/unknown key "argv"/);
    expect(() => parseFlagSets([{ name: 'a', args: '--x' }], 'f')).toThrow(/args must be an array of strings/);
    expect(() => parseFlagSets([{ name: 'a', env: { X: 1 } }], 'f')).toThrow(/f\[0\]\.env\.X must be a string/);
    expect(() => parseFlagSets([{ name: 'a', args: ['${NOPE_UNSET_VAR}'] }], 'f', {})).toThrow(/NOPE_UNSET_VAR is not set/);
    expect(() => parseFlagSets(Array.from({ length: 65 }, (_, i) => ({ name: `s${i}` })), 'f')).toThrow(/more than the 64/);
  });

  it('appends args and layers env for stdio, headers for http, and refuses the wrong kind', () => {
    const t = applyFlagSet({ kind: 'stdio', command: 'srv', args: ['serve'], env: { A: '1' } }, { name: 's', args: ['--read-only'], env: { B: '2' } });
    expect(t).toEqual({ kind: 'stdio', command: 'srv', args: ['serve', '--read-only'], env: { A: '1', B: '2' } });
    const h = applyFlagSet({ kind: 'http', url: 'https://h/mcp', headers: { A: '1' } }, { name: 's', headers: { 'X-MCP-Readonly': 'true' } });
    expect(h).toEqual({ kind: 'http', url: 'https://h/mcp', headers: { A: '1', 'X-MCP-Readonly': 'true' } });
    expect(() => applyFlagSet(server, { name: 's', headers: { A: '1' } })).toThrow(/"headers" apply to --url targets/);
    expect(() => applyFlagSet({ kind: 'http', url: 'https://h/mcp' }, { name: 's', args: ['--x'] })).toThrow(/apply to stdio servers/);
    expect(() => applyFlagSet({ kind: 'http', url: 'https://h/mcp' }, { name: 's', headers: { Authorization: 'short' } })).toThrow(/at least 8 characters/);
  });

  it('config servers carry flagSets', () => {
    const cfg = parseConfig(JSON.stringify({ servers: [{ name: 'k', command: ['srv'], flagSets: [{ name: 'ro', args: ['--read-only'] }] }] }), '/x/c.json');
    expect(cfg.servers[0]!.flagSets).toEqual([{ name: 'ro', args: ['--read-only'] }]);
    expect(() => parseConfig(JSON.stringify({ servers: [{ name: 'k', command: ['srv'], flagSets: [{}] }] }), '/x/c.json')).toThrow(/servers\[0\]\.flagSets\[0\]\.name/);
  });

  it('variant ids run A..Z, AA..', () => {
    expect([0, 1, 25, 26, 27, 51, 52].map(variantId)).toEqual(['A', 'B', 'Z', 'AA', 'AB', 'AZ', 'BA']);
  });
});

describe('buildMatrix (pure)', () => {
  const snap = (tools: unknown[], prompts: unknown[] = []): ReturnType<typeof buildSnapshot> =>
    buildSnapshot({ server: { name: 's', version: '1' }, protocolVersion: null, tools, prompts, resourceTemplates: [] } as RawCapture, { capturedAt: 't' });
  const ro = { readOnlyHint: true };
  const base = snap([
    { name: 'read', inputSchema: { type: 'object' }, annotations: ro },
    { name: 'same', inputSchema: { type: 'object' }, annotations: ro },
  ]);
  const wide = snap(
    [
      { name: 'read', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, annotations: { readOnlyHint: false } },
      { name: 'same', inputSchema: { type: 'object' }, annotations: ro },
      { name: 'write', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: false } },
    ],
    [{ name: 'p' }],
  );

  it('groups each entry into variants and reports presence per set', () => {
    const r = buildMatrix([
      { set: { name: 'a' }, launch: null, snapshot: base, file: 'a.json' },
      { set: { name: 'b' }, launch: null, snapshot: wide, file: 'b.json' },
      { set: { name: 'c' }, launch: null, snapshot: base, file: 'c.json' },
      { set: { name: 'broken' }, launch: null, error: 'boom' },
    ]);
    expect(r.format).toBe(MATRIX_FORMAT);
    expect(r.baseline).toBe('a');
    expect(r.sets.map((s) => [s.name, s.ok])).toEqual([['a', true], ['b', true], ['c', true], ['broken', false]]);
    expect(r.sets[3]!.error).toBe('boom');
    const read = r.sections.tools.find((e) => e.key === 'read')!;
    expect(read.variants.map((v) => [v.id, v.sets, v.safety])).toEqual([
      ['A', ['a', 'c'], 'read-only'],
      ['B', ['b'], 'destructive'],
    ]);
    expect(read.variants[1]!.annotations).toEqual({ readOnlyHint: false });
    expect(read.changes).toEqual([
      {
        from: 'A',
        to: 'B',
        changes: [
          { path: '/annotations/readOnlyHint', before: true, after: false, descriptive: false },
          { path: '/inputSchema/properties', before: undefined, after: { q: { type: 'string' } }, descriptive: false },
        ],
      },
    ]);
    const write = r.sections.tools.find((e) => e.key === 'write')!;
    expect(write).toMatchObject({ presentIn: ['b'], absentFrom: ['a', 'c'], uniform: false });
    expect(r.sections.tools.find((e) => e.key === 'same')!.uniform).toBe(true);
    expect(r.summary.tools).toEqual({ total: 3, uniform: 1, varying: 2 });
    expect(r.summary.prompts).toEqual({ total: 1, uniform: 0, varying: 1 });
    expect(r.versusBaseline.map((v) => [v.set, v.identical])).toEqual([['b', false], ['c', true]]);
    expect(r.versusBaseline[0]!.added.tools).toEqual(['write']);
    expect(r.versusBaseline[0]!.changed.tools).toEqual(['read']);
    expect(r.versusBaseline[0]!.safety.lessSafe).toEqual([{ key: 'read', before: 'read-only', after: 'destructive' }]);

    const text = renderMatrix(r);
    expect(text).toContain('flag matrix: s 1, 4 flag set(s), 3 captured, baseline "a"');
    expect(text).toContain('broken  error: boom');
    expect(text).toMatch(/\n {2}read +A ro +B destr +A ro\n/);
    expect(text).toMatch(/\n {2}write +- +A write +-\n/);
    expect(text).toContain('read: A -> B: /annotations/readOnlyHint, /inputSchema/properties');
    expect(text).toContain('SAFETY: 1 added tool(s) are not read-only (0 destructive): write');
    expect(text).toContain('SAFETY: 1 tool(s) became less safe: read (read-only -> destructive)');
    expect(text).toMatch(/\n {2}c +identical/);
  });

  it('handles every set failing', () => {
    const r = buildMatrix([{ set: { name: 'a' }, launch: null, error: 'x' }]);
    expect(r.baseline).toBeNull();
    expect(r.server).toBeNull();
    expect(r.summary.tools).toEqual({ total: 0, uniform: 0, varying: 0 });
    expect(renderMatrix(r)).toContain('(no set captured)');
  });

  it('keeps untrusted names out of the terminal as raw control characters', () => {
    const evil = 'x\u001b[31m\n::error::y';
    const r = buildMatrix([
      { set: { name: 'a' }, launch: null, snapshot: snap([{ name: evil, inputSchema: {} }]) },
      { set: { name: 'b' }, launch: null, snapshot: snap([]) },
    ]);
    const text = renderMatrix(r);
    expect(text).not.toContain('\u001b');
    expect(text).not.toMatch(/^::error::/m);
  });
});

describe('matrix command against a flag-dependent server', () => {
  it('captures every set, writes a snapshot per set and the matrix report, and shows what each flag changes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-matrix-'));
    writeFileSync(join(dir, 'sets.json'), JSON.stringify(K8S_SETS));
    const io = mkIO();
    const code = await cmdMatrix({ childStderr: 'ignore', target: server, dir, cwd: dir, flagSetsFile: join(dir, 'sets.json') }, io);
    expect(code, io.stderr.join('\n')).toBe(EXIT_OK);
    const mdir = join(dir, 'flags-server.matrix');
    expect(readdirSync(mdir).sort()).toEqual([MATRIX_REPORT_FILE, 'default.json', 'helm.json', 'no-destructive.json', 'read-only.json']);

    // each set's snapshot is a normal, self-consistent format-2 snapshot that says which set and arguments it was taken with
    const ro = parseSnapshot(readFileSync(join(mdir, 'read-only.json'), 'utf8'), 'read-only.json');
    expect(snapshotSelfConsistent(ro)).toBe(true);
    expect(ro.flagSet).toBe('read-only');
    expect(ro.launch?.transport === 'stdio' && ro.launch.args.slice(1)).toEqual(['--read-only']);
    expect(ro.catalog.tools.map((t) => t.name)).toEqual(['configuration_view', 'pods_list', 'pods_run']);

    const report = JSON.parse(readFileSync(join(mdir, MATRIX_REPORT_FILE), 'utf8')) as MatrixReport;
    expect(report.format).toBe(MATRIX_FORMAT);
    expect(report.server).toEqual({ name: 'flags-server', version: '0.0.1' });
    expect(report.sets.map((s) => [s.name, s.ok, s.counts?.tools, s.snapshot])).toEqual([
      ['default', true, 4, 'default.json'],
      ['read-only', true, 3, 'read-only.json'],
      ['no-destructive', true, 3, 'no-destructive.json'],
      ['helm', true, 7, 'helm.json'],
    ]);
    const byName = new Map(report.sections.tools.map((e) => [e.key, e]));
    // the same name, two definitions: pods_run is writable by default and a read-only dry run under --read-only
    const podsRun = byName.get('pods_run')!;
    expect(podsRun.variants.map((v) => [v.id, v.sets, v.safety])).toEqual([
      ['A', ['default', 'no-destructive', 'helm'], 'write'],
      ['B', ['read-only'], 'read-only'],
    ]);
    expect(podsRun.changes[0]!.changes.map((c) => c.path)).toEqual([
      '/annotations/destructiveHint',
      '/annotations/readOnlyHint',
      '/description',
      '/inputSchema/properties/namespace',
    ]);
    expect(byName.get('pods_delete')).toMatchObject({ presentIn: ['default', 'helm'], absentFrom: ['read-only', 'no-destructive'] });
    expect(byName.get('helm_install')).toMatchObject({ presentIn: ['helm'] });
    expect(byName.get('pods_list')!.uniform).toBe(true);
    const helm = report.versusBaseline.find((v) => v.set === 'helm')!;
    expect(helm.added.tools).toEqual(['helm_install', 'helm_list', 'helm_uninstall']);
    expect(helm.safety.added.map((a) => [a.key, a.safety])).toEqual([
      ['helm_install', 'write'],
      ['helm_list', 'read-only'],
      ['helm_uninstall', 'destructive'],
    ]);

    const out = io.stdout.join('\n');
    expect(out).toContain(`wrote ${mdir}/ (4 snapshot(s) + ${MATRIX_REPORT_FILE})`);
    expect(out).toMatch(/\n {2}pods_run +A write +B ro +A write +A write\n/);
    expect(out).toMatch(/\n {2}pods_delete +A destr +- +- +A destr\n/);
  });

  it('writes a byte-identical matrix report for the same catalogs (no timestamps)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-matrix-det-'));
    writeFileSync(join(dir, 'sets.json'), JSON.stringify(K8S_SETS.slice(0, 2)));
    const read = async () => {
      expect(await cmdMatrix({ childStderr: 'ignore', target: server, dir, cwd: dir, flagSetsFile: join(dir, 'sets.json'), quiet: true }, mkIO())).toBe(EXIT_OK);
      return readFileSync(join(dir, 'flags-server.matrix', MATRIX_REPORT_FILE), 'utf8');
    };
    expect(await read()).toBe(await read());
  });

  it('a set whose server fails is reported, the others are still written, and the exit code is 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-matrix-fail-'));
    writeFileSync(join(dir, 'sets.json'), JSON.stringify([{ name: 'ok' }, { name: 'crash', args: ['--crash'] }]));
    const io = mkIO();
    const code = await cmdMatrix({ childStderr: 'ignore', target: server, dir, cwd: dir, flagSetsFile: join(dir, 'sets.json'), timeoutMs: 5000 }, io);
    expect(code).toBe(EXIT_ERROR);
    expect(io.stderr.join('\n')).toMatch(/flag set "crash": /);
    const mdir = join(dir, 'flags-server.matrix');
    expect(existsSync(join(mdir, 'ok.json'))).toBe(true);
    expect(existsSync(join(mdir, 'crash.json'))).toBe(false);
    const report = JSON.parse(readFileSync(join(mdir, MATRIX_REPORT_FILE), 'utf8')) as MatrixReport;
    expect(report.sets[1]).toMatchObject({ name: 'crash', ok: false });
    expect(report.sets[1]!.launch).toMatchObject({ transport: 'stdio' });
  });

  it('warns about stale set files from an earlier run', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-matrix-stale-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify([{ name: 'one' }, { name: 'two', args: ['--read-only'] }]));
    writeFileSync(join(dir, 'b.json'), JSON.stringify([{ name: 'one' }]));
    expect(await cmdMatrix({ childStderr: 'ignore', target: server, dir, cwd: dir, flagSetsFile: join(dir, 'a.json'), quiet: true }, mkIO())).toBe(EXIT_OK);
    const io = mkIO();
    expect(await cmdMatrix({ childStderr: 'ignore', target: server, dir, cwd: dir, flagSetsFile: join(dir, 'b.json'), quiet: true }, io)).toBe(EXIT_OK);
    expect(io.stderr.join('\n')).toMatch(/also holds two\.json, not written by this run/);
  });

  it('masks a credential a set carries in the report, the set snapshot and the output', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-matrix-secret-'));
    const secret = 'abcdefgh-1234-SECRET-5678';
    writeFileSync(join(dir, 'sets.json'), JSON.stringify([{ name: 'a', env: { API_TOKEN: secret } }, { name: 'b', args: ['--api-key', secret] }]));
    const io = mkIO();
    expect(await cmdMatrix({ childStderr: 'ignore', target: server, dir, cwd: dir, flagSetsFile: join(dir, 'sets.json'), json: true }, io)).toBe(EXIT_OK);
    const mdir = join(dir, 'flags-server.matrix');
    for (const f of readdirSync(mdir)) expect(readFileSync(join(mdir, f), 'utf8')).not.toContain(secret);
    expect(io.stdout.join('\n')).not.toContain(secret);
    const report = JSON.parse(io.stdout.join('\n')) as MatrixReport;
    expect(report.sets[0]!.launch).toMatchObject({ env: { API_TOKEN: '***' } });
    expect(report.sets[1]!.launch).toMatchObject({ args: expect.arrayContaining(['--api-key', '***']) as unknown as string[] });
  });

  it('uses a configured server and its flagSets with --server, and --no-write writes nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-matrix-cfg-'));
    writeFileSync(
      join(dir, '.mcp-catalog.json'),
      JSON.stringify({ servers: [{ name: 'k8s', command: [process.execPath, FLAGS], flagSets: K8S_SETS.slice(0, 2) }, { name: 'other', command: ['x'] }] }),
    );
    const run = (args: string[]) => spawnSync(process.execPath, [CLI, 'matrix', ...args], { encoding: 'utf8', cwd: dir, timeout: 60_000 });
    const one = run(['--server', 'k8s', '--no-write']);
    expect(one.status, one.stderr).toBe(0);
    expect(one.stdout).toContain('flag matrix: flags-server 0.0.1, 2 flag set(s), 2 captured, baseline "default"');
    expect(existsSync(join(dir, '.mcp-catalog'))).toBe(false);
    const written = run(['--server', 'k8s', '--quiet']);
    expect(written.status, written.stderr).toBe(0);
    expect(readdirSync(join(dir, '.mcp-catalog', 'k8s.matrix')).sort()).toEqual([MATRIX_REPORT_FILE, 'default.json', 'read-only.json']);

    const all = run([]);
    expect(all.status).toBe(2);
    expect(all.stderr).toContain('matrix captures one server');
    const none = run(['--server', 'other']);
    expect(none.status).toBe(2);
    expect(none.stderr).toContain('matrix needs flag sets');
    const typo = run(['--server', 'k8s', '--flag-set', 'x']);
    expect(typo.status).toBe(2);
    expect(typo.stderr).toContain('unknown option --flag-set for matrix (did you mean --flag-sets?)');
    const empty = run(['--server', 'k8s', '--flag-sets']);
    expect(empty.status).toBe(2);
    expect(empty.stderr).toContain('--flag-sets needs a file');
  });
});
