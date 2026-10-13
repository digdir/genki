import { describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';

const tenant = '991825827';

const drift: Principal = { kind: 'operator', issuer: 'test', subject: 'drift' };

const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
  drift,
  ingrid: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ingrid',
    authorizedFor: [
      { org: '405003309', actions: ['use-services'] },
      { org: tenant, actions: ['use-services', 'manage-datasets'] },
    ],
  },
};

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
      knowledge: {
        endpoints: {
          search: {
            engine: 'typesense',
            baseURL: 'https://search.example.no',
            auth: { kind: 'api-key', secret: 'secret://env/search-key' },
          },
        },
        datasets: [
          {
            id: 'digdir/kudos',
            endpoint: 'search',
            residency: 'norway',
            options: {
              collections: { docs: 'kudos_docs', chunks: 'kudos_chunks' },
              profiles: {
                content: { collection: 'chunks', queryBy: ['content'], textField: 'content' },
              },
            },
          },
        ],
      },
      rerank: { endpoints: {}, rerankers: [] },
    },
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k', SEARCH_KEY: 's' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
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
  const call = (
    path: string,
    init: {
      method?: string;
      body?: unknown;
      ifMatch?: number;
      as?: string;
      session?: string;
    } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${init.as ?? 'drift'}`,
        'content-type': 'application/json',
        'change-reason': 'Hjelp fra Digdir',
        ...(init.ifMatch !== undefined ? { 'if-match': `"${init.ifMatch}"` } : {}),
        ...(init.session ? { 'support-session': init.session } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const support = async () => {
    const opened = await admin.openSupportSession(drift, tenant, 'feilsøking', 30);
    if (!opened.ok) throw new Error('no support session');
    return opened.value.id;
  };
  return { admin, call, platform, support };
};

const json = async <T>(res: Response) => (await res.json()) as T;

const endpoint = {
  engine: 'http-search',
  baseURL: 'https://sok.testetaten.example.no',
  auth: { kind: 'bearer', secret: `secret://tenant/${tenant}/search-token` },
};

const gate = { metric: 'judge.helpfulness', kind: 'threshold', threshold: 0.7 };

describe('operator access to tenant configuration', () => {
  it('hides tenant configuration from an operator without a support session', async () => {
    const { call } = await boot();
    for (const path of ['catalog', 'datasets', 'gates', 'guardrail-rules', 'knowledge/engines'])
      expect((await call(`/tenants/${tenant}/${path}`)).status).toBe(404);
    expect(
      (
        await call(`/tenants/${tenant}/catalog/knowledge-endpoint/sok`, {
          method: 'PUT',
          body: endpoint,
        })
      ).status,
    ).toBe(404);
  });

  it("lets an operator change tenant configuration in a support session, recorded as done on the tenant's behalf", async () => {
    const { admin, call, support } = await boot();
    const session = await support();

    for (const path of ['catalog', 'datasets', 'gates', 'guardrail-rules', 'knowledge/engines'])
      expect((await call(`/tenants/${tenant}/${path}`, { session })).status).toBe(200);
    const write = await call(`/tenants/${tenant}/catalog/knowledge-endpoint/sok`, {
      method: 'PUT',
      body: endpoint,
      session,
    });
    const gateWrite = await call(`/tenants/${tenant}/gates/hjelpsom`, {
      method: 'PUT',
      body: gate,
      session,
    });

    expect(write.status).toBe(200);
    expect(gateWrite.status).toBeLessThan(300);
    expect(
      (await admin.audit(tenant)).find((e) => e.action === 'platform.catalog.publish'),
    ).toMatchObject({
      tenant,
      actor: 'operator:test:drift',
      onBehalfOf: tenant,
      outcome: 'applied',
    });
  });

  it('refuses an operator change to tenant configuration without a support session', async () => {
    const { call } = await boot();
    const write = await call(`/tenants/${tenant}/catalog/knowledge-endpoint/sok`, {
      method: 'PUT',
      body: endpoint,
    });
    expect(write.status).toBe(404);
  });

  it('refuses a support session opened for another tenant', async () => {
    const { admin, call } = await boot();
    const opened = await admin.openSupportSession(drift, '889640782', 'nav', 30);
    const session = opened.ok ? opened.value.id : '';
    expect((await call(`/tenants/${tenant}/datasets`, { session })).status).toBe(404);
  });

  it('lets a person authorized for several organisations reach each of them', async () => {
    const { call } = await boot();
    expect((await call(`/tenants/${tenant}/datasets`, { as: 'ingrid' })).status).toBe(200);
    expect((await call('/tenants/889640782/datasets', { as: 'ingrid' })).status).toBe(404);
  });
});

describe('tenant changes to its catalog, gates and rules', () => {
  it('keeps platform catalog changes without an on-behalf-of tenant', async () => {
    const { admin, call } = await boot();
    const saved = await call('/operator/catalog/model-endpoint/norsk', {
      method: 'PUT',
      body: {
        protocol: 'openai-chat',
        baseURL: 'https://modeller.example.no/v1',
        auth: { kind: 'api-key', secret: 'secret://env/other-key' },
      },
    });
    expect(saved.status).toBe(200);
    const entries = await admin.audit('991825827');
    const entry = entries.find((e) => e.action === 'platform.catalog.publish');
    expect(entry?.actor).toBe('operator:test:drift');
    expect(entry?.onBehalfOf).toBeUndefined();
  });

  it('lets a tenant add, edit and remove its own gate and refuses a mandatory flag on it', async () => {
    const { admin, call } = await boot();
    expect(
      (await call(`/tenants/${tenant}/gates/hjelpsom`, { method: 'PUT', body: gate, as: 'kari' }))
        .status,
    ).toBe(200);
    const edited = await call(`/tenants/${tenant}/gates/hjelpsom`, {
      method: 'PUT',
      ifMatch: 1,
      body: { ...gate, threshold: 0.8 },
      as: 'kari',
    });
    expect(edited.status).toBe(200);
    expect(await json(edited)).toMatchObject({ version: 2, scope: tenant });
    expect(
      (
        await call(`/tenants/${tenant}/gates/hjelpsom`, {
          method: 'PUT',
          ifMatch: 1,
          body: { ...gate, threshold: 0.9 },
          as: 'kari',
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await call(`/tenants/${tenant}/gates/streng`, {
          method: 'PUT',
          body: { ...gate, mandatory: true },
          as: 'kari',
        })
      ).status,
    ).toBe(400);

    const mine = await json<{ data: { id: string; editable: boolean }[] }>(
      await call(`/tenants/${tenant}/gates`, { as: 'kari' }),
    );
    expect(mine.data.find((g) => g.id === 'hjelpsom')).toMatchObject({ editable: true });

    expect(
      (await call(`/tenants/${tenant}/gates/hjelpsom`, { method: 'DELETE', as: 'kari' })).status,
    ).toBe(200);
    const after = await json<{ data: { id: string }[] }>(
      await call(`/tenants/${tenant}/gates`, { as: 'kari' }),
    );
    expect(after.data.map((g) => g.id)).not.toContain('hjelpsom');

    const gateEntries = (await admin.audit(tenant)).filter((e) =>
      e.action.startsWith('platform.gate.'),
    );
    expect(gateEntries.map((e) => [e.action, e.outcome])).toEqual([
      ['platform.gate.save', 'applied'],
      ['platform.gate.save', 'applied'],
      ['platform.gate.save', 'rejected'],
      ['platform.gate.save', 'rejected'],
      ['platform.gate.delete', 'applied'],
    ]);
  });

  it("shows an operator in a support session the shared platform entries and the tenant's own entries", async () => {
    const { call, support } = await boot();
    await call(`/tenants/${tenant}/catalog/knowledge-endpoint/sok`, {
      method: 'PUT',
      body: endpoint,
      as: 'kari',
    });
    await call(`/tenants/${tenant}/guardrail-rules/saksnummer`, {
      method: 'PUT',
      body: { kind: 'regex', pattern: 'sak \\d+' },
      as: 'kari',
    });
    const session = await support();

    const catalog = await json<{ data: { id: string; scope: string }[]; tenantKinds: string[] }>(
      await call(`/tenants/${tenant}/catalog?kind=knowledge-endpoint`, { session }),
    );
    expect(catalog.data.map((e) => [e.id, e.scope])).toEqual(
      expect.arrayContaining([[`${tenant}/sok`, tenant]]),
    );
    expect(catalog.tenantKinds).toEqual(expect.arrayContaining(['knowledge-endpoint', 'dataset']));
    expect(catalog.tenantKinds).not.toContain('price');

    const rules = await json<{ data: { id: string; scope: string; editable: boolean }[] }>(
      await call(`/tenants/${tenant}/guardrail-rules`, { session }),
    );
    expect(rules.data.find((r) => r.id === 'saksnummer')).toMatchObject({
      scope: tenant,
      editable: true,
    });

    const datasets = await json<{ data: { id: string; scope: string }[] }>(
      await call(`/tenants/${tenant}/catalog?kind=dataset`, { session }),
    );
    expect(datasets.data).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: 'digdir/kudos', scope: 'platform' })]),
    );
  });
});

describe('operator onboarding', () => {
  it('lets an operator onboard a tenant, which is then listed with its name as onboarding', async () => {
    const { call, platform } = await boot();
    const tenantInput = { orgNumber: '974760673', name: 'Brønnøysundregistrene' };

    const refused = await call('/operator/tenants', { body: tenantInput, as: 'kari' });
    const created = await call('/operator/tenants', { body: tenantInput });

    expect(refused.status).toBe(403);
    expect(created.status).toBe(200);
    expect(await platform.directory.list()).toContainEqual(
      expect.objectContaining({ ...tenantInput, status: 'onboarding' }),
    );
  });
});
