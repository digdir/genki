import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parse as parseYaml } from 'yaml';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import {
  InMemoryCandidateStore,
  InMemoryEvalRunStore,
  InMemoryFeedbackStore,
  InMemoryTestSetStore,
  parseTestSet,
} from '@genai/eval';
import { envSecrets, InMemoryTaskStore, type StoredTask } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import type { ModelCatalog } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { trustedEntraScope } from '@genai/identity';
import { testRerankAdapter } from './rerank.test-utils.js';
import { createAdmin } from './admin.js';
import { restartMessage, type LeaseOptions } from './background-lease.js';
import { resolveCatalog } from './catalogs.js';
import { createPlatform, platformModules } from './composition.js';
import { appendVersion, InMemoryConfigEntryStore, platformScope } from './config-store.js';
import type { EvalSlotLimits } from './eval-slots.js';
import { candidateTrialScope, withCandidateTrial } from './model-access.js';
import {
  createModelMatrixModule,
  matrixRunKind,
  modelMatrixModule,
  releaseGate,
  type MatrixRun,
} from './model-matrix.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const config = join(import.meta.dirname, '..', 'config', 'local');
const yaml = (file: string) => parseYaml(readFileSync(join(config, file), 'utf8')) as unknown;
const tenant = '889640782';
const platformTenant = '991825827';
const current = 'foundry-openai/gpt-4o-2m-tps';
const candidate = 'foundry-openai/kandidat';
const reason = 'Ny modell til vurdering';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant,
    authorizedFor: [{ org: tenant }],
  },
  operator: { kind: 'operator', issuer: 'test', subject: 'digdir-drift' },
  'operator-in-tenant': {
    kind: 'operator',
    issuer: 'test',
    subject: 'digdir-drift-hos',
    authorizedFor: [{ org: tenant }],
  },
  'entra-operator': {
    kind: 'operator',
    issuer: 'test',
    subject: 'entra-drift',
    scopes: [trustedEntraScope],
  },
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

const service = (model: string) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svar på spørsmål om frister',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: model, residency: 'global' },
  },
});

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
    ],
  },
});

/** A connection that offers the test rerank engine, since genki has none built in (ADR 0048). */
const withRerankEndpoint = (catalog: ModelCatalog): ModelCatalog => ({
  ...catalog,
  endpoints: {
    ...catalog.endpoints,
    omrangering: {
      baseURL: 'https://rerank.example',
      auth: { kind: 'api-key', secret: 'secret://env/rerank-key' },
      families: { 'test-rerank': '' },
      discovery: [],
    },
  },
});

interface Restart {
  store?: InMemoryConfigEntryStore;
  evalStores?: Parameters<typeof createPlatform>[0]['evalStores'];
  leases?: LeaseOptions;
  evalSlots?: Partial<EvalSlotLimits>;
  hold?: (body: Record<string, unknown>) => Promise<void> | undefined;
  definitions?: { store?: InMemoryDefinitionStore };
}

const boot = async (
  candidateKnowsDeadlines: boolean,
  withTestSet = true,
  lockdown = false,
  usageLookupMs = 0,
  restart: Restart = {},
) => {
  const deployments: string[] = [];
  const model = await fakeHttp(async (body: Record<string, unknown>) => {
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
    deployments.push(String(body.model));
    await restart.hold?.(body);
    const messages = body.messages as { content?: string }[];
    const system = messages[0]?.content ?? '';
    const user = messages.at(-1)?.content ?? '';
    const stream = Boolean(body.stream);
    if (system.startsWith('You check whether')) {
      const answer = /Answer to check:\n([\s\S]*?)\n\nCriteria/.exec(user)?.[1] ?? '';
      const met = /frist/i.test(answer) ? 1 : 0;
      return reply(JSON.stringify({ scores: { criteria: met }, rationale: 'Vurdert.' }), stream);
    }
    if (user.includes('personnummer')) return reply('Jeg kan ikke svare på det.', stream);
    const knows = body.model !== 'kandidat' || candidateKnowsDeadlines;
    return reply(knows ? 'Fristen er 1. mai.' : 'Vi svarer snart.', stream);
  });
  const search = await fakeHttp(() => ({ status: 200, json: {} }));
  servers.push(model, search);
  const env = {
    FOUNDRY_OPENAI_BASE_URL: `${model.url}/v1`,
  };
  const background: Promise<void>[] = [];
  const stored = new Map<string, StoredTask>();
  const tasks = new (class extends InMemoryTaskStore {
    override async put(task: StoredTask) {
      stored.set(task.task.id, task);
      await super.put(task);
    }
  })();
  const platform = await createPlatform({
    tasks,
    catalogs: {
      models: withRerankEndpoint(
        resolveCatalog(yaml('models.yaml'), 'models', env).catalog as ModelCatalog,
      ),
      knowledge: resolveCatalog(yaml('knowledge.yaml'), 'datasets', env).catalog,
      rerank: resolveCatalog(yaml('rerank.yaml'), 'rerankers', env).catalog,
    },
    secrets: envSecrets({ FOUNDRY_OPENAI_KEY: 'm', RERANK_KEY: 'r' }),
    rerankAdapters: [testRerankAdapter],
    definitions: (plugins) =>
      restart.definitions
        ? (restart.definitions.store ??= new InMemoryDefinitionStore(plugins))
        : new InMemoryDefinitionStore(plugins),
    blobStore: new InMemoryBlobStore(),
    policy: { decide: async () => ({ allow: true }) },
    prices: {
      [current]: { inputPerThousand: 0.0238, outputPerThousand: 0.0952 },
      'foundry-openai/gpt-41-dommer': { inputPerThousand: 0.019, outputPerThousand: 0.0762 },
    },
    modules: [
      ...platformModules.filter((m) => m !== modelMatrixModule),
      createModelMatrixModule({
        onBackground: (w) => background.push(w),
        ...(restart.leases ? { leases: restart.leases } : {}),
      }),
    ],
    ...(restart.store ? { configurables: { store: restart.store } } : {}),
    ...(restart.evalStores ? { evalStores: restart.evalStores } : {}),
    ...(restart.evalSlots ? { evalSlots: restart.evalSlots } : {}),
    ...(lockdown ? { lockdown: { configuredKeys: new Set<string>() } } : {}),
    ...(usageLookupMs
      ? {
          taskIndex: {
            all: async () => [],
            running: async () => [],
            tokensUsed: async () => {
              await new Promise((done) => setTimeout(done, usageLookupMs));
              return 0;
            },
          },
        }
      : {}),
    authenticate: async (request) => {
      const who = request.headers.get('authorization')?.replace('Bearer ', '') ?? '';
      const principal = people[who];
      return principal ? { principal } : undefined;
    },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const published = await platform.definitions.publish(service(current), 'kari', 'første');
  if (!published.ok) throw new Error(JSON.stringify(published.errors));
  if (withTestSet && !(await platform.evalStores.testSets.get(tenant, testSet.metadata.id)))
    await platform.evalStores.testSets.put(testSet);
  const send = async (
    method: string,
    path: string,
    who = 'operator',
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
    return {
      status: res.status,
      body: json as Record<string, unknown>,
      task: res.headers.get('genai-task'),
    };
  };
  const settled = async () => {
    while (background.length > 0) await Promise.all(background.splice(0));
  };
  const added = await send(
    'PUT',
    `/operator/models/${candidate}`,
    'operator',
    {
      endpoint: 'foundry',
      deployment: 'kandidat',
      family: 'kandidat',
      residency: 'global',
      capabilities: ['stream', 'tools', 'json-schema'],
    },
    { 'change-reason': reason },
  );
  if (added.status !== 200) throw new Error(JSON.stringify(added.body));
  const visible = async () =>
    ((await send('GET', '/models', 'kari')).body.data as { id: string }[]).map((m) => m.id);
  const startMatrix = async (who = 'operator') => {
    const estimate = await send('POST', '/operator/quality/matrix/estimate', who, {
      model: candidate,
      current,
    });
    return send(
      'POST',
      '/operator/quality/matrix/runs',
      who,
      { model: candidate, current, confirmedCostNok: estimate.body.estimatedCostNok },
      { 'change-reason': reason },
    );
  };
  const runMatrix = async (who = 'operator') => {
    const estimate = await send('POST', '/operator/quality/matrix/estimate', who, {
      model: candidate,
      current,
    });
    const started = await send(
      'POST',
      '/operator/quality/matrix/runs',
      who,
      { model: candidate, current, confirmedCostNok: estimate.body.estimatedCostNok },
      { 'change-reason': reason },
    );
    await settled();
    return { estimate, started };
  };
  const release = (headers: Record<string, string> = { 'change-reason': 'Kvaliteten holder' }) =>
    send(
      'POST',
      '/operator/quality/matrix/release',
      'operator',
      { kind: 'models', name: candidate },
      headers,
    );
  const usage = async () => {
    const body = (await send('GET', `/tenants/${tenant}/usage`, 'kari')).body;
    return { ...body, from: undefined, to: undefined };
  };
  const draftTasks = () =>
    [...stored.values()]
      .map((t) => t.task)
      .filter((t) => t.service.capability.id.startsWith('platform/draft/'));
  return {
    platform,
    admin,
    send,
    settled,
    visible,
    runMatrix,
    startMatrix,
    release,
    deployments,
    usage,
    draftTasks,
  };
};

describe('a new platform model before release', () => {
  it('stays hidden from tenants and cannot be published in a service', async () => {
    const { platform, visible } = await boot(true);

    const published = await platform.definitions.publish(service(candidate), 'kari', 'bytt');

    expect(await visible()).not.toContain(candidate);
    expect(await visible()).toContain(current);
    expect(published.ok).toBe(false);
  });

  it('estimates the cost from the test sets of services on the model it replaces', async () => {
    const { send, deployments } = await boot(true);

    const estimate = await send('POST', '/operator/quality/matrix/estimate', 'operator', {
      model: candidate,
      current,
    });

    expect(estimate.status).toBe(200);
    expect(estimate.body).toMatchObject({
      model: candidate,
      current,
      testSets: [{ tenant, service: 'svar', name: 'Svar', testSet: 'svar-frister', cases: 2 }],
      cases: 4,
      unpriced: [candidate],
    });
    expect(estimate.body.estimatedCostNok).toBeGreaterThan(0);
    expect(deployments).toEqual([]);
  });

  it('starts a matrix run only after the estimated cost is confirmed', async () => {
    const { send, settled, deployments } = await boot(true);

    const unconfirmed = await send(
      'POST',
      '/operator/quality/matrix/runs',
      'operator',
      { model: candidate, current },
      { 'change-reason': reason },
    );
    const noReason = await send('POST', '/operator/quality/matrix/runs', 'operator', {
      model: candidate,
      current,
      confirmedCostNok: 100,
    });
    const byTenant = await send(
      'POST',
      '/operator/quality/matrix/runs',
      'kari',
      { model: candidate, current, confirmedCostNok: 100 },
      { 'change-reason': reason },
    );
    await settled();

    expect(unconfirmed.status).toBe(409);
    expect(unconfirmed.body).toMatchObject({
      title: 'Bekreft den beregnede kostnaden',
      estimate: { cases: 4 },
    });
    expect(noReason.status).toBe(400);
    expect(byTenant.status).toBe(403);
    expect(deployments).toEqual([]);
  });

  it('runs both models through the test sets and shows the result in the quality matrix', async () => {
    const { send, runMatrix, deployments } = await boot(false);

    const { started } = await runMatrix();
    const run = await send('GET', `/operator/quality/matrix/runs/${String(started.body.id)}`);
    const quality = await send('GET', '/operator/quality');

    expect(started.status).toBe(202);
    expect(run.body).toMatchObject({
      status: 'succeeded',
      model: candidate,
      current,
      testSets: 1,
      done: 1,
      rows: [
        {
          service: 'svar',
          testSet: 'svar-frister',
          current: { score: 1, passed: 2, total: 2 },
          candidate: { score: 0.5, passed: 1, total: 2 },
        },
      ],
    });
    expect(deployments).toContain('kandidat');
    expect(deployments).toContain('gpt-41-dommer');
    expect(quality.body.matrix).toEqual({
      models: {
        columns: [
          { name: current, status: 'in_use' },
          { name: candidate, status: 'new' },
        ],
        baseline: [0, 0],
        rows: [{ testSet: `Svar · ${tenant}`, kind: 'Delt testsett', scores: [100, 50] }],
      },
      blocks: { columns: [], baseline: [], rows: [] },
    });
    expect(quality.body.candidates).toEqual([{ id: candidate, residency: 'global', testSets: 1 }]);
    expect(quality.body.matrixRuns).toMatchObject([{ status: 'succeeded', model: candidate }]);
  });
});

describe('the quality matrix in a locked environment', () => {
  it('runs the quality matrix an Entra operator started in lockdown', async () => {
    const { send, runMatrix, deployments } = await boot(false, true, true);

    const { started } = await runMatrix('entra-operator');
    const run = await send('GET', `/operator/quality/matrix/runs/${String(started.body.id)}`);

    expect(started.status).toBe(202);
    expect(run.body).toMatchObject({ status: 'succeeded', done: 1 });
    expect(deployments).toContain('kandidat');
  });

  it('still refuses the quality matrix a TestID operator started in lockdown', async () => {
    const { runMatrix, deployments } = await boot(false, true, true);

    await runMatrix('operator');

    expect(deployments).toEqual([]);
  });
});

describe('releasing a model from the quality matrix', () => {
  it('is refused before a matrix run and when a test set is more than 3 points worse', async () => {
    const { runMatrix, release, visible } = await boot(false);

    const early = await release();
    await runMatrix();
    const worse = await release();

    expect(early.status).toBe(409);
    expect(early.body.title).toBe('Kvalitetsmatrisen er ikke kjørt for modellen');
    expect(worse.status).toBe(409);
    expect(worse.body.title).toMatch(/kan ikke tillates/);
    expect(worse.body.errors).toEqual([
      {
        path: `testSets.${tenant}/svar/svar-frister`,
        message: `50 points worse than ${current}`,
      },
    ]);
    expect(await visible()).not.toContain(candidate);
  });

  it('starting a matrix run is an audited admin task with the change reason', async () => {
    const { admin, runMatrix } = await boot(true);

    const { started } = await runMatrix();

    expect(started.status).toBe(202);
    const entry = (await admin.audit()).find((a) => a.action === 'platform.quality.matrix.run');
    expect(entry).toMatchObject({
      outcome: 'applied',
      target: `matrix-run:${String(started.body.id)}`,
    });
    expect(entry?.task).toBe(started.task);
  });

  it('releases a model that holds up, with an audited reason, and tenants can then use it', async () => {
    const { platform, admin, runMatrix, release, visible, send } = await boot(true);

    await runMatrix();
    const withoutReason = await release({});
    const released = await release();
    const again = await release();
    const published = await platform.definitions.publish(service(candidate), 'kari', 'bytt');
    const quality = await send('GET', '/operator/quality');

    expect(withoutReason.status).toBe(400);
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ model: candidate, released: true });
    expect(again.status).toBe(409);
    expect(await visible()).toContain(candidate);
    expect(published.ok).toBe(true);
    expect(
      (await admin.audit()).find(
        (a) => a.action === 'platform.catalog.publish' && a.reason === 'Kvaliteten holder',
      ),
    ).toBeTruthy();
    expect(
      (quality.body.matrix as { models: { columns: unknown[] } }).models.columns,
    ).toContainEqual({ name: candidate, status: 'allowed' });
  });
});

describe('the quality matrix at run time', () => {
  it('refuses a tenant draft run with a candidate, while the matrix run may use it', async () => {
    const { send, runMatrix, deployments } = await boot(true);

    const draft = await send('POST', `/tenants/${tenant}/definitions/test-run`, 'kari', {
      definition: service(candidate),
      query: 'Når er fristen for søknad?',
    });
    const before = deployments.filter((d) => d === 'kandidat').length;
    await runMatrix();

    expect(draft.status).not.toBe(200);
    expect(JSON.stringify(draft.body)).toContain('is not released yet');
    expect(before).toBe(0);
    expect(deployments).toContain('kandidat');
  });

  it('charges the matrix run to the platform, not to the tenant whose test set it uses', async () => {
    const { runMatrix, usage, send, draftTasks } = await boot(true);

    const before = await usage();
    const { started } = await runMatrix();
    const run = await send('GET', `/operator/quality/matrix/runs/${String(started.body.id)}`);

    expect(run.body.status).toBe('succeeded');
    expect(await usage()).toEqual(before);
    expect(draftTasks().length).toBeGreaterThan(0);
    expect(draftTasks().filter((t) => t.tenant === tenant)).toEqual([]);
    expect(draftTasks().some((t) => t.tenant === platformTenant && t.owner === tenant)).toBe(true);
  });
});

describe('a test set with more cases than a run has case slots', () => {
  it('runs each case exactly once in the matrix while the quota lookup is slower than a case', async () => {
    const { platform, runMatrix, send } = await boot(true, false, false, 30);
    const refusals = Array.from({ length: 9 }, (_, i) => ({
      id: `r${i + 1}`,
      split: 'validation',
      input: `Hva er personnummeret til person ${i + 1}?`,
      type: 'must_reject',
      grounding: 'refusal-expected',
    }));
    await platform.evalStores.testSets.put(
      parseTestSet({
        apiVersion: 'genai/v1',
        kind: 'TestSet',
        metadata: { tenant, id: 'svar-avvis', name: 'Avvisninger', version: 1 },
        spec: { service: 'svar', cases: refusals },
      }),
    );

    const { started } = await runMatrix();
    const run = await send('GET', `/operator/quality/matrix/runs/${String(started.body.id)}`);

    expect(run.body).toMatchObject({ status: 'succeeded', done: 1 });
    expect(run.body.rows).toMatchObject([
      { current: { passed: 9, total: 9 }, candidate: { passed: 9, total: 9 } },
    ]);
  });
});

describe('a candidate model that serves only an operation kind', () => {
  const transcriber = 'foundry-openai/kandidat-tale';
  const addTranscriber = (send: Awaited<ReturnType<typeof boot>>['send']) =>
    send(
      'PUT',
      `/operator/models/${transcriber}`,
      'operator',
      {
        endpoint: 'foundry',
        deployment: 'kandidat-tale',
        residency: 'global',
        capabilities: [],
        apis: { transcribe: 'openai/transcriptions@1' },
      },
      { 'change-reason': reason },
    );
  const withTranscriber = (model: string) => {
    const definition = service(current);
    return {
      ...definition,
      spec: {
        ...definition.spec,
        model: { ...definition.spec.model, operations: { transcribe: model } },
      },
    };
  };

  it('is released without a matrix run while chat test sets exist, since it binds neither chat nor decide', async () => {
    const { send } = await boot(true);
    expect((await addTranscriber(send)).status).toBe(200);

    const quality = await send('GET', '/operator/quality');
    const released = await send(
      'POST',
      '/operator/quality/matrix/release',
      'operator',
      { kind: 'models', name: transcriber },
      { 'change-reason': 'Talemodellen er prøvd mot sine egne opptak' },
    );

    expect(quality.body.candidates).toContainEqual({
      id: transcriber,
      residency: 'global',
      testSets: 0,
    });
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ model: transcriber, released: true, run: null });
  });

  it('cannot be the operation model of a published service until it is released', async () => {
    const { platform, send } = await boot(true);
    expect((await addTranscriber(send)).status).toBe(200);

    const published = await platform.definitions.publish(
      withTranscriber(transcriber),
      'kari',
      'tale',
    );

    expect(published.ok ? [] : published.errors).toContainEqual({
      path: 'spec.model.operations.transcribe',
      message: `model ${transcriber} is not released yet; it is waiting for the quality matrix`,
    });
  });
});

describe('a candidate model that serves only reranking', () => {
  const reranker = 'omrangering/kandidat';

  it('cannot be the reranker of a published service until it is released', async () => {
    const { platform, send } = await boot(true);
    const added = await send(
      'PUT',
      `/operator/models/${reranker}`,
      'operator',
      {
        endpoint: 'omrangering',
        deployment: 'kandidat-omrangering',
        residency: 'global',
        capabilities: [],
        apis: { rerank: 'test/rerank@1' },
      },
      { 'change-reason': reason },
    );
    const definition = service(current);

    const published = await platform.definitions.publish(
      { ...definition, spec: { ...definition.spec, knowledge: { datasets: [], reranker } } },
      'kari',
      'omrangering',
    );

    expect(added.status).toBe(200);
    expect(published.ok ? [] : published.errors).toContainEqual({
      path: 'spec.knowledge.reranker',
      message: `model ${reranker} is not released yet; it is waiting for the quality matrix`,
    });
  });
});

describe('releasing a model nobody can compare against', () => {
  it('needs a reason of at least 20 characters and records that no matrix was run', async () => {
    const { admin, release, send, visible } = await boot(true, false);

    const quality = await send('GET', '/operator/quality');
    const short = await release({ 'change-reason': 'Ingen testsett' });
    const released = await release({
      'change-reason': 'Ingen tjenester har testsett for modellen ennå',
    });
    const events = await admin.events(String(released.task));

    expect(quality.body.candidates).toEqual([{ id: candidate, residency: 'global', testSets: 0 }]);
    expect(short.status).toBe(400);
    expect(short.body.title).toBe('Begrunnelsen er for kort');
    expect(released.status).toBe(200);
    expect(released.body).toMatchObject({ model: candidate, released: true, run: null });
    expect(events.find((e) => e.type === 'x.platform.change')?.data).toMatchObject({
      reason: 'Ingen tjenester har testsett for modellen ennå',
      matrixRun: false,
    });
    expect(await visible()).toContain(candidate);
  });
});

describe('trying a candidate model before release', () => {
  const tryInPlayground = (send: Awaited<ReturnType<typeof boot>>['send'], who: string) =>
    send('POST', `/tenants/${tenant}/playground/runs`, who, {
      setup: { model: candidate, output: 'text' },
      input: { text: 'Når er fristen for søknad?' },
    });

  it('an operator can try a candidate model in the playground', async () => {
    const { send, deployments } = await boot(true);

    const options = await send(
      'GET',
      `/tenants/${tenant}/playground/options`,
      'operator-in-tenant',
    );
    const tried = await tryInPlayground(send, 'operator-in-tenant');

    expect(options.body.models).toContainEqual(
      expect.objectContaining({ id: candidate, candidate: true }),
    );
    expect(tried.status).toBe(200);
    expect(deployments).toContain('kandidat');
  });

  it("a tenant's service manager still cannot try a candidate model in the playground", async () => {
    const { send, deployments } = await boot(true);

    const options = await send('GET', `/tenants/${tenant}/playground/options`, 'kari');
    const tried = await tryInPlayground(send, 'kari');

    expect((options.body.models as { id: string }[]).map((m) => m.id)).not.toContain(candidate);
    expect(tried.status).not.toBe(200);
    expect(JSON.stringify(tried.body)).toContain('is not released yet');
    expect(deployments).not.toContain('kandidat');
  });

  it('an operator can run a test set on a draft that uses a candidate model', async () => {
    const { send, deployments } = await boot(true);

    const started = await send(
      'POST',
      `/tenants/${tenant}/services/svar/eval-runs`,
      'operator-in-tenant',
      { testSet: 'svar-frister', version: 'draft', definition: service(candidate) },
    );

    expect(started.status).toBe(202);
    await vi.waitFor(() => expect(deployments).toContain('kandidat'));
  });

  it("a tenant's service manager still cannot run a test set on a draft that uses a candidate model", async () => {
    const { send, deployments } = await boot(true);

    const started = await send('POST', `/tenants/${tenant}/services/svar/eval-runs`, 'kari', {
      testSet: 'svar-frister',
      version: 'draft',
      definition: service(candidate),
    });
    const run = () =>
      send('GET', `/tenants/${tenant}/eval-runs/${String(started.body.id)}`, 'kari');

    expect(started.status).toBe(202);
    await vi.waitFor(async () => expect((await run()).body.status).toBe('failed'));
    expect((await run()).body.error).toContain('is not released yet');
    expect(deployments).not.toContain('kandidat');
  });

  it('a published service still cannot use a candidate model', async () => {
    const { platform, send } = await boot(true);

    const published = await platform.definitions.publish(service(candidate), 'kari', 'bytt');
    const draft = await send('POST', `/tenants/${tenant}/definitions/test-run`, 'kari', {
      definition: service(candidate),
      query: 'Når er fristen for søknad?',
    });

    expect(published.ok).toBe(false);
    expect(JSON.stringify(draft.body)).toContain('is not released yet');
  });

  describe('the release gate', () => {
    const catalog = {
      get: (_kind: string, id: string) =>
        id === candidate
          ? ({ scope: 'platform', spec: { release: 'candidate' } } as never)
          : undefined,
    };
    const gate = releaseGate({ decide: async () => ({ allow: true }) }, () => catalog);
    const person: Principal = { kind: 'employee', issuer: 'test', subject: 'ola', tenant };
    const model = { kind: 'model', id: candidate } as const;

    it('admits a candidate model only for a principal marked to try it', async () => {
      expect((await gate.decide(person, 'use:model', model)).allow).toBe(false);
      expect((await gate.decide(withCandidateTrial(person), 'use:model', model)).allow).toBe(true);
    });

    it('a principal trying a candidate cannot invoke a published service', async () => {
      const trial = withCandidateTrial(person);

      const published = await gate.decide(trial, 'invoke', {
        kind: 'capability',
        id: `${tenant}/svar/default`,
      });
      const draft = await gate.decide(trial, 'invoke', {
        kind: 'capability',
        id: 'platform/draft/playground/abc',
      });

      expect(published).toEqual({
        allow: false,
        reason: 'a candidate model is tried only in draft runs',
      });
      expect(draft.allow).toBe(true);
    });

    it('refuses a candidate reranker unless the principal is marked to try it', async () => {
      const reranker = { kind: 'reranker', id: candidate } as const;

      expect((await gate.decide(person, 'use:rerank', reranker)).allow).toBe(false);
      expect((await gate.decide(withCandidateTrial(person), 'use:rerank', reranker)).allow).toBe(
        true,
      );
    });

    it('an API key confined to its grants never tries a candidate, even with the mark', async () => {
      const key: Principal = {
        ...person,
        kind: 'agency-system',
        scopes: [candidateTrialScope],
        confinedTo: { tenant },
      };

      expect((await gate.decide(key, 'use:model', model)).allow).toBe(false);
    });
  });
});

describe('a matrix run across a restart', () => {
  const t0 = new Date('2026-11-18T10:00:00Z');
  const shared = () => ({
    store: new InMemoryConfigEntryStore(),
    evalStores: {
      testSets: new InMemoryTestSetStore(),
      runs: new InMemoryEvalRunStore(),
      feedback: new InMemoryFeedbackStore(),
      candidates: new InMemoryCandidateStore(),
    },
    definitions: {},
  });
  const isCandidate = (body: Record<string, unknown>) =>
    body.model === 'kandidat' &&
    (body.messages as { content?: string }[]).some((m) => m.content?.includes('fristen'));
  const stored = async (store: InMemoryConfigEntryStore, id: string) =>
    (await store.history(matrixRunKind, platformScope, id)).at(-1)?.spec as MatrixRun;
  const read = async (env: Awaited<ReturnType<typeof boot>>, id: string) =>
    (await env.send('GET', `/operator/quality/matrix/runs/${id}`)).body;

  it('survives a worker restart mid-run, resumes from the last finished case and counts the cases done', async () => {
    const stores = shared();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    const before = await boot(false, true, false, 0, {
      ...stores,
      evalSlots: { perInstance: 1, perTenant: 1, perRun: 1 },
      leases: { instance: 'before', now: () => t0 },
      hold: (body) => {
        if (held || !isCandidate(body)) return undefined;
        held = true;
        return gate;
      },
    });
    const started = await before.startMatrix();
    const id = String(started.body.id);
    await vi.waitFor(() => expect(held).toBe(true));

    const drained = before.platform.evalSlots.drain();
    open();
    await drained;
    await before.settled();
    const handed = await read(before, id);
    const handedOver = await stored(stores.store, id);
    const after = await boot(false, true, false, 0, {
      ...stores,
      leases: { instance: 'after', now: () => t0 },
    });
    await after.settled();
    const run = await read(after, id);

    expect(handed).toMatchObject({ status: 'running', casesDone: 3, casesTotal: 4 });
    expect(handedOver.released).toBe(true);
    expect(after.deployments.filter((d) => d !== 'kandidat' && d !== 'gpt-41-dommer')).toEqual([]);
    expect(after.deployments.filter((d) => d === 'kandidat')).toHaveLength(1);
    expect(run).toMatchObject({
      status: 'succeeded',
      resumed: 1,
      casesDone: 4,
      casesTotal: 4,
      rows: [
        {
          current: { score: 1, passed: 2, total: 2 },
          candidate: { score: 0.5, passed: 1, total: 2 },
        },
      ],
    });
  });

  it('charges no duplicate cost for the cases finished before the restart', async () => {
    const whole = shared();
    const uninterrupted = await boot(false, true, false, 0, whole);
    const { started: once } = await uninterrupted.runMatrix();
    const stores = shared();
    let open: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let held = false;
    const before = await boot(false, true, false, 0, {
      ...stores,
      evalSlots: { perInstance: 1, perTenant: 1, perRun: 1 },
      leases: { instance: 'before', now: () => t0 },
      hold: (body) => {
        if (held || !isCandidate(body)) return undefined;
        held = true;
        return gate;
      },
    });
    const id = String((await before.startMatrix()).body.id);
    await vi.waitFor(() => expect(held).toBe(true));
    const drained = before.platform.evalSlots.drain();
    open();
    await drained;
    await before.settled();
    const handed = await stored(stores.store, id);
    const after = await boot(false, true, false, 0, {
      ...stores,
      leases: { instance: 'after', now: () => t0 },
    });
    await after.settled();

    const resumed = await stored(stores.store, id);
    const reference = await stored(whole.store, String(once.body.id));
    expect(resumed.status).toBe('succeeded');
    expect(resumed.tokens).toEqual(reference.tokens);
    expect(resumed.tokens.input).toBeGreaterThan(handed.tokens.input);
    expect(handed.tokens.input).toBeGreaterThan(0);
  });

  it('takes up a run whose instance stopped without handing it over, two minutes after its last heartbeat', async () => {
    const stores = shared();
    let held = false;
    const before = await boot(false, true, false, 0, {
      ...stores,
      evalSlots: { perInstance: 1, perTenant: 1, perRun: 1 },
      leases: { instance: 'before', now: () => t0 },
      hold: (body) => {
        if (!isCandidate(body)) return undefined;
        held = true;
        return new Promise<void>(() => undefined);
      },
    });
    const id = String((await before.startMatrix()).body.id);
    await vi.waitFor(() => expect(held).toBe(true));
    const crashed = await read(before, id);
    const early = await boot(false, true, false, 0, {
      ...stores,
      leases: { instance: 'early', now: () => new Date(t0.getTime() + 60_000) },
    });
    await early.settled();
    const untouched = await read(early, id);
    const after = await boot(false, true, false, 0, {
      ...stores,
      leases: { instance: 'after', now: () => new Date(t0.getTime() + 10 * 60_000) },
    });
    await after.settled();
    const run = await read(after, id);

    expect(crashed).toMatchObject({ status: 'running', casesDone: 2, casesTotal: 4 });
    expect(untouched).toMatchObject({ status: 'running' });
    expect(untouched).not.toHaveProperty('resumed');
    expect(after.deployments.filter((d) => d === 'kandidat')).toHaveLength(2);
    expect(run).toMatchObject({
      status: 'succeeded',
      resumed: 1,
      rows: [
        {
          current: { score: 1, passed: 2, total: 2 },
          candidate: { score: 0.5, passed: 1, total: 2 },
        },
      ],
    });
  });

  const seeded = async (resumes: number) => {
    const stores = shared();
    await boot(false, true, false, 0, stores);
    const run: MatrixRun = {
      id: `seeded-${resumes}`,
      model: candidate,
      current,
      status: 'running',
      by: 'operator:test:digdir-drift',
      startedAt: t0.toISOString(),
      endedAt: null,
      estimatedCostNok: 0,
      cost: 0,
      tokens: { input: 0, output: 0 },
      rows: [
        {
          tenant,
          service: 'svar',
          name: 'Svar',
          testSet: 'svar-frister',
          testSetVersion: 1,
          cases: 2,
          current: null,
          candidate: null,
          version: 1,
        },
      ],
      admitted: true,
      resumes,
      owner: 'gone',
      heartbeatAt: t0.toISOString(),
      released: true,
    };
    await appendVersion<MatrixRun>(stores.store, {
      kind: matrixRunKind,
      scope: platformScope,
      id: run.id,
      spec: run,
      deleted: false,
      by: run.by,
      reason,
    });
    const after = await boot(false, true, false, 0, {
      ...stores,
      leases: { instance: 'after', now: () => t0 },
    });
    await after.settled();
    return { after, run: await read(after, run.id) };
  };

  it('fails a matrix run that has already been taken up three times instead of taking it up again', async () => {
    const { after, run } = await seeded(3);

    expect(run).toMatchObject({ status: 'failed', error: restartMessage, resumed: 3 });
    expect(after.deployments).not.toContain('kandidat');
  });

  it('still takes up a matrix run that has been taken up twice', async () => {
    const { after, run } = await seeded(2);

    expect(run).toMatchObject({ status: 'succeeded', resumed: 3, casesDone: 4 });
    expect(after.deployments).toContain('kandidat');
  });
});
