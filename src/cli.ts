#!/usr/bin/env node
/**
 * mcp-catalog-snap CLI
 *
 *   mcp-catalog-snap snapshot [--name N] [--dir D] [--url U [--header H]...] [-- cmd args...]
 *   mcp-catalog-snap check    [--server N] [--ignore-descriptions] [--allow-additions] [--json]
 *   mcp-catalog-snap diff     A.json B.json [--ignore-descriptions] [--allow-additions] [--json]
 *   mcp-catalog-snap hash     [FILE | --url U | -- cmd args...]
 *   mcp-catalog-snap sweep    [--from FILE | --url U | -- cmd args...] [--adapter A] [--json] ...
 */

import { bool, parseArgs, str, targetFromArgs, type ParsedArgs } from './args.js';
import { redact, redactingIO, targetSecrets } from './redact.js';
import { cmdSweep, type SweepCommandOptions } from './cmd-sweep.js';
import { cmdCheck, cmdDiff, cmdHash, cmdSnapshot, EXIT_ERROR, EXIT_OK, type IO } from './commands.js';
import { oneLine, terminalSafe } from './safe-text.js';
import { VERSION } from './version.js';

const HELP = `mcp-catalog-snap ${VERSION} — snapshot an MCP server's tool catalog, fail CI on byte drift,
and run a static sweep (sizes, tokens, schema findings) over it

Usage:
  mcp-catalog-snap snapshot [options] -- <command> [args...]   capture a stdio server
  mcp-catalog-snap snapshot [options] --url URL [--header "Name: v"]...   capture a Streamable HTTP server
  mcp-catalog-snap snapshot [options]                           capture every server in .mcp-catalog.json
  mcp-catalog-snap check    [options]                           re-capture + diff against the snapshot(s)
  mcp-catalog-snap diff     A.json B.json [--json]              diff two snapshot files
  mcp-catalog-snap hash     [FILE | --url URL | -- <command>]   print the catalog fingerprint (sha256)
  mcp-catalog-snap sweep    [--from FILE | --url URL | -- <command>] [options]   static sweep report

Target options (snapshot / check / hash):
  --url URL             Streamable HTTP endpoint
  --header "Name: v"    extra HTTP header (repeatable)
  --bearer-file FILE    send "Authorization: Bearer <first line of FILE>" (never printed)
  --bearer-env VAR      same, token read from environment variable VAR
  --env KEY=value       extra env for the stdio child (repeatable)
  --cwd DIR             working directory for the stdio child
  --name NAME           snapshot name for an ad-hoc target (default: the server's reported name)
  --config FILE         config file (default .mcp-catalog.json)
  --server NAME         only this configured server
  --dir DIR             snapshot directory (default .mcp-catalog, or snapshotDir from config)
  --timeout MS          per-request timeout (default 30000)
  --timeout-total MS    deadline for each server's whole capture (default: none)

check / diff options:
  --ignore-descriptions do not treat description-only changes as drift
  --allow-additions     do not treat added tools/prompts/templates as drift (a section
                        the snapshot lists as empty is no baseline: additions there still drift)
  --update              rewrite drifted snapshots (check still exits 1)
  --json                machine-readable output
  --report FILE         (check) also write the JSON report to FILE

snapshot options:
  --no-write            print the snapshot to stdout instead of writing it
  --quiet               no summary on success

sweep options:
  --from FILE           offline input: tools/list result, JSON-RPC response, tools array,
                        snapshot file, or (exec adapters) a JSONL dump
  --adapter ID          tools-list (default) | posthog-exec
  --name NAME           server name to report
  --tokenizers LIST     comma list of cl100k (default), o200k, chars4
  --budget-tokenizer ID tokenizer budgets and rankings use (default cl100k)
  --max-tool-tokens N   fail (exit 4) when any tool's model-visible size is over N tokens
  --max-catalog-tokens N  fail (exit 4) when the whole catalog's model-visible size is over N tokens
  --count-annotations   count annotations as model-visible (default: name,
                        description, inputSchema only; wire size always counts everything)
  --enum-max N          enum size that triggers enum-large (default 20)
  --max-description-bytes N  description size that triggers description-oversize (default 16384)
  --max-icon-bytes N    data: URI icon size that triggers icon-data-uri-large (default 4096)
  --anthropic           also ask Anthropic count_tokens (needs ANTHROPIC_API_KEY; sends the catalog)
  --anthropic-model M   model for --anthropic (default claude-opus-5-5)
  --call-results FILE   JSONL of {"tool", "result"} observed tools/call results to check
  --save-raw FILE       (live exec adapters) save what was fetched, for a later --from re-run
  --json                print the JSON report instead of the markdown summary
  --report FILE         also write the JSON report to FILE
  --md FILE             also write the markdown summary to FILE
  --top N               rows in the largest-tools table (default 15)

Exit codes: 0 ok / no drift · 1 drift · 2 error · 3 snapshot failed its sha256 integrity check
            · 4 sweep budget exceeded
`;

function num(args: ParsedArgs, key: string, integer = true): number | undefined {
  const v = str(args.flags[key]);
  if (args.flags[key] === true) throw new Error(`--${key} needs a value`);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new Error(`--${key} expects a non-negative ${integer ? 'integer' : 'number'}, got ${v}`);
  return n;
}

function sweepOptions(args: ParsedArgs, target: ReturnType<typeof targetFromArgs>): SweepCommandOptions {
  const o: SweepCommandOptions = { json: bool(args.flags['json']), anthropic: bool(args.flags['anthropic']), countAnnotations: bool(args.flags['count-annotations']) };
  const set = <K extends keyof SweepCommandOptions>(k: K, v: SweepCommandOptions[K] | undefined): void => {
    if (v !== undefined) o[k] = v;
  };
  set('target', target);
  set('from', str(args.flags['from']));
  set('adapter', str(args.flags['adapter']));
  set('name', str(args.flags['name']));
  set('timeoutMs', timeoutMs(args));
  set('totalTimeoutMs', timeoutMs(args, 'timeout-total'));
  const toks = str(args.flags['tokenizers']);
  set('tokenizers', toks === undefined ? undefined : toks.split(',').map((t) => t.trim()).filter(Boolean));
  set('budgetTokenizer', str(args.flags['budget-tokenizer']));
  set('maxToolTokens', num(args, 'max-tool-tokens'));
  set('maxCatalogTokens', num(args, 'max-catalog-tokens'));
  set('enumMax', num(args, 'enum-max'));
  set('maxDescriptionBytes', num(args, 'max-description-bytes'));
  set('maxIconBytes', num(args, 'max-icon-bytes'));
  set('anthropicModel', str(args.flags['anthropic-model']));
  set('callResults', str(args.flags['call-results']));
  set('saveRaw', str(args.flags['save-raw']));
  set('reportFile', str(args.flags['report']));
  set('mdFile', str(args.flags['md']));
  set('top', num(args, 'top'));
  for (const k of ['from', 'report', 'md', 'save-raw', 'call-results', 'adapter', 'tokenizers']) {
    if (args.flags[k] === true) throw new Error(`--${k} needs a value`);
  }
  return o;
}

function timeoutMs(args: ParsedArgs, key = 'timeout'): number | undefined {
  const t = str(args.flags[key]);
  if (t === undefined) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${key} expects a positive number of ms, got ${t}`);
  return n;
}

function policy(args: ParsedArgs): { ignoreDescriptions: boolean; allowAdditions: boolean; json: boolean } {
  return {
    ignoreDescriptions: bool(args.flags['ignore-descriptions']),
    allowAdditions: bool(args.flags['allow-additions']),
    json: bool(args.flags['json']),
  };
}

function optional<T>(key: string, v: T | undefined): Record<string, T> {
  return v === undefined ? {} : { [key]: v };
}

export async function main(argv: string[], rawIo: IO): Promise<number> {
  // Every byte the CLI prints or writes goes through this scrubber; commands add their configured targets' secrets.
  let io: IO = rawIo;
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`error: ${oneLine((err as Error).message)}`);
    return EXIT_ERROR;
  }
  if (bool(args.flags['version']) || args.cmd === '--version' || args.cmd === 'version') {
    io.out(VERSION);
    return EXIT_OK;
  }
  if (bool(args.flags['help']) || args.cmd === 'help' || args.cmd === '--help') {
    io.out(HELP.trimEnd());
    return EXIT_OK;
  }

  let secrets: string[] = [];
  try {
    const target = targetFromArgs(args);
    secrets = targetSecrets(target);
    io = redactingIO(rawIo, secrets);
    const common = {
      ...optional('target', target),
      ...optional('name', str(args.flags['name'])),
      ...optional('config', str(args.flags['config'])),
      ...optional('server', str(args.flags['server'])),
      ...optional('dir', str(args.flags['dir'])),
      ...optional('timeoutMs', timeoutMs(args)),
      ...optional('totalTimeoutMs', timeoutMs(args, 'timeout-total')),
      quiet: bool(args.flags['quiet']),
    };
    switch (args.cmd) {
      case 'snapshot':
        return await cmdSnapshot({ ...common, noWrite: bool(args.flags['no-write']) }, io);
      case 'check':
        return await cmdCheck(
          { ...common, ...policy(args), update: bool(args.flags['update']), ...optional('reportFile', str(args.flags['report'])) },
          io,
        );
      case 'diff': {
        const [a, b] = args.positional;
        if (!a || !b) {
          io.err('error: diff needs two snapshot files: mcp-catalog-snap diff A.json B.json');
          return EXIT_ERROR;
        }
        return cmdDiff(a, b, policy(args), io);
      }
      case 'sweep':
        if (args.positional.length > 0) {
          io.err(`error: unexpected argument ${JSON.stringify(args.positional[0])} (offline input goes in --from FILE)`);
          return EXIT_ERROR;
        }
        return await cmdSweep(sweepOptions(args, target), io);
      case 'hash': {
        const file = args.positional[0];
        if (file !== undefined && target !== undefined) throw new Error('give a snapshot FILE or a live target (--url or -- command), not both');
        return await cmdHash({ ...common, ...optional('file', file), json: false }, io);
      }
      default:
        io.err(`error: unknown command "${args.cmd}"\n`);
        io.err(HELP.trimEnd());
        return EXIT_ERROR;
    }
  } catch (err) {
    io.err(`error: ${oneLine(redact((err as Error).message, secrets))}`);
    return EXIT_ERROR;
  }
}

const io: IO = {
  // The output boundary: whatever a command printed, terminal-active characters and workflow-command / fence lines are neutralized here.
  out: (s) => process.stdout.write(`${terminalSafe(s)}\n`),
  err: (s) => process.stderr.write(`${terminalSafe(s)}\n`),
};

main(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`error: ${oneLine((err as Error).message)}\n`);
    process.exitCode = EXIT_ERROR;
  },
);
