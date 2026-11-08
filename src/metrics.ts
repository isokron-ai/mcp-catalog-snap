/**
 * Per-tool size metrics and contract fingerprints.
 *
 * What is measured for a `tools/list` entry:
 *   - `wire` (`total`): the compact RFC 8785 (JCS) serialization of the whole
 *     entry, i.e. exactly the bytes `fingerprint` hashes, icons and `_meta`
 *     included. This is what crosses the wire, not what the model reads.
 *   - `modelVisible`: JCS of only the fields clients pass to the model:
 *     `name`, `description`, `inputSchema` (and `annotations` when asked).
 *     `title` is a display name and is not counted. Clients re-serialize tool definitions in their own way, so
 *     both are stable reference texts, not the literal prompt bytes of any
 *     one client.
 *   - per field: `name`, `title`, `description` as their raw string value;
 *     `inputSchema`, `outputSchema`, `annotations`, `icons`, `_meta` as
 *     compact JCS; `other` = JCS of every remaining field together.
 *
 * Fingerprints (per tool):
 *   - `fingerprint`: the *contract* fingerprint, sha256 of
 *     JCS({ inputSchema, outputSchema }) (absent members omitted). Wording
 *     edits do not move it, so rule packs pinned to it survive them.
 *   - `descriptionFingerprint`: sha256 of JCS(description ?? null), so a
 *     wording edit shows up as description drift on its own.
 *   - `entryFingerprint`: sha256 of JCS(entry), every field included.
 *   - the catalog fingerprint stays the v0.1 snapshot `sha256`
 *     (`fingerprint(catalog)` over sorted tools/prompts/resourceTemplates).
 *   - `orderedToolsFingerprint`: sha256 of JCS(tools array in server order).
 *     This is the IsoKron ADR-0005 `hashMcpToolDefinitions` scheme (deep key
 *     sort, array order preserved, no whitespace), so the two agree on the
 *     same `tools/list` array.
 */

import { canonicalJson, fingerprint, setOwn } from './canonical.js';
import type { CatalogTool } from './snapshot.js';
import { utf8Bytes, type Tokenizer } from './tokenize.js';

/** Bytes plus a token count per tokenizer id. */
export interface Measure {
  bytes: number;
  tokens: Record<string, number>;
}

/** Named fields of a tools/list entry; `other` is every remaining field, measured together. */
export const TOOL_FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations', 'icons', '_meta', 'other'] as const;
export type ToolField = (typeof TOOL_FIELDS)[number];

/** Fields counted as model-visible: what clients pass to the model (Anthropic: name, description, input_schema). `title` is a display name. */
export const MODEL_VISIBLE_FIELDS = ['name', 'description', 'inputSchema'] as const;
/** `annotations` are client hints (permissions, UI); counted as model-visible only on request. */
export const MODEL_VISIBLE_FIELDS_WITH_ANNOTATIONS = [...MODEL_VISIBLE_FIELDS, 'annotations'] as const;

/** JCS of the model-visible projection of a tools/list entry. */
export function modelVisibleText(tool: CatalogTool, withAnnotations = false): string {
  const o: Record<string, unknown> = {};
  for (const f of withAnnotations ? MODEL_VISIBLE_FIELDS_WITH_ANNOTATIONS : MODEL_VISIBLE_FIELDS) {
    if (Object.hasOwn(tool, f) && tool[f] !== undefined) setOwn(o, f, tool[f]);
  }
  return canonicalJson(o);
}

export interface ToolMetrics {
  name: string;
  /** sha256 of JCS({ inputSchema, outputSchema }). */
  fingerprint: string;
  /** sha256 of JCS(description ?? null). */
  descriptionFingerprint: string;
  /** sha256 of JCS(whole entry). */
  entryFingerprint: string;
  /** JCS of the whole entry (wire). */
  total: Measure;
  /** JCS of the model-visible projection. */
  modelVisible: Measure;
  /** Only fields present on the entry. */
  fields: Partial<Record<ToolField, Measure>>;
}

export function measure(text: string, tokenizers: readonly Tokenizer[]): Measure {
  const tokens: Record<string, number> = {};
  for (const t of tokenizers) tokens[t.id] = t.count(text);
  return { bytes: utf8Bytes(text), tokens };
}

/** Sum measures key by key (tokenizer ids missing on one side count as 0). */
export function addMeasures(a: Measure, b: Measure): Measure {
  const tokens: Record<string, number> = { ...a.tokens };
  for (const [k, v] of Object.entries(b.tokens)) tokens[k] = (tokens[k] ?? 0) + v;
  return { bytes: a.bytes + b.bytes, tokens };
}

export function emptyMeasure(tokenizers: readonly Tokenizer[]): Measure {
  const tokens: Record<string, number> = {};
  for (const t of tokenizers) tokens[t.id] = 0;
  return { bytes: 0, tokens };
}

function fieldText(value: unknown): string {
  return typeof value === 'string' ? value : canonicalJson(value);
}

export function measureTool(tool: CatalogTool, tokenizers: readonly Tokenizer[], opts: { modelVisibleAnnotations?: boolean } = {}): ToolMetrics {
  const fields: Partial<Record<ToolField, Measure>> = {};
  // a field literally named `other` is not a named field: it is measured with the rest
  const named = new Set<string>(TOOL_FIELDS.filter((f) => f !== 'other'));
  for (const f of TOOL_FIELDS) {
    if (f === 'other') continue;
    const v = Object.hasOwn(tool, f) ? tool[f] : undefined;
    if (v !== undefined) fields[f] = measure(fieldText(v), tokenizers);
  }
  const rest: Record<string, unknown> = {};
  let restCount = 0;
  for (const k of Object.keys(tool)) {
    if (named.has(k) || tool[k] === undefined) continue;
    setOwn(rest, k, tool[k]);
    restCount++;
  }
  if (restCount > 0) fields.other = measure(canonicalJson(rest), tokenizers);
  return {
    name: tool.name,
    fingerprint: contractFingerprint(tool),
    descriptionFingerprint: fingerprint(tool.description ?? null),
    entryFingerprint: fingerprint(tool),
    total: measure(canonicalJson(tool), tokenizers),
    modelVisible: measure(modelVisibleText(tool, opts.modelVisibleAnnotations ?? false), tokenizers),
    fields,
  };
}

/** sha256 of JCS({ inputSchema, outputSchema }), absent members omitted. */
export function contractFingerprint(tool: Pick<CatalogTool, 'inputSchema' | 'outputSchema'>): string {
  const c: Record<string, unknown> = {};
  if (tool.inputSchema !== undefined) c['inputSchema'] = tool.inputSchema;
  if (tool.outputSchema !== undefined) c['outputSchema'] = tool.outputSchema;
  return fingerprint(c);
}

/** ADR-0005-compatible fingerprint: JCS over the tools array in the order the server listed them. */
export function orderedToolsFingerprint(tools: readonly unknown[]): string {
  return fingerprint(tools);
}

/** Nearest-rank percentile of a numeric list (p in 0..100). Empty → 0. */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1]!;
}

export interface Distribution {
  sum: number;
  median: number;
  p90: number;
  max: number;
}

export function distribution(values: readonly number[]): Distribution {
  return {
    sum: values.reduce((a, b) => a + b, 0),
    median: percentile(values, 50),
    p90: percentile(values, 90),
    max: values.reduce((a, b) => Math.max(a, b), 0),
  };
}

/** Fixed histogram buckets: `[lo, hi]` inclusive, last bucket open-ended. */
export function histogram(values: readonly number[], edges: readonly number[]): Record<string, number> {
  const out: Record<string, number> = {};
  const labels: string[] = [];
  let lo = 0;
  for (const hi of edges) {
    labels.push(`${lo}-${hi}`);
    lo = hi + 1;
  }
  labels.push(`${lo}+`);
  for (const l of labels) out[l] = 0;
  for (const v of values) {
    let i = edges.findIndex((hi) => v <= hi);
    if (i < 0) i = edges.length;
    out[labels[i]!]!++;
  }
  return out;
}
