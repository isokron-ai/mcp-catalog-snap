/**
 * Server labels never carry the stdio command line (0.2.0 release review,
 * blocking finding on #11).
 *
 * Before the fix the label for an argv-launched server was the command and
 * its arguments with a list of credential patterns masked, and it went to
 * stderr and into `check --report` as `servers[].server`. Pattern lists
 * leak: `check --report r.json -- node srv --header "Authorization: Bearer
 * S" postgresql://u:PW@h/db` wrote both S and PW, and so did mongodb+srv://
 * and redis:// userinfo, `-e TOKEN=V` / `KEY=V` (V without a digit or with
 * punctuation), `--dsn=postgres://…`, and `--pat`, `--bearer`, `-t`, `-k`
 * values. The label is now the command basename plus a hash
 * (`node#1a2b3c4d`) or an explicit `--label`; the masking rules remain as
 * defence in depth for anything that does show arguments.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { describeTarget } from '../src/capture.js';
import { credentialName, maskedArgs, targetSecrets } from '../src/redact.js';

const CLI = fileURLToPath(new URL('../dist/cli.js', import.meta.url));

/** Letters only (no digit: `looksSecret` cannot recognize it by shape). */
function letters(tag: string): string {
  let s = '';
  for (let i = 0; i < 14; i++) s += String.fromCharCode(97 + Math.floor(Math.random() * 26));
  return `${tag}${s}`;
}

const S = {
  bearer: letters('bearer'),
  pg: letters('pgpw'),
  mongo: letters('mongopw'),
  redis: letters('redispw'),
  redisUser: letters('redisuserpw'),
  envNoDigit: letters('envtok'),
  keyPunct: `${letters('keyp')}!#%^,x`,
  dsn: letters('dsnpw'),
  pat: letters('patv'),
  bearerFlag: letters('bearerflag'),
  t: letters('tval'),
  k: letters('kval'),
  apiKeyHeader: letters('hdrkey'),
};

/** One argv per leak the review listed (plus a credential header via -H). */
const LEAKS: [string, string[], string][] = [
  ['--header Authorization: Bearer', ['--header', `Authorization: Bearer ${S.bearer}`], S.bearer],
  ['postgresql:// userinfo', [`postgresql://u:${S.pg}@h/db`], S.pg],
  ['mongodb+srv:// userinfo', [`mongodb+srv://app:${S.mongo}@cluster0.example.net/db?retryWrites=true`], S.mongo],
  ['redis:// userinfo (no user)', [`redis://:${S.redis}@h:6379/0`], S.redis],
  ['redis:// userinfo (user)', [`redis://default:${S.redisUser}@h:6379`], S.redisUser],
  ['-e TOKEN=V, V without a digit', ['-e', `TOKEN=${S.envNoDigit}`], S.envNoDigit],
  ['KEY=V, V with punctuation', [`KEY=${S.keyPunct}`], S.keyPunct],
  ['--dsn=postgres://…', [`--dsn=postgres://u:${S.dsn}@h/db`], S.dsn],
  ['--pat V', ['--pat', S.pat], S.pat],
  ['--bearer V', ['--bearer', S.bearerFlag], S.bearerFlag],
  ['-t V', ['-t', S.t], S.t],
  ['-k V', ['-k', S.k], S.k],
  ['-H X-Api-Key: V', ['-H', `X-Api-Key: ${S.apiKeyHeader}`], S.apiKeyHeader],
];

function run(args: string[], cwd: string) {
  const r = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', cwd, timeout: 60_000, env: { PATH: process.env['PATH'] ?? '', HOME: cwd } });
  return { code: r.status, stdout: r.stdout, stderr: r.stderr };
}

/** stdout + stderr + every file written under `dir`. */
function everything(dir: string, out: string): string {
  let s = out;
  for (const e of readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (e.isFile()) s += `\n${readFileSync(join(e.parentPath, e.name), 'utf8')}`;
  }
  return s;
}

describe('describeTarget: stdio labels carry no arguments', () => {
  it('is the command basename plus an 8-hex hash, stable, and distinguishes command lines', () => {
    const t = { kind: 'stdio' as const, command: '/usr/local/bin/node', args: ['srv.js', '--profile', 'ro'] };
    const l = describeTarget(t);
    expect(l).toMatch(/^node#[0-9a-f]{8}$/);
    expect(describeTarget({ ...t, args: [...t.args] })).toBe(l);
    expect(describeTarget({ ...t, args: ['srv.js', '--profile', 'rw'] })).not.toBe(l);
    expect(describeTarget({ ...t, command: '/opt/node' })).not.toBe(l);
    expect(describeTarget({ kind: 'stdio', command: 'srv', args: [] })).toMatch(/^srv#[0-9a-f]{8}$/);
  });

  it.each(LEAKS)('%s: the label does not contain the secret', (_name, args, secret) => {
    const l = describeTarget({ kind: 'stdio', command: 'node', args: ['srv', ...args] });
    expect(l).toMatch(/^node#[0-9a-f]{8}$/);
    expect(l).not.toContain(secret);
  });

  it('the hash is over the masked command line: it does not depend on a recognized credential', () => {
    const a = describeTarget({ kind: 'stdio', command: 'srv', args: ['--token', letters('a')] });
    const b = describeTarget({ kind: 'stdio', command: 'srv', args: ['--token', letters('b')] });
    expect(a).toBe(b);
  });
});

describe('maskedArgs (defence in depth)', () => {
  it.each(LEAKS)('%s: masked', (_name, args, secret) => {
    const m = maskedArgs(['srv', ...args]).join(' ');
    expect(m).not.toContain(secret);
    expect(m).toContain('***');
  });

  it('keeps ordinary arguments and flag names readable', () => {
    expect(maskedArgs(['serve', '--path', '/a/b', '--profile', 'ro', '--header', 'Authorization: Bearer x', `postgresql://u:${S.pg}@h:5432/db`])).toEqual([
      'serve',
      '--path',
      '/a/b',
      '--profile',
      'ro',
      '--header',
      'Authorization: ***',
      'postgresql://***@h:5432/db',
    ]);
  });

  it('also masks attached short values, Authorization / Bearer anywhere, connection-string and query credentials', () => {
    const v = letters('misc');
    for (const a of [
      [`-t${v}`],
      [`-p${v}`],
      [`x-proxy Authorization: Basic ${v}`],
      [`use Bearer ${v} please`],
      [`Server=h;Password=${v};Db=x`],
      [`amqp://h/vhost?password=${v}&heartbeat=30`],
      [`--env=API_TOKEN=${v}`],
      [`https://${v}9z1@github.com/o/r`],
      ['--api-key', v],
      [`--secretFile=${v}`],
      ['--github-pat', v],
      ['--sentry-dsn', v],
    ]) {
      expect(maskedArgs(a).join(' '), a.join(' ')).not.toContain(v);
    }
  });

  it('credential names: substrings anywhere, short words only as whole words', () => {
    for (const n of ['--token', '--api-key', '--authToken', 'GITHUB_TOKEN', 'DB_PASSWORD', '--pwd', '--pat', '--github-pat', '--githubPat', '--sentry-dsn', '--dsn', 'AWS_SECRET_ACCESS_KEY', '--bearer', '--cred-file']) {
      expect(credentialName(n), n).toBe(true);
    }
    for (const n of ['--path', '--patch', '--profile', '--verbose', '--port', 'HOME', '--dns-server']) expect(credentialName(n), n).toBe(false);
  });
});

describe('targetSecrets: argv credentials are scrubbed wherever they are echoed', () => {
  it('collects every leak value except the display-only -t / -k', () => {
    const all = LEAKS.flatMap(([, a]) => a);
    const s = targetSecrets({ kind: 'stdio', command: 'node', args: ['srv', ...all] });
    for (const [name, , secret] of LEAKS) {
      if (secret === S.t || secret === S.k) continue;
      expect(s, name).toContain(secret);
    }
    // -t / -k values are too ambiguous (a tag, a timeout, a mode) to refuse catalogs over
    expect(s).not.toContain(S.t);
    expect(s).not.toContain(S.k);
  });

  it('does not treat ordinary values as credentials', () => {
    const s = targetSecrets({ kind: 'stdio', command: 'node', args: ['srv', '--path', '/very/long/path/to/data', '--mode', 'streamable', 'postgresql://postgres@h/db', '-t', 'streamable-http'] });
    expect(s).toEqual([]);
  });
});

describe('CLI: no argv secret reaches stderr, stdout or the report', () => {
  it.each(LEAKS)('%s: check --report and snapshot', (_name, args, secret) => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-argv-'));
    let out = '';
    for (const cmd of [['check', '--report', 'r.json'], ['check', '--json', '--report', 'r2.json'], ['snapshot']]) {
      const r = run([...cmd, '--timeout', '5000', '--', process.execPath, join(dir, 'no-such-srv.js'), ...args], dir);
      expect(r.code, cmd.join(' ')).toBe(2);
      out += `${r.stdout}\n${r.stderr}`;
      if (!cmd.includes('--json')) expect(r.stderr).toMatch(/error: node#[0-9a-f]{8}: /);
    }
    const report = JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as { servers: { server: string }[] };
    expect(report.servers[0]!.server).toMatch(/^node#[0-9a-f]{8}$/);
    expect(everything(dir, out)).not.toContain(secret);
  });

  it('the review repro: --header "Authorization: Bearer …" and postgresql://u:PW@h/db together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-argv-'));
    const r = run(['check', '--report', 'r.json', '--', process.execPath, join(dir, 'srv'), '--header', `Authorization: Bearer ${S.bearer}`, `postgresql://u:${S.pg}@h/db`], dir);
    expect(r.code).toBe(2);
    const seen = everything(dir, `${r.stdout}\n${r.stderr}`);
    expect(seen).not.toContain(S.bearer);
    expect(seen).not.toContain(S.pg);
  });

  it('--label names the ad-hoc server in stderr and the report; it is refused for configured servers', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-argv-'));
    const r = run(['check', '--label', 'billing-db', '--report', 'r.json', '--', process.execPath, join(dir, 'srv'), '--pat', S.pat], dir);
    expect(r.code).toBe(2);
    expect(r.stderr).toMatch(/error: billing-db: /);
    expect((JSON.parse(readFileSync(join(dir, 'r.json'), 'utf8')) as { servers: { server: string }[] }).servers[0]!.server).toBe('billing-db');
    expect(run(['snapshot', '--label', 'x', '--', process.execPath, join(dir, 'srv')], dir).stderr).toMatch(/error: x: /);
    const cfg = run(['check', '--label', 'x'], dir);
    expect(cfg.code).toBe(2);
    expect(cfg.stderr).toMatch(/--label names an ad-hoc target/);
    expect(run(['check', '--label', '', '--', 'srv'], dir).stderr).toMatch(/--label must not be empty/);
    expect(run(['hash', '--label', 'x', '--', 'srv'], dir).stderr).toMatch(/unknown option --label for hash/);
  });
});
