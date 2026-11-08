import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { POSTHOG_EXEC, loadSweepInput, parseToolNames, parseToolsListFile } from '../src/adapters/index.js';
import { parseExecRecords, serializeExecRecords, sweepInputFromExecSession } from '../src/adapters/exec.js';
import { sourceOf } from '../src/adapters/tools-list.js';
import { openSessionOnTransport } from '../src/capture.js';
import { canonicalJson, fingerprint } from '../src/canonical.js';
import { analyzeTool } from '../src/findings.js';
import { measure } from '../src/metrics.js';
import { SnapshotIntegrityError, buildSnapshot, serializeSnapshot } from '../src/snapshot.js';
import { loadTokenizers } from '../src/tokenize.js';

const FIX = join(import.meta.dirname, 'fixtures', 'sweep');
const tmp = (): string => mkdtempSync(join(tmpdir(), 'mcs-adapters-'));

describe('tools-list adapter (offline)', () => {
  it('reads a tools/list result with serverInfo; keeps server order for ADR-0005', async () => {
    const input = await loadSweepInput({ from: join(FIX, 'tools-list.json') });
    expect(input.adapter).toBe('tools-list');
    expect(input.server).toEqual({ name: 'fixture-server', version: '2.3.4' });
    expect(input.source).toEqual({ kind: 'file', name: 'tools-list.json', format: 'tools/list result' });
    expect(input.catalog.tools.map((t) => t.name)).toEqual(['issue-delete', 'item-get', 'report-create', 'run-query']);
    expect((input.orderedTools as { name: string }[]).map((t) => t.name)).toEqual(['report-create', 'issue-delete', 'run-query', 'item-get']);
    expect(input.notes[0]).toMatch(/tools only/);
    expect(input.modelVisible.size).toBe(0);
  });

  it('accepts a bare array, a JSON-RPC response, and a snapshot; refuses a tampered snapshot', () => {
    const tools = [{ name: 'b', inputSchema: { type: 'object' } }, { name: 'a', inputSchema: { type: 'object' } }];
    expect(parseToolsListFile(JSON.stringify(tools), '/x/y/my-server.json').server).toEqual({ name: 'my-server', version: null });
    const rpc = parseToolsListFile(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { tools } }), 'r.json', 'named');
    expect(rpc.source.kind === 'file' && rpc.source.format).toBe('JSON-RPC response');
    expect(rpc.server.name).toBe('named');
    const snap = buildSnapshot({ server: { name: 's', version: '1' }, protocolVersion: '2025-11-25', tools, prompts: [], resourceTemplates: [] }, { capturedAt: 't' });
    const fromSnap = parseToolsListFile(serializeSnapshot(snap), 's.json');
    expect(fingerprint(fromSnap.catalog)).toBe(snap.sha256);
    expect(fromSnap.orderedTools).toBeNull();
    const tampered = serializeSnapshot({ ...snap, catalog: { ...snap.catalog, tools: [] } });
    expect(() => parseToolsListFile(tampered, 's.json')).toThrow(SnapshotIntegrityError);
    expect(() => parseToolsListFile('{"nope":1}', 'n.json')).toThrow(/expected a tools\/list result/);
    expect(() => parseToolsListFile('{', 'n.json')).toThrow(/not valid JSON/);
  });

  it('sourceOf never carries credentials: URL origin+path only, stdio basename only', () => {
    expect(sourceOf({ kind: 'http', url: 'https://user:pw@mcp.example.com/mcp?token=abc#x' })).toEqual({ kind: 'http', url: 'https://mcp.example.com/mcp [query redacted]' });
    expect(sourceOf({ kind: 'stdio', command: '/usr/local/bin/server', args: ['--api-key', 'secret'] })).toEqual({ kind: 'stdio', command: 'server' });
  });

  it('loadSweepInput validates its options', async () => {
    await expect(loadSweepInput({})).rejects.toThrow(/exactly one input/);
    await expect(loadSweepInput({ from: 'a', target: { kind: 'stdio', command: 'x', args: [] } })).rejects.toThrow(/exactly one input/);
    await expect(loadSweepInput({ from: 'a', adapter: 'nope' })).rejects.toThrow(/unknown adapter "nope"/);
    await expect(loadSweepInput({ from: join(FIX, 'tools-list.json'), saveRaw: 'x' })).rejects.toThrow(/--save-raw/);
  });
});

describe('exec adapter (offline dump)', () => {
  it('reads records: info as exposure, other views, embedded schema, schema-view unknown types', async () => {
    const input = await loadSweepInput({ adapter: 'posthog-exec', from: join(FIX, 'exec-dump.jsonl') });
    expect(input.adapter).toBe('posthog-exec');
    expect(input.server).toEqual({ name: 'exec-dump', version: null });
    expect(input.catalog.tools.map((t) => t.name)).toEqual(['issue-delete', 'report-create', 'run-query']);
    expect(input.modelVisible.get('run-query')).toMatch(/^name: run-query\n/);
    expect([...input.views.get('run-query')!.keys()]).toEqual(['infoFull', 'infoJson', 'schema']);
    const emb = input.embeddedSchemas.get('report-create')!;
    expect(emb.escaped.startsWith("'{")).toBe(true);
    expect(JSON.parse(emb.plain)).toEqual(input.catalog.tools.find((t) => t.name === 'report-create')!.inputSchema);
    expect(input.findings.map((f) => [f.tool, f.data?.['unknownTypes']])).toEqual([
      ['report-create', 1],
      ['run-query', 1],
    ]);
    // the contract is the full schema, so the findings engine sees everything the plain adapter would
    const plain = await loadSweepInput({ from: join(FIX, 'tools-list.json') });
    const rc = (i: typeof input): string => canonicalJson(i.catalog.tools.find((t) => t.name === 'report-create'));
    expect(rc(input)).toBe(rc(plain));
  });

  it('rejects malformed lines with a line number', () => {
    expect(() => parseExecRecords('{"name":"a","info_output":"x"}\n{bad', 'f.jsonl')).toThrow(/f\.jsonl:2/);
    expect(() => parseExecRecords('{"name":"a"}', 'f.jsonl')).toThrow(/info_output/);
  });

  it('parseToolNames handles JSON and line/comma lists', () => {
    expect(parseToolNames('["a-b","c"]')).toEqual(['a-b', 'c']);
    expect(parseToolNames('{"tools":[{"name":"x"},"y"]}')).toEqual(['x', 'y']);
    expect(parseToolNames('- alpha-list\n* beta.get — Beta\n1. gamma: thing\n`delta`\n\n')).toEqual(['alpha-list', 'beta.get', 'gamma', 'delta']);
    expect(parseToolNames('one, two,three')).toEqual(['one', 'two', 'three']);
  });
});

/** A tiny exec-style server: `tools`, `info [--json] <name>`, `schema <name>`. */
function execServer(): McpServer {
  const contracts: Record<string, { description: string; inputSchema: unknown }> = {
    'flag-list': { description: 'List flags.', inputSchema: { type: 'object', properties: { limit: { type: 'integer' } } } },
    'flag-delete': { description: 'Delete a flag.', inputSchema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] } },
  };
  const server = new McpServer({ name: 'exec-demo', version: '0.9.0' });
  server.registerTool(
    'exec',
    { description: 'Run a CLI-style command.', inputSchema: { command: z.string(), context: z.string(), llm_model: z.string() } },
    async ({ command }) => {
      const text = (t: string, isError = false): { content: { type: 'text'; text: string }[]; isError?: boolean } =>
        isError ? { content: [{ type: 'text', text: t }], isError: true } : { content: [{ type: 'text', text: t }] };
      if (command === 'tools') return text('Available tools\nflag-list\nflag-delete');
      const m = /^(info --json|info|schema) (\S+)$/.exec(command);
      const c = m ? contracts[m[2]!] : undefined;
      if (!m || !c) return text(`unknown tool: ${command}`, true);
      if (m[1] === 'info --json') return text(JSON.stringify({ name: m[2], ...c }));
      if (m[1] === 'schema') return text(JSON.stringify(c.inputSchema));
      return text(`name: ${m[2]}\ndescription: ${c.description}\ninputSchema: '${JSON.stringify(c.inputSchema)}'\n`);
    },
  );
  return server;
}

describe('exec adapter (live, in-memory)', () => {
  it('lists, fetches info / info --json / schema, drops rejected names, and round-trips through --save-raw', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await execServer().connect(serverT);
    const session = await openSessionOnTransport(clientT);
    try {
      const { input, records } = await sweepInputFromExecSession(session, { profile: POSTHOG_EXEC }, { kind: 'stdio', command: 'demo' });
      expect(input.server).toEqual({ name: 'exec-demo', version: '0.9.0' });
      expect(input.wrapperTools!.map((t) => t.name)).toEqual(['exec']);
      expect(input.catalog.tools.map((t) => t.name)).toEqual(['flag-delete', 'flag-list']);
      expect(input.notes.join('\n')).toMatch(/1 listed name\(s\) were rejected by `info` \(isError\): Available/);
      expect(input.embeddedSchemas.get('flag-list')!.plain).toBe('{"type":"object","properties":{"limit":{"type":"integer"}}}');
      // offline re-read of the saved records reproduces the contracts and exposures
      const dir = tmp();
      writeFileSync(join(dir, 'raw.jsonl'), serializeExecRecords(records));
      const again = await loadSweepInput({ adapter: 'posthog-exec', from: join(dir, 'raw.jsonl'), name: 'exec-demo' });
      expect(fingerprint(again.catalog)).toBe(fingerprint(input.catalog));
      expect(again.modelVisible).toEqual(input.modelVisible);
      expect(serializeExecRecords(records)).toBe(serializeExecRecords([...records].reverse().sort((a, b) => (a.name < b.name ? -1 : 1))));
    } finally {
      await session.close();
    }
  });

  it('never sends invalid names; tells rejected names from failed calls', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const s = new McpServer({ name: 'exec-kinds', version: '1' });
    const sent: string[] = [];
    s.registerTool('exec', { description: 'x', inputSchema: { command: z.string(), context: z.string(), llm_model: z.string() } }, async ({ command }) => {
      sent.push(command);
      if (command === 'tools') return { content: [{ type: 'text', text: JSON.stringify(['ok-tool', 'gone-tool', 'hang-tool', 'bad name', 'x;rm -rf ~', 'multi\nline']) }] };
      if (command.endsWith(' hang-tool')) return new Promise(() => undefined);
      if (command.endsWith(' gone-tool')) return { content: [{ type: 'text', text: 'no such tool' }], isError: true };
      return { content: [{ type: 'text', text: command.startsWith('info --json') ? '{"name":"ok-tool","inputSchema":{"type":"object"}}' : 'name: ok-tool\n' }] };
    });
    await s.connect(serverT);
    const session = await openSessionOnTransport(clientT, { timeoutMs: 300 });
    try {
      const { input } = await sweepInputFromExecSession(session, { profile: POSTHOG_EXEC }, { kind: 'stdio', command: 'x' });
      expect(input.catalog.tools.map((t) => t.name)).toEqual(['ok-tool']);
      const notes = input.notes.join('\n');
      expect(notes).toMatch(/3 listed name\(s\) have characters outside \[A-Za-z0-9._:-\] and were not sent/);
      expect(notes).toMatch(/1 listed name\(s\) were rejected by `info` \(isError\): gone-tool/);
      expect(notes).toMatch(/1 tool\(s\) failed with a transport or timeout error: hang-tool \(.*\)/);
      expect(sent.some((c) => /bad name|rm -rf|multi/.test(c))).toBe(false);
    } finally {
      await session.close();
    }
  });

  it('fails clearly when the wrapper tool is missing', async () => {
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    const s = new McpServer({ name: 'plain', version: '1' });
    s.registerTool('other', { description: 'x' }, async () => ({ content: [] }));
    await s.connect(serverT);
    const session = await openSessionOnTransport(clientT);
    try {
      await expect(sweepInputFromExecSession(session, { profile: POSTHOG_EXEC }, { kind: 'stdio', command: 'x' })).rejects.toThrow(/no "exec" tool \(tools\/list: other\)/);
    } finally {
      await session.close();
    }
  });
});

/**
 * Reproduces the first PostHog audit (scratchpad posthog/sweep: analyze.py
 * over raw.jsonl, SWEEP_SUMMARY.md). The 24 MB dump is not in the repo:
 * point MCS_POSTHOG_RAW at it to run this.
 */
const RAW = process.env['MCS_POSTHOG_RAW'];
describe.runIf(RAW !== undefined && existsSync(RAW))('PostHog audit reproduction (MCS_POSTHOG_RAW)', () => {
  it('matches the audit totals within tolerance', async () => {
    const [cl] = await loadTokenizers(['cl100k']);
    const input = await loadSweepInput({ adapter: 'posthog-exec', from: RAW! });
    const tok = (s: string): number => measure(s, [cl!]).tokens['cl100k']!;
    const sum = (f: (name: string) => number): number => input.catalog.tools.reduce((n, t) => n + f(t.name), 0);
    const got = {
      tools: input.catalog.tools.length,
      info: sum((n) => tok(input.modelVisible.get(n)!)),
      infoFull: sum((n) => tok(input.views.get(n)!.get('infoFull')!)),
      schema: sum((n) => tok(input.views.get(n)!.get('schema')!)),
      description: input.catalog.tools.reduce((n, t) => n + tok(t.description ?? ''), 0),
      escaped: sum((n) => tok(input.embeddedSchemas.get(n)!.escaped)),
      plain: sum((n) => tok(input.embeddedSchemas.get(n)!.plain)),
      summaryUnknown: input.findings.reduce((n, f) => n + Number(f.data?.['unknownTypes'] ?? 0), 0),
    };
    let waste = 0;
    let bytes = 0;
    for (const t of input.catalog.tools) {
      const a = analyzeTool(t);
      waste += a.duplicates.wasteBytes;
      bytes += a.duplicates.defs.bytesBefore;
    }
    const audit = { tools: 1193, info: 933_010, infoFull: 1_290_802, schema: 249_001, description: 210_494, escaped: 660_351, plain: 606_160, summaryUnknown: 77 };
    for (const [k, v] of Object.entries(audit)) expect(Math.abs(got[k as keyof typeof got] - v) / v, k).toBeLessThanOrEqual(0.005);
    expect(Math.abs(waste / bytes - 1_353_392 / 3_741_142)).toBeLessThan(0.002);
  }, 300_000);
});
