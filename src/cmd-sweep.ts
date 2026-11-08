/**
 * `mcp-catalog-snap sweep`: the free static sweep.
 *
 * Exit codes (shared with check/diff/hash where they overlap):
 *   0  swept; no explicit budget exceeded
 *   2  usage, input, connection or I/O error
 *   3  the input snapshot failed its sha256 integrity check
 *   4  an explicit budget (--max-tool-tokens / --max-catalog-tokens) was exceeded
 * Precedence: 3 > 2 > 4.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { loadSweepInput, type LoadOptions } from './adapters/index.js';
import { ANTHROPIC_API_KEY_ENV, DEFAULT_ANTHROPIC_MODEL, anthropicToolCounts } from './anthropic.js';
import type { Target } from './capture.js';
import { EXIT_ERROR, EXIT_OK, EXIT_TAMPERED } from './commands.js';
import { redactingIO, scrubDeep, targetSecrets, writeText, type IO } from './redact.js';
import { renderSweepMarkdown } from './report-md.js';
import { SnapshotIntegrityError } from './snapshot.js';
import { runSweep, serializeReport, type SweepOptions, type SweepReport } from './sweep.js';
import { REFERENCE_TOKENIZER, loadTokenizers } from './tokenize.js';

export const EXIT_BUDGET = 4;

export interface SweepCommandOptions {
  adapter?: string;
  from?: string;
  target?: Target;
  name?: string;
  timeoutMs?: number;
  tokenizers?: string[];
  budgetTokenizer?: string;
  maxToolTokens?: number;
  maxCatalogTokens?: number;
  enumMax?: number;
  maxDescriptionBytes?: number;
  maxIconBytes?: number;
  /** Count `annotations` as model-visible. */
  countAnnotations?: boolean;
  anthropic?: boolean;
  anthropicModel?: string;
  callResults?: string;
  saveRaw?: string;
  json?: boolean;
  reportFile?: string;
  mdFile?: string;
  top?: number;
  /** Injected in tests. */
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

function readCallResults(path: string): { tool: string; result: unknown }[] {
  const out: { tool: string; result: unknown }[] = [];
  const lines = readFileSync(path, 'utf8').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch {
      throw new Error(`${basename(path)}:${i + 1}: not valid JSON`);
    }
    const r = o as { tool?: unknown; result?: unknown };
    if (typeof r.tool !== 'string' || r.result === undefined) throw new Error(`${basename(path)}:${i + 1}: expected {"tool": "...", "result": {...}}`);
    out.push({ tool: r.tool, result: r.result });
  }
  return out;
}

/**
 * Scrub the report model, then render it. Order matters: renderers escape
 * and truncate, which would hide a credential from a scrubber that ran
 * afterwards (the output-layer scrubber stays as a second line of defense).
 */
export function sweepOutputs(raw: SweepReport, variants: readonly string[], top?: number): { report: SweepReport; json: string; md: string } {
  const report = scrubDeep(raw, variants);
  return { report, json: serializeReport(report), md: renderSweepMarkdown(report, top !== undefined ? { top } : {}) };
}

export async function cmdSweep(opts: SweepCommandOptions, rawIo: IO): Promise<number> {
  const secrets = targetSecrets(opts.target);
  const io = redactingIO(rawIo, secrets);
  const env = opts.env ?? process.env;
  try {
    const tokenizers = await loadTokenizers(opts.tokenizers ?? [REFERENCE_TOKENIZER]);
    const load: LoadOptions = { stderr: opts.json ? 'ignore' : 'inherit' };
    if (opts.adapter !== undefined) load.adapter = opts.adapter;
    if (opts.from !== undefined) load.from = opts.from;
    if (opts.target !== undefined) load.target = opts.target;
    if (opts.name !== undefined) load.name = opts.name;
    if (opts.timeoutMs !== undefined) load.timeoutMs = opts.timeoutMs;
    if (opts.saveRaw !== undefined) {
      load.saveRaw = opts.saveRaw;
      load.secrets = secrets;
    }
    const input = await loadSweepInput(load);

    const sweepOpts: SweepOptions = { tokenizers, findings: {} };
    if (opts.budgetTokenizer !== undefined) sweepOpts.budgetTokenizer = opts.budgetTokenizer;
    const budgets: NonNullable<SweepOptions['budgets']> = {};
    if (opts.maxToolTokens !== undefined) budgets.toolTokens = opts.maxToolTokens;
    if (opts.maxCatalogTokens !== undefined) budgets.catalogTokens = opts.maxCatalogTokens;
    sweepOpts.budgets = budgets;
    if (opts.enumMax !== undefined) sweepOpts.findings!.enumMax = opts.enumMax;
    if (opts.maxDescriptionBytes !== undefined) sweepOpts.findings!.maxDescriptionBytes = opts.maxDescriptionBytes;
    if (opts.maxIconBytes !== undefined) sweepOpts.findings!.maxIconBytes = opts.maxIconBytes;
    if (opts.countAnnotations) sweepOpts.modelVisibleAnnotations = true;
    if (opts.callResults !== undefined) sweepOpts.callResults = readCallResults(opts.callResults);

    if (opts.anthropic) {
      const key = env[ANTHROPIC_API_KEY_ENV]?.trim();
      if (!key) {
        sweepOpts.anthropic = { skipped: `${ANTHROPIC_API_KEY_ENV} is not set` };
        io.err(`note: --anthropic skipped: ${ANTHROPIC_API_KEY_ENV} is not set`);
      } else {
        secrets.push(key); // the redacting IO shares this array
        const a: Parameters<typeof anthropicToolCounts>[1] = { apiKey: key, model: opts.anthropicModel ?? DEFAULT_ANTHROPIC_MODEL };
        if (opts.fetch) a.fetch = opts.fetch;
        sweepOpts.anthropic = await anthropicToolCounts(input.catalog.tools, a);
      }
    }

    const { report, json, md } = sweepOutputs(runSweep(input, sweepOpts), io.variants(), opts.top);
    if (opts.reportFile !== undefined) writeText(io, opts.reportFile, json);
    if (opts.mdFile !== undefined) writeText(io, opts.mdFile, md);
    io.out((opts.json ? json : md).trimEnd());
    if (report.budget.exceeded) {
      io.err(`budget exceeded: ${report.budget.toolsOver.length} tool(s) over${report.budget.catalogOver ? ', catalog over' : ''}`);
      return EXIT_BUDGET;
    }
    return EXIT_OK;
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
    return err instanceof SnapshotIntegrityError ? EXIT_TAMPERED : EXIT_ERROR;
  }
}
