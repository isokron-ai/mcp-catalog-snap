/**
 * Streamable HTTP end-to-end: an SDK McpServer behind
 * StreamableHTTPServerTransport on a local node:http server, captured through
 * our `--url` / `--header` path.
 */

import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { capture } from '../src/capture.js';
import { cmdHash, cmdSnapshot, EXIT_ERROR, EXIT_OK, type IO } from '../src/commands.js';
import { buildSnapshot } from '../src/snapshot.js';

function mkIO(): IO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (s) => stdout.push(s), err: (s) => stderr.push(s) };
}

describe('capture over Streamable HTTP', () => {
  let http: HttpServer;
  let url: string;
  const seenAuth: string[] = [];
  const sessions = new Map<string, StreamableHTTPServerTransport>();

  beforeAll(async () => {
    http = createServer(async (req: IncomingMessage, res: ServerResponse) => {
      if (req.url !== '/mcp') {
        res.statusCode = 404;
        res.end();
        return;
      }
      if (req.headers.authorization !== 'Bearer t0k3n') {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      seenAuth.push(req.headers.authorization);
      const sid = req.headers['mcp-session-id'];
      let transport = typeof sid === 'string' ? sessions.get(sid) : undefined;
      if (!transport) {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id) => {
            sessions.set(id, transport!);
          },
        });
        const server = new McpServer({ name: 'http-demo', version: '3.1.4' });
        server.registerTool('ping', { description: 'Ping.', inputSchema: { n: z.number() } }, async () => ({ content: [] }));
        await server.connect(transport);
      }
      await transport.handleRequest(req, res);
    });
    await new Promise<void>((r) => http.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
  });

  afterAll(async () => {
    for (const t of sessions.values()) await t.close();
    await new Promise<void>((r) => http.close(() => r()));
  });

  it('captures through --url with --header and records the negotiated protocol version', async () => {
    const raw = await capture({ kind: 'http', url, headers: { Authorization: 'Bearer t0k3n' } });
    expect(raw.server).toEqual({ name: 'http-demo', version: '3.1.4' });
    expect(raw.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const snap = buildSnapshot(raw);
    expect(snap.catalog.tools.map((t) => t.name)).toEqual(['ping']);
    expect(seenAuth.length).toBeGreaterThan(0);
  });

  it('fails with exit 2 (not a hang) when the server rejects the request', async () => {
    const io = mkIO();
    const code = await cmdHash({ target: { kind: 'http', url }, timeoutMs: 5_000 }, io);
    expect(code).toBe(EXIT_ERROR);
    expect(io.stderr.join("\n")).toMatch(/error: .*unauthorized/);
  });

  it('snapshot --no-write prints the file for an http target', async () => {
    const io = mkIO();
    const code = await cmdSnapshot({ target: { kind: 'http', url, headers: { Authorization: 'Bearer t0k3n' } }, noWrite: true }, io);
    expect(code).toBe(EXIT_OK);
    const parsed = JSON.parse(io.stdout.join('\n')) as { server: { name: string }; sha256: string };
    expect(parsed.server.name).toBe('http-demo');
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('rejects a malformed --url before dialing', async () => {
    await expect(capture({ kind: 'http', url: 'not a url' })).rejects.toThrow(/invalid --url/);
  });
});
