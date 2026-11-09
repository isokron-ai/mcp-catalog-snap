import { describe, expect, it } from 'vitest';

import { diffCatalogs, diffValues, evaluate } from '../src/diff.js';
import { normalizeCatalog, type Catalog } from '../src/snapshot.js';

function catalog(tools: unknown[], extra: Partial<{ prompts: unknown[]; resourceTemplates: unknown[] }> = {}): Catalog {
  return normalizeCatalog({ tools, prompts: extra.prompts ?? [], resourceTemplates: extra.resourceTemplates ?? [] });
}

const base = catalog([
  {
    name: 'get_doc',
    description: 'Fetch a document.',
    inputSchema: {
      type: 'object',
      properties: { slug: { type: 'string', description: 'Document slug.' }, rev: { type: 'integer' } },
      required: ['slug'],
    },
    annotations: { readOnlyHint: true },
  },
  { name: 'put_doc', description: 'Store.', inputSchema: { type: 'object', properties: { body: { type: 'string' } } } },
]);

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

describe('diffValues', () => {
  it('returns no changes for canonically equal values', () => {
    expect(diffValues({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toEqual([]);
  });

  it('reports leaf paths as JSON Pointers', () => {
    const ch = diffValues({ inputSchema: { properties: { q: { type: 'string' } } } }, { inputSchema: { properties: { q: { type: 'number' } } } });
    expect(ch).toEqual([{ path: '/inputSchema/properties/q/type', before: 'string', after: 'number', descriptive: false }]);
  });

  it('reports array element and length changes by index', () => {
    const ch = diffValues({ required: ['a', 'b'] }, { required: ['a'] });
    expect(ch).toEqual([{ path: '/required/1', before: 'b', after: undefined, descriptive: false }]);
  });

  it('escapes ~ and / in pointer segments', () => {
    const ch = diffValues({ 'a/b': { 'c~d': 1 } }, { 'a/b': { 'c~d': 2 } });
    expect(ch[0]!.path).toBe('/a~1b/c~0d');
  });

  it('treats a type change (object vs scalar) as a single leaf change', () => {
    const ch = diffValues({ x: { y: 1 } }, { x: 5 });
    expect(ch).toEqual([{ path: '/x', before: { y: 1 }, after: 5, descriptive: false }]);
  });

  it('marks any path ending in "description" as descriptive', () => {
    expect(diffValues({ description: 'a' }, { description: 'b' })[0]!.descriptive).toBe(true);
    expect(diffValues({ s: { p: { description: 'a' } } }, { s: { p: { description: 'b' } } })[0]!.descriptive).toBe(true);
    expect(diffValues({ title: 'a' }, { title: 'b' })[0]!.descriptive).toBe(false);
  });
});

describe('diffCatalogs', () => {
  it('reports identical catalogs', () => {
    const d = diffCatalogs(base, clone(base));
    expect(d.identical).toBe(true);
    expect(d.fingerprint.before).toBe(d.fingerprint.after);
    expect(d.sections.every((s) => s.added.length + s.removed.length + s.changed.length === 0)).toBe(true);
  });

  it('reports added and removed tools', () => {
    const after = catalog([base.tools[0], { name: 'new_tool', inputSchema: { type: 'object' } }]);
    const d = diffCatalogs(base, after);
    const tools = d.sections.find((s) => s.section === 'tools')!;
    expect(tools.added).toEqual(['new_tool']);
    expect(tools.removed).toEqual(['put_doc']);
    expect(tools.changed).toEqual([]);
    expect(d.counts).toEqual({
      before: { tools: 2, prompts: 0, resourceTemplates: 0 },
      after: { tools: 2, prompts: 0, resourceTemplates: 0 },
    });
  });

  it('flags a top-level description change as description-only', () => {
    const after = clone(base);
    after.tools[0]!.description = 'Fetch a document (now with more words).';
    const d = diffCatalogs(base, after);
    const tools = d.sections.find((s) => s.section === 'tools')!;
    expect(tools.changed).toHaveLength(1);
    expect(tools.changed[0]!.key).toBe('get_doc');
    expect(tools.changed[0]!.descriptionOnly).toBe(true);
    expect(tools.changed[0]!.changes[0]!.path).toBe('/description');
    expect(d.identical).toBe(false);
  });

  it('flags a nested property description change as description-only too', () => {
    const after = clone(base);
    (after.tools[0]!.inputSchema as { properties: { slug: { description: string } } }).properties.slug.description = 'The slug.';
    const tools = diffCatalogs(base, after).sections[0]!;
    expect(tools.changed[0]!.descriptionOnly).toBe(true);
    expect(tools.changed[0]!.changes[0]!.path).toBe('/inputSchema/properties/slug/description');
  });

  it('does not call a mixed change description-only', () => {
    const after = clone(base);
    after.tools[0]!.description = 'changed';
    (after.tools[0]!.inputSchema as { required: string[] }).required = [];
    const tools = diffCatalogs(base, after).sections[0]!;
    expect(tools.changed[0]!.descriptionOnly).toBe(false);
    expect(tools.changed[0]!.changes.map((c) => c.path)).toEqual(['/description', '/inputSchema/required/0']);
  });

  it('diffs prompts and resource templates by their own keys', () => {
    const before = catalog([], {
      prompts: [{ name: 'p', description: 'x' }],
      resourceTemplates: [{ uriTemplate: 'a://{id}', name: 'a' }],
    });
    const after = catalog([], {
      prompts: [{ name: 'p', description: 'y' }],
      resourceTemplates: [{ uriTemplate: 'b://{id}', name: 'a' }],
    });
    const d = diffCatalogs(before, after);
    expect(d.sections[1]!.changed[0]!.key).toBe('p');
    expect(d.sections[2]!.added).toEqual(['b://{id}']);
    expect(d.sections[2]!.removed).toEqual(['a://{id}']);
  });
});

describe('evaluate (drift policy)', () => {
  it('no drift on identical', () => {
    const v = evaluate(diffCatalogs(base, clone(base)));
    expect(v).toEqual({ drift: false, reasons: [], waived: [] });
  });

  it('description changes are drift by default and waived with ignoreDescriptions', () => {
    const after = clone(base);
    after.tools[1]!.description = 'Store (edited).';
    const d = diffCatalogs(base, after);
    expect(evaluate(d).drift).toBe(true);
    expect(evaluate(d).reasons[0]).toMatch(/^tool description changed: put_doc \(\/description\)/);
    const waived = evaluate(d, { ignoreDescriptions: true });
    expect(waived.drift).toBe(false);
    expect(waived.waived).toHaveLength(1);
  });

  it('additions are drift by default and waived with allowAdditions (read-only tools)', () => {
    const after = catalog([...base.tools, { name: 'extra', inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }]);
    const d = diffCatalogs(base, after);
    expect(evaluate(d).reasons).toEqual(['tool added: extra']);
    const v = evaluate(d, { allowAdditions: true });
    expect(v.drift).toBe(false);
    expect(v.waived).toEqual(['tool added: extra']);
    // an added tool without annotations may write (spec default): allowAdditions alone does not waive it
    const w = diffCatalogs(base, catalog([...base.tools, { name: 'extra', inputSchema: { type: 'object' } }]));
    expect(evaluate(w, { allowAdditions: true }).reasons).toEqual(['tool added (destructive, not read-only): extra']);
    expect(evaluate(w, { allowAdditions: true, allowWriteAdditions: true }).drift).toBe(false);
  });

  it('allowAdditions does not waive additions to a section the snapshot lists as empty', () => {
    const empty = catalog([]);
    const v = evaluate(diffCatalogs(empty, base), { allowAdditions: true });
    expect(v.drift).toBe(true);
    expect(v.waived).toEqual([]);
    expect(v.reasons).toEqual([
      'tools: snapshot lists none, live server lists 2 — --allow-additions waives additions only against a non-empty baseline; re-snapshot if this is intended',
      'tool added: get_doc',
      'tool added (destructive, not read-only): put_doc',
    ]);
    // same rule per section: a first prompt on a server whose snapshot has none is not waived
    const withPrompt = catalog(clone(base.tools), { prompts: [{ name: 'p' }] });
    const p = evaluate(diffCatalogs(base, withPrompt), { allowAdditions: true });
    expect(p.drift).toBe(true);
    expect(p.reasons[0]).toMatch(/^prompts: snapshot lists none, live server lists 1/);
    // and without allowAdditions nothing changes: plain additions, no baseline note
    expect(evaluate(diffCatalogs(empty, base)).reasons).toEqual(['tool added: get_doc', 'tool added (destructive, not read-only): put_doc']);
  });

  it('allowAdditions waives additions against a non-empty baseline, whatever the size gap', () => {
    const one = catalog([clone(base.tools[0]!)]);
    const many = catalog([...clone(base.tools), ...['c', 'd', 'e'].map((name) => ({ name, inputSchema: { type: 'object' }, annotations: { readOnlyHint: true } }))]);
    const v = evaluate(diffCatalogs(one, many), { allowAdditions: true, allowWriteAdditions: true });
    expect(v.drift).toBe(false);
    expect(v.waived).toEqual(['tool added: c', 'tool added: d', 'tool added: e', 'tool added (destructive, not read-only): put_doc']);
    // two empty sections on both sides are not drift
    expect(evaluate(diffCatalogs(catalog([]), catalog([])), { allowAdditions: true }).drift).toBe(false);
  });

  it('removals and schema changes are never waived', () => {
    const after = catalog([
      { ...clone(base.tools[0]!), inputSchema: { type: 'object', properties: {}, required: [] } },
    ]);
    const v = evaluate(diffCatalogs(base, after), { ignoreDescriptions: true, allowAdditions: true });
    expect(v.drift).toBe(true);
    expect(v.reasons).toEqual([
      'tool removed: put_doc',
      'tool changed: get_doc (/inputSchema/properties/rev, /inputSchema/properties/slug, /inputSchema/required/0)',
    ]);
  });

  it('splits structural and descriptive reasons for the same tool', () => {
    const after = clone(base);
    after.tools[0]!.description = 'x';
    after.tools[0]!.annotations = { readOnlyHint: false };
    const v = evaluate(diffCatalogs(base, after), { ignoreDescriptions: true });
    expect(v.drift).toBe(true);
    expect(v.reasons).toEqual(['tool became less safe: get_doc (read-only -> destructive)', 'tool changed: get_doc (/annotations/readOnlyHint)']);
    expect(v.waived).toEqual(['tool description changed: get_doc (/description)']);
  });
});
