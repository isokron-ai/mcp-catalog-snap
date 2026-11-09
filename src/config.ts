/**
 * `.mcp-catalog.json` — the list of servers `check` / `snapshot` act on when
 * no ad-hoc target is given.
 *
 * ```json
 * {
 *   "snapshotDir": ".mcp-catalog",
 *   "servers": [
 *     { "name": "kronicle-lite", "command": ["npx", "-y", "kronicle-lite@0.2.0", "serve"] },
 *     { "name": "remote", "url": "https://host/mcp",
 *       "headers": { "Authorization": "Bearer ${MCP_TOKEN}" } }
 *   ]
 * }
 * ```
 *
 * `${VAR}` in `url`, `headers`, `env` and `command` is expanded from the
 * environment at load time (missing variables are an error, so a CI job
 * with a forgotten secret fails loudly instead of sending a literal).
 * Relative `snapshotDir` / `cwd` resolve against the config file's directory.
 */

import { readInputText } from './read-input.js';
import { dirname, isAbsolute, resolve } from 'node:path';

import type { Target } from './capture.js';

export const DEFAULT_CONFIG_FILE = '.mcp-catalog.json';
export const DEFAULT_SNAPSHOT_DIR = '.mcp-catalog';

export interface ServerSpec {
  name: string;
  target: Target;
  /** Display label for messages and reports (ad-hoc `--label`); default: `name`, else `describeTarget`. */
  label?: string;
}

export interface CatalogConfig {
  /** Absolute path of the config file. */
  path: string;
  /** Absolute snapshot directory. */
  snapshotDir: string;
  servers: ServerSpec[];
}

export function expandEnv(s: string, env: NodeJS.ProcessEnv = process.env): string {
  return s.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) throw new Error(`environment variable ${name} is not set (referenced as \${${name}})`);
    return v;
  });
}

function expandRecord(r: Record<string, unknown>, where: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(r)) {
    if (typeof v !== 'string') throw new Error(`${where}.${k} must be a string`);
    out[k] = expandEnv(v, env);
  }
  return out;
}

export function parseConfig(text: string, configPath: string, env: NodeJS.ProcessEnv = process.env): CatalogConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`${configPath}: not valid JSON (${(err as Error).message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`${configPath}: expected a JSON object`);
  }
  const o = raw as Record<string, unknown>;
  const baseDir = dirname(resolve(configPath));
  const snapshotDirRaw = o['snapshotDir'] ?? DEFAULT_SNAPSHOT_DIR;
  if (typeof snapshotDirRaw !== 'string') throw new Error(`${configPath}: snapshotDir must be a string`);
  const snapshotDir = isAbsolute(snapshotDirRaw) ? snapshotDirRaw : resolve(baseDir, snapshotDirRaw);

  if (!Array.isArray(o['servers'])) throw new Error(`${configPath}: "servers" must be an array`);
  const servers: ServerSpec[] = [];
  const seen = new Set<string>();
  o['servers'].forEach((entry, i) => {
    const where = `${configPath}: servers[${i}]`;
    if (entry === null || typeof entry !== 'object') throw new Error(`${where} must be an object`);
    const e = entry as Record<string, unknown>;
    if (typeof e['name'] !== 'string' || e['name'].length === 0) throw new Error(`${where}.name is required`);
    const name = e['name'];
    if (seen.has(name)) throw new Error(`${configPath}: duplicate server name "${name}"`);
    seen.add(name);

    const hasCommand = e['command'] !== undefined;
    const hasUrl = e['url'] !== undefined;
    if (hasCommand === hasUrl) throw new Error(`${where} needs exactly one of "command" or "url"`);

    if (hasCommand) {
      const cmd = e['command'];
      let argv: string[];
      if (typeof cmd === 'string') argv = cmd.trim().split(/\s+/);
      else if (Array.isArray(cmd) && cmd.every((x) => typeof x === 'string')) argv = cmd as string[];
      else throw new Error(`${where}.command must be a string or an array of strings`);
      if (e['args'] !== undefined) {
        if (!Array.isArray(e['args']) || !e['args'].every((x) => typeof x === 'string')) {
          throw new Error(`${where}.args must be an array of strings`);
        }
        argv = [...argv, ...(e['args'] as string[])];
      }
      argv = argv.map((a) => expandEnv(a, env));
      const [command, ...args] = argv;
      if (!command) throw new Error(`${where}.command is empty`);
      const target: Target = { kind: 'stdio', command, args };
      if (e['env'] !== undefined) {
        if (e['env'] === null || typeof e['env'] !== 'object') throw new Error(`${where}.env must be an object`);
        target.env = expandRecord(e['env'] as Record<string, unknown>, `${where}.env`, env);
      }
      if (e['cwd'] !== undefined) {
        if (typeof e['cwd'] !== 'string') throw new Error(`${where}.cwd must be a string`);
        const cwd = expandEnv(e['cwd'], env);
        target.cwd = isAbsolute(cwd) ? cwd : resolve(baseDir, cwd);
      }
      servers.push({ name, target });
    } else {
      if (typeof e['url'] !== 'string') throw new Error(`${where}.url must be a string`);
      const target: Target = { kind: 'http', url: expandEnv(e['url'], env) };
      if (e['headers'] !== undefined) {
        if (e['headers'] === null || typeof e['headers'] !== 'object') throw new Error(`${where}.headers must be an object`);
        target.headers = expandRecord(e['headers'] as Record<string, unknown>, `${where}.headers`, env);
      }
      servers.push({ name, target });
    }
  });
  return { path: resolve(configPath), snapshotDir, servers };
}

export function loadConfig(configPath: string, env: NodeJS.ProcessEnv = process.env): CatalogConfig {
  let text: string;
  try {
    text = readInputText(configPath, 'config');
  } catch (err) {
    throw new Error(`cannot read config ${configPath}: ${(err as NodeJS.ErrnoException).message}`);
  }
  return parseConfig(text, configPath, env);
}
