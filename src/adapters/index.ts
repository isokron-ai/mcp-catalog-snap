/**
 * Adapter registry: pick an adapter by id and load a SweepInput from a
 * live target or a saved file.
 */

import { writeFileSync } from 'node:fs';
import { basename } from 'node:path';

import type { CaptureOptions, Target } from '../capture.js';
import { readInputText } from '../read-input.js';
import { assertNoSecrets } from '../redact.js';
import { EXEC_PROFILES, parseExecRecords, serializeExecRecords, sweepInputFromExecRecords, sweepInputFromExecServer } from './exec.js';
import { TOOLS_LIST_ADAPTER, parseToolsListFile, sweepInputFromServer } from './tools-list.js';
import type { SweepInput } from './types.js';

export const ADAPTERS: readonly string[] = [TOOLS_LIST_ADAPTER, ...Object.keys(EXEC_PROFILES)];

export interface LoadOptions extends CaptureOptions {
  adapter?: string;
  /** Saved input file (offline mode). */
  from?: string;
  target?: Target;
  /** Server name to report instead of the one the server / file gives. */
  name?: string;
  /** Exec adapters, live only: also write the fetched records as JSONL here. */
  saveRaw?: string;
  /** Credentials the request carried; a raw dump containing one is refused. */
  secrets?: string[];
}

export async function loadSweepInput(opts: LoadOptions): Promise<SweepInput> {
  const adapter = opts.adapter ?? TOOLS_LIST_ADAPTER;
  if (!ADAPTERS.includes(adapter) || (adapter !== TOOLS_LIST_ADAPTER && !Object.hasOwn(EXEC_PROFILES, adapter))) throw new Error(`unknown adapter "${adapter}" (known: ${ADAPTERS.join(', ')})`);
  if ((opts.from === undefined) === (opts.target === undefined)) {
    throw new Error('give exactly one input: --from FILE, --url URL, or `-- command args`');
  }
  if (opts.saveRaw !== undefined && (adapter === TOOLS_LIST_ADAPTER || opts.from !== undefined)) {
    throw new Error('--save-raw applies to a live exec-style sweep only (tools-list servers: use `snapshot`)');
  }

  if (opts.from !== undefined) {
    const text = readInputText(opts.from, '--from');
    if (adapter === TOOLS_LIST_ADAPTER) return parseToolsListFile(text, opts.from, opts.name);
    const records = parseExecRecords(text, basename(opts.from));
    if (records.length === 0) throw new Error(`${opts.from}: no records`);
    const profile = EXEC_PROFILES[adapter]!;
    const meta: Parameters<typeof sweepInputFromExecRecords>[1] = {
      adapter,
      server: { name: opts.name ?? basename(opts.from).replace(/\.[^.]*$/, ''), version: null },
      protocolVersion: null,
      source: { kind: 'file', name: basename(opts.from), format: `${adapter} JSONL` },
    };
    if (profile.infoSchemaMarker !== undefined) meta.marker = profile.infoSchemaMarker;
    return sweepInputFromExecRecords(records, meta);
  }

  const target = opts.target!;
  if (adapter === TOOLS_LIST_ADAPTER) return sweepInputFromServer(target, opts, opts.name);
  const live: Parameters<typeof sweepInputFromExecServer>[1] = { ...opts, profile: EXEC_PROFILES[adapter]! };
  if (opts.name !== undefined) live.nameOverride = opts.name;
  const { input, records } = await sweepInputFromExecServer(target, live);
  if (opts.saveRaw !== undefined) {
    const text = serializeExecRecords(records);
    assertNoSecrets(text, opts.secrets ?? [], 'fetched exec output');
    writeFileSync(opts.saveRaw, text, 'utf8');
  }
  return input;
}

export { POSTHOG_EXEC, EXEC_PROFILES, parseToolNames, type ExecProfile, type ExecRecord } from './exec.js';
export { TOOLS_LIST_ADAPTER, parseToolsListFile, sourceOf } from './tools-list.js';
export type { SourceInfo, SweepInput } from './types.js';
