import { describe, expect, it } from 'vitest';
import { pairCitations } from '../sources/pairing.js';
import type { SourceDocument } from '../sources/types.js';
import { answerCitations, readFootnotes, type AnswerMarker } from './citations.js';

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

// As genki sends them when a service cites excerpts: each written marker and the chunk it means.
const markers: AnswerMarker[] = [
  { marker: '1', chunkId: 'a2', documentId: 'kudos::a' },
  { marker: '2', chunkId: 'b1', documentId: 'kudos::b' },
  { marker: '3', chunkId: 'a1', documentId: 'kudos::a' },
  { marker: '4', chunkId: 'a2', documentId: 'kudos::a' },
  { marker: '9', chunkId: 'gone', documentId: 'kudos::c' },
];

const drawn = (text: string) => {
  const read = readFootnotes(text, sources, markers);
  return [...read.marks.values()].map((mark) =>
    mark.kind === 'footnote' ? read.pairing.targets[mark.citation] : mark.kind,
  );
};

describe('reading an answer’s footnotes', () => {
  it('reads [N] by the service’s markers when it cites excerpts, and by the source’s index otherwise', () => {
    expect(answerCitations('Ett [2] og to [3].', sources, markers)).toEqual([
      { chunkId: 'b1', documentId: 'kudos::b' },
      { chunkId: 'a1', documentId: 'kudos::a' },
    ]);
    expect(answerCitations('Ett [2] og to [1].', sources)).toEqual([
      { index: 2, documentId: 'kudos::b' },
      { index: 1, documentId: 'kudos::a' },
    ]);
  });

  it('numbers excerpts 1, 2, 3 in the order the answer first cites them, whatever the service wrote', () => {
    const read = readFootnotes('Først [3], så [1], så [3] igjen og [2].', sources, markers);
    expect([...read.pairing.numbers]).toEqual([
      ['a1', 1],
      ['a2', 2],
      ['b1', 3],
    ]);
    expect(read.pairing.numbers.has('a3')).toBe(false);
  });

  it('leaves a [N] that is no footnote as text: a year, or a number no source has', () => {
    const read = readFootnotes('I [2021] økte det [1], jf. [7].', sources);
    expect(read.marks.size).toBe(1);
    expect(read.citations).toEqual([{ index: 1, documentId: 'kudos::a' }]);
    expect(read.written).toBe(2);
  });

  it('draws no footnote that leads to nothing shown, and leaves it out of the pairing', () => {
    expect(drawn('Her [9] og der [2].')).toEqual(['dropped', 'b1']);
    const read = readFootnotes('Her [9] og der [2].', sources, markers);
    expect(read.citations).toEqual([{ chunkId: 'b1', documentId: 'kudos::b' }]);
    expect(read.pairing.unpaired).toEqual([]);
  });

  it('draws two markers side by side that mean one excerpt as one footnote, and keeps them apart elsewhere', () => {
    expect(drawn('Samme utdrag [1][4]. Igjen senere [4].')).toEqual(['a2', 'dropped', 'a2']);
    expect(
      readFootnotes('Samme utdrag [1][4]. Igjen senere [4].', sources, markers).citations,
    ).toHaveLength(2);
  });

  it('draws two markers a space apart that mean one excerpt as one footnote', () => {
    expect(drawn('Samme utdrag [1] [4].')).toEqual(['a2', 'dropped']);
    expect(drawn('Samme utdrag [1]\t[4] og [1] **x** [4].')).toEqual([
      'a2',
      'dropped',
      'a2',
      'a2',
    ]);
  });

  it('keeps side-by-side markers for two excerpts of one document apart, and two for one document as one', () => {
    expect(drawn('To utdrag [1][3].')).toEqual(['a2', 'a1']);
    const read = readFootnotes('Ett dokument [1][1].', sources);
    expect([...read.marks.values()].map((mark) => mark.kind)).toEqual(['footnote', 'dropped']);
    expect(read.pairing.targets).toEqual(['kudos::a']);
  });

  it('numbers nothing when the footnotes name only documents, so the answer draws none', () => {
    const read = readFootnotes('Ett [2] og to [1].', sources);
    expect(read.pairing.mode).toBe('document');
    expect(read.pairing.numbers.size).toBe(0);
    expect(read.citations).toHaveLength(2);
  });

  it('makes nothing a footnote before the sources have come', () => {
    const read = readFootnotes('Skriver [1] fortsatt [2]', undefined, markers);
    expect(read.marks.size).toBe(0);
    expect(read.citations).toEqual([]);
    expect(read.written).toBe(2);
  });

  it('finds the footnotes the renderer draws, and only those: not in code, not escaped', () => {
    const text =
      '# Tittel [1]\n\n- punkt [2]\n\n| a | b |\n|---|---|\n| c [3] | d |\n\n`kode [4]` og \\[1\\]\n\n```\n[2]\n```';
    expect(drawn(text)).toEqual(['a2', 'b1', 'a1']);
  });
});

describe('the pairing both ways, from the answer’s side', () => {
  const text = 'A [3]. B [1][4]. C [2]. D [9]. E [3]. F [2021].';

  it('gives Sources exactly the footnotes the answer draws, so every footnote leads to one shown excerpt', () => {
    const read = readFootnotes(text, sources, markers);
    const pairing = pairCitations(sources, answerCitations(text, sources, markers));
    const drawnCitations = [...read.marks.values()].filter((m) => m.kind === 'footnote');
    expect(drawnCitations).toHaveLength(pairing.targets.length);
    expect(pairing.unpaired).toEqual([]);
    for (const target of pairing.targets) expect(target).toBeDefined();
  });

  it('gives every numbered excerpt at least one footnote, and lists each footnote among its excerpt’s uses', () => {
    const pairing = pairCitations(sources, answerCitations(text, sources, markers));
    for (const [chunk] of pairing.numbers)
      expect(pairing.uses.get(chunk)?.length).toBeGreaterThan(0);
    pairing.targets.forEach((chunk, i) => expect(pairing.uses.get(chunk ?? '')).toContain(i));
    expect([...pairing.numbers]).toEqual([
      ['a1', 1],
      ['a2', 2],
      ['b1', 3],
    ]);
    expect(pairing.uses.get('a1')).toEqual([0, 3]);
  });
});
