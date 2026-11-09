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
import { UNSAFE_TEXT, decodeSafe, looksSecret, safeUrl } from './safe-text.js';

export { looksSecret, safeUrl };

/** Header names whose values are credentials. */
const CREDENTIAL_HEADER = /^(authorization|proxy-authorization|cookie|x-api-key|api-key)$|token|secret|key|auth|session|password/i;
/** Env var names (stdio children) whose values are credentials. */
const CREDENTIAL_ENV = /token|secret|key|auth|pass|cookie|session|credential/i;
/** URL query parameter names whose values are credentials (signed-URL and OAuth styles included: sig, X-Amz-Signature, X-Goog-Credential, code, jwt, pat). */
const CREDENTIAL_QUERY = /token|secret|key|auth|pass|cookie|session|credential|sig|jwt|bearer|^code$|^pat$/i;
/**
 * Credentials shorter than this cannot be scrubbed without masking ordinary
 * text (and hex hashes), so a credential *header* shorter than this is
 * refused outright (`assertCredentialLengths`); short credential-looking
 * env values for stdio children are passed through unscrubbed.
 */
export const MIN_SECRET = 8;

export const REDACTED = '***';

/**
 * URL credentials: the password and credential-named query values. (Only
 * names decide: these values also make a catalog that echoes them be
 * refused, so a guess would refuse ordinary ids. Credential-looking path
 * segments are masked wherever a URL is shown instead; see `safeUrl`.)
 */
function urlSecrets(url: string): string[] {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return [];
  }
  const out: string[] = [];
  if (u.password) out.push(u.password, decodeSafe(u.password));
  for (const [k, v] of u.searchParams) if (CREDENTIAL_QUERY.test(k)) out.push(v);
  return out;
}

/** Stdio arguments of credential-named flags: `--token X`, `--api-key=X`. */
function argSecrets(args: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = /^--?([A-Za-z0-9_.-]+)=(.+)$/.exec(a);
    if (eq) {
      if (CREDENTIAL_ENV.test(eq[1]!)) out.push(eq[2]!);
    } else if (/^--?[A-Za-z0-9_.-]+$/.test(a) && CREDENTIAL_ENV.test(a)) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('-')) {
        out.push(next);
        i++;
      }
    }
  }
  return out;
}

/**
 * Secret values a target carries: credential header values (and the part
 * after the scheme), URL credentials, credential env values and arguments.
 */
export function targetSecrets(t: Target | undefined): string[] {
  const out: string[] = [];
  if (t?.kind === 'http') {
    for (const [k, v] of Object.entries(t.headers ?? {})) {
      if (!CREDENTIAL_HEADER.test(k)) continue;
      out.push(v);
      const m = /^\S+\s+(.+)$/.exec(v);
      if (m) out.push(m[1]!);
    }
    out.push(...urlSecrets(t.url));
  } else if (t?.kind === 'stdio') {
    for (const [k, v] of Object.entries(t.env ?? {})) if (CREDENTIAL_ENV.test(k)) out.push(v);
    out.push(...argSecrets(t.args));
  }
  return normalizeSecrets(out);
}

/** Unique, long enough, longest first (so a token inside "Bearer <token>" is caught either way). */
export function normalizeSecrets(values: Iterable<string>): string[] {
  return [...new Set([...values].map((s) => s.trim()).filter((s) => s.length >= MIN_SECRET))].sort((a, b) => b.length - a.length);
}

/** Refuse credential headers too short to scrub reliably. */
export function assertCredentialLengths(t: Target | undefined): void {
  if (t?.kind !== 'http') return;
  for (const [k, v] of Object.entries(t.headers ?? {})) {
    if (!CREDENTIAL_HEADER.test(k)) continue;
    const m = /^\S+\s+(.+)$/.exec(v.trim());
    const secret = (m ? m[1]! : v).trim();
    if (secret.length < MIN_SECRET) {
      throw new Error(`the ${k} credential must be at least ${MIN_SECRET} characters; a shorter one could not be reliably kept out of output`);
    }
  }
}

/** The markdown escaping `mdText` applies (shared so the scrubber can match its output). */
export function mdEscape(s: string): string {
  // why: U+2060 WORD JOINER breaks GFM autolinks (scheme://, www.) and @-mentions without changing what a reader sees;
  // `&` is escaped first so entities (&#64;, &lsqb;, …) cannot spell a mention, link or tag.
  return s
    .replace(/&/g, '&amp;')
    .replace(/[\\`*_[\]<>|~]/g, (c) => `\\${c}`)
    .replace(/:\/\//g, ':\u2060//')
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}\u2060.`)
    .replace(/@/g, '@\u2060');
}

/** The escaping `mdCode` applies inside a code span. */
export function mdCodeEscape(s: string): string {
  // `##[` is a runner legacy command anywhere in a line: break it with the renderer's own word joiner
  return `\`${s.replace(/[\r\n\t`]+/g, ' ').replace(UNSAFE_TEXT, '').replace(/##\[/g, `#${String.fromCharCode(0x2060)}#[`).replace(/\|/g, '\\|')}\``;
}

function b64Cores(s: string, alphabet: 'base64' | 'base64url'): string[] {
  // base64 of s depends on its byte offset mod 3 inside a larger blob; per alignment keep only the
  // 4-char groups made purely of s's bytes (they appear verbatim wherever s is encoded at that offset)
  const out: string[] = [];
  const bytes = Buffer.from(s);
  for (let pad = 0; pad < 3; pad++) {
    const enc = Buffer.concat([Buffer.alloc(pad, 0), bytes]).toString(alphabet);
    const start = pad > 0 ? 4 : 0;
    const end = Math.floor((pad + bytes.length) / 3) * 4;
    if (end - start >= MIN_SECRET) out.push(enc.slice(start, end));
  }
  return out;
}

/**
 * Every form a formatter could turn a secret into: raw, markdown-escaped,
 * code-span-escaped, JSON-pointer-escaped (`~0` `~1`), JSON-escaped
 * (once and twice), percent-encoded, base64 and base64url (any alignment).
 * Longest first, so the longest match is masked.
 */
export function secretVariants(secrets: readonly string[]): string[] {
  const out = new Set<string>();
  for (const s of secrets) {
    const ptr = s.replace(/~/g, '~0').replace(/\//g, '~1');
    const json = JSON.stringify(s).slice(1, -1);
    for (const v of [
      s,
      mdEscape(s),
      mdCodeEscape(s).slice(1, -1),
      ptr,
      mdEscape(ptr),
      json,
      JSON.stringify(json).slice(1, -1),
      encodeURIComponent(s),
      encodeURI(s),
      encodeURIComponent(ptr),
      ...b64Cores(s, 'base64'),
      ...b64Cores(s, 'base64url'),
    ]) {
      out.add(v);
    }
  }
  return normalizeSecrets(out);
}

const ELLIPSIS = '…';
const MIN_FRAGMENT = 6;

/**
 * Scrub `secrets` (pass `secretVariants(...)` for full coverage). Also masks
 * a fragment of 6+ characters of a secret sitting at a truncation point
 * (just before or after `…`), so a cut can never print a token prefix.
 */
export function redact(text: string, secrets: readonly string[]): string {
  if (secrets.length === 0) return text;
  let out = text;
  for (const s of secrets) if (out.includes(s)) out = out.split(s).join(REDACTED);
  if (!out.includes(ELLIPSIS)) return out;
  const parts = out.split(ELLIPSIS);
  for (let i = 0; i < parts.length; i++) {
    let p = parts[i]!;
    for (const s of secrets) {
      if (i < parts.length - 1) {
        // text before an ellipsis: does it end with a prefix of s?
        for (let k = Math.min(s.length - 1, p.length); k >= MIN_FRAGMENT; k--) {
          if (p.endsWith(s.slice(0, k))) {
            p = `${p.slice(0, p.length - k)}${REDACTED}`;
            break;
          }
        }
      }
      if (i > 0) {
        // text after an ellipsis: does it start with a suffix of s?
        for (let k = Math.min(s.length - 1, p.length); k >= MIN_FRAGMENT; k--) {
          if (p.startsWith(s.slice(s.length - k))) {
            p = `${REDACTED}${p.slice(k)}`;
            break;
          }
        }
      }
    }
    parts[i] = p;
  }
  return parts.join(ELLIPSIS);
}

export function containsSecret(text: string, secrets: readonly string[]): boolean {
  return secrets.some((s) => text.includes(s));
}

/**
 * Deep copy of `value` with every string and every object key scrubbed.
 * Iterative (report and diff objects can be deep). Applied to the report
 * model before any renderer runs, so formatting never sees a raw secret.
 */
export function scrubDeep<T>(value: T, secrets: readonly string[]): T {
  if (secrets.length === 0) return value;
  const conv = (v: unknown): unknown => {
    if (typeof v === 'string') return redact(v, secrets);
    if (v === null || typeof v !== 'object') return v;
    return Array.isArray(v) ? new Array<unknown>(v.length) : {};
  };
  const root = conv(value);
  const stack: [unknown, unknown][] = [[value, root]];
  while (stack.length > 0) {
    const [src, dst] = stack.pop()!;
    if (src === null || typeof src !== 'object') continue;
    if (Array.isArray(src)) {
      const d = dst as unknown[];
      for (let i = 0; i < src.length; i++) {
        d[i] = conv(src[i]);
        stack.push([src[i], d[i]]);
      }
    } else {
      const d = dst as Record<string, unknown>;
      for (const [k, v] of Object.entries(src as Record<string, unknown>)) {
        if (v === undefined) continue;
        const c = conv(v);
        Object.defineProperty(d, redact(k, secrets), { value: c, writable: true, enumerable: true, configurable: true });
        stack.push([v, c]);
      }
    }
  }
  return root as T;
}

/** Refuse to persist or print a body that embeds a credential the request carried. */
export function assertNoSecrets(text: string, secrets: readonly string[], what: string): void {
  if (containsSecret(text, secretVariants(secrets))) {
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
/**
 * An IO whose every line and file is scrubbed of all forms of `secrets`.
 * `secrets` may grow after creation (e.g. an API key read later); variants
 * are recomputed when it does.
 */
export function redactingIO(io: IO, secrets: string[]): IO & { secrets: string[]; variants: () => string[] } {
  let seen = -1;
  let cached: string[] = [];
  const variants = (): string[] => {
    if (seen !== secrets.length) {
      cached = secretVariants(secrets);
      seen = secrets.length;
    }
    return cached;
  };
  return {
    secrets,
    variants,
    out: (s) => io.out(redact(s, variants())),
    err: (s) => io.err(redact(s, variants())),
    writeFile: (path, text) => writeText(io, path, redact(text, variants())),
  };
}
