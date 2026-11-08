/**
 * Server text that reaches a terminal or CI log.
 *
 * Names, paths and error messages come from the server. Printed raw, a
 * newline lets them start a line a CI runner reads as a workflow command
 * (GitHub Actions trims leading space and acts on `::warning::`,
 * `::add-mask::`, …) or close a step-summary code fence, and ESC / BEL /
 * NUL drive the terminal. `visible` writes those characters as JSON-style
 * escapes so they show up instead of acting; `oneLine` is for error
 * messages: one line, escaped, length-capped.
 */

const ch = (...codes: number[]): string => String.fromCharCode(...codes);
// Ranges are built from char codes so no editor or tool turns them into raw characters in this file.
/** Characters that act on a terminal or reorder text: C0 (bar newline and tab, handled per use), DEL, C1, line/paragraph separators, bidi marks, embeddings, overrides and isolates. */
const TERMINAL_RANGES = `\\u0000-\\u001f\\u007f-\\u009f${ch(0x2028, 0x2029, 0x061c, 0x200e, 0x200f)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}`;
/** Invisible format characters that hide or spoof text: soft hyphen, Mongolian vowel separator, zero-width space/joiners, word joiner and invisible operators, deprecated format controls, BOM / zero-width no-break space. */
const INVISIBLE_RANGES = `${ch(0x00ad, 0x180e)}${ch(0x200b)}-${ch(0x200d)}${ch(0x2060)}-${ch(0x2064)}${ch(0x206a)}-${ch(0x206f)}${ch(0xfeff)}`;

/** Everything stripped from or escaped in server text: terminal-active and invisible characters. */
export const UNSAFE_TEXT = new RegExp(`[${TERMINAL_RANGES}${INVISIBLE_RANGES}]`, 'g');

/**
 * What the output boundary escapes in every line the CLI prints. Newline and
 * tab pass (output is multi-line); invisible characters pass because the
 * markdown renderer inserts U+2060 on purpose to break autolinks and
 * @-mentions, and server text has already had them removed or escaped.
 */
const TERMINAL_ACTIVE = new RegExp(`[${TERMINAL_RANGES}]`, 'g');

const SHORT: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const escapeChar = (c: string): string => SHORT[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Untrusted text with every unsafe character written as an escape (`\n`, `\u001b`, …). */
export function visible(s: string): string {
  return s.replace(UNSAFE_TEXT, (c) => escapeChar(c));
}

/** Default cap for one error line. */
export const MAX_ERROR_CHARS = 1000;

/** An error message as one visible line: URLs reduced to origin + path (`scrubUrls`), line breaks (with their indentation) become one space, the rest is escaped, then capped. */
export function oneLine(s: string, max = MAX_ERROR_CHARS): string {
  const v = visible(scrubUrls(s).replace(/[ \t]*\r?\n[ \t]*/g, ' '));
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}


/**
 * The output boundary: every line the CLI writes to stdout/stderr passes
 * here last (after credential scrubbing). Terminal-active characters become
 * escapes, a line that would start (after leading space, as GitHub Actions
 * reads it) with a workflow command `::` or a code fence gets a leading
 * backslash. This holds whatever call site printed a server string; JSON
 * output stays valid and means the same (escapes only appear inside strings).
 */
export function terminalSafe(text: string): string {
  return text
    .replace(TERMINAL_ACTIVE, (c) => (c === '\n' || c === '\t' ? c : escapeChar(c)))
    .split('\n')
    .map((line) => (line.trimStart().startsWith('::') || /^ {0,3}(```|~~~)/.test(line) ? line.replace(/^(\s*)/, '$1\\') : line))
    .join('\n');
}

/**
 * A value that looks like a credential on its own (some servers put API
 * keys in the URL path or take them as a bare argument): 16+ chars mixing
 * letters and digits, or long hex.
 */
export function looksSecret(value: string): boolean {
  const s = decodeSafe(value);
  if (s.length < 16) return false;
  if (/^[0-9a-f]{16,}$/i.test(s)) return true;
  return /[A-Za-z]/.test(s) && /\d/.test(s) && /^[A-Za-z0-9_\-.~+=]+$/.test(s);
}

export function decodeSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * A URL for display: origin and path only (no user:password@), credential-
 * looking path segments masked, and any query replaced by a marker (query
 * strings carry signatures and tokens under too many names to list).
 * `inline` writes the marker as `?[query redacted]` for use inside text.
 */
export function safeUrl(url: string, inline = false): string {
  try {
    const u = new URL(url);
    const path = u.pathname
      .split('/')
      .map((seg) => (looksSecret(seg) ? '***' : seg))
      .join('/');
    const query = u.search ? (inline ? '?[query redacted]' : ' [query redacted]') : '';
    return `${u.origin}${path}${query}`;
  } catch {
    return '<invalid url>';
  }
}

/** Every http(s) URL inside free text (server or SDK error messages) reduced to `safeUrl` form; trailing punctuation is kept. */
export function scrubUrls(text: string): string {
  return text.replace(/\bhttps?:\/\/[^\s"'<>()[\]{}]+/gi, (m) => {
    const tail = /[.,;:!?]+$/.exec(m)?.[0] ?? '';
    const url = tail ? m.slice(0, -tail.length) : m;
    const safe = safeUrl(url, true);
    return `${safe === '<invalid url>' ? '<url>' : safe}${tail}`;
  });
}
