/**
 * Static findings over a tool catalog.
 *
 * Every rule is pure over the tool entry (plus an optional reference
 * tokenizer for savings estimates), so the same catalog always yields the
 * same findings in the same order. Rule ids are part of the report schema:
 * rename one only with a report-format bump.
 */

import { canonicalJson, type JsonValue } from './canonical.js';
import { measure } from './metrics.js';
import {
  allStrings,
  allSubtrees,
  isObj,
  PathSet,
  pointer,
  schemaNodes,
  setAt,
  type Obj,
  type Path,
} from './schema-walk.js';
import type { CatalogTool } from './snapshot.js';
import { utf8Bytes, type Tokenizer } from './tokenize.js';
import { keywordProblems, validateValue } from './validate.js';

export type Severity = 'error' | 'warn' | 'info';

export const RULES = {
  'schema-missing': { severity: 'error', summary: 'tool has no inputSchema object' },
  'schema-invalid': { severity: 'error', summary: 'inputSchema uses a keyword with an invalid value, or its root is not type "object"' },
  'required-not-in-properties': { severity: 'warn', summary: '`required` names a property the object does not define' },
  'default-invalid': { severity: 'warn', summary: '`default` fails its own schema' },
  'enum-large': { severity: 'warn', summary: 'enum / const-union with more values than the cap' },
  'description-repeats-enum': { severity: 'warn', summary: 'description spells out values the enum already lists' },
  'enum-in-prose': { severity: 'warn', summary: 'allowed values listed only in a description, with no enum to enforce them' },
  'duplicate-subtree': { severity: 'warn', summary: 'repeated schema subtrees that $defs/$ref could emit once' },
  'description-oversize': { severity: 'warn', summary: 'description longer than the cap (descriptions are untrusted text)' },
  'escaped-json': { severity: 'info', summary: 'JSON carried as an escaped string, paying escape overhead' },
  'untyped-node': { severity: 'info', summary: 'schema nodes that accept anything ({} / items: {} / opaque objects)' },
  'oversize-tool': { severity: 'warn', summary: 'tool exposure is over the per-tool token budget' },
  'oversize-catalog': { severity: 'error', summary: 'catalog exposure is over the catalog token budget' },
  'annotations-missing': { severity: 'info', summary: 'no readOnlyHint / destructiveHint annotation' },
  'annotation-contradiction': { severity: 'warn', summary: 'annotations contradict each other or the tool name' },
  'output-duplication-risk': { severity: 'info', summary: 'declares outputSchema: results may repeat structuredContent as text' },
  'structured-content-duplicated': { severity: 'warn', summary: 'observed result repeats structuredContent verbatim in a text block' },
} as const satisfies Record<string, { severity: Severity; summary: string }>;

export type RuleId = keyof typeof RULES;

export interface Finding {
  rule: RuleId;
  severity: Severity;
  /** Tool name, or null for a catalog-level finding. */
  tool: string | null;
  /** RFC 6901 pointer into the tool entry ("" = the entry itself). */
  path: string;
  message: string;
  data?: { [key: string]: JsonValue };
}

export interface FindingsOptions {
  /** enum / const-union size above which `enum-large` fires (default 20). */
  enumMax?: number;
  /** Smallest serialized subtree, in bytes, considered for duplication (default 200). */
  subtreeMinBytes?: number;
  /**
   * Descriptions are untrusted text: one over this many UTF-8 bytes gets a
   * `description-oversize` finding (default 16384). Strings over 1 MiB are
   * measured but never scanned or parsed.
   */
  maxDescriptionBytes?: number;
  /** Reference tokenizer for $defs savings estimates (bytes only when absent). */
  tokenizer?: Tokenizer;
}

const DEFAULTS = { enumMax: 20, subtreeMinBytes: 200, maxDescriptionBytes: 16_384 };

/** Strings longer than this (UTF-16 units) are never regex-scanned or JSON-parsed. */
export const ANALYZE_MAX_CHARS = 1 << 20;

export interface ChoiceList {
  path: string;
  kind: 'enum' | 'const-union' | 'drf-description';
  count: number;
  bytes: number;
  /** Values are spelled out in both an enum and a description list. */
  duplicated: boolean;
}

export interface DuplicateStats {
  /** Bytes that would disappear if every repeat were emitted once. */
  wasteBytes: number;
  /** wasteBytes as a share of the JCS inputSchema bytes (0..1). */
  share: number;
  groups: number;
  maxRepeat: number;
  /** Largest offenders by waste: pointer of the first occurrence × count. */
  top: { path: string; count: number; bytes: number; wasteBytes: number }[];
  /** $defs/$ref rewrite estimate (only repeats in schema positions, only where net-positive). */
  defs: { created: number; bytesBefore: number; bytesAfter: number; tokensBefore: number | null; tokensAfter: number | null };
}

export interface UntypedStats {
  emptyItems: number;
  opaqueObjects: number;
  noTypeNodes: number;
  examples: string[];
}

export interface ToolAnalysis {
  tool: string;
  choiceLists: ChoiceList[];
  duplicates: DuplicateStats;
  untyped: UntypedStats;
  findings: Finding[];
}

/* ------------------------------------------------------------------ */
/* helpers                                                            */
/* ------------------------------------------------------------------ */

function sev(rule: RuleId): Severity {
  return RULES[rule].severity;
}

function finding(rule: RuleId, tool: string | null, path: Path | string, message: string, data?: Finding['data'], severity?: Severity): Finding {
  const f: Finding = { rule, severity: severity ?? sev(rule), tool, path: typeof path === 'string' ? path : pointer(path), message };
  if (data !== undefined) f.data = data;
  return f;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareFindings(a: Finding, b: Finding): number {
  return cmp(a.tool ?? '', b.tool ?? '') || cmp(a.rule, b.rule) || cmp(a.path, b.path) || cmp(a.message, b.message);
}

const SCHEMA_ROOT: Path = ['inputSchema'];

/* ------------------------------------------------------------------ */
/* choice lists (enum histogram, DRF description lists)               */
/* ------------------------------------------------------------------ */

/** Django REST Framework style `* \`value\` - Label` lines. */
const DRF_LINE = /^\* `(.*?)` - .*$/gm;

export function drfValues(desc: unknown): string[] {
  if (typeof desc !== 'string' || desc.length > ANALYZE_MAX_CHARS) return [];
  return [...desc.matchAll(DRF_LINE)].map((m) => m[1]!);
}

function choiceValues(node: Obj): { kind: 'enum' | 'const-union'; values: unknown[] } | null {
  if (Array.isArray(node['enum'])) return { kind: 'enum', values: node['enum'] };
  for (const k of ['anyOf', 'oneOf']) {
    const br = node[k];
    if (Array.isArray(br) && br.length >= 2 && br.every((b) => isObj(b) && 'const' in b)) {
      return { kind: 'const-union', values: br.map((b) => (b as Obj)['const']) };
    }
  }
  return null;
}

/** Enum/const values reachable through items/anyOf/oneOf/allOf (not into properties). */
function enumValuesIn(node: unknown, depth = 0): Set<string> {
  const vals = new Set<string>();
  if (!isObj(node) || depth > 6) return vals;
  const c = choiceValues(node);
  if (c) for (const v of c.values) vals.add(String(v));
  if ('const' in node) vals.add(String(node['const']));
  for (const k of ['anyOf', 'oneOf', 'allOf']) {
    const br = node[k];
    if (Array.isArray(br)) for (const b of br) for (const v of enumValuesIn(b, depth + 1)) vals.add(v);
  }
  if (isObj(node['items'])) for (const v of enumValuesIn(node['items'], depth + 1)) vals.add(v);
  return vals;
}

function choiceLists(schema: unknown): ChoiceList[] {
  const out: (ChoiceList & { raw: Path })[] = [];
  for (const [p, n] of schemaNodes(schema)) {
    const c = choiceValues(n);
    const drf = drfValues(n['description']);
    if (c) {
      const sv = new Set(c.values.map(String));
      const overlap = drf.filter((v) => sv.has(v)).length;
      out.push({
        path: pointer([...SCHEMA_ROOT, ...p]),
        kind: c.kind,
        count: c.values.length,
        bytes: utf8Bytes(canonicalJson(c.values)),
        duplicated: drf.length > 0 && new Set(drf.filter((v) => sv.has(v))).size >= 0.8 * sv.size && overlap > 0,
        raw: p,
      });
    }
    if (drf.length > 0) {
      const ev = enumValuesIn(n);
      const text = [...(n['description'] as string).matchAll(DRF_LINE)].map((m) => m[0]).join('\n');
      out.push({
        path: pointer([...SCHEMA_ROOT, ...p]),
        kind: 'drf-description',
        count: drf.length,
        bytes: utf8Bytes(text) + 1,
        duplicated: ev.size > 0 && drf.every((v) => ev.has(v)),
        raw: p,
      });
    }
  }
  // A DRF list on a nullable wrapper whose enum sits a level or three down also duplicates that enum.
  const drfByPath = new Map(out.filter((c) => c.kind === 'drf-description').map((c) => [JSON.stringify(c.raw), c]));
  for (const c of out) {
    if (c.kind === 'drf-description' || c.duplicated) continue;
    for (let k = 1; k <= 3 && k <= c.raw.length; k++) {
      const parent = drfByPath.get(JSON.stringify(c.raw.slice(0, -k)));
      if (parent?.duplicated) c.duplicated = true;
    }
  }
  return out.map(({ raw: _raw, ...rest }) => rest);
}

/* ------------------------------------------------------------------ */
/* duplicated subtrees + $defs opportunity                            */
/* ------------------------------------------------------------------ */

function duplicateStats(schema: unknown, minBytes: number, tok: Tokenizer | undefined): DuplicateStats {
  const schemaText = schema === undefined ? '' : canonicalJson(schema);
  const total = utf8Bytes(schemaText);
  const occ = collectRepeats(allSubtrees(schema), minBytes, () => false);
  const removed = new PathSet();
  let waste = 0;
  let groups = 0;
  let maxRepeat = 0;
  const top: DuplicateStats['top'] = [];
  for (const [, { bytes, paths }] of occ) {
    const live = paths.filter((p) => !removed.covers(p));
    if (live.length < 2) continue;
    const w = (live.length - 1) * bytes;
    groups++;
    waste += w;
    maxRepeat = Math.max(maxRepeat, live.length);
    top.push({ path: pointer([...SCHEMA_ROOT, ...live[0]!]), count: live.length, bytes, wasteBytes: w });
    for (const p of live.slice(1)) removed.add(p);
  }
  top.sort((a, b) => b.wasteBytes - a.wasteBytes || cmp(a.path, b.path));
  const deduped = dedupRefs(schema, minBytes);
  const afterText = deduped.created > 0 ? canonicalJson(deduped.schema) : schemaText;
  return {
    wasteBytes: waste,
    share: total === 0 ? 0 : waste / total,
    groups,
    maxRepeat,
    top: top.slice(0, 5),
    defs: {
      created: deduped.created,
      bytesBefore: total,
      bytesAfter: utf8Bytes(afterText),
      tokensBefore: tok ? tok.count(schemaText) : null,
      tokensAfter: tok ? (deduped.created > 0 ? tok.count(afterText) : tok.count(schemaText)) : null,
    },
  };
}

interface Repeat {
  bytes: number;
  paths: Path[];
}

/**
 * Group subtrees by canonical text (≥ minBytes, root excluded), returned
 * largest first (ties by text) so greedy accounting is deterministic.
 */
function collectRepeats(nodes: Iterable<[Path, unknown]>, minBytes: number, skip: (p: Path, n: unknown) => boolean): [string, Repeat][] {
  const occ = new Map<string, Repeat>();
  for (const [p, n] of nodes) {
    if (p.length === 0 || skip(p, n)) continue;
    const s = canonicalJson(n);
    // UTF-8 is at most 3 bytes per UTF-16 unit: skip the byte count when it cannot reach minBytes.
    if (s.length * 3 < minBytes) continue;
    let r = occ.get(s);
    if (!r) {
      const bytes = utf8Bytes(s);
      if (bytes < minBytes) continue;
      occ.set(s, (r = { bytes, paths: [] }));
    }
    r.paths.push(p);
  }
  return [...occ.entries()].sort(([a, ra], [b, rb]) => rb.bytes - ra.bytes || cmp(a, b));
}

/**
 * Emit repeated schema-position subtrees once under root `$defs` and point
 * every occurrence at it, largest first, only where the rewrite is smaller.
 * Existing `$defs` entries are kept; new ones are named `_dupN`.
 */
export function dedupRefs(schema: unknown, minBytes = DEFAULTS.subtreeMinBytes): { schema: unknown; created: number } {
  if (!isObj(schema)) return { schema, created: 0 };
  const work = JSON.parse(JSON.stringify(schema)) as Obj;
  const existing = isObj(work['$defs']) ? (work['$defs'] as Obj) : undefined;
  const defs: Obj = existing ?? {};
  let created = 0;
  let next = 0;
  for (;;) {
    if (created > 0 || existing) work['$defs'] = defs;
    const occ = collectRepeats(
      schemaNodes(work),
      minBytes,
      (p, n) => (p.length === 2 && p[0] === '$defs') || (isObj(n) && typeof n['$ref'] === 'string' && Object.keys(n).length === 1),
    );
    const replaced = new PathSet();
    let changed = false;
    for (const [s, { bytes: size, paths }] of occ) {
      const live = paths.filter((p) => !replaced.covers(p) && !replaced.containsUnder(p));
      if (live.length < 2) continue;
      let name = `_dup${next}`;
      while (name in defs) name = `_dup${++next}`;
      const ref = { $ref: `#/$defs/${name}` };
      const cost = utf8Bytes(canonicalJson(ref)) * live.length + utf8Bytes(canonicalJson({ [name]: null })) - 4 + size;
      if (cost >= size * live.length) continue;
      next++;
      created++;
      defs[name] = JSON.parse(s) as unknown;
      for (const p of live) {
        setAt(work, p, { ...ref });
        replaced.add(p);
      }
      changed = true;
    }
    if (!changed) break;
  }
  if (created === 0 && !existing) delete work['$defs'];
  return { schema: work, created };
}

/* ------------------------------------------------------------------ */
/* untyped nodes                                                      */
/* ------------------------------------------------------------------ */

const STRUCTURAL = ['type', 'anyOf', 'oneOf', 'allOf', 'enum', 'const', '$ref', 'properties', 'items', 'not'];

function untypedStats(schema: unknown): UntypedStats {
  const st: UntypedStats = { emptyItems: 0, opaqueObjects: 0, noTypeNodes: 0, examples: [] };
  const note = (p: Path): void => {
    if (st.examples.length < 5) st.examples.push(pointer([...SCHEMA_ROOT, ...p]));
  };
  for (const [p, n] of schemaNodes(schema)) {
    if (p.length === 0) continue;
    const items = n['items'];
    if (isObj(items) && Object.keys(items).length === 0) {
      st.emptyItems++;
      note([...p, 'items']);
    }
    if (n['type'] === 'object' && !('properties' in n) && 'additionalProperties' in n) st.opaqueObjects++;
    const isEmptyItems = p[p.length - 1] === 'items' && Object.keys(n).length === 0;
    if (!STRUCTURAL.some((k) => k in n) && !isEmptyItems) {
      st.noTypeNodes++;
      note(p);
    }
  }
  return st;
}

/* ------------------------------------------------------------------ */
/* annotations                                                        */
/* ------------------------------------------------------------------ */

/** Words marking a step that does not itself execute the verb (two-phase `*-delete-prepare`, previews). */
const NON_EXECUTING = new Set(['prepare', 'preview', 'plan', 'dry', 'dryrun', 'simulate', 'validate', 'estimate']);
const DESTRUCTIVE_VERBS = new Set(['delete', 'remove', 'destroy', 'drop', 'purge', 'erase', 'wipe', 'truncate', 'revoke', 'uninstall', 'terminate', 'kill']);

/** Lower-case words of a tool name: `deleteUser`, `user-delete`, `user.delete_all` → … */
export function nameWords(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

function annotationFindings(tool: CatalogTool): Finding[] {
  const out: Finding[] = [];
  const a = isObj(tool.annotations) ? (tool.annotations as Obj) : undefined;
  const ro = a?.['readOnlyHint'];
  const de = a?.['destructiveHint'];
  if (ro === undefined && de === undefined) {
    out.push(finding('annotations-missing', tool.name, a ? ['annotations'] : '', 'no readOnlyHint or destructiveHint; clients must assume the tool may destroy data'));
  }
  const words = nameWords(tool.name);
  const verb = words.some((w) => NON_EXECUTING.has(w)) ? undefined : words.find((w) => DESTRUCTIVE_VERBS.has(w));
  if (verb && ro === true) {
    out.push(finding('annotation-contradiction', tool.name, ['annotations', 'readOnlyHint'], `name says "${verb}" but readOnlyHint is true`, { verb }, 'error'));
  } else if (verb && de === false) {
    out.push(finding('annotation-contradiction', tool.name, ['annotations', 'destructiveHint'], `name says "${verb}" but destructiveHint is false`, { verb }));
  }
  if (ro === true && de === true) {
    out.push(finding('annotation-contradiction', tool.name, ['annotations'], 'readOnlyHint and destructiveHint are both true'));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* structural validity                                                */
/* ------------------------------------------------------------------ */

function validityFindings(tool: CatalogTool): Finding[] {
  const out: Finding[] = [];
  const schema = tool.inputSchema as unknown;
  if (!isObj(schema)) {
    out.push(finding('schema-missing', tool.name, schema === undefined ? '' : SCHEMA_ROOT, schema === undefined ? 'no inputSchema' : 'inputSchema is not an object'));
    return out;
  }
  if (schema['type'] !== 'object') {
    out.push(finding('schema-invalid', tool.name, [...SCHEMA_ROOT, 'type'], `root type is ${JSON.stringify(schema['type'] ?? null)}; MCP requires "object"`));
  }
  for (const [p, n] of schemaNodes(schema)) {
    for (const problem of keywordProblems(n, schema)) out.push(finding('schema-invalid', tool.name, [...SCHEMA_ROOT, ...p], problem));

    const req = n['required'];
    if (Array.isArray(req) && isObj(n['properties'])) {
      const known = new Set(Object.keys(n['properties']));
      for (const k of ['allOf', 'anyOf', 'oneOf']) {
        const br = n[k];
        if (Array.isArray(br)) for (const b of br) if (isObj(b) && isObj(b['properties'])) for (const x of Object.keys(b['properties'])) known.add(x);
      }
      const hasPattern = isObj(n['patternProperties']);
      const closed = n['additionalProperties'] === false;
      for (const name of req) {
        if (typeof name !== 'string' || known.has(name) || hasPattern) continue;
        out.push(
          finding(
            'required-not-in-properties',
            tool.name,
            [...SCHEMA_ROOT, ...p, 'required'],
            closed ? `"${name}" is required but not defined, and additionalProperties is false: no input can satisfy it` : `"${name}" is required but not defined in properties`,
            { property: name },
            closed ? 'error' : undefined,
          ),
        );
      }
    }

    if ('default' in n) {
      const { default: dv, ...rest } = n;
      const reason = validateValue(dv, rest, schema);
      if (reason) out.push(finding('default-invalid', tool.name, [...SCHEMA_ROOT, ...p, 'default'], reason));
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* escaped JSON inside string values                                  */
/* ------------------------------------------------------------------ */

const MIN_ESCAPED_JSON_BYTES = 40;

function escapedJsonFindings(tool: CatalogTool): Finding[] {
  const out: Finding[] = [];
  for (const [p, s] of allStrings(tool)) {
    if (s.length > ANALYZE_MAX_CHARS) continue;
    const t = s.trim();
    if (t.length < MIN_ESCAPED_JSON_BYTES || !(t.startsWith('{') || t.startsWith('['))) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(t);
    } catch {
      continue;
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    const overhead = utf8Bytes(JSON.stringify(s)) - 2 - utf8Bytes(s);
    if (overhead <= 0) continue;
    out.push(
      finding('escaped-json', tool.name, p, `string holds a JSON ${Array.isArray(parsed) ? 'array' : 'object'}; escaping adds ${overhead} bytes`, {
        bytes: utf8Bytes(s),
        overheadBytes: overhead,
      }),
    );
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* untrusted description size                                         */
/* ------------------------------------------------------------------ */

function descriptionSizeFindings(tool: CatalogTool, cap: number): Finding[] {
  const out: Finding[] = [];
  for (const [p, s] of allStrings(tool)) {
    if (p[p.length - 1] !== 'description') continue;
    const bytes = utf8Bytes(s);
    if (bytes > cap) out.push(finding('description-oversize', tool.name, p, `description is ${bytes} bytes (cap ${cap})`, { bytes, cap }));
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* per tool                                                           */
/* ------------------------------------------------------------------ */

export function analyzeTool(tool: CatalogTool, opts: FindingsOptions = {}): ToolAnalysis {
  const enumMax = opts.enumMax ?? DEFAULTS.enumMax;
  const minBytes = opts.subtreeMinBytes ?? DEFAULTS.subtreeMinBytes;
  const schema = tool.inputSchema as unknown;
  const findings: Finding[] = [];

  findings.push(...validityFindings(tool));

  const lists = isObj(schema) ? choiceLists(schema) : [];
  for (const c of lists) {
    if (c.kind !== 'drf-description' && c.count > enumMax) {
      findings.push(finding('enum-large', tool.name, c.path, `${c.kind} with ${c.count} values (cap ${enumMax})`, { count: c.count, bytes: c.bytes }));
    }
    if (c.kind === 'drf-description') {
      if (c.duplicated) {
        findings.push(finding('description-repeats-enum', tool.name, `${c.path}/description`, `description restates ${c.count} enum values (${c.bytes} bytes)`, { count: c.count, bytes: c.bytes }));
      } else {
        findings.push(finding('enum-in-prose', tool.name, `${c.path}/description`, `${c.count} allowed values listed only in prose; make them an enum`, { count: c.count, bytes: c.bytes }));
      }
    }
  }

  const duplicates = duplicateStats(isObj(schema) ? schema : undefined, minBytes, opts.tokenizer);
  if (duplicates.groups > 0) {
    const pct = Math.round(duplicates.share * 1000) / 10;
    const d = duplicates.defs;
    findings.push(
      finding(
        'duplicate-subtree',
        tool.name,
        SCHEMA_ROOT,
        `${duplicates.wasteBytes} repeated bytes (${pct}% of the schema) in ${duplicates.groups} group(s); $defs/$ref would cut ${d.bytesBefore} → ${d.bytesAfter} bytes`,
        {
          wasteBytes: duplicates.wasteBytes,
          sharePct: pct,
          groups: duplicates.groups,
          maxRepeat: duplicates.maxRepeat,
          top: duplicates.top.map((t) => ({ ...t })),
          defs: { ...d },
        },
        duplicates.share >= 0.1 || duplicates.wasteBytes >= 10_000 ? 'warn' : 'info',
      ),
    );
  }

  const untyped = untypedStats(isObj(schema) ? schema : undefined);
  const nUntyped = untyped.emptyItems + untyped.opaqueObjects + untyped.noTypeNodes;
  if (nUntyped > 0) {
    findings.push(
      finding(
        'untyped-node',
        tool.name,
        SCHEMA_ROOT,
        `${nUntyped} untyped node(s): ${untyped.noTypeNodes} with no type, ${untyped.emptyItems} items: {}, ${untyped.opaqueObjects} opaque object(s)`,
        { noTypeNodes: untyped.noTypeNodes, emptyItems: untyped.emptyItems, opaqueObjects: untyped.opaqueObjects, examples: [...untyped.examples] },
      ),
    );
  }

  findings.push(...escapedJsonFindings(tool));
  findings.push(...descriptionSizeFindings(tool, opts.maxDescriptionBytes ?? DEFAULTS.maxDescriptionBytes));
  findings.push(...annotationFindings(tool));

  if (tool.outputSchema !== undefined) {
    findings.push(
      finding(
        'output-duplication-risk',
        tool.name,
        ['outputSchema'],
        'returns structuredContent; the spec asks servers to also send it serialized as text, so clients that forward both pay for it twice',
      ),
    );
  }

  findings.sort(compareFindings);
  return { tool: tool.name, choiceLists: lists, duplicates, untyped, findings };
}

/* ------------------------------------------------------------------ */
/* budgets and observed results                                       */
/* ------------------------------------------------------------------ */

/** `oversize-tool` finding when `tokens` exceeds `budget`, else null. */
export function oversizeFinding(tool: string, tokens: number, budget: number, tokenizerId: string, what = 'exposure'): Finding | null {
  if (tokens <= budget) return null;
  return finding('oversize-tool', tool, '', `${what} is ${tokens} ${tokenizerId} tokens, over the ${budget}-token budget`, {
    tokens,
    budget,
    tokenizer: tokenizerId,
  });
}

/**
 * Inspect one observed `tools/call` result. Fires when a text block, parsed
 * as JSON, equals `structuredContent`.
 */
export function analyzeCallResult(tool: string, result: unknown, tokenizer?: Tokenizer): Finding | null {
  if (!isObj(result) || !isObj(result['structuredContent']) || !Array.isArray(result['content'])) return null;
  const sc = canonicalJson(result['structuredContent']);
  for (let i = 0; i < result['content'].length; i++) {
    const block = result['content'][i] as unknown;
    if (!isObj(block) || block['type'] !== 'text' || typeof block['text'] !== 'string') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(block['text']);
    } catch {
      continue;
    }
    if (canonicalJson(parsed) !== sc) continue;
    const text = block['text'];
    const data: Finding['data'] = { duplicatedBytes: utf8Bytes(text) };
    if (tokenizer) data['duplicatedTokens'] = measure(text, [tokenizer]).tokens[tokenizer.id]!;
    return finding('structured-content-duplicated', tool, `/content/${i}`, `text block repeats structuredContent (${utf8Bytes(text)} bytes)`, data);
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* catalog                                                            */
/* ------------------------------------------------------------------ */

export const CHOICE_LIST_EDGES = [5, 10, 20, 50, 100, 500] as const;

export interface RuleSummary {
  count: number;
  tools: number;
  severity: { error: number; warn: number; info: number };
}

export function summarizeFindings(findings: readonly Finding[]): Partial<Record<RuleId, RuleSummary>> {
  const out: Partial<Record<RuleId, RuleSummary>> = {};
  const toolSets = new Map<RuleId, Set<string>>();
  for (const f of findings) {
    const s = (out[f.rule] ??= { count: 0, tools: 0, severity: { error: 0, warn: 0, info: 0 } });
    s.count++;
    s.severity[f.severity]++;
    let set = toolSets.get(f.rule);
    if (!set) toolSets.set(f.rule, (set = new Set()));
    if (f.tool !== null) set.add(f.tool);
  }
  const sorted: Partial<Record<RuleId, RuleSummary>> = {};
  for (const rule of Object.keys(RULES) as RuleId[]) {
    const s = out[rule];
    if (s) sorted[rule] = { ...s, tools: toolSets.get(rule)!.size };
  }
  return sorted;
}
