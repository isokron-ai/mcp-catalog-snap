/**
 * Capture a server's catalog over a live MCP session.
 *
 * Uses the official SDK client. The transport is either a spawned stdio
 * child (`command` + `args`) or a Streamable HTTP endpoint (`url`). Every
 * list call is paginated to exhaustion with `nextCursor`; lists the server
 * does not advertise a capability for are recorded as empty.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

import type { RawCapture } from './snapshot.js';
import { VERSION } from './version.js';

export interface StdioTarget {
  kind: 'stdio';
  command: string;
  args: string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface HttpTarget {
  kind: 'http';
  url: string;
  headers?: Record<string, string>;
}

export type Target = StdioTarget | HttpTarget;

export interface CaptureOptions {
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Where to send the child's stderr (stdio only). Default: inherit. */
  stderr?: 'inherit' | 'ignore' | 'pipe';
}

export function describeTarget(t: Target): string {
  return t.kind === 'stdio' ? [t.command, ...t.args].join(' ') : t.url;
}

function makeTransport(target: Target, opts: CaptureOptions): Transport {
  if (target.kind === 'stdio') {
    // The SDK default is a scrubbed env (HOME/PATH/...). A CI runner needs
    // proxies, tokens and npm config to reach the child, so inherit the full
    // environment like a shell would, then layer the configured overrides.
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
    Object.assign(env, target.env ?? {});
    const params: ConstructorParameters<typeof StdioClientTransport>[0] = {
      command: target.command,
      args: target.args,
      env,
      stderr: opts.stderr ?? 'inherit',
    };
    if (target.cwd) params.cwd = target.cwd;
    return new StdioClientTransport(params);
  }
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new Error(`invalid --url: ${target.url}`);
  }
  const headers = target.headers ?? {};
  return new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : {},
  });
}

/**
 * Wrap a transport so the negotiated protocol version is observable. The
 * SDK client only forwards it to transports that implement
 * `setProtocolVersion` (HTTP does; stdio does not), so we hook that method
 * on whatever transport we were given.
 */
function observeProtocolVersion(transport: Transport): { transport: Transport; get: () => string | null } {
  let seen: string | null = null;
  const orig = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (v: string): void => {
    seen = v;
    orig?.(v);
  };
  return { transport, get: () => seen };
}

async function listAll<T>(
  page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string | undefined }>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (;;) {
    const res = await page(cursor);
    out.push(...res.items);
    if (!res.nextCursor) break;
    if (seenCursors.has(res.nextCursor)) {
      throw new Error(`server returned a repeating pagination cursor: ${res.nextCursor}`);
    }
    seenCursors.add(res.nextCursor);
    cursor = res.nextCursor;
  }
  return out;
}

/** A connected client plus what initialize told us. Close it when done. */
export interface Session {
  client: Client;
  server: RawCapture['server'];
  capabilities: ReturnType<Client['getServerCapabilities']>;
  protocolVersion: () => string | null;
  requestTimeoutMs: number;
  close: () => Promise<void>;
}

/** Connect over an already-constructed transport (tests use InMemoryTransport). */
export async function openSessionOnTransport(rawTransport: Transport, opts: CaptureOptions = {}): Promise<Session> {
  const { transport, get } = observeProtocolVersion(rawTransport);
  const client = new Client({ name: 'mcp-catalog-snap', version: VERSION }, { capabilities: {} });
  const timeout = opts.timeoutMs ?? 30_000;
  const close = async (): Promise<void> => {
    await client.close().catch(() => undefined);
  };
  try {
    await client.connect(transport, { timeout });
    const info = client.getServerVersion();
    if (!info) throw new Error('server did not return serverInfo on initialize');
    const server: RawCapture['server'] = { name: info.name, version: info.version };
    if (typeof info.title === 'string') server.title = info.title;
    return { client, server, capabilities: client.getServerCapabilities(), protocolVersion: get, requestTimeoutMs: timeout, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Connect by spawning / dialing the target. */
export async function openSession(target: Target, opts: CaptureOptions = {}): Promise<Session> {
  return openSessionOnTransport(makeTransport(target, opts), opts);
}

/** List tools/prompts/resource templates over an open session. */
export async function listCatalog(session: Session): Promise<RawCapture> {
  const { client } = session;
  const caps = session.capabilities ?? {};
  const reqOpts = { timeout: session.requestTimeoutMs };
  const tools = caps.tools
    ? await listAll(async (cursor) => {
        const r = await client.listTools(cursor ? { cursor } : {}, reqOpts);
        return { items: r.tools, nextCursor: r.nextCursor };
      })
    : [];
  const prompts = caps.prompts
    ? await listAll(async (cursor) => {
        const r = await client.listPrompts(cursor ? { cursor } : {}, reqOpts);
        return { items: r.prompts, nextCursor: r.nextCursor };
      })
    : [];
  const resourceTemplates = caps.resources
    ? await listAll(async (cursor) => {
        const r = await client.listResourceTemplates(cursor ? { cursor } : {}, reqOpts);
        return { items: r.resourceTemplates, nextCursor: r.nextCursor };
      })
    : [];
  return { server: session.server, protocolVersion: session.protocolVersion(), tools, prompts, resourceTemplates };
}

/** Capture using an already-constructed transport (tests use InMemoryTransport). */
export async function captureFromTransport(rawTransport: Transport, opts: CaptureOptions = {}): Promise<RawCapture> {
  const session = await openSessionOnTransport(rawTransport, opts);
  try {
    return await listCatalog(session);
  } finally {
    await session.close();
  }
}

/** Capture by spawning / dialing the target. */
export async function capture(target: Target, opts: CaptureOptions = {}): Promise<RawCapture> {
  return captureFromTransport(makeTransport(target, opts), opts);
}
