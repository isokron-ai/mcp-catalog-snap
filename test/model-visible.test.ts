/**
 * Issue #7: wire bytes vs model-visible tokens.
 *
 * github-mcp-server v2.1.0 ships light + dark base64 PNG `icons` on every
 * tool. Clients do not pass icons to the model, so counting them as what the
 * model sees overstated its context cost ~5x. These tests pin the split:
 * `wire` = canonical JSON of the whole tools/list entry, `modelVisible` =
 * canonical JSON of {name, title, description, inputSchema} (+ annotations
 * only when asked), and budgets apply to model-visible tokens.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { loadSweepInput, parseToolsListFile } from '../src/adapters/index.js';
import { canonicalJson } from '../src/canonical.js';
import { renderSweepMarkdown } from '../src/report-md.js';
import { runSweep, serializeReport } from '../src/sweep.js';
import { loadTokenizers } from '../src/tokenize.js';
import { VERSION } from '../src/version.js';

const FIX = join(import.meta.dirname, 'fixtures', 'sweep');
const GH = join(FIX, 'github-mcp-server-2.1.0.tools-list.json');
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const tmp = (): string => mkdtempSync(join(tmpdir(), 'mcs-mv-'));

type Tool = Record<string, unknown> & { name: string };
const ghTools = (): Tool[] => (JSON.parse(readFileSync(GH, 'utf8')) as { tools: Tool[] }).tools;
const bytes = (s: string): number => Buffer.byteLength(s, 'utf8');

function cli(args: string[]) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: tmp(), timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', HOME: tmp() } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('wire vs model-visible (github-mcp-server v2.1.0 fixture)', () => {
  it('measures wire as the whole entry and model-visible as name/title/description/inputSchema only', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const r = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks });
    const byName = new Map(ghTools().map((t) => [t.name, t]));
    for (const t of r.tools) {
      const raw = byName.get(t.name)!;
      expect(t.wire.bytes).toBe(bytes(canonicalJson(raw)));
      const visible: Record<string, unknown> = { name: raw.name, description: raw['description'], inputSchema: raw['inputSchema'] };
      expect(t.modelVisible.bytes).toBe(bytes(canonicalJson(visible)));
      expect(t.modelVisible.bytes).toBeLessThan(t.wire.bytes);
    }
    expect(r.totals.wire.bytes).toBe(r.tools.reduce((n, t) => n + t.wire.bytes, 0));
    expect(r.totals.modelVisible.tokens['cl100k']).toBe(r.tools.reduce((n, t) => n + t.modelVisible.tokens['cl100k']!, 0));
    // the icons are most of the wire tokens: model-visible is well under a third of it
    expect(r.totals.modelVisible.tokens['cl100k']! * 3).toBeLessThan(r.totals.wire.tokens['cl100k']!);
    expect(r.measurement.modelVisibleFields).toEqual(['name', 'title', 'description', 'inputSchema']);
    expect(r.measurement.budgetsApplyTo).toBe('modelVisible');
    expect(r.measurement.wire).toMatch(/whole tools\/list entry/);
    expect(r.totals.modelVisiblePerTool.sum).toBe(r.totals.modelVisible.tokens['cl100k']);
    expect(r).not.toHaveProperty('totals.exposure');
  });

  it('icons and _meta change wire but never model-visible', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const stripped = ghTools().map(({ icons: _i, _meta: _m, ...rest }) => rest);
    const a = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks });
    const b = runSweep(parseToolsListFile(JSON.stringify({ tools: stripped }), 'x.json'), { tokenizers: toks });
    expect(b.totals.modelVisible).toEqual(a.totals.modelVisible);
    expect(b.totals.wire.bytes).toBeLessThan(a.totals.wire.bytes);
  });

  it('per-field breakdown includes icons, _meta, outputSchema and any other field', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const r = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks });
    expect(Object.keys(r.totals.fields)).toEqual(['name', 'description', 'inputSchema', 'annotations', 'icons', '_meta']);
    const iconBytes = ghTools().reduce((n, t) => n + bytes(canonicalJson(t['icons'])), 0);
    expect(r.totals.fields.icons!.bytes).toBe(iconBytes);
    // the gap the issue reported: icons are the largest field on the wire
    for (const [f, m] of Object.entries(r.totals.fields)) if (f !== 'icons') expect(r.totals.fields.icons!.bytes).toBeGreaterThan(m.bytes);
    const extra = parseToolsListFile(
      JSON.stringify({ tools: [{ name: 'x', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, execution: { taskSupport: 'optional' }, __proto__x: 1 }] }),
      'x.json',
    );
    const e = runSweep(extra, { tokenizers: toks });
    expect(Object.keys(e.tools[0]!.fields)).toEqual(['name', 'inputSchema', 'outputSchema', 'other']);
    expect(e.tools[0]!.fields.other!.bytes).toBe(bytes(canonicalJson({ __proto__x: 1, execution: { taskSupport: 'optional' } })));
  });

  it('annotations are excluded by default and counted only with modelVisibleAnnotations', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const input = await loadSweepInput({ from: GH });
    const off = runSweep(input, { tokenizers: toks });
    const on = runSweep(input, { tokenizers: toks, modelVisibleAnnotations: true });
    expect(on.measurement.modelVisibleFields).toEqual(['name', 'title', 'description', 'inputSchema', 'annotations']);
    const raw = ghTools()[0]!;
    const t = on.tools.find((x) => x.name === raw.name)!;
    expect(t.modelVisible.bytes).toBe(bytes(canonicalJson({ name: raw.name, description: raw['description'], inputSchema: raw['inputSchema'], annotations: raw['annotations'] })));
    expect(on.totals.modelVisible.bytes).toBeGreaterThan(off.totals.modelVisible.bytes);
    expect(on.totals.wire).toEqual(off.totals.wire);
  });

  it('budgets apply to model-visible tokens, not wire', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const r0 = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks });
    const maxVisible = Math.max(...r0.tools.map((t) => t.modelVisible.tokens['cl100k']!));
    const maxWire = Math.max(...r0.tools.map((t) => t.wire.tokens['cl100k']!));
    expect(maxVisible).toBeLessThan(maxWire);
    const visibleTotal = r0.totals.modelVisible.tokens['cl100k']!;
    const r = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks, budgets: { toolTokens: maxVisible, catalogTokens: visibleTotal } });
    expect(r.budget.exceeded).toBe(false);
    expect(r.findings.filter((f) => f.rule === 'oversize-tool' || f.rule === 'oversize-catalog')).toEqual([]);
    const tight = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks, budgets: { toolTokens: maxVisible - 1, catalogTokens: visibleTotal - 1 } });
    expect(tight.budget.exceeded).toBe(true);
    expect(tight.budget.catalogOver).toBe(true);
    expect(tight.findings.find((f) => f.rule === 'oversize-tool')!.message).toMatch(/^model-visible size is/);
  });

  it('exec adapters: wire and model-visible are both the info text', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const input = await loadSweepInput({ adapter: 'posthog-exec', from: join(FIX, 'exec-dump.jsonl') });
    const r = runSweep(input, { tokenizers: toks });
    for (const t of r.tools) expect(t.modelVisible).toEqual(t.wire);
    expect(r.measurement.modelVisibleFields).toBeNull();
    expect(r.measurement.modelVisible).toMatch(/info/);
    const md = renderSweepMarkdown(r);
    expect(md).toMatch(/\*\*Model-visible\*\* and \*\*wire\*\* are both the adapter's per-tool text/);
    expect(md).not.toMatch(/whole tools\/list entry \(icons/);
  });
});

describe('icon data-URI findings', () => {
  it('flags duplicated data-URI icons once for the catalog, with counts and wasted bytes', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const r = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks });
    const dup = r.findings.filter((f) => f.rule === 'icon-data-uri-duplicated');
    expect(dup).toHaveLength(1);
    const srcs = ghTools().flatMap((t) => (t['icons'] as { src: string }[]).map((i) => i.src));
    const unique = new Set(srcs);
    const waste = srcs.reduce((n, s) => n + bytes(s), 0) - [...unique].reduce((n, s) => n + bytes(s), 0);
    expect(dup[0]).toMatchObject({ tool: null, severity: 'warn', data: { icons: srcs.length, unique: unique.size, wasteBytes: waste } });
    expect(srcs.length).toBe(24);
    expect(unique.size).toBe(10);
    // github's 24px PNGs are small: no size finding at the default cap
    expect(r.findings.filter((f) => f.rule === 'icon-data-uri-large')).toEqual([]);
  });

  it('flags a data-URI icon over --max-icon-bytes, per tool and icon', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const r = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks, findings: { maxIconBytes: 100 } });
    const large = r.findings.filter((f) => f.rule === 'icon-data-uri-large');
    expect(large).toHaveLength(24);
    expect(large[0]).toMatchObject({ severity: 'warn', path: '/icons/0/src' });
  });

  it('survives hostile icons: non-array, non-object, non-string src, http URLs, a 2 MiB data URI', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const big = `data:image/png;base64,${'A'.repeat(2 << 20)}`;
    const tools = [
      { name: 'a', inputSchema: { type: 'object' }, icons: 'data:x' },
      { name: 'b', inputSchema: { type: 'object' }, icons: [null, 1, { src: 42 }, { src: 'https://x/i.png' }, { src: big }] },
      { name: 'c', inputSchema: { type: 'object' }, icons: [{ src: 'https://x/i.png' }, { src: 'https://x/i.png' }] },
      { name: '__proto__', inputSchema: { type: 'object' }, icons: [{ src: 'DATA:image/png;base64,AAAA' }, { src: 'DATA:image/png;base64,AAAA' }] },
    ];
    const r = runSweep(parseToolsListFile(JSON.stringify({ tools }), 'h.json'), { tokenizers: toks });
    expect(r.findings.filter((f) => f.rule === 'icon-data-uri-large').map((f) => [f.tool, f.path])).toEqual([['b', '/icons/4/src']]);
    expect(r.findings.find((f) => f.rule === 'icon-data-uri-duplicated')).toMatchObject({ data: { icons: 3, unique: 2, wasteBytes: bytes('DATA:image/png;base64,AAAA') } });
  });
});

describe('report surfaces', () => {
  it('markdown shows model-visible, wire and the icons field, and says what budgets apply to', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const md = renderSweepMarkdown(runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks }));
    expect(md).toMatch(/\| \*\*model-visible \(all tools\)\*\* \|/);
    expect(md).toMatch(/\| wire \(whole tools\/list entries\) \|/);
    expect(md).toMatch(/\| field `icons` \|/);
    expect(md).toMatch(/Budgets apply to model-visible tokens/);
    expect(md).not.toMatch(/\*\*exposure/);
  });

  it('generator names the running version', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const r = runSweep(await loadSweepInput({ from: GH }), { tokenizers: toks });
    expect(r.generator).toBe(`mcp-catalog-snap/${VERSION}`);
    expect(serializeReport(r)).toContain(`"generator": "mcp-catalog-snap/${VERSION}"`);
  });

  it('CLI: --count-annotations and --max-icon-bytes', () => {
    const base = cli(['sweep', '--from', GH, '--json']);
    expect(base.code).toBe(0);
    const on = cli(['sweep', '--from', GH, '--json', '--count-annotations', '--max-icon-bytes', '100']);
    expect(on.code).toBe(0);
    const a = JSON.parse(base.stdout);
    const b = JSON.parse(on.stdout);
    expect(b.measurement.modelVisibleFields).toContain('annotations');
    expect(b.totals.modelVisible.bytes).toBeGreaterThan(a.totals.modelVisible.bytes);
    expect(b.findingsSummary['icon-data-uri-large'].count).toBe(24);
    expect(cli(['sweep', '--from', GH, '--max-icon-bytes', 'x']).stderr).toMatch(/non-negative integer/);
    const dir = tmp();
    writeFileSync(join(dir, 'r1.json'), cli(['sweep', '--from', GH, '--json']).stdout);
    expect(readFileSync(join(dir, 'r1.json'), 'utf8')).toBe(base.stdout);
  });
});
