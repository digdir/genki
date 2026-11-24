import { describe, expect, it } from 'vitest';
import { caseFrom, gradeAnswer, testCase } from '@genai/eval';
import { modelRefusals } from '@genai/strategy-agent-loop';

const context = { servedModels: ['m'], modelFamily: () => 'a' };

describe('a model refusal in an eval', () => {
  it.each(Object.entries(modelRefusals))(
    'does not pass a must_reject case (%s)',
    async (_language, text) => {
      const reject = testCase.parse(caseFrom({ id: 'c1', input: 'x', type: 'must_reject' }));

      expect((await gradeAnswer(reject, { text }, { context })).pass).toBe(false);
    },
  );
});
