import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  fetchKudosFile,
  FileUnreachable,
  HttpStatusError,
  kudosProd,
  kudosSource,
  runIngest,
  type DocumentConverter,
  type IndexSink,
  type KudosFile,
  onePage,
} from './index.js';

const pdf = new TextEncoder().encode('%PDF-1.7 innhold');
const sha = createHash('sha256').update(pdf).digest('hex');
const html = (body: string) => new TextEncoder().encode(`<html><head>${body}</head></html>`);

const server =
  (pages: Record<string, Uint8Array | number>, seen: string[] = []) =>
  async (url: string) => {
    seen.push(url);
    const page = pages[url];
    if (page === undefined || typeof page === 'number')
      throw new HttpStatusError(page ?? 404, `HTTP ${page ?? 404} for ${url}`);
    return page;
  };

const file = (extra: Partial<KudosFile> = {}): KudosFile => ({
  url: 'https://kudos.dfo.no/files/abc',
  sha256: sha,
  size: pdf.length,
  ...extra,
});

describe('Kudos file fetch', () => {
  it('hops from a landing page to its citation_pdf_url and verifies the bytes against the listed sha256', async () => {
    const seen: string[] = [];
    const get = server(
      {
        'https://kudos.dfo.no/files/abc': html(
          '<meta name="citation_pdf_url" content="https://kudos.dfo.no/pdf/abc.pdf">',
        ),
        'https://kudos.dfo.no/pdf/abc.pdf': pdf,
      },
      seen,
    );

    expect(await fetchKudosFile(file(), get)).toEqual(pdf);
    expect(seen).toEqual(['https://kudos.dfo.no/files/abc', 'https://kudos.dfo.no/pdf/abc.pdf']);
  });

  it('treats a 404, a 410 or a landing page without citation_pdf_url as an unreachable file', async () => {
    for (const answer of [404, 410, html('<title>Dokument</title>')]) {
      const get = server({ 'https://kudos.dfo.no/files/abc': answer });
      await expect(fetchKudosFile(file(), get)).rejects.toBeInstanceOf(FileUnreachable);
    }
  });

  it('keeps a server error retryable, not unreachable', async () => {
    const get = server({ 'https://kudos.dfo.no/files/abc': 503 });
    const error = await fetchKudosFile(file(), get).catch((e: unknown) => e);
    expect(error).not.toBeInstanceOf(FileUnreachable);
  });

  it('refuses bytes whose sha256 or size differs from the Kudos listing, or that have no sha256', async () => {
    const get = server({ 'https://kudos.dfo.no/files/abc': pdf });
    await expect(fetchKudosFile(file({ sha256: 'f'.repeat(64) }), get)).rejects.toThrow(/sha256/);
    await expect(fetchKudosFile(file({ size: 3 }), get)).rejects.toThrow(/bytes/);
    const unsigned = file();
    delete unsigned.sha256;
    await expect(fetchKudosFile(unsigned, get)).rejects.toThrow(/unverified/);
  });
});

describe('Kudos source', () => {
  const converter: DocumentConverter = {
    convert: async () => onePage('# Tildelingsbrev\n\nMål og styringsparametere for året.'),
  };
  const sink = (): IndexSink & { stored: string[] } => {
    const stored: string[] = [];
    return {
      stored,
      ensureCollections: async () => undefined,
      storeDocument: async (_n, docNum) => void stored.push(docNum),
    };
  };
  const run = (fetchFile: (f: KudosFile) => Promise<Uint8Array>, s: IndexSink) =>
    runIngest({
      source: kudosSource({
        documents: [1, 2, 3].map((id) => ({
          id,
          title: `Dokument ${id}`,
          files: [file({ url: `https://kudos.dfo.no/files/${id}` })],
        })),
        fetchFile,
        converter,
        profile: kudosProd,
      }),
      chunking: {
        strategy: { kind: 'header-based' },
        minimumLength: 10,
        maximumLength: 4000,
        metadataStyle: 'pr',
      },
      collections: { docs: 'd', chunks: 'c', phrases: 'p' },
      sink: s,
      done: new Set(),
    });

  it('skips a document whose file is unreachable and reports why, without spending the failure budget', async () => {
    const s = sink();
    const result = await run(async (f) => {
      if (f.url?.endsWith('/2')) throw new FileUnreachable('gone');
      return pdf;
    }, s);

    expect(result).toMatchObject({ stored: 2, failed: [] });
    expect(result.skippedDocuments).toEqual([{ document: 'Dokument 2', reason: 'unreachable' }]);
    expect(s.stored).toEqual(['1', '3']);
  });

  it('counts a document whose file fetch fails for another reason as a failed document', async () => {
    const result = await run(async (f) => {
      if (f.url?.endsWith('/3')) throw new Error('timeout');
      return pdf;
    }, sink());

    expect(result).toMatchObject({ stored: 2, failed: ['3'] });
  });
});

describe('Kudos files with no url', () => {
  // KUDOS lists some files with only a `source_file_url` on another site (issue 581).
  const noUrl: KudosFile = {
    uuid: 'f0',
    url: null,
    sha256: null,
    size: null,
    filename: null,
    source_file_url: 'https://www.norad.no/rapport.pdf',
  };
  const converter: DocumentConverter = {
    convert: async () => onePage('# Evaluering\n\nFunn og anbefalinger fra evalueringen.'),
  };
  const run = (files: KudosFile[], asked: unknown[]) => {
    const stored: string[] = [];
    return runIngest({
      source: kudosSource({
        documents: [{ id: 1, title: 'Dokument 1', files }],
        // As guardedFetchBytes does with a missing url.
        fetchFile: async (f) => {
          asked.push(f.url);
          if (typeof f.url !== 'string') throw new Error(`Invalid website fetch URL: ${f.url}`);
          return pdf;
        },
        converter,
        profile: kudosProd,
      }),
      chunking: {
        strategy: { kind: 'header-based' },
        minimumLength: 10,
        maximumLength: 4000,
        metadataStyle: 'pr',
      },
      collections: { docs: 'd', chunks: 'c', phrases: 'p' },
      sink: {
        ensureCollections: async () => undefined,
        storeDocument: async (_n, docNum) => void stored.push(docNum),
      },
      done: new Set(),
    }).then((result) => ({ result, stored }));
  };

  it('a Kudos file with no url is left out and the document is read from its other files', async () => {
    const asked: unknown[] = [];
    const { result, stored } = await run([noUrl, file()], asked);

    expect(asked).toEqual(['https://kudos.dfo.no/files/abc']);
    expect(result).toMatchObject({ stored: 1, failed: [] });
    expect(stored).toEqual(['1']);
  });

  it('a Kudos document whose files all lack a url is skipped as unreachable, not failed', async () => {
    const asked: unknown[] = [];
    const { result, stored } = await run([noUrl, { ...noUrl, uuid: 'f1' }], asked);

    expect(asked).toEqual([]);
    expect(result).toMatchObject({ stored: 0, failed: [] });
    expect(result.skippedDocuments).toEqual([{ document: 'Dokument 1', reason: 'unreachable' }]);
    expect(stored).toEqual([]);
  });
});
