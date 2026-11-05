/**
 * Credential hygiene. Values that carry secrets (bearer tokens and other
 * credential headers, credential-looking env vars for stdio children) are
 * collected per target and scrubbed from everything the CLI prints or
 * writes. A catalog that *contains* such a value (a server echoing the
 * Authorization header into a description) is refused instead of
 * persisted: redacting it would make the snapshot disagree with the
 * server forever.
 */

import { writeFileSync } from 'node:fs';

import type { Target } from './capture.js';

/** Header names whose values are credentials. */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$|token|secret|key|auth|session|password/i;
/** Env var names (stdio children) whose values are credentials. */
const CREDENTIAL_ENV = /token|secret|key|auth|pass|cookie|session|credential/i;
/** Shorter values are not scrubbed: they would collide with ordinary text (and hashes). */
const MIN_SECRET = 8;

export const REDACTED = '***';

/** Secret values a target carries: credential header values (and the part after the scheme), credential env values. */
export function targetSecrets(t: Target | undefined): string[] {
  const out: string[] = [];
  if (t?.kind === 'http') {
    for (const [k, v] of Object.entries(t.headers ?? {})) {
      if (!CREDENTIAL_HEADER.test(k)) continue;
      out.push(v);
      const m = /^\S+\s+(.+)$/.exec(v);
      if (m) out.push(m[1]!);
    }
  } else if (t?.kind === 'stdio') {
    for (const [k, v] of Object.entries(t.env ?? {})) if (CREDENTIAL_ENV.test(k)) out.push(v);
  }
  return normalizeSecrets(out);
}

/** Unique, long enough, longest first (so a token inside "Bearer <token>" is caught either way). */
export function normalizeSecrets(values: Iterable<string>): string[] {
  return [...new Set([...values].map((s) => s.trim()).filter((s) => s.length >= MIN_SECRET))].sort((a, b) => b.length - a.length);
}

export function redact(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  return out;
}

export function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((s) => text.includes(s));
}

/** Refuse to persist or print a body that embeds a credential the request carried. */
export function assertNoSecrets(text: string, secrets: readonly string[], what: string): void {
  if (containsSecret(text, secrets)) {
    throw new Error(`${what} contains a credential this request sent (the server echoes it back); refusing to write or print it`);
  }
}

/** Sink for command output. `writeFile` lets the CLI scrub report files the same way as stdout. */
export interface IO {
  out: (line: string) => void;
  err: (line: string) => void;
  writeFile?: (path: string, text: string) => void;
}

/** Write through the IO's writer when it has one (the CLI's redacts), else straight to disk. */
export function writeText(io: IO, path: string, text: string): void {
  if (io.writeFile) io.writeFile(path, text);
  else writeFileSync(path, text, 'utf8');
}

/** An IO whose every line and file is scrubbed of `secrets` (secrets can be added later, e.g. per configured server). */
export function redactingIO(io: IO, secrets: string[]): IO & { secrets: string[] } {
  return {
    secrets,
    out: (s) => io.out(redact(s, secrets)),
    err: (s) => io.err(redact(s, secrets)),
    writeFile: (path, text) => writeText(io, path, redact(text, secrets)),
  };
}
