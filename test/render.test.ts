import { describe, expect, it } from 'vitest';

import { diffCatalogs, evaluate } from '../src/diff.js';
import { renderDiff, renderSnapshotHeader } from '../src/render.js';
import { buildSnapshot, normalizeCatalog } from '../src/snapshot.js';

const before = normalizeCatalog({
  tools: [
    { name: 'a', description: 'A.', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
    { name: 'b', description: 'B.', inputSchema: { type: 'object' } },
  ],
  prompts: [],
  resourceTemplates: [],
});

describe('renderDiff', () => {
  it('renders an identical catalog in three lines', () => {
    const d = diffCatalogs(before, before);
    const out = renderDiff(d, evaluate(d));
    expect(out.split('\n')).toHaveLength(3);
    expect(out).toContain('catalog: identical (byte-for-byte canonical match)');
    expect(out).toMatch(/fingerprint snapshot: [0-9a-f]{64}\nfingerprint live: {5}[0-9a-f]{64}/);
  });

  it('renders added/removed/changed with the description-only tag and DRIFT reasons', () => {
    const after = normalizeCatalog({
      tools: [
        { name: 'a', description: 'A, edited.', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
        { name: 'c', inputSchema: { type: 'object' } },
      ],
      prompts: [],
      resourceTemplates: [],
    });
    const d = diffCatalogs(before, after);
    const out = renderDiff(d, evaluate(d));
    expect(out).toContain('tools: 2 -> 2 (+1 added, -1 removed, ~1 changed)');
    expect(out).toContain('  + c');
    expect(out).toContain('  - b');
    expect(out).toContain('  ~ a  [description-only]');
    expect(out).toContain('      /description (description)');
    expect(out).toContain('        - "A."');
    expect(out).toContain('        + "A, edited."');
    expect(out).toContain('DRIFT: 3 reason(s)');
  });

  it('lists waived changes and says the prefix still changes', () => {
    const after = normalizeCatalog({
      tools: [
        { name: 'a', description: 'A!', inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
        { name: 'b', description: 'B.', inputSchema: { type: 'object' } },
      ],
      prompts: [],
      resourceTemplates: [],
    });
    const d = diffCatalogs(before, after);
    const out = renderDiff(d, evaluate(d, { ignoreDescriptions: true }));
    expect(out).toContain('waived by policy:\n  tool description changed: a (/description)');
    expect(out).toContain('no drift under the current policy (bytes differ: cache prefix WILL change)');
    expect(out).not.toContain('DRIFT');
  });

  it('truncates long values and honors custom labels', () => {
    const long = 'x'.repeat(500);
    const after = normalizeCatalog({
      tools: [
        { name: 'a', description: long, inputSchema: { type: 'object', properties: { x: { type: 'string' } } } },
        { name: 'b', description: 'B.', inputSchema: { type: 'object' } },
      ],
      prompts: [],
      resourceTemplates: [],
    });
    const d = diffCatalogs(before, after);
    const out = renderDiff(d, evaluate(d), { beforeLabel: 'old.json', afterLabel: 'new.json' });
    expect(out).toContain('fingerprint old.json:');
    expect(out).toContain('fingerprint new.json:');
    expect(out).toContain('…');
    expect(out).not.toContain(long);
  });
});

describe('renderDiff focused string window', () => {
  it('shows the differing tail of a long description instead of its identical head', () => {
    const head = 'Orient call. '.repeat(20);
    const mk = (desc: string) =>
      normalizeCatalog({ tools: [{ name: 'a', description: desc, inputSchema: { type: 'object' } }], prompts: [], resourceTemplates: [] });
    const d = diffCatalogs(mk(`${head}Old ending.`), mk(`${head}New ending.`));
    const out = renderDiff(d, evaluate(d));
    expect(out).toContain('- …');
    expect(out).toContain('Old ending."');
    expect(out).toContain('New ending."');
  });
});

describe('renderSnapshotHeader', () => {
  it('summarizes the header and counts', () => {
    const snap = buildSnapshot(
      { server: { name: 's', version: '1.0.0' }, protocolVersion: '2025-06-18', tools: [], prompts: [], resourceTemplates: [] },
      { capturedAt: '2026-01-01T00:00:00.000Z' },
    );
    const out = renderSnapshotHeader(snap);
    expect(out).toContain('server:          s 1.0.0');
    expect(out).toContain('protocolVersion: 2025-06-18');
    expect(out).toContain('catalog:         0 tools, 0 prompts, 0 resource templates');
    expect(out).toContain(`sha256:          ${snap.sha256}`);
  });
});
