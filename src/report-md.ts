/**
 * Markdown summary of a SweepReport, for a CI step summary or a PR comment.
 *
 * Everything that came from the server (tool names, paths, messages built
 * from property names) is untrusted text: it is flattened to one line,
 * length-capped and escaped so it cannot break a table, open a link or
 * inject HTML.
 */

import { RULES, type Finding, type RuleId, type Severity } from './findings.js';
import { mdCodeEscape, mdEscape } from './redact.js';
import { UNSAFE_TEXT } from './safe-text.js';
import type { Measure } from './metrics.js';
import type { SweepReport } from './sweep.js';

/** Untrusted text → safe inline markdown (one line, ≤ max chars, no HTML / entities / links / mentions / table breaks). */
export function mdText(s: string, max = 120): string {
  const flat = s.replace(/[\r\n\t]+/g, ' ').replace(UNSAFE_TEXT, '');
  const cut = flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
  return mdEscape(cut);
}

/** Untrusted text as a code span; backticks and newlines removed so the span cannot be closed early. */
export function mdCode(s: string, max = 80): string {
  return mdCodeEscape(s.length > max ? `${s.slice(0, max - 1)}…` : s);
}

/** Thousands separators without locale/ICU dependence (deterministic output). */
function n(x: number): string {
  const [i, f] = String(x).split('.');
  return `${i!.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${f ? `.${f}` : ''}`;
}

const SEV_ORDER: Record<Severity, number> = { error: 0, warn: 1, info: 2 };

export interface MarkdownOptions {
  /** Rows in the "largest tools" table (default 15). */
  top?: number;
  /** Example findings per rule (default 5). */
  examples?: number;
}

export function renderSweepMarkdown(r: SweepReport, opts: MarkdownOptions = {}): string {
  const top = opts.top ?? 15;
  const examples = opts.examples ?? 5;
  const tk = r.measurement.budgetTokenizer;
  const tokIds = r.measurement.tokenizers.map((t) => t.id);
  const L: string[] = [];
  const row = (cells: string[]): void => {
    L.push(`| ${cells.join(' | ')} |`);
  };
  const measureCells = (m: Measure): string[] => [n(m.bytes), ...tokIds.map((id) => n(m.tokens[id] ?? 0))];

  L.push(`# MCP static sweep: ${mdText(r.server.name)}${r.server.version ? ` ${mdText(r.server.version)}` : ''}`);
  L.push('');
  const fields = r.measurement.modelVisibleFields;
  L.push(
    fields
      ? `> **Model-visible** = what the model reads (${fields.map((f) => `\`${f}\``).join(', ')}); **wire** = the whole tools/list entry (icons, \`_meta\` and \`outputSchema\` included), which clients do not pass to the model. Budgets apply to model-visible tokens. Every tool is counted once, as if the full catalog were loaded: not session or task exposure.`
      : `> **Model-visible** and **wire** are both the adapter's per-tool text (see "measured as" below). Budgets apply to model-visible tokens. Every tool is counted once, as if the full catalog were loaded: not session or task exposure.`,
  );
  for (const t of r.measurement.tokenizers) L.push(`> \`${t.id}\`: ${mdText(t.label, 200)}.`);
  L.push('');
  row(['', 'value']);
  row(['---', '---']);
  const src = r.source.kind === 'file' ? `file ${mdCode(r.source.name)} (${mdText(r.source.format)})` : r.source.kind === 'http' ? mdCode(r.source.url, 120) : `stdio ${mdCode(r.source.command)}`;
  row(['source', `${src}, adapter \`${r.adapter}\``]);
  row(['protocol', r.protocolVersion ? mdText(r.protocolVersion) : 'unknown']);
  row(['catalog fingerprint', `\`${r.fingerprints.catalog}\``]);
  row(['tools-ordered fingerprint (ADR-0005)', r.fingerprints.toolsOrdered ? `\`${r.fingerprints.toolsOrdered}\`` : 'n/a']);
  row(['model-visible measured as', mdText(r.measurement.modelVisible, 200)]);
  row(['wire measured as', mdText(r.measurement.wire, 200)]);
  row(['generator', `\`${r.generator}\` · report \`${r.format}\``]);
  L.push('');

  L.push('## Totals');
  L.push('');
  L.push(`${n(r.totals.tools)} tools, ${n(r.totals.prompts)} prompts, ${n(r.totals.resourceTemplates)} resource templates.`);
  L.push('');
  row(['measure', 'bytes', ...tokIds.map((id) => `${id} tokens`)]);
  row(['---', ...Array<string>(tokIds.length + 1).fill('---:')]);
  row(['**model-visible (all tools)**', ...measureCells(r.totals.modelVisible)]);
  if (r.measurement.modelVisibleFields) row(['model-visible fields, each tokenized on its own (sum)', ...measureCells(r.totals.modelVisibleFieldSum)]);
  row(['wire (whole tools/list entries)', ...measureCells(r.totals.wire)]);
  for (const [f, m] of Object.entries(r.totals.fields)) row([`field \`${f}\``, ...measureCells(m)]);
  for (const [v, m] of Object.entries(r.totals.views)) row([`view \`${mdText(v)}\``, ...measureCells(m)]);
  if (r.totals.embeddedSchema) {
    row([`embedded schema, escaped (${n(r.totals.embeddedSchema.tools)} tools)`, ...measureCells(r.totals.embeddedSchema.escaped)]);
    row(['embedded schema, as plain JSON', ...measureCells(r.totals.embeddedSchema.plain)]);
  }
  if (r.totals.wrapper) row([`wrapper tools/list (${r.totals.wrapper.tools.map((t) => mdCode(t)).join(', ')})`, ...measureCells(r.totals.wrapper.wire)]);
  L.push('');
  if (r.measurement.modelVisibleFields) {
    L.push(
      'The whole-object figure tokenizes one JSON object per tool (keys, quotes and the description\'s JSON escaping count, and tokens merge across field boundaries); the field rows tokenize each field on its own (name and description as raw text). The two need not match; budgets use the whole-object figure.',
    );
    L.push('');
  }
  const d = r.totals.modelVisiblePerTool;
  L.push(`Per-tool model-visible (${tk}): median ${n(d.median)}, p90 ${n(d.p90)}, max ${n(d.max)}.`);
  if (r.anthropic) {
    L.push('');
    if ('skipped' in r.anthropic) L.push(`Anthropic count_tokens: skipped (${mdText(r.anthropic.skipped)}).`);
    else
      L.push(
        `Anthropic count_tokens (\`${mdText(r.anthropic.model)}\`): whole catalog ${r.anthropic.catalog === null ? 'n/a' : n(r.anthropic.catalog)} tokens over a ${n(r.anthropic.baseline)}-token baseline; ${n(r.anthropic.errors)} error(s).`,
      );
  }
  L.push('');

  L.push('## Budget');
  L.push('');
  const b = r.budget;
  if (b.toolTokens === null && b.catalogTokens === null) {
    L.push(
      `No budget set (advisory per-tool threshold: ${n(b.advisoryToolTokens)} ${b.tokenizer} model-visible tokens). Set \`--max-tool-tokens\` / \`--max-catalog-tokens\` to fail CI (exit 4). Budgets apply to model-visible tokens.`,
    );
  } else {
    L.push(`${b.exceeded ? '**Budget exceeded.**' : 'Within budget.'} Budgets apply to model-visible tokens.`);
    L.push('');
    if (b.toolTokens !== null) L.push(`- per tool: ${n(b.toolTokens)} ${b.tokenizer} tokens, ${n(b.toolsOver.length)} tool(s) over${b.toolsOver.length ? `: ${b.toolsOver.slice(0, 10).map((t) => mdCode(t)).join(', ')}${b.toolsOver.length > 10 ? ', …' : ''}` : ''}`);
    if (b.catalogTokens !== null) L.push(`- catalog: ${n(b.catalogTokens)} ${b.tokenizer} tokens, ${b.catalogOver ? 'over' : 'within'} (${n(r.totals.modelVisible.tokens[b.tokenizer] ?? 0)})`);
  }
  L.push('');

  L.push('## Findings');
  L.push('');
  const rules = Object.entries(r.findingsSummary) as [RuleId, NonNullable<SweepReport['findingsSummary'][RuleId]>][];
  if (rules.length === 0) {
    L.push('None.');
  } else {
    row(['rule', 'what', 'findings', 'tools', 'error / warn / info']);
    row(['---', '---', '---:', '---:', '---:']);
    for (const [rule, s] of rules) row([`\`${rule}\``, RULES[rule].summary.replace(/\|/g, '\\|'), n(s.count), n(s.tools), `${s.severity.error} / ${s.severity.warn} / ${s.severity.info}`]);
  }
  L.push('');

  if (r.histograms.choiceListSizes && Object.values(r.histograms.choiceListSizes).some((v) => v > 0)) {
    L.push('Enum / const-union sizes: ' + Object.entries(r.histograms.choiceListSizes).map(([k, v]) => `${k}: ${n(v)}`).join(' · '));
    L.push('');
  }

  L.push(`## Largest tools (model-visible ${tk})`);
  L.push('');
  row(['#', 'tool', `model-visible ${tk} tokens`, 'model-visible bytes', 'wire bytes', 'dup %', 'largest enum', 'findings']);
  row(['---:', '---', '---:', '---:', '---:', '---:', '---:', '---:']);
  const largest = [...r.tools].sort((a, b) => (b.modelVisible.tokens[tk] ?? 0) - (a.modelVisible.tokens[tk] ?? 0) || (a.name < b.name ? -1 : 1)).slice(0, top);
  largest.forEach((t, i) =>
    row([
      String(i + 1),
      mdCode(t.name),
      n(t.modelVisible.tokens[tk] ?? 0),
      n(t.modelVisible.bytes),
      n(t.wire.bytes),
      `${Math.round(t.duplicates.share * 1000) / 10}`,
      n(t.choiceLists.largest),
      n(t.findings),
    ]),
  );
  L.push('');

  const byRule = new Map<RuleId, Finding[]>();
  for (const f of r.findings) {
    let list = byRule.get(f.rule);
    if (!list) byRule.set(f.rule, (list = []));
    list.push(f);
  }
  if (byRule.size > 0) {
    L.push('## Examples');
    L.push('');
    for (const [rule] of rules) {
      const list = [...(byRule.get(rule) ?? [])].sort((a, b) => SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
      L.push(`### \`${rule}\``);
      L.push('');
      for (const f of list.slice(0, examples)) {
        L.push(`- **${f.severity}** ${f.tool === null ? 'catalog' : mdCode(f.tool)}${f.path ? ` ${mdCode(f.path, 100)}` : ''}: ${mdText(f.message, 200)}`);
      }
      if (list.length > examples) L.push(`- … ${n(list.length - examples)} more in the JSON report`);
      L.push('');
    }
  }

  if (r.notes.length > 0) {
    L.push('## Notes');
    L.push('');
    for (const note of r.notes) L.push(`- ${mdText(note, 300)}`);
    L.push('');
  }
  return `${L.join('\n').trimEnd()}\n`;
}
