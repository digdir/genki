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

const byPage: ChunkDocumentConfig = {
  strategy: { kind: 'page', splitMaxLength: 80 },
  minimumLength: 1,
  maximumLength: 4000,
  metadataStyle: 'pr',
};

/** A document as an index job prepares it: chunked from its joined pages, then placed. */
const prepared = (
  id: string,
  files: { name: string; sha256: string; pages: string[] }[],
  config: ChunkDocumentConfig = chunking,
) => {
  const texts = files.map((f) => joinPages(f.pages));
  const chunks = chunkDocument(id, texts, config);
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

  it('a running header on every page does not move a chunk to an earlier page', () => {
    const header = 'Årsrapport 2025 Digdir';
    const doc = prepared('kudos:topptekst', [
      {
        name: 'rapport.pdf',
        sha256: sha('c'),
        pages: [
          `${header}\n\n# Innledning\n\nDette er side én om året som gikk.`,
          `${header}\n\nSide to fortsetter innledningen med mer tekst.`,
          `${header}\n\nSide tre avslutter innledningen.`,
          `${header}\n\n# Vedlegg\n\nTabeller og tall på side fire.`,
        ],
      },
    ]);
    const byHeading = Object.fromEntries(doc.chunks.map((c) => [c.headingPath?.join(' / '), c]));

    expect(byHeading.Innledning).toMatchObject({ pageFrom: 1, pageTo: 4 });
    expect(byHeading.Vedlegg).toMatchObject({ pageFrom: 4, pageTo: 4 });
  });

  it('chunk ids outside the knowledge database stay as they were', () => {
    const text = '# Mål\n\nDirektoratet skal digitalisere offentlig sektor.';
    const [chunk] = chunkDocument('4711', [text], chunking);

    expect(chunk?.chunk_id).toBe(chunkId('4711', 0, chunk?.content_markdown ?? ''));
  });

  it('every chunk carries its document, file and page, for a document with an attachment and a page split in two', () => {
    const long =
      'Første del av en lang side om tildelingen for året. ' +
      'Andre del av den samme siden, om midlene til fellesløsninger.';
    const doc = prepared(
      'kudos:4f1c',
      [
        {
          name: 'tildelingsbrev.pdf',
          sha256: sha('c'),
          pages: ['# Tildeling\n\nKort side.', long],
        },
        { name: 'vedlegg.pdf', sha256: sha('d'), pages: ['Vedlegg om rapportering.'] },
      ],
      byPage,
    );

    expect(
      doc.chunks.map((c) => ({ file: c.file, sha: c.fileSha256, from: c.pageFrom, to: c.pageTo })),
    ).toEqual([
      { file: 'tildelingsbrev.pdf', sha: sha('c'), from: 1, to: 1 },
      { file: 'tildelingsbrev.pdf', sha: sha('c'), from: 2, to: 2 },
      { file: 'tildelingsbrev.pdf', sha: sha('c'), from: 2, to: 2 },
      { file: 'vedlegg.pdf', sha: sha('d'), from: 1, to: 1 },
    ]);
    expect(doc.id).toBe('kudos:4f1c');
    expect(new Set(doc.chunks.map((c) => c.id)).size).toBe(4);
  });
});
