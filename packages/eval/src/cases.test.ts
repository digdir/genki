import { describe, expect, it } from 'vitest';
import { caseFrom, caseView, gradeAnswer } from './cases.js';
import type { JudgeMessage, JudgeModel } from './evaluators.js';
import { testCase } from './schema.js';

const context = { servedModels: ['m'], modelFamily: () => 'a' };

describe('test cases as people see them', () => {
  it('maps locked to the holdout split and back', () => {
    const added = testCase.parse(
      caseFrom({ id: 'c1', input: 'Hei', expected: 'hei', type: 'exact', split: 'locked' }),
    );

    expect(added.split).toBe('holdout');
    expect(caseView(added)).toEqual({
      id: 'c1',
      input: 'Hei',
      expected: 'hei',
      type: 'exact',
      split: 'locked',
    });
  });

  it('grades exact and must-reject cases without a judge', async () => {
    const exact = testCase.parse(
      caseFrom({ id: 'c1', input: 'x', expected: '1. mai', type: 'exact' }),
    );
    const reject = testCase.parse(caseFrom({ id: 'c2', input: 'x', type: 'must_reject' }));

    expect((await gradeAnswer(exact, { text: 'Fristen er 1.  MAI.' }, { context })).pass).toBe(
      true,
    );
    expect((await gradeAnswer(exact, { text: 'Snart' }, { context })).pass).toBe(false);
    expect((await gradeAnswer(reject, { text: '', noAnswer: true }, { context })).pass).toBe(true);
    expect((await gradeAnswer(reject, { text: 'Her er svaret' }, { context })).pass).toBe(false);
  });

  it('fails a criteria case with a reason when no judge is available', async () => {
    const criteria = testCase.parse(caseFrom({ id: 'c1', input: 'x', expected: 'Nevner fristen' }));

    expect(await gradeAnswer(criteria, { text: 'x' }, { context })).toEqual({
      pass: false,
      score: null,
      reason: 'Ingen dommermodell fra en annen modellfamilie er tilgjengelig.',
    });
  });
});

describe('criteria apart from the reference answer', () => {
  it('keeps the criteria of a new criteria case in expected.criteria, and an exact text as the reference', () => {
    const criteria = testCase.parse(caseFrom({ id: 'c1', input: 'x', expected: 'Nevner fristen' }));
    const exact = testCase.parse(
      caseFrom({ id: 'c2', input: 'x', expected: '1. mai', type: 'exact' }),
    );

    expect(caseFrom({ id: 'c1', input: 'x', expected: 'Nevner fristen' }).expected).toEqual({
      criteria: { criteria: 'Nevner fristen' },
    });
    expect(criteria.expected).toEqual({ sources: [], criteria: { criteria: 'Nevner fristen' } });
    expect(caseView(criteria).expected).toBe('Nevner fristen');
    expect(exact.expected).toEqual({ sources: [], referenceAnswer: '1. mai' });
  });

  it('keeps a reference answer and named criteria given together, as an import brings them', () => {
    const both = testCase.parse(
      caseFrom({
        id: 'c4',
        input: 'Hvem eier Kudos?',
        expected: {
          referenceAnswer: 'DFØ eier Kudos.',
          criteria: { criteria: 'Nevner DFØ', supporting_quotes: 'Kudos driftes av DFØ' },
        },
      }),
    );

    expect(both.expected).toEqual({
      sources: [],
      referenceAnswer: 'DFØ eier Kudos.',
      criteria: { criteria: 'Nevner DFØ', supporting_quotes: 'Kudos driftes av DFØ' },
    });
  });

  it('reads a criteria case written before expected.criteria with its criteria moved there', () => {
    const old = testCase.parse({
      id: 'nn-idporten-kva',
      split: 'train',
      type: 'criteria',
      input: 'Kva er ID-porten?',
      expected: { referenceAnswer: 'Svaret er skrive på nynorsk.' },
    });
    const untyped = testCase.parse({
      id: 'ue-1',
      split: 'validation',
      input: 'Hvilke statuser finnes?',
      expected: { referenceAnswer: 'Initialisert, lastet opp og publisert.' },
    });
    const both = testCase.parse({
      id: 'c3',
      split: 'train',
      type: 'criteria',
      input: 'x',
      expected: { referenceAnswer: 'Fristen er 1. mai.', criteria: { criteria: 'Nevner fristen' } },
    });

    expect(old.expected).toEqual({
      sources: [],
      criteria: { criteria: 'Svaret er skrive på nynorsk.' },
    });
    expect(untyped.expected.referenceAnswer).toBe('Initialisert, lastet opp og publisert.');
    expect(untyped.expected.criteria).toBeUndefined();
    expect(both.expected).toMatchObject({
      referenceAnswer: 'Fristen er 1. mai.',
      criteria: { criteria: 'Nevner fristen' },
    });
  });

  it('judges a criteria case on its criteria, and on its reference answer when it has none', async () => {
    const asked: JudgeMessage[][] = [];
    const judge: JudgeModel = {
      id: 'claude',
      family: 'anthropic',
      complete: async (messages) => {
        asked.push(messages);
        return '{"scores": {"criteria": 1}, "rationale": "ok"}';
      },
    };
    const withCriteria = testCase.parse({
      id: 'c1',
      split: 'train',
      input: 'Når er fristen?',
      expected: { referenceAnswer: 'Fristen er 1. mai.', criteria: { criteria: 'Nevner fristen' } },
    });
    const referenceOnly = testCase.parse({
      id: 'c2',
      split: 'train',
      input: 'Når er fristen?',
      expected: { referenceAnswer: 'Fristen er 1. mai.' },
    });

    await gradeAnswer(withCriteria, { text: 'Fristen er 1. mai.' }, { judge, context });
    await gradeAnswer(referenceOnly, { text: 'Fristen er 1. mai.' }, { judge, context });

    expect(asked[0]?.[1]?.content).toContain('Criteria:\n- criteria: Nevner fristen');
    expect(asked[1]?.[1]?.content).toContain('Criteria:\n- criteria: Fristen er 1. mai.');
  });

  it('names criteria fields as judges read them', () => {
    const named = (criteria: Record<string, string>) =>
      testCase.safeParse({ id: 'c1', split: 'train', input: 'x', expected: { criteria } }).success;

    expect(named({ criteria: 'Nevner fristen', supporting_quotes: 'Siterer forskriften' })).toBe(
      true,
    );
    expect(named({ 'Supporting quotes': 'x' })).toBe(false);
    expect(named({ criteria: '' })).toBe(false);
  });
});
