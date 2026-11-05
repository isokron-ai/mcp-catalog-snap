import { describe, expect, it } from 'vitest';

import { canonicalJson } from '../src/canonical.js';
import {
  analyzeCallResult,
  analyzeTool,
  dedupRefs,
  drfValues,
  nameWords,
  oversizeFinding,
  summarizeFindings,
  type Finding,
} from '../src/findings.js';
import { PathSet, pointer, resolveLocalRef, schemaNodes } from '../src/schema-walk.js';
import type { CatalogTool } from '../src/snapshot.js';
import { loadTokenizer } from '../src/tokenize.js';
import { keywordProblems, safeToRun, validateValue } from '../src/validate.js';

const rules = (fs: Finding[]): string[] => fs.map((f) => `${f.rule} ${f.path}`);

const big = (n: number): string[] => Array.from({ length: n }, (_, i) => `v${String(i).padStart(2, '0')}`);

describe('schema-walk', () => {
  it('visits schema positions only, with JSON-pointer paths', () => {
    const s = {
      type: 'object',
      properties: { a: { type: 'array', items: { type: 'string' } }, 'x/y': { default: { type: 'not-a-schema' } } },
      anyOf: [{ required: ['a'] }],
      items: [{ type: 'number' }],
    };
    const paths = [...schemaNodes(s)].map(([p]) => pointer(p));
    expect(paths).toEqual(['', '/properties/a', '/properties/a/items', '/properties/x~1y', '/anyOf/0', '/items/0']);
    expect(resolveLocalRef({ $defs: { 'a/b': 1 } }, '#/$defs/a~1b')).toBe(1);
    expect(resolveLocalRef({}, '#/nope')).toBeUndefined();
  });

  it('PathSet answers prefix queries both ways', () => {
    const ps = new PathSet();
    ps.add(['a', 1]);
    expect(ps.covers(['a', 1, 'b'])).toBe(true);
    expect(ps.covers(['a'])).toBe(false);
    expect(ps.containsUnder(['a'])).toBe(true);
    expect(ps.containsUnder(['b'])).toBe(false);
  });
});

describe('validity rules', () => {
  it('schema-missing / root type', () => {
    expect(rules(analyzeTool({ name: 't' } as unknown as CatalogTool).findings)).toContain('schema-missing ');
    expect(rules(analyzeTool({ name: 't', inputSchema: 'x' }).findings)).toContain('schema-missing /inputSchema');
    expect(rules(analyzeTool({ name: 't', inputSchema: { type: 'array' } }).findings)).toContain('schema-invalid /inputSchema/type');
  });

  it('flags draft-03 boolean required, bad types, bad patterns, dangling $ref', () => {
    const t: CatalogTool = {
      name: 'read-x',
      annotations: { readOnlyHint: true },
      inputSchema: {
        type: 'object',
        properties: {
          a: { type: 'string', required: true },
          b: { type: 'unknown' },
          c: { type: 'string', pattern: '(' },
          d: { $ref: '#/$defs/missing' },
        },
      },
    };
    const f = analyzeTool(t).findings.filter((x) => x.rule === 'schema-invalid');
    expect(f.map((x) => [x.path, x.message])).toEqual([
      ['/inputSchema/properties/a', expect.stringContaining('draft-03')],
      ['/inputSchema/properties/b', expect.stringContaining('"unknown" is not a JSON Schema type')],
      ['/inputSchema/properties/c', expect.stringContaining('not a valid regular expression')],
      ['/inputSchema/properties/d', expect.stringContaining('does not resolve')],
    ]);
  });

  it('required-not-in-properties: warn on open objects, error when closed, branch properties count', () => {
    const open = analyzeTool({ name: 't', inputSchema: { type: 'object', properties: { a: {} }, required: ['a', 'b'] } }).findings;
    const r1 = open.filter((f) => f.rule === 'required-not-in-properties');
    expect(r1.map((f) => [f.severity, f.data?.['property']])).toEqual([['warn', 'b']]);
    const closed = analyzeTool({
      name: 't',
      inputSchema: { type: 'object', properties: { a: {} }, required: ['b'], additionalProperties: false },
    }).findings.filter((f) => f.rule === 'required-not-in-properties');
    expect(closed[0]!.severity).toBe('error');
    const viaAllOf = analyzeTool({
      name: 't',
      inputSchema: { type: 'object', properties: { a: {} }, required: ['b'], allOf: [{ properties: { b: {} } }] },
    }).findings.filter((f) => f.rule === 'required-not-in-properties');
    expect(viaAllOf).toEqual([]);
  });

  it('default-invalid catches defaults failing type/enum/bounds/pattern/$ref, passes valid ones', () => {
    const schema = {
      type: 'object',
      $defs: { Pos: { type: 'integer', minimum: 1 } },
      properties: {
        a: { type: 'integer', default: 'ten' },
        b: { enum: ['x', 'y'], default: 'z' },
        c: { type: 'number', maximum: 5, default: 6 },
        d: { type: 'string', pattern: '^[a-z]+$', default: 'ABC' },
        e: { $ref: '#/$defs/Pos', default: 0 },
        ok1: { type: 'integer', default: 3 },
        ok2: { anyOf: [{ type: 'string' }, { type: 'null' }], default: null },
        ok3: { type: 'array', items: { type: 'string' }, default: ['a'] },
        bad3: { type: 'array', items: { type: 'string' }, default: [1] },
        ok4: { type: 'string', nullable: true, default: null },
        bad4: { type: 'object', properties: { k: { type: 'string' } }, required: ['k'], default: {} },
      },
    };
    const f = analyzeTool({ name: 't', inputSchema: schema }).findings.filter((x) => x.rule === 'default-invalid');
    expect(f.map((x) => x.path.split('/')[3])).toEqual(['a', 'b', 'bad3', 'bad4', 'c', 'd', 'e']);
  });

  it('validateValue / keywordProblems unit edges', () => {
    expect(validateValue(1, { type: 'number' }, {})).toBeNull();
    expect(validateValue(1.5, { type: 'integer' }, {})).toMatch(/not of type integer/);
    expect(validateValue({ z: 1 }, { type: 'object', additionalProperties: false }, {})).toMatch(/not allowed/);
    expect(validateValue('x', false, {})).toMatch(/false/);
    expect(validateValue('x', { oneOf: [{ type: 'number' }, { type: 'boolean' }] }, {})).toMatch(/none of the oneOf/);
    expect(keywordProblems({ required: ['a', 'a'], minLength: -1, enum: [] }, {})).toEqual([
      '`required` lists a name twice',
      '`enum` must be a non-empty array',
      '`minLength` must be a non-negative integer',
    ]);
  });
});

describe('choice-list rules', () => {
  it('enum-large over the cap, const-unions included, configurable cap', () => {
    const t: CatalogTool = {
      name: 't',
      inputSchema: {
        type: 'object',
        properties: { e: { enum: big(25) }, u: { oneOf: big(21).map((c) => ({ const: c })) }, s: { enum: big(5) } },
      },
    };
    const f = analyzeTool(t).findings.filter((x) => x.rule === 'enum-large');
    expect(f.map((x) => [x.path, x.data?.['count']])).toEqual([
      ['/inputSchema/properties/e', 25],
      ['/inputSchema/properties/u', 21],
    ]);
    expect(analyzeTool(t, { enumMax: 4 }).findings.filter((x) => x.rule === 'enum-large')).toHaveLength(3);
    expect(analyzeTool(t).choiceLists.map((c) => [c.kind, c.count])).toEqual([
      ['enum', 25],
      ['const-union', 21],
      ['enum', 5],
    ]);
  });

  it('DRF lists: repeats-enum (incl. nullable wrapper) vs enum-in-prose', () => {
    const drf = (vals: string[]): string => `Pick one.\n\n${vals.map((v) => `* \`${v}\` - ${v.toUpperCase()}`).join('\n')}`;
    expect(drfValues(drf(['a', 'b']))).toEqual(['a', 'b']);
    const t: CatalogTool = {
      name: 't',
      inputSchema: {
        type: 'object',
        properties: {
          dup: { type: 'string', enum: ['a', 'b', 'c'], description: drf(['a', 'b', 'c']) },
          wrapped: { description: drf(['x', 'y']), anyOf: [{ type: 'string', enum: ['x', 'y'] }, { type: 'null' }] },
          prose: { type: 'string', description: drf(['UTC', 'Europe/Paris']) },
        },
      },
    };
    const a = analyzeTool(t);
    expect(rules(a.findings.filter((f) => f.rule === 'description-repeats-enum' || f.rule === 'enum-in-prose'))).toEqual([
      'description-repeats-enum /inputSchema/properties/dup/description',
      'description-repeats-enum /inputSchema/properties/wrapped/description',
      'enum-in-prose /inputSchema/properties/prose/description',
    ]);
    const wrappedEnum = a.choiceLists.find((c) => c.path === '/inputSchema/properties/wrapped/anyOf/0');
    expect(wrappedEnum?.duplicated).toBe(true);
  });
});

describe('duplicate-subtree + $defs', () => {
  const filter = {
    type: 'object',
    properties: { key: { type: 'string', description: 'Property key to filter on, e.g. $browser.' }, value: { type: 'string', description: 'Value to compare the property against.' }, operator: { enum: ['exact', 'is_not', 'icontains', 'regex'] } },
  };
  const t: CatalogTool = {
    name: 't',
    inputSchema: { type: 'object', properties: { a: { type: 'array', items: filter }, b: { type: 'array', items: filter }, c: filter } },
  };

  it('counts greedy maximal repeats, reports top offenders and a $defs estimate', async () => {
    const tok = await loadTokenizer('cl100k');
    const a = analyzeTool(t, { tokenizer: tok });
    const fs = canonicalJson(filter).length;
    const wrapper = canonicalJson({ type: 'array', items: filter }).length;
    // Largest first: the a/b array wrappers repeat once; inside them only a.items is still live, so the
    // filter counts as a.items + c (b.items is already inside a removed copy).
    expect(a.duplicates.groups).toBe(2);
    expect(a.duplicates.top).toEqual([
      { path: '/inputSchema/properties/a', count: 2, bytes: wrapper, wasteBytes: wrapper },
      { path: '/inputSchema/properties/a/items', count: 2, bytes: fs, wasteBytes: fs },
    ]);
    expect(a.duplicates.wasteBytes).toBe(wrapper + fs);
    expect(a.duplicates.defs.created).toBeGreaterThan(0);
    expect(a.duplicates.defs.bytesAfter).toBeLessThan(a.duplicates.defs.bytesBefore);
    expect(a.duplicates.defs.tokensAfter!).toBeLessThan(a.duplicates.defs.tokensBefore!);
    const f = a.findings.find((x) => x.rule === 'duplicate-subtree')!;
    expect(f.severity).toBe('warn');
  });

  it('dedupRefs output still describes the same values (refs resolve) and keeps existing $defs', () => {
    const withDefs = { ...(t.inputSchema as object), $defs: { Keep: { type: 'string' }, _dup0: { type: 'null' } } };
    const { schema, created } = dedupRefs(withDefs);
    expect(created).toBeGreaterThan(0);
    const s = schema as { $defs: Record<string, unknown>; properties: Record<string, unknown> };
    expect(s.$defs['Keep']).toEqual({ type: 'string' });
    expect(s.$defs['_dup0']).toEqual({ type: 'null' });
    const ok = { a: [{ key: 'k', value: 'v', operator: 'exact' }], c: { operator: 'regex' } };
    const bad = { c: { operator: 'nope' } };
    expect(validateValue(ok, schema, schema)).toBeNull();
    expect(validateValue(bad, schema, schema)).toMatch(/enum/);
  });
});

describe('untyped, escaped JSON, annotations, output duplication', () => {
  it('untyped-node counts {} nodes, items: {} and opaque objects', () => {
    const a = analyzeTool({
      name: 't',
      inputSchema: {
        type: 'object',
        properties: { any: {}, desc: { description: 'anything' }, list: { type: 'array', items: {} }, bag: { type: 'object', additionalProperties: true } },
      },
    });
    expect(a.untyped).toMatchObject({ noTypeNodes: 2, emptyItems: 1, opaqueObjects: 1 });
    expect(a.findings.find((f) => f.rule === 'untyped-node')!.data?.['examples']).toEqual([
      '/inputSchema/properties/any',
      '/inputSchema/properties/desc',
      '/inputSchema/properties/list/items',
    ]);
  });

  it('escaped-json fires for string values holding JSON documents', () => {
    const blob = JSON.stringify({ query: { kind: 'TrendsQuery', series: [{ event: '$pageview' }] } });
    const a = analyzeTool({ name: 't', inputSchema: { type: 'object', properties: { q: { type: 'string', default: blob } } } });
    const f = a.findings.find((x) => x.rule === 'escaped-json')!;
    expect(f.path).toBe('/inputSchema/properties/q/default');
    expect(f.data?.['overheadBytes']).toBe(JSON.stringify(blob).length - 2 - blob.length);
    expect(analyzeTool({ name: 't', inputSchema: { type: 'object', description: '{ not json at all, but long enough to be checked }' } }).findings.some((x) => x.rule === 'escaped-json')).toBe(false);
  });

  it('annotation rules: missing, verb vs hints, readOnly+destructive', () => {
    const s = { type: 'object' };
    expect(rules(analyzeTool({ name: 'list-things', inputSchema: s }).findings)).toEqual(['annotations-missing ']);
    expect(nameWords('deleteUser')).toEqual(['delete', 'user']);
    expect(nameWords('feature_flag.remove-all')).toEqual(['feature', 'flag', 'remove', 'all']);
    const de = analyzeTool({ name: 'user-delete', inputSchema: s, annotations: { destructiveHint: false } }).findings;
    expect(de.map((f) => [f.rule, f.severity, f.path])).toEqual([['annotation-contradiction', 'warn', '/annotations/destructiveHint']]);
    const ro = analyzeTool({ name: 'removeItem', inputSchema: s, annotations: { readOnlyHint: true } }).findings;
    expect(ro.map((f) => [f.rule, f.severity])).toEqual([['annotation-contradiction', 'error']]);
    const both = analyzeTool({ name: 'x', inputSchema: s, annotations: { readOnlyHint: true, destructiveHint: true } }).findings;
    expect(both.map((f) => f.message)).toEqual(['readOnlyHint and destructiveHint are both true']);
    // "deleted" is not the verb "delete"
    expect(analyzeTool({ name: 'list-deleted', inputSchema: s, annotations: { readOnlyHint: true } }).findings).toEqual([]);
  });

  it('output-duplication-risk (static) and structured-content-duplicated (observed)', async () => {
    const a = analyzeTool({ name: 't', inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, annotations: { readOnlyHint: true } });
    expect(rules(a.findings)).toEqual(['output-duplication-risk /outputSchema']);
    const tok = await loadTokenizer('cl100k');
    const sc = { rows: [1, 2, 3], next: null };
    const dup = analyzeCallResult('t', { structuredContent: sc, content: [{ type: 'text', text: 'hello' }, { type: 'text', text: JSON.stringify(sc, null, 2) }] }, tok);
    expect(dup).toMatchObject({ rule: 'structured-content-duplicated', path: '/content/1', data: { duplicatedBytes: JSON.stringify(sc, null, 2).length } });
    expect(dup!.data!['duplicatedTokens']).toBeGreaterThan(0);
    expect(analyzeCallResult('t', { structuredContent: sc, content: [{ type: 'text', text: '{"rows":[1]}' }] })).toBeNull();
    expect(analyzeCallResult('t', { content: [] })).toBeNull();
  });

  it('descriptions are untrusted: size cap finding, no ReDoS on hostile patterns, huge strings not scanned', () => {
    const long = 'x'.repeat(20_000);
    const a = analyzeTool({ name: 't', description: long, inputSchema: { type: 'object', properties: { p: { type: 'string', description: 'ok' } } } });
    expect(rules(a.findings.filter((f) => f.rule === 'description-oversize'))).toEqual(['description-oversize /description']);
    expect(analyzeTool({ name: 't', description: long, inputSchema: { type: 'object' } }, { maxDescriptionBytes: 50_000 }).findings.some((f) => f.rule === 'description-oversize')).toBe(false);
    expect(safeToRun('^(a+)+$', 'aaaa')).toBe(false);
    expect(safeToRun('^([a-z]*)*x', 'a')).toBe(false);
    expect(safeToRun('^(\\w)\\1$', 'aa')).toBe(false);
    expect(safeToRun('^[a-z]+(-[a-z]+)?$', 'ab-cd')).toBe(true);
    const started = Date.now();
    const evil = analyzeTool({ name: 't', inputSchema: { type: 'object', properties: { p: { type: 'string', pattern: '^(a+)+$', default: `${'a'.repeat(40)}!` } } } });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(evil.findings.some((f) => f.rule === 'default-invalid')).toBe(false);
    const hugeDrf = `* \`a\` - A\n${'y'.repeat(1 << 20)}`;
    expect(drfValues(hugeDrf)).toEqual([]);
  });

  it('oversizeFinding and summarizeFindings', () => {
    expect(oversizeFinding('t', 100, 100, 'cl100k')).toBeNull();
    const f = oversizeFinding('t', 101, 100, 'cl100k')!;
    expect(f.message).toBe('exposure is 101 cl100k tokens, over the 100-token budget');
    const s = summarizeFindings([f, { ...f, tool: 'u' }, { ...f, rule: 'enum-large', severity: 'warn' }]);
    expect(Object.keys(s)).toEqual(['enum-large', 'oversize-tool']);
    expect(s['oversize-tool']).toEqual({ count: 2, tools: 2, severity: { error: 0, warn: 2, info: 0 } });
  });

  it('is deterministic: same tool → identical analysis', () => {
    const t: CatalogTool = { name: 'q', inputSchema: { type: 'object', properties: { b: { enum: big(30) }, a: { type: 'unknown' } } } };
    expect(JSON.stringify(analyzeTool(t))).toBe(JSON.stringify(analyzeTool(JSON.parse(JSON.stringify(t)) as CatalogTool)));
  });
});
