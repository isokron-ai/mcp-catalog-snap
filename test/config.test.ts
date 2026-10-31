import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { expandEnv, loadConfig, parseConfig } from '../src/config.js';

const env = { HOME: '/home/x', MCP_TOKEN: 'secret-123', PORT: '8080' } as NodeJS.ProcessEnv;
const path = '/proj/.mcp-catalog.json';

describe('expandEnv', () => {
  it('expands ${VAR} and leaves other text alone', () => {
    expect(expandEnv('Bearer ${MCP_TOKEN}', env)).toBe('Bearer secret-123');
    expect(expandEnv('http://h:${PORT}/mcp', env)).toBe('http://h:8080/mcp');
    expect(expandEnv('$HOME ${}', env)).toBe('$HOME ${}');
  });

  it('fails loudly on an unset variable', () => {
    expect(() => expandEnv('${NOPE}', env)).toThrow(/environment variable NOPE is not set/);
  });
});

describe('parseConfig', () => {
  it('parses stdio and http servers', () => {
    const cfg = parseConfig(
      JSON.stringify({
        servers: [
          { name: 'a', command: ['npx', '-y', 'kronicle-lite@0.2.0', 'serve'] },
          { name: 'b', command: 'node server.js', args: ['--flag'], env: { X: '1' }, cwd: 'sub' },
          { name: 'c', url: 'https://h/mcp', headers: { Authorization: 'Bearer ${MCP_TOKEN}' } },
        ],
      }),
      path,
      env,
    );
    expect(cfg.path).toBe(resolve(path));
    expect(cfg.snapshotDir).toBe(resolve('/proj/.mcp-catalog'));
    expect(cfg.servers).toHaveLength(3);
    expect(cfg.servers[0]!.target).toEqual({ kind: 'stdio', command: 'npx', args: ['-y', 'kronicle-lite@0.2.0', 'serve'] });
    expect(cfg.servers[1]!.target).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['server.js', '--flag'],
      env: { X: '1' },
      cwd: resolve('/proj/sub'),
    });
    expect(cfg.servers[2]!.target).toEqual({ kind: 'http', url: 'https://h/mcp', headers: { Authorization: 'Bearer secret-123' } });
  });

  it('resolves a custom relative snapshotDir against the config directory and keeps absolute ones', () => {
    expect(parseConfig(JSON.stringify({ snapshotDir: 'snaps', servers: [] }), path, env).snapshotDir).toBe(resolve('/proj/snaps'));
    expect(parseConfig(JSON.stringify({ snapshotDir: '/abs', servers: [] }), path, env).snapshotDir).toBe(resolve('/abs'));
  });

  it('expands env in command tokens, env and cwd', () => {
    const cfg = parseConfig(
      JSON.stringify({ servers: [{ name: 'a', command: ['node', '${HOME}/s.js'], env: { T: '${MCP_TOKEN}' }, cwd: '${HOME}' }] }),
      path,
      env,
    );
    expect(cfg.servers[0]!.target).toEqual({
      kind: 'stdio',
      command: 'node',
      args: ['/home/x/s.js'],
      env: { T: 'secret-123' },
      cwd: resolve('/home/x'),
    });
  });

  it('rejects structural mistakes with the offending path', () => {
    const bad = (servers: unknown, re: RegExp) =>
      expect(() => parseConfig(JSON.stringify({ servers }), path, env)).toThrow(re);
    bad([{ command: ['x'] }], /servers\[0\]\.name is required/);
    bad([{ name: 'a' }], /exactly one of "command" or "url"/);
    bad([{ name: 'a', command: ['x'], url: 'http://h' }], /exactly one of "command" or "url"/);
    bad([{ name: 'a', command: 42 }], /command must be a string or an array/);
    bad([{ name: 'a', command: '' }], /command is empty/);
    bad([{ name: 'a', url: 'http://h', headers: { A: 1 } }], /headers\.A must be a string/);
    bad([{ name: 'a', command: ['x'] }, { name: 'a', command: ['y'] }], /duplicate server name "a"/);
    bad('nope', /"servers" must be an array/);
    expect(() => parseConfig('[1]', path, env)).toThrow(/expected a JSON object/);
    expect(() => parseConfig('{', path, env)).toThrow(/not valid JSON/);
  });

  it('surfaces a missing secret instead of sending a literal ${...}', () => {
    expect(() => parseConfig(JSON.stringify({ servers: [{ name: 'c', url: 'https://h', headers: { A: '${MISSING}' } }] }), path, env)).toThrow(
      /MISSING is not set/,
    );
  });
});

describe('loadConfig', () => {
  it('reads from disk and resolves snapshotDir next to the file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mcs-cfg-'));
    const file = join(dir, '.mcp-catalog.json');
    writeFileSync(file, JSON.stringify({ servers: [{ name: 'x', command: 'node x.js' }] }));
    const cfg = loadConfig(file, env);
    expect(cfg.snapshotDir).toBe(join(dir, '.mcp-catalog'));
    expect(cfg.servers[0]!.name).toBe('x');
  });

  it('reports an unreadable file', () => {
    expect(() => loadConfig('/nonexistent/.mcp-catalog.json', env)).toThrow(/cannot read config/);
  });
});
