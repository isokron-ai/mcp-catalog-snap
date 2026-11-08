/**
 * Credentials carried in a URL or a stdio command line (v0.2 stress round).
 *
 * Before the fix, with a canary planted in each place:
 *   - `snapshot` / `check` error lines printed the full stdio command line
 *     (`-- server --token <canary>`) and the full URL with its query
 *     (`?api_key=<canary>`), and `check --json/--report` stored them as the
 *     server label;
 *   - a URL with `user:password@` failed inside fetch with an error that
 *     quoted the password.
 * Config files expand `${VAR}` into `command` and `url`, so these are the
 * places CI secrets land.
 */

import { execFile, spawnSync } from 'node:child_process';
import { createServer, type Server as HttpServer } from 'node:http';
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { describeTarget } from '../src/capture.js';
import { targetSecrets } from '../src/redact.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const CANARY = `CANARY_SK_${Math.random().toString(36).slice(2)}x9`;

function run(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', HOME: cwd, ...env } });
  return { code: r.status, all: `${r.stdout}\n${r.stderr}`, stderr: r.stderr };
}

/** Async variant: the test process must keep serving its in-process HTTP server meanwhile. */
function runAsync(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<{ code: number; all: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', HOME: cwd, ...env } }, (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, all: `${stdout}\n${stderr}`, stderr });
    });
  });
}

/** stdout + stderr + every file written under `dir`. */
function everything(dir: string, out: string): string {
  let s = out;
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else s += `\n${readFileSync(join(d, e.name), 'utf8')}`;
    }
  };
  walk(dir);
  return s;
}

let http: HttpServer | undefined;
afterEach(async () => {
  if (http) await new Promise<void>((r) => http!.close(() => r()));
  http = undefined;
});

describe('targetSecrets / describeTarget', () => {
  it('collect URL passwords, credential-named query values, secret-looking path segments and credential args', () => {
    const s = targetSecrets({ kind: 'http', url: `https://u:${CANARY}pw@h/mcp/${CANARY}A1/x?api_key=${CANARY}q&page=streamable&sig_token=${CANARY}s&tenant=4f9c2a1b3d5e6f7a` });
    expect(s).toEqual(expect.arrayContaining([`${CANARY}pw`, `${CANARY}q`, `${CANARY}s`]));
    // ids are not credentials by shape alone: a catalog echoing them must not be refused
    expect(s).not.toContain('streamable');
    expect(s).not.toContain('4f9c2a1b3d5e6f7a');
    expect(s).not.toContain(`${CANARY}A1`);
    const a = targetSecrets({ kind: 'stdio', command: 'srv', args: ['--token', `${CANARY}t`, `--api-key=${CANARY}k`, '--verbose', 'serve', '--project', '4f9c2a1b3d5e6f7a'] });
    expect(a).toEqual(expect.arrayContaining([`${CANARY}t`, `${CANARY}k`]));
    expect(a).not.toContain('4f9c2a1b3d5e6f7a');
  });

  it('labels targets without query, userinfo or arguments', () => {
    expect(describeTarget({ kind: 'http', url: `https://u:p@h:8443/mcp?key=${CANARY}` })).toBe('https://h:8443/mcp');
    expect(describeTarget({ kind: 'http', url: `https://h/mcp/${CANARY}A1/x` })).toBe('https://h/mcp/***/x');
    expect(describeTarget({ kind: 'stdio', command: '/usr/local/bin/srv', args: ['--token', CANARY] })).toBe('srv …');
    expect(describeTarget({ kind: 'stdio', command: 'srv', args: [] })).toBe('srv');
  });
});

describe('CLI: canaries never reach output or files', () => {
  it('stdio command line with a token: snapshot / check / hash / sweep errors', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-sec-'));
    for (const cmd of [['snapshot'], ['check'], ['hash'], ['sweep'], ['check', '--json', '--report', 'r.json']]) {
      const r = run([...cmd, '--', '/nonexistent/server', '--token', CANARY], dir);
      expect(r.code).toBe(2);
      expect(everything(dir, r.all)).not.toContain(CANARY);
    }
  });

  it('URL query and path credentials: error lines and check reports', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-sec-'));
    const url = `http://127.0.0.1:9/mcp/${CANARY}A1?api_key=${CANARY}`;
    for (const cmd of [['snapshot'], ['check'], ['hash'], ['sweep'], ['check', '--json', '--report', 'r.json']]) {
      const r = run([...cmd, '--url', url, '--timeout', '2000'], dir);
      expect(r.code).toBe(2);
      expect(everything(dir, r.all)).not.toContain(CANARY);
    }
  });

  it('URL with user:password@ is refused up front without quoting it', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-sec-'));
    for (const cmd of [['snapshot'], ['sweep'], ['hash']]) {
      const r = run([...cmd, '--url', `http://user:${CANARY}@127.0.0.1:9/mcp`, '--timeout', '2000'], dir);
      expect(r.code).toBe(2);
      expect(r.stderr).toMatch(/must not carry user:password@/);
      expect(r.all).not.toContain(CANARY);
    }
  });

  it('config file: ${VAR} expanded into a URL query is scrubbed even when the server echoes it', async () => {
    http = createServer(async (req, res) => {
      let body = '';
      for await (const ch of req) body += ch;
      if (req.method !== 'POST' || !body) {
        res.statusCode = 405;
        res.end();
        return;
      }
      const msg = JSON.parse(body) as { id?: number; method: string; params?: { protocolVersion: string } };
      if (msg.id === undefined) {
        res.statusCode = 202;
        res.end();
        return;
      }
      res.setHeader('content-type', 'application/json');
      if (msg.method === 'initialize') {
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } } }));
        return;
      }
      const echoed = new URL(req.url!, 'http://x').searchParams.get('token');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: `t_${echoed}`, inputSchema: { type: 'object' } }] } }));
    });
    await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
    const port = (http.address() as AddressInfo).port;
    const dir = mkdtempSync(join(tmpdir(), 'mcs-sec-'));
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 'echo', url: `http://127.0.0.1:${port}/mcp?token=\${TOK}` }] }));
    const env = { TOK: CANARY };
    const snap = await runAsync(['snapshot'], dir, env);
    expect(snap.code).toBe(2);
    expect(snap.stderr).toMatch(/contains a credential this request sent/);
    const sweep = await runAsync(['sweep', '--json', '--url', `http://127.0.0.1:${port}/mcp?token=${CANARY}`], dir);
    expect(sweep.code).toBe(0);
    expect(everything(dir, snap.all + sweep.all)).not.toContain(CANARY);
  });
});
