import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { canonicalJson, fingerprint, prettyCanonical, sortKeysDeep } from '../src/canonical.js';

describe('canonicalJson (RFC 8785)', () => {
  it('sorts object keys recursively and strips whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });

  it('matches the RFC 8785 §3.2.3 reference vector', () => {
    const input = JSON.parse(
      '{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],' +
        '"string":"\\u20ac$\\u000F\\u000aA\'\\u0042\\u0022\\u005c\\\\\\"\\u002f","literals":[null,true,false]}',
    );
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it('drops undefined members and nulls undefined array slots', () => {
    expect(canonicalJson({ a: undefined, b: [undefined, 1] })).toBe('{"b":[null,1]}');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalJson({ a: Number.NaN })).toThrow();
    expect(() => canonicalJson([Number.POSITIVE_INFINITY])).toThrow();
  });

  it('is insensitive to key insertion order', () => {
    const a = { name: 'x', inputSchema: { type: 'object', properties: { q: { type: 'string' } } } };
    const b = { inputSchema: { properties: { q: { type: 'string' } }, type: 'object' }, name: 'x' };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });
});

describe('fingerprint', () => {
  it('is sha256 of the canonical bytes', () => {
    const v = { z: 1, a: 'é' };
    const expected = createHash('sha256').update('{"a":"é","z":1}', 'utf8').digest('hex');
    expect(fingerprint(v)).toBe(expected);
    expect(fingerprint(v)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when any byte changes', () => {
    expect(fingerprint({ a: 'x' })).not.toBe(fingerprint({ a: 'x ' }));
  });
});

describe('sortKeysDeep / prettyCanonical', () => {
  it('returns a key-sorted deep copy', () => {
    const src = { b: { y: 1, x: 2 }, a: [{ k: 1, j: 2 }] };
    const out = sortKeysDeep(src);
    expect(Object.keys(out as object)).toEqual(['a', 'b']);
    expect(Object.keys((out as { b: object }).b)).toEqual(['x', 'y']);
    expect(Object.keys((out as { a: object[] }).a[0]!)).toEqual(['j', 'k']);
    expect(out).not.toBe(src);
  });

  it('pretty form parses back to the same canonical bytes', () => {
    const v = { q: [1, { z: null, a: true }], m: 'text' };
    const pretty = prettyCanonical(v);
    expect(pretty.endsWith('\n')).toBe(true);
    expect(pretty.startsWith('{\n  "m"')).toBe(true);
    expect(canonicalJson(JSON.parse(pretty))).toBe(canonicalJson(v));
  });

  it('uses UTF-16 code unit ordering like JCS (uppercase before lowercase, short before long)', () => {
    expect(Object.keys(sortKeysDeep({ b: 1, B: 1, a: 1, aa: 1, A: 1 }) as object)).toEqual(['A', 'B', 'a', 'aa', 'b']);
  });
});
