import { describe, expect, it } from 'vitest';
import type { Evaluator, PendingScore, Score } from '@genai/eval';
import { runContract } from '@genai/plugins';
import { evaluatorContract, httpJudge, type JudgeSend } from './plugin-contracts.js';

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

describe('evaluator@2 contract, on the pending answer it was given', () => {
  it('fails when the ticket it was given is never collected, even if asking again answers at once', async () => {
    let asked = 0;
    const evaluator = judge({
      evaluate: async () => ((asked += 1) % 2 === 1 ? [pending] : [scored(0.8)]),
      collect: async () => [],
    });

    const run = await runContract(
      evaluatorContract,
      async () => ({ subject: { evaluator, metrics: ['korrekthet'] } }),
      { timeoutMs: 300 },
    );

    expect(run.results.find((r) => r.name === pendingCheck)?.status).toBe('failed');
  });
});

describe('an HTTP judge', () => {
  const plugin = { id: 'dommer', version: '1' };
  const answering =
    (reply: (body: Record<string, unknown>) => { status: number; body: unknown }): JudgeSend =>
    async (body) => {
      const r = reply(JSON.parse(body) as Record<string, unknown>);
      return { status: r.status, body: JSON.stringify(r.body) };
    };
  const testCase = { id: 'frist', split: 'validation', input: 'Hva er fristen?', expected: {} };
  const observation = { answer: 'Fristen er 1. mai.', citations: [], toolCalls: [] };
  const ctx = { servedModels: [], modelFamily: () => undefined };
  const waiting = (ticket: string, i: number): PendingScore => ({
    case: `c${i}`,
    repeat: 0,
    task: `t${i}`,
    score: { ...pending, details: { ticket } },
  });

  it('refuses a score with neither a value nor a state, instead of reading it as not applicable', async () => {
    const evaluator = httpJudge(
      plugin,
      answering(() => ({ status: 200, body: { scores: [{ metric: 'korrekthet' }] } })),
    );

    await expect(evaluator.evaluate(testCase as never, observation as never, ctx)).rejects.toThrow(
      'the evaluator dommer answered korrekthet without a value or a state',
    );
  });

  it('keeps the scores of the batches that arrived when a later batch fails', async () => {
    const items = Array.from({ length: 60 }, (_, i) => waiting(`sak-${i}`, i));
    const evaluator = httpJudge(
      plugin,
      answering((body) => {
        const tickets = (body.collect as { tickets: string[] }).tickets;
        return tickets.includes('sak-0')
          ? {
              status: 200,
              body: {
                results: tickets.map((ticket) => ({
                  ticket,
                  scores: [{ metric: 'korrekthet', value: 1 }],
                })),
              },
            }
          : { status: 503, body: {} };
      }),
    );
    const failing = httpJudge(
      plugin,
      answering(() => ({ status: 503, body: {} })),
    );

    const collected = (await evaluator.collect?.(items)) ?? [];
    expect(collected).toHaveLength(50);
    expect(collected.every((c) => c.score.state === 'scored')).toBe(true);
    await expect(failing.collect?.(items)).rejects.toThrow(
      'the evaluator dommer answered HTTP 503',
    );
  });
});
