/**
 * Optional provider-reported token counts from Anthropic's free
 * `POST /v1/messages/count_tokens` endpoint.
 *
 * Opt-in only (`--anthropic`): it sends the catalog to a third party, so it
 * never runs just because `ANTHROPIC_API_KEY` happens to be set in a CI
 * environment. When it is requested and no key is set, it is skipped with a
 * note instead of failing the sweep.
 *
 * What the numbers mean:
 *   - `baseline`: input tokens for a one-word user message with no tools.
 *   - per tool: count([tool]) − baseline. This *includes* the fixed tool-use
 *     preamble the API adds whenever any tool is present, so per-tool values
 *     are not additive.
 *   - `catalog`: count(all tools) − baseline, the preamble counted once.
 *     `null` when the request is refused (e.g. too large).
 * A tool the API rejects (name pattern, schema) gets `null` and an error.
 */

import { setOwn } from './canonical.js';
import type { CatalogTool } from './snapshot.js';

export const ANTHROPIC_API_KEY_ENV = 'ANTHROPIC_API_KEY';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';
const API_URL = 'https://api.anthropic.com/v1/messages/count_tokens';
const API_VERSION = '2023-06-01';

export interface AnthropicCountOptions {
  apiKey: string;
  model?: string;
  /** Injected in tests; defaults to global fetch. */
  fetch?: typeof fetch;
  url?: string;
  concurrency?: number;
}

export interface AnthropicCounts {
  model: string;
  baseline: number;
  catalog: number | null;
  perTool: Record<string, number | null>;
  errors: { tool: string | null; message: string }[];
}

interface ApiTool {
  name: string;
  description?: string;
  input_schema: unknown;
}

function toApiTool(t: CatalogTool): ApiTool {
  const out: ApiTool = { name: t.name, input_schema: t.inputSchema ?? { type: 'object' } };
  if (typeof t.description === 'string') out.description = t.description;
  return out;
}

export async function anthropicToolCounts(tools: readonly CatalogTool[], opts: AnthropicCountOptions): Promise<AnthropicCounts> {
  const doFetch = opts.fetch ?? fetch;
  const model = opts.model ?? DEFAULT_ANTHROPIC_MODEL;
  const url = opts.url ?? API_URL;
  const secret = opts.apiKey;

  async function count(apiTools: ApiTool[] | null): Promise<number> {
    const body: Record<string, unknown> = { model, messages: [{ role: 'user', content: 'x' }] };
    if (apiTools) body['tools'] = apiTools;
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': secret, 'anthropic-version': API_VERSION },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) {
      // Never echo request headers; the response body carries the API's own message.
      throw new Error(`HTTP ${res.status}: ${text.split(secret).join('***').slice(0, 300)}`);
    }
    const parsed = JSON.parse(text) as { input_tokens?: unknown };
    if (typeof parsed.input_tokens !== 'number') throw new Error('response has no numeric input_tokens');
    return parsed.input_tokens;
  }

  const baseline = await count(null);
  const errors: AnthropicCounts['errors'] = [];
  const perTool = new Map<string, number | null>();
  const queue = [...tools];
  const workers = Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      try {
        perTool.set(t.name, (await count([toApiTool(t)])) - baseline);
      } catch (err) {
        perTool.set(t.name, null);
        errors.push({ tool: t.name, message: (err as Error).message });
      }
    }
  });
  await Promise.all(workers);

  let catalog: number | null = null;
  if (tools.length > 0) {
    try {
      catalog = (await count(tools.map(toApiTool))) - baseline;
    } catch (err) {
      errors.push({ tool: null, message: `whole-catalog count: ${(err as Error).message}` });
    }
  }
  const key = (e: { tool: string | null; message: string }): string => `${e.tool ?? ''}\u0000${e.message}`;
  errors.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  // why: tool names are untrusted keys; a null-prototype object with own properties keeps `__proto__` as data.
  const sortedPerTool = Object.create(null) as Record<string, number | null>;
  for (const k of [...perTool.keys()].sort()) setOwn(sortedPerTool, k, perTool.get(k)!);
  return { model, baseline, catalog, perTool: sortedPerTool, errors };
}
