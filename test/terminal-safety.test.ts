/**
 * Untrusted server text reaching a terminal or CI log (v0.2 stress round).
 *
 * Before the fix, `check` printed tool names and property paths raw, so a
 * name with a newline injected GitHub Actions workflow commands
 * (`::warning::`, `::add-mask::`) into the job log and could close the
 * step-summary code fence; ESC/BEL/NUL from names reached stdout through
 * markdown code spans; server error messages went to stderr raw and
 * unbounded (300 KB, escapes, newlines).
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseToolsListFile } from '../src/adapters/index.js';
import { diffCatalogs, evaluate } from '../src/diff.js';
import { renderDiff, renderSnapshotHeader } from '../src/render.js';
import { mdCode, mdText, renderSweepMarkdown } from '../src/report-md.js';
import { buildSnapshot, normalizeCatalog } from '../src/snapshot.js';
import { oneLine, visible } from '../src/safe-text.js';
import { runSweep } from '../src/sweep.js';
import { loadTokenizers } from '../src/tokenize.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const HOSTILE = fileURLToPath(new URL('./fixtures/servers/hostile-stdio.mjs', import.meta.url));
const EVIL = 'x\n::warning title=pwned::owned\n```\n\u001b]0;TITLE\u0007\u001b[2J\u202e\u0000\u0085\u2028';
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

/** No control characters, and no line a CI runner would read as a workflow command (it trims leading space). */
function assertTerminalSafe(text: string): void {
  expect(text).not.toMatch(CONTROL);
  for (const line of text.split('\n')) expect(line.trimStart().startsWith('::')).toBe(false);
  for (const line of text.split('\n')) expect(line.startsWith('```')).toBe(false);
}

function cli(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', HOME: cwd, ...env } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('safe-text helpers', () => {
  it('visible() escapes control, C1, line-separator and bidi characters and keeps the rest', () => {
    expect(visible('a\nb\t\u001b[2J\u0000\u0085\u2028\u202eé😀')).toBe('a\\nb\\t\\u001b[2J\\u0000\\u0085\\u2028\\u202eé😀');
    expect(visible('plain text')).toBe('plain text');
  });

  it('oneLine() joins lines, escapes the rest and caps the length', () => {
    const s = oneLine(`[\n  {\n    "a": 1\n  }\n]\u001b ${'z'.repeat(5000)}`, 100);
    expect(s.startsWith('[ { "a": 1 } ]\\u001b z')).toBe(true);
    expect(s.length).toBeLessThanOrEqual(100);
    expect(s.endsWith('…')).toBe(true);
  });

  it('markdown code spans and text drop control and bidi characters', () => {
    expect(mdCode(EVIL)).not.toMatch(CONTROL);
    expect(mdText(EVIL, 500)).not.toMatch(CONTROL);
  });
});

describe('check output (renderDiff)', () => {
  it('shows a hostile added tool and property path on one visible line', () => {
    const before = normalizeCatalog({ tools: [{ name: 'ok', inputSchema: { type: 'object', properties: { [EVIL]: { type: 'string' } } } }], prompts: [], resourceTemplates: [] });
    const after = normalizeCatalog({
      tools: [
        { name: 'ok', inputSchema: { type: 'object', properties: { [EVIL]: { type: 'number' } } } },
        { name: EVIL, inputSchema: { type: 'object' } },
      ],
      prompts: [],
      resourceTemplates: [],
    });
    const diff = diffCatalogs(before, after);
    const out = renderDiff(diff, evaluate(diff, {}));
    assertTerminalSafe(out);
    expect(out).toContain('+ x\\n::warning title=pwned::owned\\n```\\n\\u001b]0;TITLE');
    expect(out).toContain('/inputSchema/properties/x\\n::warning');
  });

  it('snapshot header shows a hostile server name and version escaped', () => {
    const snap = buildSnapshot({ server: { name: EVIL, version: EVIL }, protocolVersion: EVIL, tools: [], prompts: [], resourceTemplates: [] }, { capturedAt: 't' });
    assertTerminalSafe(renderSnapshotHeader(snap));
  });
});

describe('sweep markdown', () => {
  it('carries no control characters from tool names, paths or the server name', async () => {
    const toks = await loadTokenizers(['cl100k']);
    const input = parseToolsListFile(
      JSON.stringify({ serverInfo: { name: EVIL, version: EVIL }, tools: [{ name: EVIL, inputSchema: { type: 'object', properties: { [EVIL]: { type: 'unknown' } } } }] }),
      'e.json',
    );
    const md = renderSweepMarkdown(runSweep(input, { tokenizers: toks }));
    expect(md).not.toMatch(CONTROL);
    for (const line of md.split('\n')) expect(line.trimStart().startsWith('::')).toBe(false);
  });
});

describe('CLI end to end (hostile stdio server)', () => {
  it('check: a hostile added tool cannot inject workflow commands or escapes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-term-'));
    const srv = ['--', process.execPath, HOSTILE];
    expect(cli(['snapshot', '--name', 'h', ...srv], dir, { MODE: 'names' }).code).toBe(0);
    const r = cli(['check', '--name', 'h', ...srv], dir, { MODE: 'names', ADD: '1' });
    expect(r.code).toBe(1);
    assertTerminalSafe(r.stdout);
    assertTerminalSafe(r.stderr);
    expect(r.stdout).toContain('tool added: x\\n::warning');
  });

  it('server error messages are one bounded, escaped line (sweep, snapshot, check, hash)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-term-'));
    const srv = ['--', process.execPath, HOSTILE];
    for (const cmd of [['sweep'], ['snapshot', '--name', 'e'], ['hash']]) {
      const r = cli([...cmd, ...srv], dir, { MODE: 'errmsg' });
      expect(r.code).toBe(2);
      assertTerminalSafe(r.stderr);
      expect(r.stderr.trimEnd().split('\n')).toHaveLength(1);
      expect(r.stderr.length).toBeLessThan(2_100);
      expect(r.stderr).toMatch(/^error: .*boom ::warning::owned \\u001b\]0;TITLE/);
    }
  });
});
