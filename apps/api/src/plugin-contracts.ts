import type { Evaluator, Observation, Score, TestCase } from '@genai/eval';
import { check, checkFailsWith, type ContractSuite } from '@genai/plugins';
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

export const evaluatorContractVersion = 'evaluator@1';

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

export const evaluatorContract: ContractSuite<EvaluatorSubject> = {
  contract: evaluatorContractVersion,
  checks: [
    {
      name: 'an answer gets scores between 0 and 1, named by metric',
      run: async (s) => {
        const scores = await s.evaluator.evaluate(exampleCase, exampleObservation, evalContext);
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
      run: async (s) => {
        const scores = await s.evaluator.evaluate(exampleCase, exampleObservation, evalContext);
        const metrics = new Set(scores.map((x) => x.metric));
        const missing = s.metrics.filter((m) => !metrics.has(m));
        check(missing.length === 0, `missing metrics: ${missing.join(', ')}`);
      },
    },
  ],
};

const judgeReply = z.object({
  scores: z
    .array(
      z.object({
        metric: z.string().min(1).max(100),
        value: z.number().min(0).max(1).nullable(),
        reason: z.string().max(2000).optional(),
      }),
    )
    .max(50),
});

export type JudgeSend = (
  body: string,
  signal?: AbortSignal,
) => Promise<{ status: number; body: string }>;

export const httpJudge = (plugin: { id: string; version: string }, send: JudgeSend): Evaluator => ({
  id: plugin.id,
  version: plugin.version,
  kind: 'model',
  judge: plugin.id,
  evaluate: async (testCase, observation): Promise<Score[]> => {
    const response = await send(
      JSON.stringify({
        contract: evaluatorContractVersion,
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
      }),
    );
    if (response.status < 200 || response.status >= 300)
      throw new Error(`the evaluator ${plugin.id} answered HTTP ${response.status}`);
    const parsed = judgeReply.safeParse(JSON.parse(response.body));
    if (!parsed.success) throw new Error(`the evaluator ${plugin.id} answered in an unknown shape`);
    return parsed.data.scores.map((s) => ({
      evaluator: plugin.id,
      version: plugin.version,
      metric: s.metric,
      value: s.value,
      applicable: s.value !== null,
      ...(s.reason ? { reason: s.reason } : {}),
    }));
  },
});
