/**
 * Every exit path of the action's check step leaves a step summary and an
 * `::error` (on failure), and sets the `report` output only when the file
 * exists (dogfood CS-8: a missing `${VAR}` gave exit 2 with neither, and
 * `outputs.report` pointed to a file never written).
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { runActionCheck } from './helpers/action.js';

const KRONICLE = fileURLToPath(new URL('../node_modules/kronicle-lite/dist/cli.js', import.meta.url));

function reportOutput(outputs: string): string | undefined {
  return /^report=(.*)$/m.exec(outputs)?.[1];
}

describe('action.yml check step', () => {
  it('exit 2 (config error): summary with the error, ::error, no report output', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-action-'));
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 'x', url: 'https://h/mcp', headers: { Authorization: 'Bearer ${MCS_MISSING_VAR}' } }] }));
    const r = runActionCheck(dir);
    expect(r.code).toBe(2);
    expect(r.summary).toMatch(/^## MCP catalog check could not run \(exit 2\)/m);
    expect(r.summary).toMatch(/MCS_MISSING_VAR is not set/);
    expect(r.log).toMatch(/^::error title=MCP catalog check failed::/m);
    expect(reportOutput(r.outputs)).toBeUndefined();
    expect(r.outputs).toMatch(/^drift=false$/m);
  });

  it('exit 2 (server failed): same', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-action-'));
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 'x', command: ['/nonexistent/server'] }] }));
    const r = runActionCheck(dir);
    expect(r.code).toBe(2);
    expect(r.summary).toMatch(/could not run \(exit 2\)/);
    expect(r.log).toMatch(/^::error title=MCP catalog check failed::/m);
  });

  it('exit 0: summary, and the report output names a file that exists', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-action-'));
    const data = mkdtempSync(join(tmpdir(), 'mcs-action-data-'));
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 'k', command: [process.execPath, KRONICLE, 'serve', '--data-dir', data] }] }));
    const snap = runActionCheck(dir, {}, {});
    expect(snap.code).toBe(2); // no snapshot yet
    expect(snap.summary).toMatch(/could not run/);
    // capture the baseline, then check
    expect(spawnSync(process.execPath, [fileURLToPath(new URL('../dist/cli.js', import.meta.url)), 'snapshot'], { cwd: dir }).status).toBe(0);
    const r = runActionCheck(dir);
    expect(r.code).toBe(0);
    expect(r.summary).toMatch(/## MCP catalog: no drift/);
    const report = reportOutput(r.outputs);
    expect(report).toBeDefined();
    expect(existsSync(report!)).toBe(true);
  });
});
