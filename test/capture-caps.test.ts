/**
 * Resource caps on live capture (v0.2 stress round). Before the fix:
 *   - a server that returned a fresh `nextCursor` forever made every command
 *     hang with memory growing (1.2 GB in 90 s);
 *   - Streamable HTTP responses had no size cap (a 200 MB tools/list was
 *     buffered whole; an endless body grew ~140 MB/s until the timeout);
 *   - stdio was capped by the SDK at 10 MiB but reported only
 *     "Connection closed";
 *   - an exec `tools` listing had no size bound (3 calls per listed name).
 */

import { createServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { POSTHOG_EXEC } from '../src/adapters/index.js';
import { sweepInputFromExecSession } from '../src/adapters/exec.js';
import { MAX_PAGES, capture, captureFromTransport, openSessionOnTransport } from '../src/capture.js';

const HOSTILE = fileURLToPath(new URL('./fixtures/servers/hostile-stdio.mjs', import.meta.url));

const served = { pages: 0 };
function pagingServer(pageBytes = 10): Server {
  const s = new Server({ name: 'pager', version: '1' }, { capabilities: { tools: {} } });
  let n = 0;
  served.pages = 0;
  s.setRequestHandler(ListToolsRequestSchema, async () => {
    n++;
    served.pages = n;
    return { tools: [{ name: `t${n}`, description: 'x'.repeat(pageBytes), inputSchema: { type: 'object' as const } }], nextCursor: `c${n}` };
  });
  return s;
}

let http: HttpServer | undefined;
afterEach(async () => {
  if (http) await new Promise<void>((r) => http!.close(() => r()));
  http = undefined;
});

describe('pagination caps', () => {
  it(`stops a server that paginates forever after ${MAX_PAGES} pages, with a clear error`, async () => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await pagingServer().connect(s);
    const t0 = Date.now();
    await expect(captureFromTransport(c)).rejects.toThrow(new RegExp(`tools/list: still paginating after ${MAX_PAGES} pages`));
    expect(served.pages).toBe(MAX_PAGES);
    expect(Date.now() - t0).toBeLessThan(20_000);
  });

  it('stops when the pages add up past the list byte cap', async () => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    await pagingServer(100_000).connect(s);
    await expect(captureFromTransport(c, { maxListBytes: 1_000_000 })).rejects.toThrow(/tools\/list: more than 1000000 bytes across pages/);
  });
});

describe('message size caps', () => {
  it('stdio: a message over the cap fails with the cap in the error, not just "Connection closed"', async () => {
    const t = { kind: 'stdio' as const, command: process.execPath, args: [HOSTILE], env: { MODE: 'big' } };
    await expect(capture(t, { maxMessageBytes: 256 * 1024, stderr: 'ignore' })).rejects.toThrow(/server message larger than 262144 bytes/);
  });

  it('http: an endless response body is cut at the cap and the download cancelled', async () => {
    let written = 0;
    let closed = false;
    http = createServer(async (req, res) => {
      let body = '';
      for await (const ch of req) body += ch;
      if (req.method !== 'POST' || !body) {
        res.statusCode = 405; // GET (SSE) / DELETE (session end): not offered
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
        res.end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'flood', version: '1' } } }));
        return;
      }
      res.on('close', () => {
        closed = true;
      });
      res.write(`{"jsonrpc":"2.0","id":${msg.id},"result":{"tools":[`);
      const chunk = `{"name":"t","inputSchema":{"type":"object"},"description":"${'x'.repeat(64 * 1024)}"},`;
      while (!res.destroyed && written < 512 * 1024 * 1024) {
        written += chunk.length;
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
    });
    await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    await expect(capture({ kind: 'http', url }, { maxMessageBytes: 1024 * 1024, timeoutMs: 20_000 })).rejects.toThrow(/server message larger than 1048576 bytes/);
    await new Promise((r) => setTimeout(r, 200));
    expect(closed).toBe(true);
    expect(written).toBeLessThan(64 * 1024 * 1024);
  });

  it('http: content-length over the cap is refused before reading', async () => {
    http = createServer(async (req, res) => {
      let body = '';
      for await (const ch of req) body += ch;
      if (req.method !== 'POST' || !body) {
        res.statusCode = 405; // GET (SSE) / DELETE (session end): not offered
        res.end();
        return;
      }
      const msg = JSON.parse(body) as { id?: number };
      res.setHeader('content-type', 'application/json');
      res.setHeader('content-length', String(50 * 1024 * 1024));
      res.write(`{"jsonrpc":"2.0","id":${msg.id ?? 0}`);
    });
    await new Promise<void>((r) => http!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/mcp`;
    await expect(capture({ kind: 'http', url }, { maxMessageBytes: 1024 * 1024, timeoutMs: 5_000 })).rejects.toThrow(/server message larger than 1048576 bytes/);
  });
});

describe('exec listing cap', () => {
  it('refuses a `tools` listing longer than maxExecTools instead of making 3 calls per name', async () => {
    const [c, s] = InMemoryTransport.createLinkedPair();
    const srv = new McpServer({ name: 'exec-many', version: '1' });
    let calls = 0;
    srv.registerTool('exec', { description: 'x', inputSchema: { command: z.string(), context: z.string(), llm_model: z.string() } }, async ({ command }) => {
      calls++;
      if (command === 'tools') return { content: [{ type: 'text' as const, text: JSON.stringify(Array.from({ length: 50 }, (_, i) => `t${i}`)) }] };
      return { content: [{ type: 'text' as const, text: '{}' }] };
    });
    await srv.connect(s);
    const session = await openSessionOnTransport(c);
    try {
      await expect(sweepInputFromExecSession(session, { profile: POSTHOG_EXEC, maxExecTools: 10 }, { kind: 'stdio', command: 'x' })).rejects.toThrow(
        /`tools` listed 50 names, more than the 10 this sweep will query/,
      );
      expect(calls).toBe(1);
    } finally {
      await session.close();
    }
  });
});
