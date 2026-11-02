import { describe, expect, it } from 'vitest';
import type { Event } from '@genai/contracts';
import { defaultObserve } from './observe.js';

describe('source evidence in observations', () => {
  it('retains titles and excerpts from retrieval events and part metadata', () => {
    const source = {
      chunkId: 'c1',
      document: 'law-2026',
      title: 'Law 2026',
      text: 'Effective 2026.',
    };
    const event = { type: 'kernel.notice', data: { kind: 'retrieval', hits: [source] } } as Event;

    const observed = defaultObserve(
      [
        {
          mime: 'text/plain',
          body: { kind: 'text', text: 'Effective 2026.' },
          meta: {
            citations: [source],
            retrieved: [{ id: 'c2', title: 'Second law', text: 'Excerpt' }],
          },
        },
      ],
      [event],
    );

    expect(observed.retrieved).toEqual([
      source,
      { chunkId: 'c2', title: 'Second law', text: 'Excerpt' },
    ]);
    expect(observed.citations).toEqual([source]);
  });

  it('ignores invalid source records and unrelated JSON parts', () => {
    const observed = defaultObserve(
      [
        {
          mime: 'application/vnd.genai.sources+json',
          body: {
            kind: 'json',
            json: { sources: [null, 'bad', {}, { chunkId: 'c1', title: 12, text: false }] },
          },
        },
        {
          mime: 'application/json',
          body: { kind: 'json', json: { sources: [{ chunkId: 'unrelated' }] } },
        },
      ],
      [],
    );

    expect(observed.retrieved).toEqual([{ chunkId: 'c1' }]);
  });
});
