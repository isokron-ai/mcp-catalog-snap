/**
 * The static sweep: SweepInput (from an adapter) → versioned JSON report.
 *
 * Deterministic by construction: no clock, no environment, tools sorted by
 * name, findings sorted by (tool, rule, path, message), objects built in a
 * fixed key order. The same input yields byte-identical `serializeReport`
 * output.
 *
 * Two measures per tool, never mixed:
 *   - `wire`: what crosses the wire, the canonical JSON of the whole
 *     tools/list entry (icons, `_meta`, `outputSchema` included).
 *   - `modelVisible`: what the model reads, the canonical JSON of only the
 *     fields clients pass to it (`name`, `description`, `inputSchema`;
 *     `annotations` only with `modelVisibleAnnotations`).
 * Budgets, histograms and rankings use `modelVisible`.
 *
 * Every figure is catalog-wide: each tool counted once, as if the whole
 * catalog were loaded. It is not session exposure (what one client loaded)
 * nor task exposure (what an agent pulled), and the report says so.
 */

import type { SweepInput } from './adapters/types.js';
import type { AnthropicCounts } from './anthropic.js';
import type { Handshake } from './capture.js';
import { canonicalJson, fingerprint, type JsonValue } from './canonical.js';
import {
  CHOICE_LIST_EDGES,
  analyzeCallResult,
  analyzeTool,
  compareFindings,
  iconFindings,
  oversizeFinding,
  summarizeFindings,
  type Finding,
  type FindingsOptions,
  type RuleId,
  type RuleSummary,
} from './findings.js';
import {
  MODEL_VISIBLE_FIELDS,
  MODEL_VISIBLE_FIELDS_WITH_ANNOTATIONS,
  TOOL_FIELDS,
  addMeasures,
  distribution,
  emptyMeasure,
  histogram,
  measure,
  measureTool,
  orderedToolsFingerprint,
  type Distribution,
  type Measure,
  type ToolField,
} from './metrics.js';
import { isObj } from './schema-walk.js';
import { REFERENCE_TOKENIZER, type Tokenizer } from './tokenize.js';
import { jsonSafe } from './safe-text.js';
import { VERSION } from './version.js';

export const REPORT_FORMAT = 'mcp-catalog-snap/sweep/1';
export const DEFAULT_ADVISORY_TOOL_TOKENS = 5_000;
export const MODEL_VISIBLE_EDGES = [100, 500, 1_000, 2_000, 5_000, 10_000] as const;

export interface SweepOptions {
  tokenizers: readonly Tokenizer[];
  /** Tokenizer id budgets and histograms use (default cl100k, else the first). */
  budgetTokenizer?: string;
  /** Explicit budgets: exceeding one makes the sweep fail (CLI exit 4). */
  budgets?: { toolTokens?: number; catalogTokens?: number };
  /** Per-tool size that earns an advisory `oversize-tool` finding when no explicit budget is set. */
  advisoryToolTokens?: number;
  findings?: Omit<FindingsOptions, 'tokenizer'>;
  /** Count `annotations` as model-visible (default false: they are client hints, not prompt text). */
  modelVisibleAnnotations?: boolean;
  /** Provider counts gathered beforehand, or why they were skipped. */
  anthropic?: AnthropicCounts | { skipped: string };
  /** Observed tools/call results, for structuredContent duplication. */
  callResults?: readonly { tool: string; result: unknown }[];
}

export interface ToolReport {
  name: string;
  fingerprint: string;
  descriptionFingerprint: string;
  entryFingerprint: string;
  /** Canonical JSON of the whole tools/list entry. */
  wire: Measure;
  /** Canonical JSON of the model-visible fields; budgets apply to this. */
  modelVisible: Measure;
  fields: Partial<Record<ToolField, Measure>>;
  views: Record<string, Measure>;
  anthropicTokens: number | null;
  annotations: { readOnlyHint: JsonValue; destructiveHint: JsonValue; idempotentHint: JsonValue; openWorldHint: JsonValue };
  choiceLists: { count: number; largest: number; over: number };
  duplicates: { wasteBytes: number; share: number; defsBytesAfter: number };
  untyped: { noTypeNodes: number; emptyItems: number; opaqueObjects: number };
  findings: number;
}

export interface SweepReport {
  format: typeof REPORT_FORMAT;
  generator: string;
  adapter: string;
  server: SweepInput['server'];
  protocolVersion: string | null;
  /** The initialize handshake as sent and answered (null for offline inputs that do not carry it). */
  handshake: Handshake | null;
  source: SweepInput['source'];
  measurement: {
    scope: string;
    wire: string;
    modelVisible: string;
    /** Fields counted as model-visible; null when the adapter supplies the model-visible text (exec). */
    modelVisibleFields: string[] | null;
    budgetsApplyTo: 'modelVisible';
    /** Why `totals.modelVisibleFieldSum` differs from `totals.modelVisible`. */
    modelVisibleFieldSum: string;
    tokenizers: { id: string; label: string }[];
    budgetTokenizer: string;
  };
  fingerprints: { catalog: string; toolsOrdered: string | null };
  totals: {
    tools: number;
    prompts: number;
    resourceTemplates: number;
    wire: Measure;
    modelVisible: Measure;
    /** Model-visible tokens per tool, in the budget tokenizer. */
    modelVisiblePerTool: Distribution;
    /** The model-visible fields' per-field measures summed (each field tokenized on its own); differs from `modelVisible`, see measurement.modelVisibleFieldSum. */
    modelVisibleFieldSum: Measure;
    fields: Partial<Record<ToolField, Measure>>;
    views: Record<string, Measure>;
    embeddedSchema: { tools: number; escaped: Measure; plain: Measure } | null;
    wrapper: { tools: string[]; wire: Measure } | null;
  };
  histograms: { modelVisibleTokens: Record<string, number>; choiceListSizes: Record<string, number> };
  budget: {
    tokenizer: string;
    toolTokens: number | null;
    catalogTokens: number | null;
    advisoryToolTokens: number;
    exceeded: boolean;
    toolsOver: string[];
    catalogOver: boolean;
  };
  anthropic: { model: string; baseline: number; catalog: number | null; errors: number } | { skipped: string } | null;
  findingsSummary: Partial<Record<RuleId, RuleSummary>>;
  tools: ToolReport[];
  findings: Finding[];
  notes: string[];
}

const SCOPE =
  'catalog-wide: every tool counted once, as if the full catalog were loaded. Not session exposure (what a client loaded) or task exposure (what an agent pulled).';

const FIELD_SUM_NOTE =
  'modelVisible tokenizes one object per tool (keys, quotes and JSON escaping of the description included, merges across field boundaries); modelVisibleFieldSum adds each field on its own (name and description as raw text, schemas as JSON). Budgets use modelVisible.';

function hint(a: unknown, k: string): JsonValue {
  const v = isObj(a) ? a[k] : undefined;
  return v === undefined ? null : (v as JsonValue);
}

function round4(n: number): number {
  return Math.round(n * 10_000) / 10_000;
}

export function runSweep(input: SweepInput, opts: SweepOptions): SweepReport {
  const toks = opts.tokenizers;
  if (toks.length === 0) throw new Error('at least one tokenizer is required');
  const budgetTok = opts.budgetTokenizer ?? (toks.some((t) => t.id === REFERENCE_TOKENIZER) ? REFERENCE_TOKENIZER : toks[0]!.id);
  const ref = toks.find((t) => t.id === budgetTok);
  if (!ref) throw new Error(`budget tokenizer "${budgetTok}" is not among the measured tokenizers (${toks.map((t) => t.id).join(', ')})`);
  const advisory = opts.advisoryToolTokens ?? DEFAULT_ADVISORY_TOOL_TOKENS;
  const toolBudget = opts.budgets?.toolTokens;
  const catalogBudget = opts.budgets?.catalogTokens;
  const perToolLimit = toolBudget ?? advisory;
  const anthropicPerTool = opts.anthropic && 'perTool' in opts.anthropic ? opts.anthropic.perTool : null;

  const findings: Finding[] = [...input.findings];
  const tools: ToolReport[] = [];
  let wireTotal = emptyMeasure(toks);
  let visibleTotal = emptyMeasure(toks);
  const withAnnotations = opts.modelVisibleAnnotations ?? false;
  const fieldTotals: Partial<Record<ToolField, Measure>> = {};
  const viewTotals: Record<string, Measure> = {};
  let escTotal = emptyMeasure(toks);
  let plainTotal = emptyMeasure(toks);
  let embeddedCount = 0;
  const choiceSizes: number[] = [];
  const toolsOver: string[] = [];

  for (const tool of input.catalog.tools) {
    const m = measureTool(tool, toks, { modelVisibleAnnotations: withAnnotations });
    const wireText = input.wire.get(tool.name);
    const visibleText = input.modelVisible.get(tool.name);
    const wire = wireText === undefined ? m.total : measure(wireText, toks);
    const modelVisible = visibleText === undefined ? m.modelVisible : visibleText === wireText ? wire : measure(visibleText, toks);
    wireTotal = addMeasures(wireTotal, wire);
    visibleTotal = addMeasures(visibleTotal, modelVisible);
    for (const f of TOOL_FIELDS) {
      const fm = m.fields[f];
      if (fm) fieldTotals[f] = addMeasures(fieldTotals[f] ?? emptyMeasure(toks), fm);
    }
    const views: Record<string, Measure> = {};
    for (const [v, text] of [...(input.views.get(tool.name) ?? new Map<string, string>())].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      views[v] = measure(text, toks);
      viewTotals[v] = addMeasures(viewTotals[v] ?? emptyMeasure(toks), views[v]);
    }

    const a = analyzeTool(tool, { ...(opts.findings ?? {}), tokenizer: ref });
    findings.push(...a.findings);
    const over = oversizeFinding(tool.name, modelVisible.tokens[budgetTok]!, perToolLimit, budgetTok);
    if (over) {
      findings.push(over);
      if (toolBudget !== undefined) toolsOver.push(tool.name);
    }

    const emb = input.embeddedSchemas.get(tool.name);
    if (emb) {
      embeddedCount++;
      const e = measure(emb.escaped, toks);
      const p = measure(emb.plain, toks);
      escTotal = addMeasures(escTotal, e);
      plainTotal = addMeasures(plainTotal, p);
      const overhead = e.tokens[budgetTok]! - p.tokens[budgetTok]!;
      if (overhead > 0) {
        findings.push({
          rule: 'escaped-json',
          severity: 'info',
          tool: tool.name,
          path: '',
          message: `the model-visible text embeds the input schema as an escaped string: ${e.tokens[budgetTok]} vs ${p.tokens[budgetTok]} ${budgetTok} tokens as plain JSON (+${overhead})`,
          data: { view: 'modelVisible', escapedBytes: e.bytes, plainBytes: p.bytes, escapedTokens: e.tokens[budgetTok]!, plainTokens: p.tokens[budgetTok]!, tokenizer: budgetTok },
        });
      }
    }

    const choices = a.choiceLists.filter((c) => c.kind !== 'drf-description');
    for (const c of choices) choiceSizes.push(c.count);
    const enumMax = opts.findings?.enumMax ?? 20;
    tools.push({
      name: tool.name,
      fingerprint: m.fingerprint,
      descriptionFingerprint: m.descriptionFingerprint,
      entryFingerprint: m.entryFingerprint,
      wire,
      modelVisible,
      fields: m.fields,
      views,
      anthropicTokens: anthropicPerTool && Object.hasOwn(anthropicPerTool, tool.name) ? anthropicPerTool[tool.name]! : null,
      annotations: {
        readOnlyHint: hint(tool.annotations, 'readOnlyHint'),
        destructiveHint: hint(tool.annotations, 'destructiveHint'),
        idempotentHint: hint(tool.annotations, 'idempotentHint'),
        openWorldHint: hint(tool.annotations, 'openWorldHint'),
      },
      choiceLists: { count: choices.length, largest: choices.reduce((n, c) => Math.max(n, c.count), 0), over: choices.filter((c) => c.count > enumMax).length },
      duplicates: { wasteBytes: a.duplicates.wasteBytes, share: round4(a.duplicates.share), defsBytesAfter: a.duplicates.defs.bytesAfter },
      untyped: { noTypeNodes: a.untyped.noTypeNodes, emptyItems: a.untyped.emptyItems, opaqueObjects: a.untyped.opaqueObjects },
      findings: 0,
    });
  }

  findings.push(...iconFindings(input.catalog.tools, opts.findings?.maxIconBytes));

  for (const c of opts.callResults ?? []) {
    const f = analyzeCallResult(c.tool, c.result, ref);
    if (f) findings.push(f);
  }

  const catalogTokens = visibleTotal.tokens[budgetTok]!;
  const limitCatalog = catalogBudget !== undefined && catalogTokens > catalogBudget;
  if (limitCatalog) {
    findings.push({
      rule: 'oversize-catalog',
      severity: 'error',
      tool: null,
      path: '',
      message: `catalog model-visible size is ${catalogTokens} ${budgetTok} tokens, over the ${catalogBudget}-token catalog budget`,
      data: { tokens: catalogTokens, budget: catalogBudget, tokenizer: budgetTok },
    });
  }
  if (toolBudget !== undefined) for (const f of findings) if (f.rule === 'oversize-tool' && f.tool !== null) f.severity = 'error';

  findings.sort(compareFindings);
  const perTool = new Map<string, number>();
  for (const f of findings) if (f.tool !== null) perTool.set(f.tool, (perTool.get(f.tool) ?? 0) + 1);
  for (const t of tools) t.findings = perTool.get(t.name) ?? 0;

  let wrapper: SweepReport['totals']['wrapper'] = null;
  if (input.wrapperTools) {
    let w = emptyMeasure(toks);
    for (const t of input.wrapperTools) w = addMeasures(w, measure(canonicalJson(t), toks));
    wrapper = { tools: input.wrapperTools.map((t) => t.name), wire: w };
  }

  const notes = [...input.notes];
  let anthropic: SweepReport['anthropic'] = null;
  if (opts.anthropic) {
    if ('skipped' in opts.anthropic) {
      anthropic = { skipped: opts.anthropic.skipped };
    } else {
      const c = opts.anthropic;
      anthropic = { model: c.model, baseline: c.baseline, catalog: c.catalog, errors: c.errors.length };
      notes.push(
        `anthropic: per-tool counts are count_tokens([tool]) − baseline and include the fixed tool-use preamble, so they do not add up to the catalog figure`,
      );
    }
  }

  return {
    format: REPORT_FORMAT,
    generator: `mcp-catalog-snap/${VERSION}`,
    adapter: input.adapter,
    server: input.server,
    protocolVersion: input.protocolVersion,
    handshake: input.handshake ?? null,
    source: input.source,
    measurement: {
      scope: SCOPE,
      wire: input.wireLabel,
      modelVisible: input.modelVisibleFromAdapter ? input.modelVisibleLabel : `${input.modelVisibleLabel}: ${(withAnnotations ? MODEL_VISIBLE_FIELDS_WITH_ANNOTATIONS : MODEL_VISIBLE_FIELDS).join(', ')}`,
      modelVisibleFields: input.modelVisibleFromAdapter ? null : [...(withAnnotations ? MODEL_VISIBLE_FIELDS_WITH_ANNOTATIONS : MODEL_VISIBLE_FIELDS)],
      budgetsApplyTo: 'modelVisible',
      modelVisibleFieldSum: FIELD_SUM_NOTE,
      tokenizers: toks.map((t) => ({ id: t.id, label: t.label })),
      budgetTokenizer: budgetTok,
    },
    fingerprints: {
      catalog: fingerprint(input.catalog),
      toolsOrdered: input.orderedTools ? orderedToolsFingerprint(input.orderedTools) : null,
    },
    totals: {
      tools: input.catalog.tools.length,
      prompts: input.catalog.prompts.length,
      resourceTemplates: input.catalog.resourceTemplates.length,
      wire: wireTotal,
      modelVisible: visibleTotal,
      modelVisiblePerTool: distribution(tools.map((t) => t.modelVisible.tokens[budgetTok]!)),
      modelVisibleFieldSum: (withAnnotations ? MODEL_VISIBLE_FIELDS_WITH_ANNOTATIONS : MODEL_VISIBLE_FIELDS).reduce(
        (acc: Measure, f) => (fieldTotals[f] ? addMeasures(acc, fieldTotals[f]!) : acc),
        emptyMeasure(toks),
      ),
      fields: Object.fromEntries(TOOL_FIELDS.filter((f) => fieldTotals[f]).map((f) => [f, fieldTotals[f]!])),
      views: Object.fromEntries(Object.keys(viewTotals).sort().map((k) => [k, viewTotals[k]!])),
      embeddedSchema: embeddedCount > 0 ? { tools: embeddedCount, escaped: escTotal, plain: plainTotal } : null,
      wrapper,
    },
    histograms: {
      modelVisibleTokens: histogram(tools.map((t) => t.modelVisible.tokens[budgetTok]!), MODEL_VISIBLE_EDGES),
      choiceListSizes: histogram(choiceSizes, CHOICE_LIST_EDGES),
    },
    budget: {
      tokenizer: budgetTok,
      toolTokens: toolBudget ?? null,
      catalogTokens: catalogBudget ?? null,
      advisoryToolTokens: advisory,
      exceeded: toolsOver.length > 0 || limitCatalog,
      toolsOver: toolsOver.sort(),
      catalogOver: limitCatalog,
    },
    anthropic,
    findingsSummary: summarizeFindings(findings),
    tools,
    findings,
    notes,
  };
}

/** The report bytes: 2-space JSON, fixed key order, trailing newline. */
export function serializeReport(report: SweepReport): string {
  return `${jsonSafe(JSON.stringify(report, null, 2))}\n`;
}
