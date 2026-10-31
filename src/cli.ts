#!/usr/bin/env node
/**
 * mcp-catalog-snap CLI
 *
 *   mcp-catalog-snap snapshot [--name N] [--dir D] [--url U [--header H]...] [-- cmd args...]
 *   mcp-catalog-snap check    [--server N] [--ignore-descriptions] [--allow-additions] [--json]
 *   mcp-catalog-snap diff     A.json B.json [--ignore-descriptions] [--allow-additions] [--json]
 *   mcp-catalog-snap hash     [FILE | --url U | -- cmd args...]
 */

import { bool, parseArgs, str, targetFromArgs, type ParsedArgs } from './args.js';
import { cmdCheck, cmdDiff, cmdHash, cmdSnapshot, EXIT_ERROR, EXIT_OK, type IO } from './commands.js';
import { VERSION } from './version.js';

const HELP = `mcp-catalog-snap ${VERSION} — snapshot an MCP server's tool catalog, fail CI on byte drift

Usage:
  mcp-catalog-snap snapshot [options] -- <command> [args...]   capture a stdio server
  mcp-catalog-snap snapshot [options] --url URL [--header "Name: v"]...   capture a Streamable HTTP server
  mcp-catalog-snap snapshot [options]                           capture every server in .mcp-catalog.json
  mcp-catalog-snap check    [options]                           re-capture + diff against the snapshot(s)
  mcp-catalog-snap diff     A.json B.json [--json]              diff two snapshot files
  mcp-catalog-snap hash     [FILE | --url URL | -- <command>]   print the catalog fingerprint (sha256)

Target options (snapshot / check / hash):
  --url URL             Streamable HTTP endpoint
  --header "Name: v"    extra HTTP header (repeatable)
  --env KEY=value       extra env for the stdio child (repeatable)
  --cwd DIR             working directory for the stdio child
  --name NAME           snapshot name for an ad-hoc target (default: the server's reported name)
  --config FILE         config file (default .mcp-catalog.json)
  --server NAME         only this configured server
  --dir DIR             snapshot directory (default .mcp-catalog, or snapshotDir from config)
  --timeout MS          per-request timeout (default 30000)

check / diff options:
  --ignore-descriptions do not treat description-only changes as drift
  --allow-additions     do not treat added tools/prompts/templates as drift
  --update              rewrite drifted snapshots (check still exits 1)
  --json                machine-readable output
  --report FILE         (check) also write the JSON report to FILE

snapshot options:
  --no-write            print the snapshot to stdout instead of writing it
  --quiet               no summary on success

Exit codes: 0 no drift · 1 drift · 2 error
`;

function timeoutMs(args: ParsedArgs): number | undefined {
  const t = str(args.flags['timeout']);
  if (t === undefined) return undefined;
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--timeout expects a positive number of ms, got ${t}`);
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

export async function main(argv: string[], io: IO): Promise<number> {
  let args: ParsedArgs;
  try {
    args = parseArgs(argv);
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
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

  try {
    const common = {
      ...optional('target', targetFromArgs(args)),
      ...optional('name', str(args.flags['name'])),
      ...optional('config', str(args.flags['config'])),
      ...optional('server', str(args.flags['server'])),
      ...optional('dir', str(args.flags['dir'])),
      ...optional('timeoutMs', timeoutMs(args)),
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
      case 'hash': {
        const file = args.positional[0];
        return await cmdHash({ ...common, ...optional('file', file), json: false }, io);
      }
      default:
        io.err(`error: unknown command "${args.cmd}"\n`);
        io.err(HELP.trimEnd());
        return EXIT_ERROR;
    }
  } catch (err) {
    io.err(`error: ${(err as Error).message}`);
    return EXIT_ERROR;
  }
}

const io: IO = {
  out: (s) => process.stdout.write(`${s}\n`),
  err: (s) => process.stderr.write(`${s}\n`),
};

main(process.argv.slice(2), io).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`error: ${(err as Error).message}\n`);
    process.exitCode = EXIT_ERROR;
  },
);
