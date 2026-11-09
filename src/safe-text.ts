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
const ACTIVE_NOT_C0 = `\\u007f-\\u009f${ch(0x2028, 0x2029, 0x061c, 0x200e, 0x200f)}${ch(0x202a)}-${ch(0x202e)}${ch(0x2066)}-${ch(0x2069)}`;
const TERMINAL_RANGES = `\\u0000-\\u001f${ACTIVE_NOT_C0}`;
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
/** UNSAFE_TEXT minus C0: in JSON text raw C0 is only structural whitespace (JSON.stringify escapes it inside strings). */
const JSON_UNSAFE = new RegExp(`[${ACTIVE_NOT_C0}${INVISIBLE_RANGES}]`, 'g');
/** Leading space or invisible characters before a would-be `::` workflow command (.NET TrimStart trims Unicode spaces; be wider). */
const LEADING_BLANK = new RegExp(`^[\\s${INVISIBLE_RANGES}]*`);

const SHORT: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };
const escapeChar = (c: string): string => SHORT[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;

/** Untrusted text with every unsafe character written as an escape (`\n`, `\u001b`, …). */
export function visible(s: string): string {
  return s.replace(UNSAFE_TEXT, (c) => escapeChar(c));
}

/** Default cap for one error line. */
export const MAX_ERROR_CHARS = 1000;

/** An error message as one visible line: line breaks (with their indentation) become one space, the rest is escaped, then capped. */
export function oneLine(s: string, max = MAX_ERROR_CHARS): string {
  const v = visible(s.replace(/[ \t]*\r?\n[ \t]*/g, ' '));
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
    // the runner's legacy commands match `##[` anywhere in a line (ActionCommand.TryParse: IndexOf("##[")).
    // `\u0023` is `#` as a JSON escape, so printed JSON still parses to the same values.
    .replace(/##\[/g, '#\\u0023[')
    .split('\n')
    .map((line) => {
      const lead = LEADING_BLANK.exec(line)![0];
      const rest = line.slice(lead.length);
      return rest.startsWith('::') || /^ {0,3}(```|~~~)/.test(line) ? `${lead}\\${rest}` : line;
    })
    .join('\n');
}

/**
 * Escape, inside JSON text, every character a human viewer must not see raw
 * (C1, U+2028/9, bidi and invisible format characters; JSON.stringify
 * already escapes C0). Such characters can only occur inside JSON strings,
 * so the result parses to the same values; `##[` (a runner legacy command)
 * becomes `#\u0023[` the same way. Used for every JSON the CLI
 * prints or writes: `--json`, `--no-write`, snapshot files, reports, raw
 * dumps.
 */
export function jsonSafe(json: string): string {
  return json.replace(JSON_UNSAFE, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).replace(/##\[/g, '#\\u0023[');
}
