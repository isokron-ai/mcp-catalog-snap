/**
 * Canonical JSON (RFC 8785 / JCS) + the catalog fingerprint.
 *
 * The fingerprint is sha256 over the compact JCS serialization of the
 * catalog body. Two captures of the same server that produce the same
 * bytes here would produce the same tool-definition block in a model
 * request — which is what a prompt-cache prefix is keyed on.
 *
 * Catalogs come from untrusted servers, so every function here is
 * iterative (no recursion, any nesting depth) and builds objects with
 * own-property definitions, so keys like `__proto__` stay data. The compact
 * form is byte-identical to the `canonicalize` package used by v0.1 (the
 * test suite checks this), so v0.1 fingerprints are unchanged.
 */

import { createHash } from 'node:crypto';

/** JSON value as it comes off the wire from an MCP server. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** A literal output fragment on the work stack (as opposed to a value still to serialize). */
class Lit {
  constructor(readonly s: string) {}
}

function primitive(v: unknown): string {
  if (typeof v === 'number') {
    if (Number.isNaN(v)) throw new Error('NaN is not allowed');
    if (!Number.isFinite(v)) throw new Error('Infinity is not allowed');
  }
  if (v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return JSON.stringify(v);
  throw new Error('value is not JSON-serializable');
}

function definedEntries(o: Record<string, unknown>): [string, unknown][] {
  return Object.keys(o)
    .sort()
    .filter((k) => o[k] !== undefined && typeof o[k] !== 'symbol')
    .map((k) => [k, o[k]]);
}

/** Compact RFC 8785 serialization. Throws on NaN/Infinity and non-JSON values. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) throw new Error('value is not JSON-serializable');
  const out: string[] = [];
  const stack: unknown[] = [value];
  while (stack.length > 0) {
    let v = stack.pop();
    if (v instanceof Lit) {
      out.push(v.s);
      continue;
    }
    while (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
      v = (v as { toJSON: () => unknown }).toJSON();
    }
    if (v === null || typeof v !== 'object') {
      out.push(primitive(v));
    } else if (Array.isArray(v)) {
      out.push('[');
      stack.push(new Lit(']'));
      for (let i = v.length - 1; i >= 0; i--) {
        const x = v[i] as unknown;
        stack.push(x === undefined || typeof x === 'symbol' ? null : x);
        if (i > 0) stack.push(new Lit(','));
      }
    } else {
      const entries = definedEntries(v as Record<string, unknown>);
      out.push('{');
      stack.push(new Lit('}'));
      for (let i = entries.length - 1; i >= 0; i--) {
        const [k, x] = entries[i]!;
        stack.push(x);
        stack.push(new Lit(`${i > 0 ? ',' : ''}${JSON.stringify(k)}:`));
      }
    }
  }
  return out.join('');
}

/** sha256 hex of the compact canonical serialization. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/** Set an own, enumerable data property (`__proto__` stays a key, not a prototype). */
export function setOwn(o: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(o, key, { value, writable: true, enumerable: true, configurable: true });
}

/**
 * Return a deep copy whose object keys are in JCS order (UTF-16 code unit
 * sort) and whose `undefined` members are dropped, so a later
 * `prettyCanonical` is byte-deterministic and agrees with the compact
 * canonical form modulo whitespace.
 */
export function sortKeysDeep(value: unknown): JsonValue {
  const conv = (v: unknown): unknown => {
    if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('non-finite number is not JSON');
    if (v === undefined) return null;
    if (v === null || typeof v !== 'object') return v;
    return Array.isArray(v) ? new Array<unknown>(v.length) : {};
  };
  const root = conv(value);
  const stack: [unknown, unknown][] = [[value, root]];
  while (stack.length > 0) {
    const [src, dst] = stack.pop()!;
    if (src === null || typeof src !== 'object') continue;
    if (Array.isArray(src)) {
      const d = dst as unknown[];
      for (let i = 0; i < src.length; i++) {
        const c = conv(src[i]);
        d[i] = c;
        stack.push([src[i], c]);
      }
    } else {
      const s = src as Record<string, unknown>;
      const d = dst as Record<string, unknown>;
      for (const key of Object.keys(s).sort()) {
        const v = s[key];
        if (v === undefined) continue;
        const c = conv(v);
        setOwn(d, key, c);
        stack.push([v, c]);
      }
    }
  }
  return root as JsonValue;
}

/**
 * Pretty-printed, key-sorted JSON with a trailing newline (git-friendly).
 * Same bytes as `JSON.stringify(sortKeysDeep(v), null, 2)`, without its
 * recursion limit. With `compactFromDepth`, containers at that nesting depth
 * or deeper are written as compact canonical JSON on one line: indentation
 * costs 2 bytes per level per line, so a deep schema otherwise grows
 * quadratically (6,000 levels: 222 KB of JSON, 360 MB pretty-printed).
 */
export function prettyCanonical(value: unknown, opts: { compactFromDepth?: number } = {}): string {
  const compactFrom = opts.compactFromDepth ?? Infinity;
  const sorted = sortKeysDeep(value);
  const out: string[] = [];
  const stack: [unknown, number][] = [[sorted, 0]];
  while (stack.length > 0) {
    const [v, depth] = stack.pop()!;
    if (v instanceof Lit) {
      out.push(v.s);
      continue;
    }
    if (v === null || typeof v !== 'object') {
      out.push(primitive(v));
      continue;
    }
    if (depth >= compactFrom) {
      out.push(canonicalJson(v));
      continue;
    }
    const pad = '  '.repeat(depth + 1);
    const close = `\n${'  '.repeat(depth)}`;
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out.push('[]');
        continue;
      }
      out.push('[');
      stack.push([new Lit(`${close}]`), 0]);
      for (let i = v.length - 1; i >= 0; i--) {
        stack.push([v[i], depth + 1]);
        stack.push([new Lit(`${i > 0 ? ',' : ''}\n${pad}`), 0]);
      }
    } else {
      const keys = Object.keys(v);
      if (keys.length === 0) {
        out.push('{}');
        continue;
      }
      out.push('{');
      stack.push([new Lit(`${close}}`), 0]);
      for (let i = keys.length - 1; i >= 0; i--) {
        stack.push([(v as Record<string, unknown>)[keys[i]!], depth + 1]);
        stack.push([new Lit(`${i > 0 ? ',' : ''}\n${pad}${JSON.stringify(keys[i])}: `), 0]);
      }
    }
  }
  return `${out.join('')}\n`;
}

/**
 * Canonical JSON per subtree, each built once from its children's strings
 * (iterative post-order, memoized by object identity). Serializing every
 * subtree of a tree then costs one pass plus the concatenation, instead of
 * re-serializing each subtree from scratch. Only valid while the values are
 * not mutated: use a fresh cache after changing the tree.
 */
export class CanonCache {
  private readonly memo = new WeakMap<object, string>();

  get(value: unknown): string {
    if (value === null || typeof value !== 'object') return value === undefined ? 'null' : primitive(value);
    const hit = this.memo.get(value);
    if (hit !== undefined) return hit;
    const stack: [object, boolean][] = [[value, false]];
    while (stack.length > 0) {
      const [node, expanded] = stack.pop()!;
      if (this.memo.has(node)) continue;
      const kids: unknown[] = Array.isArray(node) ? node : definedEntries(node as Record<string, unknown>).map(([, v]) => v);
      if (!expanded) {
        stack.push([node, true]);
        for (const k of kids) if (k !== null && typeof k === 'object' && !this.memo.has(k)) stack.push([k, false]);
        continue;
      }
      const part = (v: unknown): string =>
        v === undefined || typeof v === 'symbol' ? 'null' : v !== null && typeof v === 'object' ? this.memo.get(v)! : primitive(v);
      const s = Array.isArray(node)
        ? `[${node.map(part).join(',')}]`
        : `{${definedEntries(node as Record<string, unknown>)
            .map(([k, v]) => `${JSON.stringify(k)}:${part(v)}`)
            .join(',')}}`;
      this.memo.set(node, s);
    }
    return this.memo.get(value)!;
  }
}
