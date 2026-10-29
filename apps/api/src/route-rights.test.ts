import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal, Task } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { createPlatform } from './composition.js';
import {
  auth,
  digdir,
  klarsprak,
  plugins,
  principals as testkitPrincipals,
  settingDefinitions,
  setup,
} from './testkit.js';

const resource = 'urn:altinn:resource:digdir-genai-platform';

const person = (subject: string, actions: string[]): Principal => ({
  kind: 'employee',
  issuer: 'test',
  subject,
  tenant: digdir,
  authorizedFor: [{ org: digdir, resource, actions }],
});

const people: Record<string, Principal> = {
  ingrid: person('ingrid', ['read', 'use-services', 'manage-datasets', 'view-usage']),
  erik: person('erik', ['use-services']),
  per: person('per', ['use-services', 'manage-services']),
  kari: person('kari', ['use-services', 'manage-services', 'manage-datasets', 'view-usage']),
  key: { kind: 'agency-system', issuer: 'api-key', subject: 'nøkkel-1', tenant: digdir },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};
Object.assign(testkitPrincipals, people);

const refusal = (right: string) => ({
  status: 403,
  title: `Du trenger rettigheten «${right}»`,
});

const boot = async () => {
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: 'https://modell.example.no/v1',
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [{ id: 'fake/gpt', endpoint: 'fake', deployment: 'gpt', residency: 'norway' }],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = people[request.headers.get('authorization')?.slice(7) ?? ''];
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
  return (path: string, as: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': 'Endring i testen',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
};

const searchEndpoint = {
  engine: 'http-search',
  baseURL: 'https://sok.testetaten.example.no',
  auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/search-token` },
};

const dataset = {
  id: 'interne-sider',
  name: 'Interne sider',
  residency: 'norway',
  collection: { endpoint: 'sok', options: { index: 'intranett' } },
};

describe('platform rights on the tenant routes', () => {
  it('refuses a dataset admin without manage-services to publish a service or change settings', async () => {
    const { publish, send } = setup();

    const published = await publish('ingrid', klarsprak());
    expect(published.status).toBe(403);
    expect(await published.json()).toMatchObject({
      ...refusal('Administrere tjenester'),
      errors: [{ path: 'right', message: 'manage-services' }],
    });
    expect(
      (
        await send(`/tenants/${digdir}/settings/search.topK`, 'ingrid', {
          method: 'PUT',
          body: { value: 3 },
          reason: 'flere treff',
        })
      ).status,
    ).toBe(403);
    expect((await send(`/tenants/${digdir}/audit`, 'ingrid')).status).toBe(403);
    expect((await send(`/tenants/${digdir}/definitions`, 'ingrid')).status).toBe(200);
    expect((await publish('per', klarsprak())).status).toBe(201);
  });

  it('refuses a service admin without manage-datasets to create a dataset or run a pipeline', async () => {
    const call = await boot();

    const endpoint = await call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'per', {
      method: 'PUT',
      body: searchEndpoint,
    });
    expect(endpoint.status).toBe(403);
    expect(await endpoint.json()).toMatchObject(refusal('Administrere datasett'));
    const created = await call(`/tenants/${digdir}/datasets`, 'per', { body: dataset });
    expect(created.status).toBe(403);
    expect(
      (
        await call(`/tenants/${digdir}/datasets/interne-sider/pipelines`, 'per', {
          body: { id: 'natt' },
        })
      ).status,
    ).toBe(403);
    expect((await call(`/tenants/${digdir}/datasets`, 'per')).status).toBe(200);

    expect(
      (
        await call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'ingrid', {
          method: 'PUT',
          body: searchEndpoint,
        })
      ).status,
    ).toBe(200);
    expect((await call(`/tenants/${digdir}/datasets`, 'ingrid', { body: dataset })).status).toBe(
      201,
    );
  });

  it('refuses a dataset admin the service admin routes outside the definitions API', async () => {
    const call = await boot();

    for (const [path, init] of [
      [`/tenants/${digdir}/api-keys`, { body: { name: 'Intranett' } }],
      [`/tenants/${digdir}/api-key-policies`, { body: { name: 'Intranett' } }],
      [`/tenants/${digdir}/gates/hjelpsom`, { method: 'PUT', body: { kind: 'threshold' } }],
      [`/tenants/${digdir}/test-sets`, { body: { id: 'grunnsett' } }],
      [`/tenants/${digdir}/eval-runs`, { body: {} }],
      [`/tenants/${digdir}/tool-connections`, { body: { id: 'arkiv' } }],
      [
        `/tenants/${digdir}/secrets/arkiv-token`,
        { method: 'PUT', body: { value: 'hemmelig', allowedHosts: ['https://arkiv.example.no'] } },
      ],
      [`/tenants/${digdir}/clients/intranett`, { method: 'PUT', body: {} }],
      [`/tenants/${digdir}/definitions/test-run`, { body: { definition: {}, query: 'hei' } }],
      [`/tenants/${digdir}/definitions/input-fields`, { body: { definition: {} } }],
    ] as const) {
      const res = await call(path, 'ingrid', init);
      expect([path, res.status]).toEqual([path, 403]);
      expect(await res.json()).toMatchObject(refusal('Administrere tjenester'));
    }
  });

  it('lets a building-block registrar set a tenant secret, as the secrets action allows', async () => {
    people.bygger = person('bygger', ['use-services', 'register-building-blocks']);
    const call = await boot();
    const path = `/tenants/${digdir}/secrets/arkiv-token`;

    const saved = await call(path, 'bygger', {
      method: 'PUT',
      body: { value: 'hemmelig', allowedHosts: ['https://arkiv.example.no'] },
    });
    const refused = await call(path, 'erik', {
      method: 'PUT',
      body: { value: 'hemmelig', allowedHosts: ['https://arkiv.example.no'] },
    });

    expect(saved.status).toBe(200);
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject(refusal('Administrere tjenester'));
  });

  it('refuses a user with only use-services to read usage', async () => {
    const call = await boot();

    const usage = await call(`/tenants/${digdir}/usage`, 'erik');
    expect(usage.status).toBe(403);
    expect(await usage.json()).toMatchObject(refusal('Se forbruk og kostnad'));
    expect((await call(`/tenants/${digdir}/usage`, 'ingrid')).status).toBe(200);
    expect((await call(`/tenants/${digdir}/tasks`, 'erik')).status).toBe(200);
  });

  it('lets the caller read their own run timeline without manage-services', async () => {
    const task = (id: string, subject: string): Task => ({
      id,
      service: {
        capability: { id: `${digdir}/klarsprak/default`, version: '1' },
        strategy: { id: 'single-call', version: '1' },
        configHash: 'h',
      },
      principal: { kind: 'employee', id: JSON.stringify(['test', subject]), tenant: digdir },
      tenant: digdir,
      owner: digdir,
      status: 'completed',
      artifacts: [],
      usage: {},
      createdAt: '2026-10-06T10:00:00Z',
      endedAt: '2026-10-06T10:00:02Z',
    });
    const tasks = [task('eriks', 'erik'), task('karis', 'kari')];
    const store = new InMemoryDefinitionStore(plugins);
    const settings = new SettingsRegistry(settingDefinitions);
    const app = createApp('test', {
      platform: {
        store,
        plugins,
        settings,
        auth,
        admin: createAdmin({ store, plugins, settings }),
        tasks: {
          task: async (id) => tasks.find((t) => t.id === id),
          events: async () => [],
        },
      },
    });
    const timeline = (id: string, who: string) =>
      app.request(`/tenants/${digdir}/tasks/${id}/timeline`, {
        headers: { authorization: `Bearer ${who}` },
      });

    expect((await timeline('eriks', 'erik')).status).toBe(200);
    const others = await timeline('karis', 'erik');
    expect(others.status).toBe(403);
    expect(await others.json()).toMatchObject(refusal('Administrere tjenester'));
    expect((await timeline('eriks', 'kari')).status).toBe(200);
  });

  it('keeps access for operators with a support session', async () => {
    const { publish, send } = setup();

    expect((await publish('drift', klarsprak())).status).toBe(403);
    const opened = await send('/support-sessions', 'drift', {
      body: { tenant: digdir, reason: 'feilsøking av sak 4711', minutes: 30 },
    });
    const { id } = (await opened.json()) as { id: string };
    expect((await publish('drift', klarsprak(), 'retting av teksten', id)).status).toBe(201);
    expect((await send(`/tenants/${digdir}/audit`, 'drift', { session: id })).status).toBe(200);
  });

  it('keeps access for an API key bound to the tenant', async () => {
    const { publish, send } = setup();
    expect((await publish('key', klarsprak())).status).toBe(201);
    expect((await send(`/tenants/${digdir}/audit`, 'key')).status).toBe(200);

    const call = await boot();
    expect((await call(`/tenants/${digdir}/usage`, 'key')).status).toBe(200);
    expect(
      (
        await call(`/tenants/${digdir}/catalog/knowledge-endpoint/sok`, 'key', {
          method: 'PUT',
          body: searchEndpoint,
        })
      ).status,
    ).toBe(200);
  });
});
