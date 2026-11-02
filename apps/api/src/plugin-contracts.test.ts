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

  it('records a malformed collected score as failed with the reason, and keeps the rest', async () => {
    const items = [waiting('sak-1', 1), waiting('sak-2', 2)];
    const evaluator = httpJudge(
      plugin,
      answering(() => ({
        status: 200,
        body: {
          results: [
            { ticket: 'sak-1', scores: [{ metric: 'korrekthet', state: 'scored' }] },
            { ticket: 'sak-2', scores: [{ metric: 'korrekthet', value: 0.5 }] },
          ],
        },
      })),
    );

    expect(await evaluator.collect?.(items)).toMatchObject([
      {
        case: 'c1',
        score: {
          state: 'failed',
          value: null,
          reason: 'the evaluator dommer scored korrekthet without a value',
        },
      },
      { case: 'c2', score: { state: 'scored', value: 0.5 } },
    ]);
  });

  it('refuses a pending score without a ticket', async () => {
    const evaluator = httpJudge(
      plugin,
      answering(() => ({
        status: 200,
        body: { scores: [{ metric: 'korrekthet', state: 'pending' }] },
      })),
    );

    await expect(evaluator.evaluate(testCase as never, observation as never, ctx)).rejects.toThrow(
      'the evaluator dommer answered korrekthet pending without a ticket',
    );
  });

  it('passes the signal on to every request, when it judges and when it collects', async () => {
    const seen: (AbortSignal | undefined)[] = [];
    const evaluator = httpJudge(plugin, async (body, signal) => {
      seen.push(signal);
      return {
        status: 200,
        body: JSON.stringify(
          'collect' in JSON.parse(body)
            ? { results: [] }
            : { scores: [{ metric: 'korrekthet', value: 1 }] },
        ),
      };
    });
    const signal = new AbortController().signal;

    await evaluator.evaluate(testCase as never, observation as never, { ...ctx, signal });
    await evaluator.collect?.([waiting('sak-1', 1)], { signal });

    expect(seen).toEqual([signal, signal]);
  });

  it("sends a case's reference answer and named criteria to the judge, and leaves out what the case lacks", async () => {
    const asked: Record<string, unknown>[] = [];
    const evaluator = httpJudge(
      plugin,
      answering((body) => {
        asked.push(body);
        return { status: 200, body: { scores: [{ metric: 'korrekthet', value: 1 }] } };
      }),
    );
    const criteria = { criteria: 'Nevner fristen', supporting_quotes: 'Fristen er 1. mai' };

    await evaluator.evaluate(
      {
        ...testCase,
        expected: { sources: [], referenceAnswer: 'Fristen er 1. mai.', criteria },
      } as never,
      observation as never,
      ctx,
    );
    await evaluator.evaluate(testCase as never, observation as never, ctx);

    expect(asked[0]?.case).toEqual({
      id: 'frist',
      input: 'Hva er fristen?',
      referenceAnswer: 'Fristen er 1. mai.',
      criteria,
    });
    expect(asked[1]?.case).toEqual({ id: 'frist', input: 'Hva er fristen?' });
  });

  it('asks for at most 50 tickets per collect call', async () => {
    const sizes: number[] = [];
    const evaluator = httpJudge(plugin, async (body) => {
      sizes.push((JSON.parse(body) as { collect: { tickets: string[] } }).collect.tickets.length);
      return { status: 200, body: JSON.stringify({ results: [] }) };
    });

    await evaluator.collect?.(Array.from({ length: 120 }, (_, i) => waiting(`sak-${i}`, i)));

    expect(sizes).toEqual([50, 50, 20]);
  });
});
