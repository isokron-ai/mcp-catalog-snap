/**
 * Flag matrix: one capture per flag set, and a report of which tools,
 * prompts and resource templates appear, disappear or change between sets.
 *
 * A server registers one tool per name, and which definition it registers
 * often depends on how it was started: `--read-only` drops write tools, a
 * toolset flag adds a group, a "destructive" switch swaps a tool for a
 * narrower one under the same name. A single snapshot shows one of these
 * catalogs and hides the others. The matrix captures each set in turn (one
 * server launch per set, sequentially), writes a format-2 snapshot per set,
 * and groups every entry's definitions across sets into variants (A, B, ...)
 * by fingerprint, so a name that means different things under different
 * flags is visible as such.
 *
 * ```json
 * [
 *   { "name": "default" },
 *   { "name": "read-only", "args": ["--read-only"] },
 *   { "name": "helm", "args": ["--toolsets", "core,helm"], "env": { "X": "y" } }
 * ]
 * ```
 *
 * `args` are appended to the server's command line and `env` is layered on
 * its environment (stdio targets); `headers` are added to an HTTP target's
 * headers. The first set is the baseline the others are compared with.
 */

import { fingerprint, type JsonValue } from './canonical.js';
import type { HttpTarget, StdioTarget, Target } from './capture.js';
import { expandEnv } from './config.js';
import { SECTIONS, diffCatalogs, diffValues, indexSection, toolSafety, type PathChange, type SafetyDiff, type Section, type ToolSafety } from './diff.js';
import type { LaunchRecord } from './launch.js';
import { assertCredentialLengths } from './redact.js';
import { safetyLines } from './render.js';
import { visible } from './safe-text.js';
import type { ServerInfo, Snapshot } from './snapshot.js';
import { VERSION } from './version.js';

export const MATRIX_FORMAT = 'mcp-catalog-snap/matrix/1';
/** File name of the matrix report inside `<dir>/<server>.matrix/` (set names cannot start with `_`). */
export const MATRIX_REPORT_FILE = '_matrix.json';
/** Most flag sets one run takes. */
export const MAX_FLAG_SETS = 64;

const SET_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export interface FlagSet {
  /** File-name-safe: letters, digits, `.`, `_`, `-`; starts with a letter or digit. */
  name: string;
  /** stdio: arguments appended to the server's command line. */
  args?: string[];
  /** stdio: environment variables for this set, on top of the server's `env`. */
  env?: Record<string, string>;
  /** http: headers for this set, on top of the server's `headers`. */
  headers?: Record<string, string>;
}

function stringRecord(v: unknown, where: string, env: NodeJS.ProcessEnv): Record<string, string> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${where} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
    if (typeof x !== 'string') throw new Error(`${where}.${k} must be a string`);
    out[k] = expandEnv(x, env);
  }
  return out;
}

/**
 * Parse flag sets: an array of `{name, args?, env?, headers?}`, or an object
 * with such an array under `flagSets`. `${VAR}` is expanded as in the config
 * file. Names must be unique (case-insensitively: they become file names).
 */
export function parseFlagSets(raw: unknown, where: string, env: NodeJS.ProcessEnv = process.env): FlagSet[] {
  const list = Array.isArray(raw) ? raw : raw !== null && typeof raw === 'object' ? (raw as Record<string, unknown>)['flagSets'] : undefined;
  if (!Array.isArray(list)) throw new Error(`${where}: expected an array of flag sets (or {"flagSets": [...]})`);
  if (list.length === 0) throw new Error(`${where}: no flag sets`);
  if (list.length > MAX_FLAG_SETS) throw new Error(`${where}: ${list.length} flag sets, more than the ${MAX_FLAG_SETS} one run takes`);
  const seen = new Set<string>();
  return list.map((entry, i) => {
    const at = `${where}[${i}]`;
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${at} must be an object`);
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!['name', 'args', 'env', 'headers'].includes(k)) throw new Error(`${at}: unknown key "${k}" (expected name, args, env, headers)`);
    }
    const name = e['name'];
    if (typeof name !== 'string' || !SET_NAME.test(name)) {
      throw new Error(`${at}.name must be 1-64 letters, digits, ".", "_" or "-", starting with a letter or digit`);
    }
    if (seen.has(name.toLowerCase())) throw new Error(`${where}: duplicate flag set name "${name}"`);
    seen.add(name.toLowerCase());
    const set: FlagSet = { name };
    if (e['args'] !== undefined) {
      if (!Array.isArray(e['args']) || !e['args'].every((a) => typeof a === 'string')) throw new Error(`${at}.args must be an array of strings`);
      set.args = (e['args'] as string[]).map((a) => expandEnv(a, env));
    }
    if (e['env'] !== undefined) set.env = stringRecord(e['env'], `${at}.env`, env);
    if (e['headers'] !== undefined) set.headers = stringRecord(e['headers'], `${at}.headers`, env);
    return set;
  });
}

/** The target for one flag set: base args + set args, base env + set env (stdio); base headers + set headers (http). */
export function applyFlagSet(target: Target, set: FlagSet): Target {
  if (target.kind === 'stdio') {
    if (set.headers !== undefined) throw new Error(`flag set "${set.name}": "headers" apply to --url targets; a stdio server takes "args" and "env"`);
    const t: StdioTarget = { ...target, args: [...target.args, ...(set.args ?? [])] };
    if (set.env !== undefined) t.env = { ...(target.env ?? {}), ...set.env };
    return t;
  }
  if (set.args !== undefined || set.env !== undefined) {
    throw new Error(`flag set "${set.name}": "args" and "env" apply to stdio servers; an HTTP server takes "headers"`);
  }
  const t: HttpTarget = { ...target };
  if (set.headers !== undefined) t.headers = { ...(target.headers ?? {}), ...set.headers };
  assertCredentialLengths(t);
  return t;
}

/** One set's outcome, as `matrix` collects it. */
export interface MatrixCapture {
  set: FlagSet;
  /** How this set's server was launched (credentials masked). */
  launch: LaunchRecord | null;
  snapshot?: Snapshot;
  /** File name of the set's snapshot inside the matrix directory. */
  file?: string;
  error?: string;
}

export interface MatrixVariant {
  /** A, B, C, ... in order of first appearance across the sets. */
  id: string;
  sets: string[];
  /** sha256 of the entry's canonical JSON. */
  sha256: string;
  /** Tools: classification from the variant's annotations. */
  safety?: ToolSafety;
  /** Tools: the variant's annotations (null when it has none). */
  annotations?: JsonValue;
}

export interface MatrixEntry {
  key: string;
  presentIn: string[];
  absentFrom: string[];
  /** Present in every captured set with one definition. */
  uniform: boolean;
  variants: MatrixVariant[];
  /** For each variant after the first: what differs from variant A. */
  changes: { from: string; to: string; changes: PathChange[] }[];
}

export interface MatrixSetResult {
  name: string;
  ok: boolean;
  error?: string;
  /** Snapshot file name inside the matrix directory. */
  snapshot?: string;
  sha256?: string;
  counts?: Record<Section, number>;
  protocol?: { requested: string | null; negotiated: string | null };
  launch: LaunchRecord | null;
}

export interface MatrixVersusBaseline {
  set: string;
  identical: boolean;
  added: Record<Section, string[]>;
  removed: Record<Section, string[]>;
  changed: Record<Section, string[]>;
  safety: SafetyDiff;
}

export interface MatrixReport {
  format: typeof MATRIX_FORMAT;
  capturedWith: string;
  server: ServerInfo | null;
  /** The first set that was captured; null when none was. */
  baseline: string | null;
  sets: MatrixSetResult[];
  sections: Record<Section, MatrixEntry[]>;
  summary: Record<Section, { total: number; uniform: number; varying: number }>;
  versusBaseline: MatrixVersusBaseline[];
}

/** A, B, ..., Z, AA, AB, ... */
export function variantId(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function bySection<T>(f: (s: Section) => T): Record<Section, T> {
  return { tools: f('tools'), prompts: f('prompts'), resourceTemplates: f('resourceTemplates') };
}

function matrixSection(ok: { name: string; snap: Snapshot }[], section: Section): MatrixEntry[] {
  const indexed = ok.map((o) => ({ name: o.name, idx: indexSection(o.snap.catalog, section) }));
  const keys = [...new Set(indexed.flatMap((x) => [...x.idx.keys()]))].sort();
  return keys.map((key) => {
    const variants: (MatrixVariant & { entry: JsonValue })[] = [];
    const presentIn: string[] = [];
    const absentFrom: string[] = [];
    for (const { name, idx } of indexed) {
      const entry = idx.get(key);
      if (entry === undefined) {
        absentFrom.push(name);
        continue;
      }
      presentIn.push(name);
      const sha256 = fingerprint(entry);
      const hit = variants.find((v) => v.sha256 === sha256);
      if (hit) {
        hit.sets.push(name);
        continue;
      }
      const v: MatrixVariant & { entry: JsonValue } = { id: variantId(variants.length), sets: [name], sha256, entry };
      if (section === 'tools') {
        v.safety = toolSafety(entry);
        const a = (entry as { [k: string]: JsonValue })['annotations'];
        v.annotations = a === undefined ? null : a;
      }
      variants.push(v);
    }
    const first = variants[0]!;
    const changes = variants.slice(1).map((v) => ({ from: first.id, to: v.id, changes: diffValues(first.entry, v.entry) }));
    return {
      key,
      presentIn,
      absentFrom,
      uniform: absentFrom.length === 0 && variants.length === 1,
      variants: variants.map(({ entry: _entry, ...rest }) => rest),
      changes,
    };
  });
}

/** Build the matrix report from the per-set captures (failed sets are listed, and left out of the comparison). */
export function buildMatrix(captures: readonly MatrixCapture[]): MatrixReport {
  const ok = captures.filter((c): c is MatrixCapture & { snapshot: Snapshot } => c.snapshot !== undefined).map((c) => ({ name: c.set.name, snap: c.snapshot }));
  const sets: MatrixSetResult[] = captures.map((c) => {
    if (!c.snapshot) return { name: c.set.name, ok: false, error: c.error ?? 'not captured', launch: c.launch };
    const s = c.snapshot;
    const r: MatrixSetResult = {
      name: c.set.name,
      ok: true,
      sha256: s.sha256,
      counts: bySection((x) => s.catalog[x].length),
      protocol: { requested: s.handshake?.requestedProtocolVersion ?? null, negotiated: s.handshake?.negotiatedProtocolVersion ?? s.protocolVersion },
      launch: c.launch,
    };
    if (c.file !== undefined) r.snapshot = c.file;
    return r;
  });
  const sections = bySection((s) => matrixSection(ok, s));
  const base = ok[0];
  const versusBaseline: MatrixVersusBaseline[] = base
    ? ok.slice(1).map(({ name, snap }) => {
        const d = diffCatalogs(base.snap.catalog, snap.catalog);
        const sec = (s: Section) => d.sections.find((x) => x.section === s)!;
        return {
          set: name,
          identical: d.identical,
          added: bySection((s) => sec(s).added),
          removed: bySection((s) => sec(s).removed),
          changed: bySection((s) => sec(s).changed.map((c) => c.key)),
          safety: d.safety,
        };
      })
    : [];
  return {
    format: MATRIX_FORMAT,
    capturedWith: `mcp-catalog-snap/${VERSION}`,
    server: base ? { ...base.snap.server } : null,
    baseline: base ? base.name : null,
    sets,
    sections,
    summary: bySection((s) => {
      const uniform = sections[s].filter((e) => e.uniform).length;
      return { total: sections[s].length, uniform, varying: sections[s].length - uniform };
    }),
    versusBaseline,
  };
}

const LABEL: Record<Section, string> = { tools: 'tools', prompts: 'prompts', resourceTemplates: 'resource templates' };
const SHORT_SAFETY: Record<ToolSafety, string> = { 'read-only': 'ro', write: 'write', destructive: 'destr' };
const MAX_PATHS = 8;

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

/** Human-readable matrix: per-set summary, a presence/variant table of the entries that differ, and each set against the baseline. */
export function renderMatrix(r: MatrixReport): string {
  const L: string[] = [];
  const ok = r.sets.filter((s) => s.ok);
  const server = r.server ? `${visible(r.server.name)} ${visible(r.server.version)}` : '(no set captured)';
  L.push(`flag matrix: ${server}, ${r.sets.length} flag set(s), ${ok.length} captured${r.baseline ? `, baseline "${r.baseline}"` : ''}`);
  const w = Math.max(...r.sets.map((s) => s.name.length));
  for (const s of r.sets) {
    if (!s.ok) {
      L.push(`  ${pad(s.name, w)}  error: ${visible(s.error ?? '')}`);
      continue;
    }
    const c = s.counts!;
    const proto = s.protocol?.requested && s.protocol.requested !== s.protocol.negotiated ? ` (requested ${visible(s.protocol.requested)})` : '';
    L.push(
      `  ${pad(s.name, w)}  ${c.tools} tools, ${c.prompts} prompts, ${c.resourceTemplates} templates  ` +
        `protocol ${visible(s.protocol?.negotiated ?? '(unknown)')}${proto}  sha256 ${s.sha256}`,
    );
  }
  for (const section of SECTIONS) {
    const entries = r.sections[section];
    const sum = r.summary[section];
    if (sum.total === 0) continue;
    L.push('');
    L.push(`${LABEL[section]}: ${sum.total} across all sets, ${sum.uniform} identical in every set, ${sum.varying} differ`);
    const varying = entries.filter((e) => !e.uniform);
    if (varying.length === 0) continue;
    const cell = (e: MatrixEntry, set: string): string => {
      const v = e.variants.find((x) => x.sets.includes(set));
      if (!v) return '-';
      return v.safety ? `${v.id} ${SHORT_SAFETY[v.safety]}` : v.id;
    };
    const keyW = Math.min(48, Math.max(4, ...varying.map((e) => visible(e.key).length)));
    const colW = ok.map((s) => Math.max(s.name.length, 8));
    L.push(`  ${pad(section === 'resourceTemplates' ? 'uriTemplate' : 'name', keyW)}  ${ok.map((s, i) => pad(s.name, colW[i]!)).join('  ')}`.trimEnd());
    for (const e of varying) {
      L.push(`  ${pad(visible(e.key), keyW)}  ${ok.map((s, i) => pad(cell(e, s.name), colW[i]!)).join('  ')}`.trimEnd());
    }
    for (const e of varying) {
      for (const ch of e.changes) {
        const paths = ch.changes.map((c) => visible(c.path));
        const more = paths.length > MAX_PATHS ? `, … +${paths.length - MAX_PATHS} more` : '';
        L.push(`  ${visible(e.key)}: ${ch.from} -> ${ch.to}: ${paths.slice(0, MAX_PATHS).join(', ')}${more}`);
      }
    }
  }
  if (r.versusBaseline.length > 0) {
    L.push('');
    L.push(`versus baseline "${r.baseline}":`);
    for (const v of r.versusBaseline) {
      if (v.identical) {
        L.push(`  ${pad(v.set, w)}  identical`);
        continue;
      }
      const parts = SECTIONS.filter((s) => v.added[s].length + v.removed[s].length + v.changed[s].length > 0).map(
        (s) => `${LABEL[s]} +${v.added[s].length} -${v.removed[s].length} ~${v.changed[s].length}`,
      );
      L.push(`  ${pad(v.set, w)}  ${parts.join(', ')}`);
      for (const line of safetyLines(v)) L.push(`    ${line}`);
    }
  }
  return L.join('\n');
}
