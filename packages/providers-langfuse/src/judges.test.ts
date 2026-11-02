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
  target: string;
  status: string;
  enabled: boolean;
  sampling?: number;
  filter?: unknown[];
  mapping: { variable: string; source: string; jsonPath?: string }[];
  evaluator: { id: string; name: string };
}

interface FakeEvaluator {
  id: string;
  name: string;
  version: number;
  type?: string;
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

const rule = (over: Partial<FakeRule> = {}): FakeRule => ({
  id: 'regel-1',
  name: 'svar_oppfyller_kriteriene-eksperimenter',
  target: 'experiment',
  status: 'active',
  enabled: true,
  mapping: [
    { variable: 'input', source: 'input' },
    { variable: 'output', source: 'output' },
    { variable: 'criteria', source: 'expected_output', jsonPath: '$.criteria' },
  ],
  evaluator: { id: 'dommer-1', name: 'svar_oppfyller_kriteriene' },
  ...over,
});

const evaluator = (over: Partial<FakeEvaluator> = {}): FakeEvaluator => ({
  id: 'dommer-1',
  name: 'svar_oppfyller_kriteriene',
  version: 1,
  outputDefinition: { dataType: 'BOOLEAN' },
  modelConfig: { provider: 'foundry-claude', model: 'claude-sonnet-5' },
  ...over,
});

/** A Langfuse 4.4.0 project, answering as the local one did on 2026-10-30. */
const fakeLangfuse = (project: {
  rules: FakeRule[];
  evaluators: FakeEvaluator[];
  scores?: Record<string, FakeScore[]>;
  configs?: Record<string, { minValue?: number; maxValue?: number }>;
  /** The observations of each judge execution trace. */
  judgeTraces?: Record<string, FakeGeneration[]>;
  observationsDown?: () => boolean;
}): typeof fetch => {
  return async (input) => {
    const url = new URL(String(input));
    const path = url.pathname;
    if (path === '/api/public/unstable/evaluation-rules') {
      const page = Number(url.searchParams.get('page') ?? '1');
      const limit = Number(url.searchParams.get('limit') ?? '50');
      return Response.json({
        data: project.rules.slice((page - 1) * limit, page * limit),
        meta: {
          page,
          limit,
          totalItems: project.rules.length,
          totalPages: Math.ceil(project.rules.length / limit),
        },
      });
    }
    const ruleId = /^\/api\/public\/unstable\/evaluation-rules\/(.+)$/.exec(path)?.[1];
    if (ruleId) {
      const found = project.rules.find((r) => r.id === ruleId);
      return found ? Response.json(found) : new Response('{}', { status: 404 });
    }
    const evaluatorId = /^\/api\/public\/unstable\/evaluators\/(.+)$/.exec(path)?.[1];
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
        rules: [rule({ evaluator: { id: 'dommer-2', name: 'svar_oppfyller_kriteriene' } })],
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
      await collectedAfter({ rules: [rule({ status: 'inactive' })], evaluators: [evaluator()] }),
    ).toEqual(['the rule is no longer active']);
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
    expect(await refusedOf(rule({ sampling: 1, filter: [] }))).toBeUndefined();
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
});
