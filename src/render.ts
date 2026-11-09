/**
 * Human-readable rendering of a CatalogDiff + Verdict. No colors, no TTY
 * detection: the output is meant to be read in CI logs and pasted into PRs.
 */

import type { CatalogDiff, PathChange, Section, Verdict } from './diff.js';
import { visible } from './safe-text.js';
import type { Snapshot } from './snapshot.js';

const LABEL: Record<Section, string> = {
  tools: 'tools',
  prompts: 'prompts',
  resourceTemplates: 'resource templates',
};

function short(v: unknown, max = 96): string {
  const s = v === undefined ? '<absent>' : JSON.stringify(v);
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/**
 * For two long strings, show a window around the first differing character
 * so a wording change at the end of a 400-char description is visible.
 */
function focusedPair(before: string, after: string, max = 96): [string, string] {
  const sb = JSON.stringify(before);
  const sa = JSON.stringify(after);
  if (sb.length <= max && sa.length <= max) return [sb, sa];
  let i = 0;
  while (i < sb.length && i < sa.length && sb[i] === sa[i]) i++;
  const lead = 24;
  const start = Math.max(0, i - lead);
  const window = (s: string): string => {
    const head = start > 0 ? '…' : '';
    const body = s.slice(start, start + max);
    const tail = start + max < s.length ? '…' : '';
    return `${head}${body}${tail}`;
  };
  return [window(sb), window(sa)];
}

function renderChange(c: PathChange): string[] {
  const tag = c.descriptive ? ' (description)' : '';
  const [b, a] =
    typeof c.before === 'string' && typeof c.after === 'string' ? focusedPair(c.before, c.after) : [short(c.before), short(c.after)];
  return [`      ${visible(c.path)}${tag}`, `        - ${visible(b)}`, `        + ${visible(a)}`];
}

export interface RenderOptions {
  /** Label for the "before" side (default "snapshot"). */
  beforeLabel?: string;
  /** Label for the "after" side (default "live"). */
  afterLabel?: string;
}

export function renderDiff(diff: CatalogDiff, verdict: Verdict, opts: RenderOptions = {}): string {
  const beforeLabel = opts.beforeLabel ?? 'snapshot';
  const afterLabel = opts.afterLabel ?? 'live';
  const lines: string[] = [];
  const w = Math.max(beforeLabel.length, afterLabel.length) + 1;
  lines.push(`fingerprint ${`${beforeLabel}:`.padEnd(w)} ${diff.fingerprint.before}`);
  lines.push(`fingerprint ${`${afterLabel}:`.padEnd(w)} ${diff.fingerprint.after}`);
  if (diff.identical) {
    lines.push('catalog: identical (byte-for-byte canonical match)');
    return lines.join('\n');
  }
  for (const s of diff.sections) {
    const total = s.added.length + s.removed.length + s.changed.length;
    if (total === 0) continue;
    lines.push('');
    lines.push(
      `${LABEL[s.section]}: ${diff.counts.before[s.section]} -> ${diff.counts.after[s.section]} ` +
        `(+${s.added.length} added, -${s.removed.length} removed, ~${s.changed.length} changed)`,
    );
    for (const k of s.added) lines.push(`  + ${visible(k)}`);
    for (const k of s.removed) lines.push(`  - ${visible(k)}`);
    for (const c of s.changed) {
      lines.push(`  ~ ${visible(c.key)}${c.descriptionOnly ? '  [description-only]' : ''}`);
      for (const ch of c.changes) lines.push(...renderChange(ch));
    }
  }
  lines.push('');
  if (verdict.waived.length > 0) {
    lines.push('waived by policy:');
    for (const w of verdict.waived) lines.push(`  ${visible(w)}`);
  }
  if (verdict.drift) {
    lines.push(`DRIFT: ${verdict.reasons.length} reason(s)`);
    for (const r of verdict.reasons) lines.push(`  ${visible(r)}`);
  } else {
    lines.push('no drift under the current policy (bytes differ: cache prefix WILL change)');
  }
  return lines.join('\n');
}

export function renderSnapshotHeader(snap: Snapshot): string {
  const c = snap.catalog;
  return [
    `server:          ${visible(snap.server.name)} ${visible(snap.server.version)}`,
    `protocolVersion: ${visible(snap.protocolVersion ?? '(unknown)')}`,
    `captured:        ${snap.capturedAt} by ${snap.capturedWith}`,
    `catalog:         ${c.tools.length} tools, ${c.prompts.length} prompts, ${c.resourceTemplates.length} resource templates`,
    `sha256:          ${snap.sha256}`,
  ].join('\n');
}

/** Machine-readable result for one server, used by `--json`. */
export interface ServerResult {
  server: string;
  ok: boolean;
  drift: boolean;
  error?: string;
  /** The stored snapshot failed its sha256 integrity check (exit 3). */
  tampered?: boolean;
  snapshotPath?: string;
  fingerprint?: { snapshot: string; live: string };
  serverVersion?: { snapshot: string; live: string };
  diff?: CatalogDiff;
  verdict?: Verdict;
}

export interface CheckReport {
  tool: string;
  ok: boolean;
  policy: { ignoreDescriptions: boolean; allowAdditions: boolean };
  servers: ServerResult[];
}
