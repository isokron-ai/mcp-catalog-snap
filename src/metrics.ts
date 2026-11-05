/**
 * Per-tool size metrics and contract fingerprints.
 *
 * What is measured for a `tools/list` entry:
 *   - `total`: the compact RFC 8785 (JCS) serialization of the whole entry,
 *     i.e. exactly the bytes `fingerprint` hashes. Clients re-serialize tool
 *     definitions in their own way, so this is a stable reference text, not
 *     the literal prompt bytes of any one client.
 *   - per field: `name`, `title`, `description` as their raw string value;
 *     `inputSchema`, `outputSchema`, `annotations` as compact JCS.
 *
 * Fingerprints:
 *   - `fingerprint`: sha256 of JCS(entry). Any change to the tool, including
 *     wording, changes it.
 *   - `inputSchemaFingerprint`: sha256 of JCS(inputSchema), so a wording-only
 *     change is distinguishable from a contract change.
 *   - the catalog fingerprint stays the v0.1 snapshot `sha256`
 *     (`fingerprint(catalog)` over sorted tools/prompts/resourceTemplates).
 *   - `orderedToolsFingerprint`: sha256 of JCS(tools array in server order).
 *     This is the IsoKron ADR-0005 `hashMcpToolDefinitions` scheme (deep key
 *     sort, array order preserved, no whitespace), so the two agree on the
 *     same `tools/list` array.
 */

import { canonicalJson, fingerprint } from './canonical.js';
import type { CatalogTool } from './snapshot.js';
import { utf8Bytes, type Tokenizer } from './tokenize.js';

/** Bytes plus a token count per tokenizer id. */
export interface Measure {
  bytes: number;
  tokens: Record<string, number>;
}

export const TOOL_FIELDS = ['name', 'title', 'description', 'inputSchema', 'outputSchema', 'annotations'] as const;
export type ToolField = (typeof TOOL_FIELDS)[number];

export interface ToolMetrics {
  name: string;
  fingerprint: string;
  inputSchemaFingerprint: string | null;
  /** JCS of the whole entry. */
  total: Measure;
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

export function measureTool(tool: CatalogTool, tokenizers: readonly Tokenizer[]): ToolMetrics {
  const fields: Partial<Record<ToolField, Measure>> = {};
  for (const f of TOOL_FIELDS) {
    const v = tool[f];
    if (v !== undefined) fields[f] = measure(fieldText(v), tokenizers);
  }
  return {
    name: tool.name,
    fingerprint: fingerprint(tool),
    inputSchemaFingerprint: tool.inputSchema === undefined ? null : fingerprint(tool.inputSchema),
    total: measure(canonicalJson(tool), tokenizers),
    fields,
  };
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
