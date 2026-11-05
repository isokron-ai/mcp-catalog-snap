/**
 * The plain adapter: a server whose `tools/list` entries are the contract.
 *
 * Live: capture over stdio or Streamable HTTP. Offline: a saved file holding
 * any of
 *   - an mcp-catalog-snap snapshot (`"format": "mcp-catalog-snap/1"`),
 *     integrity-checked like `check` does;
 *   - a `tools/list` result `{ "tools": [...] }` (optionally with `prompts`,
 *     `resourceTemplates`, `serverInfo`);
 *   - a JSON-RPC response `{ "result": { "tools": [...] } }`;
 *   - a bare array of tools.
 */

import { basename, extname } from 'node:path';

import { capture, type CaptureOptions, type Target } from '../capture.js';
import { fingerprint } from '../canonical.js';
import { SNAPSHOT_FORMAT, SnapshotIntegrityError, normalizeCatalog, parseSnapshot } from '../snapshot.js';
import type { SourceInfo, SweepInput } from './types.js';

export const TOOLS_LIST_ADAPTER = 'tools-list';
const EXPOSURE_LABEL = 'canonical JSON (RFC 8785) of each tools/list entry';

/**
 * A path segment that looks like a credential (some servers put API keys
 * in the URL path): 16+ chars mixing letters and digits, or long hex.
 */
function looksSecret(seg: string): boolean {
  const s = decodeSafe(seg);
  if (s.length < 16) return false;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  return /[A-Za-z]/.test(s) && /\d/.test(s) && /^[A-Za-z0-9_\-.~+=]+$/.test(s);
}

function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/** Source description without credentials: URL origin + path (credential-looking segments masked), stdio command basename only. */
export function sourceOf(target: Target): SourceInfo {
  if (target.kind === 'stdio') return { kind: 'stdio', command: basename(target.command) };
  try {
    const u = new URL(target.url);
    const path = u.pathname
      .split('/')
      .map((seg) => (looksSecret(seg) ? '***' : seg))
      .join('/');
    return { kind: 'http', url: `${u.origin}${path}` };
  } catch {
    return { kind: 'http', url: '<invalid url>' };
  }
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
}

function emptyInput(): Pick<SweepInput, 'exposure' | 'views' | 'embeddedSchemas' | 'wrapperTools' | 'findings' | 'notes'> {
  return { exposure: new Map(), views: new Map(), embeddedSchemas: new Map(), wrapperTools: null, findings: [], notes: [] };
}

/** Parse a saved catalog file. `fileName` names the source in the report (no directory). */
export function parseToolsListFile(text: string, fileName: string, nameOverride?: string): SweepInput {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${fileName}: not valid JSON (${(err as Error).message})`);
  }
  const stem = basename(fileName, extname(fileName)) || 'server';
  const obj = asObject(parsed);

  if (obj && obj['format'] === SNAPSHOT_FORMAT) {
    const snap = parseSnapshot(text, fileName);
    const body = fingerprint(snap.catalog);
    if (body !== snap.sha256) throw new SnapshotIntegrityError(fileName, snap.sha256, body);
    const server: SweepInput['server'] = { name: nameOverride ?? snap.server.name, version: snap.server.version || null };
    if (snap.server.title !== undefined) server.title = snap.server.title;
    return {
      adapter: TOOLS_LIST_ADAPTER,
      server,
      protocolVersion: snap.protocolVersion,
      source: { kind: 'file', name: basename(fileName), format: 'snapshot' },
      catalog: snap.catalog,
      orderedTools: null,
      exposureLabel: EXPOSURE_LABEL,
      ...emptyInput(),
      notes: ['input is a snapshot: tools are stored sorted, so the server-order (ADR-0005) fingerprint is unavailable'],
    };
  }

  let body: Record<string, unknown> | null = obj;
  let format = 'tools/list result';
  if (Array.isArray(parsed)) {
    body = { tools: parsed };
    format = 'tools array';
  } else if (obj && asObject(obj['result'])) {
    body = asObject(obj['result']);
    format = 'JSON-RPC response';
  }
  if (!body || !Array.isArray(body['tools'])) {
    throw new Error(`${fileName}: expected a tools/list result ({"tools": [...]}), a JSON-RPC response, a tools array, or a snapshot`);
  }
  const tools = body['tools'] as unknown[];
  const arr = (k: string): unknown[] => (Array.isArray(body![k]) ? (body![k] as unknown[]) : []);
  const info = asObject(body['serverInfo']) ?? asObject(obj?.['serverInfo']);
  const server: SweepInput['server'] = {
    name: nameOverride ?? (typeof info?.['name'] === 'string' ? info['name'] : stem),
    version: typeof info?.['version'] === 'string' ? info['version'] : null,
  };
  if (typeof info?.['title'] === 'string') server.title = info['title'];
  const notes: string[] = [];
  if (!Array.isArray(body['prompts']) && !Array.isArray(body['resourceTemplates'])) {
    notes.push('input lists tools only: the catalog fingerprint equals a snapshot fingerprint only if the server has no prompts or resource templates');
  }
  return {
    adapter: TOOLS_LIST_ADAPTER,
    server,
    protocolVersion: typeof body['protocolVersion'] === 'string' ? body['protocolVersion'] : null,
    source: { kind: 'file', name: basename(fileName), format },
    catalog: normalizeCatalog({ tools, prompts: arr('prompts'), resourceTemplates: arr('resourceTemplates') }),
    orderedTools: tools,
    exposureLabel: EXPOSURE_LABEL,
    ...emptyInput(),
    notes,
  };
}

/** Capture a live server's catalog. */
export async function sweepInputFromServer(target: Target, opts: CaptureOptions = {}, nameOverride?: string): Promise<SweepInput> {
  const raw = await capture(target, opts);
  const server: SweepInput['server'] = { name: nameOverride ?? raw.server.name, version: raw.server.version || null };
  if (raw.server.title !== undefined) server.title = raw.server.title;
  return {
    adapter: TOOLS_LIST_ADAPTER,
    server,
    protocolVersion: raw.protocolVersion,
    source: sourceOf(target),
    catalog: normalizeCatalog(raw),
    orderedTools: raw.tools,
    exposureLabel: EXPOSURE_LABEL,
    ...emptyInput(),
  };
}
