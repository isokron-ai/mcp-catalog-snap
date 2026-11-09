/**
 * Snapshot file format (`.mcp-catalog/<server>.json`).
 *
 * ```json
 * {
 *   "format": "mcp-catalog-snap/1",
 *   "server": { "name": "kronicle-lite", "version": "0.2.0" },
 *   "protocolVersion": "2025-11-25",
 *   "capturedAt": "2026-10-31T23:00:00.000Z",
 *   "capturedWith": "mcp-catalog-snap/0.2.0",
 *   "sha256": "<sha256 of canonicalJson(catalog)>",
 *   "catalog": {
 *     "tools": [ ...sorted by name, every field tools/list returned... ],
 *     "prompts": [ ...sorted by name... ],
 *     "resourceTemplates": [ ...sorted by uriTemplate... ]
 *   }
 * }
 * ```
 *
 * Only `catalog` is hashed. Server version, capture time and the tool
 * version live in the header so a server release that does not touch its
 * catalog does not read as drift.
 */

import { fingerprint, prettyCanonical, sortKeysDeep, type JsonValue } from './canonical.js';
import { MAX_INPUT_BYTES } from './read-input.js';
import { jsonSafe } from './safe-text.js';
import { VERSION } from './version.js';

export const SNAPSHOT_FORMAT = 'mcp-catalog-snap/1';

export interface CatalogTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: JsonValue;
  outputSchema?: JsonValue;
  annotations?: JsonValue;
  [extra: string]: JsonValue | undefined;
}

export interface CatalogPrompt {
  name: string;
  title?: string;
  description?: string;
  arguments?: JsonValue;
  [extra: string]: JsonValue | undefined;
}

export interface CatalogResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: JsonValue;
  [extra: string]: JsonValue | undefined;
}

export interface Catalog {
  tools: CatalogTool[];
  prompts: CatalogPrompt[];
  resourceTemplates: CatalogResourceTemplate[];
}

export interface ServerInfo {
  name: string;
  version: string;
  title?: string;
}

export interface Snapshot {
  format: typeof SNAPSHOT_FORMAT;
  server: ServerInfo;
  protocolVersion: string | null;
  capturedAt: string;
  capturedWith: string;
  sha256: string;
  catalog: Catalog;
}

/** Raw lists as returned by the SDK client, before normalization. */
export interface RawCapture {
  server: ServerInfo;
  protocolVersion: string | null;
  tools: unknown[];
  prompts: unknown[];
  resourceTemplates: unknown[];
}

function byKey<T extends Record<string, unknown>>(key: string) {
  return (a: T, b: T): number => {
    const ka = String(a[key]);
    const kb = String(b[key]);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  };
}

function requireString(obj: Record<string, unknown>, key: string, what: string): void {
  if (typeof obj[key] !== 'string') {
    throw new Error(`${what} entry is missing a string "${key}": ${JSON.stringify(obj).slice(0, 200)}`);
  }
}

/**
 * Normalize a raw capture into a Catalog: deep key-sort every entry (JCS
 * order), drop `undefined`, and sort tools/prompts by name and resource
 * templates by uriTemplate. Nothing else is stripped — if the server sent
 * it in the list, it is part of the catalog.
 */
export function normalizeCatalog(raw: Pick<RawCapture, 'tools' | 'prompts' | 'resourceTemplates'>): Catalog {
  const tools = raw.tools.map((t) => {
    const o = sortKeysDeep(t) as Record<string, JsonValue>;
    requireString(o, 'name', 'tool');
    return o as unknown as CatalogTool;
  });
  const prompts = raw.prompts.map((p) => {
    const o = sortKeysDeep(p) as Record<string, JsonValue>;
    requireString(o, 'name', 'prompt');
    return o as unknown as CatalogPrompt;
  });
  const resourceTemplates = raw.resourceTemplates.map((r) => {
    const o = sortKeysDeep(r) as Record<string, JsonValue>;
    requireString(o, 'uriTemplate', 'resource template');
    return o as unknown as CatalogResourceTemplate;
  });

  const dupTools = findDuplicates(tools.map((t) => t.name));
  if (dupTools.length > 0) {
    throw new Error(`tools/list returned duplicate tool names: ${dupTools.join(', ')}`);
  }

  return {
    tools: tools.sort(byKey('name')),
    prompts: prompts.sort(byKey('name')),
    resourceTemplates: resourceTemplates.sort(byKey('uriTemplate')),
  };
}

function findDuplicates(names: string[]): string[] {
  const seen = new Set<string>();
  const dup = new Set<string>();
  for (const n of names) {
    if (seen.has(n)) dup.add(n);
    seen.add(n);
  }
  return [...dup].sort();
}

export interface BuildOptions {
  /** Override capture time (tests). Defaults to now. */
  capturedAt?: string;
}

export function buildSnapshot(raw: RawCapture, opts: BuildOptions = {}): Snapshot {
  const catalog = normalizeCatalog(raw);
  const server: ServerInfo = { name: raw.server.name, version: raw.server.version };
  if (raw.server.title !== undefined) server.title = raw.server.title;
  return {
    format: SNAPSHOT_FORMAT,
    server,
    protocolVersion: raw.protocolVersion,
    capturedAt: opts.capturedAt ?? new Date().toISOString(),
    capturedWith: `mcp-catalog-snap/${VERSION}`,
    sha256: fingerprint(catalog),
    catalog,
  };
}

/** Nesting depth from which a snapshot file writes subtrees as compact JSON on one line. */
export const SNAPSHOT_PRETTY_DEPTH = 64;

/**
 * Compaction tried in order until the file fits the read cap: subtrees
 * nested SNAPSHOT_PRETTY_DEPTH+ levels compact; then every catalog entry's
 * field values compact (depth 4: snapshot > catalog > section > entry >
 * field), so each tool still gets its own lines in a git diff; then the
 * whole file as compact canonical JSON.
 */
export const SNAPSHOT_COMPACT_LEVELS: readonly number[] = [SNAPSHOT_PRETTY_DEPTH, 4, 0];

/**
 * The bytes written to disk: pretty-printed, key-sorted, trailing newline;
 * subtrees nested SNAPSHOT_PRETTY_DEPTH levels or deeper on one line. When
 * that would exceed `maxBytes` (default: the 64 MiB that check / diff /
 * hash read) - a wide schema a few dozen levels deep pretty-prints to many
 * times its compact size - the next level of SNAPSHOT_COMPACT_LEVELS is
 * used, down to fully compact JSON. Every form has the same values and the
 * same sha256. A file over `maxBytes` even fully compact is refused here,
 * before anything is written.
 */
export function serializeSnapshot(snap: Snapshot, opts: { maxBytes?: number } = {}): string {
  const max = opts.maxBytes ?? MAX_INPUT_BYTES;
  let bytes = 0;
  for (const depth of SNAPSHOT_COMPACT_LEVELS) {
    let text: string;
    try {
      // bidi / invisible characters written as \u escapes: same values, nothing hidden in a git diff
      text = jsonSafe(prettyCanonical(snap, { compactFromDepth: depth }));
    } catch (err) {
      if (!(err instanceof RangeError)) throw err;
      bytes = Infinity;
      continue;
    }
    bytes = Buffer.byteLength(text, 'utf8');
    if (bytes <= max) return text;
  }
  if (bytes === Infinity) throw new Error(`snapshot would exceed the JavaScript string limit, over the ${max}-byte limit check/diff/hash read; not written`);
  throw new Error(`snapshot would be ${bytes} bytes even as compact JSON, over the ${max}-byte limit check/diff/hash read; not written`);
}

/** Parse + validate a snapshot file's text. Throws on a malformed file. */
export function parseSnapshot(text: string, source = 'snapshot'): Snapshot {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${source}: not valid JSON (${(err as Error).message})`);
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${source}: expected a JSON object`);
  }
  const o = parsed as Record<string, unknown>;
  if (o['format'] !== SNAPSHOT_FORMAT) {
    throw new Error(`${source}: unsupported format ${JSON.stringify(o['format'])} (expected ${SNAPSHOT_FORMAT})`);
  }
  const server = o['server'];
  if (server === null || typeof server !== 'object') {
    throw new Error(`${source}: missing "server"`);
  }
  const catalog = o['catalog'];
  if (catalog === null || typeof catalog !== 'object' || Array.isArray(catalog)) {
    throw new Error(`${source}: missing "catalog"`);
  }
  const c = catalog as Record<string, unknown>;
  for (const k of ['tools', 'prompts', 'resourceTemplates']) {
    if (!Array.isArray(c[k])) throw new Error(`${source}: catalog.${k} must be an array`);
  }
  if (typeof o['sha256'] !== 'string') {
    throw new Error(`${source}: missing "sha256"`);
  }
  // Re-normalize so that a hand-edited file still compares canonically.
  const normalized = normalizeCatalog({
    tools: c['tools'] as unknown[],
    prompts: c['prompts'] as unknown[],
    resourceTemplates: c['resourceTemplates'] as unknown[],
  });
  const s = server as Record<string, unknown>;
  const info: ServerInfo = { name: String(s['name'] ?? ''), version: String(s['version'] ?? '') };
  if (typeof s['title'] === 'string') info.title = s['title'];
  return {
    format: SNAPSHOT_FORMAT,
    server: info,
    protocolVersion: typeof o['protocolVersion'] === 'string' ? o['protocolVersion'] : null,
    capturedAt: String(o['capturedAt'] ?? ''),
    capturedWith: String(o['capturedWith'] ?? ''),
    sha256: o['sha256'],
    catalog: normalized,
  };
}

/** A snapshot whose stored sha256 does not match its catalog body. */
export class SnapshotIntegrityError extends Error {
  readonly path: string;
  readonly stored: string;
  readonly body: string;
  constructor(path: string, stored: string, body: string) {
    super(
      `${path}: stored sha256 ${stored} does not match its catalog body ${body} — the snapshot was edited by hand ` +
        'or corrupted, so it is not a trustworthy baseline. Restore it from version control, or re-capture it with ' +
        '`mcp-catalog-snap snapshot` and review the diff before committing.',
    );
    this.name = 'SnapshotIntegrityError';
    this.path = path;
    this.stored = stored;
    this.body = body;
  }
}

/** True when the stored sha256 matches the catalog body (file not hand-mangled). */
export function snapshotSelfConsistent(snap: Snapshot): boolean {
  return fingerprint(snap.catalog) === snap.sha256;
}

/** Filename-safe server name: `io.github.x/y` → `io.github.x__y`. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\\/]+/g, '__').replace(/[^A-Za-z0-9._@-]+/g, '_').replace(/^\.+/, '');
  return cleaned.length > 0 ? cleaned : 'server';
}
