import type { CollectedScore, Evaluator, Observation, Score, TestCase } from '@genai/eval';
import { check, checkFailsWith, skipped, type ContractSuite } from '@genai/plugins';
import type { KnowledgePort } from '@genai/port-knowledge';
import type { RemoteReply } from '@genai/strategy-remote';
import { z } from 'zod';

export interface SearchEndpointSubject {
  open(signal?: AbortSignal): KnowledgePort;
  query: string;
}

export const searchEndpointContract: ContractSuite<SearchEndpointSubject> = {
  contract: 'knowledge@1',
  checks: [
    {
      name: 'a search answers with hits that carry an id, a score and text',
      run: async (s) => {
        const { hits } = await s.open().search({ query: s.query, limit: 3 });
        check(Array.isArray(hits), 'hits is a list');
        for (const hit of hits) {
          check(typeof hit.id === 'string' && hit.id.length > 0, 'every hit has an id');
          check(typeof hit.text === 'string', `hit ${hit.id} has text`);
          check(Number.isFinite(hit.score), `hit ${hit.id} has a numeric score`);
        }
      },
    },
    {
      name: 'a search never returns more hits than the limit',
      run: async (s) => {
        const { hits } = await s.open().search({ query: s.query, limit: 1 });
        check(hits.length <= 1, `asked for 1 hit, got ${hits.length}`);
      },
    },
    {
      name: 'what a search endpoint does not offer fails as unsupported',
      run: async (s) => {
        await checkFailsWith(() => s.open().fetch(['x']), 'unsupported', 'fetch');
      },
    },
  ],
};

export interface AgentSubject {
  ask(
    query: string,
    history: { role: 'user' | 'assistant'; text: string }[],
    signal: AbortSignal,
  ): Promise<RemoteReply>;
  query: string;
}

export const agentContractVersion = 'agent@1';

export const agentContract: ContractSuite<AgentSubject> = {
  contract: agentContractVersion,
  checks: [
    {
      name: 'a question gets an answer in the remote-agent/v1 shape',
      run: async (s, signal) => {
        const reply = await s.ask(s.query, [], signal);
        check(
          (typeof reply.answer === 'string' && reply.answer.trim() !== '') ||
            reply.data !== undefined,
          'the reply carries an answer or data',
        );
      },
    },
    {
      name: 'a follow-up with history is answered too',
      run: async (s, signal) => {
        const reply = await s.ask(
          s.query,
          [
            { role: 'user', text: s.query },
            { role: 'assistant', text: 'Kan du si mer?' },
          ],
          signal,
        );
        check(
          typeof reply.answer === 'string' || reply.data !== undefined,
          'the follow-up carries an answer or data',
        );
      },
    },
  ],
};

export const evaluatorContractVersion = 'evaluator@2';

export interface EvaluatorSubject {
  evaluator: Evaluator;
  metrics: string[];
}

const exampleCase: TestCase = {
  id: 'kontrakt',
  split: 'validation',
  input: 'Hvem utsteder tildelingsbrevet til Digdir?',
  expected: { sources: [], referenceAnswer: 'Digitaliserings- og forvaltningsdepartementet.' },
  grounding: 'sources-and-answer',
  tags: [],
  needsReview: false,
};

const exampleObservation: Observation = {
  answer: 'Tildelingsbrevet kommer fra Digitaliserings- og forvaltningsdepartementet.',
  retrieved: [{ document: 'tildelingsbrev-2025' }],
  citations: [{ document: 'tildelingsbrev-2025' }],
};

const evalContext = { servedModels: [], modelFamily: () => undefined };

const collectEveryMs = 250;
const collectBatch = 50;

const pause = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });

/**
 * Asks again for what was pending until nothing is, or the check runs out of time. Given the
 * scores of an earlier answer, it collects those, so the check follows the ticket it was handed.
 */
const settledScores = async (s: EvaluatorSubject, signal: AbortSignal, answered?: Score[]) => {
  const scores = answered
    ? [...answered]
    : await s.evaluator.evaluate(exampleCase, exampleObservation, evalContext);
  const pending = () => scores.filter((x) => x.state === 'pending');
  if (pending().length > 0)
    check(s.evaluator.collect, 'an evaluator that answers pending can be collected');
  while (pending().length > 0 && !signal.aborted) {
    await pause(collectEveryMs, signal);
    const collected: CollectedScore[] =
      (await s.evaluator.collect?.(
        pending().map((score) => ({ case: exampleCase.id, repeat: 0, task: 'kontrakt', score })),
        { signal },
      )) ?? [];
    for (const c of collected) {
      if (c.score.state === 'pending') continue;
      const at = scores.findIndex((x) => x.state === 'pending' && x.metric === c.score.metric);
      if (at >= 0) scores[at] = c.score;
    }
  }
  check(
    pending().length === 0,
    `no score for ${pending()
      .map((x) => x.metric)
      .join(', ')} after collecting`,
  );
  return scores;
};

export const evaluatorContract: ContractSuite<EvaluatorSubject> = {
  contract: evaluatorContractVersion,
  checks: [
    {
      name: 'an answer gets scores between 0 and 1, named by metric',
      run: async (s, signal) => {
        const scores = await settledScores(s, signal);
        check(scores.length > 0, 'at least one score');
        for (const score of scores) {
          check(score.metric.length > 0, 'every score names a metric');
          check(
            score.value === null || (score.value >= 0 && score.value <= 1),
            `${score.metric} is between 0 and 1`,
          );
        }
      },
    },
    {
      name: 'every metric the manifest declares is scored',
      run: async (s, signal) => {
        const scores = await settledScores(s, signal);
        const metrics = new Set(scores.map((x) => x.metric));
        const missing = s.metrics.filter((m) => !metrics.has(m));
        check(missing.length === 0, `missing metrics: ${missing.join(', ')}`);
      },
    },
    {
      name: 'a pending answer gets its scores when collected',
      run: async (s, signal) => {
        const first = await s.evaluator.evaluate(exampleCase, exampleObservation, evalContext);
        if (!first.some((x) => x.state === 'pending')) return skipped;
        const scores = await settledScores(s, signal, first);
        check(
          scores.every((x) => x.state !== 'pending'),
          'every pending score is settled after collecting',
        );
        return undefined;
      },
    },
  ],
};

const judgeScore = z.object({
  metric: z.string().min(1).max(100),
  value: z.number().min(0).max(1).nullable().optional(),
  state: z.enum(['scored', 'not-applicable', 'failed', 'pending']).optional(),
  reason: z.string().max(2000).optional(),
});
type JudgeScore = z.infer<typeof judgeScore>;

const judgeReply = z.object({
  scores: z.array(judgeScore).max(50),
  ticket: z.string().min(1).max(200).optional(),
});

const collectReply = z.object({
  results: z
    .array(z.object({ ticket: z.string(), scores: z.array(judgeScore).max(50) }))
    .max(collectBatch),
});

export type JudgeSend = (
  body: string,
  signal?: AbortSignal,
) => Promise<{ status: number; body: string }>;

export const httpJudge = (plugin: { id: string; version: string }, send: JudgeSend): Evaluator => {
  const ask = async <T>(
    body: Record<string, unknown>,
    shape: z.ZodType<T>,
    signal?: AbortSignal,
  ): Promise<T> => {
    const response = await send(
      JSON.stringify({ contract: evaluatorContractVersion, ...body }),
      signal,
    );
    if (response.status < 200 || response.status >= 300)
      throw new Error(`the evaluator ${plugin.id} answered HTTP ${response.status}`);
    const parsed = shape.safeParse(JSON.parse(response.body));
    if (!parsed.success) throw new Error(`the evaluator ${plugin.id} answered in an unknown shape`);
    return parsed.data;
  };

  const scoreOf = (s: JudgeScore, ticket: string | undefined): Score => {
    if (s.state === undefined && s.value === undefined)
      throw new Error(`the evaluator ${plugin.id} answered ${s.metric} without a value or a state`);
    const state = s.state ?? (typeof s.value === 'number' ? 'scored' : 'not-applicable');
    if (state === 'scored' && typeof s.value !== 'number')
      throw new Error(`the evaluator ${plugin.id} scored ${s.metric} without a value`);
    if (state === 'pending' && !ticket)
      throw new Error(`the evaluator ${plugin.id} answered ${s.metric} pending without a ticket`);
    return {
      evaluator: plugin.id,
      version: plugin.version,
      metric: s.metric,
      value: state === 'scored' ? (s.value as number) : null,
      applicable: state !== 'not-applicable',
      state,
      ...(s.reason ? { reason: s.reason } : {}),
      ...(state === 'pending' ? { details: { ticket } } : {}),
    };
  };

  return {
    id: plugin.id,
    version: plugin.version,
    kind: 'model',
    judge: plugin.id,
    evaluate: async (testCase, observation, ctx): Promise<Score[]> => {
      const reply = await ask(
        {
          case: {
            id: testCase.id,
            input: testCase.input,
            ...(testCase.expected.referenceAnswer
              ? { referenceAnswer: testCase.expected.referenceAnswer }
              : {}),
          },
          answer: observation.answer,
          sources: observation.citations.map((c) => ({
            ...(c.document ? { document: c.document } : {}),
            ...(c.chunkId ? { chunkId: c.chunkId } : {}),
          })),
        },
        judgeReply,
        ctx.signal,
      );
      return reply.scores.map((s) => scoreOf(s, reply.ticket));
    },
    collect: async (pending, { signal } = {}): Promise<CollectedScore[]> => {
      const ticketOf = (score: Score) => score.details?.ticket as string | undefined;
      const tickets = [...new Set(pending.flatMap((p) => ticketOf(p.score) ?? []))];
      const collected: CollectedScore[] = [];
      let failure: unknown;
      for (let i = 0; i < tickets.length; i += collectBatch) {
        let results: z.infer<typeof collectReply>['results'];
        try {
          ({ results } = await ask(
            { collect: { tickets: tickets.slice(i, i + collectBatch) } },
            collectReply,
            signal,
          ));
        } catch (error) {
          // What other batches brought in is kept; the runner asks again for what is still pending.
          failure = error;
          continue;
        }
        for (const result of results)
          for (const item of pending.filter((p) => ticketOf(p.score) === result.ticket)) {
            const found = result.scores.find((s) => s.metric === item.score.metric);
            if (!found) continue;
            let score: Score;
            try {
              score = scoreOf(found, result.ticket);
            } catch (error) {
              // One malformed score fails its own case, not every case the judge had pending.
              score = {
                ...item.score,
                state: 'failed',
                reason: error instanceof Error ? error.message : String(error),
              };
            }
            if (score.state !== 'pending')
              collected.push({ case: item.case, repeat: item.repeat, score });
          }
      }
      if (failure !== undefined && collected.length === 0) throw failure;
      return collected;
    },
  };
};
