/**
 * Command implementations. Pure-ish: they take options + an IO sink and
 * return an exit code, so tests can drive them without spawning the CLI.
 *
 * Exit codes:
 *   0  no drift / success
 *   1  drift detected (check, diff)
 *   2  usage, config, connection or I/O error
 *   3  a snapshot file failed its integrity check (stored sha256 does not
 *      match its catalog body): the baseline cannot be trusted, so nothing
 *      was compared. Takes precedence over 2 and 1.
 */

import { existsSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { fingerprint } from './canonical.js';
import { capture, describeTarget, type CaptureOptions, type Target } from './capture.js';
import { DEFAULT_CONFIG_FILE, DEFAULT_SNAPSHOT_DIR, loadConfig, type ServerSpec } from './config.js';
import { contradictoryAnnotations, diffCatalogs, evaluate, type DriftPolicy } from './diff.js';
import { renderDiff, renderSnapshotHeader, type CheckReport, type ServerResult } from './render.js';
import {
  SnapshotIntegrityError,
  buildSnapshot,
  parseSnapshot,
  safeFileName,
  serializeSnapshot,
  snapshotSelfConsistent,
  type Snapshot,
} from './snapshot.js';
import { readInputText } from './read-input.js';
import { jsonSafe, oneLine, scrubErrorText, visible } from './safe-text.js';
import { VERSION } from './version.js';
import { assertCredentialLengths, assertNoSecrets, redactingIO, scrubDeep, targetSecrets, writeText, type IO } from './redact.js';

export const EXIT_OK = 0;
export const EXIT_DRIFT = 1;
export const EXIT_ERROR = 2;
export const EXIT_TAMPERED = 3;

export { SnapshotIntegrityError };

export type { IO };

export interface TargetSelection {
  /** Ad-hoc target from --url / `-- cmd`. */
  target?: Target;
  /** Snapshot name override for an ad-hoc target. */
  name?: string;
  /** Display label for an ad-hoc target in messages and reports (default: `name`, else command basename + hash, or URL origin + path). */
  label?: string;
  /** Config file path (default .mcp-catalog.json, only if it exists). */
  config?: string;
  /** Only this configured server. */
  server?: string;
  /** Snapshot directory override. */
  dir?: string;
  cwd?: string;
}

export interface CommonOptions extends TargetSelection {
  timeoutMs?: number;
  /** Deadline for each server's whole capture (--timeout-total). */
  totalTimeoutMs?: number;
  json?: boolean;
  quiet?: boolean;
  /** Where the stdio child's stderr goes (default: inherit; --json implies ignore). */
  childStderr?: 'inherit' | 'ignore';
}

interface Resolved {
  specs: ServerSpec[];
  snapshotDir: string;
  /** Ad-hoc targets have no fixed name until the server tells us. */
  adHoc: boolean;
}

function resolveTargets(sel: TargetSelection): Resolved {
  const cwd = sel.cwd ?? process.cwd();
  if (sel.target) {
    if (sel.server) throw new Error('--server selects a configured server; it cannot be combined with an ad-hoc target');
    return {
      specs: [{ name: sel.name ?? '', target: sel.target, ...(sel.label !== undefined ? { label: sel.label } : {}) }],
      snapshotDir: resolve(cwd, sel.dir ?? DEFAULT_SNAPSHOT_DIR),
      adHoc: true,
    };
  }
  if (sel.label !== undefined) throw new Error('--label names an ad-hoc target (`-- command` or --url); configured servers are labelled by their name');
  const configPath = resolve(cwd, sel.config ?? DEFAULT_CONFIG_FILE);
  if (!existsSync(configPath)) {
    throw new Error(
      sel.config
        ? `config not found: ${configPath}`
        : `no ${DEFAULT_CONFIG_FILE} in ${cwd} and no target given — pass --url URL, \`-- command args\`, or --config FILE`,
    );
  }
  const cfg = loadConfig(configPath);
  for (const s of cfg.servers) assertCredentialLengths(s.target);
  let specs = cfg.servers;
  if (sel.server !== undefined) {
    specs = specs.filter((s) => s.name === sel.server);
    if (specs.length === 0) {
      throw new Error(`server "${sel.server}" is not in ${configPath} (known: ${cfg.servers.map((s) => s.name).join(', ') || 'none'})`);
    }
  }
  if (specs.length === 0) throw new Error(`${configPath} lists no servers`);
  return { specs, snapshotDir: sel.dir ? resolve(cwd, sel.dir) : cfg.snapshotDir, adHoc: false };
}

/** How messages and reports name a server: `--label`, else its name, else `describeTarget` (never the stdio arguments). */
function labelOf(spec: ServerSpec): string {
  return spec.label ?? (spec.name || describeTarget(spec.target));
}

/** Warn (stderr) about tools whose annotations contradict each other; classification still follows the spec (read-only). */
function warnAnnotations(io: IO, server: string, snap: Snapshot): void {
  for (const tool of contradictoryAnnotations(snap.catalog.tools)) {
    io.err(
      `warning: ${visible(server)}: tool ${visible(JSON.stringify(tool))} declares readOnlyHint: true and destructiveHint: true; ` +
        'treated as read-only (destructiveHint only applies when readOnlyHint is false), check which is meant',
    );
  }
}

function snapshotPath(dir: string, name: string): string {
  return join(dir, `${safeFileName(name)}.json`);
}

function readSnapshotFile(path: string): Snapshot {
  const text = readInputText(path, 'snapshot');
  return parseSnapshot(text, path);
}

/** Read a snapshot and refuse it when its stored sha256 does not match its body. */
function readVerifiedSnapshot(path: string): Snapshot {
  const snap = readSnapshotFile(path);
  if (!snapshotSelfConsistent(snap)) throw new SnapshotIntegrityError(path, snap.sha256, fingerprint(snap.catalog));
  return snap;
}

function captureOpts(o: CommonOptions): CaptureOptions {
  const c: CaptureOptions = {};
  if (o.timeoutMs !== undefined) c.timeoutMs = o.timeoutMs;
  if (o.totalTimeoutMs !== undefined) c.totalTimeoutMs = o.totalTimeoutMs;
  // When emitting JSON, keep the child's stderr out of the way.
  c.stderr = o.childStderr ?? (o.json ? 'ignore' : 'inherit');
  return c;
}

/* ------------------------------------------------------------------ */
/* snapshot                                                           */
/* ------------------------------------------------------------------ */

export interface SnapshotOptions extends CommonOptions {
  /** Do not write; print the snapshot JSON to stdout. */
  noWrite?: boolean;
}

/** Wrap `io` so output and report files are scrubbed of every credential the resolved targets carry. */
function scrubbed(io: IO, specs: ServerSpec[]): IO & { variants: () => string[] } {
  return redactingIO(io, specs.flatMap((s) => targetSecrets(s.target)));
}

export async function cmdSnapshot(opts: SnapshotOptions, rawIo: IO): Promise<number> {
  let resolved: Resolved;
  try {
    resolved = resolveTargets(opts);
  } catch (err) {
    rawIo.err(`error: ${oneLine((err as Error).message)}`);
    return EXIT_ERROR;
  }
  const io = scrubbed(rawIo, resolved.specs);
  let failures = 0;
  for (const spec of resolved.specs) {
    try {
      const raw = await capture(spec.target, captureOpts(opts));
      const snap = buildSnapshot(raw);
      const name = spec.name || raw.server.name;
      warnAnnotations(io, name, snap);
      const text = serializeSnapshot(snap);
      assertNoSecrets(text, targetSecrets(spec.target), 'captured catalog');
      if (opts.noWrite) {
        io.out(text.trimEnd());
        continue;
      }
      mkdirSync(resolved.snapshotDir, { recursive: true });
      const path = snapshotPath(resolved.snapshotDir, name);
      writeText(io, path, text);
      if (!opts.quiet) {
        io.out(`wrote ${path}`);
        io.out(renderSnapshotHeader(snap));
      }
    } catch (err) {
      failures++;
      io.err(`error: ${visible(labelOf(spec))}: ${oneLine((err as Error).message)}`);
    }
  }
  return failures > 0 ? EXIT_ERROR : EXIT_OK;
}

/* ------------------------------------------------------------------ */
/* check                                                              */
/* ------------------------------------------------------------------ */

export interface CheckOptions extends CommonOptions, DriftPolicy {
  /** Rewrite the snapshot when drift is found (still exits 1). */
  update?: boolean;
  /** Also write the JSON report to this file (human output stays on stdout). */
  reportFile?: string;
}

export async function cmdCheck(opts: CheckOptions, rawIo: IO): Promise<number> {
  let resolved: Resolved;
  try {
    resolved = resolveTargets(opts);
  } catch (err) {
    rawIo.err(`error: ${oneLine((err as Error).message)}`);
    return EXIT_ERROR;
  }
  const io = scrubbed(rawIo, resolved.specs);
  const policy: DriftPolicy = {
    ignoreDescriptions: opts.ignoreDescriptions ?? false,
    allowAdditions: opts.allowAdditions ?? false,
    allowWriteAdditions: opts.allowWriteAdditions ?? false,
  };
  const results: ServerResult[] = [];

  for (const spec of resolved.specs) {
    const label = labelOf(spec);
    try {
      const raw = await capture(spec.target, captureOpts(opts));
      const live = buildSnapshot(raw);
      const name = spec.name || raw.server.name;
      warnAnnotations(io, name, live);
      const path = snapshotPath(resolved.snapshotDir, name);
      if (!existsSync(path)) {
        throw new Error(`no snapshot at ${path} — run \`mcp-catalog-snap snapshot\` first`);
      }
      // Integrity first: a hand-edited baseline (e.g. tools emptied) would
      // otherwise be compared as if it were a real capture.
      const stored = readVerifiedSnapshot(path);
      // why: scrub the model before rendering, so no formatter (escaping, windows, pointers) sees a raw credential
      const diff = scrubDeep(diffCatalogs(stored.catalog, live.catalog), io.variants());
      const verdict = scrubDeep(evaluate(diff, policy), io.variants());
      results.push({
        server: name,
        ok: true,
        drift: verdict.drift,
        snapshotPath: path,
        fingerprint: { snapshot: diff.fingerprint.before, live: diff.fingerprint.after },
        serverVersion: { snapshot: stored.server.version, live: live.server.version },
        diff,
        verdict,
      });
      if (!opts.json) {
        io.out(`== ${visible(name)} (${visible(path)})`);
        if (stored.server.version !== live.server.version) {
          io.out(`server version: ${visible(stored.server.version)} -> ${visible(live.server.version)}`);
        }
        io.out(renderDiff(diff, verdict));
        io.out('');
      }
      if (verdict.drift && opts.update) {
        const text = serializeSnapshot(live);
        assertNoSecrets(text, targetSecrets(spec.target), 'captured catalog');
        writeText(io, path, text);
        if (!opts.json) io.out(`updated ${path}`);
      }
    } catch (err) {
      const tampered = err instanceof SnapshotIntegrityError;
      const r: ServerResult = { server: label, ok: false, drift: false, error: scrubErrorText((err as Error).message) };
      if (tampered) {
        r.tampered = true;
        r.snapshotPath = err.path;
      }
      results.push(r);
      if (!opts.json) io.err(`error: ${visible(label)}: ${oneLine((err as Error).message)}`);
    }
  }

  const anyTampered = results.some((r) => r.tampered === true);
  const anyError = results.some((r) => !r.ok);
  const anyDrift = results.some((r) => r.drift);
  const report: CheckReport = {
    tool: `mcp-catalog-snap/${VERSION}`,
    ok: !anyError && !anyDrift,
    policy: {
      ignoreDescriptions: policy.ignoreDescriptions ?? false,
      allowAdditions: policy.allowAdditions ?? false,
      allowWriteAdditions: policy.allowWriteAdditions ?? false,
    },
    servers: scrubDeep(results, io.variants()),
  };
  if (opts.reportFile !== undefined) {
    try {
      writeText(io, opts.reportFile, `${jsonSafe(JSON.stringify(report, null, 2))}\n`);
    } catch (err) {
      io.err(`error: cannot write report ${opts.reportFile}: ${oneLine((err as Error).message)}`);
      return EXIT_ERROR;
    }
  }
  if (opts.json) {
    io.out(jsonSafe(JSON.stringify(report, null, 2)));
  } else if (!anyError) {
    const n = results.length;
    io.out(anyDrift ? `${results.filter((r) => r.drift).length}/${n} server(s) drifted` : `${n}/${n} server(s) match their snapshot`);
  }
  if (anyTampered) return EXIT_TAMPERED;
  if (anyError) return EXIT_ERROR;
  return anyDrift ? EXIT_DRIFT : EXIT_OK;
}

/* ------------------------------------------------------------------ */
/* diff                                                               */
/* ------------------------------------------------------------------ */

export interface DiffOptions extends DriftPolicy {
  json?: boolean;
}

export function cmdDiff(aPath: string, bPath: string, opts: DiffOptions, io: IO): number {
  let a: Snapshot;
  let b: Snapshot;
  try {
    a = readVerifiedSnapshot(aPath);
    b = readVerifiedSnapshot(bPath);
  } catch (err) {
    io.err(`error: ${oneLine((err as Error).message)}`);
    return err instanceof SnapshotIntegrityError ? EXIT_TAMPERED : EXIT_ERROR;
  }
  const diff = diffCatalogs(a.catalog, b.catalog);
  const verdict = evaluate(diff, opts);
  if (opts.json) {
    io.out(jsonSafe(JSON.stringify({ a: aPath, b: bPath, drift: verdict.drift, diff, verdict }, null, 2)));
  } else {
    io.out(renderDiff(diff, verdict, { beforeLabel: aPath, afterLabel: bPath }));
  }
  return verdict.drift ? EXIT_DRIFT : EXIT_OK;
}

/* ------------------------------------------------------------------ */
/* hash                                                               */
/* ------------------------------------------------------------------ */

export interface HashOptions extends CommonOptions {
  /** Snapshot file to hash instead of a live server. */
  file?: string;
}

export async function cmdHash(opts: HashOptions, rawIo: IO): Promise<number> {
  let io = rawIo;
  try {
    if (opts.file !== undefined) {
      // Nothing on stdout for a tampered file, so `$(mcp-catalog-snap hash F)`
      // cannot pick up a hash that no capture ever produced.
      const snap = readVerifiedSnapshot(opts.file);
      io.out(snap.sha256);
      return EXIT_OK;
    }
    if (!opts.target && !opts.config && !existsSync(resolve(opts.cwd ?? process.cwd(), DEFAULT_CONFIG_FILE))) {
      throw new Error('hash needs a snapshot FILE, --url URL, `-- command args`, or a .mcp-catalog.json');
    }
    const resolved = resolveTargets(opts);
    io = scrubbed(rawIo, resolved.specs);
    for (const spec of resolved.specs) {
      const raw = await capture(spec.target, captureOpts(opts));
      const snap = buildSnapshot(raw);
      io.out(resolved.specs.length > 1 ? `${snap.sha256}  ${visible(spec.name || raw.server.name)}` : snap.sha256);
    }
    return EXIT_OK;
  } catch (err) {
    io.err(`error: ${oneLine((err as Error).message)}`);
    return err instanceof SnapshotIntegrityError ? EXIT_TAMPERED : EXIT_ERROR;
  }
}
