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

  it('server stderr cannot run workflow commands or close the summary code block', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-action-'));
    // a server that writes workflow commands, a legacy ##[ command and a 4-backtick fence to stderr, without a final newline, then dies
    const hostile = [
      '::error title=pwned::injected from server stderr',
      '::add-mask::x',
      'text ##[warning]legacy command',
      '````',
      '## heading after a fence',
      '```',
      'last line without newline',
    ].join('\n');
    writeFileSync(join(dir, 'srv.cjs'), `process.stderr.write(${JSON.stringify(hostile)}); process.exit(1);`);
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 'x', command: [process.execPath, join(dir, 'srv.cjs')] }] }));
    const r = runActionCheck(dir);
    expect(r.code).toBe(2);

    // log: the server text sits between ::stop-commands::<token> and ::<token>::, each on a line of its own, before the action's ::error
    const lines = r.stdout.split('\n');
    const stop = lines.findIndex((l) => /^::stop-commands::[0-9a-f]{32}$/.test(l));
    expect(stop).toBeGreaterThanOrEqual(0);
    const token = lines[stop]!.slice('::stop-commands::'.length);
    const resume = lines.indexOf(`::${token}::`);
    const injected = lines.indexOf('::error title=pwned::injected from server stderr');
    const legacy = lines.findIndex((l) => l.includes('##[warning]'));
    const own = lines.findIndex((l) => l.startsWith('::error title=MCP catalog check failed::'));
    expect(injected).toBeGreaterThan(stop);
    expect(legacy).toBeGreaterThan(stop);
    expect(lines.indexOf('last line without newline')).toBeLessThan(resume);
    expect(resume).toBeGreaterThan(injected);
    expect(own).toBeGreaterThan(resume);
    expect(hostile).not.toContain(token);

    // summary: the fence is longer than the longest backtick run in the server text, and closes after all of it
    const sl = r.summary.split('\n');
    const open = sl.findIndex((l) => /^`{3,}$/.test(l));
    const fence = sl[open]!;
    expect(fence.length).toBeGreaterThan(4);
    const close = sl.indexOf(fence, open + 1);
    expect(close).toBeGreaterThan(sl.indexOf('last line without newline'));
    for (const l of sl.slice(open + 1, close)) expect(l).not.toBe(fence);
    expect(sl.slice(open + 1, close).join('\n')).toContain('## heading after a fence');
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
