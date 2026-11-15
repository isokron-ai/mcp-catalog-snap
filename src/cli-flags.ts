/**
 * Which options each command takes. An option the command does not know
 * is an error, not a no-op: a typo like `--max-tool-token 4000` used to run
 * the sweep with no budget and exit 0 in CI.
 */

import { BOOLEAN, REPEATABLE, type ParsedArgs } from './args.js';

const TARGET = ['url', 'header', 'bearer-file', 'bearer-env', 'env', 'cwd', 'timeout', 'timeout-total', 'name', 'telemetry-env', 'no-telemetry-defaults'];
const CONFIG = ['config', 'server', 'dir'];
const ALWAYS = ['help', 'version'];
/** Most positional arguments each command takes (hash: one snapshot file; diff: two). */
const MAX_POSITIONALS: Readonly<Record<string, number>> = { snapshot: 0, check: 0, sweep: 0, matrix: 0, hash: 1, diff: 2 };

export const COMMAND_OPTIONS: Readonly<Record<string, readonly string[]>> = {
  snapshot: [...TARGET, ...CONFIG, 'label', 'no-write', 'quiet'],
  check: [...TARGET, ...CONFIG, 'label', 'ignore-descriptions', 'allow-additions', 'allow-write-additions', 'update', 'json', 'report', 'quiet'],
  diff: ['ignore-descriptions', 'allow-additions', 'allow-write-additions', 'json'],
  matrix: [...TARGET, ...CONFIG, 'label', 'flag-sets', 'no-write', 'json', 'quiet'],
  hash: [...TARGET, ...CONFIG],
  sweep: [
    ...TARGET,
    'from',
    'adapter',
    'tokenizers',
    'budget-tokenizer',
    'max-tool-tokens',
    'max-catalog-tokens',
    'enum-max',
    'max-description-bytes',
    'max-icon-bytes',
    'count-annotations',
    'anthropic',
    'anthropic-model',
    'call-results',
    'save-raw',
    'json',
    'report',
    'md',
    'top',
  ],
};

function distance(a: string, b: string): number {
  const prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]!;
      prev[j] = Math.min(up + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = up;
    }
  }
  return prev[b.length]!;
}

function closest(name: string, known: readonly string[]): string | null {
  let best: string | null = null;
  let bestD = 3;
  for (const k of known) {
    const d = distance(name, k);
    if (d < bestD) [best, bestD] = [k, d];
  }
  return best;
}

/** Throw on an option the command does not take, a repeated single-value option, or a boolean given a non-boolean value. Unknown commands are left to the caller. */
export function validateFlags(args: ParsedArgs): void {
  const allowed = Object.hasOwn(COMMAND_OPTIONS, args.cmd) ? COMMAND_OPTIONS[args.cmd]! : null;
  if (!allowed) return;
  const known = [...allowed, ...ALWAYS];
  for (const name of [...Object.keys(args.flags), ...Object.keys(args.multi)]) {
    if (known.includes(name)) continue;
    const hint = closest(name, known);
    throw new Error(`unknown option --${name} for ${args.cmd}${hint ? ` (did you mean --${hint}?)` : ''}; see mcp-catalog-snap --help`);
  }
  for (const name of args.repeated) if (!REPEATABLE.has(name)) throw new Error(`--${name} given more than once`);
  const extra = args.positional[MAX_POSITIONALS[args.cmd] ?? 0];
  if (extra !== undefined) {
    throw new Error(`unexpected argument ${JSON.stringify(extra)} for ${args.cmd}${args.cmd === 'sweep' ? ' (offline input goes in --from FILE)' : ''}`);
  }
  for (const name of Object.keys(args.flags)) {
    const v = args.flags[name];
    if (BOOLEAN.has(name) && typeof v === 'string' && !['true', 'false', '1', '0'].includes(v)) {
      throw new Error(`--${name} expects true or false (or no value), got ${JSON.stringify(v)}`);
    }
  }
}
