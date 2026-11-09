/**
 * In-process integration: real SDK McpServer <-> InMemoryTransport <-> our
 * capture path. No child processes, no network.
 */

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { captureFromTransport } from '../src/capture.js';
import { diffCatalogs, evaluate } from '../src/diff.js';
import { buildSnapshot, parseSnapshot, serializeSnapshot } from '../src/snapshot.js';

interface DemoOptions {
  version?: string;
  getDescription?: string;
  extraTool?: boolean;
  slugDescription?: string;
  withPrompts?: boolean;
  withResources?: boolean;
}

function demoServer(o: DemoOptions = {}): McpServer {
  const server = new McpServer({ name: 'demo-server', version: o.version ?? '1.0.0', title: 'Demo' });
  server.registerTool(
    'zz_last',
    { description: 'Registered first, sorts last.', inputSchema: { n: z.number().int().min(0) } },
    async () => ({ content: [] }),
  );
  server.registerTool(
    'get_doc',
    {
      title: 'Get document',
      description: o.getDescription ?? 'Fetch a document by slug.',
      inputSchema: { slug: z.string().min(1).describe(o.slugDescription ?? 'Document slug.'), rev: z.number().int().optional() },
      outputSchema: { markdown: z.string() },
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async () => ({ content: [], structuredContent: { markdown: '' } }),
  );
  if (o.extraTool) {
    server.registerTool('extra', { description: 'Added later.' }, async () => ({ content: [] }));
  }
  if (o.withPrompts) {
    server.registerPrompt('summarize', { description: 'Summarize a doc.', argsSchema: { slug: z.string() } }, () => ({ messages: [] }));
    server.registerPrompt('a_first', { title: 'First' }, () => ({ messages: [] }));
  }
  if (o.withResources) {
    server.registerResource(
      'document',
      new ResourceTemplate('demo://docs/{slug}', { list: undefined }),
      { title: 'Documents', description: 'A doc.', mimeType: 'text/markdown' },
      async (uri) => ({ contents: [{ uri: uri.href, text: '' }] }),
    );
  }
  return server;
}

async function captureDemo(o: DemoOptions = {}) {
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const server = demoServer(o);
  await server.connect(serverT);
  try {
    return await captureFromTransport(clientT);
  } finally {
    await server.close();
  }
}

describe('capture over InMemoryTransport', () => {
  it('captures serverInfo, protocolVersion and the tool list', async () => {
    const raw = await captureDemo();
    expect(raw.server).toEqual({ name: 'demo-server', version: '1.0.0', title: 'Demo' });
    expect(raw.protocolVersion).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(raw.tools.map((t) => (t as { name: string }).name)).toEqual(['zz_last', 'get_doc']);
  });

  it('builds a snapshot with sorted tools and full schemas/annotations/title/description', async () => {
    const snap = buildSnapshot(await captureDemo());
    expect(snap.catalog.tools.map((t) => t.name)).toEqual(['get_doc', 'zz_last']);
    const get = snap.catalog.tools[0]!;
    expect(get.title).toBe('Get document');
    expect(get.description).toBe('Fetch a document by slug.');
    expect(get.annotations).toEqual({ idempotentHint: true, readOnlyHint: true });
    const input = get.inputSchema as { type: string; properties: Record<string, { description?: string }>; required?: string[] };
    expect(input.type).toBe('object');
    expect(input.properties['slug']!.description).toBe('Document slug.');
    expect(input.required).toEqual(['slug']);
    expect((get.outputSchema as { properties: object }).properties).toHaveProperty('markdown');
    expect(snap.protocolVersion).not.toBeNull();
  });

  it('records prompts and resource templates when the server advertises them, empty otherwise', async () => {
    const without = buildSnapshot(await captureDemo());
    expect(without.catalog.prompts).toEqual([]);
    expect(without.catalog.resourceTemplates).toEqual([]);

    const withBoth = buildSnapshot(await captureDemo({ withPrompts: true, withResources: true }));
    expect(withBoth.catalog.prompts.map((p) => p.name)).toEqual(['a_first', 'summarize']);
    expect(withBoth.catalog.prompts[1]!.arguments).toEqual([{ name: 'slug', required: true }]);
    expect(withBoth.catalog.resourceTemplates).toEqual([
      { description: 'A doc.', mimeType: 'text/markdown', name: 'document', title: 'Documents', uriTemplate: 'demo://docs/{slug}' },
    ]);
    expect(withBoth.sha256).not.toBe(without.sha256);
  });

  it('is byte-stable across two captures of the same server', async () => {
    const a = buildSnapshot(await captureDemo());
    const b = buildSnapshot(await captureDemo());
    expect(a.sha256).toBe(b.sha256);
    expect(serializeSnapshot(parseSnapshot(serializeSnapshot(a), 'a')).replace(/"capturedAt": "[^"]+"/, '')).toBe(
      serializeSnapshot(b).replace(/"capturedAt": "[^"]+"/, ''),
    );
  });

  it('a server version bump alone does not change the fingerprint', async () => {
    const a = buildSnapshot(await captureDemo({ version: '1.0.0' }));
    const b = buildSnapshot(await captureDemo({ version: '2.0.0' }));
    expect(a.server.version).toBe('1.0.0');
    expect(b.server.version).toBe('2.0.0');
    expect(a.sha256).toBe(b.sha256);
  });

  it('detects a mutated tool description as description-only drift', async () => {
    const before = buildSnapshot(await captureDemo());
    const after = buildSnapshot(await captureDemo({ getDescription: 'Fetch a document by slug. Now with extra words.' }));
    const d = diffCatalogs(before.catalog, after.catalog);
    expect(d.identical).toBe(false);
    const tools = d.sections[0]!;
    expect(tools.changed).toEqual([
      {
        key: 'get_doc',
        descriptionOnly: true,
        changes: [{ path: '/description', before: 'Fetch a document by slug.', after: 'Fetch a document by slug. Now with extra words.', descriptive: true }],
      },
    ]);
    expect(evaluate(d).drift).toBe(true);
    expect(evaluate(d, { ignoreDescriptions: true }).drift).toBe(false);
  });

  it('detects a nested property description change the same way', async () => {
    const before = buildSnapshot(await captureDemo());
    const after = buildSnapshot(await captureDemo({ slugDescription: 'The slug.' }));
    const tools = diffCatalogs(before.catalog, after.catalog).sections[0]!;
    expect(tools.changed[0]!.changes[0]!.path).toBe('/inputSchema/properties/slug/description');
    expect(tools.changed[0]!.descriptionOnly).toBe(true);
  });

  it('detects an added tool and honors allowAdditions', async () => {
    const before = buildSnapshot(await captureDemo());
    const after = buildSnapshot(await captureDemo({ extraTool: true }));
    const d = diffCatalogs(before.catalog, after.catalog);
    expect(d.sections[0]!.added).toEqual(['extra']);
    // registered without annotations: per the spec it may write, so allowAdditions alone does not waive it
    expect(evaluate(d).reasons).toEqual(['tool added (destructive, not read-only): extra']);
    expect(evaluate(d, { allowAdditions: true }).drift).toBe(true);
    expect(evaluate(d, { allowAdditions: true, allowWriteAdditions: true }).drift).toBe(false);
    // and the reverse direction is a removal, which nothing waives
    const r = diffCatalogs(after.catalog, before.catalog);
    expect(evaluate(r, { allowAdditions: true, ignoreDescriptions: true }).reasons).toEqual(['tool removed: extra']);
  });
});

describe('pagination', () => {
  async function pagedServer(pages: string[][], opts: { loop?: boolean } = {}) {
    const server = new Server({ name: 'paged', version: '0.0.1' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async (req) => {
      const idx = req.params?.cursor ? Number(req.params.cursor) : 0;
      const tools = (pages[idx] ?? []).map((name) => ({ name, inputSchema: { type: 'object' as const } }));
      const next = opts.loop ? String(idx) : idx + 1 < pages.length ? String(idx + 1) : undefined;
      return next === undefined ? { tools } : { tools, nextCursor: next };
    });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    try {
      return await captureFromTransport(clientT);
    } finally {
      await server.close();
    }
  }

  it('follows nextCursor until exhausted', async () => {
    const raw = await pagedServer([['c', 'a'], ['b'], ['d']]);
    expect(raw.tools.map((t) => (t as { name: string }).name)).toEqual(['c', 'a', 'b', 'd']);
    expect(buildSnapshot(raw).catalog.tools.map((t) => t.name)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('refuses a server whose cursor loops', async () => {
    await expect(pagedServer([['a']], { loop: true })).rejects.toThrow(/repeating pagination cursor/);
  });
});
