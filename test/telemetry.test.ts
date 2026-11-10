/**
 * K-G6: a server catalog-snap launches gets common telemetry-off variables,
 * the caller can add more or turn the defaults off, and the snapshot records
 * what the child actually received. The fake server reports the variables
 * it sees in a tool description, so these tests observe the child's real
 * environment.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { capture, type StdioTarget } from '../src/capture.js';
import { mergeTelemetry } from '../src/commands.js';
import { parseConfig } from '../src/config.js';
import { TELEMETRY_OFF_ENV, childEnv, describeLaunch, telemetryEnv, type TelemetryOptions } from '../src/launch.js';
import { buildSnapshot, parseSnapshot } from '../src/snapshot.js';

const FLAGS = fileURLToPath(new URL('./fixtures/servers/flags-stdio.mjs', import.meta.url));
const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const SHOW = 'DO_NOT_TRACK,OTEL_SDK_DISABLED,FOO_TELEMETRY,PATH_SEEN';

function target(env: Record<string, string> = {}): StdioTarget {
  return { kind: 'stdio', command: process.execPath, args: [FLAGS], env: { SHOW_ENV: SHOW, ...env } };
}

/** The variables the child saw, from its "env" tool. */
async function childSaw(t: StdioTarget, telemetry?: TelemetryOptions) {
  const raw = await capture(t, telemetry ? { stderr: 'ignore', telemetry } : { stderr: 'ignore' });
  const tool = (raw.tools as { name: string; description?: string }[]).find((x) => x.name === 'env')!;
  return { seen: JSON.parse(tool.description!) as Record<string, string | null>, snap: buildSnapshot(raw) };
}

describe('telemetry-off environment', () => {
  const saved = process.env['DO_NOT_TRACK'];
  afterEach(() => {
    if (saved === undefined) delete process.env['DO_NOT_TRACK'];
    else process.env['DO_NOT_TRACK'] = saved;
  });

  it('sets the defaults for a launched server and records them', async () => {
    const { seen, snap } = await childSaw(target());
    expect(seen['DO_NOT_TRACK']).toBe('1');
    expect(seen['OTEL_SDK_DISABLED']).toBe('true');
    expect(snap.launch).toMatchObject({ transport: 'stdio', telemetryEnv: { ...TELEMETRY_OFF_ENV } });
  });

  it('overrides an inherited value (DO_NOT_TRACK=0 in the parent environment)', async () => {
    process.env['DO_NOT_TRACK'] = '0';
    const { seen, snap } = await childSaw(target());
    expect(seen['DO_NOT_TRACK']).toBe('1');
    expect(snap.launch?.transport === 'stdio' && snap.launch.telemetryEnv['DO_NOT_TRACK']).toBe('1');
  });

  it("lets the server's own env win, and records the value the child got", async () => {
    const { seen, snap } = await childSaw(target({ DO_NOT_TRACK: '0' }));
    expect(seen['DO_NOT_TRACK']).toBe('0');
    expect(snap.launch?.transport === 'stdio' && snap.launch.telemetryEnv['DO_NOT_TRACK']).toBe('0');
  });

  it('adds caller variables and can drop the defaults', async () => {
    delete process.env['DO_NOT_TRACK'];
    const added = await childSaw(target(), { extra: { FOO_TELEMETRY: 'off' } });
    expect(added.seen['FOO_TELEMETRY']).toBe('off');
    expect(added.seen['DO_NOT_TRACK']).toBe('1');
    expect(added.snap.launch?.transport === 'stdio' && added.snap.launch.telemetryEnv).toEqual({ ...TELEMETRY_OFF_ENV, FOO_TELEMETRY: 'off' });

    const off = await childSaw(target(), { defaults: false });
    expect(off.seen['DO_NOT_TRACK']).toBeNull();
    expect(off.snap.launch?.transport === 'stdio' && off.snap.launch.telemetryEnv).toEqual({});
  });

  it('layers inherited < telemetry < target env (unit)', () => {
    const { env, telemetry } = childEnv({ env: { NEXT_TELEMETRY_DISABLED: '0' } }, { extra: { X_TEL: 'no' } }, { DO_NOT_TRACK: '0', HOME: '/h' });
    expect(env['HOME']).toBe('/h');
    expect(env['DO_NOT_TRACK']).toBe('1');
    expect(env['NEXT_TELEMETRY_DISABLED']).toBe('0');
    expect(telemetry).toEqual({ ...TELEMETRY_OFF_ENV, NEXT_TELEMETRY_DISABLED: '0', X_TEL: 'no' });
    expect(Object.keys(telemetry)).toEqual(Object.keys(telemetry).sort());
    expect(telemetryEnv({ defaults: false })).toEqual({});
  });

  it('an http target records no telemetry variables (nothing is launched)', () => {
    expect(describeLaunch({ kind: 'http', url: 'https://h/mcp' })).toEqual({ transport: 'http', url: 'https://h/mcp', headers: [] });
  });

  it('config telemetryEnv / telemetryDefaults parse, and the command line merges on top', () => {
    const cfg = parseConfig(JSON.stringify({ telemetryEnv: { A_TEL: '${V}' }, telemetryDefaults: false, servers: [] }), '/x/c.json', { V: 'off' });
    expect(cfg.telemetry).toEqual({ defaults: false, extra: { A_TEL: 'off' } });
    expect(parseConfig('{"servers":[]}', '/x/c.json').telemetry).toEqual({});
    expect(() => parseConfig('{"telemetryDefaults":"no","servers":[]}', '/x/c.json')).toThrow(/telemetryDefaults must be true or false/);
    expect(() => parseConfig('{"telemetryEnv":[],"servers":[]}', '/x/c.json')).toThrow(/telemetryEnv must be an object/);
    expect(mergeTelemetry({ extra: { A: '1', B: '1' } }, { extra: { B: '2' } })).toEqual({ extra: { A: '1', B: '2' } });
    expect(mergeTelemetry({}, { defaults: false })).toEqual({ defaults: false, extra: {} });
    expect(mergeTelemetry({ defaults: false }, {})).toEqual({ defaults: false, extra: {} });
  });

  it('CLI: --telemetry-env adds (repeatable), --no-telemetry-defaults drops the built-ins', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-tele-cli-'));
    const base = [CLI, 'snapshot', '--quiet', '--dir', dir, '--env', `SHOW_ENV=${SHOW}`];
    const run = (extra: string[]) => {
      const r = spawnSync(process.execPath, [...base, ...extra, '--', process.execPath, FLAGS], { encoding: 'utf8', cwd: dir, timeout: 30_000, env: { ...process.env, DO_NOT_TRACK: '' } });
      expect(r.status, r.stderr).toBe(0);
      const snap = parseSnapshot(readFileSync(join(dir, 'flags-server.json'), 'utf8'), 'f');
      const seen = JSON.parse(snap.catalog.tools.find((t) => t.name === 'env')!.description!) as Record<string, string | null>;
      return { seen, tele: snap.launch?.transport === 'stdio' ? snap.launch.telemetryEnv : null };
    };
    const a = run(['--telemetry-env', 'FOO_TELEMETRY=off', '--telemetry-env', 'PATH_SEEN=x']);
    expect(a.seen).toMatchObject({ DO_NOT_TRACK: '1', FOO_TELEMETRY: 'off', PATH_SEEN: 'x' });
    expect(a.tele).toMatchObject({ DO_NOT_TRACK: '1', FOO_TELEMETRY: 'off' });
    const b = run(['--no-telemetry-defaults']);
    expect(b.seen['DO_NOT_TRACK']).toBe('');
    expect(b.tele).toEqual({});
    const bad = spawnSync(process.execPath, [CLI, 'snapshot', '--telemetry-env', 'NOEQUALS', '--', process.execPath, FLAGS], { encoding: 'utf8', timeout: 30_000 });
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('--telemetry-env expects "KEY=value"');
  });

  it('config: telemetryEnv reaches a configured server', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-tele-cfg-'));
    writeFileSync(
      join(dir, '.mcp-catalog.json'),
      JSON.stringify({ telemetryEnv: { FOO_TELEMETRY: 'cfg' }, servers: [{ name: 'f', command: [process.execPath, FLAGS], env: { SHOW_ENV: SHOW } }] }),
    );
    const r = spawnSync(process.execPath, [CLI, 'snapshot', '--quiet'], { encoding: 'utf8', cwd: dir, timeout: 30_000 });
    expect(r.status, r.stderr).toBe(0);
    const snap = parseSnapshot(readFileSync(join(dir, '.mcp-catalog', 'f.json'), 'utf8'), 'f');
    expect(JSON.parse(snap.catalog.tools.find((t) => t.name === 'env')!.description!)).toMatchObject({ FOO_TELEMETRY: 'cfg', DO_NOT_TRACK: '1' });
    expect(snap.launch).toMatchObject({ telemetryEnv: { FOO_TELEMETRY: 'cfg', DO_NOT_TRACK: '1' } });
  });
});
