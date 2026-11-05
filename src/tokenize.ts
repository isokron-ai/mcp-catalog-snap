/**
 * Pluggable text tokenizers for size measurement.
 *
 * Token counts here are a *reference scale*, not what any particular model
 * bills. `cl100k` (tiktoken cl100k_base) is the default because published
 * MCP size comparisons use it; `o200k` is offered for the newer OpenAI
 * family and `chars4` reproduces the common `ceil(chars / 4)` heuristic
 * that several servers use for their own size limits. A provider-reported
 * count (Anthropic) lives in `anthropic.ts` because it counts tool
 * definitions over the network, not text.
 *
 * BPE comes from `gpt-tokenizer`, whose merge loop is linear in practice:
 * a 64K-character single word counts in ~0.1 s (js-tiktoken, used before,
 * took minutes on such input). Texts over `TOKENIZE_CHUNK` units are
 * counted in chunks cut only where the pre-tokenizer must end a piece
 * anyway; a long boundary-free word stays in one chunk. Counts are
 * therefore exact, never approximate: the test suite checks them against
 * Python tiktoken oracle values, including adversarial long runs of
 * letters, digits and hex, contractions at chunk edges and combining
 * marks.
 *
 * Special-token strings such as `<|endoftext|>` are counted as plain text
 * (tiktoken's `disallowed_special=()`), so a description that happens to
 * contain one is measured instead of throwing.
 */

/** A synchronous text → token-count function, loaded once. */
export interface Tokenizer {
  /** Stable id used as the key in reports (`cl100k`, `o200k`, `chars4`, or a custom id). */
  readonly id: string;
  /** Human label carried into reports so a number is never shown without its scale. */
  readonly label: string;
  count(text: string): number;
}

export type TokenizerFactory = () => Promise<Tokenizer>;

/** Texts longer than this many UTF-16 units are counted chunk by chunk. */
export const TOKENIZE_CHUNK = 2_048;

const LN = /[\p{L}\p{N}]/u;
const LNM = /[\p{L}\p{N}\p{M}]/u;

/**
 * True when cl100k/o200k pre-tokenization must end a piece at `i`: the
 * code point before `i` is a letter or digit and the one at `i` is not a
 * letter, digit, combining mark or apostrophe (contractions). Pieces never
 * span such a point, so the two sides count the same separately as
 * together. Lone surrogates are neither letters nor digits.
 */
function isPieceBoundary(text: string, i: number): boolean {
  const nextCode = text.charCodeAt(i);
  if (nextCode >= 0xdc00 && nextCode <= 0xdfff && i > 0) {
    const before = text.charCodeAt(i - 1);
    if (before >= 0xd800 && before <= 0xdbff) return false; // inside a surrogate pair
  }
  const next = String.fromCodePoint(text.codePointAt(i)!);
  if (next === "'" || LNM.test(next)) return false;
  const p1 = text.charCodeAt(i - 1);
  let prev: string;
  if (p1 >= 0xdc00 && p1 <= 0xdfff && i >= 2) {
    const p0 = text.charCodeAt(i - 2);
    prev = p0 >= 0xd800 && p0 <= 0xdbff ? text.slice(i - 2, i) : text[i - 1]!;
  } else {
    prev = text[i - 1]!;
  }
  return prev.length === 2 || !(p1 >= 0xd800 && p1 <= 0xdfff) ? LN.test(prev) : false;
}

/**
 * Split text into pieces of about TOKENIZE_CHUNK units, each cut at a
 * piece boundary, so the summed count is exact. A stretch with no boundary
 * (one long word) stays whole: gpt-tokenizer is linear on such input, so
 * no hard cut is needed.
 */
export function chunkText(text: string): string[] {
  if (text.length <= TOKENIZE_CHUNK) return [text];
  const out: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + TOKENIZE_CHUNK, text.length);
    if (end < text.length) {
      let cut = -1;
      for (let j = end; j > i; j--) {
        if (isPieceBoundary(text, j)) {
          cut = j;
          break;
        }
      }
      if (cut < 0) for (let j = end + 1; j < text.length; j++) if (isPieceBoundary(text, j)) {
        cut = j;
        break;
      }
      end = cut < 0 ? text.length : cut;
    }
    out.push(text.slice(i, end));
    i = end;
  }
  return out;
}

interface Encoder {
  countTokens: (text: string, opts?: { disallowedSpecial?: Set<string> }) => number;
}

async function bpe(id: string, label: string, load: () => Promise<Encoder>): Promise<Tokenizer> {
  const enc = await load();
  const opts = { disallowedSpecial: new Set<string>() };
  const one = (t: string): number => (t.length === 0 ? 0 : enc.countTokens(t, opts));
  return { id, label, count: (text) => chunkText(text).reduce((n, c) => n + one(c), 0) };
}

const BUILTIN: Record<string, TokenizerFactory> = {
  cl100k: () => bpe('cl100k', 'tiktoken cl100k_base (reference scale; not a Claude tokenizer)', () => import('gpt-tokenizer/encoding/cl100k_base')),
  o200k: () => bpe('o200k', 'tiktoken o200k_base (reference scale)', () => import('gpt-tokenizer/encoding/o200k_base')),
  chars4: async () => ({
    id: 'chars4',
    label: 'ceil(UTF-16 length / 4) heuristic (not a tokenizer)',
    count: (text) => Math.ceil(text.length / 4),
  }),
};

const custom = new Map<string, TokenizerFactory>();

/** Built-in tokenizer ids, in display order. */
export const BUILTIN_TOKENIZERS: readonly string[] = Object.keys(BUILTIN);

/** The tokenizer every report and budget defaults to. */
export const REFERENCE_TOKENIZER = 'cl100k';

/** Register a custom tokenizer (programmatic API). Ids must be unique. */
export function registerTokenizer(id: string, factory: TokenizerFactory): void {
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) throw new Error(`tokenizer id must be lowercase [a-z0-9._-]: ${JSON.stringify(id)}`);
  if (Object.hasOwn(BUILTIN, id) || custom.has(id)) throw new Error(`tokenizer "${id}" is already registered`);
  custom.set(id, factory);
}

const loaded = new Map<string, Promise<Tokenizer>>();

/** Load (once) and return the tokenizer with this id. */
export function loadTokenizer(id: string): Promise<Tokenizer> {
  const factory = Object.hasOwn(BUILTIN, id) ? BUILTIN[id] : custom.get(id);
  if (!factory) {
    const known = [...BUILTIN_TOKENIZERS, ...custom.keys()].join(', ');
    return Promise.reject(new Error(`unknown tokenizer "${id}" (known: ${known})`));
  }
  let p = loaded.get(id);
  if (!p) {
    p = factory();
    loaded.set(id, p);
  }
  return p;
}

/** Load several tokenizers, de-duplicated, keeping the given order. */
export async function loadTokenizers(ids: readonly string[]): Promise<Tokenizer[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new Error('at least one tokenizer is required');
  return Promise.all(unique.map(loadTokenizer));
}

/** UTF-8 byte length. */
export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}
