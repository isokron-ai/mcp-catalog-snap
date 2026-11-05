/**
 * Small, conservative JSON Schema checks with no runtime dependency.
 *
 * `keywordProblems` checks that the keywords a node uses have the shape
 * the spec requires (`type` names a real type, `required` is a string
 * array, `pattern` compiles, …). `validateValue` checks a value (a
 * `default`) against a schema for the common keywords only; anything it
 * does not understand passes, so it reports definite failures, never
 * guesses.
 */

import { isObj, resolveLocalRef, type Obj } from './schema-walk.js';

const TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const NUM_KEYS = ['minimum', 'maximum', 'multipleOf'];
const NONNEG_INT_KEYS = ['minLength', 'maxLength', 'minItems', 'maxItems', 'minProperties', 'maxProperties'];

function isSchema(v: unknown): boolean {
  return isObj(v) || typeof v === 'boolean';
}

function compiles(pattern: string): boolean {
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
    else if (ref.startsWith('#') && resolveLocalRef(root, ref) === undefined) out.push(`\`$ref\` ${JSON.stringify(ref)} does not resolve`);
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

/**
 * Patterns come from untrusted schemas and JS regexes cannot be time-boxed,
 * so a default is only tested against a short pattern with no nested
 * quantifier (`(a+)+`, `(\\w*)*`, …), on a short value. Anything else is
 * skipped, not reported.
 */
export function safeToRun(pattern: string, value: string): boolean {
  if (pattern.length > 512 || value.length > 1024) return false;
  return !/\((?:[^()\\]|\\.)*[+*}](?:[^()\\]|\\.)*\)\s*[+*{]/.test(pattern) && !/\\[1-9]/.test(pattern);
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
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (isObj(a) && isObj(b)) {
    const ka = Object.keys(a);
    return ka.length === Object.keys(b).length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]));
  }
  return false;
}

/**
 * First reason `value` fails `schema`, or null when it passes (or when the
 * schema uses only keywords this checker does not evaluate).
 */
export function validateValue(value: unknown, schema: unknown, root: unknown, depth = 0): string | null {
  if (depth > 32 || schema === true || schema === undefined) return null;
  if (schema === false) return 'schema is `false`';
  if (!isObj(schema)) return null;
  if (typeof schema['$ref'] === 'string') {
    const target = resolveLocalRef(root, schema['$ref']);
    const r = target === undefined ? null : validateValue(value, target, root, depth + 1);
    if (r) return r;
  }
  if (value === null && schema['nullable'] === true) return null;
  const t = schema['type'];
  if (t !== undefined) {
    const list = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string' && TYPES.has(x));
    if (list.length > 0 && !list.some((x) => typeMatches(value, x))) return `${JSON.stringify(value)} is not of type ${list.join('|')}`;
  }
  if (Array.isArray(schema['enum']) && !schema['enum'].some((e) => deepEqual(e, value))) return `${JSON.stringify(value)} is not one of the enum values`;
  if ('const' in schema && !deepEqual(schema['const'], value)) return `${JSON.stringify(value)} is not the const ${JSON.stringify(schema['const'])}`;
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
    if (typeof schema['pattern'] === 'string' && safeToRun(schema['pattern'], value) && compiles(schema['pattern'])) {
      let re: RegExp;
      try {
        re = new RegExp(schema['pattern'], 'u');
      } catch {
        re = new RegExp(schema['pattern']);
      }
      if (!re.test(value)) return `${JSON.stringify(value)} does not match pattern ${JSON.stringify(schema['pattern'])}`;
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema['minItems'] === 'number' && value.length < schema['minItems']) return `array shorter than minItems ${schema['minItems']}`;
    if (typeof schema['maxItems'] === 'number' && value.length > schema['maxItems']) return `array longer than maxItems ${schema['maxItems']}`;
    const prefix = Array.isArray(schema['prefixItems']) ? schema['prefixItems'] : Array.isArray(schema['items']) ? schema['items'] : [];
    for (let i = 0; i < value.length; i++) {
      const s = i < prefix.length ? prefix[i] : isSchema(schema['items']) ? schema['items'] : undefined;
      const r = validateValue(value[i], s, root, depth + 1);
      if (r) return `[${i}]: ${r}`;
    }
  }
  if (isObj(value)) {
    const props = isObj(schema['properties']) ? schema['properties'] : {};
    if (Array.isArray(schema['required'])) {
      for (const k of schema['required']) if (typeof k === 'string' && !(k in value)) return `missing required property "${k}"`;
    }
    for (const [k, v] of Object.entries(value)) {
      if (k in props) {
        const r = validateValue(v, props[k], root, depth + 1);
        if (r) return `.${k}: ${r}`;
      } else if (schema['additionalProperties'] === false && !isObj(schema['patternProperties'])) {
        return `property "${k}" is not allowed (additionalProperties: false)`;
      }
    }
  }
  if (Array.isArray(schema['allOf'])) {
    for (const s of schema['allOf']) {
      const r = validateValue(value, s, root, depth + 1);
      if (r) return r;
    }
  }
  for (const k of ['anyOf', 'oneOf']) {
    const branches = schema[k];
    // oneOf is checked as anyOf: "exactly one" is not something a default is likely to get wrong on purpose.
    if (Array.isArray(branches) && branches.length > 0 && branches.every((b) => validateValue(value, b, root, depth + 1) !== null)) {
      return `${JSON.stringify(value)} matches none of the ${k} branches`;
    }
  }
  return null;
}
