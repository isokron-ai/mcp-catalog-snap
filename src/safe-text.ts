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

/** C0 and C1 controls, DEL, line/paragraph separators, bidi embedding/override/isolate controls. */
// U+2028..U+2069 are built from char codes so no editor or tool turns them into raw separators in this file.
export const UNSAFE_TEXT = new RegExp(`[\\u0000-\\u001f\\u007f-\\u009f${String.fromCharCode(0x2028, 0x2029)}${String.fromCharCode(0x202a)}-${String.fromCharCode(0x202e)}${String.fromCharCode(0x2066)}-${String.fromCharCode(0x2069)}]`, 'g');

const SHORT: Record<string, string> = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** Untrusted text with every unsafe character written as an escape (`\n`, `\u001b`, …). */
export function visible(s: string): string {
  return s.replace(UNSAFE_TEXT, (c) => SHORT[c] ?? `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** Default cap for one error line. */
export const MAX_ERROR_CHARS = 1000;

/** An error message as one visible line: line breaks (with their indentation) become one space, the rest is escaped, then capped. */
export function oneLine(s: string, max = MAX_ERROR_CHARS): string {
  const v = visible(s.replace(/[ \t]*\r?\n[ \t]*/g, ' '));
  return v.length > max ? `${v.slice(0, max - 1)}…` : v;
}
