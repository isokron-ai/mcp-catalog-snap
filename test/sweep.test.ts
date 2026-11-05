import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import { loadSweepInput, parseToolsListFile } from '../src/adapters/index.js';
import { bearerToken, parseArgs, targetFromArgs } from '../src/args.js';
import { redact, targetSecrets } from '../src/redact.js';
import { fingerprint } from '../src/canonical.js';
import { EXIT_BUDGET, cmdSweep } from '../src/cmd-sweep.js';
import { mdCode, mdText, renderSweepMarkdown } from '../src/report-md.js';
import { buildSnapshot, serializeSnapshot } from '../src/snapshot.js';
import { REPORT_FORMAT, runSweep, serializeReport } from '../src/sweep.js';
import { loadTokenizers } from '../src/tokenize.js';

const FIX = join(import.meta.dirname, 'fixtures', 'sweep');
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const KRONICLE_CLI = fileURLToPath(new URL('../node_modules/kronicle-lite/dist/cli.js', import.meta.url));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'mcs-sweep-'));

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    cwd: tmp(),
    timeout: 60_000,
    env: { PATH: process.env['PATH'] ?? '', HOME: tmp(), ...env },
  });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

function capture(): { io: { out: (s: string) => void; err: (s: string) => void }; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, out, err };
}

describe('runSweep', () => {
  it('builds a versioned report with fingerprints, totals and sorted findings', async () => {
    const toks = await loadTokenizers(['cl100k', 'chars4']);
    const input = await loadSweepInput({ from: join(FIX, 'tools-list.json') });
    const r = runSweep(input, { tokenizers: toks });
    expect(r.format).toBe(REPORT_FORMAT);
    expect(r.fingerprints.catalog).toBe(fingerprint(input.catalog));
    expect(r.measurement.tokenizers.map((t) => t.id)).toEqual(['cl100k', 'chars4']);
    expect(r.measurement.scope).toMatch(/^catalog exposure/);
    expect(r.tools.map((t) => t.name)).toEqual(['issue-delete', 'item-get', 'report-create', 'run-query']);
    expect(r.totals.exposure.bytes).toBe(r.tools.reduce((n, t) => n + t.exposure.bytes, 0));
    expect(r.totals.exposure.tokens['chars4']).toBeGreaterThan(0);
    const rc = r.tools.find((t) => t.name === 'report-create')!;
    expect(rc.choiceLists).toEqual({ count: 3, largest: 25, over: 1 });
    expect(rc.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: null, openWorldHint: null });
    expect(r.findingsSummary['enum-large']).toEqual({ count: 1, tools: 1, severity: { error: 0, warn: 1, info: 0 } });
    expect(r.budget).toMatchObject({ toolTokens: null, catalogTokens: null, exceeded: false });
    const keys = r.findings.map((f) => `${f.tool}\u0000${f.rule}\u0000${f.path}`);
    expect(keys).toEqual([...keys].sort());
    expect(() => runSweep(input, { tokenizers: toks, budgetTokenizer: 'o200k' })).toThrow(/not among/);
  });

  it('is byte-identical for the same catalog regardless of key order and tool order (except the ordered fingerprint)', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const text = readFileSync(join(FIX, 'tools-list.json'), 'utf8');
    const a = serializeReport(runSweep(parseToolsListFile(text, 'tools-list.json'), { tokenizers: toks }));
    const b = serializeReport(runSweep(parseToolsListFile(text, 'tools-list.json'), { tokenizers: toks }));
    expect(b).toBe(a);
    const shuffle = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(shuffle) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, shuffle(x)])) : v;
    const parsed = JSON.parse(text) as { tools: unknown[] };
    const reordered = JSON.stringify({ ...(shuffle(parsed) as object), tools: (shuffle(parsed.tools) as unknown[]).reverse() });
    const c = runSweep(parseToolsListFile(reordered, 'tools-list.json'), { tokenizers: toks });
    const ra = JSON.parse(a) as typeof c;
    expect(c.fingerprints.catalog).toBe(ra.fingerprints.catalog);
    expect(c.fingerprints.toolsOrdered).not.toBe(ra.fingerprints.toolsOrdered);
    expect(serializeReport({ ...c, fingerprints: ra.fingerprints })).toBe(a);
  });

  it('explicit budgets: per-tool and catalog, error severity, exceeded flag', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const input = await loadSweepInput({ from: join(FIX, 'tools-list.json') });
    const r = runSweep(input, { tokenizers: toks, budgets: { toolTokens: 100, catalogTokens: 500 } });
    expect(r.budget).toMatchObject({ toolTokens: 100, catalogTokens: 500, exceeded: true, toolsOver: ['report-create', 'run-query'], catalogOver: true });
    expect(r.findings.filter((f) => f.rule === 'oversize-tool').map((f) => [f.tool, f.severity])).toEqual([
      ['report-create', 'error'],
      ['run-query', 'error'],
    ]);
    expect(r.findings.find((f) => f.rule === 'oversize-catalog')).toMatchObject({ tool: null, severity: 'error' });
    const advisory = runSweep(input, { tokenizers: toks, advisoryToolTokens: 100 });
    expect(advisory.budget.exceeded).toBe(false);
    expect(advisory.findings.filter((f) => f.rule === 'oversize-tool').map((f) => f.severity)).toEqual(['warn', 'warn']);
  });

  it('exec input: info exposure, views, embedded-schema escaped-json finding', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const r = runSweep(await loadSweepInput({ adapter: 'posthog-exec', from: join(FIX, 'exec-dump.jsonl') }), { tokenizers: toks });
    expect(Object.keys(r.totals.views)).toEqual(['infoFull', 'infoJson', 'schema']);
    expect(r.totals.embeddedSchema!.tools).toBe(3);
    const esc = r.findings.filter((f) => f.rule === 'escaped-json' && f.data?.['view'] === 'exposure');
    expect(esc.length).toBeGreaterThan(0);
    expect(esc[0]!.data!['escapedTokens']).toBeGreaterThan(esc[0]!.data!['plainTokens'] as number);
    expect(r.totals.exposure.tokens['cl100k']).toBe(r.tools.reduce((n, t) => n + t.exposure.tokens['cl100k']!, 0));
  });
});

describe('markdown', () => {
  it('escapes hostile server text so it cannot break tables, links or HTML', async () => {
    expect(mdText('a|b\n<script>[x](http://e)`')).toBe('a\\|b \\<script\\>\\[x\\](http:\u2060//e)\\`');
    expect(mdCode('x`y|z\nw')).toBe('`x y\\|z w`');
    expect(mdText('y'.repeat(500)).length).toBeLessThanOrEqual(120);
    const toks = await loadTokenizers(['cl100k']);
    const evil = '|`</td><img src=x onerror=alert(1)>\n# owned';
    const input = parseToolsListFile(JSON.stringify({ tools: [{ name: evil, inputSchema: { type: 'object', properties: { [evil]: { type: 'unknown' } } } }] }), 'e.json');
    const md = renderSweepMarkdown(runSweep(input, { tokenizers: toks }));
    // inside code spans HTML is inert; everywhere else it must be escaped
    expect(md.replace(/`[^`\n]*`/g, '')).not.toContain('<img');
    expect(md).not.toMatch(/^# owned/m);
    const row = md.split('\n').find((l) => l.startsWith('| 1 |'))!;
    expect(row.replace(/\\\|/g, '').split('|').length - 1).toBe(8);
  });
});

describe('cmdSweep', () => {
  it('anthropic: skipped without a key (note, exit 0); counted with a key (fake fetch); key redacted', async () => {
    const c1 = capture();
    expect(await cmdSweep({ from: join(FIX, 'tools-list.json'), anthropic: true, json: true, env: {} }, c1.io)).toBe(0);
    expect(JSON.parse(c1.out[0]!).anthropic).toEqual({ skipped: 'ANTHROPIC_API_KEY is not set' });
    const fake = vi.fn(async (_u: string | URL | Request, init?: RequestInit) => {
      const n = (JSON.parse(String(init?.body)) as { tools?: unknown[] }).tools?.length ?? 0;
      return new Response(JSON.stringify({ input_tokens: 10 + 50 * n }), { status: 200 });
    });
    const c2 = capture();
    expect(await cmdSweep({ from: join(FIX, 'tools-list.json'), anthropic: true, json: true, env: { ANTHROPIC_API_KEY: 'sk-ant-test-123' }, fetch: fake as unknown as typeof fetch }, c2.io)).toBe(0);
    const r = JSON.parse(c2.out[0]!);
    expect(r.anthropic).toEqual({ model: 'claude-opus-5-5', baseline: 10, catalog: 200, errors: 0 });
    expect(r.tools.map((t: { anthropicTokens: number }) => t.anthropicTokens)).toEqual([50, 50, 50, 50]);
    expect(c2.out.join('') + c2.err.join('')).not.toContain('sk-ant-test-123');
  });

  it('call results: structured-content-duplicated from a JSONL file', async () => {
    const dir = tmp();
    const sc = { rows: [{ id: 1 }] };
    writeFileSync(join(dir, 'calls.jsonl'), `${JSON.stringify({ tool: 'run-query', result: { structuredContent: sc, content: [{ type: 'text', text: JSON.stringify(sc) }] } })}\n`);
    const c = capture();
    expect(await cmdSweep({ from: join(FIX, 'tools-list.json'), callResults: join(dir, 'calls.jsonl'), json: true }, c.io)).toBe(0);
    expect(JSON.parse(c.out[0]!).findingsSummary['structured-content-duplicated']).toMatchObject({ count: 1 });
    writeFileSync(join(dir, 'bad.jsonl'), '{"tool":1}\n');
    const c2 = capture();
    expect(await cmdSweep({ from: join(FIX, 'tools-list.json'), callResults: join(dir, 'bad.jsonl') }, c2.io)).toBe(2);
    expect(c2.err[0]).toMatch(/bad\.jsonl:1/);
  });
});

describe('bearer tokens', () => {
  it('reads from file or env, conflicts are errors, values are redactable and never in messages', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'tok'), 'phx_secret_token\nignored\n');
    const a = parseArgs(['sweep', '--url', 'https://h/mcp', '--bearer-file', join(dir, 'tok')]);
    expect(bearerToken(a)).toBe('phx_secret_token');
    const t = targetFromArgs(a)!;
    expect(t.kind === 'http' && t.headers).toEqual({ Authorization: 'Bearer phx_secret_token' });
    expect(targetSecrets(t)).toEqual(['Bearer phx_secret_token', 'phx_secret_token']);
    expect(redact('failed with Bearer phx_secret_token', targetSecrets(t))).toBe('failed with ***');
    expect(bearerToken(parseArgs(['x', '--bearer-env', 'TOK']), { TOK: ' abc ' })).toBe('abc');
    expect(() => bearerToken(parseArgs(['x', '--bearer-env', 'TOK']), {})).toThrow(/TOK: variable is unset/);
    expect(() => bearerToken(parseArgs(['x', '--bearer-file', join(dir, 'missing')]))).toThrow(/ENOENT/);
    expect(() => bearerToken(parseArgs(['x', '--bearer-file', 'f', '--bearer-env', 'E']))).toThrow(/not both/);
    expect(() => targetFromArgs(parseArgs(['x', '--url', 'https://h', '--header', 'authorization: x', '--bearer-env', 'TOK']))).toThrow();
  });
});

describe('sweep CLI (black box)', () => {
  it('two runs produce byte-identical JSON and markdown', () => {
    const d1 = tmp();
    const d2 = tmp();
    for (const d of [d1, d2]) {
      const r = cli(['sweep', '--from', join(FIX, 'tools-list.json'), '--tokenizers', 'cl100k,o200k', '--report', join(d, 'r.json'), '--md', join(d, 'r.md')]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('# MCP static sweep: fixture-server 2.3.4');
    }
    expect(readFileSync(join(d2, 'r.json'), 'utf8')).toBe(readFileSync(join(d1, 'r.json'), 'utf8'));
    expect(readFileSync(join(d2, 'r.md'), 'utf8')).toBe(readFileSync(join(d1, 'r.md'), 'utf8'));
    expect(readFileSync(join(d1, 'r.json'), 'utf8')).not.toMatch(/"(capturedAt|time|date)"/);
  });

  it('exit codes: 4 budget, 3 tampered snapshot, 2 bad input; --json prints the report', () => {
    const over = cli(['sweep', '--from', join(FIX, 'tools-list.json'), '--max-tool-tokens', '100', '--json']);
    expect(over.code).toBe(EXIT_BUDGET);
    expect(JSON.parse(over.stdout).budget.exceeded).toBe(true);
    expect(over.stderr).toMatch(/budget exceeded: 2 tool\(s\) over/);
    expect(cli(['sweep', '--from', join(FIX, 'tools-list.json'), '--max-catalog-tokens', '100000']).code).toBe(0);

    const dir = tmp();
    const snap = buildSnapshot(
      { server: { name: 's', version: '1' }, protocolVersion: null, tools: [{ name: 'a', inputSchema: { type: 'object' } }], prompts: [], resourceTemplates: [] },
      { capturedAt: 't' },
    );
    writeFileSync(join(dir, 'bad.json'), serializeSnapshot({ ...snap, catalog: { ...snap.catalog, tools: [] } }));
    expect(cli(['sweep', '--from', join(dir, 'bad.json')]).code).toBe(3);
    writeFileSync(join(dir, 'good.json'), serializeSnapshot(snap));
    expect(cli(['sweep', '--from', join(dir, 'good.json')]).code).toBe(0);

    expect(cli(['sweep', '--from', join(dir, 'nope.json')]).code).toBe(2);
    expect(cli(['sweep']).stderr).toMatch(/exactly one input/);
    expect(cli(['sweep', 'file.json']).stderr).toMatch(/--from FILE/);
    expect(cli(['sweep', '--from', join(FIX, 'tools-list.json'), '--max-tool-tokens', 'lots']).stderr).toMatch(/non-negative integer/);
    expect(cli(['sweep', '--from', join(FIX, 'tools-list.json'), '--tokenizers', 'nope']).stderr).toMatch(/unknown tokenizer/);
  });

  it('never prints a bearer token, even when the connection fails', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'tok'), 'tok_DO_NOT_PRINT_42\n');
    const r = cli(['sweep', '--url', 'http://127.0.0.1:9/mcp', '--bearer-file', join(dir, 'tok'), '--timeout', '3000']);
    expect(r.code).toBe(2);
    expect(r.stdout + r.stderr).not.toContain('tok_DO_NOT_PRINT_42');
    const e = cli(['sweep', '--url', 'http://127.0.0.1:9/mcp', '--bearer-env', 'MCS_TOK', '--timeout', '3000'], { MCS_TOK: 'env_DO_NOT_PRINT_7' });
    expect(e.stdout + e.stderr).not.toContain('env_DO_NOT_PRINT_7');
  });

  it('sweeps a live stdio server (kronicle-lite) and matches its snapshot fingerprint', () => {
    const work = tmp();
    const args = ['--', process.execPath, KRONICLE_CLI, 'serve', '--data-dir', join(work, 'data')];
    const r = cli(['sweep', '--json', ...args]);
    expect(r.code).toBe(0);
    const report = JSON.parse(r.stdout);
    expect(report.server.name).toBe('kronicle-lite');
    expect(report.source).toEqual({ kind: 'stdio', command: basename(process.execPath) });
    const h = cli(['hash', ...args]);
    expect(report.fingerprints.catalog).toBe(h.stdout.trim());
    expect(report.totals.tools).toBeGreaterThan(0);
  });
});
