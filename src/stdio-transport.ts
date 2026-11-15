/**
 * Stdio transport that owns the server's whole process tree.
 *
 * The SDK's StdioClientTransport signals only the direct child. A server
 * started through a wrapper (`bash -c`, `npx`, `uvx`, `sh -c "x & exec y"`)
 * leaves grandchildren that keep the stdio pipes open, so after a deadline
 * the CLI printed its error but never exited. Here the server is spawned
 * `detached` (its own process group on POSIX) and closing the transport
 * ends the group: stdin is closed, then SIGTERM to the group, then SIGKILL
 * after a grace period, and the pipes are destroyed and the child unref'd so
 * this process can exit even if something survives (the server's stderr is
 * forwarded through a pipe for the same reason, not inherited). The same group kill
 * runs if this process exits or is interrupted with a server still running.
 * On Windows the tree is ended with `taskkill /T /F`.
 *
 * The child's stderr is always read through a pipe: forwarded to this
 * process's stderr for 'inherit', drained otherwise, and its last lines are
 * kept (`exitInfo`). A server that refuses its flags or configuration
 * usually says why on stderr and exits; the SDK only reports "Connection
 * closed", so the capture error quotes the server's own last lines.
 */

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

export interface GroupStdioParams {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  stderr: 'inherit' | 'ignore' | 'pipe';
  maxBufferSize: number;
  /** Wait after closing stdin and again after SIGTERM before escalating (default 2000 ms each). */
  graceMs?: number;
}

const live = new Set<ChildProcess>();
let hooked = false;

/** Kill a server's process tree. Synchronous so it also works from an 'exit' handler. */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, signal); // the group: wrapper, server and anything they started
  } catch {
    try {
      child.kill(signal);
    } catch {
      // already gone
    }
  }
}

function hookExit(): void {
  if (hooked) return;
  hooked = true;
  process.on('exit', () => {
    for (const c of live) killTree(c, 'SIGKILL');
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.once(sig, () => {
      for (const c of live) killTree(c, 'SIGKILL');
      process.exit(128 + ({ SIGHUP: 1, SIGINT: 2, SIGTERM: 15 } as const)[sig]);
    });
  }
}

/** Lines of the child's stderr kept for error messages (the last ones), and their caps. */
const STDERR_TAIL_LINES = 8;
const STDERR_LINE_CHARS = 400;

export interface ExitInfo {
  code: number | null;
  signal: string | null;
  /** The last lines the server wrote to stderr (trimmed, at most 8). */
  stderrTail: string[];
}

export class GroupStdioTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;

  private child: ChildProcess | undefined;
  private readonly buffer: ReadBuffer;
  private closing: Promise<void> | undefined;
  private tail: string[] = [];
  private partial = '';
  private exit: { code: number | null; signal: string | null } | null = null;
  private stopping = false;

  /** How the server ended, when it ended on its own (not by close()), with its last stderr lines; null while it runs. */
  exitInfo(): ExitInfo | null {
    if (!this.exit || this.stopping) return null;
    const tail = [...this.tail, ...(this.partial.trim() ? [this.partial.trim().slice(0, STDERR_LINE_CHARS)] : [])].slice(-STDERR_TAIL_LINES);
    return { code: this.exit.code, signal: this.exit.signal, stderrTail: tail };
  }

  private keepStderr(chunk: Buffer): void {
    const lines = (this.partial + chunk.toString('utf8')).split(/\r?\n/);
    this.partial = (lines.pop() ?? '').slice(-STDERR_LINE_CHARS * 4);
    for (const l of lines) if (l.trim()) this.tail.push(l.trim().slice(0, STDERR_LINE_CHARS));
    if (this.tail.length > STDERR_TAIL_LINES) this.tail.splice(0, this.tail.length - STDERR_TAIL_LINES);
  }

  constructor(private readonly params: GroupStdioParams) {
    this.buffer = new ReadBuffer({ maxBufferSize: params.maxBufferSize });
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  start(): Promise<void> {
    if (this.child) throw new Error('GroupStdioTransport already started');
    hookExit();
    return new Promise((resolve, reject) => {
      const child = spawn(this.params.command, this.params.args, {
        env: this.params.env,
        cwd: this.params.cwd,
        // stderr is always a pipe we own: forwarded for 'inherit' (an inherited fd would let a survivor hold this
        // process's stderr open), drained otherwise, and its last lines kept for the error a failed capture reports
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        shell: false,
        windowsHide: true,
      });
      this.child = child;
      live.add(child);
      child.on('error', (err) => {
        live.delete(child);
        reject(err);
        this.onerror?.(err);
      });
      child.on('spawn', () => resolve());
      child.on('exit', (code, signal) => {
        this.exit = { code, signal };
      });
      child.on('close', () => {
        live.delete(child);
        if (this.child === child) this.child = undefined;
        this.onclose?.();
      });
      child.stderr?.on('data', (chunk: Buffer) => {
        this.keepStderr(chunk);
        if (this.params.stderr === 'inherit') process.stderr.write(chunk);
      });
      child.stdin?.on('error', (err) => this.onerror?.(err));
      child.stdout?.on('error', (err) => this.onerror?.(err));
      child.stdout?.on('data', (chunk: Buffer) => {
        try {
          this.buffer.append(chunk);
        } catch (err) {
          this.onerror?.(err as Error);
          void this.close();
          return;
        }
        for (;;) {
          let msg: JSONRPCMessage | null;
          try {
            msg = this.buffer.readMessage();
          } catch (err) {
            this.onerror?.(err as Error);
            continue;
          }
          if (msg === null) break;
          this.onmessage?.(msg);
        }
      });
    });
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      const stdin = this.child?.stdin;
      if (!stdin || stdin.destroyed) {
        reject(new Error('Not connected'));
        return;
      }
      if (stdin.write(serializeMessage(message))) resolve();
      else stdin.once('drain', resolve);
    });
  }

  close(): Promise<void> {
    this.closing ??= this.shutdown();
    return this.closing;
  }

  private async shutdown(): Promise<void> {
    const child = this.child;
    if (!child) return;
    // an exit from here on is ours (stdin closed, then signals), not the server giving up
    if (!this.exit) this.stopping = true;
    const grace = this.params.graceMs ?? 2000;
    const exited = new Promise<void>((r) => {
      if (child.exitCode !== null || child.signalCode !== null) r();
      else child.once('exit', () => r());
    });
    // Timers stay ref'd: an unref'd timer as the only pending work would let Node exit mid-shutdown (silently, code 0).
    const sleep = (ms: number): { done: Promise<void>; cancel: () => void } => {
      let t: ReturnType<typeof setTimeout> | undefined;
      return { done: new Promise<void>((r) => (t = setTimeout(r, ms))), cancel: () => clearTimeout(t) };
    };
    const wait = async (ms: number): Promise<void> => {
      const s = sleep(ms);
      await Promise.race([exited, s.done]);
      s.cancel();
    };
    try {
      child.stdin?.end();
    } catch {
      // ignore
    }
    await wait(grace);
    // Even when the direct child exited, its group may hold background processes: end them too.
    const childGone = child.exitCode !== null || child.signalCode !== null;
    killTree(child, 'SIGTERM');
    if (childGone) await sleep(Math.min(grace, 200)).done;
    else await wait(grace);
    killTree(child, 'SIGKILL');
    live.delete(child);
    for (const s of [child.stdin, child.stdout, child.stderr]) s?.destroy();
    child.unref();
    this.buffer.clear();
    if (this.child === child) {
      this.child = undefined;
      this.onclose?.();
    }
  }
}
