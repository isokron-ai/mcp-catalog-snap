/**
 * CLI input strictness (v0.2 stress round). Before the fix:
 *   - unknown options were ignored, so `sweep --max-tool-token 4000` (typo)
 *     ran with no budget and exited 0 in CI; a repeated option silently
 *     took the last value; `--json=yes` silently meant false;
 *   - numeric options took `''` as 0, `0x10` as 16 and unsafe integers;
 *   - input files were read whole and unbounded: `--from /dev/zero` and
 *     `hash /dev/zero` aborted with std::bad_alloc (exit 134);
 *   - a UTF-8 BOM (Windows editors) made a valid file "not valid JSON".
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseArgs } from '../src/args.js';
import { validateFlags } from '../src/cli-flags.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const FIX = fileURLToPath(new URL('./fixtures/sweep/tools-list.json', import.meta.url));
const HOSTILE = fileURLToPath(new URL('./fixtures/servers/hostile-stdio.mjs', import.meta.url));

function cli(args: string[], input?: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-strict-'));
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd: dir, timeout: 60_000, input, env: { PATH: process.env['PATH'] ?? '', HOME: dir } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr, dir };
}

describe('options', () => {
  it('an unknown option is an error that names the closest known one', () => {
    const r = cli(['sweep', '--from', FIX, '--max-tool-token', '10']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/unknown option --max-tool-token for sweep \(did you mean --max-tool-tokens\?\)/);
    expect(cli(['sweep', '--from', FIX, '--config', 'x.json']).stderr).toMatch(/unknown option --config for sweep/);
    expect(cli(['diff', 'a', 'b', '--ignore-description']).stderr).toMatch(/unknown option --ignore-description for diff \(did you mean --ignore-descriptions\?\)/);
  });

  it('a repeated single-value option is an error', () => {
    const r = cli(['sweep', '--from', FIX, '--max-tool-tokens', '10', '--max-tool-tokens', '100000']);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/--max-tool-tokens given more than once/);
  });

  it('boolean options take only true/false/1/0 after =', () => {
    expect(cli(['sweep', '--from', FIX, '--json=yes']).stderr).toMatch(/--json expects true or false/);
    expect(cli(['sweep', '--from', FIX, '--json=false']).code).toBe(0);
    expect(JSON.parse(cli(['sweep', '--from', FIX, '--json=1']).stdout).format).toBe('mcp-catalog-snap/sweep/1');
  });

  it('numbers are plain decimal safe integers', () => {
    for (const bad of ['', ' ', '0x10', '1e3', '1.5', '-1', '+5', '99999999999999999999']) {
      const r = cli(['sweep', '--from', FIX, `--max-tool-tokens=${bad}`]);
      expect(r.code, bad).toBe(2);
      expect(r.stderr, bad).toMatch(/--max-tool-tokens expects a non-negative integer/);
    }
    expect(cli(['sweep', '--from', FIX, '--max-tool-tokens', '4000']).code).toBe(0);
    expect(cli(['sweep', '--from', FIX, '--timeout', '1e3']).stderr).toMatch(/--timeout expects a positive number of ms \(whole milliseconds\)/);
  });

  it('accepts every option the README, the help text and the action pass', () => {
    const lines = [
      'snapshot --url https://h/mcp --header A:b --name n --dir d --no-write --quiet --timeout 5 --config c --server s',
      'snapshot --url https://h/mcp --bearer-file f',
      'snapshot --env K=v --cwd /tmp --name n',
      'check --config c --timeout 30000 --ignore-descriptions --allow-additions --server s --report r --json --update',
      'diff a b --json --ignore-descriptions --allow-additions',
      'hash f',
      'hash --url https://h/mcp --bearer-env E',
      'sweep --from f --report r --md m --json --top 3 --tokenizers cl100k --budget-tokenizer cl100k --enum-max 5 --max-description-bytes 9 --max-icon-bytes 9 --count-annotations',
      'sweep --url https://h --bearer-env E --adapter posthog-exec --save-raw x --anthropic --anthropic-model m --call-results c --max-tool-tokens 1 --max-catalog-tokens 2 --name n',
    ];
    for (const l of lines) expect(() => validateFlags(parseArgs(l.split(' '))), l).not.toThrow();
  });
});

describe('positionals', () => {
  it('a command that takes no (or fewer) file arguments refuses stray ones', () => {
    for (const [args, re] of [
      [['snapshot', 'extra'], /unexpected argument "extra" for snapshot/],
      [['check', 'x.json'], /unexpected argument "x.json" for check/],
      [['hash', 'a.json', 'b.json'], /unexpected argument "b.json" for hash/],
      [['diff', 'a', 'b', 'c'], /unexpected argument "c" for diff/],
    ] as const) {
      const r = cli([...args]);
      expect(r.code, args.join(' ')).toBe(2);
      expect(r.stderr, args.join(' ')).toMatch(re);
    }
  });
});

describe('deep catalogs', () => {
  it('snapshot of a schema too deep to pretty-print fails with a clear error; hash still works', () => {
    const env = { MODE: 'deep', DEPTH: '20000' };
    const run = (args: string[]) => {
      const dir = mkdtempSync(join(tmpdir(), 'mcs-deep-'));
      return spawnSync(process.execPath, [CLI, ...args, '--', process.execPath, HOSTILE], { encoding: 'utf8', cwd: dir, timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', HOME: dir, ...env } });
    };
    const s = run(['snapshot', '--name', 'deep']);
    expect(s.status).toBe(2);
    expect(s.stderr).toMatch(/too deeply nested to write as a snapshot/);
    expect(s.stderr).not.toMatch(/Invalid string length/);
    const h = run(['hash']);
    expect(h.status).toBe(0);
    expect(h.stdout.trim()).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('input files', () => {
  it('a FIFO with no writer is a clear error, not a hang', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-fifo-'));
    const fifo = join(dir, 'f.json');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const t0 = Date.now();
    const r = spawnSync(process.execPath, [CLI, 'sweep', '--from', fifo], { encoding: 'utf8', timeout: 20_000, env: { PATH: process.env['PATH'] ?? '' } });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/is a FIFO with nothing to read \(no writer within 5 s\)/);
    expect(Date.now() - t0).toBeLessThan(10_000);
  });

  it('a FIFO with a writer is read', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-fifo-'));
    const fifo = join(dir, 'f.json');
    expect(spawnSync('mkfifo', [fifo]).status).toBe(0);
    const body = JSON.stringify({ tools: [{ name: 'a', inputSchema: { type: 'object' } }] });
    const r = spawnSync('bash', ['-c', `(sleep 1; printf '%s' "$BODY" > "$F") & exec "$NODE" "$CLI" sweep --from "$F" --json`], {
      encoding: 'utf8',
      timeout: 20_000,
      env: { PATH: process.env['PATH'] ?? '', BODY: body, F: fifo, NODE: process.execPath, CLI },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout).totals.tools).toBe(1);
  });

  it('are read with a size cap: /dev/zero is a clean error, not an abort', () => {
    const cases: string[][] = [
      ['sweep', '--from', '/dev/zero'],
      ['hash', '/dev/zero'],
      ['diff', '/dev/zero', FIX],
      ['sweep', '--from', FIX, '--call-results', '/dev/zero'],
      ['check', '--config', '/dev/zero'],
      ['sweep', '--url', 'http://127.0.0.1:9/mcp', '--bearer-file', '/dev/zero'],
    ];
    for (const c of cases) {
      const r = cli(c);
      expect(r.code, c.join(' ')).toBe(2);
      expect(r.stderr, c.join(' ')).toMatch(/is larger than \d+ bytes/);
    }
  });

  it('pipes still work (process substitution, /dev/stdin)', () => {
    const r = cli(['sweep', '--from', '/dev/stdin', '--json'], JSON.stringify({ tools: [{ name: 'a', inputSchema: { type: 'object' } }] }));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).totals.tools).toBe(1);
  });

  it('a UTF-8 byte order mark is accepted', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-bom-'));
    writeFileSync(join(dir, 'bom.json'), `${String.fromCharCode(0xfeff)}${JSON.stringify({ tools: [{ name: 'a', inputSchema: { type: 'object' } }] })}`);
    expect(cli(['sweep', '--from', join(dir, 'bom.json')]).code).toBe(0);
  });
});
