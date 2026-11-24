import { describe, expect, it } from 'vitest';
import type { Turn } from './api.js';
import { blockData, blockState, pickReads } from './block-data.js';

const turn = (id: string, question: string, sources = 1): Turn => ({
  id,
  question,
  askedAt: 0,
  answer: {
    text: `Svar på ${question}`,
    status: 'complete',
    created: Date.parse('2026-11-21T09:00:00Z'),
    sources: Array.from({ length: sources }, (_, i) => ({
      index: i + 1,
      title: `Kilde ${i + 1}`,
      url: `https://example.no/${i + 1}`,
      excerpts: [{ text: 'utdrag '.repeat(400) }],
    })),
  },
});

const context = {
  serviceName: 'Klarspråk',
  locale: 'nb' as const,
  threadTitle: 'Om klarspråk',
  threads: [{ id: 't1', title: 'Om klarspråk', updatedAt: '2026-11-21T09:00:00Z' }],
  currentThread: 't1',
};

describe('the data a ref block is given', () => {
  it('gives a ref block in the main zone the data of its own turn', () => {
    const first = turn('1', 'Hva er klarspråk?');

    const data = blockData('main', first, context);

    expect(data).toMatchObject({
      question: { text: 'Hva er klarspråk?' },
      answer: { status: 'done', text: 'Svar på Hva er klarspråk?' },
      sources: [{ index: 1, title: 'Kilde 1' }],
      service: { name: 'Klarspråk' },
    });
    expect(data.threads).toBeUndefined();
    expect(blockData('primary', first, context).threads).toEqual([
      { title: 'Om klarspråk', updatedAt: '2026-11-21T09:00:00.000Z', current: true },
    ]);
  });

  it('gives a ref block only the fields it reads', () => {
    const data = blockData('main', turn('1', 'Hva er klarspråk?'), context);

    expect(pickReads(data, ['question.text', 'sources.title', 'nothing.here'])).toEqual({
      question: { text: 'Hva er klarspråk?' },
      sources: [{ title: 'Kilde 1' }],
    });
  });

  it('gives a block that reads nothing, or only unknown fields, no data', () => {
    const data = blockData('main', turn('1', 'Hva er klarspråk?'), context);

    expect(pickReads(data, [])).toEqual({});
    expect(pickReads(data, ['nothing.here'])).toEqual({});
  });

  it("caps lists at the field list's maximum", () => {
    const data = blockData('main', turn('1', 'Mange kilder', 80), context);

    const picked = pickReads(data, ['sources.excerpt']);

    expect(picked.sources).toHaveLength(50);
    expect(picked.sources?.[0]?.excerpt).toHaveLength(1_000);
  });

  it('sets the state from the turn', () => {
    expect(blockState(undefined)).toBe('empty');
    expect(blockState({ id: '1', question: 'q', askedAt: 0 })).toBe('loading');
    expect(blockState(turn('1', 'q'))).toBe('filled');
  });
});
