import {
  agreementMap,
  evaluatorOfJudge,
  testCase,
  type Observation,
  type PendingScore,
  type Score,
} from '@genai/eval';
import { describe, expect, it } from 'vitest';
import { langfuseJudges, type LangfuseJudge } from './judges.js';
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
  metadata: { job_configuration_id: string };
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
