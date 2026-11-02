import { randomUUID } from 'node:crypto';
import {
  agreementMap,
  evaluatorOfJudge,
  judgedExpectation,
  testCase,
  type Observation,
  type PendingScore,
  type Score,
} from '@genai/eval';
import { describe, expect, it } from 'vitest';
import { langfuseJudges, type LangfuseJudge } from './judges.js';
import { judgeTraceIdOf } from './sink.js';
import { traceIdFor } from './spans.js';

interface FakeRule {
  id: string;
  name: string;
  enabled: boolean;
  sampling?: number;
  filter?: unknown[];
  evaluatorAssignments: {
    evaluatorId: string;
    variableMapping: { variable: string; source: string; jsonPath?: string }[] | null;
  }[];
}

interface FakeEvaluator {
  id: string;
  name: string;
  version: number;
  type?: string;
  status?: 'active' | 'paused';
  pausedMessage?: string | null;
  variableMapping?: { variable: string; source: string; jsonPath?: string }[];
  outputDefinition: { dataType: string };
  modelConfig: { provider: string; model: string } | null;
}

interface FakeScore {
  name: string;
  value: unknown;
  dataType: string;
  comment?: string;
  configId?: string | null;
  timestamp?: string;
  metadata: { job_configuration_id: string; job_execution_id?: string };
}

interface FakeGeneration {
  type: string;
  inputUsage: number;
  outputUsage: number;
  costDetails: Record<string, number>;
}

/** Langfuse 4.72.0's filter for a rule that judges each experiment item once, on its root span. */
const itemRoot = {
  type: 'boolean',
  column: 'isExperimentItemRootSpan',
  operator: '=',
  value: true,
};

const kriterieMapping = [
  { variable: 'input', source: 'input' },
  { variable: 'output', source: 'output' },
  { variable: 'criteria', source: 'expected_output', jsonPath: '$.criteria' },
];

/** A rule with one evaluator; mapping overrides the evaluator's, and filter goes beside item-root. */
const rule = (
  over: Partial<Omit<FakeRule, 'filter'>> & {
    mapping?: FakeEvaluator['variableMapping'] | null;
    evaluatorId?: string;
    filter?: unknown[];
    itemRoot?: boolean;
  } = {},
): FakeRule => {
  const { mapping, evaluatorId, filter, itemRoot: root, ...rest } = over;
  return {
    id: 'regel-1',
    name: 'svar_oppfyller_kriteriene-eksperimenter',
    enabled: true,
    sampling: 1,
    filter: [...(root === false ? [] : [itemRoot]), ...(filter ?? [])],
    evaluatorAssignments: [
      {
        evaluatorId: evaluatorId ?? 'dommer-1',
        variableMapping: mapping === undefined ? kriterieMapping : mapping,
      },
    ],
    ...rest,
  };
};

const evaluator = (over: Partial<FakeEvaluator> = {}): FakeEvaluator => ({
  id: 'dommer-1',
  name: 'svar_oppfyller_kriteriene',
  version: 1,
  type: 'llm_as_judge',
  status: 'active',
  pausedMessage: null,
  variableMapping: kriterieMapping,
  outputDefinition: { dataType: 'BOOLEAN' },
  modelConfig: { provider: 'foundry-claude', model: 'claude-sonnet-5' },
  ...over,
});

/** A Langfuse 4.72.0 project, answering as the local one did on 2026-11-02. */
const fakeLangfuse = (project: {
  rules: FakeRule[];
  evaluators: FakeEvaluator[];
  scores?: Record<string, FakeScore[]>;
  configs?: Record<string, { minValue?: number; maxValue?: number }>;
  /** The observations of each judge execution trace. */
  judgeTraces?: Record<string, FakeGeneration[]>;
  observationsDown?: () => boolean;
  /** The HTTP status the v2 evaluation routes answer with instead, such as 4.4.0's 404. */
  evaluationDown?: number;
  /** Items per page of the v2 listings. */
  pageSize?: number;
}): typeof fetch => {
  const page = <T>(items: T[], url: URL) => {
    const size = Math.min(project.pageSize ?? 100, Number(url.searchParams.get('limit') ?? '50'));
    const from = Number(url.searchParams.get('cursor') ?? '0');
    const next = from + size;
    return Response.json({
      data: items.slice(from, next),
      meta: next < items.length ? { cursor: String(next) } : {},
    });
  };
  return async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (/^\/api\/public\/v2\/(evaluation-rules|evaluators)/.test(path) && project.evaluationDown)
      return new Response('{}', { status: project.evaluationDown });
    if (path === '/api/public/v2/evaluation-rules') return page(project.rules, url);
    if (path === '/api/public/v2/evaluators') return page(project.evaluators, url);
    const ruleId = /^\/api\/public\/v2\/evaluation-rules\/(.+)$/.exec(path)?.[1];
    if (ruleId) {
      const found = project.rules.find((r) => r.id === ruleId);
      return found ? Response.json(found) : new Response('{}', { status: 404 });
    }
    const evaluatorId = /^\/api\/public\/v2\/evaluators\/(.+)$/.exec(path)?.[1];
    if (evaluatorId) {
      const found = project.evaluators.find((e) => e.id === evaluatorId);
      return found ? Response.json(found) : new Response('{}', { status: 404 });
    }
    const configId = /^\/api\/public\/score-configs\/(.+)$/.exec(path)?.[1];
    if (configId) {
      const found = project.configs?.[configId];
      return found
        ? Response.json({ id: configId, ...found })
        : new Response('{}', { status: 404 });
    }
    if (path === '/api/public/v2/observations') {
      if (project.observationsDown?.()) return new Response('{}', { status: 503 });
      const trace = url.searchParams.get('traceId') ?? '';
      return Response.json({ data: project.judgeTraces?.[trace] ?? [], meta: {} });
    }
    if (path === '/api/public/v3/scores') {
      const trace = url.searchParams.get('traceId') ?? '';
      return Response.json({
        data: (project.scores?.[trace] ?? []).map((s, i) => ({
          id: `score-${i}`,
          source: 'EVAL',
          timestamp: s.timestamp ?? '2026-10-30T08:00:00.000Z',
          ...s,
        })),
        meta: {},
      });
    }
    return new Response('{}', { status: 404 });
  };
};

const api = (fake: typeof fetch) => ({
  host: 'https://langfuse.etaten.example.no',
  publicKey: 'pk-lf-etaten',
  secretKey: 'sk-lf-etaten',
  fetch: fake,
});

const kriteriesak = testCase.parse({
  id: 'frist-klage',
  split: 'validation',
  input: 'Hvor lang er klagefristen?',
  expected: { criteria: { criteria: 'Svaret sier tre uker.' } },
});

const svar: Observation = { answer: 'Klagefristen er tre uker.', retrieved: [], citations: [] };
const ctx = { servedModels: [], modelFamily: () => undefined, run: 'kjøring-1', task: 'sak-1' };

const listed = async (fake: typeof fetch) => {
  const [judge] = await langfuseJudges(api(fake)).list('kudos');
  return judge as LangfuseJudge;
};

const pendingOf = (score: Score, task = 'sak-1'): PendingScore => ({
  case: 'frist-klage',
  repeat: 0,
  task,
  score,
});

describe('Langfuse judges', () => {
  it('takes only scores from the snapshotted rule, never a same-named score from another rule', async () => {
    const project = {
      rules: [rule()],
      evaluators: [evaluator()],
      scores: {
        [traceIdFor('sak-1')]: [
          {
            name: 'svar_oppfyller_kriteriene-eksperimenter',
            value: false,
            dataType: 'BOOLEAN',
            comment: 'Fra en annen regel med samme navn.',
            timestamp: '2026-10-30T08:00:05.000Z',
            metadata: { job_configuration_id: 'regel-annen' },
          },
          {
            name: 'svar_oppfyller_kriteriene-eksperimenter',
            value: true,
            dataType: 'BOOLEAN',
            comment: 'Svaret sier tre uker.',
            metadata: { job_configuration_id: 'regel-1' },
          },
        ],
      },
    };
    const judges = langfuseJudges(api(fakeLangfuse(project)));
    const judge = judges.evaluator(await listed(fakeLangfuse(project)), {
      tenant: 'dfo',
      content: true,
    });

    const [pending] = await judge.evaluate(kriteriesak, svar, ctx);
    const collected = await judge.collect?.([pendingOf(pending as Score)]);

    expect(pending).toMatchObject({
      state: 'pending',
      metric: 'langfuse:kudos/svar_oppfyller_kriteriene-eksperimenter',
    });
    expect(collected).toMatchObject([
      {
        case: 'frist-klage',
        repeat: 0,
        score: { state: 'scored', value: 1, reason: 'Svaret sier tre uker.' },
      },
    ]);
  });

  it('marks scores judge changed when the rule, its mapping, the evaluator version or its model changed since the start', async () => {
    const scores = {
      [traceIdFor('sak-1')]: [
        {
          name: 'svar_oppfyller_kriteriene-eksperimenter',
          value: true,
          dataType: 'BOOLEAN',
          metadata: { job_configuration_id: 'regel-1' },
        },
      ],
    };
    const atStart = await listed(fakeLangfuse({ rules: [rule()], evaluators: [evaluator()] }));
    const collectedAfter = async (project: { rules: FakeRule[]; evaluators: FakeEvaluator[] }) => {
      const judge = langfuseJudges(api(fakeLangfuse({ ...project, scores }))).evaluator(atStart, {
        tenant: 'dfo',
        content: true,
      });
      const [pending] = await judge.evaluate(kriteriesak, svar, ctx);
      const [collected] = (await judge.collect?.([pendingOf(pending as Score)])) ?? [];
      return collected?.score.details?.judgeChanged;
    };

    expect(await collectedAfter({ rules: [rule()], evaluators: [evaluator()] })).toBeUndefined();
    expect(
      await collectedAfter({
        rules: [rule({ mapping: [{ variable: 'output', source: 'output' }] })],
        evaluators: [evaluator()],
      }),
    ).toEqual(["the rule's mapping"]);
    expect(
      await collectedAfter({
        rules: [rule({ evaluatorId: 'dommer-2' })],
        evaluators: [evaluator({ id: 'dommer-2', version: 2 })],
      }),
    ).toEqual(["the rule's evaluator", "the evaluator's version 1 → 2"]);
    expect(
      await collectedAfter({
        rules: [rule()],
        evaluators: [
          evaluator({ modelConfig: { provider: 'foundry-claude', model: 'claude-opus-5' } }),
        ],
      }),
    ).toEqual([
      "the evaluator's model foundry-claude/claude-sonnet-5 → foundry-claude/claude-opus-5",
    ]);
    expect(await collectedAfter({ rules: [], evaluators: [evaluator()] })).toEqual([
      'the rule is gone',
    ]);
    expect(
      await collectedAfter({ rules: [rule({ enabled: false })], evaluators: [evaluator()] }),
    ).toEqual(['the rule is no longer active']);
    expect(
      await collectedAfter({ rules: [rule({ itemRoot: false })], evaluators: [evaluator()] }),
    ).toEqual(['the rule is no longer active']);
    expect(
      await collectedAfter({ rules: [rule()], evaluators: [evaluator({ status: 'paused' })] }),
    ).toEqual(["the rule's evaluator is paused"]);
  });

  it("keeps two agencies', or two connections', judges of the same name apart, scores and labels alike", async () => {
    const fake = fakeLangfuse({ rules: [rule()], evaluators: [evaluator()] });
    const judges = langfuseJudges(api(fake));
    const [kudos] = await judges.list('kudos');
    const [annen] = await judges.list('annen');
    if (!kudos || !annen) throw new Error('the rule was not listed');
    const dfo = judges.evaluator(kudos, { tenant: 'dfo', content: true });
    const nav = judges.evaluator(kudos, { tenant: 'nav', content: true });
    const dfoAnnen = judges.evaluator(annen, { tenant: 'dfo', content: true });
    const metricOf = async (e: typeof dfo) => (await e.evaluate(kriteriesak, svar, ctx))[0]?.metric;
    // Labels pool by a judge's evaluator, as a gate looks its agreement up.
    const agreement = agreementMap(
      ['a', 'b', 'c', 'd'].map((item, i) => ({
        item,
        judge: evaluatorOfJudge(dfo.judge as string),
        judgeLabel: i % 2 ? 'good' : 'bad',
        humanLabel: i % 2 ? 'good' : 'bad',
        labeller: 'merker-1',
      })),
    );
    const agreed = (judge: string) =>
      agreement.get(judge) ?? agreement.get(evaluatorOfJudge(judge));

    expect([dfo.judge, nav.judge, dfoAnnen.judge]).toEqual([
      'langfuse:dfo/kudos/svar_oppfyller_kriteriene-eksperimenter@v1+foundry-claude/claude-sonnet-5',
      'langfuse:nav/kudos/svar_oppfyller_kriteriene-eksperimenter@v1+foundry-claude/claude-sonnet-5',
      'langfuse:dfo/annen/svar_oppfyller_kriteriene-eksperimenter@v1+foundry-claude/claude-sonnet-5',
    ]);
    expect(await metricOf(dfo)).not.toBe(await metricOf(dfoAnnen));
    expect(agreed(dfo.judge as string)).toBe(1);
    expect(agreed(nav.judge as string)).toBeUndefined();
    expect(agreed(dfoAnnen.judge as string)).toBeUndefined();
  });

  it("refuses a judge on the project's or organisation's default model", async () => {
    const judge = await listed(
      fakeLangfuse({ rules: [rule()], evaluators: [evaluator({ modelConfig: null })] }),
    );

    expect(judge).toMatchObject({
      id: 'langfuse:kudos/svar_oppfyller_kriteriene-eksperimenter',
      refused: { reason: 'default-model' },
    });
    expect(judge.refused?.message).toMatch(/default model/);
  });

  it('refuses a judge whose mapping reads a field genki does not send, such as tool calls', async () => {
    const judge = await listed(
      fakeLangfuse({
        rules: [
          rule({
            mapping: [
              { variable: 'output', source: 'output' },
              { variable: 'verktøy', source: 'tool_calls' },
            ],
          }),
        ],
        evaluators: [evaluator()],
      }),
    );

    expect(judge.refused).toMatchObject({ reason: 'unsent-field', field: 'tool_calls' });
    expect(judge.refused?.message).toMatch(/tool_calls/);
    // The answer goes as its parts, so no path into it reads what the judge expects.
    const pathed = await listed(
      fakeLangfuse({
        rules: [rule({ mapping: [{ variable: 'svar', source: 'output', jsonPath: '$.text' }] })],
        evaluators: [evaluator()],
      }),
    );
    expect(pathed.refused).toMatchObject({ reason: 'unread-path', field: 'output $.text' });
  });

  it('refuses a judge that judges only some items, by sampling or a filter, or that is not an LLM judge', async () => {
    const refusedOf = async (r: FakeRule, e: FakeEvaluator = evaluator()) =>
      (await listed(fakeLangfuse({ rules: [r], evaluators: [e] }))).refused?.reason;

    expect(await refusedOf(rule({ sampling: 0.5 }))).toBe('sampled');
    expect(
      await refusedOf(
        rule({ filter: [{ type: 'string', column: 'name', operator: '=', value: 'x' }] }),
      ),
    ).toBe('filtered');
    expect(await refusedOf(rule(), evaluator({ type: 'code', modelConfig: null }))).toBe(
      'not-a-model',
    );
    expect(await refusedOf(rule({ sampling: 1 }))).toBeUndefined();
  });

  it('is not applicable on a case without the fields its mapping reads, on a connection without content, and on a holdout case', async () => {
    const fake = fakeLangfuse({ rules: [rule()], evaluators: [evaluator()] });
    const judges = langfuseJudges(api(fake));
    const listedJudge = await listed(fake);
    const withContent = judges.evaluator(listedJudge, { tenant: 'dfo', content: true });
    const withoutContent = judges.evaluator(listedJudge, { tenant: 'dfo', content: false });
    const utenKriterier = testCase.parse({
      id: 'uten-kriterier',
      split: 'validation',
      input: 'Hvor lang er klagefristen?',
      type: 'exact',
      expected: { referenceAnswer: 'tre uker' },
    });
    const holdout = testCase.parse({ ...kriteriesak, split: 'holdout' });
    const tomtSvar: Observation = { answer: '', retrieved: [], citations: [] };

    const states = async (scores: Promise<Score[]>) =>
      (await scores).map((s) => ({ state: s.state, reason: s.reason }));

    expect(await states(withContent.evaluate(utenKriterier, svar, ctx))).toEqual([
      { state: 'not-applicable', reason: 'the case has no expected_output $.criteria' },
    ]);
    expect(await states(withContent.evaluate(kriteriesak, tomtSvar, ctx))).toEqual([
      { state: 'not-applicable', reason: 'the case has no output' },
    ]);
    expect(await states(withoutContent.evaluate(kriteriesak, svar, ctx))).toEqual([
      { state: 'not-applicable', reason: 'the connection does not receive content' },
    ]);
    expect(await states(withContent.evaluate(holdout, svar, ctx))).toEqual([
      { state: 'not-applicable', reason: 'holdout cases are never sent' },
    ]);
    expect(await states(withContent.evaluate(kriteriesak, svar, ctx))).toEqual([
      { state: 'pending', reason: undefined },
    ]);
  });

  it("reads a criteria case's reference answer as its criteria when it names none, as genki's criteria judge does", async () => {
    const fake = fakeLangfuse({ rules: [rule()], evaluators: [evaluator()] });
    const judge = langfuseJudges(api(fake)).evaluator(await listed(fake), {
      tenant: 'dfo',
      content: true,
    });
    const golden = testCase.parse({
      id: 'frist-gull',
      split: 'validation',
      input: 'Hvor lang er klagefristen?',
      expected: { referenceAnswer: 'Klagefristen er tre uker.' },
    });

    expect(judgedExpectation(golden)).toEqual({ criteria: 'Klagefristen er tre uker.' });
    expect((await judge.evaluate(golden, svar, ctx))[0]).toMatchObject({ state: 'pending' });
  });

  it('stores tokens only for a model Langfuse does not price', async () => {
    const scoreOn = (task: string, execution: string) => ({
      [traceIdFor(task)]: [
        {
          name: 'svar_oppfyller_kriteriene-eksperimenter',
          value: true,
          dataType: 'BOOLEAN',
          metadata: { job_configuration_id: 'regel-1', job_execution_id: execution },
        },
      ],
    });
    const generation = (costDetails: Record<string, number>): FakeGeneration => ({
      type: 'GENERATION',
      inputUsage: 1200,
      outputUsage: 300,
      costDetails,
    });
    const project = {
      rules: [rule()],
      evaluators: [evaluator()],
      scores: { ...scoreOn('sak-1', 'jobb-1'), ...scoreOn('sak-2', 'jobb-2') },
      judgeTraces: {
        [judgeTraceIdOf('jobb-1')]: [
          generation({ input: 0.0024, output: 0.003, total: 0.0054 }),
          { type: 'SPAN', inputUsage: 0, outputUsage: 0, costDetails: {} },
        ],
        // A model Langfuse has no price for: its tokens count, its cost is unknown.
        [judgeTraceIdOf('jobb-2')]: [generation({})],
      },
    };
    const judge = langfuseJudges(api(fakeLangfuse(project))).evaluator(
      await listed(fakeLangfuse(project)),
      { tenant: 'dfo', content: true },
    );
    const [first] = await judge.evaluate(kriteriesak, svar, ctx);
    const [second] = await judge.evaluate(kriteriesak, svar, { ...ctx, task: 'sak-2' });

    await judge.collect?.([pendingOf(first as Score), pendingOf(second as Score, 'sak-2')]);

    expect(judge.reportedUsage?.()).toEqual({
      'langfuse:kudos/svar_oppfyller_kriteriene-eksperimenter': {
        inputTokens: 2400,
        outputTokens: 600,
        costUsd: 0.0054,
        unpriced: 1,
        unread: 0,
      },
    });
  });

  it("counts every judge call Langfuse made on the run's cases once, its own judges' apart from the project's other judges", async () => {
    const call = (cost: number): FakeGeneration => ({
      type: 'GENERATION',
      inputUsage: 1000,
      outputUsage: 100,
      costDetails: { total: cost },
    });
    const scored = (rule: string, execution: string): FakeScore => ({
      name: rule,
      value: true,
      dataType: 'BOOLEAN',
      metadata: { job_configuration_id: rule, job_execution_id: execution },
    });
    const sitater = rule({
      id: 'regel-2',
      name: 'svar_siterer-eksperimenter',
      mapping: [
        { variable: 'sitater', source: 'expected_output', jsonPath: '$.supporting_quotes' },
      ],
    });
    const project = {
      rules: [rule(), sitater, rule({ id: 'regel-3', name: 'tone-eksperimenter' })],
      evaluators: [evaluator()],
      // Every active judge in the project judges the case, also those genki does not use.
      scores: {
        [traceIdFor('sak-1')]: [
          scored('regel-1', 'jobb-1'),
          scored('regel-2', 'jobb-2'),
          scored('regel-3', 'jobb-3'),
        ],
      },
      judgeTraces: {
        [judgeTraceIdOf('jobb-1')]: [call(0.001)],
        [judgeTraceIdOf('jobb-2')]: [call(0.002)],
        [judgeTraceIdOf('jobb-3')]: [call(0.004)],
      },
    };
    const judges = langfuseJudges(api(fakeLangfuse(project)));
    const [kriterier, siterer] = await langfuseJudges(api(fakeLangfuse(project))).list('kudos');
    const first = judges.evaluator(kriterier as LangfuseJudge, { tenant: 'dfo', content: true });
    const second = judges.evaluator(siterer as LangfuseJudge, { tenant: 'dfo', content: true });
    const [pending] = await first.evaluate(kriteriesak, svar, ctx);
    // The second judge cannot read the case, yet Langfuse judged it and billed the call.
    expect((await second.evaluate(kriteriesak, svar, ctx))[0]?.state).toBe('not-applicable');

    await first.collect?.([pendingOf(pending as Score)]);
    await first.collect?.([pendingOf(pending as Score)]);
    const usage = (cost: number) => ({
      inputTokens: 1000,
      outputTokens: 100,
      costUsd: cost,
      unpriced: 0,
      unread: 0,
    });

    expect(first.reportedUsage?.()).toEqual({
      'langfuse:kudos/svar_oppfyller_kriteriene-eksperimenter': usage(0.001),
      'langfuse:kudos/svar_siterer-eksperimenter': usage(0.002),
      'langfuse:kudos': usage(0.004),
    });
    expect(second.reportedUsage?.()).toEqual(first.reportedUsage?.());
  });

  it("counts a project judge that scores after the run's own judges, and shows the amount as at least for one that never does", async () => {
    const call = (cost: number): FakeGeneration => ({
      type: 'GENERATION',
      inputUsage: 1000,
      outputUsage: 100,
      costDetails: { total: cost },
    });
    const scored = (rule: string, execution: string): FakeScore => ({
      name: rule,
      value: true,
      dataType: 'BOOLEAN',
      metadata: { job_configuration_id: rule, job_execution_id: execution },
    });
    const onTrace: FakeScore[] = [scored('regel-1', 'jobb-1')];
    const project = {
      rules: [
        rule(),
        rule({ id: 'regel-3', name: 'tone-eksperimenter' }),
        rule({ id: 'regel-4', name: 'lengde-eksperimenter' }),
      ],
      evaluators: [evaluator()],
      scores: { [traceIdFor('sak-1')]: onTrace },
      judgeTraces: {
        [judgeTraceIdOf('jobb-1')]: [call(0.001)],
        [judgeTraceIdOf('jobb-3')]: [call(0.004)],
      },
    };
    const judges = langfuseJudges(api(fakeLangfuse(project)));
    judges.expectJudges(['regel-1', 'regel-3', 'regel-4']);
    const judge = judges.evaluator(await listed(fakeLangfuse(project)), {
      tenant: 'dfo',
      content: true,
    });
    const [pending] = await judge.evaluate(kriteriesak, svar, ctx);

    await judge.collect?.([pendingOf(pending as Score)]);
    // The tone judge scores after the run's own judge has; the length judge never does.
    onTrace.push(scored('regel-3', 'jobb-3'));
    await judge.settle?.();

    expect(judge.reportedUsage?.()).toEqual({
      'langfuse:kudos/svar_oppfyller_kriteriene-eksperimenter': {
        inputTokens: 1000,
        outputTokens: 100,
        costUsd: 0.001,
        unpriced: 0,
        unread: 0,
      },
      'langfuse:kudos': {
        inputTokens: 1000,
        outputTokens: 100,
        costUsd: 0.004,
        unpriced: 0,
        unread: 1,
      },
    });
  });

  it("keeps a judge's score when its cost cannot be read, and counts the cost when a later read finds it", async () => {
    let down = true;
    const project = {
      rules: [rule()],
      evaluators: [evaluator()],
      scores: {
        [traceIdFor('sak-1')]: [
          {
            name: 'svar_oppfyller_kriteriene-eksperimenter',
            value: true,
            dataType: 'BOOLEAN',
            metadata: { job_configuration_id: 'regel-1', job_execution_id: 'jobb-1' },
          },
        ],
      },
      judgeTraces: {
        [judgeTraceIdOf('jobb-1')]: [
          { type: 'GENERATION', inputUsage: 900, outputUsage: 90, costDetails: { total: 0.002 } },
        ],
      },
      observationsDown: () => down,
    };
    const judge = langfuseJudges(api(fakeLangfuse(project))).evaluator(
      await listed(fakeLangfuse(project)),
      { tenant: 'dfo', content: true },
    );
    const [pending] = await judge.evaluate(kriteriesak, svar, ctx);
    const [later] = await judge.evaluate(kriteriesak, svar, { ...ctx, task: 'sak-2' });

    const collected = await judge.collect?.([pendingOf(pending as Score)]);
    const unread = judge.reportedUsage?.();
    down = false;
    await judge.collect?.([pendingOf(later as Score, 'sak-2')]);

    expect(collected).toMatchObject([{ score: { state: 'scored', value: 1 } }]);
    expect(unread).toEqual({
      'langfuse:kudos/svar_oppfyller_kriteriene-eksperimenter': {
        inputTokens: 0,
        outputTokens: 0,
        costUsd: null,
        unpriced: 0,
        unread: 1,
      },
    });
    expect(judge.reportedUsage?.()).toEqual({
      'langfuse:kudos/svar_oppfyller_kriteriene-eksperimenter': {
        inputTokens: 900,
        outputTokens: 90,
        costUsd: 0.002,
        unpriced: 0,
        unread: 0,
      },
    });
  });

  it("reads a boolean as 1 or 0, scales a number by its config's bounds, and keeps a category as it came", async () => {
    const valueOf = async (score: FakeScore, dataType: string) => {
      const project = {
        rules: [rule()],
        evaluators: [evaluator({ outputDefinition: { dataType } })],
        scores: { [traceIdFor('sak-1')]: [score] },
        configs: { 'skala-1-5': { minValue: 1, maxValue: 5 } },
      };
      const judge = langfuseJudges(api(fakeLangfuse(project))).evaluator(
        await listed(fakeLangfuse(project)),
        { tenant: 'dfo', content: true },
      );
      const [pending] = await judge.evaluate(kriteriesak, svar, ctx);
      const [collected] = (await judge.collect?.([pendingOf(pending as Score)])) ?? [];
      const s = collected?.score;
      return { state: s?.state, value: s?.value, asItCame: s?.details?.asItCame };
    };
    const fra = (value: unknown, dataType: string, configId: string | null = null): FakeScore => ({
      name: 'svar_oppfyller_kriteriene-eksperimenter',
      value,
      dataType,
      configId,
      metadata: { job_configuration_id: 'regel-1' },
    });

    expect(await valueOf(fra(true, 'BOOLEAN'), 'BOOLEAN')).toEqual({
      state: 'scored',
      value: 1,
      asItCame: undefined,
    });
    expect(await valueOf(fra(false, 'BOOLEAN'), 'BOOLEAN')).toEqual({
      state: 'scored',
      value: 0,
      asItCame: undefined,
    });
    expect(await valueOf(fra(4, 'NUMERIC', 'skala-1-5'), 'NUMERIC')).toEqual({
      state: 'scored',
      value: 0.75,
      asItCame: undefined,
    });
    expect(await valueOf(fra(4, 'NUMERIC'), 'NUMERIC')).toEqual({
      state: 'scored',
      value: null,
      asItCame: 4,
    });
    expect(await valueOf(fra('delvis', 'CATEGORICAL'), 'CATEGORICAL')).toEqual({
      state: 'scored',
      value: null,
      asItCame: 'delvis',
    });
  });
  it('reads every page of rules and evaluators through the v2 API, and lists an enabled rule with one active LLM judge and the item-root filter as a judge', async () => {
    const others = Array.from({ length: 4 }, (_, i) =>
      evaluator({ id: `annen-${i}`, name: `annen_${i}` }),
    );
    const judges = await langfuseJudges(
      api(
        fakeLangfuse({
          // The judge's rule and evaluator sit on the last pages.
          rules: [
            rule({ id: 'av', name: 'avslått', enabled: false }),
            rule({ id: 'av-2', name: 'avslått_2', enabled: false }),
            rule(),
          ],
          evaluators: [...others, evaluator()],
          pageSize: 2,
        }),
      ),
    ).list('kudos');

    expect(judges).toEqual([
      {
        id: 'langfuse:kudos/svar_oppfyller_kriteriene-eksperimenter',
        connection: 'kudos',
        rule: {
          id: 'regel-1',
          name: 'svar_oppfyller_kriteriene-eksperimenter',
          mapping: [
            { variable: 'input', source: 'input' },
            { variable: 'output', source: 'output' },
            { variable: 'criteria', source: 'expected_output', jsonPath: '$.criteria' },
          ],
        },
        evaluator: {
          id: 'dommer-1',
          name: 'svar_oppfyller_kriteriene',
          version: 1,
          dataType: 'BOOLEAN',
          model: { provider: 'foundry-claude', model: 'claude-sonnet-5' },
        },
      },
    ]);
  });

  it("takes the rule's own variable mapping over its evaluator's, and the evaluator's when the rule has none", async () => {
    const own = [{ variable: 'output', source: 'output' }];
    const mappingOf = async (mapping: typeof own | null) =>
      (await listed(fakeLangfuse({ rules: [rule({ mapping })], evaluators: [evaluator()] }))).rule
        .mapping;

    expect(await mappingOf(own)).toEqual(own);
    expect(await mappingOf(null)).toEqual(evaluator().variableMapping);
  });

  it('refuses the run for an enabled rule without the item-root filter, and refuses a non-LLM judge', async () => {
    const judges = langfuseJudges(
      api(
        fakeLangfuse({
          rules: [
            rule(),
            // Judges every span of a case: three times on a trace with a retrieval and a generation.
            rule({ id: 'regel-2', name: 'alle_spenn', itemRoot: false }),
            rule({ id: 'regel-3', name: 'kode', evaluatorId: 'kode-1' }),
            rule({ id: 'regel-4', name: 'av', itemRoot: false, enabled: false }),
          ],
          evaluators: [evaluator(), evaluator({ id: 'kode-1', type: 'code', modelConfig: null })],
        }),
      ),
    );

    expect((await judges.forRun('kudos', brev)).refusing.map((r) => r.name)).toEqual([
      'alle_spenn',
    ]);
    expect((await judges.list('kudos')).map((j) => [j.rule.name, j.refused?.reason])).toEqual([
      ['svar_oppfyller_kriteriene-eksperimenter', undefined],
      ['kode', 'not-a-model'],
    ]);
  });

  it("neither lists nor counts a rule whose evaluator is paused, and refuses it by Langfuse's message when read for a run", async () => {
    const pausedMessage =
      'Evaluator paused: no default evaluation model is configured. Set a default evaluation model or update the evaluator template, then reactivate it.';
    const judges = langfuseJudges(
      api(
        fakeLangfuse({
          rules: [rule(), rule({ id: 'regel-2', name: 'alle_spenn', itemRoot: false })],
          evaluators: [evaluator({ status: 'paused', pausedMessage })],
        }),
      ),
    );
    const listedJudges = await judges.list('kudos');

    expect((await judges.forRun('kudos', brev)).refusing.map((r) => r.name)).toEqual([]);
    // Langfuse does not run it, so no screen lists it; a run that uses it reads why.
    expect(listedJudges.map((j) => j.refused)).toEqual([
      { reason: 'paused', message: pausedMessage },
    ]);
  });

  it('refuses a rule with more than one evaluator, or with a filter outside the measured schema', async () => {
    const several = rule();
    several.evaluatorAssignments.push({ evaluatorId: 'dommer-2', variableMapping: null });
    const refusedOf = async (r: FakeRule) =>
      (
        await listed(
          fakeLangfuse({ rules: [r], evaluators: [evaluator(), evaluator({ id: 'dommer-2' })] }),
        )
      ).refused?.reason;

    expect(await refusedOf(several)).toBe('several-evaluators');
    expect(
      await refusedOf(
        rule({
          filter: [{ type: 'string', column: 'datasetId', operator: 'starts with', value: 'd' }],
        }),
      ),
    ).toBe('filtered');
    // What the upgrade from 4.4.0 leaves beside the item-root filter of a rule on a dataset is read.
    expect(
      await refusedOf(
        rule({
          filter: [
            { type: 'stringOptions', column: 'datasetId', operator: 'any of', value: ['d'] },
          ],
        }),
      ),
    ).toBeUndefined();
  });

  it('counts a rule as unreadable when one of its several evaluators is still active, or its evaluator is not listed', async () => {
    const several = rule({ id: 'regel-2', name: 'to_evaluatorer' });
    several.evaluatorAssignments = [
      { evaluatorId: 'pause-1', variableMapping: null },
      { evaluatorId: 'dommer-1', variableMapping: null },
    ];
    const judges = langfuseJudges(
      api(
        fakeLangfuse({
          rules: [
            several,
            rule({ id: 'regel-3', name: 'ukjent_evaluator', evaluatorId: 'borte-1' }),
            rule({
              id: 'regel-4',
              name: 'ukjent_alle_spenn',
              evaluatorId: 'borte-1',
              itemRoot: false,
            }),
          ],
          evaluators: [evaluator(), evaluator({ id: 'pause-1', status: 'paused' })],
        }),
      ),
    );

    // Langfuse still runs the active one, so the rule is refused, never dropped as paused.
    expect((await judges.list('kudos')).map((j) => [j.rule.name, j.refused?.reason])).toEqual([
      ['to_evaluatorer', 'several-evaluators'],
    ]);
    expect((await judges.forRun('kudos', brev)).refusing.map((r) => r.name)).toEqual([
      'ukjent_evaluator',
      'ukjent_alle_spenn',
    ]);
    // With every one of them paused, Langfuse runs nothing: the rule is paused.
    const allPaused = rule({ id: 'regel-5', name: 'alle_pauset' });
    allPaused.evaluatorAssignments = [
      { evaluatorId: 'pause-1', variableMapping: null },
      { evaluatorId: 'pause-2', variableMapping: null },
    ];
    const paused = langfuseJudges(
      api(
        fakeLangfuse({
          rules: [allPaused],
          evaluators: [
            evaluator({ id: 'pause-1', status: 'paused' }),
            evaluator({ id: 'pause-2', status: 'paused' }),
          ],
        }),
      ),
    );
    expect((await paused.list('kudos')).map((j) => j.refused?.reason)).toEqual(['paused']);
    expect((await paused.forRun('kudos', brev)).refusing.map((r) => r.name)).toEqual([]);
  });

  it('refuses judges whose rules share a name, which genki cannot tell apart', async () => {
    const judges = await langfuseJudges(
      api(
        fakeLangfuse({
          rules: [rule(), rule({ id: 'regel-2' })],
          evaluators: [evaluator()],
        }),
      ),
    ).list('kudos');

    expect(judges.map((j) => [j.rule.id, j.refused?.reason])).toEqual([
      ['regel-1', 'same-name'],
      ['regel-2', 'same-name'],
    ]);
  });

  it('names a score name that two rules write as shared, also when their evaluators differ', async () => {
    const shared = await langfuseJudges(
      api(
        fakeLangfuse({
          rules: [
            rule(),
            rule({ id: 'regel-2', name: 'kopi', evaluatorId: 'dommer-2' }),
            rule({ id: 'regel-3', name: 'av', enabled: false }),
          ],
          evaluators: [evaluator(), evaluator({ id: 'dommer-2' })],
        }),
      ),
    ).shared();

    expect(shared).toEqual([
      {
        name: 'svar_oppfyller_kriteriene',
        rules: ['svar_oppfyller_kriteriene-eksperimenter', 'kopi'],
      },
    ]);
  });

  it('throws when the rules or evaluators cannot be read (404, 401 or 5xx), never reading them as no rules', async () => {
    for (const status of [404, 401, 503]) {
      const judges = langfuseJudges(
        api(fakeLangfuse({ rules: [rule()], evaluators: [evaluator()], evaluationDown: status })),
      );
      await expect(judges.list('kudos')).rejects.toThrow(`HTTP ${status}`);
      await expect(judges.forRun('kudos', brev)).rejects.toThrow(`HTTP ${status}`);
    }
  });

  it("names each score after the judge's evaluator, as Langfuse names it", async () => {
    const project = {
      rules: [rule({ name: 'regel_98c_navnesjekk' })],
      evaluators: [evaluator()],
      scores: {
        [traceIdFor('sak-1')]: [
          {
            name: 'svar_oppfyller_kriteriene',
            value: true,
            dataType: 'BOOLEAN',
            metadata: { job_configuration_id: 'regel-1' },
          },
        ],
      },
    };
    const judge = langfuseJudges(api(fakeLangfuse(project))).evaluator(
      await listed(fakeLangfuse(project)),
      { tenant: 'dfo', content: true },
    );
    const [pending] = await judge.evaluate(kriteriesak, svar, ctx);
    const [collected] = (await judge.collect?.([pendingOf(pending as Score)])) ?? [];

    expect(pending?.details?.scoreName).toBe('svar_oppfyller_kriteriene');
    expect(collected?.score.details?.scoreName).toBe('svar_oppfyller_kriteriene');
  });
});

const liveHost = process.env.LANGFUSE_LOCAL_URL;

describe.skipIf(!liveHost)('judges on a local Langfuse 4.72.0', () => {
  it("reads the filters of a live Langfuse 4.72.0's rules: a judge of the test set, another test set's judge, a rule on every span", async () => {
    const live = {
      host: liveHost as string,
      publicKey: process.env.LANGFUSE_LOCAL_PUBLIC_KEY ?? 'pk-lf-genki-472',
      secretKey: process.env.LANGFUSE_LOCAL_SECRET_KEY ?? 'sk-lf-genki-472',
    };
    const authorization = `Basic ${Buffer.from(`${live.publicKey}:${live.secretKey}`).toString('base64')}`;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(new URL(path, live.host), {
        method,
        headers: { authorization, 'content-type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error(`${method} ${path}: HTTP ${response.status}`);
      return (await response.json()) as Record<string, unknown>;
    };
    const evaluators = (await call('GET', '/api/public/v2/evaluators?limit=100')).data as {
      id: string;
      name: string;
      status: string;
      type: string;
      modelConfig: unknown;
    }[];
    const judge = evaluators.find(
      (e) => e.status === 'active' && e.type === 'llm_as_judge' && e.modelConfig,
    );
    if (!judge) throw new Error('the local Langfuse needs an active LLM evaluator with a model');
    const suffix = randomUUID().slice(0, 8);
    const created: string[] = [];
    const ruleOf = async (name: string, filter: unknown[]) => {
      const rule = await call('POST', '/api/public/v2/evaluation-rules', {
        name,
        enabled: true,
        sampling: 1,
        filter,
        evaluatorAssignments: [{ evaluatorId: judge.id, variableMapping: null }],
      });
      created.push(String(rule.id));
    };
    try {
      await ruleOf(`genki_live_item_${suffix}`, [itemRoot, onDataset()]);
      await ruleOf(`genki_live_other_${suffix}`, [itemRoot, onDataset('datasett-vedtak')]);
      await ruleOf(`genki_live_spans_${suffix}`, [onDataset()]);
      await ruleOf(`genki_live_env_${suffix}`, [
        filterOf('environment', 'none of', ['genki-test-runs']),
      ]);
      const judges = langfuseJudges(live);

      const listedJudges = await judges.list('lokal');
      const found = await judges.forRun('lokal', brev);
      const names = (list: { rule: { name: string } }[]) => list.map((j) => j.rule.name);
      const refusing = found.refusing.map((r) => r.name);

      expect(listedJudges.find((j) => j.rule.name === `genki_live_item_${suffix}`)).toMatchObject({
        id: `langfuse:lokal/genki_live_item_${suffix}`,
        evaluator: { id: judge.id, name: judge.name },
      });
      expect(names(found.judges)).toContain(`genki_live_item_${suffix}`);
      expect(names(found.elsewhere)).toContain(`genki_live_other_${suffix}`);
      expect(refusing).toContain(`genki_live_spans_${suffix}`);
      expect([...names(found.judges), ...names(found.elsewhere), ...refusing]).not.toContain(
        `genki_live_env_${suffix}`,
      );
    } finally {
      for (const id of created) await call('DELETE', `/api/public/v2/evaluation-rules/${id}`);
    }
  });
});

/** A sent run of the test set klarsprak-brev v4, linked to its dataset. */
const brev = {
  tenant: '991825827',
  dataset: 'datasett-brev',
  environment: 'genki-test-runs',
  experimentName: 'klarsprak-brev v4',
};

const filterOf = (column: string, operator: string, value: unknown, type = 'stringOptions') => ({
  type,
  column,
  operator,
  value,
});

const onDataset = (id = brev.dataset) => filterOf('datasetId', 'any of', [id]);

/** What forRun makes of each rule: judge, skip, or the refusal's text. */
const outcomeOf = async (rules: FakeRule[], run = brev) => {
  const found = await langfuseJudges(
    api(fakeLangfuse({ rules, evaluators: [evaluator()] })),
  ).forRun('kudos', run);
  return Object.fromEntries([
    ...found.judges.map((j) => [j.rule.name, 'judge']),
    ...found.elsewhere.map((j) => [j.rule.name, 'skip']),
    ...found.refusing.map((r) => [r.name, r.message]),
  ]) as Record<string, string>;
};

describe("Langfuse rules' filters, read for a run", () => {
  it("skips a rule whose datasetId filter names another test set's dataset", async () => {
    const found = await langfuseJudges(
      api(
        fakeLangfuse({
          rules: [rule({ name: 'vedtak', filter: [onDataset('datasett-vedtak')] })],
          evaluators: [evaluator()],
        }),
      ),
    ).forRun('kudos', brev);

    expect(found.judges).toEqual([]);
    expect(found.refusing).toEqual([]);
    expect(found.elsewhere.map((j) => j.rule.name)).toEqual(['vedtak']);
  });

  it("takes a rule filtered on this test set's dataset and the item root for a judge", async () => {
    const found = await langfuseJudges(
      api(fakeLangfuse({ rules: [rule({ filter: [onDataset()] })], evaluators: [evaluator()] })),
    ).forRun('kudos', brev);

    expect(found.judges.map((j) => [j.rule.name, j.refused])).toEqual([
      ['svar_oppfyller_kriteriene-eksperimenter', undefined],
    ]);
    expect(found.elsewhere).toEqual([]);
    expect(found.refusing).toEqual([]);
  });

  it('refuses the run for a rule that only filters on the dataset, since it judges every span', async () => {
    const outcome = await outcomeOf([
      rule({ name: 'alle_spenn', itemRoot: false, filter: [onDataset()] }),
    ]);

    expect(outcome.alle_spenn).toMatch(/alle_spenn would judge every span/);
    expect(outcome.alle_spenn).toMatch(/isExperimentItemRootSpan = true/);
  });

  it("skips a rule that leaves genki's test runs out by environment", async () => {
    expect(
      await outcomeOf([
        rule({
          name: 'live',
          itemRoot: false,
          filter: [filterOf('environment', 'none of', ['genki-test-runs'])],
        }),
        rule({
          id: 'regel-2',
          name: 'prod',
          itemRoot: false,
          filter: [filterOf('environment', 'any of', ['production'])],
        }),
      ]),
    ).toEqual({});
  });

  it('skips a rule filtered on a trace name genki does not use', async () => {
    // Digdir's live judges: genki's trace name is its draft's id, new for each run.
    expect(
      await outcomeOf([
        rule({
          name: 'kunnskapsassistent_relevans',
          itemRoot: false,
          filter: [filterOf('traceName', 'any of', ['991825827/kunnskapsassistent'])],
        }),
      ]),
    ).toEqual({});
  });

  it('refuses the run for a rule filtered on a name alone, since genki names only the root span in advance', async () => {
    const outcome = await outcomeOf([
      rule({
        name: 'navn',
        itemRoot: false,
        filter: [filterOf('name', 'any of', ['991825827/kunnskapsassistent'])],
      }),
    ]);

    expect(outcome.navn).toMatch(/navn would judge every span/);
  });

  it('skips an item-root rule filtered on a name the root span does not have', async () => {
    expect(
      await outcomeOf([rule({ filter: [filterOf('name', 'any of', ['kunnskapsassistent'])] })]),
    ).toEqual({ 'svar_oppfyller_kriteriene-eksperimenter': 'skip' });
  });

  it('reads every operator of the measured filter schema the way Langfuse does', async () => {
    // Each filter beside the item-root filter: true lets the run's root span through, false not.
    const cases: [ReturnType<typeof filterOf>, boolean][] = [
      [filterOf('datasetId', 'any of', ['datasett-brev', 'x']), true],
      [filterOf('datasetId', 'none of', ['datasett-brev']), false],
      [filterOf('environment', 'none of', ['production']), true],
      [filterOf('type', 'any of', ['AGENT']), true],
      [filterOf('type', 'none of', ['AGENT']), false],
      [filterOf('traceName', 'none of', ['kunnskapsassistent']), true],
      [filterOf('name', 'none of', ['kunnskapsassistent']), true],
      [filterOf('experimentName', '=', 'klarsprak-brev v4', 'string'), true],
      [filterOf('experimentName', '=', 'klarsprak-brev v3', 'string'), false],
      [filterOf('experimentName', 'contains', '-brev', 'string'), true],
      [filterOf('experimentName', 'does not contain', '-brev', 'string'), false],
      [filterOf('experimentName', 'starts with', 'klarsprak-brev', 'string'), true],
      [filterOf('experimentName', 'ends with', 'v3', 'string'), false],
      [filterOf('experimentName', 'is not empty', '', 'string'), true],
      [filterOf('tags', 'any of', ['tenant:991825827'], 'arrayOptions'), true],
      [filterOf('tags', 'none of', ['tenant:991825827'], 'arrayOptions'), false],
      [filterOf('tags', 'all of', ['tenant:991825827', 'production'], 'arrayOptions'), false],
      [filterOf('isRootObservation', '=', true, 'boolean'), true],
      [filterOf('isRootObservation', '<>', true, 'boolean'), false],
      [filterOf('parentObservationId', 'is null', '', 'null'), true],
      [filterOf('parentObservationId', 'is not null', '', 'null'), false],
    ];
    for (const [filter, through] of cases)
      expect(
        (await outcomeOf([rule({ filter: [filter] })]))['svar_oppfyller_kriteriene-eksperimenter'],
        `${filter.column} ${filter.operator} ${JSON.stringify(filter.value)}`,
      ).toBe(through ? 'judge' : 'skip');
    // <> false on the item-root column is the item-root filter too.
    expect(
      await outcomeOf([
        rule({
          itemRoot: false,
          filter: [filterOf('isExperimentItemRootSpan', '<>', false, 'boolean'), onDataset()],
        }),
      ]),
    ).toEqual({ 'svar_oppfyller_kriteriene-eksperimenter': 'judge' });
  });

  it('refuses the run for a filter on a column genki cannot know before the run, naming the rule', async () => {
    const outcome = await outcomeOf([
      rule({
        name: 'modell',
        filter: [onDataset(), filterOf('providedModelName', 'contains', 'gpt', 'string')],
      }),
      // Another filter leaves the run out, so what genki cannot know does not matter.
      rule({
        id: 'regel-2',
        name: 'live_feil',
        itemRoot: false,
        filter: [
          filterOf('environment', 'none of', ['genki-test-runs']),
          filterOf('level', 'any of', ['ERROR']),
        ],
      }),
    ]);

    expect(outcome).toEqual({
      modell: expect.stringMatching(/modell has a filter on providedModelName/) as string,
    });
  });

  it('refuses the run for an operator or value type outside the measured schema', async () => {
    const outcome = await outcomeOf([
      rule({ name: 'ukjent_operator', filter: [filterOf('datasetId', 'starts with', ['d'])] }),
      rule({
        id: 'regel-2',
        name: 'ukjent_type',
        filter: [filterOf('datasetId', 'any of', 'datasett-brev')],
      }),
      rule({
        id: 'regel-3',
        name: 'ukjent_kolonne',
        filter: [filterOf('promptLabel', 'any of', ['prod'])],
      }),
    ]);

    expect(Object.keys(outcome).sort()).toEqual([
      'ukjent_kolonne',
      'ukjent_operator',
      'ukjent_type',
    ]);
    expect(outcome.ukjent_operator).toMatch(/a filter on datasetId that genki cannot read/);
  });

  it('skips a rule pinned to another experiment id, and lets none of through', async () => {
    expect(
      await outcomeOf([
        rule({ name: 'en_kjoring', filter: [filterOf('experimentId', 'any of', ['kjøring-1'])] }),
        rule({
          id: 'regel-2',
          name: 'ikke_en_kjoring',
          filter: [onDataset(), filterOf('experimentId', 'none of', ['kjøring-1'])],
        }),
      ]),
    ).toEqual({ en_kjoring: 'skip', ikke_en_kjoring: 'judge' });
  });

  it("skips a rule filtered on tags genki's traces do not carry", async () => {
    expect(
      await outcomeOf([
        rule({
          name: 'prod_tagg',
          itemRoot: false,
          filter: [filterOf('tags', 'any of', ['production'], 'arrayOptions')],
        }),
      ]),
    ).toEqual({});
  });

  it('does not take a rule that reaches only the root through isRootObservation for a judge', async () => {
    const outcome = await outcomeOf([
      rule({
        name: 'rot',
        itemRoot: false,
        filter: [onDataset(), filterOf('isRootObservation', '=', true, 'boolean')],
      }),
    ]);

    expect(outcome.rot).toMatch(
      /rot judges the run's root spans without isExperimentItemRootSpan = true/,
    );
  });

  it('takes an item-root rule without a dataset filter for a judge of every test set', async () => {
    expect(await outcomeOf([rule()])).toEqual({
      'svar_oppfyller_kriteriene-eksperimenter': 'judge',
    });
    expect(
      await outcomeOf([rule()], {
        ...brev,
        dataset: 'datasett-vedtak',
        experimentName: 'vedtak v1',
      }),
    ).toEqual({ 'svar_oppfyller_kriteriene-eksperimenter': 'judge' });
  });

  it("says the judge changed when its filter no longer reaches the run's dataset", async () => {
    const project = {
      rules: [rule({ filter: [onDataset()] })],
      evaluators: [evaluator()],
      scores: {
        [traceIdFor('sak-1')]: [
          {
            name: 'svar_oppfyller_kriteriene',
            value: true,
            dataType: 'BOOLEAN',
            metadata: { job_configuration_id: 'regel-1' },
          },
        ],
      },
    };
    const judges = langfuseJudges(api(fakeLangfuse(project)));
    const [snapshot] = (await judges.forRun('kudos', brev)).judges;
    const judge = judges.evaluator(snapshot as LangfuseJudge, { tenant: 'dfo', content: true });
    const [pending] = await judge.evaluate(kriteriesak, svar, ctx);
    // The agency points the rule at another test set while the run waits for its scores.
    project.rules[0] = rule({ filter: [onDataset('datasett-vedtak')] });
    const [collected] = (await judge.collect?.([pendingOf(pending as Score)])) ?? [];

    expect(collected?.score.details?.judgeChanged).toEqual([
      "the rule's filter no longer reaches the run",
    ]);
  });
});
