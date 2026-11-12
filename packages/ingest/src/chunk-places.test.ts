import { describe, expect, it } from 'vitest';
import { placeChunks } from './chunk-places.js';
import { chunkDocument, type ChunkDocumentConfig } from './chunk-document.js';
import { joinPages } from './converter.js';
import { chunkId } from './ids.js';
import { toIndexDocument } from './index-writer.js';

const chunking: ChunkDocumentConfig = {
  strategy: { kind: 'header-based', splitMaxLength: 400 },
  minimumLength: 10,
  maximumLength: 2000,
  metadataStyle: 'pr',
};

const sha = (c: string) => c.repeat(64);

/** A document as an index job prepares it: chunked from its joined pages, then placed. */
const prepared = (id: string, files: { name: string; sha256: string; pages: string[] }[]) => {
  const texts = files.map((f) => joinPages(f.pages));
  const chunks = chunkDocument(id, texts, chunking);
  const doc = toIndexDocument(
    id,
    { id, title: 'Årsrapport' },
    chunks.map((c) => ({ ...c })),
    [],
  );
  return placeChunks(doc, { texts, files });
};

describe('chunks in the knowledge database', () => {
  it('two documents with the same text get different chunk ids', () => {
    const pages = ['# Mål\n\nDirektoratet skal digitalisere offentlig sektor.'];
    const a = prepared('kudos:a', [{ name: 'a.pdf', sha256: sha('a'), pages }]);
    const b = prepared('kudos:b', [{ name: 'b.pdf', sha256: sha('a'), pages }]);

    expect(a.chunks[0]?.text).toBe(b.chunks[0]?.text);
    expect(a.chunks[0]?.id).not.toBe(b.chunks[0]?.id);
  });

  it('a chunk across a page break records the pages it spans', () => {
    const doc = prepared('kudos:rapport', [
      {
        name: 'rapport.pdf',
        sha256: sha('b'),
        pages: [
          '# Innledning\n\nDette er side én om året som gikk.',
          '# Budsjett 2025\n\nBudsjettet økte med ti prosent.',
          'Fortsatt om budsjettet: midlene gikk til fellesløsninger.\n\n# Vedlegg\n\nTabeller og tall.',
        ],
      },
    ]);
    const byHeading = Object.fromEntries(doc.chunks.map((c) => [c.headingPath?.join(' / '), c]));

    expect(byHeading.Innledning).toMatchObject({ pageFrom: 1, pageTo: 1 });
    expect(byHeading['Budsjett 2025']).toMatchObject({ pageFrom: 2, pageTo: 3 });
    expect(byHeading.Vedlegg).toMatchObject({ pageFrom: 3, pageTo: 3 });
    for (const chunk of doc.chunks)
      expect(chunk).toMatchObject({ file: 'rapport.pdf', fileSha256: sha('b') });
  });

  it('chunk ids outside the knowledge database stay as they were', () => {
    const text = '# Mål\n\nDirektoratet skal digitalisere offentlig sektor.';
    const [chunk] = chunkDocument('4711', [text], chunking);

    expect(chunk?.chunk_id).toBe(chunkId('4711', 0, chunk?.content_markdown ?? ''));
  });
});
