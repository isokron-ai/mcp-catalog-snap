/**
 * Local filesystem paths in what catalog-snap writes to files (the snapshot's
 * `launch` header, the matrix report's per-set errors, the check report's
 * errors). A snapshot is meant to be committed and shared; the operator's home
 * directory, user name, temp folders and directory layout are not part of
 * what it proves. Credential masking (`redact.ts`) already blanked path
 * segments that look like tokens, which left the rest of each path readable.
 *
 * Every absolute path is rewritten:
 *   - inside the project root (the config file's directory, or the working
 *     directory for an ad-hoc target): `<project>/` + the path relative to it,
 *     so a reader can still tell which config or fixture was used;
 *   - anywhere else: `<local>/` + its last segment (`/opt/homebrew/bin/node`
 *     becomes `<local>/node`, a temp-dir kubeconfig `<local>/kms.kubeconfig`).
 * POSIX paths, Windows drive paths and `file://` URLs are covered; http(s)
 * URLs and relative paths are left alone. None of this is hashed: the
 * catalog fingerprint is unchanged.
 */

import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, win32 } from 'node:path';

export const PROJECT_PATH = '<project>';
export const LOCAL_PATH = '<local>';

const STOP = `\\s'"=,;:|()\\[\\]{}<>`;
// An absolute POSIX path at a word boundary: start, whitespace or a separator before it; not `//` (a URL authority).
const POSIX = new RegExp(`(^|[\\s=:,;'"(\\[{|])(\\/(?!\\/)[^${STOP}]*)`, 'g');
const WINDOWS = new RegExp(`(^|[\\s=,;'"(\\[{|])([A-Za-z]:[\\\\/][^\\s'"=,;|()\\[\\]{}<>]*)`, 'g');
const FILE_URL = /\bfile:\/\/(\/[^\s'"<>()[\]{}]*)/gi;

function roots(root: string | undefined): string[] {
  if (!root || !isAbsolute(root)) return [];
  const out = [root.replace(/\/+$/, '') || '/'];
  try {
    const real = realpathSync(root);
    if (!out.includes(real)) out.push(real);
  } catch {
    // a root that does not exist: the lexical form only
  }
  return out;
}

function rewrite(p: string, rs: string[], windows: boolean): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  for (const r of rs) {
    const rel = windows ? win32.relative(r, trimmed) : relative(r, trimmed);
    if (rel === '') return PROJECT_PATH;
    if (!rel.startsWith('..') && !isAbsolute(rel) && !win32.isAbsolute(rel)) return `${PROJECT_PATH}/${rel.split('\\').join('/')}`;
  }
  const last = windows ? win32.basename(trimmed) : basename(trimmed);
  return last ? `${LOCAL_PATH}/${last}` : LOCAL_PATH;
}

/** `text` with every absolute local path rewritten relative to `root` or reduced to its last segment. */
export function redactLocalPaths(text: string, root?: string): string {
  const rs = roots(root);
  return text
    .replace(FILE_URL, (_m, p: string) => `file://${rewrite(p, rs, false)}`)
    // (a rewritten `file://<local>/x` is not matched again: `/x` follows `>`, not a boundary)
    .replace(POSIX, (_m, pre: string, p: string) => pre + rewrite(p, rs, false))
    .replace(WINDOWS, (_m, pre: string, p: string) => pre + rewrite(p, rs, true));
}

/** The same rewrite applied to every string inside a JSON-like value. */
export function redactLocalPathsDeep<T>(value: T, root?: string): T {
  if (typeof value === 'string') return redactLocalPaths(value, root) as T;
  if (Array.isArray(value)) return value.map((v) => redactLocalPathsDeep(v, root)) as T;
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactLocalPathsDeep(v, root);
    return out as T;
  }
  return value;
}
