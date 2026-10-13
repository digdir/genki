import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { adoptionKind, blockKey } from './building-blocks.js';
import { createPlatform, platformModules } from './composition.js';
import { appendVersion } from './config-store.js';
import { serviceTemplateModule } from './service-template.js';

const tenant = '991825827';
const kari = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant,
  authorizedFor: [{ org: tenant }],
} as Principal;

const model = (id: string, capabilities: string[], residency = 'eu') => ({
  id,
  endpoint: 'fake',
  deployment: id.slice(id.indexOf('/') + 1),
  residency,
  capabilities,
});

const boot = async (
  prices: Record<string, { inputPerThousand: number; outputPerThousand: number }> = {},
) => {
  const settings = new SettingsRegistry(platformSettings);
  const platform = await createPlatform({
    settings,
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: 'https://modell.example.no/v1',
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [
          model('405003309/a-annen-virksomhet', ['stream', 'json-schema']),
          model('fake/a-uten-json', ['stream']),
          model('fake/b-norsk', ['stream', 'json-schema'], 'norway'),
          model('fake/c-eu', ['stream', 'tools', 'json-schema']),
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    prices,
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer kari' ? { principal: kari } : undefined,
    modules: [...platformModules, serviceTemplateModule],
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const request = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { platform, admin, request, settings };
};

interface Template {
  definition: {
    metadata: { tenant: string };
    spec: {
      strategy: unknown;
      tools: unknown[];
      model: { primary: string; residency: string };
      improve?: unknown;
    };
  };
}

const template = async (request: (path: string) => Response | Promise<Response>) => {
  const res = await request(`/tenants/${tenant}/definitions/template?kind=Service`);
  return { status: res.status, body: (await res.json()) as Template };
};

describe('the service draft template', () => {
  it('passes the checks /definitions/validate runs for the tenant', async () => {
    const { admin, request } = await boot();
    const { status, body } = await template(request);

    expect(status).toBe(200);
    expect(admin.check(body.definition, {})).toEqual([]);
    expect(body.definition.metadata.tenant).toBe(tenant);
    expect(body.definition.spec.strategy).toEqual({
      id: 'rag-single-shot',
      version: 1,
      config: { generate: true },
    });
    expect(body.definition.spec.tools).toEqual([]);
    expect(body.definition.spec.improve).toEqual({ allow: ['instructions'] });
  });

  it('picks the first enabled model with the capabilities the strategy needs, with its residency', async () => {
    const { request } = await boot();
    const { body } = await template(request);

    expect(body.definition.spec.model).toEqual({ primary: 'fake/b-norsk', residency: 'norway' });
  });

  it('prefers the cheapest priced model over the first by id', async () => {
    const { request } = await boot({
      'fake/b-norsk': { inputPerThousand: 0.5, outputPerThousand: 1.5 },
      'fake/c-eu': { inputPerThousand: 0.01, outputPerThousand: 0.02 },
    });
    const { body } = await template(request);

    expect(body.definition.spec.model.primary).toBe('fake/c-eu');
  });

  it('starts with the platform default service model when one is set', async () => {
    const { request, settings } = await boot({
      'fake/b-norsk': { inputPerThousand: 0.01, outputPerThousand: 0.02 },
    });
    expect(settings.setDefault('services.defaultModel', 'fake/c-eu', 'drift', 'Test').ok).toBe(
      true,
    );
    const { body } = await template(request);

    expect(body.definition.spec.model).toEqual({ primary: 'fake/c-eu', residency: 'eu' });
  });

  it('skips a model the tenant turned off in Byggeklosser', async () => {
    const { platform, request } = await boot();
    await appendVersion(platform.configEntries, {
      kind: adoptionKind,
      scope: tenant,
      id: blockKey('model', 'fake/b-norsk'),
      spec: { status: 'in_use', settings: { enabled: false }, event: 'settings' },
      deleted: false,
      by: 'Kari',
      reason: 'Slått av i testen',
      at: '2026-10-07T10:00:00Z',
    });
    const { body } = await template(request);

    expect(body.definition.spec.model.primary).toBe('fake/c-eu');
  });

  it('refuses kinds without a template', async () => {
    const { request } = await boot();
    const res = await request(`/tenants/${tenant}/definitions/template?kind=Skill`);

    expect(res.status).toBe(400);
  });
});
