import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryBlobStore } from '@genai/port-blob';
import { describe, expect, it } from 'vitest';
import { documentId } from './ids.js';
import { PageGone, type ListedDocument, type Listing } from './document-records.js';
import {
  knowledgeListingOf,
  pipelineSpec,
  type IngestSourceOptions,
  type PipelineSpec,
} from './pipeline-sources.js';

const signal = new AbortController().signal;
const scope = { tenant: '991825827', dataset: '991825827/docs', owner: '991825827' };

const spec = (source: Record<string, unknown>) => pipelineSpec.parse({ name: 'Docs', source });

const first = (docs: (ListedDocument | undefined)[]) => {
  const [doc] = docs;
  if (!doc) throw new Error('nothing was listed');
  return doc;
};

const all = async (listing: Listing) => {
  const out: ListedDocument[] = [];
  for await (const doc of listing.documents()) out.push(doc);
  return out;
};

const site = (pages: Record<string, string>, fetched: string[]) => ({
  resolve: async () => ['93.184.216.34'],
  fetch: (async (url: string | URL | Request) => {
    fetched.push(String(url));
    const body = pages[String(url)];
    return body === undefined ? new Response('', { status: 404 }) : new Response(body);
  }) as typeof fetch,
});

const sitemap = (entries: { loc: string; lastmod?: string }[]) =>
  `<urlset>${entries
    .map(
      (e) => `<url><loc>${e.loc}</loc>${e.lastmod ? `<lastmod>${e.lastmod}</lastmod>` : ''}</url>`,
    )
    .join('')}</urlset>`;

describe('knowledge listings', () => {
  it('a website page whose lastmod has not moved is not fetched', async () => {
    const fetched: string[] = [];
    const pages = {
      'https://www.example.no/sitemap.xml': sitemap([
        { loc: 'https://www.example.no/a.md', lastmod: '2026-10-30' },
        { loc: 'https://www.example.no/b.md' },
      ]),
      'https://www.example.no/a.md': '# A\n\nSide a.',
      'https://www.example.no/b.md': '# B\n\nSide b.',
    };
    const listing = await knowledgeListingOf(
      spec({ kind: 'website', sitemap: 'https://www.example.no/sitemap.xml' }),
      { web: site(pages, fetched) },
      scope,
      signal,
    );
    const docs = await all(listing);
    expect(listing.deletes).toBe('crawled');
    expect(listing.complete()).toBe(true);
    expect(fetched).toEqual(['https://www.example.no/sitemap.xml', 'https://www.example.no/b.md']);
    expect(docs.map((d) => d.files)).toEqual([
      [],
      [{ name: 'https://www.example.no/b.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) }],
    ]);
    expect(docs[0]?.metadata).toEqual({
      loc: 'https://www.example.no/a.md',
      lastmod: '2026-10-30',
    });
    const loaded = await listing.load(first(docs).record);
    expect(loaded.texts.join('')).toContain('Side a.');
  });

  it('a page that answers 404 when its index job loads it is gone', async () => {
    const pages = {
      'https://www.example.no/sitemap.xml': sitemap([
        { loc: 'https://www.example.no/borte.md', lastmod: '2026-10-30' },
      ]),
    };
    const listing = await knowledgeListingOf(
      spec({ kind: 'website', sitemap: 'https://www.example.no/sitemap.xml' }),
      { web: site(pages, []) },
      scope,
      signal,
    );
    const [doc] = await all(listing);
    await expect(listing.load(first([doc]).record)).rejects.toBeInstanceOf(PageGone);
  });

  it("the worker's fetches go through the fetch guard, and a source that needs a tenant secret is refused", async () => {
    const fetched: string[] = [];
    const internal = await knowledgeListingOf(
      spec({ kind: 'website', sitemap: 'https://intern.example.no/sitemap.xml' }),
      { web: { ...site({}, fetched), resolve: async () => ['10.0.0.5'] } },
      scope,
      signal,
    );
    await expect(all(internal)).rejects.toThrow();
    expect(internal.complete()).toBe(false);
    expect(fetched).toEqual([]);
    await expect(
      knowledgeListingOf(
        { ...spec({ kind: 'upload' }), source: { kind: 'database' } } as unknown as PipelineSpec,
        {},
        scope,
        signal,
      ),
    ).rejects.toThrow(
      'a source of kind database cannot fill a dataset on the knowledge database yet',
    );
  });

  it('a Kudos listing that starts after its first page is incomplete', async () => {
    const pages: string[] = [];
    const kudos = {
      sleep: async () => undefined,
      fetch: (async (url: string | URL | Request) => {
        const page = Number(new URL(String(url)).searchParams.get('page') ?? '1');
        pages.push(String(page));
        return new Response(
          JSON.stringify({
            data: [{ id: page, uuid: `u-${page}`, type: 'Årsrapport', title: `Rapport ${page}` }],
            meta: { current_page: page, last_page: 4 },
          }),
        );
      }) as typeof fetch,
    };
    const converter = { toMarkdown: async () => 'tekst' };
    const fromThree = await knowledgeListingOf(
      spec({ kind: 'kudos', types: ['Årsrapport'], startingPage: 3 }),
      { kudos, converter },
      scope,
      signal,
    );
    expect(await all(fromThree)).toHaveLength(2);
    expect(fromThree.complete()).toBe(false);
    const whole = await knowledgeListingOf(
      spec({ kind: 'kudos', types: ['Årsrapport'] }),
      { kudos, converter },
      scope,
      signal,
    );
    expect(await all(whole)).toHaveLength(4);
    expect(whole.complete()).toBe(true);
  });

  it('a folder listing hashes each file and loads one document from its record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'listing-'));
    await mkdir(join(root, 'docs'));
    await writeFile(join(root, 'docs', 'a.md'), '# A\n\nInnhold a.');
    const listing = await knowledgeListingOf(
      spec({ kind: 'folder', path: 'docs' }),
      { folderRoot: root },
      scope,
      signal,
    );
    const docs = await all(listing);
    expect(listing.deletes).toBe('listed');
    expect(listing.complete()).toBe(true);
    expect(docs).toHaveLength(1);
    expect(docs[0]?.files).toEqual([
      { name: 'a.md', sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
    expect((await listing.load(first(docs).record)).texts.join('')).toContain('Innhold a.');
  });

  it("a folder document's id is folder: with its owner and a hash of its path from the folder root", async () => {
    const root = await mkdtemp(join(tmpdir(), 'listing-'));
    await mkdir(join(root, 'docs', 'adr'), { recursive: true });
    await writeFile(join(root, 'docs', 'adr', '0042.md'), '# ADR\n\nInnhold.');
    const platform = await knowledgeListingOf(
      spec({ kind: 'folder', path: '.' }),
      { folderRoot: root },
      { tenant: '991825827', dataset: 'digdir/genki-docs', owner: 'platform' },
      signal,
    );
    const [doc] = await all(platform);
    expect(doc?.id).toBe(`folder:platform/${documentId('docs/adr/0042.md')}`);
    const loaded = await platform.load(first([doc]).record);
    expect(loaded.key).toBe(doc?.id);
    expect(loaded.docNum).toBe(doc?.id);

    const tenant = await knowledgeListingOf(
      spec({ kind: 'folder', path: 'docs' }),
      { folderRoot: root },
      scope,
      signal,
    );
    expect((await all(tenant)).map((d) => d.id)).toEqual([
      `folder:991825827/${documentId('docs/adr/0042.md')}`,
    ]);
  });

  it("a folder document's id names no path", async () => {
    const root = await mkdtemp(join(tmpdir(), 'listing-'));
    await mkdir(join(root, 'handbok'));
    await writeFile(join(root, 'handbok', 'permisjon-ola-nordmann.md'), '# Permisjon\n\nInnhold.');
    const [doc] = await all(
      await knowledgeListingOf(
        spec({ kind: 'folder', path: 'handbok' }),
        { folderRoot: root },
        scope,
        signal,
      ),
    );
    expect(doc?.id).toMatch(/^folder:991825827\/[0-9a-f]+$/);
    expect(doc?.id).not.toContain('ola');
  });

  it('two folder pipelines over one file give it the same id', async () => {
    const root = await mkdtemp(join(tmpdir(), 'listing-'));
    await mkdir(join(root, 'docs', 'adr'), { recursive: true });
    await writeFile(join(root, 'docs', 'adr', '0042.md'), '# ADR\n\nInnhold.');
    const idsOf = async (path: string) =>
      (
        await all(
          await knowledgeListingOf(
            spec({ kind: 'folder', path }),
            { folderRoot: root },
            scope,
            signal,
          ),
        )
      ).map((d) => d.id);
    expect(await idsOf('.')).toEqual(await idsOf('docs/adr'));
  });

  it('a folder document keeps its id when the folder root moves', async () => {
    const ids = async () => {
      const root = await mkdtemp(join(tmpdir(), 'listing-'));
      await mkdir(join(root, 'docs'));
      await writeFile(join(root, 'docs', 'a.md'), '# A\n\nInnhold a.');
      const listing = await knowledgeListingOf(
        spec({ kind: 'folder', path: 'docs' }),
        { folderRoot: root },
        scope,
        signal,
      );
      const doc = first(await all(listing));
      const loaded = await listing.load(doc.record);
      const { id, doc_num, path } = loaded.stored?.([]) ?? {};
      return { id: doc.id, docNum: loaded.docNum, stored: { id, doc_num, path } };
    };
    const [laptop, test] = [await ids(), await ids()];
    expect(laptop.id).toBe(test.id);
    expect(laptop.docNum).toBe(test.docNum);
    expect(laptop.stored).toEqual(test.stored);
  });

  it('an upload listing gives the blob store hash without reading the file', async () => {
    const blobs = new InMemoryBlobStore();
    await blobs.put(
      { tenant: scope.tenant, path: 'datasets/docs/uploads/notat.md' },
      new TextEncoder().encode('# Notat\n\nOpplastet.'),
      'text/markdown',
    );
    const reads: string[] = [];
    const uploads: IngestSourceOptions['uploads'] = {
      list: (tenant, prefix) => blobs.list(tenant, prefix),
      get: async (info) => {
        reads.push(info.path);
        return blobs.get(info);
      },
    };
    const listing = await knowledgeListingOf(spec({ kind: 'upload' }), { uploads }, scope, signal);
    const docs = await all(listing);
    expect(listing.deletes).toBe('explicit');
    expect(reads).toEqual([]);
    expect(docs[0]?.files).toEqual([{ name: 'notat.md', sha256: expect.any(String) }]);
    expect((await listing.load(first(docs).record)).texts.join('')).toContain('Opplastet.');
  });
});
