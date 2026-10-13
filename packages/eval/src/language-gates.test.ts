import { describe, expect, it } from 'vitest';
import { evaluateGates, gate, testCase, type EvalRun } from './index.js';

const result = (id: string, value: number, language?: 'nb' | 'en') => ({
  case: id,
  split: 'validation' as const,
  repeat: 0,
  task: `t-${id}`,
  tags: [],
  ...(language ? { language } : {}),
  scores: [{ evaluator: 'retrieval', version: '1', metric: 'recall@10', value, applicable: true }],
});

const runOf = (results: EvalRun['results']): EvalRun => ({
  id: 'r',
  testSet: { tenant: '991825827', id: 'ka', version: 1 },
  capability: 'ka',
  splits: ['validation'],
  repeats: 1,
  startedAt: '2026-10-12T10:00:00Z',
  endedAt: '2026-10-12T10:05:00Z',
  provenance: { commit: 'a', data: 'd', servedModels: [], judges: [], services: [] },
  results,
  metrics: {},
  byTag: {},
});

const registry = new Map(
  [
    { id: 'recall', metric: 'recall@10', kind: 'threshold', threshold: 0.8 },
    {
      id: 'recall-per-language',
      metric: 'recall@10',
      kind: 'threshold',
      threshold: 0.8,
      languages: ['nb', 'en'],
    },
  ].map((g) => [g.id, gate.parse(g)]),
);

const evaluate = (gates: string[], results: EvalRun['results']) =>
  evaluateGates({
    evaluation: { testSets: ['ka'], gates },
    registry,
    candidate: new Map([['ka', runOf(results)]]),
  });

describe('quality per language', () => {
  it('lets a test case carry the language it is asked in', () => {
    expect(
      testCase.parse({ id: 'a', split: 'validation', input: 'Hi?', language: 'en' }).language,
    ).toBe('en');
    expect(
      testCase.parse({ id: 'b', split: 'validation', input: 'Hei?' }).language,
    ).toBeUndefined();
  });

  it('fails a per-language gate when one language is below the threshold although the mean passes', () => {
    const results = [
      result('nb1', 1, 'nb'),
      result('nb2', 1, 'nb'),
      result('nb3', 1, 'nb'),
      result('en1', 0.5, 'en'),
    ];
    expect(evaluate(['recall'], results).pass).toBe(true);
    const outcome = evaluate(['recall-per-language'], results);
    expect(outcome.pass).toBe(false);
    expect(outcome.results.map((r) => [r.testSet, r.pass])).toEqual([
      ['ka (nb)', true],
      ['ka (en)', false],
    ]);
  });

  it('fails a per-language gate for a language with no scored cases', () => {
    const outcome = evaluate(['recall-per-language'], [result('nb1', 1, 'nb')]);
    expect(outcome.results[1]).toMatchObject({ testSet: 'ka (en)', pass: false });
  });
});
