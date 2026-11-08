/**
 * Bounded reads of input files (`--from`, snapshots, config, call results,
 * bearer files). A path can name anything: a device that never ends
 * (`/dev/zero`) used to abort the process with std::bad_alloc. Reads stop
 * past the cap with a clear error. Pipes (process substitution,
 * `/dev/stdin`) keep working; a UTF-8 byte order mark is dropped.
 */

import { closeSync, openSync, readSync } from 'node:fs';

/** Default cap for input files. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

const pause = new Int32Array(new SharedArrayBuffer(4));

/** readSync that waits out EAGAIN (a non-blocking fd 0 with no data yet). */
function readRetrying(fd: number, buf: Buffer): number {
  for (;;) {
    try {
      return readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw err;
      Atomics.wait(pause, 0, 0, 20);
    }
  }
}

export function readInputText(path: string, what: string, maxBytes: number = MAX_INPUT_BYTES): string {
  let fd: number;
  let stdin = false;
  try {
    fd = openSync(path, 'r');
  } catch (err) {
    // `/dev/stdin` that is a socket (spawn with `input`) cannot be opened by path: read fd 0 instead.
    if (path !== '/dev/stdin' || (err as NodeJS.ErrnoException).code !== 'ENXIO') throw err;
    fd = 0;
    stdin = true;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(1 << 20, maxBytes + 1 - total));
      const n = readRetrying(fd, buf);
      if (n === 0) break;
      chunks.push(n === buf.length ? buf : buf.subarray(0, n));
      total += n;
      if (total > maxBytes) throw new Error(`${what} ${path} is larger than ${maxBytes} bytes`);
    }
    const text = Buffer.concat(chunks, total).toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } finally {
    if (!stdin) closeSync(fd);
  }
}
