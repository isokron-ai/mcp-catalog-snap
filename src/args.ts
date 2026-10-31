/**
 * Minimal argv parser. `--flag value`, `--flag=value`, bare `--flag`,
 * repeatable flags (`--header A --header B`), and `--` after which every
 * token is the stdio server command.
 */

import type { Target } from './capture.js';

export interface ParsedArgs {
  cmd: string;
  positional: string[];
  flags: Record<string, string | true>;
  multi: Record<string, string[]>;
  /** Tokens after `--`. */
  command: string[];
}

const REPEATABLE = new Set(['header', 'env']);
const BOOLEAN = new Set([
  'json',
  'ignore-descriptions',
  'allow-additions',
  'quiet',
  'help',
  'version',
  'no-write',
  'update',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const [cmd = 'help', ...rest] = argv;
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const multi: Record<string, string[]> = {};
  const command: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--') {
      command.push(...rest.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      let key = a.slice(2);
      let value: string | undefined;
      const eq = key.indexOf('=');
      if (eq >= 0) {
        value = key.slice(eq + 1);
        key = key.slice(0, eq);
      } else if (!BOOLEAN.has(key)) {
        const next = rest[i + 1];
        if (next !== undefined && next !== '--' && !next.startsWith('--')) {
          value = next;
          i++;
        }
      }
      if (REPEATABLE.has(key)) {
        if (value === undefined) throw new Error(`--${key} needs a value`);
        (multi[key] ??= []).push(value);
      } else {
        flags[key] = value ?? true;
      }
    } else {
      positional.push(a);
    }
  }
  return { cmd, positional, flags, multi, command };
}

export function str(v: string | true | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function bool(v: string | true | undefined): boolean {
  return v === true || v === 'true' || v === '1';
}

/** `Name: value` → ['Name', 'value'] */
export function parseHeader(h: string): [string, string] {
  const idx = h.indexOf(':');
  if (idx <= 0) throw new Error(`--header expects "Name: value", got ${JSON.stringify(h)}`);
  return [h.slice(0, idx).trim(), h.slice(idx + 1).trim()];
}

/** `KEY=value` → ['KEY', 'value'] */
export function parseEnvAssignment(s: string): [string, string] {
  const idx = s.indexOf('=');
  if (idx <= 0) throw new Error(`--env expects "KEY=value", got ${JSON.stringify(s)}`);
  return [s.slice(0, idx), s.slice(idx + 1)];
}

/** Build an ad-hoc target from `--url ...` or `-- cmd args`, or undefined. */
export function targetFromArgs(args: ParsedArgs): Target | undefined {
  const url = str(args.flags['url']);
  if (url !== undefined && args.command.length > 0) {
    throw new Error('give either --url or a `-- command`, not both');
  }
  if (url !== undefined) {
    const headers: Record<string, string> = {};
    for (const h of args.multi['header'] ?? []) {
      const [k, v] = parseHeader(h);
      headers[k] = v;
    }
    const t: Target = { kind: 'http', url };
    if (Object.keys(headers).length > 0) t.headers = headers;
    return t;
  }
  if (args.command.length > 0) {
    const [command, ...cmdArgs] = args.command;
    const t: Target = { kind: 'stdio', command: command!, args: cmdArgs };
    const env: Record<string, string> = {};
    for (const e of args.multi['env'] ?? []) {
      const [k, v] = parseEnvAssignment(e);
      env[k] = v;
    }
    if (Object.keys(env).length > 0) t.env = env;
    const cwd = str(args.flags['cwd']);
    if (cwd !== undefined) t.cwd = cwd;
    return t;
  }
  return undefined;
}
