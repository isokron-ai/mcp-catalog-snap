/**
 * Structural diff between two catalogs.
 *
 * The diff is computed on the canonical (key-sorted) catalog, per section
 * (tools / prompts / resourceTemplates), keyed by tool/prompt name or
 * resource uriTemplate. Changed entries carry leaf-level path changes as
 * RFC 6901 JSON Pointers relative to the entry
 * (`/inputSchema/properties/slug/description`).
 *
 * A path is *descriptive* when its last segment is `description` — top-level
 * tool descriptions and nested JSON-Schema property descriptions alike.
 * Those still change the bytes (and so the prompt-cache prefix) but do not
 * change what the model is *allowed* to send, so they are flagged separately
 * and can be waived with `ignoreDescriptions`.
 */

import { canonicalJson, fingerprint, type JsonValue } from './canonical.js';
import type { Catalog } from './snapshot.js';

export type Section = 'tools' | 'prompts' | 'resourceTemplates';
export const SECTIONS: readonly Section[] = ['tools', 'prompts', 'resourceTemplates'];

export interface PathChange {
  /** JSON Pointer relative to the entry, e.g. `/inputSchema/required/1`. */
  path: string;
  before: JsonValue | undefined;
  after: JsonValue | undefined;
  /** Last path segment is `description`. */
  descriptive: boolean;
}

export interface ChangedEntry {
  key: string;
  changes: PathChange[];
  /** Every change in this entry is descriptive. */
  descriptionOnly: boolean;
}

export interface SectionDiff {
  section: Section;
  added: string[];
  removed: string[];
  changed: ChangedEntry[];
}

export interface CatalogDiff {
  /** Canonical bytes identical. */
  identical: boolean;
  fingerprint: { before: string; after: string };
  counts: { before: Record<Section, number>; after: Record<Section, number> };
  sections: SectionDiff[];
}

export interface DriftPolicy {
  /** Do not count description-only changes (top-level or nested) as drift. */
  ignoreDescriptions?: boolean;
  /**
   * Do not count added tools/prompts/templates as drift: entries the live
   * server lists that the snapshot does not, *where the snapshot's section is
   * a real baseline*. When the snapshot lists no entries at all in a section
   * and the live server lists some, nothing in that section was ever checked,
   * so those additions are not waived (an emptied snapshot must not pass).
   */
  allowAdditions?: boolean;
}

export interface Verdict {
  /** True when, under the policy, the catalog has drifted. */
  drift: boolean;
  /** Human-readable reasons (empty when no drift). */
  reasons: string[];
  /** Changes present but waived by policy. */
  waived: string[];
}

function escapePointer(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

function isObject(v: JsonValue | undefined): v is { [key: string]: JsonValue } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Leaf-level diff of two JSON values. */
/** Below this many path segments a change is reported at the subtree, not walked further. */
export const MAX_DIFF_DEPTH = 256;

function deepMarker(v: JsonValue | undefined): JsonValue | undefined {
  return v === undefined ? undefined : `<subtree too deep to show; sha256 ${fingerprint(v)}>`;
}

/**
 * Leaf-level changes between two JSON values, as RFC 6901 paths. Iterative
 * (untrusted catalogs can nest arbitrarily deep); keys are read as own
 * properties only, so `constructor` / `__proto__` are compared as data.
 */
export function diffValues(before: JsonValue | undefined, after: JsonValue | undefined, prefix = ''): PathChange[] {
  const out: PathChange[] = [];
  const own = (o: { [k: string]: JsonValue }, k: string): JsonValue | undefined => (Object.hasOwn(o, k) ? o[k] : undefined);
  const stack: [JsonValue | undefined, JsonValue | undefined, string, number][] = [[before, after, prefix, 0]];
  while (stack.length > 0) {
    const [b, a, p, depth] = stack.pop()!;
    if (b === a) continue;
    if (depth < MAX_DIFF_DEPTH && isObject(b) && isObject(a)) {
      const keys = [...new Set([...Object.keys(b), ...Object.keys(a)])].sort();
      for (let i = keys.length - 1; i >= 0; i--) stack.push([own(b, keys[i]!), own(a, keys[i]!), `${p}/${escapePointer(keys[i]!)}`, depth + 1]);
      continue;
    }
    if (depth < MAX_DIFF_DEPTH && Array.isArray(b) && Array.isArray(a)) {
      const n = Math.max(b.length, a.length);
      for (let i = n - 1; i >= 0; i--) stack.push([b[i], a[i], `${p}/${i}`, depth + 1]);
      continue;
    }
    if (b !== undefined && a !== undefined && canonicalJson(b) === canonicalJson(a)) continue;
    const last = p.slice(p.lastIndexOf('/') + 1);
    const tooDeep = depth >= MAX_DIFF_DEPTH;
    out.push({ path: p === '' ? '/' : p, before: tooDeep ? deepMarker(b) : b, after: tooDeep ? deepMarker(a) : a, descriptive: last === 'description' });
  }
  return out;
}

const KEY_OF: Record<Section, string> = {
  tools: 'name',
  prompts: 'name',
  resourceTemplates: 'uriTemplate',
};

function indexSection(catalog: Catalog, section: Section): Map<string, JsonValue> {
  const m = new Map<string, JsonValue>();
  const key = KEY_OF[section];
  for (const entry of catalog[section] as unknown as Array<Record<string, JsonValue>>) {
    m.set(String(entry[key]), entry as JsonValue);
  }
  return m;
}

export function diffSection(before: Catalog, after: Catalog, section: Section): SectionDiff {
  const a = indexSection(before, section);
  const b = indexSection(after, section);
  const added = [...b.keys()].filter((k) => !a.has(k)).sort();
  const removed = [...a.keys()].filter((k) => !b.has(k)).sort();
  const changed: ChangedEntry[] = [];
  for (const k of [...a.keys()].sort()) {
    if (!b.has(k)) continue;
    const changes = diffValues(a.get(k), b.get(k));
    if (changes.length === 0) continue;
    changed.push({ key: k, changes, descriptionOnly: changes.every((c) => c.descriptive) });
  }
  return { section, added, removed, changed };
}

export function diffCatalogs(before: Catalog, after: Catalog): CatalogDiff {
  const fb = fingerprint(before);
  const fa = fingerprint(after);
  return {
    identical: fb === fa,
    fingerprint: { before: fb, after: fa },
    counts: {
      before: { tools: before.tools.length, prompts: before.prompts.length, resourceTemplates: before.resourceTemplates.length },
      after: { tools: after.tools.length, prompts: after.prompts.length, resourceTemplates: after.resourceTemplates.length },
    },
    sections: SECTIONS.map((s) => diffSection(before, after, s)),
  };
}

const SINGULAR: Record<Section, string> = {
  tools: 'tool',
  prompts: 'prompt',
  resourceTemplates: 'resource template',
};

const PLURAL: Record<Section, string> = {
  tools: 'tools',
  prompts: 'prompts',
  resourceTemplates: 'resource templates',
};

/** Apply a drift policy to a diff. */
export function evaluate(diff: CatalogDiff, policy: DriftPolicy = {}): Verdict {
  const reasons: string[] = [];
  const waived: string[] = [];
  for (const s of diff.sections) {
    const noun = SINGULAR[s.section];
    for (const k of s.removed) reasons.push(`${noun} removed: ${k}`);
    // An addition is a live entry beyond a baseline the snapshot actually
    // holds. A snapshot section with zero entries is no baseline: waiving
    // there would let a snapshot whose entries were deleted pass `check`.
    const baseline = diff.counts.before[s.section] > 0;
    const waiveAdditions = policy.allowAdditions === true && baseline;
    if (policy.allowAdditions === true && !baseline && s.added.length > 0) {
      reasons.push(
        `${PLURAL[s.section]}: snapshot lists none, live server lists ${diff.counts.after[s.section]} — ` +
          '--allow-additions waives additions only against a non-empty baseline; re-snapshot if this is intended',
      );
    }
    for (const k of s.added) {
      (waiveAdditions ? waived : reasons).push(`${noun} added: ${k}`);
    }
    for (const c of s.changed) {
      const structural = c.changes.filter((x) => !x.descriptive);
      const descriptive = c.changes.filter((x) => x.descriptive);
      if (structural.length > 0) {
        reasons.push(`${noun} changed: ${c.key} (${structural.map((x) => x.path).join(', ')})`);
      }
      if (descriptive.length > 0) {
        const msg = `${noun} description changed: ${c.key} (${descriptive.map((x) => x.path).join(', ')})`;
        (policy.ignoreDescriptions ? waived : reasons).push(msg);
      }
    }
  }
  return { drift: reasons.length > 0, reasons, waived };
}
