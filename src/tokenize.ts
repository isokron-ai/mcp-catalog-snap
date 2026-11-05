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

async function tiktoken(id: string, label: string, load: () => Promise<{ default: RankFile }>): Promise<Tokenizer> {
  const [{ Tiktoken }, ranks] = await Promise.all([import('js-tiktoken/lite'), load()]);
  const enc = new Tiktoken(ranks.default);
  return { id, label, count: (text) => (text.length === 0 ? 0 : enc.encode(text, [], []).length) };
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
