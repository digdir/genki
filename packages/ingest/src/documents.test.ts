import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { InMemoryBlobStore } from '@genai/port-blob';
import { memoryEngine, openTarget } from '@genai/port-knowledge/testing';
import {
  NoTextLayerError,
  convertibleExtensions,
  folderSource,
  htmlToMarkdown,
  kudosSource,
  htmlToPage,
  runIndexIngest,
  runIngest,
  skipReasonFor,
  uploadDocumentId,
  uploadSource,
  websiteSkipReasonFor,
  websiteSource,
  type DocumentConverter,
  type IndexSink,
  type IngestSource,
} from './index.js';

const encoder = new TextEncoder();
const digdirPage = () => readFile(join(import.meta.dirname, 'fixtures', 'digdir-page.txt'));

const chunking = {
  strategy: { kind: 'header-based' as const },
  minimumLength: 1,
  maximumLength: 4000,
  metadataStyle: 'pr' as const,
};

const collections = { docs: 'd', chunks: 'c', phrases: 'p' };

const recordingSink = () => {
  const docs: Record<string, unknown>[] = [];
  const chunks: string[] = [];
  const sink: IndexSink = {
    ensureCollections: async () => {},
    storeDocument: async (_names, _docNum, doc, stored) => {
      docs.push(doc);
      chunks.push(...stored.map((c) => String(c.content_markdown)));
    },
  };
  return { sink, docs, chunks };
};

const ingest = async (source: IngestSource) => {
  const recorded = recordingSink();
  const result = await runIngest({ source, chunking, collections, sink: recorded.sink });
  return { ...recorded, result };
};

const fakeConverter = (
  failures: Record<string, Error> = {},
): DocumentConverter & {
  seen: string[];
} => {
  const seen: string[] = [];
  return {
    seen,
    extensions: ['.pdf', '.docx'],
    toMarkdown: async (file) => {
      seen.push(file.name);
      const failure = Object.entries(failures).find(([name]) => file.name.endsWith(name));
      if (failure) throw failure[1];
      return `# ${file.name}\n\n${new TextDecoder().decode(file.bytes)}`;
    },
  };
};

const boilerplate = [
  'informasjonskapsler',
  'Godta alle',
  'Hopp til hovedinnhold',
  'Hovedmeny',
  'Tjenester og verktøy',
  'Forsiden',
  'Del siden',
  'Facebook',
  'Relatert innhold',
  'postboks',
  'Personvernerklæring',
  'dataLayer',
];

describe('web content', () => {
  it('keeps only the main article, collapses whitespace and titles the page from its heading', async () => {
    const page = htmlToPage((await digdirPage()).toString('utf8'));

    expect(page.title).toBe('Tildelingsbrev og årsrapporter');
    expect(page.markdown).toBe(
      [
        '# Tildelingsbrev og årsrapporter',
        '',
        'Her finner du tildelingsbrev og årsrapporter for Digitaliseringsdirektoratet.',
        '',
        '## Tildelingsbrev 2025',
        '',
        'Departementet stiller midler til disposisjon for direktoratet. Brevet beskriver mål og styringsparametere.',
      ].join('\n'),
    );
  });

  it('falls back to the title tag, and to the body when the page has no main element', () => {
    const page = htmlToPage(
      '<html><head><title>Om oss</title></head><body><nav>Meny</nav><header>Logo</header><p>Vi er   et direktorat.</p><footer>Kontakt</footer></body></html>',
    );

    expect(page).toEqual({ title: 'Om oss', markdown: 'Vi er et direktorat.' });
  });

  it('takes the main region from role=main and drops hidden and consent elements inside it', () => {
    expect(
      htmlToMarkdown(
        '<div role="main"><div data-x="1" class="consent-dialog"><p>Samtykke</p></div><p hidden>Skjult</p><p>Innhold</p></div><p>Utenfor</p>',
      ),
    ).toBe('Innhold');
  });

  it('a website source yields the article text only and the page title instead of the URL tail', async () => {
    const html = await digdirPage();
    const { docs, chunks, result } = await ingest(
      websiteSource({
        entries: [{ loc: 'https://www.digdir.no/om-oss/7432' }],
        baseUrl: 'https://www.digdir.no/',
        fetchBody: async () => ({
          bytes: new Uint8Array(html),
          contentType: 'text/html; charset=utf-8',
        }),
      }),
    );

    expect(result.stored).toBe(1);
    expect(docs[0]).toMatchObject({ title: 'Tildelingsbrev og årsrapporter', url: 'om-oss/7432' });
    const text = chunks.join('\n');
    expect(text).toContain('Departementet stiller midler til disposisjon');
    for (const phrase of boilerplate) expect(text).not.toContain(phrase);
    expect(text).not.toMatch(/ {2}|\n{3}/);
  });

  it('a page title returned by fetchMarkdown also replaces the URL tail', async () => {
    const { docs } = await ingest(
      websiteSource({
        entries: [{ loc: 'https://www.digdir.no/7432' }],
        fetchMarkdown: async () => ({ markdown: '# Hei\n\nTekst.', title: 'Hei' }),
      }),
    );

    expect(docs[0]).toMatchObject({ title: 'Hei' });
  });

  it('a Markdown page is titled from its frontmatter, not from the URL', async () => {
    const markdown = '---\ntitle: "Gi abonnenter tilgang"\n---\n\nTekst om tilgang.\n';
    const { docs } = await ingest(
      websiteSource({
        entries: [{ loc: 'https://docs.example.test/nb/grant-subscriber-access/index.md' }],
        fetchBody: async () => ({
          bytes: new TextEncoder().encode(markdown),
          contentType: 'text/markdown; charset=utf-8',
        }),
      }),
    );

    expect(docs[0]).toMatchObject({
      title: 'Gi abonnenter tilgang',
      frontmatter_title: 'Gi abonnenter tilgang',
    });
  });
});

describe('documents through a converter', () => {
  it('only text types are readable without a converter', () => {
    expect(convertibleExtensions()).toEqual([]);
    expect(skipReasonFor('/a/rapport.pdf')).toBe('unsupported_type');
    expect(skipReasonFor('/a/side.HTML')).toBeUndefined();
    expect(websiteSkipReasonFor('https://www.digdir.no/rapport.pdf')).toBe('unsupported_type');
    expect(websiteSkipReasonFor('https://www.digdir.no/om-oss')).toBeUndefined();
  });

  it('a converter makes PDF and DOCX readable, and other binaries stay skipped', () => {
    const converter = fakeConverter();

    expect(convertibleExtensions(converter)).toEqual(['.pdf', '.docx']);
    expect(skipReasonFor('/a/rapport.pdf', converter)).toBeUndefined();
    expect(skipReasonFor('/a/brev.docx', converter)).toBeUndefined();
    expect(skipReasonFor('/a/budsjett.xlsx', converter)).toBe('unsupported_type');
    expect(websiteSkipReasonFor('https://www.digdir.no/rapport.pdf', converter)).toBeUndefined();
    expect(websiteSkipReasonFor('https://www.digdir.no/budsjett.xlsx', converter)).toBe(
      'unsupported_type',
    );
  });

  it('the folder source converts PDF and DOCX and turns conversion failures into skips', async () => {
    const files: Record<string, string> = {
      '/docs/rapport.pdf': 'Årsrapport for 2025.',
      '/docs/brev.docx': 'Tildelingsbrev for 2025.',
      '/docs/skannet.pdf': '',
      '/docs/ødelagt.pdf': '',
      '/docs/notat.md': '# Notat\n\nEt notat.',
      '/docs/budsjett.xlsx': '',
    };
    const converter = fakeConverter({
      'skannet.pdf': new NoTextLayerError('skannet.pdf'),
      'ødelagt.pdf': new Error('bad xref'),
    });
    const read: string[] = [];
    const { chunks, result } = await ingest(
      folderSource({
        entries: Object.keys(files).map((path) => ({ path, lastmod: '1' })),
        basePath: '/docs/',
        converter,
        readBytes: async (path) => {
          read.push(path);
          return encoder.encode(files[path] ?? '');
        },
      }),
    );

    expect(result.stored).toBe(3);
    expect(result.skippedDocuments).toEqual([
      { document: 'skannet.pdf', reason: 'no_text' },
      { document: 'ødelagt.pdf', reason: 'conversion_failed' },
      { document: 'budsjett.xlsx', reason: 'unsupported_type' },
    ]);
    expect(chunks.join('\n')).toContain('Årsrapport for 2025.');
    expect(chunks.join('\n')).toContain('Tildelingsbrev for 2025.');
    expect(read).not.toContain('/docs/budsjett.xlsx');
  });

  it('the folder source keeps skipping PDF and DOCX without a converter', async () => {
    const { result } = await ingest(
      folderSource({
        entries: [
          { path: '/docs/rapport.pdf', lastmod: '1' },
          { path: '/docs/brev.docx', lastmod: '1' },
        ],
        basePath: '/docs/',
        readBytes: async () => encoder.encode('x'),
      }),
    );

    expect(result.stored).toBe(0);
    expect(result.skippedDocuments).toEqual([
      { document: 'rapport.pdf', reason: 'unsupported_type' },
      { document: 'brev.docx', reason: 'unsupported_type' },
    ]);
  });

  it('the website source converts a linked PDF only when given a converter', async () => {
    const options = {
      entries: [{ loc: 'https://www.digdir.no/dokumenter/arsrapport-2025.pdf' }],
      fetchBody: async () => ({
        bytes: encoder.encode('Årsrapporten viser resultater.'),
        contentType: 'application/pdf',
      }),
    };

    const without = await ingest(websiteSource(options));
    const converter = fakeConverter();
    const withConverter = await ingest(websiteSource({ ...options, converter }));

    expect(without.result.skippedDocuments).toEqual([
      {
        document: 'https://www.digdir.no/dokumenter/arsrapport-2025.pdf',
        reason: 'unsupported_type',
      },
    ]);
    expect(withConverter.result.stored).toBe(1);
    expect(withConverter.chunks.join('\n')).toContain('Årsrapporten viser resultater.');
    expect(converter.seen).toEqual(['/dokumenter/arsrapport-2025.pdf']);
  });

  it('a scanned PDF on a website is skipped as no_text instead of failing the run', async () => {
    const { result } = await ingest(
      websiteSource({
        entries: [{ loc: 'https://www.digdir.no/skannet.pdf' }],
        converter: fakeConverter({ 'skannet.pdf': new NoTextLayerError('skannet.pdf') }),
        fetchBody: async () => ({ bytes: encoder.encode('%PDF'), contentType: 'application/pdf' }),
      }),
    );

    expect(result).toMatchObject({ stored: 0, failed: [] });
    expect(result.skippedDocuments).toEqual([
      { document: 'https://www.digdir.no/skannet.pdf', reason: 'no_text' },
    ]);
  });

  it('the website source passes a custom content extractor', async () => {
    const { chunks } = await ingest(
      websiteSource({
        entries: [{ loc: 'https://www.digdir.no/side' }],
        extract: () => '<p>Utdrag fra leseren</p>',
        fetchBody: async () => ({ bytes: encoder.encode('<p>Hele siden</p>') }),
      }),
    );

    expect(chunks).toEqual(['Utdrag fra leseren']);
  });
});

describe('upload source', () => {
  const tenant = '991825827';
  const prefix = 'datasets/veiledning/';
  const signal = new AbortController().signal;

  it('reads uploaded files, converts binaries and skips what it cannot read', async () => {
    const blobs = new InMemoryBlobStore(() => new Date('2026-10-08T10:00:00Z'));
    await blobs.put(
      { tenant, path: `${prefix}Tildelingsbrev_2025.pdf` },
      encoder.encode('Tildelingsbrevet gir rammer for 2025.'),
      'application/pdf',
    );
    await blobs.put(
      { tenant, path: `${prefix}skannet.pdf` },
      encoder.encode('%PDF'),
      'application/pdf',
    );
    await blobs.put(
      { tenant, path: `${prefix}notater/møte.md` },
      encoder.encode('# Møte\n\nReferat fra møtet.'),
      'text/markdown',
    );
    await blobs.put({ tenant, path: `${prefix}budsjett.xlsx` }, encoder.encode('x'), 'x/y');
    await blobs.put(
      { tenant, path: 'datasets/annet/fremmed.md' },
      encoder.encode('# Nei'),
      'text/markdown',
    );

    const { docs, chunks, result } = await ingest(
      uploadSource({
        blobs,
        tenant,
        prefix,
        converter: fakeConverter({ 'skannet.pdf': new NoTextLayerError('skannet.pdf') }),
      }),
    );

    expect(result.stored).toBe(2);
    expect(result.skippedDocuments).toEqual([
      { document: 'budsjett.xlsx', reason: 'unsupported_type' },
      { document: 'skannet.pdf', reason: 'no_text' },
    ]);
    expect(docs).toEqual([
      expect.objectContaining({
        id: uploadDocumentId(tenant, `${prefix}notater/møte.md`),
        title: 'møte',
        path: 'notater/møte.md',
        type: 'upload',
      }),
      expect.objectContaining({
        id: uploadDocumentId(tenant, `${prefix}Tildelingsbrev_2025.pdf`),
        title: 'Tildelingsbrev 2025',
        path: 'Tildelingsbrev_2025.pdf',
      }),
    ]);
    expect(chunks.join('\n')).not.toContain('Nei');
  });

  it('a re-upload updates the same document and a removed file is gone after the next run', async () => {
    const engine = memoryEngine({ vectors: false });
    const dataset = { id: 'veiledning', filters: {}, options: {} };
    const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
    const target = (generation: string) => ({
      engine: 'memory',
      needs: engine.writer.needs,
      dataset,
      writer,
      generation,
    });
    const search = () => openTarget({ adapter: engine.adapter }, { id: dataset.id, filters: {} });
    const blobs = new InMemoryBlobStore();
    const put = (name: string, text: string) =>
      blobs.put({ tenant, path: `${prefix}${name}` }, encoder.encode(text), 'text/markdown');
    const source = () => uploadSource({ blobs, tenant, prefix });

    await put('tilskudd.md', '# Tilskudd\n\nKommunen gir tilskudd til foreninger.');
    await put('frister.md', '# Frister\n\nSøknadsfristen er 1. mars.');
    await runIndexIngest({ source: source(), chunking, target: target('g1') });
    await put('tilskudd.md', '# Tilskudd\n\nTilskudd gis nå også til driftsstøtte.');
    await blobs.delete({ tenant, path: `${prefix}frister.md` });
    await runIndexIngest({ source: source(), chunking, target: target('g2') });

    const port = search();
    expect((await port.search({ query: 'Søknadsfristen', profile: 'content' })).hits).toEqual([]);
    expect((await port.search({ query: 'foreninger', profile: 'content' })).hits).toEqual([]);
    const fresh = await port.search({ query: 'driftsstøtte', profile: 'content' });
    expect(fresh.hits.map((h) => h.document)).toEqual([
      uploadDocumentId(tenant, `${prefix}tilskudd.md`),
    ]);
    expect(await writer.stats(dataset, 'g2')).toMatchObject({ documents: 1 });
  });
});

describe('the Kudos source', () => {
  it('skips a file that fails conversion and keeps the other files of the document', async () => {
    const converter = fakeConverter({
      'skannet.pdf': new NoTextLayerError('skannet.pdf'),
      'skadet.pdf': new Error('broken'),
    });
    const file = (name: string) => ({ url: `https://kudos.example/${name}` });
    const { result, chunks } = await ingest(
      kudosSource({
        documents: [
          { id: 1, title: 'Blandet', files: [file('skannet.pdf'), file('brev.pdf')] },
          { id: 2, title: 'Skannet', files: [file('skannet.pdf')] },
          { id: 3, title: 'Skadet', files: [file('skadet.pdf')] },
        ],
        fetchFile: async () => encoder.encode('Tildelingsbrev for 2025.'),
        converter,
      }),
    );

    expect(result).toMatchObject({ stored: 1, failed: [] });
    expect(result.skippedDocuments).toEqual([
      { document: 'Skannet', reason: 'no_text' },
      { document: 'Skadet', reason: 'conversion_failed' },
    ]);
    expect(chunks.join('\n')).toContain('Tildelingsbrev for 2025.');
  });

  it('keeps every document when Kudos identifies them by uuid only', async () => {
    const file = (name: string) => ({ url: `https://kudos.example/${name}` });
    const { result } = await ingest(
      kudosSource({
        documents: [
          { uuid: '40adee75', title: 'Tildelingsbrev 2025', files: [file('a.pdf')] },
          { uuid: '7c1b9f02', title: 'Tildelingsbrev 2024', files: [file('b.pdf')] },
        ],
        fetchFile: async () => encoder.encode('Tildelingsbrev med mål og styringsparametere.'),
        converter: fakeConverter({}),
      }),
    );

    expect(result).toMatchObject({ stored: 2, failed: [] });
  });
});
