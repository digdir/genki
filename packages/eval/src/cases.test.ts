import { describe, expect, it } from 'vitest';
import { caseFrom, caseView, gradeAnswer } from './cases.js';
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
