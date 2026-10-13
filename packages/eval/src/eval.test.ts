import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Event, Part, Principal } from '@genai/contracts';
import {
  createKernel,
  type Capability,
  type Kernel,
  type PortProvider,
  type Strategy,
} from '@genai/kernel';
import {
  bootstrapMean,
  bundledJudge,
  cli,
  compareRuns,
  compilePattern,
  contractAssertions,
  evalRunStrategy,
  evaluateGates,
  gate,
  kernelTarget,
  mean,
  pairedBootstrap,
  pairwiseJudge,
  parseTestSet,
  parseTestSetYaml,
  percentile,
  retrievalRecall,
  rubricJudge,
  runEval,
  type EvalContext,
  type EvalRun,
  type Evaluator,
  type JudgeModel,
  type Observation,
  type Score,
  type TestCase,
  type TestSet,
} from './index.js';

const testsets = join(import.meta.dirname, '..', 'testsets');

const caseOf = (overrides: Partial<TestCase> & { id: string }): TestCase => ({
  split: 'train',
  input: 'spørsmål',
  expected: { sources: [] },
  grounding: 'sources-and-answer',
  tags: [],
  needsReview: false,
  ...overrides,
});

const observation = (overrides: Partial<Observation> = {}): Observation => ({
  answer: '',
  retrieved: [],
  citations: [],
  ...overrides,
});

const ctx: EvalContext = {
  servedModels: ['foundry/gpt-4o'],
  modelFamily: (m) =>
    m.startsWith('foundry/gpt')
      ? 'openai'
      : m.startsWith('foundry/claude')
        ? 'anthropic'
        : undefined,
};

const values = (scores: Score[]) =>
  Object.fromEntries(scores.map((s) => [s.metric, s.applicable ? s.value : 'n/a']));

describe('test sets', () => {
  it('imports both headless-rag golden sets with every case, reference answer and split', () => {
    const files = readdirSync(testsets)
      .filter((f) => f.startsWith('headless-rag-') && f.endsWith('.yaml'))
      .sort();
    const sets = files.map((f) => parseTestSetYaml(readFileSync(join(testsets, f), 'utf8')));

    expect(sets.map((s) => [s.metadata.id, s.spec.cases.length])).toEqual([
      ['headless-rag-ue-42', 42],
      ['headless-rag-website-118', 118],
    ]);
    for (const set of sets) {
      expect(set.spec.cases.every((c) => c.expected.referenceAnswer !== undefined)).toBe(true);
      expect(new Set(set.spec.cases.map((c) => c.split))).toEqual(
        new Set(['train', 'validation', 'holdout']),
      );
      for (const c of set.spec.cases)
        if (c.expected.answerPattern)
          expect(() => compilePattern(c.expected.answerPattern as string)).not.toThrow();
    }
  });

  it('refuses duplicate case ids, unknown keys and patterns JavaScript cannot run', () => {
    const base = {
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant: '991825827', id: 'x', name: 'x', version: 1 },
      spec: { cases: [{ id: 'a', split: 'train', input: 'q' }] },
    };
    expect(() =>
      parseTestSet({ ...base, spec: { cases: [base.spec.cases[0], base.spec.cases[0]] } }),
    ).toThrow(/duplicate case a/);
    expect(() =>
      parseTestSet({ ...base, spec: { cases: [{ ...base.spec.cases[0], answer: 'x' }] } }),
    ).toThrow();
    expect(() =>
      parseTestSet({
        ...base,
        spec: { cases: [{ ...base.spec.cases[0], expected: { answerPattern: '(?x)a b' } }] },
      }),
    ).toThrow(/regular expression/);
  });

  it('reads Clojure-style inline flags', () => {
    expect(compilePattern('(?is)første.linje').test('FØRSTE\nLINJE')).toBe(true);
    expect(compilePattern('(?i)juni\\s*2020').test('Lansert i Juni 2020')).toBe(true);
    expect(compilePattern('abc').flags).toBe('');
  });
});

describe('statistics', () => {
  it('interpolates percentiles as worked out by hand', () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([1, 2, 3, 4], 0.25)).toBe(1.75);
    expect(percentile([10], 0.9)).toBe(10);
  });

  it('gives a zero-width interval for constant values and the same interval for the same seed', () => {
    const [low, high] = bootstrapMean([0.7, 0.7, 0.7]);
    expect(low).toBeCloseTo(0.7, 12);
    expect(high).toBeCloseTo(0.7, 12);
    const sample = [0, 1, 1, 0, 1, 0.5, 0.25, 1];
    expect(bootstrapMean(sample, { seed: 7 })).toEqual(bootstrapMean(sample, { seed: 7 }));
  });

  it('matches the normal approximation for a fair coin over 100 cases', () => {
    const coin = Array.from({ length: 100 }, (_, i) => (i % 2 === 0 ? 1 : 0));
    const [low, high] = bootstrapMean(coin, { iterations: 4000 });
    expect(mean(coin)).toBe(0.5);
    expect(low).toBeGreaterThan(0.38);
    expect(low).toBeLessThan(0.42);
    expect(high).toBeGreaterThan(0.58);
    expect(high).toBeLessThan(0.62);
  });

  it('pairs cases and finds a clear improvement', () => {
    const baseline = Array.from({ length: 40 }, (_, i) => (i % 4 === 0 ? 1 : 0));
    const candidate = baseline.map(() => 1);
    const c = pairedBootstrap(baseline, candidate);
    expect(c.difference).toBe(0.75);
    expect(c.ci[0]).toBeGreaterThan(0.5);
    expect(() => pairedBootstrap([1], [1, 0])).toThrow(/same length/);
  });
});

describe('evaluators', () => {
  it('checks answer patterns, refusals and structured fields', async () => {
    const contract = contractAssertions();

    const hit = await contract.evaluate(
      caseOf({ id: 'a', expected: { sources: [], answerPattern: '(?i)publisert' } }),
      observation({ answer: 'Filen er Publisert.' }),
      ctx,
    );
    const miss = await contract.evaluate(
      caseOf({ id: 'a', expected: { sources: [], answerPattern: '(?i)publisert' } }),
      observation({ answer: 'Vet ikke.' }),
      ctx,
    );
    const refusal = await contract.evaluate(
      caseOf({ id: 'r', grounding: 'refusal-expected' }),
      observation({ answer: 'Jeg finner ikke dette i kildene.' }),
      ctx,
    );
    const fields = await contract.evaluate(
      caseOf({
        id: 'f',
        expected: { sources: [], fields: { kategori: 'klage', frist: '2026-11-01' } },
      }),
      observation({ answer: 'ok', fields: { kategori: 'klage', frist: '2026-12-01' } }),
      ctx,
    );

    expect(values(hit)).toEqual({ 'non-empty-answer': 1, 'answer-pattern': 1 });
    expect(values(miss)).toEqual({ 'non-empty-answer': 1, 'answer-pattern': 0 });
    expect(values(refusal)).toEqual({ refusal: 1, 'answer-pattern': 'n/a' });
    expect(values(fields)['fields-match']).toBe(0.5);
  });

  it('scores recall at k and whether citations are inside what was retrieved', async () => {
    const recall = retrievalRecall(3);
    const c = caseOf({
      id: 'r',
      expected: { sources: [{ chunkId: 'c1' }, { document: 'd7', position: 2 }] },
    });

    const scores = await recall.evaluate(
      c,
      observation({
        retrieved: [
          { chunkId: 'c5' },
          { chunkId: 'c1' },
          { chunkId: 'c6' },
          { document: 'd7', position: 2 },
        ],
        citations: [{ chunkId: 'c1' }, { chunkId: 'c6' }, { chunkId: 'c404' }],
      }),
      ctx,
    );
    const answerOnly = await recall.evaluate(
      caseOf({ id: 'o', grounding: 'answer-only' }),
      observation(),
      ctx,
    );

    expect(values(scores)['recall@3']).toBe(0.5);
    expect(values(scores)['citations-grounded']).toBeCloseTo(2 / 3);
    expect(values(answerOnly)).toEqual({ 'recall@3': 'n/a', 'citations-grounded': 'n/a' });
  });

  const judge = (reply: string, family = 'anthropic'): JudgeModel & { prompts: string[] } => {
    const prompts: string[] = [];
    return {
      id: `${family}-judge`,
      family,
      prompts,
      complete: async (messages) => {
        prompts.push(messages.map((m) => m.content).join('\n'));
        return reply;
      },
    };
  };

  it('normalises rubric scores from the bundled prompt and fills in the reference', async () => {
    const j = judge(
      'Her er vurderingen: {"scores": {"correctness": 5, "completeness": 3, "language": 1}, "rationale": "Riktig, men på engelsk."}',
    );
    const evaluator = rubricJudge(j, bundledJudge('answer-quality'));
    const c = caseOf({
      id: 'j',
      input: 'Når ble Altinn 3 lansert?',
      expected: { sources: [], referenceAnswer: 'Juni 2020.' },
    });

    const scores = await evaluator.evaluate(c, observation({ answer: 'June 2020.' }), ctx);

    expect(values(scores)).toEqual({
      'judge.correctness': 1,
      'judge.completeness': 0.5,
      'judge.language': 0,
      'judge.overall': 0.5,
    });
    expect(j.prompts[0]).toContain('Juni 2020.');
    expect(evaluator.judge).toBe('anthropic-judge');
  });

  it('refuses a judge from the same family as the system, an unknown family and a malformed reply', async () => {
    const prompt = bundledJudge('answer-quality');
    const c = caseOf({ id: 'j', expected: { sources: [], referenceAnswer: 'x' } });

    await expect(
      rubricJudge(judge('{}', 'openai'), prompt).evaluate(c, observation(), ctx),
    ).rejects.toThrow(/same family/);
    await expect(
      rubricJudge(judge('{}'), prompt).evaluate(c, observation(), {
        ...ctx,
        servedModels: ['aivar/x'],
      }),
    ).rejects.toThrow(/no model family/);
    await expect(
      rubricJudge(judge('ikke json'), prompt).evaluate(c, observation(), ctx),
    ).rejects.toThrow(/did not return JSON/);
    await expect(
      rubricJudge(judge('{"scores": {"correctness": 9}}'), prompt).evaluate(c, observation(), ctx),
    ).rejects.toThrow(/no valid score/);
    const noReference = await rubricJudge(judge('{}'), prompt).evaluate(
      caseOf({ id: 'n' }),
      observation(),
      ctx,
    );
    expect(noReference.every((s) => !s.applicable)).toBe(true);
  });

  it('asks a pairwise judge in both orders and treats a flip as a tie with position bias', async () => {
    const replies = ['{"winner": "B"}', '{"winner": "A"}'];
    const consistent: JudgeModel = {
      id: 'j',
      family: 'anthropic',
      complete: async () => replies.shift() as string,
    };
    const alwaysFirst: JudgeModel = {
      id: 'j',
      family: 'anthropic',
      complete: async () => '{"winner": "A"}',
    };
    const prompt = bundledJudge('pairwise-preference');
    const c = caseOf({ id: 'p' });

    expect(
      await pairwiseJudge(consistent, prompt)(
        c,
        observation({ answer: 'gammel' }),
        observation({ answer: 'ny' }),
        ctx,
      ),
    ).toEqual({
      winner: 'candidate',
      positionBias: false,
      value: 1,
    });
    expect(await pairwiseJudge(alwaysFirst, prompt)(c, observation(), observation(), ctx)).toEqual({
      winner: 'tie',
      positionBias: true,
      value: 0.5,
    });
  });
});

const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' };

const descriptor = (id: string) => ({
  id,
  version: '1',
  tenant: '991825827',
  title: id,
  description: id,
  input: {},
  interaction: ['unary' as const],
  accepts: [],
  produces: [],
  emits: [],
  oversight: { interrupts: false, riskClass: 'minimal' as const, aiDisclosure: 'KI' },
});

const model = { kind: 'model', id: 'foundry/gpt-4o', tenant: '991825827' };

const fakeModels: PortProvider<{ answer(): Promise<void> }> = {
  open: (ref, portContext) => ({
    answer: () => portContext.meter({ inputTokens: 10, outputTokens: 5, requests: 1 }, ref),
  }),
};

const answering = (useModel = true): Strategy => ({
  id: 'fake-rag',
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },
  run: async function* (c, input) {
    const question = input.parts?.[0]?.body.kind === 'text' ? input.parts[0].body.text : '';
    if (useModel) await (await c.use<{ answer(): Promise<void> }>('model', model)).answer();
    yield {
      type: 'kernel.notice',
      data: { kind: 'retrieval', hits: [{ id: 'c1' }, { id: 'c2' }, { id: 'c3' }] },
    };
    const part: Part = {
      mime: 'text/plain',
      body: {
        kind: 'text',
        text: question.includes('broker') ? 'Filen blir publisert.' : 'Ukjent.',
      },
      meta: { citations: [{ id: 'c1' }] },
    };
    yield { type: 'kernel.result', data: [part] };
  },
});

const setOf = (): TestSet =>
  parseTestSet({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: { tenant: '991825827', id: 'mini', name: 'mini', version: 1 },
    spec: {
      cases: [
        {
          id: 'a',
          split: 'train',
          input: 'broker statuser',
          expected: { sources: [{ chunkId: 'c1' }], answerPattern: '(?i)publisert' },
          tags: ['broker'],
        },
        {
          id: 'b',
          split: 'validation',
          input: 'events abonnement',
          expected: { sources: [{ chunkId: 'c9' }], answerPattern: '(?i)abonnement' },
          tags: ['events'],
        },
        { id: 'h', split: 'holdout', input: 'låst', expected: { sources: [{ chunkId: 'c1' }] } },
      ],
    },
  });

const kernelWith = (strategies: Strategy[], capabilities: Capability[]): Kernel =>
  createKernel({
    strategies,
    capabilities,
    ports: { model: fakeModels },
    policy: { decide: async () => ({ allow: true }) },
  });

const answerCapability: Capability = {
  descriptor: descriptor('answer'),
  strategy: { id: 'fake-rag', version: '1' },
  config: {},
  grants: [{ port: 'model', ref: model }],
};

const evaluators: Evaluator[] = [contractAssertions(), retrievalRecall(3)];

describe('eval runner', () => {
  it('runs train and validation k times, never the holdout, and annotates every task', async () => {
    const kernel = kernelWith([answering()], [answerCapability]);

    const run = await runEval({
      target: kernelTarget(kernel, kari, 'answer'),
      testSet: setOf(),
      evaluators,
      provenance: { commit: 'abc123', data: 'kudos@2026-10-01' },
      repeats: 2,
    });

    expect(run.results.map((r) => `${r.case}#${r.repeat}`)).toEqual(['a#0', 'b#0', 'a#1', 'b#1']);
    expect(run.metrics['answer-pattern']).toMatchObject({ mean: 0.5, n: 2 });
    expect(run.metrics['recall@3']?.mean).toBe(0.5);
    expect(run.metrics['citations-grounded']?.mean).toBe(1);
    expect(run.byTag.broker?.['answer-pattern']?.mean).toBe(1);
    expect(run.provenance).toMatchObject({
      commit: 'abc123',
      data: 'kudos@2026-10-01',
      servedModels: ['foundry/gpt-4o'],
      judges: [],
    });
    expect(run.provenance.services[0]).toMatch(/^answer@1#/);
    const audit: Event[] = [];
    for await (const e of await kernel.events(kari, run.results[0]?.task as string, {
      audience: 'audit',
    }))
      audit.push(e);
    expect(audit.filter((e) => e.type === 'kernel.score')).toHaveLength(
      run.results[0]?.scores.length as number,
    );
  });

  it('fails loudly on missing provenance, a run without a served model, and a failing evaluator', async () => {
    const kernel = kernelWith([answering()], [answerCapability]);
    const silent = kernelWith([answering(false)], [answerCapability]);
    const broken: Evaluator = {
      id: 'broken',
      version: '1',
      kind: 'deterministic',
      evaluate: async () => Promise.reject(new Error('boom')),
    };
    const base = { testSet: setOf(), evaluators, provenance: { commit: 'abc', data: 'd' } };

    await expect(
      runEval({
        ...base,
        target: kernelTarget(kernel, kari, 'answer'),
        provenance: { commit: '', data: 'd' },
      }),
    ).rejects.toThrow(/commit/);
    await expect(
      runEval({ ...base, target: kernelTarget(silent, kari, 'answer') }),
    ).rejects.toThrow(/case a recorded no served model/);
    await expect(
      runEval({ ...base, target: kernelTarget(kernel, kari, 'answer'), evaluators: [broken] }),
    ).rejects.toThrow(/evaluator broken failed on case a: boom/);
    await expect(
      runEval({ ...base, target: kernelTarget(kernel, kari, 'missing') }),
    ).rejects.toThrow(/case a failed/);
  });
});

const fakeRun = (
  perCase: Record<string, number>,
  overrides: Partial<EvalRun['provenance']> = {},
  tags: Record<string, string[]> = {},
): EvalRun => {
  const results = Object.entries(perCase).map(([c, value]) => ({
    case: c,
    split: 'validation' as const,
    repeat: 0,
    task: `t-${c}`,
    tags: tags[c] ?? [],
    scores: [
      { evaluator: 'retrieval', version: '1', metric: 'recall@10', value, applicable: true },
      {
        evaluator: 'judge:answer-quality',
        version: '1',
        metric: 'judge.overall',
        value,
        applicable: true,
      },
    ],
  }));
  return {
    id: 'r',
    testSet: { tenant: '991825827', id: 'ka-kudos', version: 1 },
    capability: 'ka',
    splits: ['train', 'validation'],
    repeats: 1,
    startedAt: '2026-10-06T10:00:00Z',
    endedAt: '2026-10-06T10:05:00Z',
    provenance: {
      commit: 'a',
      data: 'kudos@1',
      servedModels: ['foundry/gpt-4o'],
      judges: ['anthropic-judge'],
      services: ['ka@1#x'],
      ...overrides,
    },
    results,
    metrics: {},
    byTag: {},
  };
};

const cases = (n: number, value: (i: number) => number) =>
  Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, value(i)]));

describe('comparing runs', () => {
  it('only compares like with like unless the difference is the point', () => {
    const baseline = fakeRun(cases(30, (i) => (i % 2 ? 1 : 0)));
    const candidate = fakeRun(
      cases(30, () => 1),
      { commit: 'b' },
    );

    expect(() => compareRuns(baseline, candidate, 'recall@10')).toThrow(/differ in commit/);
    expect(() =>
      compareRuns(
        baseline,
        fakeRun(
          cases(30, () => 1),
          { data: 'kudos@2' },
        ),
        'recall@10',
        { allowDifferent: ['commit'] },
      ),
    ).toThrow(/differ in data/);
    const c = compareRuns(baseline, candidate, 'recall@10', { allowDifferent: ['commit'] });
    expect(c.difference).toBe(0.5);
    expect(c.n).toBe(30);
  });
});

describe('publishing gates', () => {
  const registry = new Map(
    [
      { id: 'recall-at-10', metric: 'recall@10', kind: 'threshold', threshold: 0.8 },
      { id: 'no-tag-regression', metric: 'recall@10', kind: 'no-regression', perTag: true },
      { id: 'judge-quality', metric: 'judge.overall', kind: 'threshold', threshold: 0.9 },
    ].map((g) => [g.id, gate.parse(g)]),
  );
  const evaluation = (gates: string[]) => ({ testSets: ['ka-kudos'], gates });

  it('passes and fails a threshold gate on the gate split', () => {
    const good = evaluateGates({
      evaluation: evaluation(['recall-at-10']),
      registry,
      candidate: new Map([['ka-kudos', fakeRun(cases(10, (i) => (i < 9 ? 1 : 0)))]]),
    });
    const bad = evaluateGates({
      evaluation: evaluation(['recall-at-10']),
      registry,
      candidate: new Map([['ka-kudos', fakeRun(cases(10, (i) => (i < 5 ? 1 : 0)))]]),
    });

    expect(good.pass).toBe(true);
    expect(good.results[0]?.value).toBe(0.9);
    expect(bad.pass).toBe(false);
    expect(bad.results[0]?.reason).toBe('recall@10 0.500 < 0.8');
  });

  it('fails an unknown gate and a missing run instead of skipping them', () => {
    const outcome = evaluateGates({
      evaluation: evaluation(['recall-at-10', 'typo-gate']),
      registry,
      candidate: new Map(),
    });

    expect(outcome.pass).toBe(false);
    expect(outcome.results.map((r) => r.reason)).toEqual([
      'no eval run for test set ka-kudos',
      'gate typo-gate is not defined',
    ]);
  });

  it('lets an uncalibrated judge advise but never block', () => {
    const run = fakeRun(cases(10, () => 0.5));
    const uncalibrated = evaluateGates({
      evaluation: evaluation(['judge-quality']),
      registry,
      candidate: new Map([['ka-kudos', run]]),
      judgeAgreement: new Map([['anthropic-judge', 0.4]]),
    });
    const calibrated = evaluateGates({
      evaluation: evaluation(['judge-quality']),
      registry,
      candidate: new Map([['ka-kudos', run]]),
      judgeAgreement: new Map([['anthropic-judge', 0.72]]),
    });

    expect(uncalibrated.results[0]).toMatchObject({ pass: false, blocking: false });
    expect(uncalibrated.pass).toBe(true);
    expect(calibrated.results[0]).toMatchObject({ pass: false, blocking: true });
    expect(calibrated.pass).toBe(false);
  });

  it('catches a regression in one tag that the overall number hides', () => {
    const tags = Object.fromEntries(
      Array.from({ length: 40 }, (_, i) => [`c${i}`, [i < 20 ? 'broker' : 'events']]),
    );
    const baseline = fakeRun(
      cases(40, (i) => (i < 20 ? 1 : 0)),
      {},
      tags,
    );
    const candidate = fakeRun(
      cases(40, (i) => (i < 20 ? 0 : 1)),
      { commit: 'b' },
      tags,
    );

    const outcome = evaluateGates({
      evaluation: evaluation(['no-tag-regression']),
      registry,
      candidate: new Map([['ka-kudos', candidate]]),
      baseline: new Map([['ka-kudos', baseline]]),
    });

    expect(outcome.pass).toBe(false);
    expect(outcome.results[0]?.value).toBe(0);
    expect(outcome.results[0]?.reason).toMatch(/^regressed: broker -1\.000/);
    expect(
      evaluateGates({
        evaluation: evaluation(['no-tag-regression']),
        registry,
        candidate: new Map([['ka-kudos', candidate]]),
      }).results[0]?.reason,
    ).toBe('no baseline run for test set ka-kudos');
  });
});

describe('platform.eval.run', () => {
  it('runs as a kernel task over sub-tasks and returns the eval run with progress on the way', async () => {
    const holder: { kernel?: Kernel } = {};
    const strategy = evalRunStrategy({
      kernel: () => holder.kernel as Kernel,
      evaluators: new Map(evaluators.map((e) => [e.id, e])),
    });
    const kernel = (holder.kernel = kernelWith(
      [answering(), strategy as Strategy],
      [
        answerCapability,
        {
          descriptor: descriptor('eval'),
          strategy: { id: 'platform.eval.run', version: '1' },
          config: {},
          grants: [],
        },
      ],
    ));

    const run = await kernel.invoke(kari, 'eval', {
      data: {
        capability: 'answer',
        testSet: setOf(),
        evaluators: ['contract', 'retrieval'],
        provenance: { commit: 'abc', data: 'd1' },
      },
    });
    const events: Event[] = [];
    for await (const e of run.events) events.push(e);
    const [part] = await run.result;

    const result = part?.body.kind === 'json' ? (part.body.json as EvalRun) : undefined;
    expect(result?.results.map((r) => r.case)).toEqual(['a', 'b']);
    expect(result?.metrics['answer-pattern']?.mean).toBe(0.5);
    expect(
      events
        .filter((e) => e.type === 'kernel.notice')
        .map((e) => (e.data as { done: number }).done),
    ).toEqual([1, 2]);
    expect((await kernel.task(kari, run.task)).status).toBe('completed');
  });

  it('stops an eval run before the next case once the monthly token quota is used up', async () => {
    const holder: { kernel?: Kernel } = {};
    let admitted = 0;
    const strategy = evalRunStrategy({
      kernel: () => holder.kernel as Kernel,
      evaluators: new Map(evaluators.map((e) => [e.id, e])),
      admit: async () => (admitted += 1) <= 1,
    });
    const kernel = (holder.kernel = kernelWith(
      [answering(), strategy as Strategy],
      [
        answerCapability,
        {
          descriptor: descriptor('eval'),
          strategy: { id: 'platform.eval.run', version: '1' },
          config: {},
          grants: [],
        },
      ],
    ));

    const run = await kernel.invoke(kari, 'eval', {
      data: {
        capability: 'answer',
        testSet: setOf(),
        evaluators: ['contract', 'retrieval'],
        provenance: { commit: 'abc', data: 'd1' },
      },
    });

    await expect(run.result).rejects.toThrow(/monthly token quota/);
    expect((await kernel.task(kari, run.task)).status).toBe('failed');
  });

  it('refuses an eval run with an unknown evaluator', async () => {
    const holder: { kernel?: Kernel } = {};
    const strategy = evalRunStrategy({
      kernel: () => holder.kernel as Kernel,
      evaluators: new Map(),
    });
    const kernel = (holder.kernel = kernelWith(
      [answering(), strategy as Strategy],
      [
        answerCapability,
        {
          descriptor: descriptor('eval'),
          strategy: { id: 'platform.eval.run', version: '1' },
          config: {},
          grants: [],
        },
      ],
    ));

    const run = await kernel.invoke(kari, 'eval', {
      data: {
        capability: 'answer',
        testSet: setOf(),
        evaluators: ['judge'],
        provenance: { commit: 'a', data: 'd' },
      },
    });

    await expect(run.result).rejects.toThrow();
    expect((await kernel.task(kari, run.task)).status).toBe('failed');
  });
});

describe('cli', () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };

  it('validates test sets and compares two saved runs', () => {
    const v = io();
    expect(cli(['validate', join(testsets, 'headless-rag-ue-42.yaml')], v.io)).toBe(0);
    expect(v.out[0]).toMatch(
      /^headless-rag-ue-42 v1: 42 cases \(train \d+, validation \d+, holdout \d+\)$/,
    );

    const dir = mkdtempSync(join(tmpdir(), 'eval-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify(fakeRun(cases(10, () => 0))));
    writeFileSync(
      join(dir, 'b.json'),
      JSON.stringify(
        fakeRun(
          cases(10, () => 1),
          { commit: 'b' },
        ),
      ),
    );
    const c = io();
    expect(
      cli(
        ['compare', join(dir, 'a.json'), join(dir, 'b.json'), 'recall@10', '--allow', 'commit'],
        c.io,
      ),
    ).toBe(0);
    expect(c.out[0]).toBe(
      'recall@10: 0.000 -> 1.000, difference 1.000 [1.000, 1.000] over 10 cases',
    );

    const bad = io();
    expect(cli(['compare', join(dir, 'a.json'), join(dir, 'b.json'), 'recall@10'], bad.io)).toBe(1);
    expect(bad.err[0]).toMatch(/differ in commit/);
    expect(cli([], io().io)).toBe(2);
  });
});
