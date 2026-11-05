/**
 * Second review round: validator CPU budget, tokenizer parity on
 * adversarial strings, targeted guard tests (each fails if its guard is
 * removed), and markdown entity injection.
 */

import { describe, expect, it } from 'vitest';

import { analyzeTool, type Finding } from '../src/findings.js';
import { mdText } from '../src/report-md.js';
import type { CatalogTool } from '../src/snapshot.js';
import { chunkText, loadTokenizers } from '../src/tokenize.js';
import { validateContext, validateValue } from '../src/validate.js';

const tool = (inputSchema: unknown, name = 't'): CatalogTool => ({ name, inputSchema: inputSchema as CatalogTool['inputSchema'] });
const rules = (fs: Finding[]): string[] => fs.map((f) => f.rule);
const within = <T>(ms: number, f: () => T): T => {
  const t0 = Date.now();
  const r = f();
  expect(Date.now() - t0).toBeLessThan(ms);
  return r;
};
/** Best of 3 runs: bounds the code's cost, not the scheduler's (the suite runs files in parallel). */
const bestOf3Within = <T>(ms: number, f: () => T): T => {
  let best = Infinity;
  let r: T | undefined;
  for (let i = 0; i < 3 && best >= ms; i++) {
    const t0 = Date.now();
    r = f();
    best = Math.min(best, Date.now() - t0);
  }
  expect(best).toBeLessThan(ms);
  return r!;
};

describe('validator cost is bounded by steps and bytes', () => {
  it('1 MB object default against 10K enum entries finishes under 2 s', () => {
    const s = { type: 'object', properties: { p: { enum: Array.from({ length: 10_000 }, () => ({})), default: { a: 'x'.repeat(1 << 20) } } } };
    const a = bestOf3Within(2_000, () => analyzeTool(tool(s)));
    expect(rules(a.findings).some((r) => r === 'default-invalid' || r === 'default-unchecked')).toBe(true);
  });

  it('anyOf of 1,000 $refs to 1,000-entry enums with a 100 KB default finishes under 2 s', () => {
    const $defs: Record<string, unknown> = {};
    for (let i = 0; i < 1_000; i++) $defs[`E${i}`] = { enum: Array.from({ length: 1_000 }, (_, j) => `v${j}`) };
    const s = { type: 'object', $defs, properties: { p: { anyOf: Array.from({ length: 1_000 }, (_, i) => ({ $ref: `#/$defs/E${i}` })), default: 'y'.repeat(100_000) } } };
    const a = bestOf3Within(2_000, () => analyzeTool(tool(s)));
    expect(rules(a.findings).some((r) => r === 'default-invalid' || r === 'default-unchecked')).toBe(true);
  });

  it('charges a step per enum comparison and bytes per serialization', () => {
    const ctx = validateContext(1_000_000);
    expect(validateValue({ a: 'x'.repeat(10_000) }, { enum: [{}, {}, {}] }, {}, ctx)).toMatch(/enum/);
    expect(ctx.steps).toBeGreaterThanOrEqual(3);
    expect(ctx.bytes).toBeGreaterThanOrEqual(10_000);
    expect(ctx.bytes).toBeLessThan(20_000); // the default is serialized once, not once per entry
    const tight = validateContext(1_000_000, 5_000);
    validateValue({ a: 'x'.repeat(10_000) }, { enum: [{}] }, {}, tight);
    expect(tight.exhausted).toBe(true);
  });

  it('memoizes $ref targets per (ref, value)', () => {
    const root = { $defs: { E: { enum: Array.from({ length: 500 }, (_, j) => j) } } };
    const ctx = validateContext(1_000_000);
    const schema = { allOf: Array.from({ length: 200 }, () => ({ $ref: '#/$defs/E' })) };
    expect(validateValue(7, schema, root, ctx)).toBeNull();
    expect(ctx.steps).toBeLessThan(2_000); // without the memo: 200 × 500
  });
});

describe('tokenizer parity on adversarial strings (Python tiktoken oracle)', () => {
  const hex = (): string => {
    let h = '';
    let x = 12345;
    for (let i = 0; i < 70_000; i++) {
      x = (x * 48271) % 2147483647;
      h += '0123456789abcdef'[x % 16];
    }
    return h;
  };
  const STRINGS = (): string[] => [
    'a'.repeat(70_000),
    '7'.repeat(70_000),
    hex(),
    "don't we'll it's I'M they'RE ".repeat(3_000),
    `${'x'.repeat(2_047)}'s ${'y'.repeat(2_046)}'t ${'z'.repeat(5_000)}`,
    'ab12'.repeat(20_000),
    `${'é'.repeat(30_000)}${'é'.repeat(20_000)}`,
  ];
  const ORACLE = {
    cl100k: [8750, 23334, 39624, 30001, 3273, 40000, 69999],
    o200k: [8750, 23334, 39769, 24001, 3272, 40000, 69999],
  };

  it.each(['cl100k', 'o200k'] as const)('%s: exact counts, no hard cuts', async (id) => {
    const [t] = await loadTokenizers([id]);
    expect(STRINGS().map((s) => t!.count(s))).toEqual(ORACLE[id]);
  });

  it('lone surrogates: chunked count equals a single pass', async () => {
    const [t] = await loadTokenizers(['cl100k']);
    const s = `${'a\uDC00.'.repeat(2_000)}${'b\uD800 '.repeat(2_000)}${'x'.repeat(3_000)}\uDC00${'y'.repeat(3_000)}`;
    const single = await import('gpt-tokenizer/encoding/cl100k_base');
    expect(t!.count(s)).toBe(single.countTokens(s, { disallowedSpecial: new Set() }));
    expect(chunkText(s).join('')).toBe(s);
  });

  it('a 64K single word is one chunk, still under 2 s', async () => {
    const [t] = await loadTokenizers(['cl100k', 'o200k']);
    expect(chunkText('q'.repeat(65_536))).toHaveLength(1);
    within(2_000, () => t!.count('q'.repeat(65_536)));
  });
});

describe('targeted guard tests (each fails if its guard is removed)', () => {
  it('pattern avoidance: no RegExp from the schema is ever executed', () => {
    const PATTERN = '^b+$';
    const seen: string[] = [];
    const origExec = RegExp.prototype.exec;
    const origTest = RegExp.prototype.test;
    RegExp.prototype.exec = function (this: RegExp, s: string) {
      seen.push(this.source);
      return origExec.call(this, s);
    };
    RegExp.prototype.test = function (this: RegExp, s: string) {
      seen.push(this.source);
      return origTest.call(this, s);
    };
    try {
      const a = analyzeTool(tool({ type: 'object', properties: { p: { type: 'string', pattern: PATTERN, default: 'a' } } }));
      expect(rules(a.findings)).toContain('default-unchecked');
      expect(rules(a.findings)).not.toContain('default-invalid');
    } finally {
      RegExp.prototype.exec = origExec;
      RegExp.prototype.test = origTest;
    }
    expect(seen).not.toContain(PATTERN);
  });

  it('depth cap: an invalid node below 64 levels is not analyzed; the cut is reported', () => {
    let v: unknown = { type: 'unknown' };
    for (let i = 0; i < 80; i++) v = { type: 'object', properties: { x: v } };
    const a = analyzeTool(tool(v));
    expect(rules(a.findings)).toContain('schema-too-deep');
    expect(a.findings.filter((f) => f.rule === 'schema-invalid')).toEqual([]);
  });

  it('ref cycle guard: a self-referencing schema still yields a definite verdict', () => {
    // $ref is expanded before the type check, so without the guard the self-reference recurses until the budget runs out
    const s = { type: 'object', $defs: { A: { $ref: '#/$defs/A', type: 'integer' } }, properties: { p: { $ref: '#/$defs/A', default: 'x' } } };
    const a = analyzeTool(tool(s));
    expect(rules(a.findings)).toContain('default-invalid');
    expect(rules(a.findings)).not.toContain('default-unchecked');
    const ctx = validateContext();
    expect(validateValue('x', { $ref: '#/$defs/A' }, s, ctx)).toMatch(/not of type integer/);
    expect(ctx.exhausted).toBe(false);
    expect(ctx.steps).toBeLessThan(10);
  });

  it('hasOwn: inherited names are neither properties nor present keys', () => {
    const closed = analyzeTool(tool({ type: 'object', properties: { p: { type: 'object', properties: { a: {} }, additionalProperties: false, default: { constructor: 1 } } } }));
    expect(closed.findings.find((f) => f.rule === 'default-invalid')?.message).toMatch(/"constructor" is not allowed/);
    const req = analyzeTool(tool({ type: 'object', properties: { p: { type: 'object', required: ['toString'], default: {} } } }));
    expect(req.findings.find((f) => f.rule === 'default-invalid')?.message).toMatch(/missing required property "toString"/);
    const props = analyzeTool(tool({ type: 'object', properties: { a: {} }, required: ['valueOf'] }));
    expect(props.findings.find((f) => f.rule === 'required-not-in-properties')?.data?.['property']).toBe('valueOf');
  });

  it('work budget: a small budget stops analysis with a finding (asserted on the counter, not the clock)', () => {
    const properties: Record<string, unknown> = {};
    for (let i = 0; i < 5_000; i++) properties[`p${i}`] = { type: 'string' };
    const a = analyzeTool(tool({ type: 'object', properties }), { workBudget: 1_000 });
    expect(a.findings.find((f) => f.rule === 'analysis-budget-exceeded')?.data?.['workBudget']).toBe(1_000);
    expect(rules(analyzeTool(tool({ type: 'object', properties })).findings)).not.toContain('analysis-budget-exceeded');
  });
});

describe('markdown entity injection', () => {
  it('HTML entities cannot form mentions, links or tags', () => {
    for (const evil of ['&#64;everyone', '&commat;team', '&lsqb;x&rsqb;(https://e)', '&lt;img src=x onerror=alert(1)&gt;', 'h&#116;tps://evil', '&#x5B;a](b)']) {
      const t = mdText(evil);
      expect(t).not.toMatch(/&(?!amp;)/);
    }
  });
});
