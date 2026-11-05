/**
 * JSON Schema traversal helpers shared by the findings rules.
 *
 * `schemaNodes` visits every object in a *schema position* (the root,
 * `properties/*`, `$defs/*`, `items`, `anyOf/*`, …) and never descends into
 * data positions (`default`, `examples`, `enum`, `const`), so a default value
 * shaped like `{ "type": … }` is not mistaken for a schema.
 */

import { setOwn } from './canonical.js';

export type PathSeg = string | number;
export type Path = readonly PathSeg[];
export type Obj = Record<string, unknown>;

const MAP_KEYS = new Set(['properties', '$defs', 'definitions', 'patternProperties', 'dependentSchemas']);
const LIST_KEYS = new Set(['anyOf', 'oneOf', 'allOf', 'prefixItems']);
const ONE_KEYS = new Set(['items', 'additionalProperties', 'not', 'contains', 'propertyNames', 'if', 'then', 'else']);

export function isObj(v: unknown): v is Obj {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Deepest level the walks descend to; anything below is reported, not analyzed. */
export const MAX_WALK_DEPTH = 64;

/** Deterministic work budget for one tool's analysis (wall-clock limits would break byte-identical reports). */
export class WorkBudget {
  spent = 0;
  constructor(readonly limit: number) {}
  spend(units: number): void {
    this.spent += units;
    if (this.spent > this.limit) throw new WorkBudgetExceeded(this.limit);
  }
}

export class WorkBudgetExceeded extends Error {
  constructor(readonly limit: number) {
    super(`analysis work budget of ${limit} units exceeded`);
    this.name = 'WorkBudgetExceeded';
  }
}

export interface WalkOptions {
  maxDepth?: number;
  work?: WorkBudget;
  /** Called once per node whose children were not visited because of maxDepth. */
  onTooDeep?: (path: Path) => void;
}

function schemaChildren(node: Obj, path: Path): [Path, unknown][] {
  const out: [Path, unknown][] = [];
  for (const [k, v] of Object.entries(node)) {
    if (MAP_KEYS.has(k) && isObj(v)) {
      for (const [pk, pv] of Object.entries(v)) out.push([[...path, k, pk], pv]);
    } else if (LIST_KEYS.has(k) && Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) out.push([[...path, k, i], v[i]]);
    } else if (ONE_KEYS.has(k)) {
      if (isObj(v)) out.push([[...path, k], v]);
      // draft-04..07 tuple form: `items: [schema, …]`
      else if (k === 'items' && Array.isArray(v)) for (let i = 0; i < v.length; i++) out.push([[...path, k, i], v[i]]);
    }
  }
  return out;
}

/** Iterative depth-first pre-order walk shared by the generators below. */
function* walk<T>(
  root: unknown,
  start: Path,
  accept: (n: unknown) => n is T,
  children: (n: T, p: Path) => [Path, unknown][],
  opts: WalkOptions,
): Generator<[Path, T]> {
  const maxDepth = opts.maxDepth ?? MAX_WALK_DEPTH;
  const stack: [Path, unknown, number][] = [[start, root, 0]];
  while (stack.length > 0) {
    const [p, n, depth] = stack.pop()!;
    if (!accept(n)) continue;
    opts.work?.spend(1);
    yield [p, n];
    const kids = children(n, p);
    if (kids.length === 0) continue;
    if (depth >= maxDepth) {
      opts.onTooDeep?.(p);
      continue;
    }
    for (let i = kids.length - 1; i >= 0; i--) stack.push([kids[i]![0], kids[i]![1], depth + 1]);
  }
}

/** Every object in a schema position, depth-first, keys in object order. */
export function schemaNodes(node: unknown, path: Path = [], opts: WalkOptions = {}): Generator<[Path, Obj]> {
  return walk(node, path, isObj, schemaChildren, opts);
}

function subtreeChildren(n: Obj | unknown[], p: Path): [Path, unknown][] {
  if (Array.isArray(n)) return n.map((v, i) => [[...p, i], v] as [Path, unknown]);
  return Object.entries(n).map(([k, v]) => [[...p, k], v] as [Path, unknown]);
}

/** Every object/array subtree (data positions included), depth-first. */
export function allSubtrees(node: unknown, path: Path = [], opts: WalkOptions = {}): Generator<[Path, Obj | unknown[]]> {
  return walk(node, path, (n): n is Obj | unknown[] => Array.isArray(n) || isObj(n), subtreeChildren, opts);
}

/** Every string value (keys excluded) with its path. */
export function* allStrings(node: unknown, path: Path = [], opts: WalkOptions = {}): Generator<[Path, string]> {
  if (typeof node === 'string') {
    yield [path, node];
    return;
  }
  for (const [p, n] of allSubtrees(node, path, opts)) {
    if (Array.isArray(n)) {
      for (let i = 0; i < n.length; i++) if (typeof n[i] === 'string') yield [[...p, i], n[i] as string];
    } else {
      for (const [k, v] of Object.entries(n)) if (typeof v === 'string') yield [[...p, k], v];
    }
  }
}

/** True when any object/array in `v` sits more than `max` levels down (iterative, stops early). */
export function exceedsDepth(v: unknown, max: number): boolean {
  const stack: [unknown, number][] = [[v, 0]];
  while (stack.length > 0) {
    const [n, d] = stack.pop()!;
    if (n === null || typeof n !== 'object') continue;
    if (d > max) return true;
    for (const c of Array.isArray(n) ? n : Object.values(n)) if (c !== null && typeof c === 'object') stack.push([c, d + 1]);
  }
  return false;
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
    let decoded: string;
    try {
      decoded = decodeURIComponent(raw);
    } catch {
      return undefined; // malformed percent-encoding: treat as unresolvable
    }
    const seg = decoded.replace(/~1/g, '/').replace(/~0/g, '~');
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
    else if (isObj(cur) && Object.hasOwn(cur, k as string)) cur = cur[k as string];
    else return undefined;
  }
  return cur;
}

export function setAt(root: unknown, path: Path, value: unknown): void {
  const parent = getAt(root, path.slice(0, -1));
  const last = path[path.length - 1]!;
  if (Array.isArray(parent)) parent[last as number] = value;
  else if (isObj(parent)) setOwn(parent, last as string, value);
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
