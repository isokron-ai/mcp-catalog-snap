/**
 * JSON Schema traversal helpers shared by the findings rules.
 *
 * `schemaNodes` visits every object in a *schema position* (the root,
 * `properties/*`, `$defs/*`, `items`, `anyOf/*`, …) and never descends into
 * data positions (`default`, `examples`, `enum`, `const`), so a default value
 * shaped like `{ "type": … }` is not mistaken for a schema.
 */

export type PathSeg = string | number;
export type Path = readonly PathSeg[];
export type Obj = Record<string, unknown>;

const MAP_KEYS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const ONE_KEYS = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else']);

export function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Every object in a schema position, depth-first, keys in object order. */
export function* schemaNodes(node: unknown, path: Path = []): Generator<[Path, Obj]> {
  if (!isObj(node)) return;
  yield [path, node];
  for (const [k, v] of Object.entries(node)) {
    if (MAP_KEYS.has(k) && isObj(v)) {
      for (const [pk, pv] of Object.entries(v)) yield* schemaNodes(pv, [...path, k, pk]);
    } else if (LIST_KEYS.has(k) && Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) yield* schemaNodes(v[i], [...path, k, i]);
    } else if (ONE_KEYS.has(k)) {
      if (isObj(v)) yield* schemaNodes(v, [...path, k]);
      // draft-04..07 tuple form: `items: [schema, …]`
      else if (k === 'items' && Array.isArray(v)) for (let i = 0; i < v.length; i++) yield* schemaNodes(v[i], [...path, k, i]);
    }
  }
}

/** Every object/array subtree (data positions included), depth-first. */
export function* allSubtrees(node: unknown, path: Path = []): Generator<[Path, Obj | unknown[]]> {
  if (Array.isArray(node)) {
    yield [path, node];
    for (let i = 0; i < node.length; i++) yield* allSubtrees(node[i], [...path, i]);
  } else if (isObj(node)) {
    yield [path, node];
    for (const [k, v] of Object.entries(node)) yield* allSubtrees(v, [...path, k]);
  }
}

/** Every string value (keys excluded) with its path. */
export function* allStrings(node: unknown, path: Path = []): Generator<[Path, string]> {
  if (typeof node === 'string') yield [path, node];
  else if (Array.isArray(node)) for (let i = 0; i < node.length; i++) yield* allStrings(node[i], [...path, i]);
  else if (isObj(node)) for (const [k, v] of Object.entries(node)) yield* allStrings(v, [...path, k]);
}

/** RFC 6901 JSON Pointer. */
export function pointer(path: Path): string {
  return path.map((s) => `/${String(s).replace(/~/g, '~0').replace(/\//g, '~1')}`).join('');
}

/** Resolve a local `#/…` reference against `root`; undefined when it does not resolve. */
export function resolveLocalRef(root: unknown, ref: string): unknown {
  if (ref === '#') return root;
  if (!ref.startsWith('#/')) return undefined;
  let cur: unknown = root;
  for (const raw of ref.slice(2).split('/')) {
    const seg = decodeURIComponent(raw).replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(cur)) cur = cur[Number(seg)];
    else if (isObj(cur)) cur = Object.prototype.hasOwnProperty.call(cur, seg) ? cur[seg] : undefined;
    else return undefined;
    if (cur === undefined) return undefined;
  }
  return cur;
}

export function getAt(root: unknown, path: Path): unknown {
  let cur: unknown = root;
  for (const k of path) {
    if (Array.isArray(cur)) cur = cur[k as number];
    else if (isObj(cur)) cur = cur[k as string];
    else return undefined;
  }
  return cur;
}

export function setAt(root: unknown, path: Path, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (Array.isArray(parent)) parent[last as number] = value;
  else if (isObj(parent)) parent[last as string] = value;
}

/**
 * A set of paths answering "is some member a prefix of p?" and "is p a
 * prefix of some member?" in O(depth) instead of a scan over members.
 */
export class PathSet {
  private readonly members = new Set<string>();
  private readonly ancestors = new Set<string>();

  add(p: Path): void {
    this.members.add(JSON.stringify(p));
    for (let i = 0; i < p.length; i++) this.ancestors.add(JSON.stringify(p.slice(0, i)));
  }

  /** Some member equals p or is an ancestor of p. */
  covers(p: Path): boolean {
    for (let i = 1; i <= p.length; i++) if (this.members.has(JSON.stringify(p.slice(0, i)))) return true;
    return false;
  }

  /** p equals or is an ancestor of some member. */
  containsUnder(p: Path): boolean {
    const k = JSON.stringify(p);
    return this.members.has(k) || this.ancestors.has(k);
  }
}

/** `a` is a (non-strict) prefix of `b`. */
export function isPrefix(a: Path, b: Path): boolean {
  if (a.length > b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
