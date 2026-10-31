import { describe, expect, it } from 'vitest';

import { fingerprint } from '../src/canonical.js';
import {
  SNAPSHOT_FORMAT,
  buildSnapshot,
  normalizeCatalog,
  parseSnapshot,
  safeFileName,
  serializeSnapshot,
  snapshotSelfConsistent,
  type RawCapture,
} from '../src/snapshot.js';
import { VERSION } from '../src/version.js';

const raw: RawCapture = {
  server: { name: 'demo', version: '1.2.3' },
  protocolVersion: '2025-06-18',
  tools: [
    { name: 'zeta', inputSchema: { type: 'object', properties: {} }, description: 'last' },
    { name: 'alpha', inputSchema: { properties: { x: { type: 'string' } }, type: 'object', required: ['x'] }, annotations: { readOnlyHint: true } },
  ],
  prompts: [{ name: 'p2' }, { name: 'p1', description: 'first' }],
  resourceTemplates: [
    { uriTemplate: 'x://b/{id}', name: 'b' },
    { uriTemplate: 'x://a/{id}', name: 'a' },
  ],
};

describe('normalizeCatalog', () => {
  it('sorts tools and prompts by name and templates by uriTemplate', () => {
    const c = normalizeCatalog(raw);
    expect(c.tools.map((t) => t.name)).toEqual(['alpha', 'zeta']);
    expect(c.prompts.map((p) => p.name)).toEqual(['p1', 'p2']);
    expect(c.resourceTemplates.map((r) => r.uriTemplate)).toEqual(['x://a/{id}', 'x://b/{id}']);
  });

  it('deep-sorts keys inside each entry', () => {
    const c = normalizeCatalog(raw);
    expect(Object.keys(c.tools[0]!)).toEqual(['annotations', 'inputSchema', 'name']);
    expect(Object.keys(c.tools[0]!.inputSchema as object)).toEqual(['properties', 'required', 'type']);
  });

  it('keeps every field the server sent (no stripping)', () => {
    const c = normalizeCatalog({ ...raw, tools: [{ name: 't', inputSchema: { type: 'object' }, _meta: { k: 1 }, custom: 'x' }] });
    expect(c.tools[0]).toEqual({ _meta: { k: 1 }, custom: 'x', inputSchema: { type: 'object' }, name: 't' });
  });

  it('rejects duplicate tool names', () => {
    expect(() =>
      normalizeCatalog({ ...raw, tools: [{ name: 'a', inputSchema: {} }, { name: 'a', inputSchema: {} }] }),
    ).toThrow(/duplicate tool names: a/);
  });

  it('rejects entries without a string key', () => {
    expect(() => normalizeCatalog({ ...raw, tools: [{ inputSchema: {} }] })).toThrow(/missing a string "name"/);
    expect(() => normalizeCatalog({ ...raw, resourceTemplates: [{ name: 'x' }] })).toThrow(/"uriTemplate"/);
  });
});

describe('buildSnapshot', () => {
  it('fills the header and hashes only the catalog', () => {
    const snap = buildSnapshot(raw, { capturedAt: '2026-01-01T00:00:00.000Z' });
    expect(snap.format).toBe(SNAPSHOT_FORMAT);
    expect(snap.server).toEqual({ name: 'demo', version: '1.2.3' });
    expect(snap.protocolVersion).toBe('2025-06-18');
    expect(snap.capturedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(snap.capturedWith).toBe(`mcp-catalog-snap/${VERSION}`);
    expect(snap.sha256).toBe(fingerprint(snap.catalog));
  });

  it('gives the same sha256 regardless of server version or capture time', () => {
    const a = buildSnapshot(raw, { capturedAt: '2026-01-01T00:00:00.000Z' });
    const b = buildSnapshot({ ...raw, server: { name: 'demo', version: '9.9.9' } }, { capturedAt: '2027-01-01T00:00:00.000Z' });
    expect(a.sha256).toBe(b.sha256);
  });

  it('gives the same sha256 regardless of list order', () => {
    const a = buildSnapshot(raw);
    const b = buildSnapshot({ ...raw, tools: [...raw.tools].reverse(), prompts: [...raw.prompts].reverse() });
    expect(a.sha256).toBe(b.sha256);
  });
});

describe('serialize / parse', () => {
  it('round-trips byte-for-byte', () => {
    const snap = buildSnapshot(raw, { capturedAt: '2026-01-01T00:00:00.000Z' });
    const text = serializeSnapshot(snap);
    const back = parseSnapshot(text, 'mem');
    expect(back).toEqual(snap);
    expect(serializeSnapshot(back)).toBe(text);
    expect(snapshotSelfConsistent(back)).toBe(true);
  });

  it('writes keys in JCS order with a trailing newline', () => {
    const text = serializeSnapshot(buildSnapshot(raw));
    expect(text.endsWith('}\n')).toBe(true);
    const keys = Object.keys(JSON.parse(text) as object);
    expect(keys).toEqual([...keys].sort());
  });

  it('rejects malformed files with a useful message', () => {
    expect(() => parseSnapshot('{', 'f.json')).toThrow(/f\.json: not valid JSON/);
    expect(() => parseSnapshot('[]', 'f.json')).toThrow(/expected a JSON object/);
    expect(() => parseSnapshot('{"format":"nope"}', 'f.json')).toThrow(/unsupported format "nope"/);
    expect(() => parseSnapshot(JSON.stringify({ format: SNAPSHOT_FORMAT, server: {} }), 'f.json')).toThrow(/missing "catalog"/);
    expect(() =>
      parseSnapshot(JSON.stringify({ format: SNAPSHOT_FORMAT, server: {}, catalog: { tools: [], prompts: {}, resourceTemplates: [] } }), 'f.json'),
    ).toThrow(/catalog\.prompts must be an array/);
  });

  it('detects a hand-edited body via snapshotSelfConsistent', () => {
    const snap = buildSnapshot(raw);
    const edited = parseSnapshot(serializeSnapshot(snap).replace('"last"', '"LAST"'), 'mem');
    expect(snapshotSelfConsistent(edited)).toBe(false);
  });
});

describe('safeFileName', () => {
  it('flattens slashes and odd characters', () => {
    expect(safeFileName('kronicle-lite')).toBe('kronicle-lite');
    expect(safeFileName('io.github.rafe-walker/kronicle-lite')).toBe('io.github.rafe-walker__kronicle-lite');
    expect(safeFileName('my server (v2)!')).toBe('my_server_v2_');
    expect(safeFileName('../../etc')).toBe('__..__etc'); // no separators, no leading dot
    expect(safeFileName('../../etc')).not.toMatch(/[\\/]/);
    expect(safeFileName('')).toBe('server');
  });
});
