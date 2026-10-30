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
  criteriaJudge,
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
  score,
  type EvalContext,
  type EvalRun,
  type Evaluator,
  type JudgeModel,
  type Observation,
  type PendingScore,
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

  it('checks the case types a person writes: exact text, and a refusal that may be no answer at all, but never a structured answer', async () => {
    const contract = contractAssertions();

    const exact = (answer: string) =>
      contract.evaluate(
        caseOf({ id: 'e', type: 'exact', expected: { sources: [], referenceAnswer: '1. mai' } }),
        observation({ answer }),
        ctx,
      );
    const rejected = (answer: string) =>
      contract.evaluate(caseOf({ id: 'm', type: 'must_reject' }), observation({ answer }), ctx);

    expect(contract.version).toBe('2');
    expect(values(await exact('Fristen er 1.  MAI.'))['exact-text']).toBe(1);
    expect(values(await exact('Snart.'))['exact-text']).toBe(0);
    expect(values(await rejected(''))).toMatchObject({ refusal: 1 });
    expect(values(await rejected('Her er svaret.'))).toMatchObject({ refusal: 0 });
    expect(
      values(
        await contract.evaluate(
          caseOf({ id: 'm', type: 'must_reject' }),
          observation({ answer: '', fields: { personnummer: '01017012345' } }),
          ctx,
        ),
      ),
    ).toMatchObject({ refusal: 0 });
    expect(
      values(await contract.evaluate(caseOf({ id: 'c' }), observation({ answer: 'x' }), ctx))[
        'exact-text'
      ],
    ).toBeUndefined();
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

  it('checks a judge against the models that wrote the answer, never an embedder that only searched', async () => {
    const embedder = {
      kind: 'embedder',
      id: 'foundry/text-embedding-3-large',
      tenant: '991825827',
    };
    const searching: Strategy = {
      id: 'searching-rag',
      version: '1',
      requires: { kernel: 1, ports: ['model', 'embedding'], features: [] },
      run: async function* (c) {
        await (await c.use<{ answer(): Promise<void> }>('embedding', embedder)).answer();
        await (await c.use<{ answer(): Promise<void> }>('model', model)).answer();
        yield {
          type: 'kernel.result',
          data: [{ mime: 'text/plain', body: { kind: 'text', text: 'Filen blir publisert.' } }],
        };
      },
    };
    const kernel = createKernel({
      strategies: [searching],
      capabilities: [
        {
          ...answerCapability,
          strategy: { id: 'searching-rag', version: '1' },
          grants: [...answerCapability.grants, { port: 'embedding', ref: embedder }],
        },
      ],
      ports: { model: fakeModels, embedding: fakeModels },
      policy: { decide: async () => ({ allow: true }) },
    });
    const checked: string[][] = [];
    const watching: Evaluator = {
      id: 'watching',
      version: '1',
      kind: 'model',
      evaluate: async (_c, _o, context) => {
        checked.push(context.servedModels);
        return [];
      },
    };

    const run = await runEval({
      target: kernelTarget(kernel, kari, 'answer'),
      testSet: setOf(),
      evaluators: [watching],
      provenance: { commit: 'abc', data: 'd' },
    });

    expect(checked).toEqual([['foundry/gpt-4o'], ['foundry/gpt-4o']]);
    expect(run.provenance.servedModels).toEqual([
      'foundry/gpt-4o',
      'foundry/text-embedding-3-large',
    ]);
  });

  it('scores a case no model answered, such as a refusal before the model, and reports usage so far with its progress', async () => {
    const kernel = kernelWith([answering()], [answerCapability]);
    const answer = kernelTarget(kernel, kari, 'answer');
    const progress: [number, unknown][] = [];

    const run = await runEval({
      testSet: setOf(),
      evaluators,
      provenance: { commit: 'abc', data: 'd' },
      target: {
        ...answer,
        invoke: async (input) => {
          const outcome = await answer.invoke(input);
          return progress.length === 0 ? { ...outcome, servedModels: [] } : outcome;
        },
      },
      meterAnswers: () => ({ inputTokens: 10, outputTokens: 2, costMicroNok: 5 }),
      onProgress: (done, _total, usage) => progress.push([done, usage]),
    });

    expect(run.results).toHaveLength(2);
    expect(run.provenance.servedModels).toEqual(['foundry/gpt-4o']);
    expect(progress).toEqual([
      [1, { answers: { inputTokens: 10, outputTokens: 2, costMicroNok: 5 } }],
      [2, { answers: { inputTokens: 20, outputTokens: 4, costMicroNok: 10 } }],
    ]);
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
    ).rejects.toThrow(/the run recorded no served model/);
    await expect(
      runEval({ ...base, target: kernelTarget(kernel, kari, 'answer'), evaluators: [broken] }),
    ).rejects.toThrow(/evaluator broken failed on case a: boom/);
    await expect(
      runEval({ ...base, target: kernelTarget(kernel, kari, 'missing') }),
    ).rejects.toThrow(/case a failed/);
  });
});

const scoredAs = (item: PendingScore, value: number): Score => ({
  evaluator: item.score.evaluator,
  version: item.score.version,
  metric: item.score.metric,
  value,
  applicable: true,
  state: 'scored',
});

const settledAs = (
  item: PendingScore,
  state: 'failed' | 'not-applicable',
  reason: string,
): Score => ({
  evaluator: item.score.evaluator,
  version: item.score.version,
  metric: item.score.metric,
  value: null,
  applicable: state !== 'not-applicable',
  state,
  reason,
});

const later = (deliver: (item: PendingScore, attempt: number) => Score | undefined) => {
  const calls: number[] = [];
  const self: Evaluator = {
    id: 'judge:later',
    version: '1',
    kind: 'model',
    judge: 'foundry/claude-later',
    evaluate: async (c) => [
      {
        evaluator: self.id,
        version: self.version,
        metric: 'judge.later',
        value: null,
        applicable: true,
        state: 'pending',
        details: { ticket: c.id },
      },
    ],
    collect: async (pending) => {
      calls.push(pending.length);
      return pending.flatMap((item) => {
        const delivered = deliver(item, calls.length);
        return delivered ? [{ case: item.case, repeat: item.repeat, score: delivered }] : [];
      });
    },
  };
  return { evaluator: self, calls };
};

const fakeClock = () => {
  const started = Date.UTC(2026, 9, 29, 12);
  let at = started;
  return {
    now: () => new Date(at),
    sleep: async (ms: number) => {
      at += ms;
    },
    pass: (ms: number) => {
      at += ms;
    },
    waited: () => at - started,
  };
};

const judged = (run: EvalRun, metric = 'judge.later') =>
  run.results.map((r) => r.scores.find((s) => s.metric === metric));

describe('deferred judges (evaluator@2)', () => {
  const kernel = kernelWith([answering()], [answerCapability]);
  const base = { testSet: setOf(), provenance: { commit: 'abc', data: 'd' } };

  it("lands a pending judge's scores in the run and its metrics once they are collected", async () => {
    const clock = fakeClock();
    const { evaluator, calls } = later((item, attempt) =>
      attempt < 2 ? undefined : scoredAs(item, item.case === 'a' ? 1 : 0),
    );

    const run = await runEval({
      ...base,
      target: kernelTarget(kernel, kari, 'answer'),
      evaluators: [contractAssertions(), evaluator],
      now: clock.now,
      wait: { sleep: clock.sleep },
    });

    expect(calls).toEqual([2, 2]);
    expect(judged(run)).toMatchObject([
      { state: 'scored', value: 1 },
      { state: 'scored', value: 0 },
    ]);
    expect(run.metrics['judge.later']).toMatchObject({ mean: 0.5, n: 2 });
    expect(run.incomplete).toEqual([]);
    expect(run.provenance.judges).toEqual(['foundry/claude-later']);
    const audit: Event[] = [];
    for await (const e of await kernel.events(kari, run.results[0]?.task as string, {
      audience: 'audit',
    }))
      audit.push(e);
    expect(
      audit
        .filter((e) => e.type === 'kernel.score')
        .map((e) => e.data as Score)
        .filter((s) => s.metric === 'judge.later'),
    ).toMatchObject([{ state: 'scored', value: 1 }]);
  });

  it('records a score still missing 5 minutes after the last case was sent as missing, naming the judge and the count', async () => {
    const clock = fakeClock();
    const { evaluator, calls } = later((item) =>
      item.case === 'a' ? scoredAs(item, 1) : undefined,
    );
    const answer = kernelTarget(kernel, kari, 'answer');

    const run = await runEval({
      ...base,
      target: {
        ...answer,
        invoke: async (input) => {
          clock.pass(60_000);
          return answer.invoke(input);
        },
      },
      evaluators: [evaluator],
      repeats: 2,
      now: clock.now,
      wait: { sleep: clock.sleep },
    });

    expect(clock.waited()).toBe(4 * 60_000 + 5 * 60_000);
    // Every 5 seconds before the deadline, none at it.
    expect(calls).toHaveLength(59);
    expect(judged(run)).toMatchObject([
      { state: 'scored', value: 1 },
      { state: 'missing', value: null, reason: 'no score within 5 minutes of the last case' },
      { state: 'scored', value: 1 },
      { state: 'missing', value: null, reason: 'no score within 5 minutes of the last case' },
    ]);
    expect(run.metrics['judge.later']).toMatchObject({ mean: 1, n: 1 });
    expect(run.incomplete).toEqual([
      {
        evaluator: 'judge:later',
        missing: 2,
        failed: 0,
        of: 4,
        reason: 'no score from judge:later for 2 of 4 cases',
      },
    ]);
  });

  it('keeps waiting when collecting fails, and names the last error on what never arrived', async () => {
    const clock = fakeClock();
    const { evaluator } = later(() => {
      throw new Error('the evaluator answered HTTP 503');
    });

    const run = await runEval({
      ...base,
      target: kernelTarget(kernel, kari, 'answer'),
      evaluators: [evaluator],
      now: clock.now,
      wait: { sleep: clock.sleep },
    });

    expect(clock.waited()).toBe(5 * 60_000);
    expect(judged(run)).toMatchObject([
      {
        state: 'missing',
        reason:
          'no score within 5 minutes of the last case (last error: the evaluator answered HTTP 503)',
      },
      { state: 'missing' },
    ]);
  });

  it('takes no score that arrives after the deadline, and bounds each collect by the time left', async () => {
    const clock = fakeClock();
    const signals: (AbortSignal | undefined)[] = [];
    const { evaluator } = later((item) => {
      clock.pass(6 * 60_000);
      return scoredAs(item, 1);
    });
    const collect = evaluator.collect?.bind(evaluator);
    evaluator.collect = async (pending, options) => {
      signals.push(options?.signal);
      return (await collect?.(pending, options)) ?? [];
    };

    const run = await runEval({
      ...base,
      target: kernelTarget(kernel, kari, 'answer'),
      evaluators: [evaluator],
      now: clock.now,
      wait: { sleep: clock.sleep },
    });

    expect(judged(run)).toMatchObject([
      { state: 'missing', reason: 'no score within 5 minutes of the last case' },
      { state: 'missing' },
    ]);
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
  });

  it('fails the run when a collected score cannot be recorded on its case, as for an immediate score', async () => {
    const clock = fakeClock();
    const { evaluator } = later((item) => scoredAs(item, 1));
    const answer = kernelTarget(kernel, kari, 'answer');

    await expect(
      runEval({
        ...base,
        target: {
          ...answer,
          annotate: async (_task, s) => {
            if (s.metric === 'judge.later' && s.state === 'scored')
              throw new Error('the audit log is down');
          },
        },
        evaluators: [evaluator],
        now: clock.now,
        wait: { sleep: clock.sleep },
      }),
    ).rejects.toThrow('the audit log is down');
  });

  it('stops waiting for scores when the eval run is cancelled', async () => {
    const clock = fakeClock();
    const cancel = new AbortController();
    const { evaluator, calls } = later(() => {
      cancel.abort(new Error('cancelled by Kari'));
      return undefined;
    });

    await expect(
      runEval({
        ...base,
        target: kernelTarget(kernel, kari, 'answer'),
        evaluators: [evaluator],
        now: clock.now,
        wait: { sleep: clock.sleep },
        signal: cancel.signal,
      }),
    ).rejects.toThrow('cancelled by Kari');
    expect(calls).toEqual([2]);
  });

  it('keeps pending, failed and not applicable apart', async () => {
    const shape = { evaluator: 'judge:later', version: '1', metric: 'judge.later' };
    const parses = (s: Record<string, unknown>) => score.safeParse({ ...shape, ...s }).success;
    expect(parses({ value: null, applicable: true, state: 'pending' })).toBe(true);
    expect(parses({ value: null, applicable: true, state: 'failed' })).toBe(true);
    expect(parses({ value: null, applicable: false, state: 'not-applicable' })).toBe(true);
    expect(parses({ value: null, applicable: false, state: 'pending' })).toBe(false);
    expect(parses({ value: null, applicable: true, state: 'not-applicable' })).toBe(false);
    expect(parses({ value: 0.5, applicable: true, state: 'failed' })).toBe(false);
    expect(parses({ value: null, applicable: true, state: 'scored' })).toBe(false);

    const clock = fakeClock();
    const { evaluator } = later((item) =>
      item.case === 'a'
        ? settledAs(item, 'failed', 'the judge model timed out')
        : settledAs(item, 'not-applicable', 'the case has no criteria'),
    );
    const run = await runEval({
      ...base,
      target: kernelTarget(kernel, kari, 'answer'),
      evaluators: [evaluator],
      now: clock.now,
      wait: { sleep: clock.sleep },
    });

    expect(judged(run)).toMatchObject([
      { state: 'failed', applicable: true, reason: 'the judge model timed out' },
      { state: 'not-applicable', applicable: false },
    ]);
    expect(run.metrics['judge.later']).toBeUndefined();
    expect(run.incomplete).toEqual([
      {
        evaluator: 'judge:later',
        missing: 0,
        failed: 1,
        of: 1,
        reason: 'judge:later failed on 1 of 1 cases',
      },
    ]);
  });

  it('waits for nothing when every judge answers at once', async () => {
    const clock = fakeClock();

    const run = await runEval({
      ...base,
      target: kernelTarget(kernel, kari, 'answer'),
      evaluators,
      now: clock.now,
      wait: { sleep: clock.sleep },
    });

    expect(clock.waited()).toBe(0);
    expect(run.results.flatMap((r) => r.scores.map((s) => s.state))).not.toContain('pending');
  });

  it('fails a run whose evaluator answers pending but cannot be collected', async () => {
    const { evaluator } = later(() => undefined);
    const uncollectable: Evaluator = {
      id: evaluator.id,
      version: evaluator.version,
      kind: evaluator.kind,
      evaluate: evaluator.evaluate,
    };

    await expect(
      runEval({
        ...base,
        target: kernelTarget(kernel, kari, 'answer'),
        evaluators: [uncollectable],
      }),
    ).rejects.toThrow(/evaluator judge:later answered pending on case a but cannot be collected/);
  });
});

describe('the criteria judge', () => {
  const claude: JudgeModel = {
    id: 'foundry/claude-sonnet',
    family: 'anthropic',
    complete: async (messages) =>
      messages[1]?.content.includes('Nevner fristen')
        ? '{"scores": {"criteria": 1}, "rationale": "Fristen er nevnt."}'
        : '{"scores": {"criteria": 0}, "rationale": "Fristen mangler."}',
  };
  const criteriaCase = caseOf({
    id: 'k',
    type: 'criteria',
    expected: { sources: [], criteria: { criteria: 'Nevner fristen' } },
  });

  it('scores a criteria case on its criteria under its own identity, with its model in the version', async () => {
    const picked: string[][] = [];
    const judge = criteriaJudge(async (writers) => {
      picked.push(writers);
      return claude;
    });

    const scores = await judge.evaluate(criteriaCase, observation({ answer: '1. mai' }), ctx);
    await judge.evaluate({ ...criteriaCase, id: 'k2' }, observation({ answer: '1. mai' }), ctx);

    expect(scores).toEqual([
      {
        evaluator: 'judge:criteria',
        version: '1+foundry/claude-sonnet',
        metric: 'judge.criteria',
        value: 1,
        applicable: true,
        state: 'scored',
        reason: 'Fristen er nevnt.',
      },
    ]);
    expect(judge.judge).toBe('judge:criteria@1+foundry/claude-sonnet');
    expect(picked).toEqual([['foundry/gpt-4o']]);
  });

  it('is not applicable to exact and must_reject cases, or to a case without criteria', async () => {
    const judge = criteriaJudge(async () => claude);
    const states = async (c: TestCase) =>
      (await judge.evaluate(c, observation({ answer: 'x' }), ctx)).map((s) => [s.state, s.reason]);

    expect(await states(caseOf({ id: 'e', type: 'exact' }))).toEqual([
      ['not-applicable', 'the case is exact, not criteria'],
    ]);
    expect(await states(caseOf({ id: 'm', type: 'must_reject' }))).toEqual([
      ['not-applicable', 'the case is must_reject, not criteria'],
    ]);
    expect(await states(caseOf({ id: 'n', type: 'criteria' }))).toEqual([
      ['not-applicable', 'the case has no criteria'],
    ]);
    expect(judge.judge).toBeUndefined();
  });

  it('records a failed score when no judge model is available, picking one fails, or the judge call fails', async () => {
    const none = criteriaJudge(async () => undefined);
    const broken = criteriaJudge(async () => ({
      ...claude,
      complete: async () => Promise.reject(new Error('the model answered HTTP 429')),
    }));

    expect(await none.evaluate(criteriaCase, observation({ answer: 'x' }), ctx)).toMatchObject([
      { state: 'failed', reason: 'no judge model from another family than foundry/gpt-4o' },
    ]);
    expect(await broken.evaluate(criteriaCase, observation({ answer: 'x' }), ctx)).toMatchObject([
      { state: 'failed', reason: 'the model answered HTTP 429' },
    ]);
    const unpickable = criteriaJudge(() => Promise.reject(new Error('the policy store is down')));
    expect(
      await unpickable.evaluate(criteriaCase, observation({ answer: 'x' }), ctx),
    ).toMatchObject([{ state: 'failed', reason: 'the policy store is down' }]);
  });

  it('puts its identity with version and model in the provenance of the run', async () => {
    const kernel = kernelWith([answering()], [answerCapability]);
    const set = setOf();
    const run = await runEval({
      target: kernelTarget(kernel, kari, 'answer'),
      testSet: {
        ...set,
        spec: {
          ...set.spec,
          cases: set.spec.cases.map((c) => ({
            ...c,
            type: 'criteria' as const,
            expected: { ...c.expected, criteria: { criteria: 'Nevner fristen' } },
          })),
        },
      },
      evaluators: [criteriaJudge(async () => claude)],
      provenance: { commit: 'abc', data: 'd' },
      modelFamily: ctx.modelFamily,
    });

    expect(run.provenance.judges).toEqual(['judge:criteria@1+foundry/claude-sonnet']);
    expect(run.metrics['judge.criteria']).toMatchObject({ mean: 1, n: 2 });
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
      {
        evaluator: 'retrieval',
        version: '1',
        metric: 'recall@10',
        value,
        applicable: true,
        state: 'scored' as const,
      },
      {
        evaluator: 'judge:answer-quality',
        version: '1',
        metric: 'judge.overall',
        value,
        applicable: true,
        state: 'scored' as const,
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
    incomplete: [],
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

  it('fails a gate whose metric has a missing or failed score in its split, in the run or its baseline, naming the count', () => {
    const unsettle = (
      run: EvalRun,
      metric: string,
      split: 'train' | 'validation' = 'validation',
    ) => ({
      ...run,
      results: run.results.map((r, i) =>
        i < 2
          ? {
              ...r,
              split,
              scores: r.scores.map((s): Score =>
                s.metric === metric
                  ? { ...s, value: null, state: i === 0 ? 'missing' : 'failed' }
                  : s,
              ),
            }
          : r,
      ),
    });
    const calibrated = new Map([['anthropic-judge', 0.72]]);
    const gated = (gates: string[], candidate: EvalRun, baseline?: EvalRun) =>
      evaluateGates({
        evaluation: evaluation(gates),
        registry,
        candidate: new Map([['ka-kudos', candidate]]),
        ...(baseline ? { baseline: new Map([['ka-kudos', baseline]]) } : {}),
        judgeAgreement: calibrated,
      });
    const all = fakeRun(cases(10, () => 1));

    const threshold = gated(['judge-quality'], unsettle(all, 'judge.overall'));
    const regression = gated(['no-tag-regression'], unsettle(all, 'recall@10'), all);
    const otherSplit = gated(['judge-quality'], unsettle(all, 'judge.overall', 'train'));

    expect(threshold.pass).toBe(false);
    expect(threshold.results[0]).toMatchObject({
      pass: false,
      blocking: true,
      reason: 'judge.overall: no score for 2 of 10 cases',
    });
    expect(regression.results[0]).toMatchObject({
      pass: false,
      reason: 'recall@10: no score for 2 of 10 cases',
    });
    expect(otherSplit.pass).toBe(true);
    const baseline = gated(['no-tag-regression'], all, unsettle(all, 'recall@10'));
    expect(baseline.results[0]).toMatchObject({
      pass: false,
      reason: 'recall@10: no score in the baseline for 2 of 10 cases',
    });
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

  it('tells whoever follows the eval task that it is waiting for scores, and for how many', async () => {
    const holder: { kernel?: Kernel } = {};
    const { evaluator } = later((item, attempt) => (attempt < 2 ? undefined : scoredAs(item, 1)));
    const strategy = evalRunStrategy({
      kernel: () => holder.kernel as Kernel,
      evaluators: new Map([[evaluator.id, evaluator]]),
      wait: { everyMs: 1 },
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
        evaluators: ['judge:later'],
        provenance: { commit: 'abc', data: 'd1' },
      },
    });
    const events: Event[] = [];
    for await (const e of run.events) events.push(e);
    const [part] = await run.result;

    const notices = events
      .filter((e) => e.type === 'kernel.notice')
      .map((e) => e.data as { kind: string; pending?: number; until?: string });
    expect(notices.map((n) => n.kind)).toEqual(['eval.progress', 'eval.progress', 'eval.waiting']);
    expect(notices[2]).toMatchObject({ pending: 2, until: expect.any(String) });
    const result = part?.body.kind === 'json' ? (part.body.json as EvalRun) : undefined;
    expect(result?.metrics['judge.later']?.mean).toBe(1);
  });

  it('gives each run its own evaluators, so a judge picked for one run is never reused by the next', async () => {
    const holder: { kernel?: Kernel } = {};
    const picks: string[] = [];
    const claude: JudgeModel = {
      id: 'foundry/claude-sonnet',
      family: 'anthropic',
      complete: async () => '{"scores": {"criteria": 1}, "rationale": "ok"}',
    };
    const strategy = evalRunStrategy({
      kernel: () => holder.kernel as Kernel,
      evaluators: new Map(),
      modelFamily: ctx.modelFamily,
      forRun: (principal) =>
        new Map([
          [
            'judge:criteria',
            criteriaJudge(async () => {
              picks.push(principal.subject);
              return claude;
            }),
          ],
        ]),
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
    const set = setOf();
    const criteriaSet = {
      ...set,
      spec: {
        ...set.spec,
        cases: set.spec.cases.map((c) => ({
          ...c,
          type: 'criteria' as const,
          expected: { ...c.expected, criteria: { criteria: 'Nevner fristen' } },
        })),
      },
    };
    const evaluate = async () => {
      const run = await kernel.invoke(kari, 'eval', {
        data: {
          capability: 'answer',
          testSet: criteriaSet,
          evaluators: ['judge:criteria'],
          provenance: { commit: 'abc', data: 'd1' },
        },
      });
      const [part] = await run.result;
      return part?.body.kind === 'json' ? (part.body.json as EvalRun) : undefined;
    };

    const first = await evaluate();
    const second = await evaluate();

    expect(picks).toEqual(['kari', 'kari']);
    expect(first?.provenance.judges).toEqual(['judge:criteria@1+foundry/claude-sonnet']);
    expect(second?.metrics['judge.criteria']?.mean).toBe(1);
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
