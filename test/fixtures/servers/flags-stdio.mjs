/* global process */
// Flag-dependent stdio MCP server for tests (raw newline-delimited JSON-RPC, no SDK), shaped like
// kubernetes-mcp-server: the catalog depends on the command line.
//   --toolsets a,b         toolsets to register (core, config, helm; default core,config)
//   --read-only            only read-only tools; pods_run is replaced by a read-only dry-run variant of the same name
//   --disable-destructive  drop destructive tools
//   --crash                exit 3 before answering initialize
//   --fail-config FILE     write "Error: cannot read config FILE: no such file or directory" to stderr, exit 2
//   (an unknown toolset name is refused like a real server does: an error line on stderr, exit 1)
//   --protocol V           answer initialize with protocolVersion V (default: echo the requested one)
// Env: SHOW_ENV=A,B lists a tool "env" whose description is the JSON of those variables as this process sees them.
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const value = (f) => {
  const i = argv.indexOf(f);
  return i >= 0 ? argv[i + 1] : undefined;
};
if (flag('--crash')) process.exit(3);
if (value('--fail-config') !== undefined) {
  process.stderr.write(`Error: cannot read config ${value('--fail-config')}: no such file or directory\n`);
  process.exit(2);
}

const toolsets = (value('--toolsets') ?? 'core,config').split(',');
const unknownSet = toolsets.find((t) => !['core', 'config', 'helm'].includes(t));
if (unknownSet !== undefined) {
  process.stderr.write('starting server\n');
  process.stderr.write(`Error: invalid toolset name: ${unknownSet}, valid names are: core, config, helm\n`);
  process.exit(1);
}
const readOnly = flag('--read-only');
const noDestructive = flag('--disable-destructive');
const RO = { readOnlyHint: true };
const W = { readOnlyHint: false, destructiveHint: false };
const D = { readOnlyHint: false, destructiveHint: true };
const obj = (props = {}) => ({ type: 'object', properties: props });

const all = [
  { set: 'core', name: 'pods_list', inputSchema: obj({ namespace: { type: 'string' } }), annotations: RO },
  { set: 'core', name: 'pods_delete', inputSchema: obj({ name: { type: 'string' } }), annotations: D },
  readOnly
    ? { set: 'core', name: 'pods_run', description: 'Dry-run a pod (read-only mode).', inputSchema: obj({ image: { type: 'string' } }), annotations: RO }
    : { set: 'core', name: 'pods_run', description: 'Run a pod.', inputSchema: obj({ image: { type: 'string' }, namespace: { type: 'string' } }), annotations: W },
  { set: 'config', name: 'configuration_view', inputSchema: obj(), annotations: RO },
  { set: 'helm', name: 'helm_list', inputSchema: obj(), annotations: RO },
  { set: 'helm', name: 'helm_install', inputSchema: obj({ chart: { type: 'string' } }), annotations: W },
  { set: 'helm', name: 'helm_uninstall', inputSchema: obj({ name: { type: 'string' } }), annotations: D },
];
const tools = all
  .filter((t) => toolsets.includes(t.set))
  .filter((t) => !readOnly || t.annotations.readOnlyHint === true)
  .filter((t) => !noDestructive || t.annotations.destructiveHint !== true)
  .map((t) => {
    const entry = { ...t };
    delete entry.set;
    return entry;
  });
if (process.env.SHOW_ENV) {
  const seen = {};
  for (const k of process.env.SHOW_ENV.split(',')) seen[k] = process.env[k] ?? null;
  tools.push({ name: 'env', description: JSON.stringify(seen), inputSchema: obj(), annotations: RO });
}

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
    out({
      jsonrpc: '2.0',
      id: msg.id,
      result: { protocolVersion: value('--protocol') ?? msg.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'flags-server', version: '0.0.1' } },
    });
  } else if (msg.method === 'tools/list') {
    out({ jsonrpc: '2.0', id: msg.id, result: { tools } });
  } else {
    out({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } });
  }
});
