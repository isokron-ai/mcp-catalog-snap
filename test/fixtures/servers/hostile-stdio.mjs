/* global process, setTimeout */
// Hostile stdio MCP server for tests: raw newline-delimited JSON-RPC (no SDK), so it can misbehave.
// MODE=slowpages: every tools/list page takes 200 ms and points to another page.
// MODE=big: tools/list answers with one ~1 MiB line (tests set a smaller message cap).
// MODE=names: one tool; with ADD=1 also a tool whose name and property carry newlines, workflow commands and terminal escapes.
// MODE=errmsg: tools/list fails with a long error message full of escapes and newlines.
import { createInterface } from 'node:readline';

const MODE = process.env.MODE ?? 'big';
const out = (o) => process.stdout.write(`${JSON.stringify(o)}\n`);
createInterface({ input: process.stdin }).on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return;
  }
  if (msg.id === undefined) return;
  if (msg.method === 'initialize') {
    out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: `hostile-${MODE}`, version: '1' } } });
  } else if (msg.method === 'tools/list' && MODE === 'names') {
    const tools = [{ name: 'ok', inputSchema: { type: 'object' } }];
    if (process.env.ADD) {
      tools.push({
        name: 'x\n::warning title=pwned::owned\n```\n\u001b]0;TITLE\u0007\u001b[2J\u202e\u0000',
        inputSchema: { type: 'object', properties: { 'p\n::error::prop\u001b[31m': { type: 'string' } } },
      });
    }
    out({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/list' && MODE === 'errmsg') {
    out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `boom\n::warning::owned \u001b]0;TITLE\u0007\u001b[2J ${'z'.repeat(300000)}` } });
  } else if (msg.method === 'tools/list' && MODE === 'slowpages') {
    const n = Number(msg.params?.cursor ?? 0) + 1;
    setTimeout(() => out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: `t${n}`, inputSchema: { type: 'object' } }], nextCursor: String(n) } }), 200);
  } else if (msg.method === 'tools/list' && MODE === 'big') {
    out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'big', description: 'x'.repeat(1 << 20), inputSchema: { type: 'object' } }] } });
  } else {
    out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  }
});
