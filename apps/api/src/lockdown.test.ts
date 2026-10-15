import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { apiKeyDigest, createAuthenticator } from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { InMemoryExecutionStore, InMemoryIngestionBackend, IngestionService } from './ingestion.js';
import {
  configuredCredentialScope,
  lockedEnvironmentType,
  mayUseModels,
  withCredentialOrigin,
} from './lockdown.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { digdir, files, principals, testService } from './testkit.js';

const configuredKey = 'gp_from-configuration';
const configuredIngestKey = 'gp_ingest-from-configuration';
const reason = 'Endring i testen';

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const boot = async (lockdown: boolean) => {
  const model = await fakeHttp((body) => ({
    status: 200,
    json: Array.isArray(body.input)
      ? {
          object: 'list',
          data: body.input.map((_, index) => ({
            object: 'embedding',
            index,
            embedding: [0.1, 0.2, 0.3, 0.4],
          })),
          usage: { prompt_tokens: 1, total_tokens: 1 },
        }
      : {
          id: 'c1',
          object: 'chat.completion',
          created: 0,
          model: 'gpt',
          choices: [
            { index: 0, message: { role: 'assistant', content: 'Hei.' }, finish_reason: 'stop' },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        },
  }));
  fakes.push(model);
  const keys = new InMemoryTenantApiKeys();
  await keys.add({
    id: 'ka-backend',
    name: 'KA backend',
    digest: apiKeyDigest(configuredKey),
    tenant: digdir,
    scopes: ['query'],
    datasets: [],
    agents: [],
    service: 'klarsprak',
  });
  await keys.add({
    id: 'ingest-backend',
    name: 'Innlesing',
    digest: apiKeyDigest(configuredIngestKey),
    tenant: digdir,
    scopes: ['ingest'],
    datasets: ['*'],
    agents: [],
  });
  const ingestion = new InMemoryIngestionBackend(() => [{ key: 'a', text: 'Digdir har ansvar.' }]);
  const authenticator = createAuthenticator({ apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: `${model.url}/v1`,
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [{ id: 'fake/gpt', endpoint: 'fake', deployment: 'gpt', residency: 'norway' }],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
      embeddings: {
        endpoints: {
          fake: {
            protocol: 'openai-embeddings',
            baseURL: `${model.url}/v1`,
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [
          {
            id: 'fake/embed',
            endpoint: 'fake',
            deployment: 'embed',
            residency: 'norway',
            dimensions: 4,
          },
        ],
      },
    },
    configurables: { scheduleIntervalMs: 0, ingestion },
    settings,
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    apiKeys: keys,
    ...(lockdown
      ? {
          lockdown: {
            configuredKeys: new Set([
              apiKeyDigest(configuredKey),
              apiKeyDigest(configuredIngestKey),
            ]),
          },
        }
      : {}),
    authenticate: async (request) => {
      const person = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      if (person) return { principal: person };
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  await platform.definitions.publish(testService('klarsprak'), 'test', 'test', files);
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
    models: platform.models,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      auth: { authenticate: (request) => platform.caller(request) },
      tenantGate: platform.tenantGate,
      caller: platform.caller,
      lockdown,
    },
  });
  platform.mount(app, admin);
  const send = (
    path: string,
    as: string,
    init: { method?: string; body?: unknown; reason?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(principals[as] ? { authorization: `Bearer ${as}` } : { 'x-api-key': as }),
        'content-type': 'application/json',
        ...(init.reason ? { 'change-reason': init.reason } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const chat = (as: string) =>
    send('/v1/chat/completions', as, {
      body: { model: 'klarsprak__default', messages: [{ role: 'user', content: 'hei' }] },
    });
  const dataset = async () => {
    await send(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'kari', {
      method: 'PUT',
      body: {
        engine: 'typesense',
        baseURL: 'https://sok.testetaten.example.no',
        auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/search-token` },
      },
      reason,
    });
    const created = await send(`/tenants/${digdir}/datasets`, 'kari', {
      body: {
        id: 'sider',
        name: 'Nettsider',
        residency: 'norway',
        index: { endpoint: 'sok', collections: { docs: 'sider_docs', chunks: 'sider_chunks' } },
      },
      reason,
    });
    expect(created.status).toBe(201);
    const pipeline = await send(`/tenants/${digdir}/datasets/sider/pipelines`, 'kari', {
      body: {
        id: 'nettsider',
        name: 'Nettsidene',
        source: { kind: 'website', sitemap: 'https://www.digdir.no/sitemap.xml' },
        chunking: { minimumLength: 1 },
        schedule: 'daily',
      },
      reason,
    });
    expect(pipeline.status).toBe(201);
  };
  const execute = (as: string) =>
    send(`/tenants/${digdir}/datasets/sider/pipelines/nettsider/execute`, as, {
      body: {},
      reason,
    });
  return { app, send, chat, platform, model, ingestion, dataset, execute };
};

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

describe('lockdown', () => {
  it('lets a key from configuration run its service in lockdown', async () => {
    const { chat } = await boot(true);

    const res = await chat(configuredKey);

    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('Hei.');
  });

  it('refuses a key created through the API from running a service in lockdown', async () => {
    const { send, chat, model } = await boot(true);
    const created = await send(`/tenants/${digdir}/services/klarsprak/api-keys`, 'kari', {
      body: { name: 'Egen nøkkel' },
      reason,
    });
    expect(created.status).toBe(201);
    const { key } = await json<{ key: string }>(created);

    const res = await chat(key);

    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ type: lockedEnvironmentType });
    expect(model.seen).toHaveLength(0);
  });

  it.each(['kari', 'operator'])(
    'refuses a person who runs a service in lockdown, even an operator (%s)',
    async (who) => {
      const { chat, model } = await boot(true);

      const res = await chat(who);

      expect(res.status).toBe(403);
      expect(res.headers.get('content-type')).toContain('application/problem+json');
      expect(await json(res)).toMatchObject({
        type: lockedEnvironmentType,
        title: expect.stringContaining('låst'),
      });
      expect(model.seen).toHaveLength(0);
    },
  );

  it('refuses a person at the model port even where no route is listed', async () => {
    const { platform } = await boot(true);
    const context = (principal: Principal) => ({
      tenant: digdir,
      principal,
      task: 't',
      signal: AbortSignal.timeout(1000),
      meter: async () => undefined,
    });
    const person: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir };
    const configured: Principal = {
      kind: 'agency-system',
      issuer: 'test',
      subject: 'ka',
      scopes: [configuredCredentialScope],
    };

    expect(() => platform.models.open({ kind: 'model', id: 'fake/gpt' }, context(person))).toThrow(
      /may not use models/,
    );
    expect(() =>
      platform.models.open({ kind: 'model', id: 'fake/gpt' }, context(configured)),
    ).not.toThrow();
  });

  it('refuses a person who runs a pipeline in lockdown', async () => {
    const { dataset, execute, ingestion } = await boot(true);
    await dataset();

    const res = await execute('kari');

    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({
      type: lockedEnvironmentType,
      title: expect.stringContaining('innlesing'),
    });
    expect(ingestion.jobs).toHaveLength(0);
  });

  it('refuses an operator who runs a pipeline in lockdown', async () => {
    const { dataset, send, ingestion } = await boot(true);
    await dataset();

    const res = await send(
      `/operator/datasets/${encodeURIComponent(`${digdir}/sider`)}/pipelines/nettsider/execute`,
      'operator',
      { body: {}, reason },
    );

    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ type: lockedEnvironmentType });
    expect(ingestion.jobs).toHaveLength(0);
  });

  it('lets a configured key run a pipeline in lockdown', async () => {
    const { dataset, execute, ingestion } = await boot(true);
    await dataset();

    const res = await execute(configuredIngestKey);

    expect(res.status).toBe(202);
    expect(ingestion.jobs).toHaveLength(1);
  });

  it('lets people run a pipeline when lockdown is off', async () => {
    const { dataset, execute, ingestion } = await boot(false);
    await dataset();

    expect((await execute('kari')).status).toBe(202);
    expect(ingestion.jobs).toHaveLength(1);
  });

  it('refuses ingestion in lockdown that no configured key started, wherever it starts', async () => {
    const { dataset, platform, ingestion } = await boot(true);
    await dataset();
    const pipeline = await platform.ingestion.get(digdir, `${digdir}/sider`, 'nettsider');
    if (!pipeline) throw new Error('no pipeline');
    const target = { dataset: `${digdir}/sider`, endpoint: `${digdir}/sok`, collections: {} };

    const started = await platform.ingestion.execute({ pipeline, target, by: 'kari' });

    expect(started).toMatchObject({ ok: false, errors: [{ path: 'principal' }] });
    expect(ingestion.jobs).toHaveLength(0);
  });

  it.each([
    `/tenants/${digdir}/datasets/sider/engine-switches`,
    `/tenants/${digdir}/datasets/sider/engine-switches/1/retry`,
    `/operator/datasets/sider/engine-switches`,
    `/tenants/${digdir}/datasets/sider/enrichment/hypothetical-questions/apply`,
    `/tenants/${digdir}/connectors/kobling/sync`,
  ])('refuses new embeddings for a person in lockdown (%s)', async (path) => {
    const { send, model } = await boot(true);

    const res = await send(path, path.startsWith('/operator') ? 'operator' : 'kari', {
      body: { method: 'copy', to: 'sok' },
      reason,
    });

    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ type: lockedEnvironmentType });
    expect(model.seen).toHaveLength(0);
  });

  it('still searches existing data in lockdown', async () => {
    const { platform } = await boot(true);
    const person: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir };

    const query = await platform.embedders
      .open(
        { kind: 'embedder', id: 'fake/embed' },
        {
          tenant: digdir,
          principal: person,
          task: 'search',
          signal: AbortSignal.timeout(1000),
          meter: async () => undefined,
        },
      )
      .embed(['Hvem har ansvar?']);

    expect(query.vectors).toHaveLength(1);
  });

  it('skips scheduled ingestion in lockdown and logs why', async () => {
    const clock = { now: new Date('2026-10-07T10:00:00Z') };
    const backend = new InMemoryIngestionBackend(() => [{ key: 'a', text: 'Digdir har ansvar.' }]);
    const logged: string[] = [];
    const service = new IngestionService({
      store: new InMemoryConfigEntryStore(),
      executions: new InMemoryExecutionStore(),
      backend,
      now: () => clock.now,
      admits: mayUseModels,
      onRefused: (message) => logged.push(message),
    });
    await service.save({
      scope: digdir,
      dataset: `${digdir}/sider`,
      id: 'nettsider',
      spec: {
        name: 'Nettsidene',
        source: { kind: 'website', sitemap: 'https://www.digdir.no/sitemap.xml' },
        chunking: { minimumLength: 1 },
        schedule: 'daily',
      },
      by: 'kari',
      reason,
    });
    clock.now = new Date('2026-10-08T01:00:30Z');

    const fired = await service.runDue(
      () => ({ dataset: `${digdir}/sider`, endpoint: `${digdir}/sok`, collections: {} }),
      'platform',
    );

    expect(backend.jobs).toHaveLength(0);
    expect(fired).toMatchObject([{ status: 'failed', error: expect.stringContaining('locked') }]);
    expect(logged).toEqual([expect.stringContaining('platform:ingestion-schedule')]);
  });

  it('does not trust a configured-credential scope the caller brings itself', () => {
    const principal = withCredentialOrigin(
      { configuredKeys: new Set([apiKeyDigest(configuredKey)]) },
      new Request('http://x', { headers: { 'x-api-key': 'gp_somebody-else' } }),
      { kind: 'agency-system', issuer: 'test', subject: 'x', scopes: [configuredCredentialScope] },
    );

    expect(principal.scopes).toEqual([]);
  });

  it('allows reading and configuration changes in lockdown', async () => {
    const { send } = await boot(true);

    const read = await send(`/tenants/${digdir}/definitions`, 'kari');
    const created = await send(`/tenants/${digdir}/services/klarsprak/api-keys`, 'kari', {
      body: { name: 'Ny nøkkel' },
      reason,
    });

    expect(read.status).toBe(200);
    expect(created.status).toBe(201);
  });

  it('lets people run services when lockdown is off', async () => {
    const { chat } = await boot(false);

    expect((await chat('kari')).status).toBe(200);
  });

  it('tells the apps on /health whether the environment is locked', async () => {
    expect(await json(await (await boot(true)).app.request('/health'))).toMatchObject({
      lockdown: true,
    });
    expect(await json(await (await boot(false)).app.request('/health'))).toMatchObject({
      lockdown: false,
    });
  });
});
