/**
 * Capture a server's catalog over a live MCP session.
 *
 * Uses the official SDK client. The transport is either a spawned stdio
 * child (`command` + `args`) or a Streamable HTTP endpoint (`url`). Every
 * list call is paginated to exhaustion with `nextCursor`; lists the server
 * does not advertise a capability for are recorded as empty.
 *
 * The server is untrusted, so capture is bounded: one message may be at
 * most `maxMessageBytes` (stdio line or HTTP response body, default 10 MiB),
 * a list may span at most `MAX_PAGES` pages and `maxListBytes` (default
 * 64 MiB) in total, and every request has a timeout.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createHash } from 'node:crypto';
import { basename } from 'node:path';

import { canonicalJson, sortKeysDeep, type JsonValue } from './canonical.js';
import { childEnv, describeLaunch, type LaunchRecord, type TelemetryOptions } from './launch.js';
import { looksSecret, maskedArgs, safeUrl } from './redact.js';
import { GroupStdioTransport, type GroupStdioParams } from './stdio-transport.js';
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

/** Most pages one list may span. */
export const MAX_PAGES = 1000;
/** Default cap on one server message (stdio line or HTTP response body), in bytes. */
export const MAX_MESSAGE_BYTES = 10 * 1024 * 1024;
/** Default cap on one list's items across all pages (JSON characters). */
export const MAX_LIST_BYTES = 64 * 1024 * 1024;

export interface CaptureOptions {
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
  /** Largest server message accepted, in bytes (default MAX_MESSAGE_BYTES). */
  maxMessageBytes?: number;
  /** Largest list accepted across all its pages (default MAX_LIST_BYTES). */
  maxListBytes?: number;
  /** Deadline for the whole capture, connect to last page, in ms (default: none; every request still has `timeoutMs`). */
  totalTimeoutMs?: number;
  /** Where to send the child's stderr (stdio only). Default: inherit. */
  stderr?: 'inherit' | 'ignore' | 'pipe';
  /** Telemetry-off environment for a launched stdio server (default: TELEMETRY_OFF_ENV). */
  telemetry?: TelemetryOptions;
}

/**
 * The initialize handshake as it happened on the wire: what this client
 * asked for and sent, and the version the server answered with. Servers may
 * list different tools depending on the requested version and the client
 * capabilities, so a snapshot records both.
 */
export interface Handshake {
  /** `protocolVersion` in the client's initialize request. */
  requestedProtocolVersion: string | null;
  /** `protocolVersion` in the server's initialize result (the session's version). */
  negotiatedProtocolVersion: string | null;
  /** `capabilities` in the client's initialize request. */
  clientCapabilities: JsonValue;
  /** `clientInfo` in the client's initialize request. */
  clientInfo: JsonValue;
}

/**
 * A label for messages and reports that carries no credentials. A stdio
 * target is labelled by its command's basename and a short stable hash of
 * its command line (`node#1a2b3c4d`), never by its arguments: argument
 * syntax for credentials is open-ended (`--header "Authorization: …"`,
 * `postgresql://u:pw@h`, `-e TOKEN=…`, `-t …`), so no masking rule can be
 * trusted to catch them all. The hash is taken over the command line with
 * credentials masked (`maskedArgs`), so it is not a guessing oracle for a
 * recognized credential either. Pass `--label` to name an ad-hoc server.
 * An http target shows the URL's origin and path (no query, no
 * user:password@, credential-looking segments masked).
 */
export function describeTarget(t: Target): string {
  if (t.kind === 'http') return safeUrl(t.url);
  const base = basename(t.command);
  const hash = createHash('sha256').update(JSON.stringify([t.command, ...maskedArgs(t.args)])).digest('hex').slice(0, 8);
  return `${base === '' || looksSecret(base) ? 'server' : base}#${hash}`;
}

/**
 * Run `work` under an overall deadline. On expiry `onExpire` runs (it closes
 * the transport, which ends the child process or connection) and the
 * returned promise rejects.
 */
export async function withDeadline<T>(ms: number | undefined, onExpire: () => unknown, work: () => Promise<T>): Promise<T> {
  if (ms === undefined) return work();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      Promise.resolve()
        .then(onExpire)
        .catch(() => undefined);
      reject(new Error(`capture did not finish within ${ms} ms (--timeout-total)`));
    }, ms);
  });
  const run = work();
  run.catch(() => undefined);
  try {
    return await Promise.race([run, expired]);
  } finally {
    clearTimeout(timer);
  }
}

/** A server message over the size cap. */
export class MessageTooLargeError extends Error {
  constructor(readonly limit: number) {
    super(`server message larger than ${limit} bytes (the capture cap); refusing to buffer it`);
  }
}

/**
 * `fetch` whose response bodies are cut at `limit` bytes: a declared
 * Content-Length over it is refused before reading, and a body that grows
 * past it errors and cancels the download.
 */
export function cappedFetch(limit: number, inner: typeof fetch = fetch): typeof fetch {
  return async (input, init) => {
    const res = await inner(input, init);
    const declared = Number(res.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > limit) {
      await res.body?.cancel().catch(() => undefined);
      throw new MessageTooLargeError(limit);
    }
    if (!res.body || [101, 204, 205, 304].includes(res.status)) return res;
    let seen = 0;
    const body = res.body.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, ctl) {
          seen += chunk.byteLength;
          if (seen > limit) ctl.error(new MessageTooLargeError(limit));
          else ctl.enqueue(chunk);
        },
      }),
    );
    return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
  };
}

/** A transport for `target`, and the launch record a snapshot stores for it. */
function makeTransport(target: Target, opts: CaptureOptions): { transport: Transport; launch: LaunchRecord } {
  const maxMessage = opts.maxMessageBytes ?? MAX_MESSAGE_BYTES;
  if (target.kind === 'stdio') {
    // The SDK default is a scrubbed env (HOME/PATH/...). A CI runner needs
    // proxies, tokens and npm config to reach the child, so inherit the full
    // environment like a shell would, set telemetry off, then layer the
    // configured overrides.
    const { env, telemetry } = childEnv(target, opts.telemetry);
    const params: GroupStdioParams = {
      command: target.command,
      args: target.args,
      env,
      stderr: opts.stderr ?? 'inherit',
      maxBufferSize: maxMessage,
    };
    if (target.cwd) params.cwd = target.cwd;
    // Own process group: closing (or a deadline) ends wrappers' grandchildren too, so nothing holds the pipes open.
    return { transport: new GroupStdioTransport(params), launch: describeLaunch(target, telemetry) };
  }
  let url: URL;
  try {
    url = new URL(target.url);
  } catch {
    throw new Error('invalid --url (expected an absolute http(s) URL)');
  }
  if (url.username || url.password) {
    throw new Error('--url must not carry user:password@ (send credentials with --bearer-file, --bearer-env or --header)');
  }
  const headers = target.headers ?? {};
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: Object.keys(headers).length > 0 ? { headers } : {},
    fetch: cappedFetch(maxMessage),
  });
  return { transport, launch: describeLaunch(target) };
}

/**
 * Wrap a transport so the handshake is observable. The negotiated version:
 * the SDK client only forwards it to transports that implement
 * `setProtocolVersion` (HTTP does; stdio does not), so we hook that method
 * on whatever transport we were given. The requested version, capabilities
 * and client info: read from the initialize request as it is sent.
 */
function observeHandshake(transport: Transport): { transport: Transport; get: () => string | null; handshake: () => Handshake } {
  let seen: string | null = null;
  let sent: Record<string, unknown> | null = null;
  const orig = transport.setProtocolVersion?.bind(transport);
  transport.setProtocolVersion = (v: string): void => {
    seen = v;
    orig?.(v);
  };
  const send = transport.send.bind(transport);
  transport.send = (message, options) => {
    const m = message as { method?: unknown; params?: unknown };
    if (sent === null && m.method === 'initialize' && m.params !== null && typeof m.params === 'object') {
      sent = m.params as Record<string, unknown>;
    }
    return send(message, options);
  };
  const handshake = (): Handshake => ({
    requestedProtocolVersion: typeof sent?.['protocolVersion'] === 'string' ? sent['protocolVersion'] : null,
    negotiatedProtocolVersion: seen,
    clientCapabilities: sortKeysDeep(sent?.['capabilities'] ?? {}),
    clientInfo: sortKeysDeep(sent?.['clientInfo'] ?? null),
  });
  return { transport, get: () => seen, handshake };
}

async function listAll<T>(
  what: string,
  maxBytes: number,
  page: (cursor: string | undefined) => Promise<{ items: T[]; nextCursor?: string | undefined }>,
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  let bytes = 0;
  for (let pages = 1; ; pages++) {
    const res = await page(cursor);
    // canonicalJson is iterative: JSON.stringify overflows the stack on a few thousand levels of nesting
    bytes += canonicalJson(res.items).length;
    if (bytes > maxBytes) throw new Error(`${what}: more than ${maxBytes} bytes across pages; refusing to buffer more`);
    out.push(...res.items);
    if (!res.nextCursor) break;
    if (pages >= MAX_PAGES) throw new Error(`${what}: still paginating after ${MAX_PAGES} pages; refusing to follow more`);
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
  /** The initialize handshake as sent and answered. */
  handshake: () => Handshake;
  requestTimeoutMs: number;
  maxListBytes: number;
  close: () => Promise<void>;
  /** The transport error behind a failure, when there is a clearer one (e.g. a message over the size cap). */
  explain: (err: unknown) => unknown;
}

/** Transport errors arrive on `onerror` while the request only sees "Connection closed" or a timeout; keep the telling ones. */
function transportCause(err: unknown): MessageTooLargeError | null {
  if (err instanceof MessageTooLargeError) return err;
  const m = /ReadBuffer exceeded maximum size of (\d+) bytes/.exec(err instanceof Error ? err.message : String(err));
  return m ? new MessageTooLargeError(Number(m[1])) : null;
}

/** Connect over an already-constructed transport (tests use InMemoryTransport). */
export async function openSessionOnTransport(rawTransport: Transport, opts: CaptureOptions = {}): Promise<Session> {
  const { transport, get, handshake } = observeHandshake(rawTransport);
  const client = new Client({ name: 'mcp-catalog-snap', version: VERSION }, { capabilities: {} });
  const timeout = opts.timeoutMs ?? 30_000;
  let cause: MessageTooLargeError | null = null;
  client.onerror = (e) => {
    cause ??= transportCause(e);
  };
  const explain = (err: unknown): unknown => transportCause(err) ?? cause ?? err;
  const close = async (): Promise<void> => {
    await client.close().catch(() => undefined);
  };
  try {
    await client.connect(transport, { timeout });
    const info = client.getServerVersion();
    if (!info) throw new Error('server did not return serverInfo on initialize');
    const server: RawCapture['server'] = { name: info.name, version: info.version };
    if (typeof info.title === 'string') server.title = info.title;
    return {
      client,
      server,
      capabilities: client.getServerCapabilities(),
      protocolVersion: get,
      handshake,
      requestTimeoutMs: timeout,
      maxListBytes: opts.maxListBytes ?? MAX_LIST_BYTES,
      close,
      explain,
    };
  } catch (err) {
    await close();
    throw explain(err);
  }
}

/** Connect by spawning / dialing the target. */
export async function openSession(target: Target, opts: CaptureOptions = {}): Promise<Session> {
  return openSessionOnTransport(makeTransport(target, opts).transport, opts);
}

/** List tools/prompts/resource templates over an open session. */
export async function listCatalog(session: Session): Promise<RawCapture> {
  const { client } = session;
  const caps = session.capabilities ?? {};
  const reqOpts = { timeout: session.requestTimeoutMs };
  const max = session.maxListBytes;
  const tools = caps.tools
    ? await listAll('tools/list', max, async (cursor) => {
        const r = await client.listTools(cursor ? { cursor } : {}, reqOpts);
        return { items: r.tools, nextCursor: r.nextCursor };
      })
    : [];
  const prompts = caps.prompts
    ? await listAll('prompts/list', max, async (cursor) => {
        const r = await client.listPrompts(cursor ? { cursor } : {}, reqOpts);
        return { items: r.prompts, nextCursor: r.nextCursor };
      })
    : [];
  const resourceTemplates = caps.resources
    ? await listAll('resources/templates/list', max, async (cursor) => {
        const r = await client.listResourceTemplates(cursor ? { cursor } : {}, reqOpts);
        return { items: r.resourceTemplates, nextCursor: r.nextCursor };
      })
    : [];
  return { server: session.server, protocolVersion: session.protocolVersion(), handshake: session.handshake(), tools, prompts, resourceTemplates };
}

/** Capture using an already-constructed transport (tests use InMemoryTransport). */
export async function captureFromTransport(rawTransport: Transport, opts: CaptureOptions = {}): Promise<RawCapture> {
  return withDeadline(
    opts.totalTimeoutMs,
    () => rawTransport.close(),
    async () => {
      const session = await openSessionOnTransport(rawTransport, opts);
      try {
        return await listCatalog(session);
      } catch (err) {
        throw session.explain(err);
      } finally {
        await session.close();
      }
    },
  );
}

/** Capture by spawning / dialing the target. The result records how the server was launched (`launch`). */
export async function capture(target: Target, opts: CaptureOptions = {}): Promise<RawCapture> {
  const { transport, launch } = makeTransport(target, opts);
  return { ...(await captureFromTransport(transport, opts)), launch };
}
