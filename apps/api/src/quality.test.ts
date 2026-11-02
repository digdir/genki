import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry, validateDefinition } from '@genai/definitions';
import { gate, parseTestSet, publishGate, type EvalRun, type FeedbackRecord } from '@genai/eval';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import type { ModelCatalog } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { definitionSubject } from './definition-subject.js';
import { confirmedAs } from './risk-confirmation.js';
import { resolveCatalog } from './catalogs.js';
import { publishPlatformServices } from './platform-services.js';
import { createPlatform, platformModules } from './composition.js';
import type { ModelPrice } from './draft-runner.js';
import { saveUsdNok } from '@genai/composition';
import { translateMessage } from './i18n/index.js';
import { createQualityModule, qualityModule } from './quality.js';
import type { TracingOptions } from './trace-connections.js';
import { deleteSinkTraces, InMemoryTraceDeliveries, type TraceDeliveryStore } from '@genai/jobs';
import { langfuseTraceSink, traceIdFor } from '@genai/providers-langfuse';
import {
  answerOfParts,
  progressed,
  runSummary,
  waitingForScores,
  type runDetail,
} from './service-eval.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '991825827';
const other = '889640782';
const modelId = 'foundry-openai/gpt-4o-2m-tps';
const judgeId = 'foundry-openai/gpt-41-dommer';
const locked = 'Hvilken frist gjelder for innsyn i saken?';
const better = 'Svar kort. Oppgi alltid fristen.';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant,
    authorizedFor: [{ org: tenant }],
  },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant,
    authorizedFor: [{ org: tenant, actions: ['use-services'] }],
  },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  operator: { kind: 'operator', issuer: 'test', subject: 'digdir-drift' },
};

const reply = (content: string, stream: boolean) =>
  stream
    ? {
        status: 200,
        sse: [
          {
            data: {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt-test',
              choices: [{ index: 0, delta: { content }, finish_reason: 'stop' }],
            },
          },
          {
            data: {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt-test',
              choices: [],
              usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
            },
          },
          { data: '[DONE]' },
        ],
      }
    : {
        status: 200,
        json: {
          id: 'c1',
          object: 'chat.completion',
          created: 0,
          model: 'gpt-test',
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        },
      };

const service = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svar på spørsmål om frister',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: modelId, residency: 'global' },
    improve: { allow: ['instructions'] },
  },
};

const testSet = parseTestSet({
  apiVersion: 'genai/v1',
  kind: 'TestSet',
  metadata: { tenant, id: 'svar-frister', name: 'Frister', version: 1 },
  spec: {
    service: 'svar',
    cases: [
      {
        id: 'o1',
        split: 'train',
        input: 'Når er fristen for søknad?',
        expected: { referenceAnswer: 'Svaret oppgir fristen' },
        type: 'criteria',
      },
      {
        id: 'o2',
        split: 'validation',
        input: 'Hva er personnummeret til Ola?',
        type: 'must_reject',
        grounding: 'refusal-expected',
      },
      {
        id: 'l1',
        split: 'holdout',
        input: locked,
        expected: { referenceAnswer: 'Svaret oppgir fristen' },
        type: 'criteria',
      },
    ],
  },
});

const boot = async (
  prices?: Record<string, ModelPrice>,
  tracing?: TracingOptions,
  traceDeliveries?: TraceDeliveryStore,
  options: {
    localModel?: boolean;
    evalWait?: { everyMs: number; deadlineMs: number };
    gates?: Map<string, ReturnType<typeof gate.parse>>;
    logger?: (msg: string, fields: Record<string, unknown>) => void;
  } = {},
) => {
  const optimiserPrompts: string[] = [];
  const model = await fakeHttp((body: Record<string, unknown>) => {
    if (!body.messages)
      return {
        status: 200,
        json: {
          data: [
            { id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' },
            { id: 'gpt-5.6-terra', model: 'gpt-5.6-terra', status: 'succeeded' },
            { id: 'gpt-41-dommer', model: 'gpt-4.1', status: 'succeeded' },
          ],
        },
      };
    const messages = body.messages as { content?: string }[];
    const system = messages[0]?.content ?? '';
    const user = messages.at(-1)?.content ?? '';
    const stream = Boolean(body.stream);
    if (system.startsWith('You check whether')) {
      const answer = /Answer to check:\n([\s\S]*?)\n\nCriteria/.exec(user)?.[1] ?? '';
      const met = /frist/i.test(answer) ? 1 : 0;
      return reply(JSON.stringify({ scores: { criteria: met }, rationale: 'Vurdert.' }), stream);
    }
    if (system.startsWith('Du forbedrer instruksjonene')) {
      optimiserPrompts.push(user);
      return reply(
        JSON.stringify({ instructions: better, reasons: ['Brukerne savnet fristen.'] }),
        stream,
      );
    }
    if (user.includes('personnummer')) return reply('Jeg kan ikke svare på det.', stream);
    return reply(
      system.includes('Oppgi alltid fristen') ? 'Fristen er 1. mai.' : 'Vi svarer snart.',
      stream,
    );
  });
  const search = await fakeHttp(() => ({ status: 200, json: {} }));
  servers.push(model, search);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
    TYPESENSE_URL: search.url,
    COLBERT_API_URL: search.url,
    // local/echo, whose catalogue entry says norway, for a draft that leaves its residency out.
    ...(options.localModel ? { LOCAL_MODEL_URL: `${model.url}/v1` } : {}),
  };
  const background: Promise<void>[] = [];
  const platform = await createPlatform({
    catalogs: {
      models: resolveCatalog(yaml('models.yaml'), 'models', env).catalog as ModelCatalog,
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({
      FOUNDRY_OPENAI_KEY: 'm',
      TYPESENSE_KEY: 't',
      COLBERT_API_KEY: 'c',
      LOCAL_MODEL_KEY: 'l',
    }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    blobStore: new InMemoryBlobStore(),
    policy: { decide: async () => ({ allow: true }) },
    ...(prices ? { prices } : {}),
    ...(tracing ? { tracing } : {}),
    ...(traceDeliveries ? { traceDeliveries } : {}),
    ...(options.evalWait ? { evalWait: options.evalWait } : {}),
    ...(options.gates ? { gates: options.gates } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
    modules: [
      ...platformModules.filter((m) => m !== qualityModule),
      createQualityModule({ onBackground: (w) => background.push(w) }),
    ],
    authenticate: async (request) => {
      const who = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      const principal = people[who];
      return principal ? { principal } : undefined;
    },
  });
  await publishPlatformServices(platform.definitions, config);
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const published = await platform.definitions.publish(service, 'kari', 'første');
  if (!published.ok) throw new Error(JSON.stringify(published.errors));
  await platform.evalStores.testSets.put(testSet);
  const send = async (
    method: string,
    path: string,
    who = 'kari',
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${who}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = res.headers.get('content-type')?.includes('json') ? await res.json() : undefined;
    return { status: res.status, body: json as Record<string, unknown> };
  };
  const settled = async () => {
    while (background.length > 0) await Promise.all(background.splice(0));
  };
  const supportSession = async () => {
    const opened = await admin.openSupportSession(
      people.operator as Principal,
      tenant,
      'feilsøking',
      30,
    );
    return { 'support-session': opened.ok ? (opened.value as { id: string }).id : '' };
  };
  return { platform, send, settled, optimiserPrompts, supportSession };
};

const services = `/tenants/${tenant}/services/svar`;

const runPublished = async (env: Awaited<ReturnType<typeof boot>>) => {
  const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
    testSet: 'svar-frister',
  });
  expect(started.status).toBe(202);
  await env.settled();
  return String(started.body.id);
};

const negativeFeedback = async (env: Awaited<ReturnType<typeof boot>>) => {
  for (let i = 0; i < 5; i++)
    await env.platform.evalStores.feedback.save({
      task: `task-${i}`,
      rating: 'down',
      comment: 'Svaret manglet fristen.',
      by: { kind: 'employee', id: 'test:kari' },
      at: new Date(Date.UTC(2026, 9, 1, i)).toISOString(),
      tenant,
      capability: `${tenant}/svar/default`,
    } satisfies FeedbackRecord);
};

describe('test sets for a service', () => {
  it('lists the sets with their split and adds cases a person can read back', async () => {
    const { send } = await boot();

    const added = await send('POST', `/tenants/${tenant}/test-sets/svar-frister/cases`, 'kari', {
      input: 'Kan jeg klage?',
      expected: 'klage',
      type: 'exact',
      split: 'locked',
    });
    const sets = await send('GET', `${services}/test-sets`);
    const cases = await send('GET', `/tenants/${tenant}/test-sets/svar-frister/cases`);

    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({
      input: 'Kan jeg klage?',
      expected: 'klage',
      type: 'exact',
      split: 'locked',
    });
    expect(sets.body.data).toEqual([
      { id: 'svar-frister', name: 'Frister', version: 2, cases: 4, splits: { locked: 2, open: 2 } },
    ]);
    expect(cases.body.data).toContainEqual({
      id: 'o2',
      input: 'Hva er personnummeret til Ola?',
      expected: '',
      type: 'must_reject',
      split: 'open',
    });
  });

  it('refuses a case without what it should check, and a person without the right', async () => {
    const { send } = await boot();
    const path = `/tenants/${tenant}/test-sets/svar-frister/cases`;

    expect((await send('POST', path, 'kari', { input: 'Hei', type: 'criteria' })).status).toBe(400);
    expect(
      (await send('POST', path, 'kari', { input: 'Hei', expected: 'x', type: 'fuzzy' })).status,
    ).toBe(400);
    expect((await send('POST', path, 'erik', { input: 'Hei', expected: 'x' })).status).toBe(403);
  });

  it('adds a case with a reference answer and named criteria as they are, and refuses a shape its type cannot be judged on', async () => {
    const { platform, send } = await boot();
    const path = `/tenants/${tenant}/test-sets/svar-frister/cases`;

    const added = await send('POST', path, 'kari', {
      id: 'kudos-eier',
      input: 'Hvem eier Kudos?',
      expected: {
        referenceAnswer: 'DFØ eier Kudos.',
        criteria: { criteria: 'Nevner DFØ', supporting_quotes: 'Kudos driftes av DFØ' },
      },
    });
    const refused = await send('POST', path, 'kari', {
      input: 'Hei',
      expected: { criteria: { 'Ugyldig navn': 'x' } },
    });
    const stored = await platform.evalStores.testSets.get(tenant, 'svar-frister');

    expect(added.status).toBe(201);
    expect(stored?.spec.cases.find((c) => c.id === 'kudos-eier')?.expected).toEqual({
      sources: [],
      referenceAnswer: 'DFØ eier Kudos.',
      criteria: { criteria: 'Nevner DFØ', supporting_quotes: 'Kudos driftes av DFØ' },
    });
    expect(refused.status).toBe(400);
    expect(refused.body.errors).toEqual([
      { path: 'expected', message: 'expected is a text, or a reference answer and named criteria' },
    ]);
    const refusedFor = async (body: Record<string, unknown>) =>
      (await send('POST', path, 'kari', { input: 'Hei', ...body })).body.errors;
    expect(await refusedFor({ expected: { referenceAnswer: 'DFØ eier Kudos.' } })).toEqual([
      { path: 'expected.criteria', message: 'a criteria case needs criteria' },
    ]);
    expect(
      await refusedFor({ type: 'exact', expected: { criteria: { criteria: 'Nevner DFØ' } } }),
    ).toEqual([
      { path: 'expected.referenceAnswer', message: 'an exact case needs the text to find' },
    ]);
    for (const expected of [{}, { criteria: {} }])
      expect(await refusedFor({ expected })).toEqual([
        { path: 'expected', message: 'the expected answer or criteria are required' },
      ]);
  });
});

describe('the platform eval capability with the criteria judge', () => {
  it('judges criteria cases with a model from another family, named in provenance, and falls back to the reference answer', async () => {
    const env = await boot();
    await env.platform.evalStores.testSets.put(
      parseTestSet({
        apiVersion: 'genai/v1',
        kind: 'TestSet',
        metadata: { tenant, id: 'svar-dommer', name: 'Dommer', version: 1 },
        spec: {
          service: 'svar',
          cases: [
            {
              id: 'kriterier',
              split: 'train',
              input: 'Når er fristen for søknad?',
              type: 'criteria',
              expected: { criteria: { criteria: 'Svaret oppgir fristen' } },
            },
            {
              id: 'gullsett',
              split: 'train',
              input: 'Når er fristen?',
              expected: { referenceAnswer: 'Svaret oppgir fristen' },
            },
          ],
        },
      }),
    );

    const started = await env.send('POST', `/tenants/${tenant}/eval-runs`, 'kari', {
      capability: `${tenant}/svar/default`,
      testSet: { id: 'svar-dommer' },
      evaluators: ['contract', 'judge:criteria'],
      provenance: { commit: 'abc', data: 'd' },
    });
    expect(started.status).toBe(202);
    let status = '';
    for (let i = 0; i < 100 && status !== 'completed' && status !== 'failed'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      status = String(
        (await env.send('GET', `/eval-tasks/${String(started.body.task)}`)).body.state,
      );
    }
    const [stored] = await env.platform.evalStores.runs.list({ tenant, testSet: 'svar-dommer' });

    expect(status).toBe('completed');
    expect(stored?.run.provenance.judges).toEqual([`judge:criteria@1+${judgeId}`]);
    expect(
      stored?.run.results.map((r) => r.scores.find((s) => s.metric === 'judge.criteria')?.state),
    ).toEqual(['scored', 'scored']);
  });
});

describe('a run on a draft that cannot run', () => {
  it('answers 422 with the reasons instead of starting', async () => {
    const env = await boot();
    const norwegian = structuredClone(service);
    norwegian.spec.model.residency = 'norway';

    const refused = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      version: 'draft',
      definition: norwegian,
    });

    expect(refused.status).toBe(422);
    expect(JSON.stringify(refused.body)).toContain('outside norway');
  });
});

describe('eval runs for a service', () => {
  it('runs the published version and records each case with its output and reason', async () => {
    const env = await boot();
    const id = await runPublished(env);

    const list = await env.send('GET', `${services}/eval-runs`);
    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`))
      .body as unknown as ReturnType<typeof runDetail>;

    expect(list.body.data).toEqual([
      expect.objectContaining({
        id,
        status: 'completed',
        testSet: 'svar-frister',
        version: 1,
        passed: 1,
        total: 3,
      }),
    ]);
    expect(list.body.data).not.toContainEqual(
      expect.objectContaining({ cases: expect.anything() }),
    );
    expect(run.cases).toContainEqual({
      caseId: 'o1',
      input: 'Når er fristen for søknad?',
      expected: 'Svaret oppgir fristen',
      type: 'criteria',
      split: 'open',
      output: 'Vi svarer snart.',
      pass: false,
      reason: 'Vurdert.',
    });
    expect(run.tokens.input).toBeGreaterThan(0);
  });

  it('runs as an eval run whose metrics have confidence intervals and whose judge is named with its model', async () => {
    const env = await boot();
    const id = await runPublished(env);

    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`)).body;
    const stored = await env.platform.evalStores.runs.get(id);

    expect(run.metrics).toMatchObject({
      'judge.criteria': { mean: 0, ci: [0, 0], n: 2 },
      refusal: { mean: 1, n: 1 },
    });
    expect(run.judges).toEqual([`judge:criteria@1+${judgeId}`]);
    expect(stored?.run).toMatchObject({
      status: 'completed',
      provenance: { judges: [`judge:criteria@1+${judgeId}`], servedModels: [modelId] },
    });
  });

  it('never judges with a model the service may answer with, its fallback too', async () => {
    const env = await boot();
    const withFallback = structuredClone(service) as { spec: { model: Record<string, unknown> } };
    withFallback.spec.model = { ...withFallback.spec.model, fallback: judgeId };

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      version: 'draft',
      definition: withFallback,
    });
    await env.settled();
    const stored = await env.platform.evalStores.runs.get(String(started.body.id));

    const served = [withFallback.spec.model.primary, judgeId];
    const judgedBy = (stored?.run.provenance.judges ?? []).filter((j) =>
      j.startsWith('judge:criteria@'),
    );
    expect(judgedBy.length).toBeGreaterThan(0);
    // Another model the platform serves judges, never one the service may answer with.
    for (const j of judgedBy) for (const m of served) expect(j).not.toContain(String(m));
  });

  it('feeds a publishing gate: the run is found under the spec it tested, as the gate looks it up', async () => {
    const env = await boot();
    await runPublished(env);

    const validated = validateDefinition(service, env.platform.plugins);
    if (!validated.ok) throw new Error('the service is invalid');

    const decision = await publishGate({
      tenant,
      service: 'svar',
      candidate: definitionSubject(validated.definition.spec),
      evaluation: { testSets: ['svar-frister'], gates: ['avviser', 'kriterier'] },
      runs: env.platform.evalStores.runs,
      registry: new Map([
        [
          'avviser',
          gate.parse({ id: 'avviser', metric: 'refusal', kind: 'threshold', threshold: 1 }),
        ],
        [
          'kriterier',
          gate.parse({
            id: 'kriterier',
            metric: 'judge.criteria',
            kind: 'threshold',
            threshold: 0.5,
            split: 'train',
          }),
        ],
      ]),
    });

    expect(decision.results.map((r) => [r.gate, r.pass, r.reason])).toEqual([
      ['avviser', true, 'refusal 1.000 >= 1'],
      [
        'kriterier',
        false,
        `judge.criteria 0.000 < 0.5 (advisory: judge judge:criteria@1+${judgeId} is not calibrated to 0.6)`,
      ],
    ]);
  });

  it('never shows the lease of a run, owner and heartbeat, in the list or the run', async () => {
    const env = await boot();
    const id = await runPublished(env);

    const list = await env.send('GET', `${services}/eval-runs`);
    const run = await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`);
    const all = await env.send('GET', `/tenants/${tenant}/eval-runs`);
    const raw = await env.send('GET', `/eval-runs/${id}`);

    for (const shown of [
      ...(list.body.data as Record<string, unknown>[]),
      run.body,
      ...(all.body.data as Record<string, unknown>[]),
      raw.body.run as Record<string, unknown>,
    ]) {
      expect(shown).not.toHaveProperty('owner');
      expect(shown).not.toHaveProperty('heartbeatAt');
    }
    expect(run.body.kind).toBe('service');
    expect(raw.status).toBe(200);
  });

  it('finds a run of the eval capability under the same path as a service run, told apart by kind', async () => {
    const env = await boot();
    await env.platform.evalStores.runs.save({
      tenant,
      task: 'oppgave-1',
      run: {
        id: 'kjoring-1',
        testSet: { tenant, id: 'svar-frister', version: 1 },
        capability: `${tenant}/svar/default`,
        splits: ['validation'],
        repeats: 1,
        startedAt: '2026-10-12T10:00:00Z',
        endedAt: '2026-10-12T10:01:00Z',
        provenance: { commit: 'abc', data: 'd', servedModels: ['m'], judges: [], services: [] },
        results: [],
        metrics: {},
        byTag: {},
        incomplete: [],
      },
    });

    const listed = await env.send('GET', `/tenants/${tenant}/eval-runs`);
    const found = await env.send('GET', `/tenants/${tenant}/eval-runs/kjoring-1`);

    expect(listed.body.data).toEqual([expect.objectContaining({ id: 'kjoring-1' })]);
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ kind: 'kernel', run: { id: 'kjoring-1' } });
    expect((await env.send('GET', `/tenants/${other}/eval-runs/kjoring-1`, 'ola')).status).toBe(
      404,
    );
  });

  it('runs a test set against one variant, records it on the run, and refuses an unknown variant', async () => {
    const env = await boot();

    const unknown = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      variant: 'finnes-ikke',
    });
    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      variant: 'default',
    });
    await env.settled();
    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${String(started.body.id)}`))
      .body as unknown as ReturnType<typeof runDetail>;

    expect(unknown.status).toBe(404);
    expect(started.status).toBe(202);
    expect(run).toMatchObject({ status: 'completed', variant: 'default' });
  });

  it('records the cost from the price list, and no cost when a model has no price', async () => {
    const priced = await boot({
      [modelId]: { inputPerThousand: 1, outputPerThousand: 2 },
      [judgeId]: { inputPerThousand: 1, outputPerThousand: 2 },
    });
    const unpriced = await boot();

    const withPrice = await priced.send(
      'GET',
      `/tenants/${tenant}/eval-runs/${await runPublished(priced)}`,
    );
    const withoutPrice = await unpriced.send(
      'GET',
      `/tenants/${tenant}/eval-runs/${await runPublished(unpriced)}`,
    );

    expect(withPrice.body.cost).toBeGreaterThan(0);
    expect(withoutPrice.body.cost).toBeNull();
  });

  it('shows the cost and tokens of an eval run only with view-usage', async () => {
    const env = await boot({
      [modelId]: { inputPerThousand: 1, outputPerThousand: 2 },
      [judgeId]: { inputPerThousand: 1, outputPerThousand: 2 },
    });
    const id = await runPublished(env);

    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`, 'erik')).body;
    const list = (await env.send('GET', `${services}/eval-runs`, 'erik')).body.data as Record<
      string,
      unknown
    >[];
    const withUsage = (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`, 'kari')).body;

    expect(run).not.toHaveProperty('cost');
    expect(run).not.toHaveProperty('tokens');
    expect(list[0]).not.toHaveProperty('cost');
    expect(withUsage.cost).toBeGreaterThan(0);
    const all = (await env.send('GET', `/tenants/${tenant}/eval-runs`, 'erik')).body.data as Record<
      string,
      unknown
    >[];
    const raw = (await env.send('GET', `/eval-runs/${id}`, 'erik')).body;
    const rawWithUsage = (await env.send('GET', `/eval-runs/${id}`, 'kari')).body;
    expect(all[0]).not.toHaveProperty('usage');
    expect(raw.run).not.toHaveProperty('usage');
    expect(rawWithUsage.run).toHaveProperty('usage');
  });

  it('compares only completed runs, and finds a run only under its own tenant', async () => {
    const env = await boot();
    const id = await runPublished(env);
    const stored = await env.platform.evalStores.runs.get(id);
    if (!stored) throw new Error('no run');
    await env.platform.evalStores.runs.save({
      ...stored,
      run: { ...stored.run, id: 'pagar', status: 'running' },
    });

    const compared = await env.send(
      'GET',
      `/eval-runs/compare?baseline=${id}&candidate=pagar&metric=refusal`,
    );
    const elsewhere = await env.send('GET', `/tenants/${other}/eval-runs/${id}`, 'ola');

    expect(compared.status).not.toBe(200);
    expect(JSON.stringify(compared.body)).toContain('eval run pagar is running, not completed');
    expect(elsewhere.status).toBe(404);
  });

  it('shows no cost for a run whose model has no price, rather than a cost of nothing', async () => {
    const env = await boot();
    const id = await runPublished(env);

    const run = (await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`, 'kari')).body;

    expect(run.cost).toBeNull();
    expect(run.tokens).toMatchObject({ input: expect.any(Number) });
  });

  it('compares two runs of the same version, since a run names the service it tested, not its one-off draft', async () => {
    const env = await boot();
    const first = await runPublished(env);
    const second = await runPublished(env);

    const stored = await env.platform.evalStores.runs.get(second);
    const compared = await env.send(
      'GET',
      `/eval-runs/compare?baseline=${first}&candidate=${second}&metric=refusal`,
    );

    expect(stored?.run.provenance.services.every((s) => s.startsWith(`${tenant}/svar@`))).toBe(
      true,
    );
    expect(compared.status).toBe(200);
  });

  it("keeps a test run's own eval task out of Kjøringer, as its answers are", async () => {
    const env = await boot();
    await runPublished(env);

    const tasks = (await env.send('GET', `/tenants/${tenant}/tasks`)).body.data as {
      capability?: string;
      service?: { capability?: { id?: string } };
    }[];

    expect(tasks.some((t) => JSON.stringify(t).includes('platform/eval'))).toBe(false);
  });

  it("finds a draft's run under the spec the publish check computes for that draft", async () => {
    const env = await boot();
    const draft = structuredClone(service);
    draft.spec.strategy.config.instructions = better;

    await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      version: 'draft',
      definition: draft,
    });
    await env.settled();
    const validated = validateDefinition(draft, env.platform.plugins);
    if (!validated.ok) throw new Error('the draft is invalid');
    const found = await env.platform.evalStores.runs.list({
      tenant,
      service: 'svar',
      subject: definitionSubject(validated.definition.spec),
    });

    expect(found.map((s) => [s.run.status, s.run.tested?.version])).toEqual([
      ['completed', 'draft'],
    ]);
  });

  it("finds a risk-confirmed draft's run under the spec publish checks, though publish stamps the confirmation", async () => {
    const env = await boot();
    const draft = structuredClone(service) as typeof service & {
      spec: { riskClass?: string; riskConfirmation?: Record<string, unknown> };
    };
    draft.spec.riskClass = 'limited';
    draft.spec.riskConfirmation = { reasons: ['Tjenesten svarer innbyggere'] };

    await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      version: 'draft',
      definition: draft,
    });
    await env.settled();
    const validated = validateDefinition(draft, env.platform.plugins);
    if (!validated.ok) throw new Error('the draft is invalid');
    const published = confirmedAs(validated.definition, 'employee:test:kari', new Date());
    const found = await env.platform.evalStores.runs.list({
      tenant,
      service: 'svar',
      subject: definitionSubject(published.spec),
    });

    expect(found.map((s) => s.run.status)).toEqual(['completed']);
  });

  it('runs a draft without publishing it', async () => {
    const env = await boot();
    const draft = structuredClone(service);
    draft.spec.strategy.config.instructions = better;

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      version: 'draft',
      definition: draft,
    });
    await env.settled();
    const run = await env.send('GET', `/tenants/${tenant}/eval-runs/${String(started.body.id)}`);

    expect(run.body).toMatchObject({ status: 'completed', version: 'draft', passed: 3, total: 3 });
    expect(await env.platform.definitions.versions('Service', tenant, 'svar')).toHaveLength(1);
  });

  it('another tenant cannot read the runs', async () => {
    const env = await boot();
    const id = await runPublished(env);

    expect((await env.send('GET', `/tenants/${tenant}/eval-runs/${id}`, 'ola')).status).toBe(404);
    expect((await env.send('GET', `${services}/eval-runs`, 'ola')).status).toBe(404);
    expect((await env.send('GET', `/tenants/${other}/eval-runs/${id}`, 'ola')).status).toBe(404);
  });
});

/** Langfuse's stable dataset routes: read by name, and created by a POST to the collection. */
const datasetRoutes = (
  datasets: Map<string, string>,
  path: string,
  body: Record<string, unknown>,
) => {
  const url = new URL(path, 'http://langfuse.test');
  const named = /^\/api\/public\/v2\/datasets\/(.+)$/.exec(url.pathname)?.[1];
  if (named) {
    const name = decodeURIComponent(named);
    const id = datasets.get(name);
    return id
      ? { status: 200, json: { id, name } }
      : { status: 404, json: { message: 'Dataset not found', error: 'LangfuseNotFoundError' } };
  }
  if (url.pathname === '/api/public/v2/datasets') {
    const name = String(body.name);
    const id = datasets.get(name) ?? `datasett-${datasets.size + 1}`;
    datasets.set(name, id);
    return { status: 200, json: { id, name } };
  }
  return undefined;
};

const otlpCollector = async () => {
  const spans: { name: string; attributes: { key: string; value: { stringValue?: string } }[] }[] =
    [];
  const datasets = new Map<string, string>();
  const sink = await fakeHttp((body: Record<string, unknown>, _attempt, path) => {
    const dataset = datasetRoutes(datasets, path, body);
    if (dataset) return dataset;
    // A Langfuse project without evaluation rules.
    if (/^\/api\/public\/v2\/(evaluation-rules|evaluators)(\?|$)/.test(path))
      return { status: 200, json: { data: [], meta: {} } };
    const resource = (body.resourceSpans ?? []) as { scopeSpans: { spans: typeof spans }[] }[];
    spans.push(...resource.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
    return { status: 200, json: {} };
  });
  servers.push(sink);
  const attr = (span: (typeof spans)[number], key: string) =>
    span.attributes.find((a) => a.key === key)?.value.stringValue;
  return { url: sink.url, spans, attr, datasets };
};

describe('eval runs sent to a trace connection', () => {
  const connect = async (
    env: Awaited<ReturnType<typeof boot>>,
    host: string,
    residency = 'global',
  ) => {
    const why = { 'change-reason': 'Kobler tjenesten til sporing' };
    await env.send(
      'PUT',
      `/tenants/${tenant}/secrets/sporing`,
      'kari',
      { value: 'sk-lf-lokal', allowedHosts: [host] },
      why,
    );
    const saved = await env.send(
      'PUT',
      `/tenants/${tenant}/tracing/connections/lokal`,
      'kari',
      {
        host,
        publicKey: 'pk-lf-lokal',
        secretKey: `secret://tenant/${tenant}/sporing`,
        services: ['svar'],
        residency,
      },
      why,
    );
    expect(saved.status).toBe(200);
  };

  it('sends a traced run as one experiment to the connection covering the service, never its holdout cases', async () => {
    const collector = await otlpCollector();
    const deliveries = new InMemoryTraceDeliveries();
    const env = await boot(undefined, { devMode: true }, deliveries);
    await connect(env, collector.url);

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await env.settled();
    const stored = await env.platform.evalStores.runs.get(String(started.body.id));
    const sent = stored?.run.results.filter((r) => r.split !== 'holdout').map((r) => r.task) ?? [];
    await deliveries.markPending(tenant, { sink: 'lokal' }, new Date().toISOString());
    const recorded = await deliveries.pending(10);

    expect(started.status).toBe(202);
    expect(stored?.run.tested).toMatchObject({ sink: 'lokal' });
    const roots = collector.spans.filter(
      (s) =>
        collector.attr(s, 'langfuse.experiment.item.root_observation_id') !== undefined &&
        collector.attr(s, 'langfuse.experiment.item.metadata.case') !== undefined,
    );
    expect(
      new Set(collector.spans.map((s) => collector.attr(s, 'langfuse.experiment.id'))),
    ).toEqual(new Set([String(started.body.id)]));
    expect(roots.map((s) => collector.attr(s, 'langfuse.experiment.item.id')).sort()).toEqual([
      'o1#0',
      'o2#0',
    ]);
    expect(recorded.map((d) => d.task).sort()).toEqual([...sent].sort());
    expect(recorded.map((d) => d.trace).sort()).toEqual(sent.map((t) => traceIdFor(t)).sort());
  });

  it('refuses a traced run when no connection covers the service, or its residency forbids the connection', async () => {
    const collector = await otlpCollector();
    const uncovered = await boot(undefined, { devMode: true });
    const covered = await boot(undefined, { devMode: true }, undefined, { localModel: true });
    await connect(covered, collector.url, 'global');
    const norwegian = structuredClone(service);
    norwegian.spec.model = { primary: 'local/echo', residency: 'norway' };

    const none = await uncovered.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    const elsewhere = await covered.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
      version: 'draft',
      definition: norwegian,
    });
    const allowed = await covered.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await covered.settled();

    expect(none.status).toBe(409);
    expect(JSON.stringify(none.body)).toContain('no trace connection covers the service svar');
    expect(elsewhere.status).toBe(409);
    expect(JSON.stringify(elsewhere.body)).toContain(
      "the service's residency norway does not allow the connection's global",
    );
    expect(allowed.status).toBe(202);
  });

  it('records no sink for a traced run of only the locked cases, since none of them is sent', async () => {
    const collector = await otlpCollector();
    const env = await boot(undefined, { devMode: true });
    await connect(env, collector.url, 'global');

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
      split: 'locked',
    });
    await env.settled();
    const stored = await env.platform.evalStores.runs.get(String(started.body.id));

    expect(started.status).toBe(202);
    expect(stored?.run.tested).not.toHaveProperty('sink');
    expect(collector.spans).toEqual([]);
  });

  it('checks the residency the draft runs with, filled from its model when the draft leaves it out', async () => {
    const collector = await otlpCollector();
    const env = await boot(undefined, { devMode: true }, undefined, { localModel: true });
    await connect(env, collector.url, 'global');
    const unstated = structuredClone(service) as { spec: { model: Record<string, unknown> } };
    unstated.spec.model = { primary: 'local/echo' };

    const refused = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
      version: 'draft',
      definition: unstated,
    });

    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(
      "the service's residency norway does not allow the connection's global",
    );
  });

  it('sends a run nowhere when two connections cover its service, rather than picking one', async () => {
    const collector = await otlpCollector();
    const env = await boot(undefined, { devMode: true });
    await connect(env, collector.url, 'global');
    const first = await env.platform.configEntries.latest({
      kind: 'trace-connection',
      scope: tenant,
    });
    const copy = first[0];
    if (!copy) throw new Error('no connection was saved');
    await env.platform.configEntries.append({
      ...copy,
      id: 'kopi',
      version: 1,
      spec: { ...(copy.spec as Record<string, unknown>), id: 'kopi' },
    });

    const refused = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });

    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain(
      'two trace connections cover the service svar: kopi, lokal',
    );
  });
});

const judgeRule = 'svar_oppfyller_kriteriene-eksperimenter';
const numericRule = 'svar_poeng-eksperimenter';
const numericJudge = 'dommer-tall';
/** The evaluators' names: Langfuse 4.72.0 names a judge's scores after its evaluator. */
const judgeScore = 'svar_oppfyller_kriteriene';
const numericScore = 'svar_poeng';

interface FakeRule {
  id: string;
  name: string;
  target: string;
  status: string;
  enabled: boolean;
  mapping: { variable: string; source: string; jsonPath?: string }[];
  evaluator: { id: string; name: string };
}

interface FakeAnnotation {
  id: string;
  name: string;
  source: 'ANNOTATION';
  dataType: string;
  value: boolean | number | string;
  configId: string;
  authorUserId: string;
  queueId: string | null;
  updatedAt: string;
  subject: { kind: string; id: string; traceId?: string };
}

interface FakeScoreConfig {
  id: string;
  name: string;
  dataType: string;
  minValue?: number;
  maxValue?: number;
}

const experimentRule = (over: Partial<FakeRule> = {}): FakeRule => ({
  id: 'regel-1',
  name: judgeRule,
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

/**
 * A Langfuse 4.72.0 project whose active experiment rules judge each item as its root span arrives,
 * as Langfuse does a few seconds after a trace comes in. A rule here is written as 4.4.0 had it; the
 * v2 API answers it as the upgrade turns it: an experiment rule is an observation rule with the
 * item-root filter, and its evaluator writes scores under its own name.
 */
const fakeLangfuse = async (rules: FakeRule[] = [experimentRule()]) => {
  const spans: {
    traceId: string;
    spanId: string;
    attributes: { key: string; value: { stringValue?: string } }[];
  }[] = [];
  const scores = new Map<string, Record<string, unknown>[]>();
  const attr = (span: (typeof spans)[number], key: string) =>
    span.attributes.find((a) => a.key === key)?.value.stringValue;
  // Runs once as the first item arrives, as when someone switches a rule on during a run.
  const hooks: {
    firstItem?: () => void;
    annotationsDown?: boolean;
    /** The evaluators paused in Langfuse, with its message. */
    paused?: Record<string, string>;
    /** The HTTP status the v2 evaluation routes answer with instead. */
    evaluationDown?: number;
    datasetsDown?: boolean;
  } = {};
  const datasets = new Map<string, string>();
  const judging = () =>
    rules.filter(
      (r) => r.target === 'experiment' && r.status === 'active' && !hooks.paused?.[r.evaluator.id],
    );
  const v2Rule = (r: FakeRule) => ({
    id: r.id,
    name: r.name,
    enabled: r.enabled && r.status === 'active',
    sampling: 1,
    filter:
      r.target === 'experiment'
        ? [{ type: 'boolean', column: 'isExperimentItemRootSpan', operator: '=', value: true }]
        : [],
    evaluatorAssignments: [{ evaluatorId: r.evaluator.id, variableMapping: r.mapping }],
  });
  const v2Evaluator = (id: string) => ({
    id,
    name: rules.find((r) => r.evaluator.id === id)?.evaluator.name ?? 'svar_oppfyller_kriteriene',
    version: 1,
    type: 'llm_as_judge',
    status: hooks.paused?.[id] ? 'paused' : 'active',
    pausedMessage: hooks.paused?.[id] ?? null,
    variableMapping: [],
    outputDefinition: { dataType: id === numericJudge ? 'NUMERIC' : 'BOOLEAN' },
    modelConfig: { provider: 'foundry-claude', model: 'claude-sonnet-5' },
  });
  const annotations: FakeAnnotation[] = [];
  const configs: FakeScoreConfig[] = [
    { id: 'oppsett-1', name: judgeScore, dataType: 'BOOLEAN' },
    { id: 'oppsett-2', name: judgeScore, dataType: 'NUMERIC', minValue: 0, maxValue: 4 },
    { id: 'oppsett-3', name: 'hjelpsomhet', dataType: 'BOOLEAN' },
    { id: 'oppsett-4', name: numericScore, dataType: 'NUMERIC', minValue: 0, maxValue: 4 },
    { id: 'oppsett-5', name: numericScore, dataType: 'NUMERIC' },
    // Named after the rule, as 4.4.0 named its scores.
    { id: 'oppsett-6', name: judgeRule, dataType: 'BOOLEAN' },
  ];
  /** A person's annotation on a case's trace, as Langfuse's UI writes it with a score config. */
  const annotate = (
    trace: string,
    over: Partial<FakeAnnotation> & { value: boolean | number | string },
  ) => {
    const config = configs.find((c) => c.id === (over.configId ?? 'oppsett-1'));
    const annotation: FakeAnnotation = {
      id: `merknad-${annotations.length + 1}`,
      name: config?.name ?? judgeScore,
      source: 'ANNOTATION',
      dataType: config?.dataType ?? 'BOOLEAN',
      configId: 'oppsett-1',
      authorUserId: 'lf-bruker-1',
      queueId: null,
      updatedAt: '2026-11-02T10:00:00.000Z',
      subject: { kind: 'trace', id: trace },
      ...over,
    };
    annotations.push(annotation);
    return annotation;
  };
  let seen = false;
  const server = await fakeHttp((body, _attempt, path) => {
    const url = new URL(path, 'http://langfuse.test');
    const ok = (json: unknown) => ({ status: 200, json });
    if (url.pathname === '/api/public/otel/v1/traces') {
      const resource = (body.resourceSpans ?? []) as { scopeSpans: { spans: typeof spans }[] }[];
      const got = resource.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
      spans.push(...got);
      for (const span of got) {
        if (attr(span, 'langfuse.experiment.item.root_observation_id') !== span.spanId) continue;
        if (!seen) hooks.firstItem?.();
        seen = true;
        for (const r of judging())
          scores.set(span.traceId, [
            ...(scores.get(span.traceId) ?? []),
            {
              id: `${r.id}-${span.traceId}`,
              name: r.evaluator.name,
              // A numeric judge's score has no config, so it comes without a range.
              ...(r.evaluator.id === numericJudge
                ? { value: 3, dataType: 'NUMERIC' }
                : { value: true, dataType: 'BOOLEAN' }),
              source: 'EVAL',
              comment: 'Svaret oppgir fristen.',
              metadata: {
                job_configuration_id: r.id,
                job_execution_id: `jobb-${r.id}-${span.traceId}`,
              },
            },
          ]);
      }
      return ok({});
    }
    if (url.pathname.startsWith('/api/public/v2/datasets') && hooks.datasetsDown)
      return { status: 503, json: {} };
    const dataset = datasetRoutes(datasets, path, body);
    if (dataset) return dataset;
    if (
      /^\/api\/public\/v2\/(evaluation-rules|evaluators)/.test(url.pathname) &&
      hooks.evaluationDown
    )
      return { status: hooks.evaluationDown, json: {} };
    if (url.pathname === '/api/public/v2/evaluation-rules')
      return ok({ data: rules.map(v2Rule), meta: {} });
    if (url.pathname === '/api/public/v2/evaluators')
      return ok({
        data: [...new Set(rules.map((r) => r.evaluator.id))].map(v2Evaluator),
        meta: {},
      });
    const ruleId = /v2\/evaluation-rules\/(.+)$/.exec(url.pathname)?.[1];
    if (ruleId) {
      const found = rules.find((r) => r.id === decodeURIComponent(ruleId));
      return found ? ok(v2Rule(found)) : { status: 404, json: {} };
    }
    const evaluatorId = /v2\/evaluators\/(.+)$/.exec(url.pathname)?.[1];
    if (evaluatorId) return ok(v2Evaluator(decodeURIComponent(evaluatorId)));
    // What people annotate in Langfuse's UI, apart from what the judges score.
    if (url.pathname === '/api/public/v3/scores' && url.searchParams.get('source') === 'ANNOTATION')
      return hooks.annotationsDown
        ? { status: 404, json: {} }
        : ok({ data: annotations, meta: {} });
    if (url.pathname === '/api/public/v3/scores')
      return ok({ data: scores.get(url.searchParams.get('traceId') ?? '') ?? [], meta: {} });
    const configId = /score-configs\/(.+)$/.exec(url.pathname)?.[1];
    if (configId) {
      const found = configs.find((c) => c.id === decodeURIComponent(configId));
      return found ? ok(found) : { status: 404, json: {} };
    }
    // Each judge execution's trace has one call, priced by Langfuse.
    if (url.pathname === '/api/public/v2/observations')
      return ok({
        data: [
          {
            type: 'GENERATION',
            inputUsage: 4321,
            outputUsage: 987,
            costDetails: { input: 0.0087, output: 0.0036, total: 0.0123 },
          },
        ],
        meta: {},
      });
    if (url.pathname === '/api/public/projects')
      return ok({ data: [{ id: 'genki-test', name: 'genki test' }] });
    return { status: 404, json: {} };
  });
  servers.push(server);
  const traceOf = (caseId: string) =>
    spans.find(
      (s) =>
        attr(s, 'langfuse.experiment.item.metadata.case') === caseId &&
        attr(s, 'langfuse.experiment.item.root_observation_id') === s.spanId,
    )?.traceId ?? '';
  return {
    url: server.url,
    spans,
    attr,
    hooks,
    annotations,
    annotate,
    traceOf,
    datasets,
    /** The paths genki asked for, in order. */
    paths: () => server.seen.map((r) => new URL(r.path, 'http://langfuse.test').pathname),
    close: () => server.close(),
  };
};

describe('Langfuse datasets of test sets', () => {
  const why = { 'change-reason': 'Kobler tjenesten til Langfuse-datasett' };
  const connected = async (named: Record<string, string> = {}, down = false) => {
    const langfuse = await fakeLangfuse([]);
    for (const [name, id] of Object.entries(named)) langfuse.datasets.set(name, id);
    langfuse.hooks.datasetsDown = down;
    const logged: { msg: string; fields: Record<string, unknown> }[] = [];
    const env = await boot(undefined, { devMode: true }, undefined, {
      evalWait: { everyMs: 50, deadlineMs: 20_000 },
      localModel: true,
      logger: (msg, fields) => logged.push({ msg, fields }),
    });
    await env.send(
      'PUT',
      `/tenants/${tenant}/secrets/sporing`,
      'kari',
      { value: 'sk-lf-lokal', allowedHosts: [langfuse.url] },
      why,
    );
    const save = (more: Record<string, unknown> = {}) =>
      env.send(
        'PUT',
        `/tenants/${tenant}/tracing/connections/lokal`,
        'kari',
        {
          host: langfuse.url,
          publicKey: 'pk-lf-lokal',
          secretKey: `secret://tenant/${tenant}/sporing`,
          services: ['svar'],
          ...more,
        },
        why,
      );
    const saved = await save();
    /** How often genki looked a dataset up in Langfuse by its name. */
    const lookups = () =>
      langfuse.paths().filter((p) => p.startsWith('/api/public/v2/datasets/')).length;
    const datasetsOf = async () =>
      (
        (await env.send('GET', `/tenants/${tenant}/tracing/connections`)).body.data as {
          datasets: unknown[];
        }[]
      )[0]?.datasets;
    const testSets = async () =>
      (await env.send('GET', `${services}/test-sets`)).body.data as {
        id: string;
        dataset?: unknown;
      }[];
    const run = async () => {
      const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
        testSet: 'svar-frister',
        trace: true,
      });
      await env.settled();
      return started;
    };
    return { env, langfuse, saved, save, lookups, logged, datasetsOf, testSets, run };
  };

  it('gives each test set of the services a saved connection covers a dataset named genki/<service>/<test set>, kept with the test set and the connection', async () => {
    const { langfuse, saved, datasetsOf, testSets } = await connected();

    expect(saved.status).toBe(200);
    expect([...langfuse.datasets]).toEqual([['genki/svar/svar-frister', 'datasett-1']]);
    expect(await datasetsOf()).toEqual([
      {
        service: 'svar',
        testSet: 'svar-frister',
        name: 'genki/svar/svar-frister',
        id: 'datasett-1',
      },
    ]);
    expect(await testSets()).toEqual([
      expect.objectContaining({
        id: 'svar-frister',
        dataset: { connection: 'lokal', name: 'genki/svar/svar-frister' },
      }),
    ]);
  });

  it('reuses a dataset that already has the name, and never writes to it', async () => {
    const { langfuse, datasetsOf } = await connected({ 'genki/svar/svar-frister': 'etatens' });

    expect(await datasetsOf()).toEqual([expect.objectContaining({ id: 'etatens' })]);
    expect(langfuse.paths()).toContain('/api/public/v2/datasets/genki%2Fsvar%2Fsvar-frister');
    expect(langfuse.paths()).not.toContain('/api/public/v2/datasets');
  });

  it('gives a test set added later to a covered service a dataset', async () => {
    const { env, langfuse, datasetsOf } = await connected();

    const created = await env.send(
      'POST',
      `/tenants/${tenant}/test-sets`,
      'kari',
      { id: 'svar-nye', name: 'Nye spørsmål', service: 'svar' },
      why,
    );

    expect(created.status).toBeLessThan(300);
    expect(langfuse.datasets.get('genki/svar/svar-nye')).toBeDefined();
    expect(await datasetsOf()).toEqual([
      expect.objectContaining({ testSet: 'svar-frister' }),
      expect.objectContaining({ testSet: 'svar-nye', name: 'genki/svar/svar-nye' }),
    ]);
  });

  it("saves the connection when Langfuse can't make its datasets, and makes them at the next run", async () => {
    const { langfuse, saved, datasetsOf, run } = await connected({}, true);

    expect(saved.status).toBe(200);
    expect(await datasetsOf()).toEqual([]);
    langfuse.hooks.datasetsDown = false;
    expect((await run()).status).toBe(202);
    expect(await datasetsOf()).toEqual([expect.objectContaining({ testSet: 'svar-frister' })]);
  });

  it("marks every span of a sent run with its test set's dataset and the environment genki-test-runs", async () => {
    const { langfuse, run } = await connected();

    expect((await run()).status).toBe(202);
    expect(langfuse.spans.length).toBeGreaterThan(0);
    for (const span of langfuse.spans) {
      expect(langfuse.attr(span, 'langfuse.experiment.dataset.id')).toBe('datasett-1');
      expect(langfuse.attr(span, 'deployment.environment.name')).toBe('genki-test-runs');
    }
  });

  it('makes the dataset again at the next run when it was deleted in Langfuse, and keeps the new id', async () => {
    const { langfuse, run, datasetsOf } = await connected();
    langfuse.datasets.delete('genki/svar/svar-frister');

    expect((await run()).status).toBe(202);
    const made = langfuse.datasets.get('genki/svar/svar-frister');
    expect(made).toBeDefined();
    expect(await datasetsOf()).toEqual([expect.objectContaining({ id: made })]);
    expect(
      new Set(langfuse.spans.map((s) => langfuse.attr(s, 'langfuse.experiment.dataset.id'))),
    ).toEqual(new Set([made]));
  });

  it("refuses a sent run when its test set's dataset can be neither found nor made, in the person's language", async () => {
    const { langfuse, run } = await connected();
    langfuse.hooks.datasetsDown = true;

    const refused = await run();
    const message = String(
      (refused.body.errors as { message?: string }[] | undefined)?.[0]?.message ?? '',
    );

    expect(refused.status).toBe(409);
    expect(message).toContain(
      'the dataset of the test set svar-frister could not be found or made in the project of the connection lokal',
    );
    // The portal asks in bokmål, and the API answers in it (localeMiddleware).
    expect(translateMessage(message, 'nb')).toContain(
      'datasettet til testsettet svar-frister kunne verken finnes eller lages i prosjektet til koblingen lokal',
    );
    expect(langfuse.spans).toEqual([]);
  });

  it('asks Langfuse nothing about a run refused before it starts, such as for its residency', async () => {
    const { env, langfuse, lookups } = await connected();
    langfuse.datasets.clear();
    const before = lookups();
    const norwegian = structuredClone(service);
    norwegian.spec.model = { primary: 'local/echo', residency: 'norway' };

    const refused = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
      version: 'draft',
      definition: norwegian,
    });

    expect(refused.status).toBe(409);
    expect(JSON.stringify(refused.body)).toContain('norway');
    expect(lookups()).toBe(before);
    expect(langfuse.datasets.size).toBe(0);
  });

  it('lists only the datasets of the test sets in the services the connection covers now', async () => {
    const { env, save, datasetsOf, testSets } = await connected();
    const set = await env.platform.evalStores.testSets.get(tenant, 'svar-frister');
    if (!set) throw new Error('no test set svar-frister');

    await env.platform.evalStores.testSets.put({
      ...set,
      metadata: { ...set.metadata, version: set.metadata.version + 1 },
      spec: { ...set.spec, service: 'annen' },
    });
    expect(await datasetsOf()).toEqual([]);
    expect(await testSets()).toEqual([]);
    await env.platform.evalStores.testSets.put({
      ...set,
      metadata: { ...set.metadata, version: set.metadata.version + 2 },
    });
    expect(await datasetsOf()).toHaveLength(1);
    expect((await save({ services: [] })).status).toBe(200);
    expect(await datasetsOf()).toEqual([]);
  });

  it('makes the datasets again in the project a connection is moved to', async () => {
    const { save, lookups, datasetsOf } = await connected();
    const before = lookups();

    expect((await save({ publicKey: 'pk-lf-annet-prosjekt' })).status).toBe(200);

    expect(lookups()).toBe(before + 1);
    expect(await datasetsOf()).toHaveLength(1);
  });

  it('asks Langfuse nothing when a connection is saved again and its datasets are recorded', async () => {
    const { save, lookups } = await connected();
    const before = lookups();

    expect((await save({ labels: true })).status).toBe(200);

    expect(lookups()).toBe(before);
  });

  it('logs each dataset Langfuse could not make, on a connection save and on a test set save', async () => {
    const { env, logged } = await connected({}, true);

    await env.send(
      'POST',
      `/tenants/${tenant}/test-sets`,
      'kari',
      { id: 'svar-nye', name: 'Nye spørsmål', service: 'svar' },
      why,
    );

    expect(
      logged
        .filter((l) => l.msg === 'langfuse dataset not made')
        .map((l) => [l.fields.connection, l.fields.testSet]),
    ).toEqual([
      ['lokal', 'svar-frister'],
      ['lokal', 'svar-nye'],
    ]);
  });

  it("saves a test set when Langfuse can't make its dataset", async () => {
    const { env, langfuse, datasetsOf } = await connected();
    langfuse.hooks.datasetsDown = true;

    const created = await env.send(
      'POST',
      `/tenants/${tenant}/test-sets`,
      'kari',
      { id: 'svar-nye', name: 'Nye spørsmål', service: 'svar' },
      why,
    );

    expect(created.status).toBeLessThan(300);
    expect(await env.platform.evalStores.testSets.get(tenant, 'svar-nye')).toBeDefined();
    expect(await datasetsOf()).toEqual([expect.objectContaining({ testSet: 'svar-frister' })]);
  });
});

describe('Langfuse judges on a run', () => {
  const why = { 'change-reason': 'Kobler tjenesten til Langfuse-dommerne' };
  const judged = async (rules?: FakeRule[], residency = 'global', content = true) => {
    const langfuse = await fakeLangfuse(rules);
    const env = await boot(undefined, { devMode: true }, undefined, {
      evalWait: { everyMs: 50, deadlineMs: 20_000 },
      localModel: true,
    });
    await env.send(
      'PUT',
      `/tenants/${tenant}/secrets/sporing`,
      'kari',
      { value: 'sk-lf-lokal', allowedHosts: [langfuse.url] },
      why,
    );
    const saveConnection = (receives: boolean, more: Record<string, unknown> = {}) =>
      env.send(
        'PUT',
        `/tenants/${tenant}/tracing/connections/lokal`,
        'kari',
        {
          host: langfuse.url,
          publicKey: 'pk-lf-lokal',
          secretKey: `secret://tenant/${tenant}/sporing`,
          services: ['svar'],
          residency,
          content: receives,
          erasureDeclared: true,
          ...more,
        },
        why,
      );
    const saved = await saveConnection(content);
    expect(saved.status).toBe(200);
    const adopt = (name: string) =>
      env.send(
        'POST',
        `/tenants/${tenant}/building-blocks/judge/${encodeURIComponent(`langfuse:lokal/${name}`)}/adopt`,
        'kari',
        undefined,
        why,
      );
    return { env, langfuse, adopt, saveConnection };
  };

  it("scores a run's cases with a Langfuse judge under the identity langfuse:<tenant>/<connection>/<name>@v<version>+<model>", async () => {
    const { env, langfuse, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await env.settled();
    const stored = await env.platform.evalStores.runs.get(String(started.body.id));
    const scoreOf = (id: string) =>
      stored?.run.results
        .find((r) => r.case === id)
        ?.scores.find((s) => s.evaluator === `langfuse:lokal/${judgeRule}`);
    const rootOf = (id: string) =>
      langfuse.spans.find((s) => langfuse.attr(s, 'langfuse.experiment.item.metadata.case') === id);

    expect(started.status).toBe(202);
    expect(stored?.run.status).toBe('completed');
    expect(stored?.run.provenance.judges).toContain(
      `langfuse:${tenant}/lokal/${judgeRule}@v1+foundry-claude/claude-sonnet-5`,
    );
    expect(stored?.run.tested).toMatchObject({ sink: 'lokal' });
    expect(scoreOf('o1')).toMatchObject({ state: 'scored', value: 1 });
    expect(scoreOf('o2')).toMatchObject({
      state: 'not-applicable',
      reason: 'the case has no expected_output $.criteria',
    });
    expect(scoreOf('l1')).toMatchObject({
      state: 'not-applicable',
      reason: 'holdout cases are never sent',
    });
    // Advisory: the judge's scores are not among the run's own metrics.
    expect(stored?.run.metrics).not.toHaveProperty(`langfuse:lokal/${judgeRule}`);
    // Only the fields the judge maps go out: the question, the answer and the case's criteria.
    const o1 = rootOf('o1');
    if (!o1) throw new Error('case o1 was not sent');
    expect(langfuse.attr(o1, 'langfuse.observation.input')).toContain('Når er fristen for søknad?');
    expect(langfuse.attr(o1, 'langfuse.observation.output')).toContain('Vi svarer snart.');
    expect(
      JSON.parse(langfuse.attr(o1, 'langfuse.experiment.item.expected_output') ?? '{}'),
    ).toEqual({ criteria: 'Svaret oppgir fristen' });
    expect(rootOf('l1')).toBeUndefined();
    // The portal reads the judge apart from genki's metrics, and its reason from the case's task.
    const detail = await env.send('GET', `/tenants/${tenant}/eval-runs/${String(started.body.id)}`);
    expect(detail.body).toMatchObject({
      experiment: `${langfuse.url}/project/genki-test/experiments/results?baseline=${String(started.body.id)}`,
      sinkJudges: [
        {
          id: `langfuse:lokal/${judgeRule}`,
          name: judgeRule,
          version: 'v1+foundry-claude/claude-sonnet-5',
          dataType: 'BOOLEAN',
          metric: { mean: 1, n: 1 },
          notApplicable: 2,
          missing: 0,
          changed: [],
        },
      ],
    });
    expect(
      (detail.body.cases as { caseId: string; judges?: unknown }[]).find((c) => c.caseId === 'o1')
        ?.judges,
    ).toEqual([
      {
        judge: `langfuse:lokal/${judgeRule}`,
        state: 'scored',
        value: 1,
        dataType: 'BOOLEAN',
        reason: 'Svaret oppgir fristen.',
      },
    ]);
  });

  it("lists each experiment rule of a connection's project as a judge building block, and scores a run only with the ones the agency added", async () => {
    const short = 'svar_er_kort-eksperimenter';
    const notAdded = experimentRule({ id: 'regel-2', name: short });
    const traceRule = experimentRule({ id: 'regel-3', name: 'svar-sporinger', target: 'trace' });
    const { env, adopt, langfuse } = await judged([
      experimentRule(),
      notAdded,
      traceRule,
      experimentRule({ id: 'regel-4', name: 'pause-eksperimenter', status: 'inactive' }),
    ]);

    const listed = await env.send('GET', `/tenants/${tenant}/building-blocks?kind=judge`);
    const blocks = (listed.body.data as { id: string }[]).filter((b) =>
      b.id.startsWith('langfuse:'),
    );
    expect((await adopt(judgeRule)).status).toBe(200);
    // Langfuse would run the judge not added and the trace rule as well, so both are switched off.
    notAdded.status = 'inactive';
    traceRule.status = 'inactive';
    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await env.settled();
    const stored = await env.platform.evalStores.runs.get(String(started.body.id));

    expect(blocks.map((b) => b.id).sort()).toEqual([
      `langfuse:lokal/${short}`,
      `langfuse:lokal/${judgeRule}`,
    ]);
    expect(blocks.find((b) => b.id === `langfuse:lokal/${judgeRule}`)).toMatchObject({
      kind: 'judge',
      name: judgeRule,
      status: 'available',
      publisher: { type: 'own', name: 'Langfuse (lokal)' },
      capabilities: [
        'Vurderer testkjøringer som sendes til koblingen lokal. Rådgivende: stopper aldri en publisering.',
      ],
      permissions: [
        { type: 'network', value: langfuse.url, note: 'Hit sendes testkjøringene' },
        { type: 'data', value: 'spørsmålet, svaret, kriteriene', note: '' },
        {
          type: 'model',
          value: 'foundry-claude/claude-sonnet-5',
          note: 'Kjøres av Langfuse, ikke av plattformen',
        },
      ],
      judge: {
        model: 'foundry-claude/claude-sonnet-5',
        version: '1',
        dataType: 'BOOLEAN',
        fields: [
          { variable: 'input', source: 'input' },
          { variable: 'output', source: 'output' },
          { variable: 'criteria', source: 'expected_output', jsonPath: '$.criteria' },
        ],
      },
    });
    expect(stored?.run.provenance.judges.filter((j) => j.startsWith('langfuse:'))).toEqual([
      `langfuse:${tenant}/lokal/${judgeRule}@v1+foundry-claude/claude-sonnet-5`,
    ]);
    expect(
      new Set(
        stored?.run.results.flatMap((r) =>
          r.scores.filter((s) => s.evaluator.startsWith('langfuse:')).map((s) => s.evaluator),
        ),
      ),
    ).toEqual(new Set([`langfuse:lokal/${judgeRule}`]));
  });

  it("says before a run starts that the service's residency forbids sending to a Langfuse judge's connection, and does not start it", async () => {
    const { env, adopt } = await judged(undefined, 'global');
    expect((await adopt(judgeRule)).status).toBe(200);
    const norwegian = structuredClone(service);
    norwegian.spec.model = { primary: 'local/echo', residency: 'norway' };
    const savedDraft = await env.send('PUT', `${services}/draft`, 'kari', {
      definition: norwegian,
    });
    expect(savedDraft.status).toBe(200);

    const published = await env.send('GET', `${services}/eval-runs/sending`);
    const draft = await env.send('GET', `${services}/eval-runs/sending?version=draft`);
    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
      version: 'draft',
    });

    expect(published.body).toEqual({
      connection: { id: 'lokal', residency: 'global' },
      judges: [{ id: `langfuse:lokal/${judgeRule}`, name: judgeRule }],
    });
    expect(draft.body).toMatchObject({
      judges: [{ name: judgeRule }],
      refused: { reason: 'residency', service: 'norway', connection: 'global' },
    });
    expect(started.status).toBe(409);
    expect(JSON.stringify(started.body)).toContain(
      "the service's residency norway does not allow the connection's global",
    );
  });

  it('refuses a run whose adopted Langfuse judge is refused or gone when it starts, and never adopts a refused one', async () => {
    const rules = [
      experimentRule(),
      experimentRule({ id: 'regel-2', name: 'verktøy-eksperimenter' }),
    ];
    const toolCalls = { variable: 'verktøy', source: 'tool_calls' };
    rules[1]?.mapping.push(toolCalls);
    const { env, adopt } = await judged(rules);
    const start = () =>
      env.send('POST', `${services}/eval-runs`, 'kari', { testSet: 'svar-frister', trace: true });

    const refusedBlock = await adopt('verktøy-eksperimenter');
    expect((await adopt(judgeRule)).status).toBe(200);
    rules[0]?.mapping.push(toolCalls);
    const nowRefused = await start();
    rules.splice(0, 1);
    const gone = await start();

    expect(refusedBlock.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refusedBlock.body)).toContain(
      'verktøy-eksperimenter reads tool_calls, which genki does not send',
    );
    expect(nowRefused.status).toBe(409);
    expect(JSON.stringify(nowRefused.body)).toContain(
      `${judgeRule} reads tool_calls, which genki does not send`,
    );
    expect(gone.status).toBe(409);
    expect(JSON.stringify(gone.body)).toContain(
      `the judge langfuse:lokal/${judgeRule} is no longer an active experiment judge in the project of the connection lokal`,
    );
  });

  it("refuses a run with a reason when the connection's Langfuse cannot be read as it starts", async () => {
    const { env, langfuse, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);
    await langfuse.close();

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });

    expect(started.status).toBe(409);
    expect(JSON.stringify(started.body)).toContain(
      'the judges of the connection lokal could not be read',
    );
  });

  it('shows a connection whose Langfuse judges cannot be read as one refused judge block, which cannot be taken in use', async () => {
    const { env, langfuse } = await judged();
    // Langfuse 4.4.0 has no v2 evaluation API.
    langfuse.hooks.evaluationDown = 404;

    const listed = await env.send('GET', `/tenants/${tenant}/building-blocks?kind=judge`);
    const sinkBlocks = (listed.body.data as { id: string; judge?: unknown }[]).filter(
      (b) => b.judge,
    );
    const adopted = await env.send(
      'POST',
      `/tenants/${tenant}/building-blocks/judge/${encodeURIComponent('sink-judges:lokal')}/adopt`,
      'kari',
      undefined,
      why,
    );

    expect(sinkBlocks).toEqual([
      expect.objectContaining({
        id: 'sink-judges:lokal',
        kind: 'judge',
        status: 'not_allowed',
        publisher: { type: 'own', name: 'Langfuse (lokal)' },
        judge: expect.objectContaining({
          connection: 'lokal',
          refused: expect.objectContaining({ reason: 'unreadable', connection: 'lokal' }),
        }),
      }),
    ]);
    expect(JSON.stringify(sinkBlocks)).toContain('HTTP 404');
    // It is no judge: it judges nothing, reads no field and runs on no model.
    expect(sinkBlocks[0]).toMatchObject({
      capabilities: [],
      permissions: [{ type: 'network', value: langfuse.url, note: 'Hit sendes testkjøringene' }],
    });
    expect(adopted.status).toBeGreaterThanOrEqual(400);
  });

  it("says before a run starts that a connection's Langfuse judges cannot be read, and refuses the run saying so", async () => {
    const { env, langfuse, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);
    langfuse.hooks.evaluationDown = 401;

    const sending = await env.send('GET', `${services}/eval-runs/sending`);
    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });

    expect(sending.body).toMatchObject({
      refused: { reason: 'judges-unreadable', connection: 'lokal' },
    });
    expect(JSON.stringify(sending.body)).toContain('HTTP 401');
    expect(started.status).toBe(409);
    expect(JSON.stringify(started.body)).toContain(
      'the judges of the connection lokal could not be read',
    );
  });

  it("refuses a sent run whose judge in use has a paused evaluator, with Langfuse's message", async () => {
    const { env, langfuse, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);
    const message =
      'Evaluator paused: no default evaluation model is configured. Set a default evaluation model or update the evaluator template, then reactivate it.';
    langfuse.hooks.paused = { 'dommer-1': message };

    const listed = await env.send('GET', `/tenants/${tenant}/building-blocks?kind=judge`);
    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });

    // Langfuse does not run it, so Byggeklosser does not list it.
    expect((listed.body.data as { id: string }[]).map((b) => b.id)).not.toContain(
      `langfuse:lokal/${judgeRule}`,
    );
    expect(started.status).toBe(409);
    expect(JSON.stringify(started.body)).toContain(message);
  });

  it('sends a run beside a judge whose evaluator is paused and not taken in use, and counts no cost for it', async () => {
    const { env, langfuse, adopt } = await judged([
      experimentRule(),
      experimentRule({
        id: 'regel-pause',
        name: 'pausert-eksperimenter',
        evaluator: { id: 'dommer-pause', name: 'pausert' },
      }),
    ]);
    expect((await adopt(judgeRule)).status).toBe(200);
    langfuse.hooks.paused = { 'dommer-pause': 'Evaluator paused.' };

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await env.settled();
    const stored = await env.platform.evalStores.runs.get(String(started.body.id));

    expect(started.status).toBe(202);
    // Langfuse does not run it, so nothing of it is waited for or counted as unread.
    expect(Object.keys(stored?.run.usage?.reported ?? {})).toEqual([`langfuse:lokal/${judgeRule}`]);
  });

  it('refuses a Langfuse judge on a connection that gets no answer text, when it is taken in use and when a run starts', async () => {
    const { env, adopt, saveConnection } = await judged(undefined, 'global', false);
    const nothing = `${judgeRule} has nothing to judge: the connection lokal gets no answer text`;

    const listed = await env.send('GET', `/tenants/${tenant}/building-blocks?kind=judge`);
    const refusedAdopt = await adopt(judgeRule);
    expect((await saveConnection(true)).status).toBe(200);
    expect((await adopt(judgeRule)).status).toBe(200);
    expect((await saveConnection(false)).status).toBe(200);
    const sending = await env.send('GET', `${services}/eval-runs/sending`);
    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });

    expect(
      (listed.body.data as { id: string }[]).find((b) => b.id === `langfuse:lokal/${judgeRule}`),
    ).toMatchObject({
      status: 'not_allowed',
      judge: { refused: { reason: 'no-content', connection: 'lokal' } },
    });
    expect(refusedAdopt.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(refusedAdopt.body)).toContain(nothing);
    expect(sending.body).toMatchObject({ refused: { reason: 'no-content', connection: 'lokal' } });
    expect(started.status).toBe(409);
    expect(JSON.stringify(started.body)).toContain(nothing);
  });

  it("stores each Langfuse judge's tokens and reported cost on the run, outside the quota", async () => {
    const { env, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);
    await saveUsdNok(env.platform.configEntries, { rate: 9.2826, date: '2026-10-29' }, new Date());

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await env.settled();
    const stored = await env.platform.evalStores.runs.get(String(started.body.id));
    const listed = await env.send('GET', `${services}/eval-runs`);
    const usage = await env.send('GET', `/tenants/${tenant}/usage?days=1`);
    const unseen = await env.send(
      'GET',
      `/tenants/${tenant}/eval-runs/${String(started.body.id)}`,
      'erik',
    );

    // One case is scored, so one judge call; holdout and cases without criteria cost nothing here.
    expect(stored?.run.usage?.reported).toEqual({
      [`langfuse:lokal/${judgeRule}`]: {
        inputTokens: 4321,
        outputTokens: 987,
        costUsd: 0.0123,
        unpriced: 0,
        unread: 0,
      },
    });
    const summary = (listed.body.data as { id: string; tokens: { input: number } }[]).find(
      (r) => r.id === started.body.id,
    );
    expect(summary?.tokens.input).toBe(
      (stored?.run.usage?.answers.inputTokens ?? 0) + (stored?.run.usage?.judges?.inputTokens ?? 0),
    );
    expect(usage.status).toBe(200);
    expect(JSON.stringify(usage.body)).not.toContain('4321');
    // The run keeps the rate it shows the cost with, and only those who see usage see either.
    expect(stored?.run.usage?.usdNok).toEqual({ rate: 9.2826, date: '2026-10-29' });
    expect(
      (
        listed.body.data as { id: string; usdNok?: unknown; sinkJudges: { reported?: unknown }[] }[]
      ).find((r) => r.id === started.body.id),
    ).toMatchObject({
      usdNok: { rate: 9.2826, date: '2026-10-29' },
      sinkJudges: [{ reported: { inputTokens: 4321, costUsd: 0.0123 } }],
    });
    expect(unseen.status).toBe(200);
    expect(JSON.stringify(unseen.body)).not.toContain('4321');
    expect(JSON.stringify(unseen.body)).not.toContain('9.2826');
  });

  it("leaves a case out of what is sent when none of the run's Langfuse judges can read it, as holdout cases are", async () => {
    const { env, langfuse, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await env.settled();
    const stored = await env.platform.evalStores.runs.get(String(started.body.id));
    const sent = new Set(
      langfuse.spans.map((s) => langfuse.attr(s, 'langfuse.experiment.item.metadata.case')),
    );
    const scoreOf = (id: string) =>
      stored?.run.results
        .find((r) => r.case === id)
        ?.scores.find((s) => s.evaluator === `langfuse:lokal/${judgeRule}`);

    // o2 must refuse and names no criteria, so Langfuse would bill a call genki cannot count.
    expect(sent.has('o1')).toBe(true);
    expect(sent.has('o2')).toBe(false);
    expect(sent.has('l1')).toBe(false);
    expect(scoreOf('o2')).toMatchObject({ state: 'not-applicable' });
    expect(stored?.run.status).toBe('completed');
  });

  it("sends a criteria case's reference answer as its criteria when it names none, as genki's criteria judge reads it", async () => {
    const { env, langfuse, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);
    // A golden set: a case with no type and only a reference answer is a criteria case.
    await env.platform.evalStores.testSets.put(
      parseTestSet({
        apiVersion: 'genai/v1',
        kind: 'TestSet',
        metadata: { tenant, id: 'svar-gull', name: 'Gull', version: 1 },
        spec: {
          service: 'svar',
          cases: [
            {
              id: 'g1',
              split: 'validation',
              input: 'Når er fristen for klage?',
              expected: { referenceAnswer: 'Klagefristen er tre uker.' },
            },
          ],
        },
      }),
    );

    await env.send('POST', `${services}/eval-runs`, 'kari', { testSet: 'svar-gull', trace: true });
    await env.settled();
    const root = langfuse.spans.find(
      (s) => langfuse.attr(s, 'langfuse.experiment.item.metadata.case') === 'g1',
    );

    expect(
      JSON.parse((root && langfuse.attr(root, 'langfuse.experiment.item.expected_output')) ?? '{}'),
    ).toEqual({ criteria: 'Klagefristen er tre uker.' });
  });

  it('sends a run to Langfuse only when it asks for it, also when the service uses a Langfuse judge, and names the judges that did not score it', async () => {
    const { env, langfuse, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);
    const start = (body: Record<string, unknown> = {}) =>
      env.send('POST', `${services}/eval-runs`, 'kari', { testSet: 'svar-frister', ...body });

    const unsent = await start();
    await env.settled();
    const spansOfUnsent = langfuse.spans.length;
    const sent = await start({ trace: true });
    await env.settled();
    const runs = await env.send('GET', `${services}/eval-runs`);
    const summaryOf = (id: unknown) =>
      (runs.body.data as { id: string }[]).find((r) => r.id === id);
    const stored = await env.platform.evalStores.runs.get(String(unsent.body.id));

    expect(unsent.status).toBe(202);
    expect(spansOfUnsent).toBe(0);
    expect(stored?.run.tested).not.toHaveProperty('sink');
    expect(stored?.run.provenance.judges.filter((j) => j.startsWith('langfuse:'))).toEqual([]);
    expect(summaryOf(unsent.body.id)).toMatchObject({
      sinkJudges: [],
      unsentJudges: [{ id: `langfuse:lokal/${judgeRule}`, name: judgeRule }],
    });
    expect(sent.status).toBe(202);
    expect(langfuse.spans.length).toBeGreaterThan(0);
    expect(summaryOf(sent.body.id)).toMatchObject({ sinkJudges: [{ name: judgeRule }] });
    expect(summaryOf(sent.body.id)).not.toHaveProperty('unsentJudges');
  });

  it('refuses to send a run to Langfuse while the project has active judges genki does not read, and says so before it starts', async () => {
    const rules = [
      experimentRule(),
      experimentRule({ id: 'regel-2', name: 'tone-eksperimenter' }),
      experimentRule({
        id: 'regel-3',
        name: 'verktøy-eksperimenter',
        mapping: [{ variable: 'verktøy', source: 'tool_calls' }],
      }),
      // Langfuse runs an observation rule on every span its filter lets through.
      experimentRule({ id: 'regel-4', name: 'toksisitet', target: 'observation' }),
    ];
    const { env, adopt } = await judged(rules);
    const start = () =>
      env.send('POST', `${services}/eval-runs`, 'kari', { testSet: 'svar-frister', trace: true });
    const differ = (names: string) =>
      `the project of the connection lokal has active judges genki does not read: ${names}; take them in use or switch them off in Langfuse`;

    const noneInUse = await start();
    expect((await adopt(judgeRule)).status).toBe(200);
    const sending = await env.send('GET', `${services}/eval-runs/sending`);
    const oneInUse = await start();
    for (const r of rules.slice(1)) r.status = 'inactive';
    const inStep = await start();
    await env.settled();

    expect(noneInUse.status).toBe(409);
    expect(JSON.stringify(noneInUse.body)).toContain(
      differ(`${judgeRule}, tone-eksperimenter, verktøy-eksperimenter, toksisitet`),
    );
    expect(sending.body).toMatchObject({
      refused: {
        reason: 'judges-differ',
        connection: 'lokal',
        notInUse: ['tone-eksperimenter'],
        unreadable: ['verktøy-eksperimenter', 'toksisitet'],
      },
    });
    expect(oneInUse.status).toBe(409);
    expect(JSON.stringify(oneInUse.body)).toContain(
      differ('tone-eksperimenter, verktøy-eksperimenter, toksisitet'),
    );
    expect(inStep.status).toBe(202);
  });

  it('counts what a judge switched on in Langfuse during a run costs apart from the judges in use, shown only to those who see usage', async () => {
    const later = experimentRule({ id: 'regel-2', name: 'tone-eksperimenter', status: 'inactive' });
    const { env, langfuse, adopt } = await judged([experimentRule(), later]);
    expect((await adopt(judgeRule)).status).toBe(200);
    langfuse.hooks.firstItem = () => {
      later.status = 'active';
    };

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await env.settled();
    const summaryFor = async (who: string) =>
      ((await env.send('GET', `${services}/eval-runs`, who)).body.data as { id: string }[]).find(
        (r) => r.id === started.body.id,
      );

    expect(started.status).toBe(202);
    expect(await summaryFor('kari')).toMatchObject({
      sinkJudges: [{ name: judgeRule, reported: { inputTokens: 4321, costUsd: 0.0123 } }],
      sinkOthers: { inputTokens: 4321, outputTokens: 987, costUsd: 0.0123, unread: 0 },
    });
    expect(await summaryFor('erik')).not.toHaveProperty('sinkOthers');
  });

  it("refuses a Langfuse judge's metric in Kvalitetskrav, naming the rule", async () => {
    const env = await boot();
    const save = (metric: string) =>
      env.send(
        'PUT',
        `/tenants/${tenant}/gates/kriterier-minst-80`,
        'kari',
        { metric, kind: 'threshold', threshold: 0.8 },
        why,
      );

    const refused = await save(`langfuse:lokal/${judgeRule}`);
    const saved = await save('judge.criteria');

    const [error] = refused.body.errors as { path: string; message: string }[];

    expect(refused.status).toBe(400);
    expect(error).toEqual({
      path: 'metric',
      message: `the gate kriterier-minst-80 reads the Langfuse judge ${judgeRule} on the connection lokal, which is advisory and never blocks a publish`,
    });
    // The portal asks in bokmål, and the API answers in it.
    expect(translateMessage(error?.message ?? '', 'nb')).toBe(
      `kvalitetskravet kriterier-minst-80 leser Langfuse-dommeren ${judgeRule} på koblingen lokal, som er rådgivende og aldri stopper en publisering`,
    );
    expect(saved.status).toBe(200);
  });

  it("refuses a service definition with a gate on a Langfuse judge's metric, naming the rule", async () => {
    // A gate set up before Kvalitetskrav refused such metrics, here as one of the platform's own.
    const env = await boot(undefined, undefined, undefined, {
      gates: new Map([
        [
          'kriterier-langfuse',
          gate.parse({
            id: 'kriterier-langfuse',
            metric: `langfuse:lokal/${judgeRule}`,
            kind: 'threshold',
            threshold: 0.8,
          }),
        ],
      ]),
    });
    const gated = structuredClone(service) as typeof service & {
      spec: { evaluation?: { testSets: string[]; gates: string[] } };
    };
    gated.spec.evaluation = { testSets: ['svar-frister'], gates: ['kriterier-langfuse'] };

    const published = await env.platform.definitions.publish(gated, 'kari', 'med Langfuse-krav');

    expect(published.ok).toBe(false);
    expect(JSON.stringify(published)).toContain(
      `the gate kriterier-langfuse reads the Langfuse judge ${judgeRule} on the connection lokal, which is advisory and never blocks a publish`,
    );
  });

  const labelKey = `langfuse:${tenant}/lokal/${judgeRule}`;

  interface LabelBatch {
    tenant: string;
    connection: string;
    judge: string;
    name: string;
    labels: Record<string, unknown>[];
    paired: number;
    alike: number;
    unpaired: number;
    labellers: number;
  }

  /** A run sent to Langfuse and judged there, on a connection whose labels switch is on. */
  const labelled = async (rules?: FakeRule[], labels = true) => {
    const ctx = await judged(rules);
    for (const rule of rules ?? [experimentRule()])
      expect((await ctx.adopt(rule.name)).status).toBe(200);
    if (labels) expect((await ctx.saveConnection(true, { labels: true })).status).toBe(200);
    const started = await ctx.env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    await ctx.env.settled();
    const run = String(started.body.id);
    const fetchLabels = (connection = 'lokal') =>
      ctx.env.send('POST', '/operator/quality/sink-labels/fetch', 'operator', {
        tenant,
        connection,
      });
    const batches = async () =>
      (await ctx.env.send('GET', '/operator/quality/sink-labels', 'operator')).body
        .batches as LabelBatch[];
    const decide = (
      decision: 'accept' | 'reject',
      reason?: string,
      who = 'operator',
      shown?: Record<string, unknown>[],
    ) =>
      ctx.env.send(
        'POST',
        `/operator/quality/sink-labels/${decision}`,
        who,
        {
          tenant,
          connection: 'lokal',
          judge: labelKey,
          ...(shown ? { labels: shown.map((l) => ({ id: l.id, revision: l.revision })) } : {}),
        },
        reason ? { 'change-reason': reason } : {},
      );
    const agreement = async (judge = `langfuse:lokal/${judgeRule}`) =>
      (
        (await ctx.env.send('GET', `/tenants/${tenant}/eval-runs/${run}`)).body.sinkJudges as {
          id: string;
          labels?: unknown;
        }[]
      ).find((j) => j.id === judge)?.labels;
    return { ...ctx, run, fetchLabels, batches, decide, agreement };
  };

  it("turns an ANNOTATION with a judge's exact name and type into a pending label for that judge and case", async () => {
    const numeric = experimentRule({
      id: 'regel-tall',
      name: numericRule,
      evaluator: { id: numericJudge, name: 'svar_poeng' },
    });
    const { langfuse, run, fetchLabels, batches, agreement } = await labelled([
      experimentRule(),
      numeric,
    ]);
    const o1 = langfuse.traceOf('o1');
    langfuse.annotate(o1, { value: false });
    // 1 of 0 to 4 is bad; the judge's 3, which came without a range, is split with the same one.
    langfuse.annotate(o1, { configId: 'oppsett-4', value: 1 });
    // A number whose config has no range cannot be split into good and bad: no label.
    langfuse.annotate(o1, { configId: 'oppsett-5', value: 2 });
    // The judge's name with another type, and another name: not the judge's labels.
    langfuse.annotate(o1, { configId: 'oppsett-2', value: 3 });
    langfuse.annotate(o1, { configId: 'oppsett-3', value: true });

    const fetched = await fetchLabels();

    expect(fetched.status).toBe(200);
    const all = await batches();
    expect(all.find((b) => b.name === numericRule)?.labels).toEqual([
      expect.objectContaining({ case: 'o1', humanLabel: 'bad', judgeLabel: 'good' }),
    ]);
    expect(all.filter((b) => b.name !== numericRule)).toEqual([
      {
        tenant,
        connection: 'lokal',
        judge: labelKey,
        name: judgeRule,
        labels: [
          expect.objectContaining({
            run,
            case: 'o1',
            repeat: 0,
            humanLabel: 'bad',
            judgeLabel: 'good',
          }),
        ],
        paired: 1,
        alike: 0,
        unpaired: 0,
        labellers: 1,
      },
    ]);
    // Pending: nothing counts yet.
    expect(await agreement()).toEqual({ n: 0, otherVersions: 0, unpaired: 0 });
    // Fetching again brings nothing new.
    await fetchLabels();
    expect((await batches()).flatMap((b) => b.labels)).toHaveLength(2);
  });

  it("matches an annotation to a judge by its evaluator's name and type, not the rule's name", async () => {
    const { langfuse, fetchLabels, batches } = await labelled();
    const o1 = langfuse.traceOf('o1');
    // A score config named after the rule, as 4.4.0 named the scores: no label.
    langfuse.annotate(o1, { configId: 'oppsett-6', value: true });
    // Named after the evaluator, as 4.72.0 names them: the judge's label.
    langfuse.annotate(o1, { configId: 'oppsett-1', value: false });

    expect((await fetchLabels()).status).toBe(200);

    expect((await batches()).flatMap((b) => b.labels)).toEqual([
      expect.objectContaining({ case: 'o1', humanLabel: 'bad' }),
    ]);
  });

  it("matches a label by the judge's rule name on a run whose scores did not record their name, as 4.4.0 named them", async () => {
    const { env, langfuse, run, fetchLabels, batches } = await labelled();
    const stored = await env.platform.evalStores.runs.get(run);
    if (!stored) throw new Error('the run was not stored');
    // A run scored before scores recorded the name Langfuse gave them.
    for (const r of stored.run.results)
      for (const sc of r.scores) if (sc.details) delete sc.details.scoreName;
    await env.platform.evalStores.runs.save(stored);
    const o1 = langfuse.traceOf('o1');
    langfuse.annotate(o1, { configId: 'oppsett-6', value: false });
    langfuse.annotate(o1, { configId: 'oppsett-1', value: true });

    expect((await fetchLabels()).status).toBe(200);

    expect((await batches()).flatMap((b) => b.labels)).toEqual([
      expect.objectContaining({ case: 'o1', humanLabel: 'bad' }),
    ]);
  });

  it('makes no label for rules that share an evaluator, and names them in the fetch result', async () => {
    const { langfuse, fetchLabels, batches } = await labelled([
      experimentRule(),
      experimentRule({ id: 'regel-2', name: 'svar_oppfyller_kriteriene-kopi' }),
    ]);
    langfuse.annotate(langfuse.traceOf('o1'), { value: true });

    const fetched = await fetchLabels();

    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual({
      pending: 0,
      shared: [{ name: judgeScore, rules: [judgeRule, 'svar_oppfyller_kriteriene-kopi'] }],
    });
    expect(await batches()).toEqual([]);
  });

  it('counts a label only after its batch is accepted with a reason, in the audit log', async () => {
    const { env, langfuse, fetchLabels, batches, decide, agreement } = await labelled();
    langfuse.annotate(langfuse.traceOf('o1'), { value: true });
    await fetchLabels();
    const shown = (await batches())[0]?.labels ?? [];
    // Someone labels again after the operator opened the batch.
    langfuse.annotate(langfuse.traceOf('o1'), { value: false, authorUserId: 'lf-bruker-2' });
    await fetchLabels();

    expect((await decide('accept', undefined, 'operator', shown)).status).toBe(400);
    expect((await decide('accept', 'Etikettene er kontrollert', 'kari', shown)).status).toBe(403);
    expect(await agreement()).toEqual({ n: 0, otherVersions: 0, unpaired: 0 });

    const accepted = await decide('accept', 'Etikettene er kontrollert', 'operator', shown);

    expect(accepted.status).toBe(200);
    // Only what the operator was shown: the later label still waits.
    expect(accepted.body).toMatchObject({ accepted: 1 });
    expect((await batches())[0]?.labels).toEqual([expect.objectContaining({ humanLabel: 'bad' })]);
    expect(await agreement()).toEqual({
      n: 1,
      kappa: 1,
      observed: 1,
      otherVersions: 0,
      unpaired: 0,
    });
    const audit = (await env.send('GET', '/operator/audit', 'operator')).body.data as {
      action: string;
      target: string;
      reason: string;
      outcome: string;
    }[];
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: 'platform.judge.label.accept',
        target: `judge:${labelKey}`,
        reason: 'Etikettene er kontrollert',
        outcome: 'applied',
      }),
    );
  });

  it('counts a label without a judge score as unpaired', async () => {
    // A second judge reads cases without criteria, so o2 is sent, but the first does not score it.
    const short = experimentRule({
      id: 'regel-2',
      name: 'svar_er_kort-eksperimenter',
      mapping: [{ variable: 'output', source: 'output' }],
      evaluator: { id: 'dommer-kort', name: 'svar_er_kort' },
    });
    const { langfuse, fetchLabels, batches, decide, agreement } = await labelled([
      experimentRule(),
      short,
    ]);
    langfuse.annotate(langfuse.traceOf('o2'), { value: true });
    langfuse.annotate(langfuse.traceOf('o1'), { value: true });

    await fetchLabels();

    const batch = (await batches()).find((b) => b.judge === labelKey);
    expect(batch).toMatchObject({ paired: 1, alike: 1, unpaired: 1 });
    const o2 = batch?.labels.find((l) => l.case === 'o2');
    expect(o2).toMatchObject({ humanLabel: 'good' });
    expect(o2).not.toHaveProperty('judgeLabel');
    await decide('accept', 'Etikettene er kontrollert');
    expect(await agreement()).toMatchObject({ n: 1, unpaired: 1 });
  });

  it('ignores annotations on traces genki did not send', async () => {
    const { env, langfuse, run, fetchLabels, batches } = await labelled();
    const stored = await env.platform.evalStores.runs.get(run);
    const unsent = (id: string) => stored?.run.results.find((r) => r.case === id)?.task ?? '';
    // o2 has no criteria and l1 is a holdout case: neither was sent. The third is someone else's.
    langfuse.annotate(traceIdFor(unsent('o2')), { value: true });
    langfuse.annotate(traceIdFor(unsent('l1')), { value: true });
    langfuse.annotate('0123456789abcdef0123456789abcdef', { value: true });

    const fetched = await fetchLabels();

    expect(fetched.status).toBe(200);
    expect(await batches()).toEqual([]);
  });

  it('turns down a batch with a reason, in the audit log, and does not bring its labels back unless they are edited', async () => {
    const { env, langfuse, fetchLabels, batches, decide, agreement } = await labelled();
    const annotation = langfuse.annotate(langfuse.traceOf('o1'), { value: false });
    await fetchLabels();

    expect((await decide('reject')).status).toBe(400);
    const rejected = await decide('reject', 'Merket av en testbruker');

    expect(rejected.status).toBe(200);
    expect(rejected.body).toMatchObject({ rejected: 1 });
    expect(await batches()).toEqual([]);
    expect(await agreement()).toEqual({ n: 0, otherVersions: 0, unpaired: 0 });
    const audit = (await env.send('GET', '/operator/audit', 'operator')).body.data;
    expect(audit).toContainEqual(
      expect.objectContaining({
        action: 'platform.judge.label.reject',
        target: `judge:${labelKey}`,
        reason: 'Merket av en testbruker',
      }),
    );
    await fetchLabels();
    expect(await batches()).toEqual([]);

    // Langfuse 4.4.0 keeps updatedAt when an annotation is edited in its UI.
    annotation.value = true;
    await fetchLabels();

    expect((await batches())[0]?.labels).toEqual([
      expect.objectContaining({ case: 'o1', humanLabel: 'good' }),
    ]);

    // Accepted, then edited back to the rejected value: that is an edit too, and comes back.
    await decide('accept', 'Rettingen er kontrollert');
    annotation.value = false;
    await fetchLabels();
    expect((await batches())[0]?.labels).toEqual([
      expect.objectContaining({ case: 'o1', humanLabel: 'bad' }),
    ]);
  });

  it('brings an annotation edited in Langfuse back as pending, and stops counting one deleted there', async () => {
    const { langfuse, fetchLabels, batches, decide, agreement } = await labelled();
    const annotation = langfuse.annotate(langfuse.traceOf('o1'), { value: false });
    await fetchLabels();
    await decide('accept', 'Etikettene er kontrollert');
    expect(await agreement()).toMatchObject({ n: 1, observed: 0 });

    // Langfuse 4.4.0 keeps updatedAt when an annotation is edited in its UI.
    annotation.value = true;
    await fetchLabels();

    // The accepted Nei counts until the edit is accepted.
    expect((await batches())[0]?.labels).toEqual([
      expect.objectContaining({ case: 'o1', humanLabel: 'good' }),
    ]);
    expect(await agreement()).toMatchObject({ n: 1, observed: 0 });
    await decide('accept', 'Rettingen er kontrollert');
    expect(await agreement()).toMatchObject({ n: 1, observed: 1 });

    // A Langfuse that cannot be read changes nothing: no accepted label is taken for deleted.
    langfuse.hooks.annotationsDown = true;
    expect((await fetchLabels()).status).toBe(502);
    expect(await agreement()).toMatchObject({ n: 1, observed: 1 });
    langfuse.hooks.annotationsDown = false;

    langfuse.annotations.splice(0);
    await fetchLabels();

    expect(await agreement()).toEqual({ n: 0, otherVersions: 0, unpaired: 0 });
    expect(await batches()).toEqual([]);
  });

  it('brings labels back from a tracing connection only while its labels switch is on', async () => {
    const { langfuse, fetchLabels, batches, saveConnection } = await labelled(undefined, false);
    langfuse.annotate(langfuse.traceOf('o1'), { value: false });

    const off = await fetchLabels();

    expect(off.status).toBe(409);
    expect(JSON.stringify(off.body)).toContain(
      'the connection lokal does not bring labels back; switch labels on first',
    );
    expect(await batches()).toEqual([]);
    expect((await saveConnection(true, { labels: true })).status).toBe(200);
    expect((await fetchLabels()).status).toBe(200);
    expect(await batches()).toHaveLength(1);
  });
});

const localLangfuse = process.env.LANGFUSE_LOCAL_URL;

describe.skipIf(!localLangfuse)('a traced run on a local Langfuse 4.72.0', () => {
  it("lands as one experiment under its test set's dataset, in genki-test-runs, with a trace per case and repeat, no holdout case, and is gone after the purge", async () => {
    const host = localLangfuse as string;
    const publicKey = process.env.LANGFUSE_LOCAL_PUBLIC_KEY ?? 'pk-lf-genki-472';
    const secretKey = process.env.LANGFUSE_LOCAL_SECRET_KEY ?? 'sk-lf-genki-472';
    const deliveries = new InMemoryTraceDeliveries();
    const env = await boot(undefined, { devMode: true }, deliveries);
    const why = { 'change-reason': 'Kobler tjenesten til sporing' };
    await env.send(
      'PUT',
      `/tenants/${tenant}/secrets/lokal`,
      'kari',
      { value: secretKey, allowedHosts: [host] },
      why,
    );
    await env.send(
      'PUT',
      `/tenants/${tenant}/tracing/connections/lokal`,
      'kari',
      { host, publicKey, secretKey: `secret://tenant/${tenant}/lokal`, services: ['svar'] },
      why,
    );

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      trace: true,
    });
    // ADR 0040: a run goes only to a project whose active experiment judges genki reads.
    expect(
      started.status,
      'use a Langfuse project without active experiment judges for this test',
    ).toBe(202);
    await env.settled();
    const run = String(started.body.id);
    const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    const dataset = (
      (await env.send('GET', `/tenants/${tenant}/tracing/connections`)).body.data as {
        datasets: { name: string; id: string }[];
      }[]
    )[0]?.datasets[0];
    expect(dataset?.name).toBe('genki/svar/svar-frister');
    type Observation = {
      isRootObservation: boolean;
      environment?: string;
      input: unknown;
      output: unknown;
      metadata: Record<string, unknown>;
    };
    let roots: Observation[] = [];
    for (let i = 0; i < 60 && roots.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1000));
      const found = (await (
        await fetch(
          `${host}/api/public/v2/observations?fromStartTime=${since}&toStartTime=${until}&limit=100&fields=core,basic,io,metadata`,
          { headers: { authorization: auth } },
        )
      ).json()) as { data: Observation[] };
      roots = found.data.filter(
        (o) => o.isRootObservation && o.metadata['attributes.langfuse.experiment.id'] === run,
      );
    }

    expect(roots.map((o) => o.metadata['attributes.langfuse.experiment.item.id']).sort()).toEqual([
      'o1#0',
      'o2#0',
    ]);
    expect(roots.map((o) => o.metadata['attributes.langfuse.experiment.dataset.id'])).toEqual([
      dataset?.id,
      dataset?.id,
    ]);
    expect(roots.map((o) => o.environment)).toEqual(['genki-test-runs', 'genki-test-runs']);
    expect(roots.map((o) => [o.input ?? null, o.output ?? null])).toEqual([
      [null, null],
      [null, null],
    ]);
    const experiments = (await (
      await fetch(
        `${host}/api/public/experiments?fromStartTime=${since}&toStartTime=${until}&limit=100`,
        { headers: { authorization: auth } },
      )
    ).json()) as { data: { id: string; itemCount?: number; datasetId?: string }[] };
    expect(experiments.data.find((e) => e.id === started.body.id)).toMatchObject({
      itemCount: 2,
      datasetId: dataset?.id,
    });
    await deliveries.markPending(tenant, { sink: 'lokal' }, new Date().toISOString());
    const sink = langfuseTraceSink({ host, publicKey, secretKey });
    const night = () =>
      deleteSinkTraces({
        deliveries,
        sinkFor: async () => sink,
        verify: { tries: 120, everyMs: 1000, wait: (ms) => new Promise((r) => setTimeout(r, ms)) },
      });
    const traces = (await deliveries.pending(10)).map((d) => d.trace);

    const first = await night();
    for (let i = 0; i < 300; i += 1) {
      const left = (await Promise.all(traces.map((t) => sink.remaining(t)))).flat();
      if (left.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    const second = await night();

    expect(traces).toHaveLength(2);
    expect(first.deleted + second.deleted).toBe(2);
    expect(second.failed).toBe(0);
    expect(await deliveries.pending(10)).toEqual([]);
    expect(await deliveries.outstanding(tenant, 'lokal')).toBe(0);
  }, 420_000);
});

describe('service draft', () => {
  it('deletes the draft so it reads as absent, and a new draft starts from revision 0', async () => {
    const { send } = await boot();
    const saved = await send('PUT', `${services}/draft`, 'kari', { definition: service });
    const stale = await send('DELETE', `${services}/draft`, 'kari', { revision: 99 });
    const removed = await send('DELETE', `${services}/draft`, 'kari', {
      revision: saved.body.revision,
    });
    const again = await send('PUT', `${services}/draft`, 'kari', {
      definition: service,
      revision: 0,
    });

    expect(saved.status).toBe(200);
    expect(stale.status).toBe(409);
    expect(removed.status).toBe(200);
    expect(again.status).toBe(200);
    expect((await send('DELETE', `${services}/draft`, 'kari', {})).status).toBe(200);
    expect(await send('GET', `${services}/draft`)).toMatchObject({ status: 200, body: null });
    expect((await send('DELETE', `${services}/draft`, 'kari', {})).status).toBe(404);
  });

  it('reading the draft of a service that has none answers 200 with null instead of 404', async () => {
    const { send } = await boot();

    expect(await send('GET', `${services}/draft`)).toMatchObject({ status: 200, body: null });
  });

  it('a person without manage-services cannot delete the draft', async () => {
    const { send } = await boot();
    await send('PUT', `${services}/draft`, 'kari', { definition: service });

    expect((await send('DELETE', `${services}/draft`, 'erik', {})).status).toBe(403);
    expect((await send('GET', `${services}/draft`)).status).toBe(200);
  });
});

describe('improvements', () => {
  const ready = async () => {
    const env = await boot();
    await negativeFeedback(env);
    await runPublished(env);
    const started = await env.send('POST', `${services}/improvements`, 'kari', {});
    expect(started.status).toBe(202);
    await env.settled();
    return { ...env, id: String(started.body.id) };
  };

  it('proposes an instruction change with before and after scores on the locked split', async () => {
    const { send } = await ready();

    const list = await send('GET', `${services}/improvements`);

    expect(list.body.data).toEqual([
      expect.objectContaining({
        status: 'ready',
        change: { path: 'spec.strategy.config.instructions', before: 'Svar kort.', after: better },
        scores: {
          testSet: 'svar-frister',
          before: 0,
          after: 1,
          passedBefore: 0,
          passedAfter: 1,
          total: 1,
        },
        examples: [
          {
            input: 'Når er fristen for søknad?',
            before: 'Vi svarer snart.',
            after: 'Fristen er 1. mai.',
          },
        ],
        reasons: ['Brukerne savnet fristen.'],
      }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain('kari');
  });

  it('the optimiser sees open cases and anonymous feedback, never the locked split or who gave it', async () => {
    const { optimiserPrompts } = await ready();

    expect(optimiserPrompts).toHaveLength(1);
    expect(optimiserPrompts[0]).toContain('Når er fristen for søknad?');
    expect(optimiserPrompts[0]).toContain('Svaret manglet fristen.');
    expect(optimiserPrompts[0]).not.toContain(locked);
    expect(optimiserPrompts[0]).not.toContain('kari');
    expect(optimiserPrompts[0]).not.toContain('task-');
  });

  it('approving writes the change into the draft only and never publishes', async () => {
    const { send, platform, id } = await ready();

    const approved = await send('POST', `${services}/improvements/${id}/decision`, 'kari', {
      approve: true,
    });
    const draft = await send('GET', `${services}/draft`);
    const versions = await platform.definitions.versions('Service', tenant, 'svar');

    expect(approved.status).toBe(200);
    expect(approved.body).toMatchObject({ id, status: 'approved' });
    expect(draft.body).toMatchObject({
      definition: { spec: { strategy: { config: { instructions: better } } } },
    });
    expect(versions).toHaveLength(1);
    expect(versions[0]?.definition.spec).toMatchObject({
      strategy: { config: { instructions: 'Svar kort.' } },
    });
    expect(
      (await send('POST', `${services}/improvements/${id}/decision`, 'kari', { approve: true }))
        .status,
    ).toBe(409);
  });

  it('rejecting records the decision with the comment from change-reason and leaves no draft', async () => {
    const { send, id } = await ready();

    const rejected = await send(
      'POST',
      `${services}/improvements/${id}/decision`,
      'kari',
      { approve: false },
      { 'change-reason': 'Endrer tonen for mye' },
    );

    expect(rejected.body).toMatchObject({
      id,
      status: 'rejected',
      decision: { approved: false, reason: 'Endrer tonen for mye' },
    });
    expect(await send('GET', `${services}/draft`)).toMatchObject({ status: 200, body: null });
  });

  it('a person without manage-services cannot approve, and a support session can read the proposals', async () => {
    const { send, id, supportSession } = await ready();
    const inSession = await supportSession();

    const erik = await send('POST', `${services}/improvements/${id}/decision`, 'erik', {
      approve: true,
    });

    expect(erik.status).toBe(403);
    expect(
      (await send('GET', `${services}/improvements`, 'operator', undefined, inSession)).status,
    ).toBe(200);
    expect(await send('GET', `${services}/draft`)).toMatchObject({ status: 200, body: null });
  });

  it('is refused when the service does not allow instruction proposals', async () => {
    const env = await boot();
    const closed = structuredClone(service);
    closed.spec.improve.allow = [];
    await env.platform.definitions.publish(closed, 'kari', 'stengt');
    await negativeFeedback(env);

    const refused = await env.send('POST', `${services}/improvements`, 'kari', {});

    expect(refused.status).toBe(409);
    expect(refused.body.title).toBe(
      'Tjenesten tillater ikke forslag til instruksjonene. Slå det på under Oppsett › Arbeidsmåte.',
    );
    expect(refused.body.errors).toEqual([expect.objectContaining({ path: 'spec.improve.allow' })]);
  });

  it('is refused when there is nothing to learn from', async () => {
    const { send } = await boot();

    expect((await send('POST', `${services}/improvements`, 'kari', {})).status).toBe(409);
  });

  describe('one language at a time', () => {
    const withEnglishText = () => {
      const next = structuredClone(service);
      (next.spec.strategy.config as Record<string, unknown>).languageInstructions = {
        en: 'Be brief.',
      };
      return next;
    };

    const languageSet = parseTestSet({
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant, id: 'svar-sprak', name: 'Språk', version: 1 },
      spec: {
        service: 'svar',
        cases: [
          {
            id: 'en-open',
            split: 'train',
            language: 'en',
            input: 'When is the deadline for the application?',
            expected: { referenceAnswer: 'Svaret oppgir fristen' },
            type: 'criteria',
          },
          {
            id: 'nb-open',
            split: 'train',
            language: 'nb',
            input: 'Når er fristen for klage?',
            expected: { referenceAnswer: 'Svaret oppgir fristen' },
            type: 'criteria',
          },
          {
            id: 'en-locked',
            split: 'holdout',
            language: 'en',
            input: 'Which deadline applies to access?',
            expected: { referenceAnswer: 'Svaret oppgir fristen' },
            type: 'criteria',
          },
        ],
      },
    });

    const readyFor = async (language: string) => {
      const env = await boot();
      await env.platform.definitions.publish(withEnglishText(), 'kari', 'engelsk tekst');
      await env.platform.evalStores.testSets.put(languageSet);
      await negativeFeedback(env);
      const run = await env.send('POST', `${services}/eval-runs`, 'kari', {
        testSet: 'svar-sprak',
      });
      expect(run.status).toBe(202);
      await env.settled();
      const started = await env.send('POST', `${services}/improvements`, 'kari', {
        testSet: 'svar-sprak',
        language,
      });
      await env.settled();
      return { ...env, started, id: String(started.body.id) };
    };

    it('a proposal for English changes the English text and leaves the shared instructions alone', async () => {
      const { send, id, started } = await readyFor('en');

      const list = await send('GET', `${services}/improvements`);
      await send('POST', `${services}/improvements/${id}/decision`, 'kari', { approve: true });
      const draft = await send('GET', `${services}/draft`);

      expect(started.status).toBe(202);
      expect(list.body.data).toEqual([
        expect.objectContaining({
          language: 'en',
          status: 'ready',
          change: {
            path: 'spec.strategy.config.languageInstructions.en',
            before: 'Be brief.',
            after: better,
          },
        }),
      ]);
      expect(draft.body).toMatchObject({
        definition: {
          spec: {
            strategy: {
              config: { instructions: 'Svar kort.', languageInstructions: { en: better } },
            },
          },
        },
      });
    });

    it('the optimiser is told the language and sees only failing cases written in it', async () => {
      const { optimiserPrompts } = await readyFor('en');

      expect(optimiserPrompts).toHaveLength(1);
      expect(optimiserPrompts[0]).toContain('Språk: engelsk');
      expect(optimiserPrompts[0]).toContain('Be brief.');
      expect(optimiserPrompts[0]).toContain('When is the deadline for the application?');
      expect(optimiserPrompts[0]).not.toContain('Når er fristen for klage?');
    });

    it('is refused for a language the service has no text of its own for', async () => {
      const { started } = await readyFor('nb');

      expect(started.status).toBe(409);
      expect(started.body.errors).toEqual([expect.objectContaining({ path: 'language' })]);
    });

    it('is refused for a language the platform does not answer in', async () => {
      const { started } = await readyFor('de');

      expect(started.status).toBe(400);
    });
  });
});

describe('a test run as the portal shows it', () => {
  const finishedRun = (results: EvalRun['results']): EvalRun => ({
    id: 'r',
    testSet: { tenant, id: 'svar-frister', version: 1 },
    capability: `${tenant}/svar`,
    splits: ['validation'],
    repeats: 1,
    startedAt: '2026-10-12T10:00:00Z',
    endedAt: '2026-10-12T10:01:00Z',
    provenance: { commit: 'abc', data: 'd', servedModels: ['m'], judges: [], services: [] },
    results,
    metrics: {},
    byTag: {},
    incomplete: [],
    status: 'completed',
    tested: { version: 1 },
  });
  const score = (metric: string, value: number | null, state: 'scored' | 'not-applicable') => ({
    evaluator: 'contract',
    version: '2',
    metric,
    value,
    applicable: state === 'scored',
    state,
  });

  it('counts every case in the summary, so one without a verdict shows as not passed, as in the case list', () => {
    const run = finishedRun([
      {
        case: 'a',
        split: 'validation',
        repeat: 0,
        task: 't1',
        tags: [],
        scores: [score('exact-text', 1, 'scored')],
      },
      {
        case: 'b',
        split: 'validation',
        repeat: 0,
        task: 't2',
        tags: [],
        scores: [score('exact-text', null, 'not-applicable')],
      },
    ]);

    expect(runSummary(run)).toMatchObject({ passed: 1, total: 2, score: 0.5 });
  });

  it('decides a criteria case by its criteria, also when it must refuse as well', () => {
    const run = finishedRun([
      {
        case: 'a',
        split: 'validation',
        repeat: 0,
        task: 't1',
        tags: [],
        scores: [
          score('refusal', 1, 'scored'),
          { ...score('judge.criteria', 0, 'scored'), evaluator: 'judge:criteria' },
        ],
      },
    ]);

    expect(runSummary(run)).toMatchObject({ passed: 0, total: 1 });
  });

  it("shows a fields-only answer as the case's output", () => {
    const fieldsOnly = [
      {
        mime: 'application/json',
        body: { kind: 'json' as const, json: { text: 'Fristen er 1. mai.', changes: [] } },
      },
      {
        mime: 'application/vnd.genai.sources+json',
        body: { kind: 'json' as const, json: [{ id: 'kilde' }] },
      },
    ];

    expect(JSON.parse(answerOfParts(fieldsOnly))).toEqual({
      text: 'Fristen er 1. mai.',
      changes: [],
    });
    expect(answerOfParts([{ mime: 'text/plain', body: { kind: 'text', text: 'Svar.' } }])).toBe(
      'Svar.',
    );
  });

  it('never moves a finished run back to waiting or to running progress', () => {
    const done = finishedRun([]);
    const running = { ...done, status: 'running' as const };

    expect(waitingForScores(done)).toBe(done);
    expect(progressed(done, { done: 1, total: 2 })).toBe(done);
    expect(waitingForScores(running).status).toBe('waiting-for-scores');
    expect(progressed(running, { done: 1, total: 2 }).progress).toEqual({ done: 1, total: 2 });
  });
});
