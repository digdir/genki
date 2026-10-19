import { describe, expect, it } from 'vitest';
import { textPart, type Part } from '@genai/contracts';
import { SOURCES_MIME, traceOutput } from './output.js';

const report = {
  chunkId: 'c1',
  title: 'Årsrapport Helsedirektoratet 2023',
  headers: [
    'Årsrapport Helsedirektoratet 2023',
    'Redegjørelse om likestilling og ivaretakelse av aktivitetsplikt',
    'Arbeid med likelønn',
  ],
  url: 'https://kudos.dfo.no/dokument/d1',
  document: 'd1',
  position: 4,
  publishedAt: '2024-04-15',
  text: 'I 2023 var det 425 kvinner i faste stillinger og 39 i midlertidige stillinger.',
};
const sameReport = { ...report, chunkId: 'c2', position: 1, text: 'Innledning til kapittelet.' };
const other = {
  chunkId: 'c3',
  title: '# Tildelingsbrev 2024',
  document: 'd2',
  url: 'chunk:c3',
  text: 'Et annet dokument.',
};

const sources = (list: unknown[]): Part => ({
  mime: SOURCES_MIME,
  body: { kind: 'json', json: { sources: list, executionMetadata: { react: 12 } } },
});

describe('trace output', () => {
  it('lists the cited sources as the workspace shows them, in citation order', () => {
    const answer = {
      ...textPart('Totalt 464 kvinner [2], se også innledningen [1].'),
      meta: {
        citations: [
          { index: 2, chunkId: 'c1' },
          { index: 1, chunkId: 'c2' },
        ],
      },
    };

    const output = traceOutput([answer, sources([report, sameReport, other])]);

    expect(output).toEqual({
      answer: 'Totalt 464 kvinner [2], se også innledningen [1].',
      citations: [
        {
          index: 1,
          title: 'Årsrapport Helsedirektoratet 2023',
          breadcrumb:
            'Årsrapport Helsedirektoratet 2023 › Redegjørelse om likestilling og ivaretakelse av aktivitetsplikt › Arbeid med likelønn',
          url: 'https://kudos.dfo.no/dokument/d1',
          document_id: 'd1',
          published_at: '2024-04-15',
          chunk_id: 'c2',
          excerpt: 'Innledning til kapittelet.',
        },
        {
          index: 2,
          title: 'Årsrapport Helsedirektoratet 2023',
          breadcrumb:
            'Årsrapport Helsedirektoratet 2023 › Redegjørelse om likestilling og ivaretakelse av aktivitetsplikt › Arbeid med likelønn',
          url: 'https://kudos.dfo.no/dokument/d1',
          document_id: 'd1',
          published_at: '2024-04-15',
          chunk_id: 'c1',
          excerpt: 'I 2023 var det 425 kvinner i faste stillinger og 39 i midlertidige stillinger.',
        },
      ],
    });
  });

  it('lists up to ten retrieved documents, one per document, when nothing is cited', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      chunkId: `x${i}`,
      document: `doc${i}`,
      title: `Dokument ${i}`,
      text: `Tekst ${i}`,
    }));

    const output = traceOutput([
      { ...textPart('Jeg fant ingen tall for dette.'), meta: { citations: [] } },
      sources([report, sameReport, other, ...many]),
    ]);

    expect(output.citations).toEqual([]);
    expect(output.retrieved?.map((s) => s.chunk_id)).toEqual([
      'c1',
      'c3',
      ...many.slice(0, 8).map((m) => m.chunkId),
    ]);
    expect(output.retrieved?.[1]).toEqual({
      title: 'Tildelingsbrev 2024',
      document_id: 'd2',
      chunk_id: 'c3',
      excerpt: 'Et annet dokument.',
    });
    expect(output.retrieved?.[0]?.index).toBeUndefined();
  });

  it('marks an empty answer as no answer and keeps structured fields', () => {
    expect(traceOutput([textPart('   '), sources([])])).toEqual({
      answer: '   ',
      citations: [],
      no_answer: true,
    });
    expect(
      traceOutput([{ mime: 'application/json', body: { kind: 'json', json: { antall: 464 } } }]),
    ).toEqual({ answer: '', citations: [], fields: { antall: 464 } });
    expect(
      traceOutput([{ ...textPart('Jeg kan ikke svare på det.'), meta: { noAnswer: true } }]),
    ).toMatchObject({ no_answer: true });
  });
});
