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
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseToolsListFile } from '../src/adapters/index.js';
import { diffCatalogs, evaluate } from '../src/diff.js';
import { renderDiff, renderSnapshotHeader } from '../src/render.js';
import { mdCode, mdText, renderSweepMarkdown } from '../src/report-md.js';
import { buildSnapshot, normalizeCatalog } from '../src/snapshot.js';
import { oneLine, terminalSafe, visible } from '../src/safe-text.js';
import { runSweep } from '../src/sweep.js';
import { loadTokenizers } from '../src/tokenize.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const HOSTILE = fileURLToPath(new URL('./fixtures/servers/hostile-stdio.mjs', import.meta.url));
const EVIL = 'x\n::warning title=pwned::owned\n```\n\u001b]0;TITLE\u0007\u001b[2J\u202e\u0000\u0085\u2028';
// eslint-disable-next-line no-control-regex -- the point is to find control characters
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069\u061c\u200e\u200f]/;

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

  it('invisible and format characters are covered: soft hyphen, ALM, MVS, ZWSP..RLM, word joiner.., bidi isolates, BOM', () => {
    const codes = [0xad, 0x61c, 0x180e, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x2060, 0x2061, 0x2064, 0x2066, 0x2067, 0x2068, 0x2069, 0x206a, 0x206f, 0xfeff];
    for (const c of codes) {
      const ch = String.fromCharCode(c);
      const hex = c.toString(16).padStart(4, '0');
      expect(visible(`a${ch}b`), hex).toBe(`a\\u${hex}b`);
      expect(mdText(`a${ch}b`), hex).toBe('ab');
      expect(mdCode(`a${ch}b`), hex).toBe('`ab`');
    }
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

describe('output boundary', () => {
  it('terminalSafe() escapes terminal controls and neutralizes workflow-command and fence lines, keeping newlines', () => {
    expect(terminalSafe('a\n  ::error::x\n```js\n~~~\n\u001b[2Jb\u202e\tc')).toBe('a\n  \\::error::x\n\\```js\n\\~~~\n\\u001b[2Jb\\u202e\tc');
    expect(terminalSafe('{\n  "a": "\u2028"\n}')).toBe('{\n  "a": "\\u2028"\n}');
    expect(terminalSafe('ok :: not at start')).toBe('ok :: not at start');
  });
});

describe('runner legacy commands (`##[cmd]` anywhere in a line) and machine/file outputs', () => {
  const RAW_VIEW = new RegExp(`[${String.fromCharCode(0x200b, 0x202e, 0x2028, 0x85, 0x2066)}]`);
  const noLegacy = (text: string): void => {
    expect(text).not.toContain('##[');
    assertTerminalSafe(text);
  };

  it('terminalSafe() breaks every ##[ and a :: after leading invisible characters', () => {
    expect(terminalSafe('a ##[stop-commands]t ##[error]x ###[')).toBe('a #\\u0023[stop-commands]t #\\u0023[error]x ##\\u0023[');
    expect(terminalSafe(`${String.fromCharCode(0x200b)}::error::x`)).toBe(`${String.fromCharCode(0x200b)}\\::error::x`);
    expect(terminalSafe(`${String.fromCharCode(0xa0)}::error::x`)).toBe(`${String.fromCharCode(0xa0)}\\::error::x`);
    expect(JSON.parse(terminalSafe(JSON.stringify({ a: 'n ##[x]' })))).toEqual({ a: 'n ##[x]' });
  });

  it('check, diff, sweep (md and --json), hash and errors never print a raw ##[', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-legacy-'));
    const srv = ['--', process.execPath, HOSTILE];
    const snap = cli(['snapshot', '--name', 'l', ...srv], dir, { MODE: 'legacy' });
    expect(snap.code).toBe(0);
    noLegacy(snap.stdout);
    const check = cli(['check', '--name', 'l', ...srv], dir, { MODE: 'legacy', ADD: '1' });
    expect(check.code).toBe(1);
    noLegacy(check.stdout + check.stderr);
    expect(check.stdout).toContain('added #\\u0023[warning]W');
    const a = join(dir, '.mcp-catalog', 'l.json');
    writeFileSync(join(dir, 'b.json'), cli(['snapshot', '--no-write', ...srv], dir, { MODE: 'legacy', ADD: '1' }).stdout);
    const diff = cli(['diff', a, join(dir, 'b.json')], dir);
    expect(diff.code).toBe(1);
    noLegacy(diff.stdout);
    noLegacy(cli(['diff', '--json', a, join(dir, 'b.json')], dir).stdout);
    noLegacy(cli(['sweep', ...srv], dir, { MODE: 'legacy' }).stdout);
    noLegacy(cli(['sweep', '--json', ...srv], dir, { MODE: 'legacy' }).stdout);
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: ['h ##[stop-commands]x', 'h2'].map((name) => ({ name, command: [process.execPath, HOSTILE], env: { MODE: 'legacy' } })) }));
    noLegacy(cli(['hash'], dir).stdout);
    const err = cli(['sweep', ...srv], dir, { MODE: 'errmsg' });
    expect(err.code).toBe(2);
    noLegacy(err.stderr);
    expect(err.stderr).toContain('#\\u0023[add-mask]DRIFT');
  });

  it('JSON outputs and files carry no raw ZWSP / RLO / U+2028 / NEL, and still parse to the same values', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-legacy-'));
    const srv = ['--', process.execPath, HOSTILE];
    expect(cli(['snapshot', '--name', 'l', ...srv], dir, { MODE: 'legacy' }).code).toBe(0);
    const file = readFileSync(join(dir, '.mcp-catalog', 'l.json'), 'utf8');
    const noWrite = cli(['snapshot', '--no-write', ...srv], dir, { MODE: 'legacy' }).stdout;
    const sweepJson = cli(['sweep', '--json', '--report', 'r.json', ...srv], dir, { MODE: 'legacy' }).stdout;
    const report = readFileSync(join(dir, 'r.json'), 'utf8');
    const checkRep = (cli(['check', '--name', 'l', '--json', '--report', 'c.json', ...srv], dir, { MODE: 'legacy', ADD: '1' }), readFileSync(join(dir, 'c.json'), 'utf8'));
    for (const [what, text] of [['snapshot file', file], ['--no-write', noWrite], ['sweep --json', sweepJson], ['sweep --report', report], ['check --report', checkRep]] as const) {
      expect(text, what).not.toMatch(RAW_VIEW);
    }
    const names = (JSON.parse(file) as { catalog: { tools: { name: string }[] } }).catalog.tools.map((t) => t.name);
    expect(names).toContain(`rlo${String.fromCharCode(0x202e)}evil`);
    expect(names).toContain(`ls${String.fromCharCode(0x2028)}x`);
    expect(sweepJson).toBe(report);
    expect(cli(['check', '--name', 'l', ...srv], dir, { MODE: 'legacy' }).code).toBe(0);
  });
});

describe('CLI end to end (hostile stdio server)', () => {
  it('check: a hostile server name/version cannot inject either (version line, header)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-term-'));
    const srv = ['--', process.execPath, HOSTILE];
    expect(cli(['snapshot', '--name', 'h', ...srv], dir, { MODE: 'names' }).code).toBe(0);
    const r = cli(['check', '--name', 'h', ...srv], dir, { MODE: 'names', ADD: '1', HOSTILE_INFO: '1' });
    expect(r.code).toBe(1);
    assertTerminalSafe(r.stdout);
    assertTerminalSafe(r.stderr);
    expect(r.stdout).toContain('server version: 1 -> 2x\\n::error::PWNED\\u001b[31m```');
    // no-name ad-hoc snapshot and multi-server hash print the server-reported name
    const s = cli(['snapshot', '--no-write', ...srv], dir, { MODE: 'names', HOSTILE_INFO: '1' });
    assertTerminalSafe(s.stdout);
    writeFileSync(
      join(dir, '.mcp-catalog.json'),
      JSON.stringify({ servers: [1, 2].map((i) => ({ name: `s${i}`, command: [process.execPath, HOSTILE], env: { MODE: 'names', HOSTILE_INFO: '1' } })) }),
    );
    const h = cli(['hash'], dir);
    expect(h.code).toBe(0);
    assertTerminalSafe(h.stdout);
    const sw = cli(['sweep', ...srv], dir, { MODE: 'names', HOSTILE_INFO: '1', ADD: '1' });
    expect(sw.code).toBe(0);
    assertTerminalSafe(sw.stdout);
  });

  it('the output boundary covers text no call site escapes (a snapshot file name from a PR checkout)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-term-'));
    const srv = ['--', process.execPath, HOSTILE];
    const s = cli(['snapshot', '--no-write', ...srv], dir, { MODE: 'names' });
    expect(s.code).toBe(0);
    const evilName = join(dir, 'a\n::warning::FROM-FILENAME\u001b[31m.json');
    writeFileSync(evilName, s.stdout);
    const r = cli(['diff', evilName, evilName], dir);
    expect(r.code).toBe(0);
    assertTerminalSafe(r.stdout);
    expect(r.stdout).toContain('\\::warning::FROM-FILENAME\\u001b[31m');
  });

  it('GitHub Action step: job log and step summary stay inert', () => {
    const action = readFileSync(fileURLToPath(new URL('../action.yml', import.meta.url)), 'utf8');
    const step = action.slice(action.indexOf('id: check'));
    const body = step.slice(step.indexOf('run: |') + 'run: |'.length).split('\n');
    const lines: string[] = [];
    for (const l of body.slice(1)) {
      if (l.trim() !== '' && !l.startsWith('        ')) break; // end of the indented `run: |` block
      lines.push(l.slice(8));
    }
    const script = lines.join('\n');
    expect(script).toMatch(/GITHUB_STEP_SUMMARY/);
    const dir = mkdtempSync(join(tmpdir(), 'mcs-action-'));
    const srv = [process.execPath, HOSTILE];
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 'h', command: srv, env: { MODE: 'names' } }] }));
    expect(cli(['snapshot'], dir).code).toBe(0);
    writeFileSync(join(dir, '.mcp-catalog.json'), JSON.stringify({ servers: [{ name: 'h', command: srv, env: { MODE: 'names', ADD: '1', HOSTILE_INFO: '1' } }] }));
    const summary = join(dir, 'summary.md');
    const r = spawnSync('bash', ['-c', script], {
      encoding: 'utf8',
      cwd: dir,
      env: {
        PATH: process.env['PATH'] ?? '',
        HOME: dir,
        GITHUB_ACTION_PATH: fileURLToPath(new URL('..', import.meta.url)),
        GITHUB_OUTPUT: join(dir, 'out.txt'),
        GITHUB_STEP_SUMMARY: summary,
        RUNNER_TEMP: dir,
        INPUT_CONFIG: '.mcp-catalog.json',
        INPUT_IGNORE_DESCRIPTIONS: 'false',
        INPUT_ALLOW_ADDITIONS: 'false',
        INPUT_SERVER: '',
        INPUT_TIMEOUT: '30000',
      },
    });
    expect(r.status).toBe(1);
    const log = `${r.stdout}\n${r.stderr}`;
    expect(log).not.toMatch(CONTROL);
    // the only workflow command in the log is the action's own
    expect(log.split('\n').filter((l) => l.trimStart().startsWith('::'))).toEqual([
      '::error title=MCP catalog drift::tool catalog differs from .mcp-catalog snapshot (prompt-cache prefix changed)',
    ]);
    const md = readFileSync(summary, 'utf8');
    expect(md).not.toMatch(CONTROL);
    // exactly the action's own fence pair
    expect(md.split('\n').filter((l) => /^ {0,3}(```|~~~)/.test(l))).toEqual(['```', '```']);
  });

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
