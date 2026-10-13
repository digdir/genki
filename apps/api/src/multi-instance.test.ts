import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import { textPart, type Principal } from '@genai/contracts';
import {
  InMemoryDefinitionStore,
  InMemorySettingsStore,
  SettingsRegistry,
  type DefinitionStore,
} from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import type { ModelClassification } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { InMemoryConnections } from '@genai/providers-mcp-client';
import {
  createAdmin,
  InMemoryAdminRecords,
  settingsConflictMessage,
  type AdminRecordStore,
  type AuditEntry,
  type SupportSession,
} from './admin.js';
import { createApp } from './app.js';
import { followChanges, LocalChangeFeed } from './change-feed.js';
import { createPlatform } from './composition.js';
import { appendVersion, InMemoryConfigEntryStore } from './config-store.js';
import { auth, digdir, other, plugins, principals, settingDefinitions } from './testkit.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

class CachedAdminRecords implements AdminRecordStore {
  #sessions: SupportSession[];

  constructor(private readonly shared: InMemoryAdminRecords) {
    this.#sessions = shared.sessions();
  }

  async reload() {
    this.#sessions = this.shared.sessions();
  }

  sessions() {
    return this.#sessions.map((s) => structuredClone(s));
  }

  async saveSession(session: SupportSession) {
    await this.shared.saveSession(session);
    await this.reload();
  }

  audit(tenant?: string) {
    return this.shared.audit(tenant);
  }

  appendAudit(entry: AuditEntry) {
    return this.shared.appendAudit(entry);
  }
}

const unused = { reload: async () => {}, refresh: async () => {}, sync: async () => {} };

const instance = async (shared: {
  settings: InMemorySettingsStore;
  records: InMemoryAdminRecords;
  feed: LocalChangeFeed;
}) => {
  const now = () => new Date('2026-10-06T10:00:00Z');
  const store = new InMemoryDefinitionStore(plugins, now);
  const settings = new SettingsRegistry(settingDefinitions, now);
  await settings.attach(shared.settings);
  const records = new CachedAdminRecords(shared.records);
  const admin = createAdmin({ store, plugins, settings, now, records });
  const app = createApp('test', { platform: { store, plugins, settings, auth, admin, now } });
  followChanges(shared.feed, {
    settings,
    supportSessions: records,
    catalog: unused,
    definitions: unused,
    models: unused,
    toolConnections: unused,
  });
  const send = (
    path: string,
    who: string,
    init: { method?: string; body?: unknown; session?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${who}`,
        'content-type': 'application/json',
        'change-reason': 'testendring',
        ...(init.session ? { 'support-session': init.session } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { admin, settings, send };
};

const twoInstances = async () => {
  const shared = {
    settings: new InMemorySettingsStore(),
    records: new InMemoryAdminRecords(),
    feed: new LocalChangeFeed(),
  };
  return { feed: shared.feed, a: await instance(shared), b: await instance(shared) };
};

const kari = principals.kari as Principal;

const boot = async (shared: {
  definitions: { store?: DefinitionStore };
  entries: InMemoryConfigEntryStore;
  feed: LocalChangeFeed;
  classifications: Record<string, ModelClassification>;
  connections: InMemoryConnections;
}) => {
  const model = await fakeHttp((body) =>
    body.stream
      ? {
          status: 200,
          sse: [
            { data: { id: 'c', choices: [{ index: 0, delta: { content: 'Et kort svar.' } }] } },
            { data: '[DONE]' },
          ],
        }
      : {
          status: 200,
          json: {
            id: 'c1',
            choices: [{ index: 0, message: { role: 'assistant', content: 'Et kort svar.' } }],
          },
        },
  );
  servers.push(model);
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
        models: [
          {
            id: 'fake/gpt',
            endpoint: 'fake',
            deployment: 'gpt',
            residency: 'norway',
            capabilities: ['stream'],
          },
        ],
      },
      knowledge: {
        endpoints: {
          'ts-gammel': {
            engine: 'typesense',
            baseURL: 'http://127.0.0.1:9',
            auth: { kind: 'api-key', secret: 'secret://env/ts-key' },
            sharing: { tenants: '*' },
          },
          'ts-ny': {
            engine: 'typesense',
            baseURL: 'http://127.0.0.1:10',
            auth: { kind: 'api-key', secret: 'secret://env/ts-key' },
            sharing: { tenants: '*' },
          },
        },
        datasets: [],
      },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ FAKE_KEY: 'k', TS_KEY: 't' }),
    definitions: (p) => (shared.definitions.store ??= new InMemoryDefinitionStore(p)),
    policy: { decide: async () => ({ allow: true }) },
    configurables: { store: shared.entries },
    modelClassifications: {
      load: async () => structuredClone(shared.classifications),
      save: async (id, classification) => {
        shared.classifications[id] = classification;
      },
    },
    connections: shared.connections,
    authenticate: async (request) => ({
      principal: principals[request.headers.get('authorization')?.slice(7) ?? ''] ?? kari,
    }),
  });
  const settings = new SettingsRegistry([]);
  followChanges(shared.feed, {
    settings,
    supportSessions: unused,
    catalog: platform.catalog,
    definitions: platform,
    models: platform.models,
    toolConnections: platform.toolConnections,
  });
  return platform;
};

const serve = (platform: Awaited<ReturnType<typeof boot>>) => {
  const app = new Hono();
  platform.mount(
    app,
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      extensions: platform.extensions,
    }),
  );
  return async (path: string, init: { method?: string; body?: unknown; as?: string } = {}) => {
    const response = await app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${init.as ?? 'kari'}`,
        'content-type': 'application/json',
        'change-reason': 'Godkjent etter vurdering',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
};

const twoPlatforms = async () => {
  const shared = {
    definitions: {},
    entries: new InMemoryConfigEntryStore(),
    feed: new LocalChangeFeed(),
    classifications: {},
    connections: new InMemoryConnections(),
  };
  return {
    feed: shared.feed,
    entries: shared.entries,
    connections: shared.connections,
    a: await boot(shared),
    b: await boot(shared),
  };
};

const service = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svarer kort på spørsmål',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'prompts/svar.md' } },
    model: { primary: 'fake/gpt', residency: 'global' },
    exposure: { rest: true },
  },
};

const ask = async (platform: Awaited<ReturnType<typeof boot>>, capability: string) => {
  const run = await platform.kernel.invoke(kari, capability, {
    data: { query: 'Hei' },
    parts: [textPart('Hei')],
  });
  return run.result;
};

describe('several API instances sharing durable stores', () => {
  it('answers 409 when tenant settings were changed by another instance', async () => {
    const { a, b } = await twoInstances();
    const put = (on: typeof a, value: number) =>
      on.send(`/tenants/${digdir}/settings/search.topK`, 'kari', {
        method: 'PUT',
        body: { value },
      });

    expect((await put(a, 20)).status).toBe(200);
    const stale = await put(b, 30);

    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ status: 409, detail: settingsConflictMessage });
    expect(b.settings.tenant(digdir).values).toEqual({ 'search.topK': 20 });
    expect((await put(b, 30)).status).toBe(200);
  });

  it('a settings change on one instance reaches the other after a settings change', async () => {
    const { a, b, feed } = await twoInstances();

    a.settings.setTenant(digdir, 'search.topK', 20);
    await a.settings.flush();
    await feed.emit('settings');

    expect(b.settings.tenant(digdir).values).toEqual({ 'search.topK': 20 });
  });

  it('an ended support session stops granting tenant access after a support-sessions change', async () => {
    const { a, b, feed } = await twoInstances();
    const opened = await a.send('/support-sessions', 'operator', {
      body: { tenant: other, reason: 'feilsøking av sak 4711', minutes: 30 },
    });
    const session = (await opened.json()) as { id: string };
    await feed.emit('support-sessions');
    const read = () => b.send(`/tenants/${other}/settings`, 'operator', { session: session.id });
    expect((await read()).status).toBe(200);

    await a.admin.endSupport(session.id, new Date('2026-10-06T10:05:00Z'));
    await feed.emit('support-sessions');

    expect((await read()).status).toBe(404);
  });

  it("a catalog entry published on one registry reaches the other registry's routers after a change", async () => {
    const { a, b, feed } = await twoPlatforms();
    const published = await a.catalog.publish({
      kind: 'model',
      scope: 'platform',
      id: 'fake/gpt-mini',
      spec: { endpoint: 'fake', deployment: 'gpt-mini', residency: 'norway' },
      by: 'operator:test:drift',
      reason: 'ny modell',
    });
    expect(published.ok).toBe(true);
    expect(b.models.describe().map((m) => m.id)).not.toContain('fake/gpt-mini');

    await feed.emit('config-entries');

    expect(b.models.describe().map((m) => m.id)).toContain('fake/gpt-mini');
  });

  it('a model disabled on one platform is disabled on the other after a model-classifications change', async () => {
    const { a, b, feed } = await twoPlatforms();
    await a.models.classify('fake/gpt', { enabled: false });
    expect(b.models.describe().find((m) => m.id === 'fake/gpt')?.enabled).toBe(true);

    await feed.emit('model-classifications');

    expect(b.models.describe().find((m) => m.id === 'fake/gpt')?.enabled).toBe(false);
  });

  it('a tool connection synced on one platform reaches the other after a tool-connections change', async () => {
    const { a, b, feed, connections } = await twoPlatforms();
    const published = await a.definitions.publish(service, 'test', 'første versjon', {
      'prompts/svar.md': 'Svar kort.',
    });
    expect(published.ok).toBe(true);
    await feed.emit('definitions');
    const connection = await connections.register({
      id: 'lovdata',
      tenant: digdir,
      name: 'Lovdata',
      endpoint: 'https://mcp.lovdata.example/mcp',
      version: '1.0',
      allow: [{ host: 'mcp.lovdata.example' }],
    });
    await connections.save({
      connection,
      tools: [
        {
          remoteName: 'sok',
          name: 'lovdata.sok',
          description: 'Søker i lovverket',
          input: { type: 'object' },
        },
      ],
      pending: [],
    });
    expect(b.plugins.tools.has('lovdata.sok@1.0')).toBe(false);

    await feed.emit('tool-connections');

    expect(b.plugins.tools.has('lovdata.sok@1.0')).toBe(true);
  });

  it('a service published on one platform becomes invokable on the other after a definitions change', async () => {
    const { a, b, feed } = await twoPlatforms();
    const published = await a.definitions.publish(service, 'test', 'første versjon', {
      'prompts/svar.md': 'Svar kort.',
    });
    expect(published.ok).toBe(true);
    const capability = (await a.definitions.capabilities())[0]?.capability.descriptor.id ?? '';
    await expect(ask(b, capability)).rejects.toThrow();

    await feed.emit('definitions');

    expect(await ask(b, capability)).toContainEqual(
      expect.objectContaining({ body: { kind: 'text', text: 'Et kort svar.' } }),
    );
  });

  it('an engine switch activated on one platform reaches the other after a config-entries change', async () => {
    const { a, b, feed, entries } = await twoPlatforms();
    const callA = serve(a);
    const callB = serve(b);
    const created = await callA(`/tenants/${digdir}/datasets`, {
      body: {
        id: 'kudos',
        name: 'Kudos-rapporter',
        residency: 'norway',
        index: {
          endpoint: 'ts-gammel',
          collections: { docs: 'kudos_docs', chunks: 'kudos_chunks' },
        },
      },
    });
    expect(created.status).toBe(201);
    await feed.emit('config-entries');
    const dataset = a.catalog.get('dataset', `${digdir}/kudos`);
    const at = '2026-10-07T10:00:00.000Z';
    await appendVersion(entries, {
      kind: 'engine-switch',
      scope: digdir,
      id: 'kudos:1',
      spec: {
        dataset: `${digdir}/kudos`,
        from: 'ts-gammel',
        to: 'ts-ny',
        method: 'copy',
        state: 'ready',
        estimate: { costNok: { min: 1, max: 2 }, durationMinutes: { min: 1, max: 2 } },
        progress: { percent: 100, documents: 2 },
        attempt: 1,
        generation: 'switch-1-1',
        startedAt: at,
        startedBy: 'employee:test:kari',
        updatedAt: at,
        datasetVersion: dataset?.version,
        decisions: [],
        cleanup: [],
      },
      deleted: false,
      by: 'employee:test:kari',
      reason: 'Flytter til ny søkemotor',
      at,
    });

    const activated = await callA(`/tenants/${digdir}/datasets/kudos/engine-switches/1/activate`, {
      body: { reason: 'Bedre treff i testsettet' },
    });
    expect(activated).toMatchObject({ status: 200, body: { state: 'active' } });
    expect(b.catalog.get('dataset', `${digdir}/kudos`)?.spec.endpoint).toBe('ts-gammel');

    await feed.emit('config-entries');

    expect(b.catalog.get('dataset', `${digdir}/kudos`)?.spec.endpoint).toBe('ts-ny');
    expect((await callB(`/tenants/${digdir}/datasets/kudos/engine`)).body).toMatchObject({
      endpoint: 'ts-ny',
      previous: { endpoint: 'ts-gammel' },
    });
  });

  it("a skill share approved on one platform lets the other platform's tenants copy it", async () => {
    const { a, b, feed } = await twoPlatforms();
    const callA = serve(a);
    const callB = serve(b);
    const created = await callA(`/tenants/${digdir}/skills`, {
      body: { id: 'klarsprak', definition: { metadata: { name: 'Klarspråk' } } },
    });
    expect(created.status).toBe(201);
    const published = await a.definitions.publish(
      {
        apiVersion: 'genai/v1',
        kind: 'Skill',
        metadata: { tenant: digdir, id: 'klarsprak', name: 'Klarspråk' },
        spec: { description: 'Skriv om til klarspråk.', instructions: 'Bruk korte setninger.' },
      },
      'test',
      'første versjon',
    );
    expect(published.ok).toBe(true);
    await feed.emit('definitions');
    const requested = await callA(`/tenants/${digdir}/skills/klarsprak/share`, {
      body: { confirm: true },
    });
    expect(requested.status).toBe(202);
    expect((await callB(`/tenants/${other}/skills`, { as: 'ola' })).body).toEqual({ data: [] });

    const decided = await callA(`/operator/skills/shares/${digdir}-klarsprak/decision`, {
      as: 'operator',
      body: { approve: true },
    });
    await feed.emit('config-entries');

    expect(decided.body).toMatchObject({ state: 'shared' });
    expect((await callB(`/tenants/${other}/skills`, { as: 'ola' })).body).toMatchObject({
      data: [{ id: 'klarsprak', owner: digdir, readOnly: true }],
    });
    expect(
      await callB(`/tenants/${other}/skills/klarsprak/copy`, {
        as: 'ola',
        body: { owner: digdir },
      }),
    ).toMatchObject({
      status: 201,
      body: { owner: other, draft: { copiedFrom: { owner: digdir, id: 'klarsprak', version: 1 } } },
    });
  });
});
