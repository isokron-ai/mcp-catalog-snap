/**
 * Local paths in written files, and why a server exited.
 *
 * (a) Snapshot `launch` headers and matrix reports are meant to be committed
 * and shared. They used to keep the operator's absolute paths (home, user
 * name, temp folders, directory layout) apart from segments that happened to
 * look like tokens. Paths are now `<project>/…` inside the project root (the
 * config file's directory, or the working directory) and `<local>/<last
 * segment>` elsewhere; URLs and relative paths are untouched.
 *
 * (b) A server that refuses its flags or config prints why on stderr and
 * exits; the SDK only says "Connection closed". The capture error now carries
 * the exit code and the server's last stderr lines, also with --json (where
 * the child's stderr is not shown), and the matrix report records them.
 */

import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cmdMatrix, cmdSnapshot, EXIT_ERROR, EXIT_OK, type IO } from '../src/commands.js';
import { redactLocalPaths, redactLocalPathsDeep } from '../src/local-paths.js';
import { MATRIX_REPORT_FILE, type MatrixReport } from '../src/matrix.js';
import { parseSnapshot } from '../src/snapshot.js';

const FLAGS = fileURLToPath(new URL('./fixtures/servers/flags-stdio.mjs', import.meta.url));
const REPO = fileURLToPath(new URL('..', import.meta.url));

function mkIO(): IO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

describe('redactLocalPaths', () => {
  const root = '/work/audit-harness';
  it('rewrites paths inside the root relative to it, and others to their last segment', () => {
    expect(redactLocalPaths('/work/audit-harness/server/kms.toml', root)).toBe('<project>/server/kms.toml');
    expect(redactLocalPaths('/work/audit-harness', root)).toBe('<project>');
    expect(redactLocalPaths('/home/someone/.kube/config', root)).toBe('<local>/config');
    expect(redactLocalPaths('/opt/homebrew/bin/node', root)).toBe('<local>/node');
    expect(redactLocalPaths('/var/folders/ab/xyz123/T/rig/cfg/', root)).toBe('<local>/cfg');
  });
  it('finds paths inside flags, NAME=VALUE pairs, PATH lists, quotes and file:// URLs', () => {
    expect(redactLocalPaths('--config=/work/audit-harness/a.toml', root)).toBe('--config=<project>/a.toml');
    expect(redactLocalPaths('KUBECONFIG=/home/someone/kms.kubeconfig', root)).toBe('KUBECONFIG=<local>/kms.kubeconfig');
    expect(redactLocalPaths('PATH=/usr/local/bin:/home/someone/bin', root)).toBe('PATH=<local>/bin:<local>/bin');
    expect(redactLocalPaths('open "/home/someone/x.toml": no such file', root)).toBe('open "<local>/x.toml": no such file');
    expect(redactLocalPaths('file:///home/someone/a/b.json', root)).toBe('file://<local>/b.json');
    expect(redactLocalPaths('C:\\Users\\someone\\cfg\\kms.toml', root)).toBe('<local>/kms.toml');
  });
  it('leaves URLs, relative paths and ordinary words alone', () => {
    for (const s of ['https://example.com/v1/mcp', 'http://127.0.0.1:8080/mcp', 'server/kms.toml', './cfg/a.toml', '~/x', 'core,config', 'a/b', '--read-only', 'ratio 3/4']) expect(redactLocalPaths(s, root)).toBe(s);
  });
  it('matches the root through symlinks (macOS /var is /private/var) and walks JSON values', () => {
    const d = mkdtempSync(join(tmpdir(), 'mcs-paths-'));
    expect(redactLocalPaths(join(realpathSync(d), 'x.toml'), d)).toBe('<project>/x.toml');
    expect(redactLocalPathsDeep({ a: [`${d}/y`], b: { c: '/elsewhere/z' }, n: 1 }, d)).toEqual({ a: ['<project>/y'], b: { c: '<local>/z' }, n: 1 });
  });
});

describe('launch header: no local path in the snapshot file', () => {
  it('writes project-relative and <local> paths only; the fingerprint is unchanged', async () => {
    const project = mkdtempSync(join(tmpdir(), 'mcs-project-'));
    mkdirSync(join(project, 'cfg'));
    writeFileSync(join(project, 'cfg', 'default.toml'), 'toolsets = ["core"]\n');
    const kube = join(homedir(), '.kube-not-real', 'kms.kubeconfig');
    writeFileSync(join(project, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 'k8s', command: [process.execPath, FLAGS, '--config', join(project, 'cfg', 'default.toml')], env: { KUBECONFIG: kube } }] }));
    const io = mkIO();
    expect(await cmdSnapshot({ childStderr: 'ignore', cwd: project, config: join(project, '.mcp-catalog.json') }, io)).toBe(EXIT_OK);
    const text = readFileSync(join(project, '.mcp-catalog', 'k8s.json'), 'utf8');
    for (const leak of [project, realpathSync(project), tmpdir(), homedir(), REPO.replace(/\/$/, ''), process.execPath]) expect(text).not.toContain(leak);
    const snap = parseSnapshot(text, 'f');
    expect(snap.launch).toMatchObject({ command: `<local>/${basename(process.execPath)}`, args: ['<local>/flags-stdio.mjs', '--config', '<project>/cfg/default.toml'], env: { KUBECONFIG: '<local>/kms.kubeconfig' } });
  });
});

describe('a server that exits on its own: the error says why', () => {
  const server = { kind: 'stdio' as const, command: process.execPath, args: [FLAGS] };

  it('the matrix records the exit code and the server\'s own error line, with --json too, and no local path', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-exit-'));
    const missing = join(homedir(), 'not-a-real-dir', 'kms.toml');
    writeFileSync(join(dir, 'sets.json'), JSON.stringify([{ name: 'ok' }, { name: 'typo', args: ['--toolsets', 'core,helmm'] }, { name: 'crash', args: ['--crash'] }, { name: 'nocfg', args: ['--fail-config', missing] }]));
    const io = mkIO();
    const code = await cmdMatrix({ json: true, target: server, dir, cwd: dir, flagSetsFile: join(dir, 'sets.json'), timeoutMs: 5000 }, io);
    expect(code).toBe(EXIT_ERROR);
    const text = readFileSync(join(dir, 'flags-server.matrix', MATRIX_REPORT_FILE), 'utf8');
    const report = JSON.parse(text) as MatrixReport;
    const err = (name: string) => report.sets.find((s) => s.name === name)!.error!;
    expect(err('typo')).toMatch(/Connection closed \(the server exited with code 1 before answering; its stderr: starting server \| Error: invalid toolset name: helmm, valid names are: core, config, helm\)/);
    expect(err('crash')).toMatch(/\(the server exited with code 3 before answering; it wrote nothing to stderr\)/);
    expect(err('nocfg')).toMatch(/its stderr: Error: cannot read config <local>\/kms\.toml: no such file or directory/);
    expect(text).not.toContain(homedir());
    expect(report.sets[0]).toMatchObject({ name: 'ok', ok: true });
    // the console error carries it too
    expect(io.stderr.join('\n')).toMatch(/flag set "typo": .*invalid toolset name: helmm/);
  });

  it('a server stopped by us is not reported as having exited', async () => {
    const io = mkIO();
    const dir = mkdtempSync(join(tmpdir(), 'mcs-exit-ok-'));
    expect(await cmdSnapshot({ childStderr: 'ignore', target: server, dir, cwd: dir }, io)).toBe(EXIT_OK);
    expect(io.stderr.join('\n')).not.toMatch(/exited with code/);
  });
});
