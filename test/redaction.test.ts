/**
 * Canary: a server that echoes the Authorization header back (in tool
 * descriptions and in error bodies). No command may print the token or
 * write it to disk.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { sourceOf } from '../src/adapters/tools-list.js';
import { mdText } from '../src/report-md.js';
import { buildSnapshot, serializeSnapshot } from '../src/snapshot.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const TOKEN = 'canary_TOKEN_9f3b7c2e41d8';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'mcs-redact-'));

/** Async spawn: the canary server lives in this process, so spawnSync would deadlock it. */
function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env['PATH'] ?? '', HOME: cwd, MCS_TOKEN: TOKEN, ...env } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

function filesUnder(dir: string): string {
  let all = '';
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (f.isFile()) all += readFileSync(join(f.parentPath, f.name), 'utf8');
  }
  return all;
}

describe('bearer token canary (server echoes Authorization)', () => {
  let http: HttpServer;
  let base: string;
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  beforeAll(async () => {
    http = createServer(async (req, res) => {
      const auth = String(req.headers.authorization ?? '');
      if (req.url === '/deny') {
        res.statusCode = 401;
        res.end(`denied: you sent "${auth}"`);
        return;
      }
      const sid = req.headers['mcp-session-id'];
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
      if (!transport) {
        const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void sessions.set(id, t) });
        transport = t;
        const server = new McpServer({ name: 'echo', version: '1.0.0' });
        server.registerTool('whoami', { description: `Called with ${auth}.`, inputSchema: { n: z.number() } }, async () => ({ content: [] }));
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  const ok = (r: { out: string }): void => expect(r.out).not.toContain(TOKEN);

  it('snapshot / hash / check / sweep never print the token on an error response', async () => {
    const dir = tmp();
    for (const args of [['snapshot'], ['hash'], ['check', '--json'], ['sweep'], ['sweep', '--json']]) {
      const r = await cli([...args, '--url', `${base}/deny`, '--bearer-env', 'MCS_TOKEN'], dir);
      expect(r.code, args.join(' ')).toBe(2);
      ok(r);
    }
    const viaHeader = await cli(['hash', '--url', `${base}/deny`, '--header', `Authorization: Bearer ${TOKEN}`], dir);
    ok(viaHeader);
  });

  it('a catalog that contains the token is never written or printed', async () => {
    const dir = tmp();
    const url = `${base}/mcp`;
    const snap = await cli(['snapshot', '--url', url, '--bearer-env', 'MCS_TOKEN', '--dir', join(dir, 'snaps')], dir);
    expect(snap.code).toBe(2);
    expect(snap.out).toMatch(/credential/);
    ok(snap);
    const noWrite = await cli(['snapshot', '--url', url, '--bearer-env', 'MCS_TOKEN', '--no-write'], dir);
    ok(noWrite);

    // a stored baseline, then check against the echoing server: diff text, --json and --report are redacted
    const base0 = buildSnapshot(
      { server: { name: 'echo', version: '1.0.0' }, protocolVersion: null, tools: [{ name: 'whoami', description: 'old', inputSchema: { type: 'object' } }], prompts: [], resourceTemplates: [] },
      { capturedAt: 't' },
    );
    const snaps = join(dir, 'base');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(snaps, { recursive: true });
    writeFileSync(join(snaps, 'echo.json'), serializeSnapshot(base0));
    for (const extra of [[], ['--json'], ['--report', join(dir, 'report.json')], ['--update']]) {
      const r = await cli(['check', '--url', url, '--bearer-env', 'MCS_TOKEN', '--dir', snaps, ...extra], dir);
      expect(r.code, extra.join(' ')).not.toBe(0);
      ok(r);
    }
    expect(existsSync(join(dir, 'report.json'))).toBe(true);

    const sw = await cli(['sweep', '--url', url, '--bearer-env', 'MCS_TOKEN', '--json', '--report', join(dir, 's.json'), '--md', join(dir, 's.md')], dir);
    expect(sw.code).toBe(0);
    ok(sw);
    expect(filesUnder(dir)).not.toContain(TOKEN);
  });

  it('--bearer-* is an error for stdio and config targets', async () => {
    const dir = tmp();
    const r = await cli(['sweep', '--bearer-env', 'MCS_TOKEN', '--', 'node', '-e', '0'], dir);
    expect(r.code).toBe(2);
    expect(r.out).toMatch(/--url targets only/);
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 's', command: ['node', '-e', '0'] }] }));
    expect((await cli(['check', '--bearer-env', 'MCS_TOKEN'], dir)).out).toMatch(/--url targets only/);
  });
});

describe('source and markdown hygiene', () => {
  it('sourceOf drops credential-looking path segments', () => {
    expect(sourceOf({ kind: 'http', url: 'https://mcp.example.com/v1/sk_live_51HxQ2eKz9aB3cD4eF5g/mcp' })).toEqual({ kind: 'http', url: 'https://mcp.example.com/v1/***/mcp' });
    expect(sourceOf({ kind: 'http', url: 'https://mcp.example.com/u/0123456789abcdef0123456789abcdef/sse' })).toEqual({ kind: 'http', url: 'https://mcp.example.com/u/***/sse' });
    expect(sourceOf({ kind: 'http', url: 'https://mcp.example.com/api/project-settings/mcp' })).toEqual({ kind: 'http', url: 'https://mcp.example.com/api/project-settings/mcp' });
  });

  it('markdown text cannot autolink URLs or ping @-mentions', () => {
    const t = mdText('see https://evil.example/x and www.evil.example, cc @everyone and a@b.co');
    expect(t).not.toMatch(/https:\/\//);
    expect(t).not.toMatch(/www\./);
    expect(t).not.toMatch(/@[A-Za-z]/);
  });
});
