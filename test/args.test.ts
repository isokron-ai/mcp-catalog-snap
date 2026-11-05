import { describe, expect, it } from 'vitest';

import { parseArgs, parseHeader, targetFromArgs } from '../src/args.js';

describe('parseArgs', () => {
  it('splits command, flags, positionals and the `--` command', () => {
    const a = parseArgs(['snapshot', '--name', 'x', '--dir=out', 'pos', '--', 'npx', '-y', 'kronicle-lite', 'serve', '--data-dir', 'd']);
    expect(a.cmd).toBe('snapshot');
    expect(a.flags).toEqual({ name: 'x', dir: 'out' });
    expect(a.positional).toEqual(['pos']);
    expect(a.command).toEqual(['npx', '-y', 'kronicle-lite', 'serve', '--data-dir', 'd']);
  });

  it('does not let boolean flags swallow the next token', () => {
    const a = parseArgs(['check', '--json', '--ignore-descriptions', 'extra', '--allow-additions']);
    expect(a.flags).toEqual({ json: true, 'ignore-descriptions': true, 'allow-additions': true });
    expect(a.positional).toEqual(['extra']);
  });

  it('collects repeatable flags', () => {
    const a = parseArgs(['snapshot', '--url', 'https://h/mcp', '--header', 'A: 1', '--header=B: 2', '--env', 'K=v']);
    expect(a.multi).toEqual({ header: ['A: 1', 'B: 2'], env: ['K=v'] });
    expect(() => parseArgs(['snapshot', '--header'])).toThrow(/--header needs a value/);
  });

  it('defaults to help with no argv', () => {
    expect(parseArgs([]).cmd).toBe('help');
  });
});

describe('targetFromArgs', () => {
  it('builds an http target with headers', () => {
    const t = targetFromArgs(parseArgs(['check', '--url', 'https://h/mcp', '--header', 'Authorization: Bearer t0k3n-123']));
    expect(t).toEqual({ kind: 'http', url: 'https://h/mcp', headers: { Authorization: 'Bearer t0k3n-123' } });
  });

  it('builds a stdio target with env and cwd', () => {
    const t = targetFromArgs(parseArgs(['check', '--env', 'A=1', '--cwd', '/w', '--', 'node', 's.js']));
    expect(t).toEqual({ kind: 'stdio', command: 'node', args: ['s.js'], env: { A: '1' }, cwd: '/w' });
  });

  it('returns undefined without a target and rejects both at once', () => {
    expect(targetFromArgs(parseArgs(['check']))).toBeUndefined();
    expect(() => targetFromArgs(parseArgs(['check', '--url', 'https://h', '--', 'node']))).toThrow(/either --url or/);
  });

  it('validates header syntax', () => {
    expect(parseHeader('X-A:  v: w ')).toEqual(['X-A', 'v: w']);
    expect(() => parseHeader('novalue')).toThrow(/"Name: value"/);
    expect(() => targetFromArgs(parseArgs(['check', '--env', 'novalue', '--', 'node']))).toThrow(/"KEY=value"/);
  });
});
