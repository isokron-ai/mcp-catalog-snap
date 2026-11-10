/**
 * PS-K8: the fingerprint is reproducible from the documented recipe (the
 * README's own commands are run here). K-G5: the embedded sha256 is the
 * snapshot's identity and does not depend on capture time or any other
 * header field. K-3: docs and CI install with `npm ci`.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { cmdHash, EXIT_OK, type IO } from '../src/commands.js';
import { buildSnapshot, parseSnapshot, serializeSnapshot, type RawCapture } from '../src/snapshot.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const README = readFileSync(join(ROOT, 'README.md'), 'utf8');
const EXAMPLES = ['kronicle-lite', 'sea-lite'].map((n) => join(ROOT, 'examples', '.mcp-catalog', `${n}.json`));
const DOC_FILE = '.mcp-catalog/kronicle-lite.json';

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const has = (cmd: string, args: string[]): boolean => spawnSync(cmd, args, { encoding: 'utf8' }).status === 0;

/** The shell commands in the README's "Reproducing the fingerprint" section. */
function docCommands(): { node: string; jq: string; python: string } {
  const start = README.indexOf('### Reproducing the fingerprint');
  const section = README.slice(start, README.indexOf('\n## ', start));
  const line = (prefix: string): string => {
    const l = section.split('\n').find((x) => x.startsWith(prefix));
    expect(l, `README has a "${prefix}" line`).toBeDefined();
    return l!;
  };
  return { node: line("node -e '"), jq: line('jq -jcS .catalog '), python: line("python3 -c '") };
}

/** Run a README command against `file`; `sha256sum` is done here (macOS has no sha256sum). */
function runDoc(cmd: string, file: string): string {
  const shell = cmd.replace(DOC_FILE, `'${file}'`).replace(/ \| sha256sum$/, '');
  const r = spawnSync('sh', ['-c', shell], { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
  expect(r.status, r.stderr.toString()).toBe(0);
  return cmd.endsWith('| sha256sum') ? sha(r.stdout) : r.stdout.toString().trim();
}

function snap(tools: unknown[], capturedAt = '2026-01-01T00:00:00.000Z') {
  return buildSnapshot({ server: { name: 's', version: '1' }, protocolVersion: null, tools, prompts: [], resourceTemplates: [] } as RawCapture, { capturedAt });
}

const tool = (extra: Record<string, unknown>) => ({ name: 't', inputSchema: { type: 'object', ...extra } });
/** Catalogs plain sorted JSON (jq >= 1.7, Python) gets right. */
const PLAIN = {
  ascii: tool({ properties: { q: { type: 'string', maxLength: 100 } } }),
  nonascii: tool({ description: 'é ü 中 😀' }),
  controls: tool({ description: 'a\u0001\n\t"\\b' }),
  separators: tool({ description: 'a b‮c' }),
  numbers: tool({ minimum: 1.5, maximum: 12345678901234567000, multipleOf: 0.25 }),
};
/** Catalogs where they diverge from RFC 8785 (documented in the README). */
const DIVERGENT = {
  exponent: tool({ minimum: 1e-7 }),
  astralKey: tool({ properties: { '\u{1F600}': {}, '～': {} } }),
};

describe('fingerprint reproduction (README recipe)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mcs-repro-'));
  const files: Record<string, string> = {};
  for (const [k, t] of Object.entries({ ...PLAIN, ...DIVERGENT })) {
    files[k] = join(dir, `${k}.json`);
    writeFileSync(files[k], serializeSnapshot(snap([t])));
  }
  const stored = (f: string): string => (JSON.parse(readFileSync(f, 'utf8')) as { sha256: string }).sha256;
  const cmds = docCommands();

  it('the Node one-liner reproduces sha256 exactly, edge cases included', () => {
    for (const f of [...EXAMPLES, ...Object.values(files)]) expect(runDoc(cmds.node, f), f).toBe(stored(f));
  });

  it.skipIf(!has('jq', ['--version']))('jq -jcS .catalog | sha256sum reproduces it for typical catalogs', () => {
    const v = spawnSync('jq', ['--version'], { encoding: 'utf8' }).stdout;
    const [maj, min] = (/(\d+)\.(\d+)/.exec(v) ?? ['', '0', '0']).slice(1).map(Number) as [number, number];
    if (maj < 1 || (maj === 1 && min < 7)) return; // the README requires jq 1.7+
    for (const f of [...EXAMPLES, ...Object.keys(PLAIN).map((k) => files[k]!)]) expect(runDoc(cmds.jq, f), f).toBe(stored(f));
  });

  it.skipIf(!has('python3', ['--version']))('the Python one-liner reproduces it for typical catalogs and diverges where documented', () => {
    for (const f of [...EXAMPLES, ...Object.keys(PLAIN).map((k) => files[k]!)]) expect(runDoc(cmds.python, f), f).toBe(stored(f));
    for (const k of Object.keys(DIVERGENT)) expect(runDoc(cmds.python, files[k]!), k).not.toBe(stored(files[k]!));
  });

  it('hashing the tools array alone, or ASCII-escaped JSON, is not the fingerprint (the PS-K8 mismatch)', () => {
    const s = parseSnapshot(readFileSync(files['nonascii']!, 'utf8'), 'f');
    const sortDeep = (v: unknown): unknown =>
      Array.isArray(v) ? v.map(sortDeep) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep((v as Record<string, unknown>)[k])])) : v;
    expect(sha(JSON.stringify(sortDeep(s.catalog)))).toBe(s.sha256);
    expect(sha(JSON.stringify(sortDeep(s.catalog.tools)))).not.toBe(s.sha256);
    const asciiEscaped = JSON.stringify(sortDeep(s.catalog)).replace(/[\u0080-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
    expect(sha(asciiEscaped)).not.toBe(s.sha256);
  });
});

describe('the embedded sha256 is the identity (capturedAt and header fields are not hashed)', () => {
  it('same catalog captured at different times, launched differently, in another flag set: same sha256, different file bytes', async () => {
    const tools = [tool({ properties: { q: { type: 'string' } } })];
    const a = snap(tools, '2026-01-01T00:00:00.000Z');
    const b = buildSnapshot(
      {
        server: { name: 's', version: '2' },
        protocolVersion: '2025-06-18',
        handshake: { requestedProtocolVersion: '2025-11-25', negotiatedProtocolVersion: '2025-06-18', clientCapabilities: { elicitation: {} }, clientInfo: { name: 'x', version: '9' } },
        launch: { transport: 'stdio', command: 'srv', args: ['--read-only'], env: {}, telemetryEnv: { DO_NOT_TRACK: '1' } },
        tools,
        prompts: [],
        resourceTemplates: [],
      },
      { capturedAt: '2027-06-30T12:00:00.000Z', flagSet: 'read-only' },
    );
    expect(b.sha256).toBe(a.sha256);
    const ta = serializeSnapshot(a);
    const tb = serializeSnapshot(b);
    expect(sha(ta)).not.toBe(sha(tb));
    // the catalog body itself is byte-identical in both files
    const body = (t: string): string => t.slice(t.indexOf('"catalog"'), t.indexOf('\n  "flagSet"'));
    expect(body(ta)).toBe(body(tb));

    const dir = mkdtempSync(join(tmpdir(), 'mcs-identity-'));
    writeFileSync(join(dir, 'a.json'), ta);
    writeFileSync(join(dir, 'b.json'), tb);
    const out: string[] = [];
    const io: IO = { out: (s) => out.push(s), err: () => undefined };
    expect(await cmdHash({ file: join(dir, 'a.json') }, io)).toBe(EXIT_OK);
    expect(await cmdHash({ file: join(dir, 'b.json') }, io)).toBe(EXIT_OK);
    expect(out).toEqual([a.sha256, a.sha256]);
  });

  it('capturedAt alone: files differ in exactly that line', () => {
    const tools = [tool({})];
    const ta = serializeSnapshot(snap(tools, '2026-01-01T00:00:00.000Z')).split('\n');
    const tb = serializeSnapshot(snap(tools, '2026-02-02T00:00:00.000Z')).split('\n');
    expect(ta.length).toBe(tb.length);
    const differing = ta.map((l, i) => [l, tb[i]]).filter(([x, y]) => x !== y);
    expect(differing).toEqual([['  "capturedAt": "2026-01-01T00:00:00.000Z",', '  "capturedAt": "2026-02-02T00:00:00.000Z",']]);
  });
});

describe('npm ci (K-3)', () => {
  const contributing = readFileSync(join(ROOT, 'CONTRIBUTING.md'), 'utf8');
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');

  it('README and CONTRIBUTING tell contributors to use npm ci, and the dev loop does not use npm install', () => {
    expect(README).toContain('`npm ci`');
    const loop = contributing.slice(contributing.indexOf('## Dev loop'));
    expect(loop).toMatch(/^npm ci\b/m);
    expect(loop).not.toMatch(/^npm install\b/m);
  });

  it('CI installs with npm ci', () => {
    expect(ci).toMatch(/run: npm ci\b/);
    expect(ci).not.toMatch(/npm install\b/);
  });
});
