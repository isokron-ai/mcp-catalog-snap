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
 * Tool text is untrusted input. BPE is quadratic in the length of one
 * pre-tokenized piece, so a hostile multi-megabyte run of letters could
 * stall a sweep. Texts longer than `BOUNDED_TOKENIZE_ABOVE` UTF-16 units are
 * therefore counted in chunks of at most `TOKENIZE_CHUNK` units, cut after
 * a newline or whitespace; a run of 256+ non-space units is cut every 16. That can differ from an unchunked count by a
 * token or so per cut; real tool texts (the largest PostHog `info` payload
 * is 45K chars) stay below the threshold and are counted exactly.
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

interface RankFile {
  pat_str: string;
  special_tokens: Record<string, number>;
  bpe_ranks: string;
}

export const BOUNDED_TOKENIZE_ABOVE = 65_536;
export const TOKENIZE_CHUNK = 8_192;
/** Non-whitespace runs longer than this (the hostile case) are cut into HARD_CUT pieces. */
const LONG_RUN = 256;
const HARD_CUT = 16;

function pushHardCut(out: string[], run: string): void {
  for (let i = 0; i < run.length; ) {
    let end = Math.min(i + HARD_CUT, run.length);
    if (end < run.length && /[\uD800-\uDBFF]/.test(run[end - 1]!)) end--;
    out.push(run.slice(i, end));
    i = end;
  }
}

function pushWindows(out: string[], seg: string): void {
  // seg has no non-whitespace run over LONG_RUN, so a window always has whitespace near its end.
  for (let i = 0; i < seg.length; ) {
    let end = Math.min(i + TOKENIZE_CHUNK, seg.length);
    if (end < seg.length) {
      const window = seg.slice(i, end);
      const nl = window.lastIndexOf('\n');
      end = nl >= TOKENIZE_CHUNK / 2 ? i + nl + 1 : i + window.search(/\s\S*$/) + 1;
    }
    out.push(seg.slice(i, end));
    i = end;
  }
}

/**
 * Split long text for bounded counting: non-whitespace runs over LONG_RUN
 * units become HARD_CUT pieces; the rest is cut into ≤ TOKENIZE_CHUNK
 * windows after a newline (else whitespace). Never splits a surrogate pair.
 */
export function chunkText(text: string): string[] {
  if (text.length <= BOUNDED_TOKENIZE_ABOVE) return [text];
  const out: string[] = [];
  const longRun = new RegExp(`\\S{${LONG_RUN + 1},}`, 'g');
  let last = 0;
  for (const m of text.matchAll(longRun)) {
    if (m.index > last) pushWindows(out, text.slice(last, m.index));
    pushHardCut(out, m[0]);
    last = m.index + m[0].length;
  }
  if (last < text.length) pushWindows(out, text.slice(last));
  return out;
}

async function tiktoken(id: string, label: string, load: () => Promise<{ default: RankFile }>): Promise<Tokenizer> {
  const [{ Tiktoken }, ranks] = await Promise.all([import('js-tiktoken/lite'), load()]);
  const enc = new Tiktoken(ranks.default);
  const one = (t: string): number => (t.length === 0 ? 0 : enc.encode(t, [], []).length);
  // why: hostile text is usually repetitive, so identical chunks are counted once.
  const memo = new Map<string, number>();
  const chunk = (c: string): number => {
    let n = memo.get(c);
    if (n === undefined) {
      n = one(c);
      if (memo.size < 4096) memo.set(c, n);
    }
    return n;
  };
  return {
    id,
    label,
    count: (text) => (text.length <= BOUNDED_TOKENIZE_ABOVE ? one(text) : chunkText(text).reduce((n, c) => n + chunk(c), 0)),
  };
}

const BUILTIN: Record<string, TokenizerFactory> = {
  cl100k: () =>
    tiktoken(
      'cl100k',
      'tiktoken cl100k_base (reference scale; not a Claude tokenizer)',
      () => import('js-tiktoken/ranks/cl100k_base'),
    ),
  o200k: () =>
    tiktoken('o200k', 'tiktoken o200k_base (reference scale)', () => import('js-tiktoken/ranks/o200k_base')),
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
  if (id in BUILTIN || custom.has(id)) throw new Error(`tokenizer "${id}" is already registered`);
  custom.set(id, factory);
}

const loaded = new Map<string, Promise<Tokenizer>>();

/** Load (once) and return the tokenizer with this id. */
export function loadTokenizer(id: string): Promise<Tokenizer> {
  const factory = BUILTIN[id] ?? custom.get(id);
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
