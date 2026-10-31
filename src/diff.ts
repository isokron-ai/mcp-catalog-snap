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
  /** Do not count added tools/prompts/templates as drift. */
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
export function diffValues(before: JsonValue | undefined, after: JsonValue | undefined, prefix = ''): PathChange[] {
  if (before === after) return [];
  if (isObject(before) && isObject(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    const out: PathChange[] = [];
    for (const k of keys) out.push(...diffValues(before[k], after[k], `${prefix}/${escapePointer(k)}`));
    return out;
  }
  if (Array.isArray(before) && Array.isArray(after)) {
    const n = Math.max(before.length, after.length);
    const out: PathChange[] = [];
    for (let i = 0; i < n; i++) out.push(...diffValues(before[i], after[i], `${prefix}/${i}`));
    return out;
  }
  if (before !== undefined && after !== undefined && canonicalJson(before) === canonicalJson(after)) return [];
  const last = prefix.slice(prefix.lastIndexOf('/') + 1);
  return [{ path: prefix === '' ? '/' : prefix, before, after, descriptive: last === 'description' }];
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

/** Apply a drift policy to a diff. */
export function evaluate(diff: CatalogDiff, policy: DriftPolicy = {}): Verdict {
  const reasons: string[] = [];
  const waived: string[] = [];
  for (const s of diff.sections) {
    const noun = SINGULAR[s.section];
    for (const k of s.removed) reasons.push(`${noun} removed: ${k}`);
    for (const k of s.added) {
      (policy.allowAdditions ? waived : reasons).push(`${noun} added: ${k}`);
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
