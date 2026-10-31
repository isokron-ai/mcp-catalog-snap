/**
 * Canonical JSON (RFC 8785 / JCS) + the catalog fingerprint.
 *
 * The fingerprint is sha256 over the compact JCS serialization of the
 * catalog body. Two captures of the same server that produce the same
 * bytes here would produce the same tool-definition block in a model
 * request — which is what a prompt-cache prefix is keyed on.
 */

import { createHash } from 'node:crypto';

import canonicalizeModule from 'canonicalize';

// `canonicalize` is CommonJS (`module.exports = fn`); its typings declare a
// default export. Resolve whichever shape the runtime hands us.
type CanonicalizeFn = (input: unknown) => string | undefined;
const canonicalize: CanonicalizeFn =
  typeof canonicalizeModule === 'function'
    ? (canonicalizeModule as unknown as CanonicalizeFn)
    : (canonicalizeModule as unknown as { default: CanonicalizeFn }).default;

/** JSON value as it comes off the wire from an MCP server. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Compact RFC 8785 serialization. Throws on NaN/Infinity (not JSON). */
export function canonicalJson(value: unknown): string {
  const out = canonicalize(value);
  if (out === undefined) {
    throw new Error('value is not JSON-serializable');
  }
  return out;
}

/** sha256 hex of the compact canonical serialization. */
export function fingerprint(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

/**
 * Return a deep copy whose object keys are in JCS order (UTF-16 code unit
 * sort) and whose `undefined` members are dropped, so a later
 * `JSON.stringify(x, null, 2)` is byte-deterministic and agrees with the
 * compact canonical form modulo whitespace.
 */
export function sortKeysDeep(value: unknown): JsonValue {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new Error('non-finite number is not JSON');
    }
    if (value === undefined) return null;
    return value as JsonValue;
  }
  if (Array.isArray(value)) {
    return value.map((v) => (v === undefined ? null : sortKeysDeep(v)));
  }
  const src = value as Record<string, unknown>;
  const out: { [key: string]: JsonValue } = {};
  for (const key of Object.keys(src).sort()) {
    const v = src[key];
    if (v === undefined) continue;
    out[key] = sortKeysDeep(v);
  }
  return out;
}

/** Pretty-printed, key-sorted JSON with a trailing newline (git-friendly). */
export function prettyCanonical(value: unknown): string {
  return `${JSON.stringify(sortKeysDeep(value), null, 2)}\n`;
}
