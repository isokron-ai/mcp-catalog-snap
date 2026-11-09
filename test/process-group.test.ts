/**
 * The deadline and every close end the server's whole process tree (#9
 * review). Before: SIGTERM went to the direct child only, so a wrapper's
 * grandchild (`bash -c "server; true"`, `sh -c "sleep & exec server"`, npx,
 * uvx) kept the pipes open and the CLI printed its error but never exited.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { budget } from './helpers/time.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const STUBBORN = fileURLToPath(new URL('./fixtures/servers/stubborn.mjs', import.meta.url));
const KRONICLE = fileURLToPath(new URL('../node_modules/kronicle-lite/dist/cli.js', import.meta.url));

const alive = (pattern: string): boolean => spawnSync('pgrep', ['-f', pattern]).status === 0;
const marker = (): string => `mcs-marker-${process.pid}-${Math.random().toString(36).slice(2)}`;

function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    timeout: budget(15_000),
    cwd: mkdtempSync(join(tmpdir(), 'mcs-pg-')),
    env: { PATH: process.env['PATH'] ?? '', ...env },
  });
  return { code: r.status, stderr: r.stderr, stdout: r.stdout, ms: Date.now() - t0, timedOut: r.error !== undefined };
}

describe.skipIf(process.platform === 'win32')('process group', () => {
  it('a SIGTERM-ignoring server behind `bash -c "…; true"`: the CLI exits and the server is gone', () => {
    const m = marker();
    const r = cli(['hash', '--timeout-total', '2000', '--', 'bash', '-c', `"${process.execPath}" "${STUBBORN}" ${m}; true`]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/did not finish within 2000 ms/);
    expect(r.ms).toBeLessThan(budget(12_000));
    expect(alive(m)).toBe(false);
  });

  it('a backgrounded grandchild (`sh -c "sleep & exec server"`) is ended with the server', () => {
    const secs = `${4000 + Math.floor(Math.random() * 999)}.25`;
    const r = cli(['hash', '--timeout-total', '2000', '--', 'sh', '-c', `sleep ${secs} & exec "${process.execPath}" "${STUBBORN}" x`]);
    expect(r.timedOut).toBe(false);
    expect(r.code).toBe(2);
    expect(r.ms).toBeLessThan(budget(12_000));
    expect(alive(`sleep ${secs}`)).toBe(false);
  });

  it('a process that left the group (setsid) and holds the pipes cannot keep the CLI alive', () => {
    const secs = `${6000 + Math.floor(Math.random() * 999)}.25`;
    try {
      const r = cli(['hash', '--timeout-total', '2000', '--', 'sh', '-c', `setsid sleep ${secs} & exec "${process.execPath}" "${STUBBORN}" x`]);
      expect(r.timedOut).toBe(false);
      expect(r.code).toBe(2);
      expect(r.ms).toBeLessThan(budget(12_000));
    } finally {
      spawnSync('pkill', ['-f', `sleep ${secs}`]);
    }
  });

  it('after a successful capture the server group is ended too', () => {
    const secs = `${5000 + Math.floor(Math.random() * 999)}.25`;
    const data = mkdtempSync(join(tmpdir(), 'mcs-pg-data-'));
    const r = cli(['hash', '--', 'sh', '-c', `sleep ${secs} & exec "${process.execPath}" "${KRONICLE}" serve --data-dir "${data}"`]);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
    expect(r.ms).toBeLessThan(budget(12_000));
    expect(alive(`sleep ${secs}`)).toBe(false);
  });
});
