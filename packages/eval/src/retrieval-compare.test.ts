import { describe, expect, it } from 'vitest';
import { compareRetrieval, retrievalCases, type RetrievalRun } from './retrieval-compare.js';
import { testCase } from './schema.js';

const run = (documents: string[], latencyMs = 10): RetrievalRun => ({
  hits: documents.map((document) => ({ document, title: `Tittel ${document}` })),
  latencyMs,
});

const cases = [
  { id: 'a', question: 'Hva er tilskudd?', expected: [{ document: 'tilskudd' }] },
  { id: 'b', question: 'Hvem flytter til sky?', expected: [{ document: 'sky' }] },
];

describe('compareRetrieval', () => {
  it('compareRetrieval counts hit@5 against expected sources', () => {
    const comparison = compareRetrieval({
      cases,
      old: {
        a: run(['x', 'tilskudd'], 20),
        b: run(['x', 'y', 'z', 'w', 'v', 'sky'], 30),
      },
      new: {
        a: run(['tilskudd'], 8),
        b: run(['sky', 'x'], 12),
      },
      testSets: ['ka-sporsmal'],
    });

    expect(comparison).toMatchObject({
      testSets: ['ka-sporsmal'],
      cases: 2,
      hitAt5: [0.5, 1],
      meanRank: [4, 1],
      latencyMs: [25, 10],
      verdict: 'better',
    });
    expect(comparison.examples[0]).toMatchObject({
      verdict: 'better',
      old: { first: 'Tittel x' },
      new: { first: 'Tittel tilskudd', rank: 1 },
    });
  });

  it('a lower hit rate makes the new engine worse and worse examples come first', () => {
    const comparison = compareRetrieval({
      cases,
      old: { a: run(['tilskudd']), b: run(['sky']) },
      new: { a: run(['tilskudd']), b: run(['x']) },
    });
    expect(comparison.verdict).toBe('worse');
    expect(comparison.examples.map((e) => e.verdict)).toEqual(['worse', 'same']);
  });

  it('only cases with expected sources and a question take part', () => {
    const parsed = [
      {
        id: 'med',
        split: 'validation',
        input: 'Spørsmål',
        expected: { sources: [{ document: 'd' }] },
      },
      { id: 'uten', split: 'validation', input: 'Spørsmål' },
      {
        id: 'deler',
        split: 'validation',
        input: { parts: [{ kind: 'text', text: 'Fra deler' }] },
        expected: { sources: [{ chunkId: 'c1' }] },
      },
    ].map((c) => testCase.parse(c));
    expect(retrievalCases(parsed).map((c) => [c.id, c.question])).toEqual([
      ['med', 'Spørsmål'],
      ['deler', 'Fra deler'],
    ]);
  });
});
