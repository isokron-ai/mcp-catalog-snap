/**
 * Canary round 2: the echoing server plants the token in every place a
 * formatter could transform it (markdown escaping of `_`, JSON-pointer
 * `~1` for `/`, JSON escaping, percent-encoding, base64 std/url-safe,
 * truncated windows). No command and no output format may leak any form.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { redact, secretVariants } from '../src/redact.js';
import { buildSnapshot, serializeSnapshot } from '../src/snapshot.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const TOKEN = 'zq9_TOKEN/9f3b+7c2e41d8~x';
const tmp = (): string => mkdtempSync(join(tmpdir(), 'mcs-redact2-'));

/** Forms a formatter could produce, built independently of src/redact.ts. */
function leakForms(t: string): string[] {
  const md = t.replace(/[\\`*_[\]<>|~&]/g, (c) => `\\${c}`);
  const ptr = t.replace(/~/g, '~0').replace(/\//g, '~1');
  const json = JSON.stringify(t).slice(1, -1);
  const pct = encodeURIComponent(t);
  const b64 = Buffer.from(t).toString('base64');
  const b64u = Buffer.from(t).toString('base64url');
  return [t, md, ptr, json, pct, b64.replace(/=+$/, ''), b64u, encodeURIComponent(ptr)];
}

function leaks(text: string): string[] {
  const found: string[] = [];
  for (const form of leakForms(TOKEN)) {
    for (let i = 0; i + 10 <= form.length; i++) {
      const piece = form.slice(i, i + 10);
      if (text.includes(piece)) {
        found.push(piece);
        break;
      }
    }
  }
  return found;
}

function cli(args: string[], cwd: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env['PATH'] ?? '', HOME: cwd, MCS_TOKEN: TOKEN } });
    let out = '';
    child.stdout.on('data', (d: Buffer) => (out += d.toString()));
    child.stderr.on('data', (d: Buffer) => (out += d.toString()));
    child.on('close', () => resolve(out));
  });
}

function files(dir: string): string {
  let all = '';
  for (const f of readdirSync(dir, { recursive: true, withFileTypes: true })) if (f.isFile()) all += readFileSync(join(f.parentPath, f.name), 'utf8');
  return all;
}

describe('token planted in every formatter-sensitive position', () => {
  let http: HttpServer;
  let url: string;
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  beforeAll(async () => {
    http = createServer(async (req, res) => {
      const tok = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
      if (req.url === '/deny') {
        res.statusCode = 403;
        res.end(`no: ${tok} ${encodeURIComponent(tok)} ${Buffer.from(tok).toString('base64')}`);
        return;
      }
      const sid = req.headers['mcp-session-id'];
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
      if (!transport) {
        const t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => void sessions.set(id, t) });
        transport = t;
        const server = new McpServer({ name: 'echo2', version: '1.0.0' });
        const schema = {
          type: 'object',
          description: `pct ${encodeURIComponent(tok)} b64 ${Buffer.from(tok).toString('base64')} b64u ${Buffer.from(tok).toString('base64url')}`,
          properties: {
            [tok]: { type: 'object', properties: { [`${tok}/inner`]: { type: 'unknown' } }, required: [tok] },
            pick: { type: 'string', enum: [tok, ...Array.from({ length: 25 }, (_, i) => `v${i}`)], description: `* \`${tok}\` - ${tok}`, default: `${tok}-not-in-enum` },
            num: { type: 'integer', default: tok },
            blob: { type: 'string', default: JSON.stringify({ token: tok, more: 'x'.repeat(50) }) },
          },
          required: [tok, `missing-${tok}`],
        };
        server.server.registerCapabilities({ tools: {} });
        server.server.setRequestHandler((await import('@modelcontextprotocol/sdk/types.js')).ListToolsRequestSchema, async () => ({
          tools: [
            { name: 'whoami', description: `Called with ${tok}. ${'pad '.repeat(40)}${tok}`, inputSchema: schema },
            { name: `user-delete`, description: tok, inputSchema: { type: 'object' }, annotations: { destructiveHint: false, title: tok } },
          ],
        }));
        void z;
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((r) => http.close(() => r())));

  it('0 leaks across every command and output format', async () => {
    const dir = tmp();
    const outputs: string[] = [];
    const auth = ['--bearer-env', 'MCS_TOKEN'];
    for (const path of ['/deny', '/mcp']) {
      outputs.push(await cli(['snapshot', '--url', `${url}${path}`, ...auth, '--dir', join(dir, 's')], dir));
      outputs.push(await cli(['snapshot', '--url', `${url}${path}`, ...auth, '--no-write'], dir));
      outputs.push(await cli(['hash', '--url', `${url}${path}`, ...auth], dir));
    }
    const base = join(dir, 'base');
    mkdirSync(base, { recursive: true });
    const snap = buildSnapshot(
      { server: { name: 'echo2', version: '1.0.0' }, protocolVersion: null, tools: [{ name: 'whoami', description: 'old', inputSchema: { type: 'object' } }], prompts: [], resourceTemplates: [] },
      { capturedAt: 't' },
    );
    writeFileSync(join(base, 'echo2.json'), serializeSnapshot(snap));
    for (const extra of [[], ['--json'], ['--report', join(dir, 'check.json')], ['--update'], ['--ignore-descriptions']]) {
      outputs.push(await cli(['check', '--url', `${url}/mcp`, ...auth, '--dir', base, ...extra], dir));
    }
    for (const extra of [[], ['--json'], ['--report', join(dir, 'r.json'), '--md', join(dir, 'r.md'), '--top', '50'], ['--tokenizers', 'cl100k,o200k,chars4', '--enum-max', '2']]) {
      outputs.push(await cli(['sweep', '--url', `${url}/mcp`, ...auth, ...extra], dir));
    }
    outputs.push(await cli(['sweep', '--url', `${url}/deny`, ...auth], dir));
    const all = outputs.join('\n') + files(dir);
    expect(outputs[outputs.length - 3]).toContain('# MCP static sweep');
    expect(all).toContain('***');
    expect(leaks(all)).toEqual([]);
  }, 120_000);

  it('a bearer shorter than 8 characters is refused', async () => {
    const dir = tmp();
    expect(await cli(['hash', '--url', `${url}/mcp`, '--header', 'Authorization: Bearer abc'], dir)).toMatch(/at least 8 characters/);
  });
});

describe('redact() second line of defense', () => {
  it('matches markdown, pointer, JSON, percent and base64 forms and masks prefixes at cut points', () => {
    const variants = secretVariants([TOKEN]);
    for (const form of leakForms(TOKEN)) expect(redact(`x ${form} y`, variants), form).not.toContain(form.slice(0, 10));
    expect(redact(`window …${TOKEN.slice(0, 7)}…`, variants)).not.toContain(TOKEN.slice(0, 7));
    expect(redact(`…${TOKEN.slice(-8)} tail`, variants)).not.toContain(TOKEN.slice(-8));
    expect(redact('a short word like bearer stays', variants)).toBe('a short word like bearer stays');
  });
});

describe('the report model is scrubbed before rendering', () => {
  it('sweepOutputs never hands a renderer the raw token (no output-layer scrubber involved)', async () => {
    const { parseToolsListFile } = await import('../src/adapters/index.js');
    const { runSweep } = await import('../src/sweep.js');
    const { loadTokenizers } = await import('../src/tokenize.js');
    const { sweepOutputs } = await import('../src/cmd-sweep.js');
    const [t] = await loadTokenizers(['cl100k']);
    const schema = { type: 'object', properties: { [TOKEN]: { type: 'unknown', default: TOKEN, enum: [1] } }, required: [`${TOKEN}_x`] };
    const r = runSweep(parseToolsListFile(JSON.stringify({ tools: [{ name: `t_${TOKEN}`, inputSchema: schema }] }), 'f.json'), { tokenizers: [t!] });
    const { report, json, md } = sweepOutputs(r, secretVariants([TOKEN]));
    expect(JSON.stringify(report)).not.toContain(TOKEN.slice(0, 10));
    expect(leaks(json + md)).toEqual([]);
    expect(md).toContain('***');
  });
});
