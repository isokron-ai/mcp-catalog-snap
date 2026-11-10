/**
 * Snapshot format 2 header (K-7 / PS-K8, K-G13): the initialize handshake
 * as sent and answered, and how the server was launched, with credentials
 * masked. Format 1 files are still read, byte-for-byte.
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';

import { capture, captureFromTransport, type Target } from '../src/capture.js';
import { cmdCheck, cmdHash, cmdSnapshot, EXIT_OK, type IO } from '../src/commands.js';
import { describeLaunch } from '../src/launch.js';
import { maskedArgs } from '../src/redact.js';
import { renderSnapshotHeader } from '../src/render.js';
import { runSweep } from '../src/sweep.js';
import { parseToolsListFile } from '../src/adapters/tools-list.js';
import { loadTokenizers } from '../src/tokenize.js';
import {
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_V1,
  buildSnapshot,
  parseSnapshot,
  serializeSnapshot,
  snapshotSelfConsistent,
} from '../src/snapshot.js';
import { VERSION } from '../src/version.js';

const FLAGS = fileURLToPath(new URL('./fixtures/servers/flags-stdio.mjs', import.meta.url));
const EXAMPLES = fileURLToPath(new URL('../examples/.mcp-catalog/', import.meta.url));

function mkIO(): IO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

const flags = (...args: string[]): Target => ({ kind: 'stdio', command: process.execPath, args: [FLAGS, ...args] });

describe('handshake (requested vs negotiated protocol, client capabilities)', () => {
  it('records what the client sent in initialize and what the server answered', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const server = new McpServer({ name: 'hs', version: '1.0.0' });
    server.registerTool('t', { description: 'T.' }, async () => ({ content: [] }));
    await server.connect(serverT);
    const raw = await captureFromTransport(clientT);
    await server.close();
    expect(raw.handshake).toEqual({
      requestedProtocolVersion: LATEST_PROTOCOL_VERSION,
      negotiatedProtocolVersion: LATEST_PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: 'mcp-catalog-snap', version: VERSION },
    });
    const snap = buildSnapshot(raw);
    expect(snap.format).toBe(SNAPSHOT_FORMAT);
    expect(snap.handshake).toEqual(raw.handshake);
    // a caller-supplied transport: nothing is known about the launch
    expect(snap.launch).toBeNull();
    expect(snap.flagSet).toBeNull();
  });

  it('keeps requested and negotiated apart when the server answers an older version', async () => {
    const raw = await capture(flags('--protocol', '2025-06-18'), { stderr: 'ignore' });
    expect(raw.handshake!.requestedProtocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    expect(raw.handshake!.negotiatedProtocolVersion).toBe('2025-06-18');
    expect(raw.protocolVersion).toBe('2025-06-18');
    const header = renderSnapshotHeader(buildSnapshot(raw));
    expect(header).toContain(`protocolVersion: 2025-06-18 (requested ${LATEST_PROTOCOL_VERSION})`);
    expect(header).toContain('client caps:     {}');
  });

  it('reaches the sweep report too', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-hs-sweep-'));
    const io = mkIO();
    expect(await cmdSnapshot({ childStderr: 'ignore', target: flags('--protocol', '2025-06-18'), dir, cwd: dir, quiet: true }, io)).toBe(EXIT_OK);
    const file = join(dir, 'flags-server.json');
    const report = runSweep(parseToolsListFile(readFileSync(file, 'utf8'), 'flags-server.json'), { tokenizers: await loadTokenizers(['chars4']) });
    expect(report.handshake?.negotiatedProtocolVersion).toBe('2025-06-18');
    expect(report.handshake?.requestedProtocolVersion).toBe(LATEST_PROTOCOL_VERSION);
  });
});

describe('launch record (server command, arguments, flags, environment)', () => {
  it('records the command line and caller env with credentials masked, in the file and nowhere hashed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-launch-'));
    const secretArg = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const secretEnv = 'sk-live-0123456789abcdefghij';
    const target: Target = {
      kind: 'stdio',
      command: process.execPath,
      args: [FLAGS, '--toolsets', 'core,helm', '--read-only', '--token', secretArg, '--kubeconfig=/k/config'],
      env: { API_TOKEN: secretEnv, KUBE_NAMESPACE: 'audit' },
    };
    const io = mkIO();
    expect(await cmdSnapshot({ childStderr: 'ignore', target, dir, cwd: dir }, io)).toBe(EXIT_OK);
    const text = readFileSync(join(dir, 'flags-server.json'), 'utf8');
    expect(text).not.toContain(secretArg);
    expect(text).not.toContain(secretEnv);
    const snap = parseSnapshot(text, 'f');
    expect(snap.launch).toEqual({
      transport: 'stdio',
      command: process.execPath,
      // (a long path segment that looks like a token is masked too: that is maskedArgs' rule, not specific to this record)
      args: [...maskedArgs([FLAGS]), '--toolsets', 'core,helm', '--read-only', '--token', '***', '--kubeconfig=/k/config'],
      env: { API_TOKEN: '***', KUBE_NAMESPACE: 'audit' },
      telemetryEnv: expect.objectContaining({ DO_NOT_TRACK: '1' }) as unknown as Record<string, string>,
    });
    // the console summary names the command and counts the arguments, never shows them
    const out = io.stdout.join('\n');
    expect(out).toMatch(/launch: {10}stdio node\S* with 7 argument\(s\), env API_TOKEN, KUBE_NAMESPACE/);
    expect(out).not.toContain('core,helm');
    // header fields are not hashed: same catalog, same sha256, whatever the launch
    const other = buildSnapshot({ server: snap.server, protocolVersion: snap.protocolVersion, ...snap.catalog });
    expect(other.launch).toBeNull();
    expect(other.sha256).toBe(snap.sha256);
  });

  it('records an http target as origin + path and header names only', () => {
    const rec = describeLaunch({ kind: 'http', url: 'https://u:p@mcp.example.com/v1/mcp?api_key=abcdefgh12345678', headers: { Authorization: 'Bearer abcdefgh12345678', 'X-MCP-Toolsets': 'repos' } });
    expect(rec).toEqual({ transport: 'http', url: 'https://mcp.example.com/v1/mcp [query redacted]', headers: ['Authorization', 'X-MCP-Toolsets'] });
    expect(JSON.stringify(rec)).not.toContain('abcdefgh12345678');
  });

  it('masks a credential passed docker-style (-e NAME=VALUE) and in connection strings', () => {
    const rec = describeLaunch({
      kind: 'stdio',
      command: 'docker',
      args: ['run', '-i', '--rm', '-e', 'GH_TOKEN=abcdefgh12345678', 'img', 'postgresql://u:pw0rd-abcdefgh@db/x', '--toolsets=repos'],
    });
    const text = JSON.stringify(rec);
    expect(text).not.toContain('abcdefgh12345678');
    expect(text).not.toContain('pw0rd-abcdefgh');
    expect(rec.transport === 'stdio' && rec.args.slice(0, 3)).toEqual(['run', '-i', '--rm']);
    expect(rec.transport === 'stdio' && rec.args.at(-1)).toBe('--toolsets=repos');
  });
});

describe('format 1 snapshots', () => {
  const v1Path = join(EXAMPLES, 'kronicle-lite.json');
  const v1Text = readFileSync(v1Path, 'utf8');

  it('the committed examples are format 1 and still parse, round-tripping byte-for-byte', () => {
    expect(JSON.parse(v1Text).format).toBe(SNAPSHOT_FORMAT_V1);
    const snap = parseSnapshot(v1Text, v1Path);
    expect(snap.format).toBe(SNAPSHOT_FORMAT_V1);
    expect(snap.handshake).toBeUndefined();
    expect(snap.launch).toBeUndefined();
    expect(snapshotSelfConsistent(snap)).toBe(true);
    expect(serializeSnapshot(snap)).toBe(v1Text);
  });

  it('hash FILE reads format 1 and format 2 alike', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-v1v2-'));
    const v1 = parseSnapshot(v1Text, v1Path);
    const v2 = buildSnapshot({ server: v1.server, protocolVersion: v1.protocolVersion, ...v1.catalog });
    writeFileSync(join(dir, 'v2.json'), serializeSnapshot(v2));
    const a = mkIO();
    const b = mkIO();
    expect(await cmdHash({ file: v1Path }, a)).toBe(EXIT_OK);
    expect(await cmdHash({ file: join(dir, 'v2.json') }, b)).toBe(EXIT_OK);
    expect(a.stdout).toEqual([v1.sha256]);
    expect(b.stdout).toEqual([v1.sha256]);
  });

  it('check compares a live capture with a format 1 baseline, and --update writes format 2', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-v1check-'));
    const live = await capture(flags(), { stderr: 'ignore' });
    const v1 = { ...buildSnapshot(live), format: SNAPSHOT_FORMAT_V1 } as Record<string, unknown>;
    delete v1['handshake'];
    delete v1['launch'];
    delete v1['flagSet'];
    // one tool fewer in the baseline: check must report it and --update must rewrite in format 2
    const cat = v1['catalog'] as { tools: { name: string }[] };
    cat.tools = cat.tools.filter((t) => t.name !== 'pods_list');
    const parsed = parseSnapshot(JSON.stringify(v1), 'v1');
    writeFileSync(join(dir, 'flags-server.json'), serializeSnapshot({ ...parsed, sha256: buildSnapshot({ server: parsed.server, protocolVersion: null, ...parsed.catalog }).sha256 }));
    const io = mkIO();
    const code = await cmdCheck({ childStderr: 'ignore', target: flags(), dir, cwd: dir, update: true }, io);
    expect(code).toBe(1);
    expect(io.stdout.join('\n')).toContain('+ pods_list');
    const after = JSON.parse(readFileSync(join(dir, 'flags-server.json'), 'utf8')) as Record<string, unknown>;
    expect(after['format']).toBe(SNAPSHOT_FORMAT);
    expect(after['launch']).toMatchObject({ transport: 'stdio', args: maskedArgs([FLAGS]) });
  });

  it('format 2 refuses a malformed header and names both formats on an unknown one', () => {
    const snap = buildSnapshot({ server: { name: 's', version: '1' }, protocolVersion: null, tools: [], prompts: [], resourceTemplates: [] });
    const bad = (patch: Record<string, unknown>) => JSON.stringify({ ...JSON.parse(serializeSnapshot(snap)), ...patch });
    expect(() => parseSnapshot(bad({ handshake: 'x' }), 'f')).toThrow(/"handshake" must be an object or null/);
    expect(() => parseSnapshot(bad({ launch: [] }), 'f')).toThrow(/"launch" must be an object or null/);
    expect(() => parseSnapshot(bad({ flagSet: 1 }), 'f')).toThrow(/"flagSet" must be a string or null/);
    expect(() => parseSnapshot(bad({ format: 'mcp-catalog-snap/3' }), 'f')).toThrow(/expected mcp-catalog-snap\/2 or mcp-catalog-snap\/1/);
    // a format 2 file without the new fields (hand-written) still reads, with nulls
    const minimal = JSON.parse(serializeSnapshot(snap)) as Record<string, unknown>;
    delete minimal['handshake'];
    delete minimal['launch'];
    const back = parseSnapshot(JSON.stringify(minimal), 'f');
    expect(back.handshake).toBeNull();
    expect(back.launch).toBeNull();
  });
});
