/**
 * Exec/CLI-style adapter: one wrapper tool (e.g. PostHog's `exec`) whose
 * sub-commands list the real tools and print each one's contract.
 *
 * An `ExecProfile` says how to drive a given server: the wrapper tool, the
 * argument that carries the command string, any extra required arguments,
 * and the command templates (`{name}` is replaced). The PostHog profile
 * ships built in; others can be passed programmatically.
 *
 * Offline, the adapter reads a JSONL dump with one record per tool (the
 * format the first PostHog audit's `sweep.ts` wrote, which `--save-raw`
 * also writes):
 *   { name, title?, description?, annotations?,
 *     info_output,            // primary exposure: `info <tool>` text
 *     full_info_output?,      // unsummarized info payload, when known
 *     info_json_output?,      // `info --json <tool>` text
 *     schema_output?,         // `schema <tool>` text
 *     full_schema?,           // complete input schema (contract); else info --json's
 *     returned_schema_plain_json? }  // the schema `info` embedded, as plain JSON
 */

import { canonicalJson } from '../canonical.js';
import { listCatalog, openSession, withDeadline, type CaptureOptions, type Session, type Target } from '../capture.js';
import type { Finding } from '../findings.js';
import { allSubtrees, isObj } from '../schema-walk.js';
import { normalizeCatalog, type CatalogTool } from '../snapshot.js';
import { sourceOf } from './tools-list.js';
import type { SweepInput } from './types.js';

export interface ExecProfile {
  id: string;
  /** Wrapper tool name in tools/list. */
  tool: string;
  /** Argument holding the command string. */
  commandArg: string;
  /** Other arguments the wrapper requires on every call. */
  extraArgs: Record<string, string>;
  /** Command that lists tool names. */
  list: string;
  /** Command whose output is the primary exposure (`{name}` substituted). */
  info: string;
  /** Command returning the contract as JSON ({name, description, inputSchema, …}). */
  infoJson: string;
  /** Optional drill-down view. */
  schema?: string;
  /** Text that precedes the schema embedded in `info` output, for escaped-JSON accounting. */
  infoSchemaMarker?: string;
}

export const POSTHOG_EXEC: ExecProfile = {
  id: 'posthog-exec',
  tool: 'exec',
  commandArg: 'command',
  extraArgs: { context: 'Static catalog sweep measuring tool definition sizes; reads no project data.', llm_model: 'unknown' },
  list: 'tools',
  info: 'info {name}',
  infoJson: 'info --json {name}',
  schema: 'schema {name}',
  infoSchemaMarker: '\ninputSchema: ',
};

export const EXEC_PROFILES: Record<string, ExecProfile> = { [POSTHOG_EXEC.id]: POSTHOG_EXEC };

const EXPOSURE_LABEL = '`info <tool>` output text (what the exec wrapper returns for one tool)';

export interface ExecRecord {
  name: string;
  title?: string;
  description?: string;
  annotations?: unknown;
  info_output: string;
  full_info_output?: string;
  info_json_output?: string;
  schema_output?: string;
  full_schema?: unknown;
  returned_schema_plain_json?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function parseJson(text: string | undefined): unknown {
  if (text === undefined) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse the offline JSONL dump. Throws on a malformed line (with its number). */
export function parseExecRecords(text: string, fileName: string): ExecRecord[] {
  const out: ExecRecord[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (!line) continue;
    let o: unknown;
    try {
      o = JSON.parse(line);
    } catch (err) {
      throw new Error(`${fileName}:${i + 1}: not valid JSON (${(err as Error).message})`);
    }
    if (!isObj(o) || typeof o['name'] !== 'string' || typeof o['info_output'] !== 'string') {
      throw new Error(`${fileName}:${i + 1}: each line needs a string "name" and "info_output"`);
    }
    const r: ExecRecord = { name: o['name'], info_output: o['info_output'] };
    for (const k of ['title', 'description', 'full_info_output', 'info_json_output', 'schema_output', 'returned_schema_plain_json'] as const) {
      const v = str(o[k]);
      if (v !== undefined) r[k] = v;
    }
    if (o['annotations'] !== undefined && o['annotations'] !== null) r.annotations = o['annotations'];
    if (o['full_schema'] !== undefined && o['full_schema'] !== null) r.full_schema = o['full_schema'];
    out.push(r);
  }
  return out;
}

function contractOf(r: ExecRecord): CatalogTool {
  const j = parseJson(r.info_json_output);
  const fromJson = isObj(j) ? j : {};
  const t: Record<string, unknown> = { name: r.name };
  const title = r.title ?? str(fromJson['title']);
  const description = r.description ?? str(fromJson['description']);
  const annotations = r.annotations ?? (isObj(fromJson['annotations']) ? fromJson['annotations'] : undefined);
  if (title !== undefined) t['title'] = title;
  if (description !== undefined) t['description'] = description;
  if (annotations !== undefined) t['annotations'] = annotations;
  const schema = r.full_schema ?? fromJson['inputSchema'];
  if (schema !== undefined) t['inputSchema'] = schema;
  return t as CatalogTool;
}

function countUnknownTypes(v: unknown): number {
  let n = 0;
  for (const [, node] of allSubtrees(v)) if (isObj(node) && node['type'] === 'unknown') n++;
  return n;
}

/** Build the sweep input from exec records (offline or freshly fetched). */
export function sweepInputFromExecRecords(
  records: readonly ExecRecord[],
  meta: Pick<SweepInput, 'server' | 'protocolVersion' | 'source'> & { adapter: string; wrapperTools?: CatalogTool[] | null; marker?: string; notes?: string[] },
): SweepInput {
  const marker = meta.marker ?? POSTHOG_EXEC.infoSchemaMarker!;
  const exposure: SweepInput['modelVisible'] = new Map();
  const views: SweepInput['views'] = new Map();
  const embeddedSchemas: SweepInput['embeddedSchemas'] = new Map();
  const findings: Finding[] = [];
  const tools: CatalogTool[] = [];
  for (const r of records) {
    const contract = contractOf(r);
    tools.push(contract);
    exposure.set(r.name, r.info_output);
    const v = new Map<string, string>();
    if (r.full_info_output !== undefined) v.set('infoFull', r.full_info_output);
    if (r.info_json_output !== undefined) v.set('infoJson', r.info_json_output);
    if (r.schema_output !== undefined) v.set('schema', r.schema_output);
    views.set(r.name, v);

    const at = r.info_output.lastIndexOf(marker);
    const plain =
      r.returned_schema_plain_json ??
      (() => {
        const j = parseJson(r.info_json_output);
        return isObj(j) && j['inputSchema'] !== undefined ? JSON.stringify(j['inputSchema']) : undefined;
      })();
    if (at >= 0 && plain !== undefined) embeddedSchemas.set(r.name, { escaped: r.info_output.slice(at + marker.length), plain });

    const unknown = countUnknownTypes(parseJson(r.schema_output));
    if (unknown > 0) {
      findings.push({
        rule: 'untyped-node',
        severity: 'info',
        tool: r.name,
        path: '',
        message: `the \`schema\` view shows ${unknown} field(s) as type "unknown"`,
        data: { view: 'schema', unknownTypes: unknown },
      });
    }
  }
  const notes = [...(meta.notes ?? [])];
  return {
    adapter: meta.adapter,
    server: meta.server,
    protocolVersion: meta.protocolVersion,
    source: meta.source,
    catalog: normalizeCatalog({ tools, prompts: [], resourceTemplates: [] }),
    orderedTools: tools,
    modelVisibleLabel: EXPOSURE_LABEL,
    wireLabel: EXPOSURE_LABEL,
    modelVisible: exposure,
    modelVisibleFromAdapter: true,
    wire: exposure,
    views,
    embeddedSchemas,
    wrapperTools: meta.wrapperTools ?? null,
    findings,
    notes,
  };
}

/** Tool names from a `tools`-style command output: JSON array/object, or one name per line / comma list. */
export function parseToolNames(text: string): string[] {
  const j = parseJson(text.trim());
  let raw: unknown[] | null = null;
  if (Array.isArray(j)) raw = j;
  else if (isObj(j) && Array.isArray(j['tools'])) raw = j['tools'];
  const names: string[] = [];
  if (raw) {
    for (const x of raw) {
      if (typeof x === 'string') names.push(x);
      else if (isObj(x) && typeof x['name'] === 'string') names.push(x['name']);
    }
  } else {
    const parts = text.includes('\n') ? text.split('\n') : text.split(',');
    for (const p of parts) {
      const m = /^[A-Za-z0-9][A-Za-z0-9._/:-]*/.exec(p.trim().replace(/^(?:[-*•]|\d+[.)])\s*/, '').replace(/^`|`$/g, ''));
      if (m && m[0].length > 1) names.push(m[0].replace(/[:.]$/, ''));
    }
  }
  return [...new Set(names)];
}

function render(template: string, name: string): string {
  return template.split('{name}').join(name);
}

/** The wrapper answered with `isError`: the server rejected the command (e.g. an unknown name). */
class ExecRejected extends Error {}

/** Default cap on names from the `tools` listing: the server is untrusted and each name costs three calls. */
export const MAX_EXEC_TOOLS = 2000;

/** Names that may be interpolated into a command string: no spaces, quotes, separators or control characters. */
export const EXEC_NAME = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function resultText(r: unknown): string {
  const o = isObj(r) ? r : {};
  const blocks = Array.isArray(o['content']) ? o['content'] : [];
  const text = blocks
    .filter((b): b is { type: 'text'; text: string } => isObj(b) && b['type'] === 'text' && typeof b['text'] === 'string')
    .map((b) => b.text)
    .join('\n');
  if (o['isError'] === true) throw new ExecRejected(text.slice(0, 300) || 'tool returned isError');
  return text;
}

export interface LiveExecOptions extends CaptureOptions {
  profile: ExecProfile;
  /** Parallel `exec` calls (default 4). */
  concurrency?: number;
  /** Most listed names this sweep will query (3 calls each; default MAX_EXEC_TOOLS). */
  maxExecTools?: number;
  nameOverride?: string;
}

/**
 * Drive a live exec-style server: list the wrapper's tools, run the list
 * command, then `info`, `info --json` and `schema` for every name. Names the
 * server rejects (`isError`) are dropped with a note. Read-only commands
 * only; never `call`.
 */
export async function sweepInputFromExecServer(target: Target, opts: LiveExecOptions): Promise<{ input: SweepInput; records: ExecRecord[] }> {
  let session: Session | undefined;
  return withDeadline(
    opts.totalTimeoutMs,
    () => session?.close(),
    async () => {
      session = await openSession(target, opts);
      try {
        return await sweepInputFromExecSession(session, opts, sourceOf(target));
      } catch (err) {
        throw session.explain(err);
      } finally {
        await session.close();
      }
    },
  );
}

/** Same as sweepInputFromExecServer over an already-open session (caller closes it). */
export async function sweepInputFromExecSession(
  session: Session,
  opts: Omit<LiveExecOptions, keyof CaptureOptions>,
  source: SweepInput['source'],
): Promise<{ input: SweepInput; records: ExecRecord[] }> {
  const p = opts.profile;
  const listed = await listCatalog(session);
  const wrapper = normalizeCatalog({ tools: listed.tools, prompts: [], resourceTemplates: [] }).tools;
  if (!wrapper.some((t) => t.name === p.tool)) {
    throw new Error(`server has no "${p.tool}" tool (tools/list: ${wrapper.map((t) => t.name).join(', ') || 'none'})`);
  }
  const run = async (command: string): Promise<string> => {
    const r = await session.client.callTool({ name: p.tool, arguments: { ...p.extraArgs, [p.commandArg]: command } }, undefined, {
      timeout: session.requestTimeoutMs,
    });
    return resultText(r);
  };
  const listedNames = parseToolNames(await run(p.list));
  const invalid = listedNames.filter((n) => !EXEC_NAME.test(n));
  const names = listedNames.filter((n) => EXEC_NAME.test(n));
  const maxTools = opts.maxExecTools ?? MAX_EXEC_TOOLS;
  if (names.length > maxTools) throw new Error(`\`${p.list}\` listed ${names.length} names, more than the ${maxTools} this sweep will query`);
  const records: ExecRecord[] = [];
  const rejected: string[] = [];
  const failed: { name: string; message: string }[] = [];
  const queue = [...names];
  await Promise.all(
    Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
      for (let name = queue.shift(); name !== undefined; name = queue.shift()) {
        try {
          const r: ExecRecord = { name, info_output: await run(render(p.info, name)), info_json_output: await run(render(p.infoJson, name)) };
          if (p.schema) r.schema_output = await run(render(p.schema, name));
          records.push(r);
        } catch (err) {
          if (err instanceof ExecRejected) rejected.push(name);
          else failed.push({ name, message: ((err as Error).message || 'error').slice(0, 200) });
        }
      }
    }),
  );
  records.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const notes = [
    `live exec sweep via "${p.tool}" (${records.length} tools); contracts come from \`${p.infoJson}\`, which the server may summarize for large tools`,
  ];
  if (invalid.length > 0) notes.push(`${invalid.length} listed name(s) have characters outside [A-Za-z0-9._:-] and were not sent`);
  if (rejected.length > 0) notes.push(`${rejected.length} listed name(s) were rejected by \`info\` (isError): ${rejected.sort().slice(0, 10).join(', ')}`);
  if (failed.length > 0) {
    failed.sort((a, b) => (a.name < b.name ? -1 : 1));
    notes.push(`${failed.length} tool(s) failed with a transport or timeout error: ${failed.slice(0, 5).map((f) => `${f.name} (${f.message})`).join(', ')}`);
    if (records.length === 0) throw new Error(`every exec call failed; first: ${failed[0]!.name}: ${failed[0]!.message}`);
  }
  const server: SweepInput['server'] = { name: opts.nameOverride ?? session.server.name, version: session.server.version || null };
  if (session.server.title !== undefined) server.title = session.server.title;
  const meta: Parameters<typeof sweepInputFromExecRecords>[1] = {
    adapter: p.id,
    server,
    protocolVersion: session.protocolVersion(),
    source,
    wrapperTools: wrapper,
    notes,
  };
  if (p.infoSchemaMarker !== undefined) meta.marker = p.infoSchemaMarker;
  return { input: sweepInputFromExecRecords(records, meta), records };
}

/** JSONL for `--save-raw`, re-readable with `--from` (deterministic: sorted, canonical keys). */
export function serializeExecRecords(records: readonly ExecRecord[]): string {
  return records.map((r) => canonicalJson(r)).join('\n') + (records.length > 0 ? '\n' : '');
}
