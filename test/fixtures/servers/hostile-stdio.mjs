/* global process, setTimeout */
// Hostile stdio MCP server for tests: raw newline-delimited JSON-RPC (no SDK), so it can misbehave.
// MODE=slowpages: every tools/list page takes 200 ms and points to another page.
// MODE=deep: one tool whose schema nests DEPTH (default 50,000) levels.
// MODE=wide: one tool whose schema nests DEPTH (default 27) object levels around LEAVES (default 200,000) string properties (~5.5 MB; ~79 MB pretty-printed).
// MODE=readonly: READ_ONLY=1 lists read tools only; unset adds write/destructive/unannotated tools (LESS_SAFE=1 also flips list_issues).
// MODE=contradict: one tool with readOnlyHint and destructiveHint both true, one plain read-only tool.
// MODE=big: tools/list answers with one ~1 MiB line (tests set a smaller message cap).
// MODE=names: one tool; with ADD=1 also a tool whose name and property carry newlines, workflow commands and terminal escapes.
// MODE=legacy: tool names with `##[cmd]` (runner legacy commands) and ZWSP/RLO/U+2028/NEL/NBSP.
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
    // HOSTILE_INFO=1: server name, version and title carry a newline + workflow command, ESC and an open code fence
    const evil = 'x\n::error::PWNED\u001b[31m```';
    const info = process.env.HOSTILE_INFO
      ? { name: `hostile-${MODE}${evil}`, version: `2${evil}`, title: evil }
      : { name: `hostile-${MODE}`, version: '1' };
    out({ jsonrpc: '2.0', id: msg.id, result: { protocolVersion: msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: info, instructions: evil } });
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
    out({ jsonrpc: '2.0', id: msg.id, error: { code: -32000, message: `boom\n::warning::owned \u001b]0;TITLE\u0007\u001b[2J ##[add-mask]DRIFT ##[stop-commands]tok ${'z'.repeat(300000)}` } });
  } else if (msg.method === 'tools/list' && MODE === 'legacy') {
    // runner legacy commands anywhere in a line, and characters a human viewer must never see raw
    const names = ['n ##[stop-commands]tok', 'n ##[error]V1', 'n ##[add-mask]DRIFT', 'n ##[ERROR file=README.md;line=1]F', 'zw\u200b::error::ZWSP', 'rlo\u202eevil', 'ls\u2028x', 'nel\u0085::error::NEL', 'nbsp\u00a0::error::NBSP'];
    const extra = process.env.ADD ? ['added ##[warning]W', 'added2\u202e\u200b'] : [];
    out({ jsonrpc: '2.0', id: msg.id, result: { tools: [...names, ...extra].map((name) => ({ name, description: `d ${name}`, inputSchema: { type: 'object', properties: { [name]: { type: 'unknown' } } } })) } });
  } else if (msg.method === 'tools/list' && MODE === 'slowpages') {
    const n = Number(msg.params?.cursor ?? 0) + 1;
    setTimeout(() => out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: `t${n}`, inputSchema: { type: 'object' } }], nextCursor: String(n) } }), 200);
  } else if (msg.method === 'tools/list' && MODE === 'deep') {
    const n = Number(process.env.DEPTH ?? 50000);
    const open = '{"type":"object","properties":{"a":';
    process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":{"tools":[{"name":"deep","inputSchema":${open.repeat(n)}{"type":"string"}${'}}'.repeat(n)}}]}}\n`);
  } else if (msg.method === 'tools/list' && MODE === 'wide') {
    const n = Number(process.env.DEPTH ?? 27);
    const leaves = Array.from({ length: Number(process.env.LEAVES ?? 200000) }, (_, i) => `"p${i}":{"type":"string"}`).join(',');
    const open = '{"type":"object","properties":{"n":';
    process.stdout.write(`{"jsonrpc":"2.0","id":${JSON.stringify(msg.id)},"result":{"tools":[{"name":"wide","inputSchema":${open.repeat(n)}{"type":"object","properties":{${leaves}}}${'}}'.repeat(n)}}]}}\n`);
  } else if (msg.method === 'tools/list' && MODE === 'contradict') {
    out({ jsonrpc: '2.0', id: msg.id, result: { tools: [
      { name: 'wipe_repo', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: true } },
      { name: 'list_repos', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true, destructiveHint: false } },
    ] } });
  } else if (msg.method === 'tools/list' && MODE === 'readonly') {
    // github-mcp-server issue 3747 shape: with READ_ONLY=yes only read tools; without it (fail-open) write and destructive tools appear
    const ro = { readOnlyHint: true };
    const tools = [
      { name: 'get_me', inputSchema: { type: 'object' }, annotations: ro },
      { name: 'list_issues', inputSchema: { type: 'object' }, annotations: process.env.READ_ONLY ? ro : { ...ro, readOnlyHint: process.env.LESS_SAFE ? false : true } },
    ];
    if (!process.env.READ_ONLY) {
      tools.push(
        { name: 'search_code', inputSchema: { type: 'object' }, annotations: ro },
        { name: 'merge_pull_request', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: false } },
        { name: 'delete_file', inputSchema: { type: 'object' }, annotations: { readOnlyHint: false, destructiveHint: true } },
        { name: 'create_issue', inputSchema: { type: 'object' } },
      );
    }
    out({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else if (msg.method === 'tools/list' && MODE === 'big') {
    out({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: 'big', description: 'x'.repeat(1 << 20), inputSchema: { type: 'object' } }] } });
  } else {
    out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  }
});
