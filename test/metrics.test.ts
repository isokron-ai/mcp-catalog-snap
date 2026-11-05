import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import { anthropicToolCounts } from '../src/anthropic.js';
import { canonicalJson, fingerprint } from '../src/canonical.js';
import {
  addMeasures,
  distribution,
  histogram,
  measure,
  measureTool,
  orderedToolsFingerprint,
  percentile,
} from '../src/metrics.js';
import { buildSnapshot, type CatalogTool } from '../src/snapshot.js';
import { loadTokenizer, loadTokenizers, registerTokenizer, utf8Bytes } from '../src/tokenize.js';

describe('tokenizers', () => {
  it('cl100k matches python tiktoken cl100k_base counts', async () => {
    const t = await loadTokenizer('cl100k');
    // Reference values from `tiktoken.get_encoding("cl100k_base").encode(s, disallowed_special=())`.
    expect(t.count('hello world')).toBe(2);
    expect(t.count('{"type":"object","properties":{"q":{"type":"string"}}}')).toBe(14);
    expect(t.count('Ünïcödé — dash <|endoftext|>')).toBe(15);
    expect(t.count('')).toBe(0);
    expect(t.label).toMatch(/not a Claude tokenizer/);
  });

  it('o200k and chars4 load; ids are de-duplicated in order', async () => {
    const ts = await loadTokenizers(['o200k', 'chars4', 'o200k']);
    expect(ts.map((t) => t.id)).toEqual(['o200k', 'chars4']);
    expect(ts[0]!.count('hello world, this is o200k')).toBe(8);
    expect(ts[1]!.count('12345')).toBe(2);
  });

  it('rejects unknown ids and duplicate registrations; custom tokenizers plug in', async () => {
    await expect(loadTokenizer('nope')).rejects.toThrow(/unknown tokenizer "nope"/);
    registerTokenizer('words-test', async () => ({ id: 'words-test', label: 'words', count: (s) => s.split(/\s+/).filter(Boolean).length }));
    expect(() => registerTokenizer('words-test', async () => ({ id: 'x', label: 'x', count: () => 0 }))).toThrow(/already/);
    expect(() => registerTokenizer('cl100k', async () => ({ id: 'x', label: 'x', count: () => 0 }))).toThrow(/already/);
    expect(() => registerTokenizer('Bad Id', async () => ({ id: 'x', label: 'x', count: () => 0 }))).toThrow(/lowercase/);
    const w = await loadTokenizer('words-test');
    expect(w.count('a b  c')).toBe(3);
    await expect(loadTokenizers([])).rejects.toThrow(/at least one/);
  });

  it('utf8Bytes counts bytes, not UTF-16 units', () => {
    expect(utf8Bytes('—')).toBe(3);
    expect(utf8Bytes('a')).toBe(1);
  });
});

const tool: CatalogTool = {
  name: 'delete-thing',
  description: 'Delete a thing.',
  inputSchema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  annotations: { destructiveHint: true },
};

describe('measureTool', () => {
  it('measures each present field and the JCS total; fingerprints match canonical sha256', async () => {
    const ts = await loadTokenizers(['cl100k', 'chars4']);
    const m = measureTool(tool, ts);
    expect(Object.keys(m.fields)).toEqual(['name', 'description', 'inputSchema', 'annotations']);
    expect(m.fields.description).toEqual({ bytes: 15, tokens: { cl100k: 4, chars4: 4 } });
    expect(m.fields.inputSchema!.bytes).toBe(canonicalJson(tool.inputSchema).length);
    expect(m.total.bytes).toBe(canonicalJson(tool).length);
    expect(m.fingerprint).toBe(createHash('sha256').update(canonicalJson(tool)).digest('hex'));
    expect(m.inputSchemaFingerprint).toBe(fingerprint(tool.inputSchema));
    // wording-only change: entry fingerprint moves, schema fingerprint does not
    const m2 = measureTool({ ...tool, description: 'Remove a thing.' }, ts);
    expect(m2.fingerprint).not.toBe(m.fingerprint);
    expect(m2.inputSchemaFingerprint).toBe(m.inputSchemaFingerprint);
  });

  it('keeps the v0.1 catalog fingerprint unchanged (snapshot sha256 over sorted catalog)', () => {
    const snap = buildSnapshot(
      { server: { name: 's', version: '1' }, protocolVersion: null, tools: [tool], prompts: [], resourceTemplates: [] },
      { capturedAt: 'x' },
    );
    expect(snap.sha256).toBe(fingerprint({ tools: [tool], prompts: [], resourceTemplates: [] }));
  });

  it('orderedToolsFingerprint equals the IsoKron ADR-0005 hashMcpToolDefinitions scheme', () => {
    // Inline copy of isokron packages/compiler/src/security/layer_4_critic/mcp-tool-hash.ts
    const canon = (v: unknown): unknown => {
      if (v === null) return null;
      if (Array.isArray(v)) return v.map(canon);
      if (typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, x] of Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out[k] = canon(x);
        return out;
      }
      return v;
    };
    const adr0005 = (defs: unknown[]): string => createHash('sha256').update(JSON.stringify(canon(defs)), 'utf8').digest('hex');
    const b: CatalogTool = { name: 'a-first', inputSchema: { type: 'object', properties: { n: { type: 'number', maximum: 1e21 } } }, description: 'é   "q"' };
    const wire = [tool, b];
    expect(orderedToolsFingerprint(wire)).toBe(adr0005(wire));
    // order-preserving: swapping changes it, unlike the sorted catalog fingerprint
    expect(orderedToolsFingerprint([b, tool])).not.toBe(orderedToolsFingerprint(wire));
  });
});

describe('aggregation helpers', () => {
  it('addMeasures, percentile, distribution, histogram', () => {
    expect(addMeasures({ bytes: 1, tokens: { a: 1 } }, { bytes: 2, tokens: { a: 2, b: 5 } })).toEqual({ bytes: 3, tokens: { a: 3, b: 5 } });
    expect(percentile([], 50)).toBe(0);
    expect(percentile([5, 1, 3], 50)).toBe(3);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(distribution([1, 2, 10])).toEqual({ sum: 13, median: 2, p90: 10, max: 10 });
    expect(histogram([0, 5, 6, 20, 21, 999], [5, 20])).toEqual({ '0-5': 2, '6-20': 2, '21+': 2 });
  });

  it('measure counts with every tokenizer', async () => {
    const ts = await loadTokenizers(['cl100k']);
    expect(measure('hello world', ts)).toEqual({ bytes: 11, tokens: { cl100k: 2 } });
  });
});

describe('anthropicToolCounts (fake fetch, no network)', () => {
  it('reports per-tool marginal and whole-catalog counts, isolates failures, never leaks the key', async () => {
    const seen: unknown[] = [];
    const fake = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { tools?: { name: string }[] };
      seen.push(init?.headers);
      const tools = body.tools ?? [];
      if (tools.some((t) => t.name === 'bad.name')) {
        return new Response('{"error":{"message":"tools.0.name: String should match pattern; key sk-secret"}}', { status: 400 });
      }
      return new Response(JSON.stringify({ input_tokens: 8 + 100 * tools.length + (tools.length > 0 ? 300 : 0) }), { status: 200 });
    });
    const other: CatalogTool = { name: 'bad.name', inputSchema: { type: 'object' } };
    const r = await anthropicToolCounts([tool, other], { apiKey: 'sk-secret', fetch: fake as unknown as typeof fetch, concurrency: 2 });
    expect(r.model).toBe('claude-opus-5-5');
    expect(r.baseline).toBe(8);
    expect(r.perTool).toEqual({ 'bad.name': null, 'delete-thing': 400 });
    expect(r.catalog).toBeNull();
    expect(r.errors.map((e) => e.tool)).toEqual(['', 'bad.name'].map((x) => x || null));
    expect(JSON.stringify(r)).not.toContain('sk-secret');
    expect((seen[0] as Record<string, string>)['anthropic-version']).toBe('2023-06-01');
  });
});
