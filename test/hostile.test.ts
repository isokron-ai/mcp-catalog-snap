/**
 * Hostile-input regression tests from the v0.2 review: every case here hung,
 * crashed or leaked before the fix. Each asserts a time bound and a
 * well-formed outcome (finding or clean error), never a hang or a stack
 * overflow.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import canonicalizeModule from 'canonicalize';
import { describe, expect, it } from 'vitest';

import { canonicalJson, fingerprint, prettyCanonical, sortKeysDeep } from '../src/canonical.js';
import { loadSweepInput, parseToolsListFile } from '../src/adapters/index.js';
import { parseExecRecords, sweepInputFromExecRecords } from '../src/adapters/exec.js';
import { anthropicToolCounts } from '../src/anthropic.js';
import { diffCatalogs } from '../src/diff.js';
import { analyzeTool } from '../src/findings.js';
import { normalizeCatalog, type CatalogTool } from '../src/snapshot.js';
import { runSweep, serializeReport } from '../src/sweep.js';
import { TOKENIZE_CHUNK, chunkText, loadTokenizer, loadTokenizers } from '../src/tokenize.js';

type CanonFn = (v: unknown) => string | undefined;
const canonicalize: CanonFn =
  typeof canonicalizeModule === 'function' ? (canonicalizeModule as unknown as CanonFn) : (canonicalizeModule as unknown as { default: CanonFn }).default;

function nested(depth: number, leaf: unknown = { type: 'string' }): unknown {
  let v: unknown = leaf;
  for (let i = 0; i < depth; i++) v = { type: 'object', properties: { x: v } };
  return v;
}

const within = <T>(ms: number, f: () => T): T => {
  const t0 = Date.now();
  const r = f();
  expect(Date.now() - t0).toBeLessThan(ms);
  return r;
};

describe('canonical JSON is iterative and identical to the canonicalize package', () => {
  it('matches canonicalize byte for byte on varied values', () => {
    const samples: unknown[] = [
      null,
      true,
      0,
      -0,
      1e21,
      1.5e-7,
      'é "\\\n\ud800',
      [],
      {},
      [1, [2, [3, {}]], undefined],
      { b: 1, a: { d: [null, 'x'], c: undefined }, '': 0, é: 1, Z: 2, '\u{1F600}': 3, 'דּ': 4 },
      JSON.parse('{"__proto__": {"x": 1}, "constructor": 2}'),
    ];
    for (const s of samples) expect(canonicalJson(s)).toBe(canonicalize(s));
    expect(() => canonicalJson(Number.NaN)).toThrow();
    expect(() => canonicalJson(undefined)).toThrow(/not JSON-serializable/);
  });

  it('handles 100,000 levels of nesting without overflowing the stack', () => {
    const deep = nested(100_000);
    const s = within(5_000, () => canonicalJson(deep));
    expect(s.startsWith('{"properties":{"x":{"properties":')).toBe(true);
    expect(fingerprint(deep)).toMatch(/^[0-9a-f]{64}$/);
    const sorted = within(5_000, () => sortKeysDeep(deep));
    expect(canonicalJson(sorted)).toBe(s);
    // pretty output is O(depth²) in indentation by nature; 3,000 levels already overflowed JSON.stringify-based code
    const pretty = within(5_000, () => prettyCanonical(nested(3_000)));
    expect(JSON.parse(pretty)).toBeTruthy();
  });

  it('pretty output equals JSON.stringify(sorted, null, 2) for normal values', () => {
    const v = { b: [1, { z: [], y: {} }], a: 'x', c: { k: null } };
    expect(prettyCanonical(v)).toBe(`${JSON.stringify(sortKeysDeep(v), null, 2)}\n`);
  });

  it('keeps "__proto__" and "constructor" as own keys (no prototype pollution, no lost keys)', () => {
    const v = JSON.parse('{"properties": {"__proto__": {"type": "string"}, "constructor": {"type": "number"}}}');
    const s = sortKeysDeep(v) as { properties: Record<string, unknown> };
    expect(Object.keys(s.properties)).toEqual(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(s.properties)).toBe(Object.prototype);
    expect(canonicalJson(s)).toBe('{"properties":{"__proto__":{"type":"string"},"constructor":{"type":"number"}}}');
    expect(({} as Record<string, unknown>)['type']).toBeUndefined();
  });
});

describe('tokenizer: exact parity with Python tiktoken, linear on hostile text', () => {
  // Oracle: len(tiktoken.get_encoding(E).encode(s, disallowed_special=())) on the committed fixtures.
  const ORACLE = {
    cl100k: { toolsList: 1359, execDump: 4774, info: 794, samples: [0, 2, 15, 18, 4, 6626] },
    o200k: { toolsList: 1351, execDump: 4722, info: 786, samples: [0, 2, 14, 15, 4, 6626] },
  };
  const samples = ['', 'hello world', 'Ünïcödé — dash <|endoftext|>', `été don't WE'LL 12345678 ${'😀'.repeat(3)}`, ' \n\n  \t x  \r\n', `${'a'.repeat(5000)}!${'b1'.repeat(3000)}`];

  it.each(['cl100k', 'o200k'] as const)('%s matches the oracle on fixtures and edge samples', async (id) => {
    const [t] = await loadTokenizers([id]);
    const fix = join(import.meta.dirname, 'fixtures', 'sweep');
    const tl = readFileSync(join(fix, 'tools-list.json'), 'utf8');
    const ex = readFileSync(join(fix, 'exec-dump.jsonl'), 'utf8');
    const info = ex.split('\n').filter(Boolean).reduce((n, l) => n + t!.count((JSON.parse(l) as { info_output: string }).info_output), 0);
    expect({ toolsList: t!.count(tl), execDump: t!.count(ex), info, samples: samples.map((s) => t!.count(s)) }).toEqual(ORACLE[id]);
  });

  it.each(['cl100k', 'o200k'] as const)('%s: a 64K-char single word counts in under 2 s', async (id) => {
    const [t] = await loadTokenizers([id]);
    for (const word of ['a'.repeat(65_536), 'xyzzy'.repeat(13_108), '!'.repeat(65_536)]) {
      const n = within(2_000, () => t!.count(word));
      expect(n).toBeGreaterThan(0);
    }
  });

  it('long texts chunked at piece boundaries count exactly like one pass', async () => {
    const [t] = await loadTokenizers(['cl100k']);
    const json = JSON.stringify(Array.from({ length: 3000 }, (_, i) => ({ type: 'object', properties: { [`k${i}`]: { description: `Value ${i} — é ü 😀`, enum: [`a_${i}`, `b${i * 7}`] } } })));
    const chunks = chunkText(json);
    expect(chunks.length).toBeGreaterThan(10);
    expect(chunks.every((c) => c.length <= TOKENIZE_CHUNK)).toBe(true);
    expect(chunks.join('')).toBe(json);
    expect(chunks.reduce((n, c) => n + t!.count(c), 0)).toBe(t!.count(json));
  });
});

describe('findings engine under hostile schemas', () => {
  const tool = (inputSchema: unknown, name = 't'): CatalogTool => ({ name, inputSchema: inputSchema as CatalogTool['inputSchema'] });
  const rules = (a: { findings: { rule: string }[] }): string[] => a.findings.map((f) => f.rule);

  it('never runs untrusted regexes: catastrophic patterns with hostile defaults finish at once', () => {
    for (const pattern of ['^((a+))+$', '^(a|a)*$', '^(a+)+$', '(x+x+)+y', '^(([a-z])+.)+[A-Z]([a-z])+$']) {
      const a = within(1_000, () => analyzeTool(tool({ type: 'object', properties: { p: { type: 'string', pattern, default: `${'a'.repeat(5_000)}!` } } })));
      const f = a.findings.find((x) => x.rule === 'default-unchecked');
      expect(f?.message).toMatch(/pattern/);
      expect(rules(a)).not.toContain('default-invalid');
    }
  });

  it('bounds $ref fan-out: allOf of 8 self-references does not hang', () => {
    const s = {
      type: 'object',
      $defs: { A: { allOf: Array.from({ length: 8 }, () => ({ $ref: '#/$defs/A' })) } },
      properties: { p: { $ref: '#/$defs/A', default: { x: 1 } }, q: { allOf: [{ $ref: '#/$defs/A' }, { $ref: '#/$defs/A' }], default: 1 } },
    };
    const a = within(1_000, () => analyzeTool(tool(s)));
    expect(a.findings.some((f) => f.rule === 'default-invalid')).toBe(false);
    // acyclic fan-out: L0 → 8 × L1 → … → L40 is 8^40 expansions without a budget
    const defs: Record<string, unknown> = { L40: { type: 'integer', minimum: 5 } };
    for (let i = 0; i < 40; i++) defs[`L${i}`] = { allOf: Array.from({ length: 8 }, () => ({ $ref: `#/$defs/L${i + 1}` })) };
    const b = within(1_000, () => analyzeTool(tool({ type: 'object', $defs: defs, properties: { p: { $ref: '#/$defs/L0', default: 7 } } })));
    expect(b.findings.find((f) => f.rule === 'default-unchecked')?.message).toMatch(/budget/);
  });

  it('malformed $ref percent-encoding is a finding, not a crash', () => {
    const a = analyzeTool(tool({ type: 'object', properties: { p: { $ref: '#/%E0%A4%A', default: 1 } } }));
    expect(a.findings.find((f) => f.rule === 'schema-invalid')?.message).toMatch(/malformed or does not resolve/);
  });

  it.each([500, 2_000, 100_000])('%i levels of nesting: bounded time, schema-too-deep finding, no overflow', (depth) => {
    const a = within(3_000, () => analyzeTool(tool(nested(depth))));
    expect(rules(a)).toContain('schema-too-deep');
  });

  it('a very wide schema stops at the work budget with a finding instead of running unbounded', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 300_000; i++) properties[`p${i}`] = { type: 'string', description: `field ${i % 7}` };
    const a = within(15_000, () => analyzeTool(tool({ type: 'object', properties })));
    expect(rules(a)).toContain('analysis-budget-exceeded');
  });

  it('deep catalogs diff without overflowing', () => {
    const before = { tools: [tool(nested(50_000, { type: 'string' }))], prompts: [], resourceTemplates: [] };
    const after = { tools: [tool(nested(50_000, { type: 'number' }))], prompts: [], resourceTemplates: [] };
    const d = within(5_000, () => diffCatalogs(normalizeCatalog(before), normalizeCatalog(after)));
    expect(d.identical).toBe(false);
  });
});

describe('prototype-named tools and properties are plain data', () => {
  const NAMES = ['constructor', 'toString', 'valueOf', '__proto__', 'hasOwnProperty', '__defineGetter__'];

  it('tools-list sweep: every prototype-named tool is measured, nothing crashes or pollutes', async () => {
    const [t] = await loadTokenizers(['cl100k']);
    const tools = NAMES.map((name) => ({
      name,
      description: `tool ${name}`,
      inputSchema: JSON.parse(`{"type":"object","properties":{"__proto__":{"type":"string"},"constructor":{"type":"integer","default":"x"}},"required":["toString","constructor"]}`),
    }));
    const input = parseToolsListFile(JSON.stringify({ tools }), 'p.json');
    const r = runSweep(input, { tokenizers: [t!] });
    expect(r.tools.map((x) => x.name)).toEqual([...NAMES].sort());
    expect(r.tools.every((x) => x.exposure.bytes > 0)).toBe(true);
    const req = r.findings.filter((f) => f.rule === 'required-not-in-properties');
    expect(req.map((f) => f.data?.['property'])).toEqual(NAMES.map(() => 'toString'));
    expect(r.findings.filter((f) => f.rule === 'default-invalid')).toHaveLength(NAMES.length);
    expect(({} as Record<string, unknown>)['type']).toBeUndefined();
    expect(JSON.parse(serializeReport(r)).tools).toHaveLength(NAMES.length);
  });

  it('exec records and Anthropic per-tool counts keyed by prototype names', async () => {
    const [t] = await loadTokenizers(['cl100k']);
    const lines = NAMES.map((name) => JSON.stringify({ name, info_output: `name: ${name}\ninputSchema: '{}'\n`, info_json_output: JSON.stringify({ name, inputSchema: { type: 'object' } }), schema_output: '{"type":"unknown"}' }));
    const input = sweepInputFromExecRecords(parseExecRecords(lines.join('\n'), 'x.jsonl'), {
      adapter: 'posthog-exec',
      server: { name: 'x', version: null },
      protocolVersion: null,
      source: { kind: 'file', name: 'x.jsonl', format: 'x' },
    });
    const fake = (async (_u: unknown, init?: RequestInit) => {
      const n = (JSON.parse(String(init?.body)) as { tools?: unknown[] }).tools?.length ?? 0;
      return new Response(JSON.stringify({ input_tokens: 3 + 10 * n }));
    }) as unknown as typeof fetch;
    const anthropic = await anthropicToolCounts(input.catalog.tools, { apiKey: 'k', fetch: fake });
    expect(Object.keys(anthropic.perTool).sort()).toEqual([...NAMES].sort());
    const r = runSweep(input, { tokenizers: [t!], anthropic });
    expect(r.tools.map((x) => x.anthropicTokens)).toEqual(NAMES.map(() => 10));
    expect(r.tools.every((x) => x.exposure.tokens['cl100k']! > 0)).toBe(true);
    expect(r.findings.filter((f) => f.data?.['view'] === 'schema')).toHaveLength(NAMES.length);
  });

  it('registry lookups ignore the prototype', async () => {
    for (const id of ['constructor', 'toString', '__proto__']) await expect(loadTokenizer(id)).rejects.toThrow(/unknown tokenizer/);
    await expect(loadSweepInput({ from: 'x', adapter: 'constructor' })).rejects.toThrow(/unknown adapter/);
  });
});

describe('seeded hostile-schema fuzz', () => {
  it('1,000 random hostile schemas: every one analyzes and sweeps without throwing, each under 1 s', async () => {
    const [t] = await loadTokenizers(['cl100k']);
    let seed = 0x9e3779b9;
    const rnd = (n: number): number => {
      seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0;
      return seed % n;
    };
    const KEYS = ['type', 'properties', 'items', 'anyOf', 'oneOf', 'allOf', '$ref', '$defs', 'enum', 'const', 'default', 'pattern', 'required', 'additionalProperties', 'description', '__proto__', 'constructor', 'not', 'if', 'then', 'prefixItems', 'minimum', 'minLength'];
    const REFS = ['#', '#/$defs/a', '#/properties/x', '#/%E0%A4%A', '#/$defs/a/allOf/0', 'http://x', '#/~2'];
    const PATTERNS = ['^((a+))+$', '^(a|a)*$', '(', '[', '(?<n>a)\\k<n>', '^$'];
    const value = (d: number): unknown => {
      switch (rnd(d > 6 ? 4 : 9)) {
        case 0:
          return rnd(3) === 0 ? 'a'.repeat(rnd(3000)) : `${'x'.repeat(rnd(5))}* \`v\` - V\n* \`w\` - W`;
        case 1:
          return rnd(1e6) - 5e5;
        case 2:
          return rnd(2) === 0;
        case 3:
          return null;
        case 4:
          return Array.from({ length: rnd(6) }, () => value(d + 1));
        default: {
          const o: Record<string, unknown> = {};
          for (let i = rnd(6); i > 0; i--) {
            const k = KEYS[rnd(KEYS.length)]!;
            const v = k === '$ref' ? REFS[rnd(REFS.length)] : k === 'pattern' ? PATTERNS[rnd(PATTERNS.length)] : k === 'type' ? ['object', 'string', 'unknown', ['null', 'integer']][rnd(4)] : value(d + 1);
            Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });
          }
          return o;
        }
      }
    };
    for (let i = 0; i < 1_000; i++) {
      const schema = value(0);
      const entry = JSON.parse(canonicalJson({ name: KEYS[rnd(KEYS.length)]!, inputSchema: schema, annotations: value(4) })) as CatalogTool;
      const t0 = Date.now();
      expect(() => analyzeTool(entry)).not.toThrow();
      const input = parseToolsListFile(JSON.stringify({ tools: [entry] }), 'f.json');
      expect(() => runSweep(input, { tokenizers: [t!] })).not.toThrow();
      expect(Date.now() - t0, `case ${i}`).toBeLessThan(1_000);
    }
  }, 120_000);
});
