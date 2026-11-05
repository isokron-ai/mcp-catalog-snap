/**
 * Small, conservative JSON Schema checks with no runtime dependency.
 *
 * `keywordProblems` checks that the keywords a node uses have the shape
 * the spec requires (`type` names a real type, `required` is a string
 * array, `pattern` compiles, …). `validateValue` checks a value (a
 * `default`) against a schema for the common keywords only; anything it
 * does not understand passes, so it reports definite failures, never
 * guesses.
 *
 * Schemas are untrusted. `pattern` is never *executed*: V8's backtracking
 * engine cannot be time-boxed, and catastrophic patterns are not reliably
 * detectable, so a value whose check needed a pattern is reported as
 * unchecked instead. Validation also has a step budget and skips a `$ref`
 * already being expanded for the same value, so self-referencing or
 * fan-out `$ref` graphs terminate.
 */

import { canonicalJson } from './canonical.js';
import { isObj, resolveLocalRef, type Obj } from './schema-walk.js';

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const NUM_KEYS = ['minimum', 'maximum', 'multipleOf'];
const NONNEG_INT_KEYS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];

function isSchema(v: unknown): boolean {
  return isObj(v) || typeof v === 'boolean';
}

/** Longest pattern we even compile (compiling is linear; executing is what is unsafe). */
const MAX_PATTERN_COMPILE = 4_096;

function compiles(pattern: string): boolean {
  if (pattern.length > MAX_PATTERN_COMPILE) return true; // not checked; never executed anyway
  for (const flags of ['u', '']) {
    try {
      new RegExp(pattern, flags);
      return true;
    } catch {
      // try the next flag set
    }
  }
  return false;
}

/** Problems with the keywords on one schema node (not recursive). */
export function keywordProblems(node: Obj, root: unknown): string[] {
  const out: string[] = [];
  const t = node['type'];
  if (t !== undefined) {
    const list = Array.isArray(t) ? t : [t];
    if (list.length === 0) out.push('`type` is an empty array');
    for (const x of list) if (typeof x !== 'string' || !TYPES.has(x)) out.push(`\`type\` ${JSON.stringify(x)} is not a JSON Schema type`);
  }
  const props = node['properties'];
  if (props !== undefined) {
    if (!isObj(props)) out.push('`properties` must be an object');
    else for (const [k, v] of Object.entries(props)) if (!isSchema(v)) out.push(`\`properties.${k}\` is not a schema`);
  }
  const req = node['required'];
  if (req !== undefined) {
    if (typeof req === 'boolean') out.push('`required` is a boolean (draft-03 style); JSON Schema needs a string array on the parent object');
    else if (!Array.isArray(req) || req.some((x) => typeof x !== 'string')) out.push('`required` must be an array of strings');
    else if (new Set(req).size !== req.length) out.push('`required` lists a name twice');
  }
  const en = node['enum'];
  if (en !== undefined && (!Array.isArray(en) || en.length === 0)) out.push('`enum` must be a non-empty array');
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    const v = node[k];
    if (v !== undefined && (!Array.isArray(v) || v.length === 0 || !v.every(isSchema))) out.push(`\`${k}\` must be a non-empty array of schemas`);
  }
  const items = node['items'];
  if (items !== undefined && !isSchema(items) && !(Array.isArray(items) && items.every(isSchema))) out.push('`items` must be a schema');
  const ap = node['additionalProperties'];
  if (ap !== undefined && !isSchema(ap)) out.push('`additionalProperties` must be a boolean or a schema');
  const ref = node['$ref'];
  if (ref !== undefined) {
    if (typeof ref !== 'string') out.push('`$ref` must be a string');
    else if (ref.startsWith('#') && resolveLocalRef(root, ref) === undefined) out.push(`\`$ref\` ${JSON.stringify(ref.slice(0, 200))} is malformed or does not resolve`);
  }
  const pat = node['pattern'];
  if (pat !== undefined && (typeof pat !== 'string' || !compiles(pat))) out.push(`\`pattern\` ${JSON.stringify(pat)} is not a valid regular expression`);
  for (const k of NUM_KEYS) if (node[k] !== undefined && typeof node[k] !== 'number') out.push(`\`${k}\` must be a number`);
  for (const k of NONNEG_INT_KEYS) {
    const v = node[k];
    if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 0)) out.push(`\`${k}\` must be a non-negative integer`);
  }
  return out;
}

function typeOf(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'number';
  return typeof v;
}

function typeMatches(v: unknown, t: string): boolean {
  const actual = typeOf(v);
  return actual === t || (t === 'number' && actual === 'integer');
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  try {
    return canonicalJson(a) === canonicalJson(b); // iterative: safe on deep values
  } catch {
    return false;
  }
}

/** Shared state for one `validateValue` run. */
export interface ValidateContext {
  steps: number;
  limit: number;
  /** A check needed a `pattern`, which is never executed. */
  skippedPattern: boolean;
  /** The step budget ran out; the result is "unknown", not "valid". */
  exhausted: boolean;
  /** $ref targets currently being expanded, per value (cycle guard). */
  active: Map<unknown, Set<unknown>>;
}

export function validateContext(limit = 10_000): ValidateContext {
  return { steps: 0, limit, skippedPattern: false, exhausted: false, active: new Map() };
}

/**
 * First reason `value` fails `schema`, or null when it passes, when the
 * schema uses only keywords this checker does not evaluate, or when the
 * budget ran out (check `ctx.exhausted` / `ctx.skippedPattern`).
 */
export function validateValue(value: unknown, schema: unknown, root: unknown, ctx: ValidateContext = validateContext(), depth = 0): string | null {
  if (ctx.exhausted) return null;
  if (++ctx.steps > ctx.limit || depth > 32) {
    ctx.exhausted = true;
    return null;
  }
  if (schema === true || schema === undefined) return null;
  if (schema === false) return 'schema is `false`';
  if (!isObj(schema)) return null;
  if (typeof schema['$ref'] === 'string') {
    const target = resolveLocalRef(root, schema['$ref']);
    if (target !== undefined) {
      let seen = ctx.active.get(value);
      if (!seen) ctx.active.set(value, (seen = new Set()));
      if (!seen.has(target)) {
        seen.add(target);
        const r = validateValue(value, target, root, ctx, depth + 1);
        seen.delete(target);
        if (r) return r;
      }
    }
  }
  if (value === null && schema['nullable'] === true) return null;
  const t = schema['type'];
  if (t !== undefined) {
    const list = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string' && TYPES.has(x));
    if (list.length > 0 && !list.some((x) => typeMatches(value, x))) return `${short(value)} is not of type ${list.join('|')}`;
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].some((e) => deepEqual(e, value))) return `${short(value)} is not one of the enum values`;
  if (Object.hasOwn(schema, 'const') && !deepEqual(schema['const'], value)) return `${short(value)} is not the const ${short(schema['const'])}`;
  if (typeof value === 'number') {
    const n = (k: string): number | undefined => (typeof schema[k] === 'number' ? (schema[k] as number) : undefined);
    if (n('minimum') !== undefined && value < n('minimum')!) return `${value} is below minimum ${n('minimum')}`;
    if (n('maximum') !== undefined && value > n('maximum')!) return `${value} is above maximum ${n('maximum')}`;
    if (n('exclusiveMinimum') !== undefined && value <= n('exclusiveMinimum')!) return `${value} is not above exclusiveMinimum ${n('exclusiveMinimum')}`;
    if (n('exclusiveMaximum') !== undefined && value >= n('exclusiveMaximum')!) return `${value} is not below exclusiveMaximum ${n('exclusiveMaximum')}`;
  }
  if (typeof value === 'string') {
    const len = [...value].length;
    if (typeof schema['minLength'] === 'number' && len < schema['minLength']) return `string shorter than minLength ${schema['minLength']}`;
    if (typeof schema['maxLength'] === 'number' && len > schema['maxLength']) return `string longer than maxLength ${schema['maxLength']}`;
    if (typeof schema['pattern'] === 'string') ctx.skippedPattern = true;
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) return `array shorter than minItems ${schema['minItems']}`;
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) return `array longer than maxItems ${schema['maxItems']}`;
    const prefix = Array.isArray(schema['prefixItems']) ? schema['prefixItems'] : Array.isArray(schema['items']) ? schema['items'] : [];
    for (let i = 0; i < value.length; i++) {
      const s = i < prefix.length ? prefix[i] : isSchema(schema['items']) ? schema['items'] : undefined;
      const r = validateValue(value[i], s, root, ctx, depth + 1);
      if (r) return `[${i}]: ${r}`;
    }
  }
  if (isObj(value)) {
    const props = isObj(schema['properties']) ? schema['properties'] : {};
    if (Array.isArray(schema['required'])) {
      for (const k of schema['required']) if (typeof k === 'string' && !Object.hasOwn(value, k)) return `missing required property "${k.slice(0, 80)}"`;
    }
    for (const [k, v] of Object.entries(value)) {
      if (Object.hasOwn(props, k)) {
        const r = validateValue(v, props[k], root, ctx, depth + 1);
        if (r) return `.${k.slice(0, 80)}: ${r}`;
      } else if (schema['additionalProperties'] === false && !isObj(schema['patternProperties'])) {
        return `property "${k.slice(0, 80)}" is not allowed (additionalProperties: false)`;
      }
    }
  }
  if (Array.isArray(schema['allOf'])) {
    for (const s of schema['allOf']) {
      const r = validateValue(value, s, root, ctx, depth + 1);
      if (r) return r;
    }
  }
  for (const k of ['anyOf', 'oneOf']) {
    const branches = schema[k];
    // oneOf is checked as anyOf: "exactly one" is not something a default is likely to get wrong on purpose.
    if (Array.isArray(branches) && branches.length > 0) {
      let allFail = true;
      for (const b of branches) {
        if (validateValue(value, b, root, ctx, depth + 1) === null) {
          allFail = false;
          break;
        }
      }
      if (allFail && !ctx.exhausted) return `${short(value)} matches none of the ${k} branches`;
    }
  }
  return null;
}

function short(v: unknown): string {
  let s: string;
  try {
    s = JSON.stringify(v) ?? String(v);
  } catch {
    s = '<value>';
  }
  return s.length > 80 ? `${s.slice(0, 79)}…` : s;
}
