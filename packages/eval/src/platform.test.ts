import { mkdtempSync, writeFileSync } from 'node:fs';
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
  agreementMap,
  anonymousFeedback,
  basicPiiRedactor,
  cli,
  cohensKappa,
  contractAssertions,
  createEvalService,
  EvalAccessError,
  evalRunStrategy,
  expireCandidates,
  gate,
  InMemoryCandidateStore,
  InMemoryEvalRunStore,
  InMemoryFeedbackStore,
  InMemoryLabelStore,
  InMemoryTestSetStore,
  isNationalId,
  judgeAgreement,
  parseTestSet,
  proposeTestCase,
  publishGate,
  recordFeedback,
  retrievalRecall,
  reviewCandidate,
  withoutExpiredCases,
  type EvalRun,
  type Evaluator,
  type FeedbackRecord,
  type JudgeLabel,
  type RunStatus,
  type TestSet,
} from './index.js';

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };
const ola: Principal = { kind: 'employee', issuer: 'test', subject: 'ola', tenant: '889640782' };
const operator: Principal = { kind: 'operator', issuer: 'test', subject: 'ops' };

const descriptor = (id: string) => ({
  id,
  version: '1',
  tenant,
  title: id,
  description: id,
  input: {},
  interaction: ['unary' as const],
  accepts: [],
  produces: [],
  emits: [],
  oversight: { interrupts: false, riskClass: 'minimal' as const, aiDisclosure: 'KI' },
});

const model = { kind: 'model', id: 'foundry/gpt-4o', tenant };

const fakeModels: PortProvider<{ answer(): Promise<void> }> = {
  open: (ref, portContext) => ({
    answer: () => portContext.meter({ inputTokens: 10, outputTokens: 5, requests: 1 }, ref),
  }),
};

const answering: Strategy = {
  id: 'fake-rag',
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },
  run: async function* (c, input) {
    const question = input.parts?.[0]?.body.kind === 'text' ? input.parts[0].body.text : '';
    await (await c.use<{ answer(): Promise<void> }>('model', model)).answer();
    yield { type: 'kernel.notice', data: { kind: 'retrieval', hits: [{ id: 'c1' }] } };
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
};

const setOf = (version = 1): TestSet =>
  parseTestSet({
    apiVersion: 'genai/v1',
    kind: 'TestSet',
    metadata: { tenant, id: 'mini', name: 'Mini', version },
    spec: {
      service: 'kunnskapsassistenten',
      cases: [
        {
          id: 'a',
          split: 'validation',
          input: 'broker statuser',
          expected: { sources: [{ chunkId: 'c1' }], answerPattern: '(?i)publisert' },
        },
        {
          id: 'b',
          split: 'validation',
          input: 'events abonnement',
          expected: { sources: [{ chunkId: 'c1' }], answerPattern: '(?i)abonnement' },
          needsReview: true,
        },
      ],
    },
  });

const boot = async (extra: Evaluator[] = []) => {
  const holder: { kernel?: Kernel } = {};
  const evaluators = [contractAssertions(), retrievalRecall(3), ...extra];
  const evalCapability: Capability = {
    descriptor: descriptor('platform-eval'),
    strategy: { id: 'platform.eval.run', version: '1' },
    config: {},
    grants: [],
  };
  const kernel = (holder.kernel = createKernel({
    strategies: [
      answering,
      evalRunStrategy({
        kernel: () => holder.kernel as Kernel,
        evaluators: new Map(evaluators.map((e) => [e.id, e])),
        wait: { everyMs: 1 },
      }) as Strategy,
    ],
    capabilities: [
      {
        descriptor: descriptor('answer'),
        strategy: { id: 'fake-rag', version: '1' },
        config: {},
        grants: [{ port: 'model', ref: model }],
      },
      evalCapability,
    ],
    ports: { model: fakeModels },
    policy: { decide: async () => ({ allow: true }) },
  }));
  const testSets = new InMemoryTestSetStore();
  await testSets.put(setOf());
  const runs = new InMemoryEvalRunStore();
  const service = createEvalService({ kernel, evalCapability: 'platform-eval', testSets, runs });
  return { kernel, testSets, runs, service };
};

const settle = async (status: () => Promise<RunStatus>): Promise<RunStatus> => {
  for (let i = 0; i < 200; i += 1) {
    const current = await status();
    if (current.state !== 'running' && current.state !== 'waiting-for-scores') return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error('eval run did not finish');
};

const start = (
  service: Awaited<ReturnType<typeof boot>>['service'],
  subject: string,
  evaluators = ['contract', 'retrieval'],
) =>
  service.startRun(kari, {
    tenant,
    capability: 'answer',
    testSet: { id: 'mini' },
    evaluators,
    provenance: { commit: 'abc', data: 'kudos@1' },
    service: 'kunnskapsassistenten',
    subject,
    splits: ['validation'],
  });

describe('eval service', () => {
  it("lists a tenant's test sets with split counts and cases awaiting review, and nobody else's", async () => {
    const { service } = await boot();

    expect(await service.listTestSets(kari, tenant)).toEqual([
      {
        id: 'mini',
        name: 'Mini',
        version: 1,
        service: 'kunnskapsassistenten',
        cases: 2,
        splits: { train: 0, validation: 2, holdout: 0 },
        needsReview: 1,
      },
    ]);
    await expect(service.listTestSets(ola, tenant)).rejects.toBeInstanceOf(EvalAccessError);
  });

  it('lets an operator read tenant test sets only inside a support session', async () => {
    const { service } = await boot();

    await expect(service.listTestSets(operator, tenant)).rejects.toBeInstanceOf(EvalAccessError);
    expect(
      await service.listTestSets({ ...operator, tenant, actor: operator }, tenant),
    ).toHaveLength(1);
  });

  it('runs an eval as a kernel task, stores the run with provenance and intervals, and reads it back', async () => {
    const { service, kernel } = await boot();

    const started = await start(service, 'v2');
    const done = await settle(() => service.status(kari, started.task));

    expect(done.state).toBe('completed');
    const runId = done.state === 'completed' ? done.run : '';
    const { run, provenance, metrics } = await service.getRun(kari, runId);
    expect(run.results.map((r) => r.case)).toEqual(['a', 'b']);
    expect(provenance).toMatchObject({ commit: 'abc', data: 'kudos@1' });
    expect(metrics['answer-pattern']).toMatchObject({ mean: 0.5, n: 2 });
    expect(metrics['answer-pattern']?.ci).toHaveLength(2);
    expect((await kernel.task(kari, started.task)).status).toBe('completed');
    await expect(service.getRun(ola, runId)).rejects.toBeInstanceOf(EvalAccessError);
    await expect(service.status(ola, started.task)).rejects.toBeInstanceOf(EvalAccessError);
    expect((await service.listRuns(kari, { tenant })).map((r) => r.subject)).toEqual(['v2']);
  });

  it('answers the status of an eval run from any instance, not only the one that started it', async () => {
    const { service, kernel, testSets, runs } = await boot();
    const elsewhere = createEvalService({
      kernel,
      evalCapability: 'platform-eval',
      testSets,
      runs,
    });

    const started = await start(service, 'v3');
    const done = await settle(() => elsewhere.status(kari, started.task));

    expect(done).toEqual(await service.status(kari, started.task));
    expect(done.state).toBe('completed');
    await expect(elsewhere.status(ola, started.task)).rejects.toBeInstanceOf(EvalAccessError);
    await expect(elsewhere.status(kari, 'finnes-ikke')).rejects.toBeInstanceOf(EvalAccessError);
  });

  it('answers that a run is waiting for scores, and for how many, while its judge has not delivered', async () => {
    let release = () => {};
    const delivered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const self: Evaluator = {
      id: 'judge:later',
      version: '1',
      kind: 'model',
      evaluate: async () => [
        {
          evaluator: self.id,
          version: self.version,
          metric: 'judge.later',
          value: null,
          applicable: true,
          state: 'pending',
        },
      ],
      collect: async (pending) => {
        await delivered;
        return pending.map((item) => ({
          case: item.case,
          repeat: item.repeat,
          score: { ...item.score, value: 1, state: 'scored' },
        }));
      },
    };
    const { service } = await boot([self]);

    const started = await start(service, 'v4', ['contract', 'judge:later']);
    let waiting: RunStatus = { state: 'running', task: started.task };
    for (let i = 0; i < 200 && waiting.state === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      waiting = await service.status(kari, started.task);
    }
    release();
    const done = await settle(() => service.status(kari, started.task));

    expect(waiting).toMatchObject({
      state: 'waiting-for-scores',
      task: started.task,
      pending: 2,
      until: expect.any(String),
    });
    expect(done.state).toBe('completed');
    const runId = done.state === 'completed' ? done.run : '';
    expect((await service.getRun(kari, runId)).metrics['judge.later']?.mean).toBe(1);
  });

  it("compares two runs of the same test set and refuses another tenant's run", async () => {
    const { service } = await boot();
    const one = await start(service, 'v1');
    const first = await settle(() => service.status(kari, one.task));
    const two = await start(service, 'v2');
    const second = await settle(() => service.status(kari, two.task));
    const id = (s: RunStatus) => (s.state === 'completed' ? s.run : '');

    const comparison = await service.compare(kari, id(first), id(second), 'answer-pattern', {
      allowDifferent: ['commit'],
    });

    expect(comparison).toMatchObject({ n: 2, difference: 0 });
    await expect(
      service.compare(ola, id(first), id(second), 'answer-pattern'),
    ).rejects.toBeInstanceOf(EvalAccessError);
  });

  it('refuses a run on a test set the tenant does not have', async () => {
    const { service } = await boot();

    await expect(
      service.startRun(kari, {
        tenant,
        capability: 'answer',
        testSet: { id: 'missing' },
        evaluators: ['contract'],
        provenance: { commit: 'abc', data: 'd' },
      }),
    ).rejects.toThrow(/no test set missing/);
  });
});

const fakeRun = (id: string, subject: string, value: number, judges: string[] = []): EvalRun => ({
  id,
  testSet: { tenant, id: 'mini', version: 1 },
  capability: 'answer',
  splits: ['validation'],
  repeats: 1,
  startedAt: '2026-10-06T10:00:00Z',
  endedAt: `2026-10-06T10:0${subject === 'v2' ? 2 : 1}:00Z`,
  provenance: { commit: subject, data: 'd', servedModels: ['m'], judges, services: [subject] },
  results: ['a', 'b', 'c', 'd'].map((c) => ({
    case: c,
    split: 'validation' as const,
    repeat: 0,
    task: `t-${c}`,
    tags: [],
    scores: [
      {
        evaluator: 'contract',
        version: '1',
        metric: 'answer-pattern',
        value,
        applicable: true,
        state: 'scored' as const,
      },
      {
        evaluator: 'judge',
        version: '1',
        metric: 'judge.correct',
        value,
        applicable: true,
        state: 'scored' as const,
      },
    ],
  })),
  metrics: {},
  byTag: {},
  incomplete: [],
});

describe('publish gate', () => {
  const registry = new Map([
    [
      'pattern-floor',
      gate.parse({
        id: 'pattern-floor',
        metric: 'answer-pattern',
        kind: 'threshold',
        threshold: 0.8,
      }),
    ],
    [
      'no-judge-regression',
      gate.parse({ id: 'no-judge-regression', metric: 'judge.correct', kind: 'no-regression' }),
    ],
  ]);

  const stored = async (...runs: [EvalRun, string][]) => {
    const store = new InMemoryEvalRunStore();
    for (const [run, subject] of runs)
      await store.save({ run, tenant, task: run.id, service: 'kunnskapsassistenten', subject });
    return store;
  };

  it("allows a publish when every gate passes on the candidate's latest run", async () => {
    const runs = await stored([fakeRun('r2', 'v2', 0.9), 'v2']);

    const decision = await publishGate({
      tenant,
      service: 'kunnskapsassistenten',
      candidate: 'v2',
      evaluation: { testSets: ['mini'], gates: ['pattern-floor'] },
      runs,
      registry,
    });

    expect(decision).toMatchObject({ allow: true, refused: [], advisory: [] });
  });

  it('refuses a publish below a threshold or without a run, naming why', async () => {
    const low = await publishGate({
      tenant,
      service: 'kunnskapsassistenten',
      candidate: 'v2',
      evaluation: { testSets: ['mini'], gates: ['pattern-floor'] },
      runs: await stored([fakeRun('r2', 'v2', 0.5), 'v2']),
      registry,
    });
    const missing = await publishGate({
      tenant,
      service: 'kunnskapsassistenten',
      candidate: 'v3',
      evaluation: { testSets: ['mini'], gates: ['pattern-floor'] },
      runs: await stored([fakeRun('r2', 'v2', 0.9), 'v2']),
      registry,
    });

    expect(low.allow).toBe(false);
    expect(low.refused).toEqual(['pattern-floor on mini: answer-pattern 0.500 < 0.8']);
    expect(missing.refused).toEqual(['pattern-floor on mini: no eval run for test set mini']);
  });

  it('lets a regression flagged by an uncalibrated judge advise but not block', async () => {
    const runs = await stored(
      [fakeRun('r1', 'v1', 0.9, ['judge-a']), 'v1'],
      [fakeRun('r2', 'v2', 0.2, ['judge-a']), 'v2'],
    );
    const input = {
      tenant,
      service: 'kunnskapsassistenten',
      candidate: 'v2',
      baseline: 'v1',
      evaluation: { testSets: ['mini'], gates: ['no-judge-regression'] },
      runs,
      registry,
      bootstrap: { seed: 1, resamples: 200 },
    };

    const uncalibrated = await publishGate({
      ...input,
      judgeAgreement: new Map([['judge-a', 0.4]]),
    });
    const calibrated = await publishGate({ ...input, judgeAgreement: new Map([['judge-a', 0.8]]) });

    expect(uncalibrated.allow).toBe(true);
    expect(uncalibrated.advisory[0]).toMatch(
      /regressed.*advisory: judge judge-a is not calibrated/,
    );
    expect(calibrated.allow).toBe(false);
  });

  it('allows a service with no gates without looking for runs', async () => {
    const decision = await publishGate({
      tenant,
      service: 's',
      candidate: 'v1',
      evaluation: { testSets: [], gates: [] },
      runs: new InMemoryEvalRunStore(),
      registry,
    });

    expect(decision.allow).toBe(true);
  });
});

describe('feedback', () => {
  it('records a thumbs rating as a feedback event on the task and keeps it for the tenant', async () => {
    const { kernel } = await boot();
    const run = await kernel.invoke(kari, 'answer', {
      parts: [{ mime: 'text/plain', body: { kind: 'text', text: 'broker' } }],
    });
    await run.result;
    const store = new InMemoryFeedbackStore();

    const record = await recordFeedback(
      { kernel, store, now: () => new Date('2026-10-06T12:00:00Z') },
      kari,
      { task: run.task, rating: 'down', comment: 'Mangler kilde' },
    );

    const audit: Event[] = [];
    for await (const e of await kernel.events(kari, run.task, { audience: 'audit' })) audit.push(e);
    expect(audit.find((e) => e.type === 'kernel.feedback')?.data).toMatchObject({
      rating: 'down',
      comment: 'Mangler kilde',
      by: { kind: 'employee', id: 'test:kari' },
    });
    expect(record.tenant).toBe(tenant);
    expect(await store.list(tenant, { rating: 'down' })).toHaveLength(1);
  });

  it('removes phone numbers and emails from the comment before anything is stored', async () => {
    const { kernel } = await boot();
    const run = await kernel.invoke(kari, 'answer', {
      parts: [{ mime: 'text/plain', body: { kind: 'text', text: 'broker' } }],
    });
    await run.result;
    const store = new InMemoryFeedbackStore();

    await recordFeedback({ kernel, store }, kari, {
      task: run.task,
      rating: 'down',
      comment: 'Ring meg på 912 34 567 eller skriv til kari@example.no',
    });

    const audit: Event[] = [];
    for await (const e of await kernel.events(kari, run.task, { audience: 'audit' })) audit.push(e);
    const [stored] = await store.list(tenant);
    expect(stored?.comment).toBe('Ring meg på [phone] eller skriv til [email]');
    expect(stored?.capability).toBe('answer');
    expect(JSON.stringify(audit)).not.toContain('912 34 567');
  });

  it('shows comments only for ratings given at least five times, and never who gave them', () => {
    const record = (i: number, rating: 'up' | 'down'): FeedbackRecord => ({
      task: `t${i}`,
      rating,
      comment: `kommentar ${i}`,
      by: { kind: 'employee', id: `test:ansatt-${i}` },
      at: '2026-10-07T08:15:00.000Z',
      tenant,
    });
    const records = [...[1, 2, 3, 4, 5].map((i) => record(i, 'up')), record(6, 'down')];

    const shown = anonymousFeedback(records);

    expect(shown.filter((f) => f.rating === 'up')).toHaveLength(5);
    expect(shown[0]).toEqual({
      task: 't1',
      rating: 'up',
      at: '2026-10-07T08:15:00.000Z',
      comment: 'kommentar 1',
    });
    expect(shown[5]).toEqual({ rating: 'down', at: '2026-10-07' });
    expect(JSON.stringify(shown)).not.toContain('ansatt');
  });

  it('refuses feedback on a task the caller cannot see', async () => {
    const { kernel } = await boot();
    const run = await kernel.invoke(kari, 'answer', {
      parts: [{ mime: 'text/plain', body: { kind: 'text', text: 'x' } }],
    });
    await run.result;

    await expect(
      recordFeedback({ kernel, store: new InMemoryFeedbackStore() }, ola, {
        task: run.task,
        rating: 'up',
      }),
    ).rejects.toThrow();
  });
});

describe('personal data', () => {
  it('recognises valid national ID numbers by checksum, including D-numbers, and leaves look-alikes', () => {
    expect(isNationalId('01017012345')).toBe(false);
    expect(isNationalId('15876510089')).toBe(true);
    expect(isNationalId('158765 10089')).toBe(true);
    expect(isNationalId('55876510089')).toBe(false);
    expect(isNationalId('41810010051')).toBe(true);
    expect(isNationalId('12345678901')).toBe(false);
  });

  it('replaces national IDs, emails and phone numbers, and reports what it found', () => {
    const { text, findings } = basicPiiRedactor.redact(
      'Kari (15876510089, kari@example.no, +47 912 34 567) spør om saksnummer 2024/1234 og 12345678901.',
    );

    expect(text).toBe(
      'Kari ([national-id], [email], [phone]) spør om saksnummer 2024/1234 og 12345678901.',
    );
    expect(findings).toEqual([
      { category: 'national-id', count: 1 },
      { category: 'email', count: 1 },
      { category: 'phone', count: 1 },
    ]);
  });
});

describe('from feedback to test case', () => {
  const setup = async () => {
    const store = new InMemoryCandidateStore();
    const testSets = new InMemoryTestSetStore();
    await testSets.put(setOf());
    let n = 0;
    const deps = {
      store,
      testSets,
      redactor: basicPiiRedactor,
      now: () => new Date('2026-10-06T12:00:00Z'),
      newId: () => `fb-${++n}`,
    };
    return deps;
  };

  it('anonymises a proposed case and holds it for review with an expiry date', async () => {
    const deps = await setup();

    const candidate = await proposeTestCase(deps, {
      tenant,
      task: 't1',
      question: 'Hva gjelder for 15876510089 i tildelingsbrevet?',
      answer: 'Ring 912 34 567.',
      proposedBy: 'kari',
      ttlDays: 30,
    });

    expect(candidate).toMatchObject({
      question: 'Hva gjelder for [national-id] i tildelingsbrevet?',
      answer: 'Ring [phone].',
      status: 'pending-review',
      expiresAt: '2026-11-05T12:00:00.000Z',
      findings: [
        { category: 'national-id', count: 1 },
        { category: 'phone', count: 1 },
      ],
    });
  });

  it('refuses a candidate when anonymisation leaves personal data behind', async () => {
    const deps = await setup();
    const leaky = {
      redact: (text: string) => ({ text, findings: [{ category: 'email', count: 1 }] }),
    };

    await expect(
      proposeTestCase(
        { ...deps, redactor: leaky },
        { tenant, task: 't', question: 'q', proposedBy: 'kari' },
      ),
    ).rejects.toThrow(/still contains personal data/);
  });

  it('lets the person who proposed a case accept it into a new version of the test set', async () => {
    const deps = await setup();
    const candidate = await proposeTestCase(deps, {
      tenant,
      task: 't1',
      question: 'Hva sier tildelingsbrevet?',
      sources: [{ document: 'd1', position: 2 }],
      proposedBy: 'kari',
    });

    const accepted = await reviewCandidate(deps, {
      candidate: candidate.id,
      reviewer: 'kari',
      decision: 'accept',
      testSet: 'mini',
      referenceAnswer: 'Det sier mye.',
    });

    const next = await deps.testSets.get(tenant, 'mini');
    expect(accepted.testSet).toEqual({ id: 'mini', version: 2, case: 'fb-1' });
    expect(next?.spec.cases.at(-1)).toMatchObject({
      id: 'fb-1',
      input: 'Hva sier tildelingsbrevet?',
      expected: { referenceAnswer: 'Det sier mye.', sources: [{ document: 'd1', position: 2 }] },
      tags: ['from-feedback'],
      origin: { task: 't1', expiresAt: candidate.expiresAt },
    });
    await expect(
      reviewCandidate(deps, { candidate: candidate.id, reviewer: 'ola', decision: 'reject' }),
    ).rejects.toThrow(/already accepted/);
  });

  it('expires stale candidates and drops expired cases from a test set', async () => {
    const deps = await setup();
    await proposeTestCase(deps, {
      tenant,
      task: 't',
      question: 'q',
      proposedBy: 'kari',
      ttlDays: 1,
    });

    expect(await expireCandidates(deps.store, tenant, new Date('2026-10-08T00:00:00Z'))).toEqual([
      'fb-1',
    ]);
    const set = parseTestSet({
      ...setOf(),
      spec: {
        ...setOf().spec,
        cases: [
          ...setOf().spec.cases,
          {
            id: 'fb-9',
            split: 'train',
            input: 'q',
            origin: { task: 't', expiresAt: '2026-10-07T00:00:00Z' },
          },
        ],
      },
    });
    expect(
      withoutExpiredCases(set, new Date('2026-10-08T00:00:00Z'))?.spec.cases.map((c) => c.id),
    ).toEqual(['a', 'b']);
    expect(withoutExpiredCases(setOf(), new Date('2026-10-08T00:00:00Z'))).toBeUndefined();
  });
});

describe('judge calibration', () => {
  const labels = (judge: string, pairs: [string, string][]): JudgeLabel[] =>
    pairs.map(([j, h], i) => ({
      item: `i${i}`,
      judge,
      judgeLabel: j,
      humanLabel: h,
      labeller: 'kari',
    }));

  it("computes Cohen's kappa against a worked example", () => {
    const pairs: [string, string][] = [
      ...Array<[string, string]>(20).fill(['yes', 'yes']),
      ...Array<[string, string]>(5).fill(['yes', 'no']),
      ...Array<[string, string]>(10).fill(['no', 'yes']),
      ...Array<[string, string]>(15).fill(['no', 'no']),
    ];

    const { kappa, observed } = cohensKappa(pairs);

    expect(observed).toBeCloseTo(0.7, 10);
    expect(kappa).toBeCloseTo(0.4, 10);
    expect(
      cohensKappa([
        ['a', 'a'],
        ['a', 'a'],
      ]).kappa,
    ).toBe(1);
  });

  it('reports agreement per judge and which judges may block a publish', async () => {
    const store = new InMemoryLabelStore();
    await store.add([
      ...labels('good', [
        ['pass', 'pass'],
        ['fail', 'fail'],
        ['pass', 'pass'],
        ['fail', 'fail'],
      ]),
      ...labels('poor', [
        ['pass', 'fail'],
        ['fail', 'pass'],
        ['pass', 'pass'],
        ['fail', 'fail'],
      ]),
    ]);
    const all = await store.list();

    expect(judgeAgreement(all).map((a) => [a.judge, a.kappa, a.blocking])).toEqual([
      ['good', 1, true],
      ['poor', 0, false],
    ]);
    expect(agreementMap(all)).toEqual(
      new Map([
        ['good', 1],
        ['poor', 0],
      ]),
    );
  });

  it('prints kappa per judge from a labels file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kappa-'));
    const file = join(dir, 'labels.json');
    writeFileSync(
      file,
      JSON.stringify(
        labels('judge-x', [
          ['pass', 'pass'],
          ['fail', 'fail'],
        ]),
      ),
    );
    const out: string[] = [];

    const code = cli(['kappa', file], { out: (l) => out.push(l), err: (l) => out.push(l) });

    expect(code).toBe(0);
    expect(out).toEqual(['judge-x: kappa 1.000, agreement 1.000 over 2 items, may block']);
  });
});
