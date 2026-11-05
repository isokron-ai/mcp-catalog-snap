/**
 * Adapter interface: turn a server (live or saved) into what the sweep
 * measures.
 *
 * Plain servers expose their contract in `tools/list`, so the exposure of a
 * tool is its list entry. CLI/exec-style servers (one `exec` tool with
 * `tools` / `info` / `schema` sub-commands, like PostHog's) expose each
 * sub-tool's contract as command *output* text, so the adapter fetches that
 * text and says which view is the primary exposure. Everything after the
 * adapter (metrics, findings, report) is the same for both.
 */

import type { Finding } from '../findings.js';
import type { Catalog, CatalogTool } from '../snapshot.js';

export type SourceInfo =
  | { kind: 'stdio'; command: string }
  | { kind: 'http'; url: string }
  | { kind: 'file'; name: string; format: string };

export interface SweepInput {
  /** Adapter id that produced this input. */
  adapter: string;
  server: { name: string; version: string | null; title?: string };
  protocolVersion: string | null;
  source: SourceInfo;
  /** Normalized contracts (tools sorted by name), hashed like a snapshot catalog. */
  catalog: Catalog;
  /** Tools in server order for the ADR-0005 fingerprint; null when the order is unknown. */
  orderedTools: unknown[] | null;
  /** What `exposure` means, carried into the report. */
  exposureLabel: string;
  /** Per tool: the primary text the model is shown for it. Missing → JCS of the entry. */
  exposure: Record<string, string>;
  /** Per tool: further named views (e.g. exec `schema` output). */
  views: Record<string, Record<string, string>>;
  /** Per tool: a schema carried as an escaped string inside text, and the same schema as plain JSON. */
  embeddedSchemas: Record<string, { escaped: string; plain: string }>;
  /** The tools/list the client actually loads, when it differs from `catalog` (exec mode). */
  wrapperTools: CatalogTool[] | null;
  /** Adapter-specific findings (they need no tokenizer). */
  findings: Finding[];
  notes: string[];
}
