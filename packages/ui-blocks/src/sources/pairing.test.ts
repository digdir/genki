import { describe, expect, it } from 'vitest';
import { pairCitations, readingOrder, type SourceCitation } from './pairing.js';
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

  it('leads footnotes that name only documents to their documents, by id or index, and numbers nothing', () => {
    const pairing = pairCitations(sources, [
      { documentId: 'kudos::b' },
      { index: 1 },
      { index: 2 },
    ]);
    expect(pairing.mode).toBe('document');
    expect(pairing.targets).toEqual(['kudos::b', 'kudos::a', 'kudos::b']);
    expect(pairing.uses.get('kudos::a')).toEqual([1]);
    expect(pairing.uses.get('kudos::b')).toEqual([0, 2]);
    expect(pairing.numbers.size).toBe(0);
  });

  it('numbers no document and guesses no excerpt when any footnote names only its document', () => {
    const pairing = pairCitations(sources, [{ chunkId: 'a1' }, { index: 2 }]);
    expect(pairing.mode).toBe('document');
    expect(pairing.numbers.size).toBe(0);
    expect(pairing.uses.get('kudos::a')).toEqual([0]);
  });
});

describe('the order Sources reads in', () => {
  // A real annual report's shape: an uncited excerpt at part 34 and «Utdrag 1» at part 92.
  const report: SourceDocument = {
    index: 6,
    title: 'Årsrapport Digitaliseringsdirektoratet 2023',
    documentId: 'kudos::88642',
    excerpts: [
      { chunkId: '42d7142b2765', text: 'Modernisering av Altinn', position: 92 },
      { chunkId: '97fc11a8044f', text: 'Eit av dei strategiske måla', position: 34 },
    ],
  };
  const note: SourceDocument = { index: 3, title: 'Notat', excerpts: [] };
  const all = [sources[0], report, sources[1], note] as SourceDocument[];
  const order = (citations: SourceCitation[] | undefined) =>
    readingOrder(all, citations && pairCitations(all, citations));
  const chunks = (read: ReturnType<typeof readingOrder>) =>
    read.documents.map((i) => read.excerpts[i]?.map((e) => e.chunkId));

  it('runs the documents by their lowest number, and those nothing cites after, in the service’s order', () => {
    expect(order(cite('b1', 'a3', '42d7142b2765')).documents).toEqual([2, 0, 1, 3]);
    expect(order(cite('42d7142b2765', 'b1')).documents).toEqual([1, 2, 0, 3]);
  });

  it('reads a document’s cited excerpts by number, before those nothing cites, in the document’s order', () => {
    expect(chunks(order(cite('42d7142b2765', 'a3', 'a1')))).toEqual([
      ['42d7142b2765', '97fc11a8044f'],
      ['a3', 'a1', 'a2'],
      ['b1'],
      [],
    ]);
  });

  it('reads the cited excerpts «Utdrag 1», 2, 3 from the top, across the documents and inside each', () => {
    const pairing = pairCitations(all, cite('42d7142b2765', 'b1', 'a2', 'b1'));
    const seen = chunks(readingOrder(all, pairing))
      .flat()
      .map((chunk) => pairing.numbers.get(chunk ?? ''));
    // The report: 1, then its uncited part. The 2022 report: 2. The 2021 report: 3, then the rest.
    expect(seen).toEqual([1, undefined, 2, 3, undefined, undefined]);
  });

  it('uncited excerpts are unnumbered and come last in their card', () => {
    const citations = cite('a3', '42d7142b2765', 'a3');
    const pairing = pairCitations(all, citations);
    const read = readingOrder(all, pairing);
    for (const card of chunks(read)) {
      const cited = (card ?? []).map((chunk) => pairing.numbers.has(chunk));
      // Once an uncited excerpt is reached, nothing cited follows it in the card.
      expect(cited).toEqual(cited.toSorted((a, b) => Number(b) - Number(a)));
    }
    expect(chunks(read)).toEqual([
      ['a3', 'a1', 'a2'],
      ['42d7142b2765', '97fc11a8044f'],
      ['b1'],
      [],
    ]);
    // Only what the footnotes cite is numbered, 1 to n, and every footnote leads to its excerpt.
    expect([...pairing.numbers]).toEqual([
      ['a3', 1],
      ['42d7142b2765', 2],
    ]);
    pairing.targets.forEach((key, i) => expect(pairing.uses.get(key ?? '')).toContain(i));
    expect(pairing.unpaired).toEqual([]);
  });

  it('keeps the service’s order and the document’s when no footnote names an excerpt', () => {
    const unchanged = [['a1', 'a2', 'a3'], ['97fc11a8044f', '42d7142b2765'], ['b1'], []];
    for (const citations of [undefined, [{ index: 2 }, { index: 1 }], [], cite('gone')]) {
      const read = order(citations);
      expect(read.documents).toEqual([0, 1, 2, 3]);
      expect(chunks(read)).toEqual(unchanged);
    }
  });
});
