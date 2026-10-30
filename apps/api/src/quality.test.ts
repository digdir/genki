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

    expect(stored?.run.provenance.judges).not.toContain(`judge:criteria@1+${judgeId}`);
    expect(
      stored?.run.results
        .flatMap((r) => r.scores)
        .filter((s) => s.metric === 'judge.criteria' && s.applicable)
        .every((s) => s.state === 'failed'),
    ).toBe(true);
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

const otlpCollector = async () => {
  const spans: { name: string; attributes: { key: string; value: { stringValue?: string } }[] }[] =
    [];
  const sink = await fakeHttp((body: Record<string, unknown>) => {
    const resource = (body.resourceSpans ?? []) as { scopeSpans: { spans: typeof spans }[] }[];
    spans.push(...resource.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
    return { status: 200, json: {} };
  });
  servers.push(sink);
  const attr = (span: (typeof spans)[number], key: string) =>
    span.attributes.find((a) => a.key === key)?.value.stringValue;
  return { url: sink.url, spans, attr };
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

interface FakeRule {
  id: string;
  name: string;
  target: string;
  status: string;
  enabled: boolean;
  mapping: { variable: string; source: string; jsonPath?: string }[];
  evaluator: { id: string; name: string };
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
 * A Langfuse 4.4.0 project whose active experiment rules judge each item as its root span arrives,
 * as Langfuse does a few seconds after a trace comes in.
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
  const judging = () => rules.filter((r) => r.target === 'experiment' && r.status === 'active');
  const server = await fakeHttp((body, _attempt, path) => {
    const url = new URL(path, 'http://langfuse.test');
    const ok = (json: unknown) => ({ status: 200, json });
    if (url.pathname === '/api/public/otel/v1/traces') {
      const resource = (body.resourceSpans ?? []) as { scopeSpans: { spans: typeof spans }[] }[];
      const got = resource.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
      spans.push(...got);
      for (const span of got)
        if (attr(span, 'langfuse.experiment.item.root_observation_id') === span.spanId)
          for (const r of judging())
            scores.set(span.traceId, [
              ...(scores.get(span.traceId) ?? []),
              {
                id: `${r.id}-${span.traceId}`,
                name: r.name,
                value: true,
                dataType: 'BOOLEAN',
                source: 'EVAL',
                comment: 'Svaret oppgir fristen.',
                metadata: { job_configuration_id: r.id },
              },
            ]);
      return ok({});
    }
    if (url.pathname === '/api/public/unstable/evaluation-rules')
      return ok({
        data: rules,
        meta: { page: 1, limit: 50, totalItems: rules.length, totalPages: 1 },
      });
    const ruleId = /evaluation-rules\/(.+)$/.exec(url.pathname)?.[1];
    if (ruleId) {
      const found = rules.find((r) => r.id === decodeURIComponent(ruleId));
      return found ? ok(found) : { status: 404, json: {} };
    }
    const evaluatorId = /unstable\/evaluators\/(.+)$/.exec(url.pathname)?.[1];
    if (evaluatorId)
      return ok({
        id: decodeURIComponent(evaluatorId),
        name: 'svar_oppfyller_kriteriene',
        version: 1,
        outputDefinition: { dataType: 'BOOLEAN' },
        modelConfig: { provider: 'foundry-claude', model: 'claude-sonnet-5' },
      });
    if (url.pathname === '/api/public/v3/scores')
      return ok({ data: scores.get(url.searchParams.get('traceId') ?? '') ?? [], meta: {} });
    if (url.pathname === '/api/public/projects')
      return ok({ data: [{ id: 'genki-test', name: 'genki test' }] });
    return { status: 404, json: {} };
  });
  servers.push(server);
  return { url: server.url, spans, attr };
};

describe('Langfuse judges on a run', () => {
  const why = { 'change-reason': 'Kobler tjenesten til Langfuse-dommerne' };
  const judged = async (rules?: FakeRule[], residency = 'global') => {
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
    const saved = await env.send(
      'PUT',
      `/tenants/${tenant}/tracing/connections/lokal`,
      'kari',
      {
        host: langfuse.url,
        publicKey: 'pk-lf-lokal',
        secretKey: `secret://tenant/${tenant}/sporing`,
        services: ['svar'],
        residency,
        content: true,
        erasureDeclared: true,
      },
      why,
    );
    expect(saved.status).toBe(200);
    const adopt = (name: string) =>
      env.send(
        'POST',
        `/tenants/${tenant}/building-blocks/judge/${encodeURIComponent(`langfuse:lokal/${name}`)}/adopt`,
        'kari',
        undefined,
        why,
      );
    return { env, langfuse, adopt };
  };

  it("scores a run's cases with a Langfuse judge under the identity langfuse:<tenant>/<connection>/<name>@v<version>+<model>", async () => {
    const { env, langfuse, adopt } = await judged();
    expect((await adopt(judgeRule)).status).toBe(200);

    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
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
    expect(stored?.run.metrics[`langfuse:lokal/${judgeRule}`]).toMatchObject({ mean: 1, n: 1 });
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
    const { env, adopt } = await judged([
      experimentRule(),
      experimentRule({ id: 'regel-2', name: short }),
      experimentRule({ id: 'regel-3', name: 'svar-sporinger', target: 'trace' }),
      experimentRule({ id: 'regel-4', name: 'pause-eksperimenter', status: 'inactive' }),
    ]);

    const listed = await env.send('GET', `/tenants/${tenant}/building-blocks?kind=judge`);
    const blocks = (listed.body.data as { id: string }[]).filter((b) =>
      b.id.startsWith('langfuse:'),
    );
    expect((await adopt(judgeRule)).status).toBe(200);
    const started = await env.send('POST', `${services}/eval-runs`, 'kari', {
      testSet: 'svar-frister',
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
});

const localLangfuse = process.env.LANGFUSE_LOCAL_URL;

describe.skipIf(!localLangfuse)('a traced run on a local Langfuse 4.4.0', () => {
  it('lands as one experiment with a trace per case and repeat, no holdout case, and is gone after the purge', async () => {
    const host = localLangfuse as string;
    const publicKey = process.env.LANGFUSE_LOCAL_PUBLIC_KEY ?? 'pk-lf-genki-test';
    const secretKey = process.env.LANGFUSE_LOCAL_SECRET_KEY ?? 'sk-lf-genki-test';
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
    await env.settled();
    const run = String(started.body.id);
    const auth = `Basic ${Buffer.from(`${publicKey}:${secretKey}`).toString('base64')}`;
    const since = new Date(Date.now() - 10 * 60_000).toISOString();
    const until = new Date(Date.now() + 10 * 60_000).toISOString();
    type Observation = {
      isRootObservation: boolean;
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
    expect(roots.map((o) => [o.input ?? null, o.output ?? null])).toEqual([
      [null, null],
      [null, null],
    ]);
    const experiments = (await (
      await fetch(
        `${host}/api/public/experiments?fromStartTime=${since}&toStartTime=${until}&limit=100`,
        { headers: { authorization: auth } },
      )
    ).json()) as { data: { id: string; itemCount?: number }[] };
    expect(experiments.data.find((e) => e.id === started.body.id)).toMatchObject({ itemCount: 2 });
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
