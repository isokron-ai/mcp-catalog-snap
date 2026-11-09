/**
 * Bounded reads of input files (`--from`, snapshots, config, call results,
 * bearer files). A path can name anything: a device that never ends
 * (`/dev/zero`) used to abort the process with std::bad_alloc. Reads stop
 * past the cap with a clear error. Pipes (process substitution,
 * `/dev/stdin`) keep working; a FIFO is opened without blocking and gets
 * FIFO_WRITER_GRACE_MS for a writer instead of hanging, and any non-regular
 * input must finish within NONREGULAR_READ_DEADLINE_MS (a trickling writer
 * cannot hold the CLI); a UTF-8 byte order mark is dropped.
 */

import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';

/** How long a FIFO opened before its writer waits for one. */
export const FIFO_WRITER_GRACE_MS = 5_000;

/** Default cap for input files. */
export const MAX_INPUT_BYTES = 64 * 1024 * 1024;

const pause = new Int32Array(new SharedArrayBuffer(4));

/** Thrown when a pipe or FIFO does not deliver its whole input before the deadline. */
class InputDeadline extends Error {}

/** readSync that waits out EAGAIN (a non-blocking fd with no data yet), up to `deadline` (epoch ms). */
function readRetrying(fd: number, buf: Buffer, deadline: number): number {
  for (;;) {
    try {
      return readSync(fd, buf, 0, buf.length, null);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EAGAIN') throw err;
      if (Date.now() > deadline) throw new InputDeadline();
      Atomics.wait(pause, 0, 0, 20);
    }
  }
}

/** A pipe or FIFO must deliver its whole input within this long (a trickling writer would otherwise hold the CLI forever). */
export const NONREGULAR_READ_DEADLINE_MS = 30_000;

export function readInputText(path: string, what: string, maxBytes: number = MAX_INPUT_BYTES, opts: { deadlineMs?: number } = {}): string {
  let fd: number;
  let stdin = false;
  try {
    // O_NONBLOCK: opening a FIFO that has no writer must not block (it reads as empty instead); reads wait out EAGAIN.
    fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (err) {
    // `/dev/stdin` that is a socket (spawn with `input`) cannot be opened by path: read fd 0 instead.
    if (path !== '/dev/stdin' || (err as NodeJS.ErrnoException).code !== 'ENXIO') throw err;
    fd = 0;
    stdin = true;
  }
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const st = fstatSync(fd);
    const fifo = !stdin && st.isFIFO();
    const waitUntil = Date.now() + FIFO_WRITER_GRACE_MS;
    const limitMs = opts.deadlineMs ?? NONREGULAR_READ_DEADLINE_MS;
    const deadline = st.isFile() ? Infinity : Date.now() + limitMs;
    for (;;) {
      const buf = Buffer.allocUnsafe(Math.min(1 << 20, maxBytes + 1 - total));
      let n: number;
      try {
        n = readRetrying(fd, buf, deadline);
      } catch (err) {
        if (err instanceof InputDeadline) throw new Error(`${what} ${path} did not deliver its input within ${limitMs / 1000} s (pipes and FIFOs must finish in time)`);
        throw err;
      }
      if (Date.now() > deadline) throw new Error(`${what} ${path} did not deliver its input within ${limitMs / 1000} s (pipes and FIFOs must finish in time)`);
      if (n === 0) {
        // A non-blocking FIFO reads as EOF until a writer opens it: give one a moment to arrive.
        if (fifo && total === 0 && Date.now() < waitUntil) {
          Atomics.wait(pause, 0, 0, 50);
          continue;
        }
        break;
      }
      chunks.push(n === buf.length ? buf : buf.subarray(0, n));
      total += n;
      if (total > maxBytes) throw new Error(`${what} ${path} is larger than ${maxBytes} bytes`);
    }
    if (total === 0 && fifo) throw new Error(`${what} ${path} is a FIFO with nothing to read (no writer within ${FIFO_WRITER_GRACE_MS / 1000} s)`);
    const text = Buffer.concat(chunks, total).toString('utf8');
    return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  } finally {
    if (!stdin) closeSync(fd);
  }
}
