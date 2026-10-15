import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { apiKeyDigest, createAuthenticator, PLATFORM_RIGHTS } from '@genai/identity';
import { UnsecuredJWT } from 'jose';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { InMemoryExecutionStore, InMemoryIngestionBackend, IngestionService } from './ingestion.js';
import {
  configuredCredentialScope,
  entraNotTrustedType,
  lockedEnvironmentType,
  mayUseModels,
  trustedEntraScope,
  withCredentialOrigin,
} from './lockdown.js';
import { operatorDirectory } from './operators.js';
import {
  maskinportenClientRegistry,
  admitMaskinportenClients,
  maskinportenClientsModule,
} from './maskinporten-clients.js';
import type { ModuleDeps } from './platform-modules.js';
import { InMemoryTenantApiKeys, portalAdminHandlers } from './routes/portal-routes.js';
import { digdir, files, principals as testPrincipals, testService } from './testkit.js';

const principals: Record<string, Principal> = {
  ...testPrincipals,
  entra: {
    kind: 'employee',
    issuer: 'test',
    subject: 'entra-subject',
    assurance: 'entraid',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: [...PLATFORM_RIGHTS] }],
    scopes: [trustedEntraScope],
  },
};
const operators = operatorDirectory([], [testPrincipals.operator?.subject ?? '']);

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
      if (person)
        return callerFrom({ method: 'token', principal: person }, operators.isOperator(person));
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  await platform.definitions.publish(testService('klarsprak'), 'test', 'test', files);
  await platform.definitions.publish(testService('annen'), 'test', 'test', files);
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
      loginRefusal: async (request) =>
        request.headers.get('authorization')?.includes('.') ? 'entra_not_trusted' : undefined,
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
  const chat = (as: string, service = 'klarsprak') =>
    send('/v1/chat/completions', as, {
      body: { model: `${service}__default`, messages: [{ role: 'user', content: 'hei' }] },
    });
  const createKey = async (as: string) => {
    const created = await send(`/tenants/${digdir}/services/klarsprak/api-keys`, as, {
      body: { name: 'KA test' },
      reason,
    });
    return json<{ key: string; apiKey: { id: string } }>(created);
  };
  const dataset = async () => {
    await send(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'entra', {
      method: 'PUT',
      body: {
        engine: 'typesense',
        baseURL: 'https://sok.testetaten.example.no',
        auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/search-token` },
      },
      reason,
    });
    const created = await send(`/tenants/${digdir}/datasets`, 'entra', {
      body: {
        id: 'sider',
        name: 'Nettsider',
        residency: 'norway',
        index: { endpoint: 'sok', collections: { docs: 'sider_docs', chunks: 'sider_chunks' } },
      },
      reason,
    });
    expect(created.status).toBe(201);
    const pipeline = await send(`/tenants/${digdir}/datasets/sider/pipelines`, 'entra', {
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
  return { app, send, chat, createKey, keys, platform, model, ingestion, dataset, execute };
};

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

describe('lockdown', () => {
  it('lets a key from configuration run its service in lockdown', async () => {
    const { chat } = await boot(true);

    const res = await chat(configuredKey);

    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('Hei.');
  });

  it('lets a key an Entra user created run its service in lockdown', async () => {
    const { chat, createKey } = await boot(true);
    const { key } = await createKey('entra');

    const res = await chat(key);

    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain('Hei.');
  });

  it('keeps a key admitted after an Entra user rotates it', async () => {
    const { chat, createKey, send } = await boot(true);
    const { apiKey } = await createKey('entra');

    const rotated = await send(`/tenants/${digdir}/api-keys/${apiKey.id}/rotate`, 'entra', {
      body: {},
      reason,
    });
    const { key } = await json<{ key: string }>(rotated);

    expect(rotated.status).toBe(201);
    expect((await chat(key)).status).toBe(200);
  });

  it('drops the admission when a key is rotated by someone who may not use models', async () => {
    const { chat, createKey, keys, model } = await boot(true);
    const { apiKey } = await createKey('entra');
    const plaintext = 'gp_rotated-by-testid';

    const outcome = await portalAdminHandlers({ apiKeys: keys })['platform.apikeys.rotate']?.(
      {
        tenant: digdir,
        id: apiKey.id,
        newId: 'rotert',
        digest: apiKeyDigest(plaintext),
        createdAt: new Date().toISOString(),
        admittedInLockdown: true,
        reason,
      },
      testPrincipals.kari as Principal,
    );
    const res = await chat(plaintext);

    expect(outcome).toMatchObject({ ok: true });
    expect((await keys.list(digdir)).find((k) => k.id === 'rotert')).not.toHaveProperty(
      'admittedInLockdown',
    );
    expect(res.status).toBe(403);
    expect(model.seen).toHaveLength(0);
  });

  it('does not admit keys created before lockdown admission existed', async () => {
    const { chat, keys, model } = await boot(true);
    const plaintext = 'gp_from-before';
    await keys.add({
      id: 'eldre',
      name: 'Eldre nøkkel',
      digest: apiKeyDigest(plaintext),
      tenant: digdir,
      scopes: ['query'],
      datasets: [],
      agents: [],
      service: 'klarsprak',
    });

    const res = await chat(plaintext);

    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({ type: lockedEnvironmentType });
    expect(model.seen).toHaveLength(0);
  });

  it('does not let an admitted key reach the operator role or other services', async () => {
    const { chat, createKey, dataset, execute, ingestion, send } = await boot(true);
    await dataset();
    const { key } = await createKey('entra');

    const operator = await send('/operator/tenants', key);
    const other = await chat(key, 'annen');
    const ingested = await execute(key);

    expect([401, 403]).toContain(operator.status);
    expect(other.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(await other.json())).not.toContain('Hei.');
    expect([401, 403]).toContain(ingested.status);
    expect(ingestion.jobs).toHaveLength(0);
  });

  it('cannot set the admission through the request body', async () => {
    const { chat, keys } = await boot(true);
    const plaintext = 'gp_asked-for-admission';

    await portalAdminHandlers({ apiKeys: keys })['platform.apikeys.create']?.(
      {
        tenant: digdir,
        id: 'selvvalgt',
        name: 'Selvvalgt',
        service: 'klarsprak',
        digest: apiKeyDigest(plaintext),
        admittedInLockdown: true,
        reason,
      },
      testPrincipals.kari as Principal,
    );

    expect((await keys.list(digdir)).find((k) => k.id === 'selvvalgt')).not.toHaveProperty(
      'admittedInLockdown',
    );
    expect((await chat(plaintext)).status).toBe(403);
  });

  it('admits a Maskinporten client an Entra user registered, and not one from anyone else', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    const { handlers } = maskinportenClientsModule({ configEntries } as unknown as ModuleDeps);
    const save = handlers?.['platform.maskinporten-client.save'];
    await save?.(
      { tenant: digdir, clientId: 'fra-entra', name: 'KA', services: ['*'], reason },
      principals.entra as Principal,
    );
    await save?.(
      {
        tenant: digdir,
        clientId: 'fra-testid',
        name: 'Annen',
        services: ['*'],
        admittedInLockdown: true,
        reason,
      },
      testPrincipals.kari as Principal,
    );
    const admit = admitMaskinportenClients(maskinportenClientRegistry(configEntries), ['mp']);
    const inLockdown = async (client: string) =>
      withCredentialOrigin(
        { configuredKeys: new Set() },
        new Request('http://x'),
        await admit({
          kind: 'agency-system',
          issuer: 'mp',
          subject: client,
          tenant: digdir,
          client,
        }),
      );

    expect(mayUseModels(await inLockdown('fra-entra'))).toBe(true);
    expect(mayUseModels(await inLockdown('fra-testid'))).toBe(false);
    expect(await maskinportenClientRegistry(configEntries).list(digdir)).not.toContainEqual(
      expect.objectContaining({ admittedInLockdown: true }),
    );
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

  it('keeps a TestID login read-only in lockdown', async () => {
    const { send } = await boot(true);

    const read = await send(`/tenants/${digdir}/definitions`, 'kari');
    const created = await send(`/tenants/${digdir}/services/klarsprak/api-keys`, 'kari', {
      body: { name: 'Ny nøkkel' },
      reason,
    });
    const operatorChange = await send('/operator/plugins/x', 'operator', {
      method: 'DELETE',
      reason,
    });
    const preferences = await send(`/tenants/${digdir}/me/preferences`, 'kari', {
      method: 'PUT',
      body: { language: 'en' },
      reason,
    });

    expect(read.status).toBe(200);
    expect(created.status).toBe(403);
    expect(await json(created)).toMatchObject({
      type: lockedEnvironmentType,
      title: expect.stringContaining('Entra ID'),
    });
    expect(operatorChange.status).toBe(403);
    expect(await json(operatorChange)).toMatchObject({ type: lockedEnvironmentType });
    expect(preferences.status).toBe(200);
  });

  it('lets a trusted Entra login change configuration in lockdown', async () => {
    const { send } = await boot(true);

    const created = await send(`/tenants/${digdir}/services/klarsprak/api-keys`, 'entra', {
      body: { name: 'Ny nøkkel' },
      reason,
    });

    expect(created.status).toBe(201);
  });

  it('lets TestID logins change configuration when lockdown is off', async () => {
    const { send } = await boot(false);

    const created = await send(`/tenants/${digdir}/services/klarsprak/api-keys`, 'kari', {
      body: { name: 'Ny nøkkel' },
      reason,
    });

    expect(created.status).toBe(201);
  });

  it('lets a trusted Entra login use models and run ingestion in lockdown', async () => {
    const { chat, dataset, execute, ingestion, model } = await boot(true);
    await dataset();

    const ran = await chat('entra');
    const ingested = await execute('entra');

    expect(ran.status).toBe(200);
    expect(model.seen.length).toBeGreaterThan(0);
    expect(ingested.status).toBe(202);
    expect(ingestion.jobs).toMatchObject([{ admitted: true }]);
  });

  it('makes the console treat a trusted Entra login as operator', async () => {
    const { send } = await boot(true);

    expect((await send('/operator/tenants', 'entra')).status).toBe(200);
    expect((await send('/operator/tenants', 'kari')).status).toBe(403);
  });

  it('answers /me with the organisations and rights of a trusted Entra login', async () => {
    const { send } = await boot(true);

    const res = await send('/me', 'entra');

    expect(res.status).toBe(200);
    expect(await json(res)).toEqual({
      organisations: [
        { orgNumber: digdir, name: expect.any(String), rights: [...PLATFORM_RIGHTS] },
      ],
    });
  });

  it('refuses an Entra login outside the configured groups with a clear problem', async () => {
    const { app } = await boot(true);
    const token = new UnsecuredJWT({ acr: 'entraid', sub: 'outsider' }).encode();

    const res = await app.request(`/tenants/${digdir}/definitions`, {
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.status).toBe(403);
    expect(await json(res)).toMatchObject({
      type: entraNotTrustedType,
      title: expect.stringContaining('Entra ID'),
    });
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
