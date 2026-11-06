import { describe, expect, it } from 'vitest';
import { pairCitations, type SourceCitation } from './pairing.js';
import type { SourceDocument } from './types.js';

const sources: SourceDocument[] = [
  {
    index: 1,
    title: 'Årsrapport 2021',
    documentId: 'kudos::a',
    excerpts: [
      { chunkId: 'a1', text: 'Ressursbruk' },
      { chunkId: 'a2', text: 'Internkontroll' },
      { chunkId: 'a3', text: 'Ledelsens vurdering' },
    ],
  },
  {
    index: 2,
    title: 'Årsrapport 2022',
    documentId: 'kudos::b',
    excerpts: [{ chunkId: 'b1', text: 'Samfunnsoppdrag' }],
  },
];

const cite = (...chunks: string[]): SourceCitation[] => chunks.map((chunkId) => ({ chunkId }));

describe('pairing footnotes with what is shown', () => {
  it('numbers only cited excerpts, 1, 2, 3 in the order of first citation', () => {
    const pairing = pairCitations(sources, cite('b1', 'a2', 'b1', 'a1'));
    expect(pairing.mode).toBe('excerpt');
    expect([...pairing.numbers]).toEqual([
      ['b1', 1],
      ['a2', 2],
      ['a1', 3],
    ]);
    expect(pairing.numbers.has('a3')).toBe(false);
  });

  it('gives every numbered excerpt each place the answer uses it, in the answer’s order', () => {
    const pairing = pairCitations(sources, cite('b1', 'a2', 'b1', 'a1'));
    expect(pairing.uses.get('b1')).toEqual([0, 2]);
    expect(pairing.uses.get('a2')).toEqual([1]);
    for (const [chunk] of pairing.numbers)
      expect(pairing.uses.get(chunk)?.length).toBeGreaterThan(0);
  });

  it('leads every footnote to one shown item, and reports one that leads nowhere without a number', () => {
    const pairing = pairCitations(sources, cite('a1', 'gone', 'a2'));
    expect(pairing.targets).toEqual(['a1', undefined, 'a2']);
    expect(pairing.unpaired).toEqual([1]);
    expect([...pairing.numbers.values()]).toEqual([1, 2]);
  });

  it('pairs both ways: every footnote’s target lists that footnote among its uses', () => {
    const citations = cite('a3', 'b1', 'a3', 'a1', 'b1', 'b1');
    const pairing = pairCitations(sources, citations);
    pairing.targets.forEach((key, i) => {
      expect(key).toBeDefined();
      expect(pairing.uses.get(key ?? '')).toContain(i);
    });
    const counted = [...pairing.uses.values()].reduce((sum, uses) => sum + uses.length, 0);
    expect(counted).toBe(citations.length);
  });

  it('pairs documents in document mode, by excerpt, id or index, and numbers nothing', () => {
    const pairing = pairCitations(
      sources,
      [{ chunkId: 'a2' }, { documentId: 'kudos::b' }, { index: 1 }],
      'document',
    );
    expect(pairing.mode).toBe('document');
    expect(pairing.numbers.size).toBe(0);
    expect(pairing.uses.get('kudos::a')).toEqual([0, 2]);
    expect(pairing.uses.get('kudos::b')).toEqual([1]);
  });

  it('falls back to document mode when a footnote names only its document', () => {
    const pairing = pairCitations(sources, [{ chunkId: 'a1' }, { index: 2 }], 'excerpt');
    expect(pairing.mode).toBe('document');
    expect(pairing.numbers.size).toBe(0);
  });
});
