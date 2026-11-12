import { describe, expect, it } from 'vitest';
import { textPart, type Part } from '@genai/contracts';
import { defaultOutput, SOURCES_MIME, structuredContent } from './tools.js';

const sources: Part = {
  mime: SOURCES_MIME,
  body: {
    kind: 'json',
    json: {
      sources: [
        { chunkId: 'c1', document: 'd1', text: 'Første' },
        { chunkId: 'c2', document: 'd1', text: 'Andre' },
      ],
    },
  },
};

const answer = (meta: Record<string, unknown>): Part => ({
  ...textPart('Første [1] og andre [2].'),
  meta,
});

describe('citation markers in structuredContent', () => {
  it('lists every marker with the one excerpt and the document it leads to, when the answer cites excerpts', () => {
    const { structured } = defaultOutput([
      answer({
        citations: [
          { index: 1, chunkId: 'c1', document: 'd1' },
          { index: 2, chunkId: 'c2', document: 'd1' },
          { index: 3, chunkId: 'not-a-source', document: 'd9' },
        ],
        citeBy: 'excerpt',
      }),
      sources,
    ]);
    const out = structuredContent(structured, 'conv');

    expect(out.markers).toEqual([
      { marker: '1', chunk_id: 'c1', document: 'd1' },
      { marker: '2', chunk_id: 'c2', document: 'd1' },
    ]);
    expect(Object.keys(out).at(-1)).toBe('chunks');
  });

  it('adds no markers when the answer cites documents', () => {
    const { structured } = defaultOutput([
      answer({
        citations: [
          { index: 1, chunkId: 'c1' },
          { index: 2, chunkId: 'c2' },
        ],
      }),
      sources,
    ]);

    expect(structuredContent(structured, 'conv')).not.toHaveProperty('markers');
  });
});
