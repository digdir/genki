import { describe, expect, it } from 'vitest';
import type { Evaluator, Score } from '@genai/eval';
import { runContract } from '@genai/plugins';
import { evaluatorContract } from './plugin-contracts.js';

const scored = (value: number): Score => ({
  evaluator: 'dommer',
  version: '1',
  metric: 'korrekthet',
  value,
  applicable: true,
  state: 'scored',
});

const pending: Score = {
  evaluator: 'dommer',
  version: '1',
  metric: 'korrekthet',
  value: null,
  applicable: true,
  state: 'pending',
  details: { ticket: 'sak-1' },
};

const judge = (parts: Pick<Evaluator, 'evaluate' | 'collect'>): Evaluator => ({
  id: 'dommer',
  version: '1',
  kind: 'model',
  ...parts,
});

const deliversOnAsk = (ask: number) => {
  let asked = 0;
  return judge({
    evaluate: async () => [pending],
    collect: async (items) => {
      asked += 1;
      return asked < ask
        ? []
        : items.map((item) => ({ case: item.case, repeat: item.repeat, score: scored(0.8) }));
    },
  });
};

const verify = (evaluator: Evaluator) =>
  runContract(
    evaluatorContract,
    async () => ({ subject: { evaluator, metrics: ['korrekthet'] } }),
    {
      timeoutMs: 2_000,
    },
  );

const pendingCheck = 'a pending answer gets its scores when collected';

describe('evaluator@2 contract', () => {
  it('passes an evaluator that answers at once, with nothing pending to collect', async () => {
    const run = await verify(judge({ evaluate: async () => [scored(0.9)] }));

    expect(run.contract).toBe('evaluator@2');
    expect(run.passed).toBe(true);
    expect(run.results.find((r) => r.name === pendingCheck)?.status).toBe('skipped');
  });

  it('passes an evaluator that answers pending and delivers when collected', async () => {
    const run = await verify(deliversOnAsk(2));

    expect(run.passed).toBe(true);
    expect(run.results.map((r) => r.status)).toEqual(['passed', 'passed', 'passed']);
  });

  it('fails an evaluator whose pending scores never arrive, or that answers pending without collect', async () => {
    const never = await verify(judge({ evaluate: async () => [pending], collect: async () => [] }));
    const uncollectable = await verify(judge({ evaluate: async () => [pending] }));

    expect(never.passed).toBe(false);
    expect(never.results.find((r) => r.name === pendingCheck)?.status).toBe('failed');
    expect(uncollectable.passed).toBe(false);
    expect(uncollectable.results[0]?.reason).toBe(
      'an evaluator that answers pending can be collected',
    );
  });
});
