import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  compileStoredServices,
  InMemoryDefinitionStore,
  serviceDefinition,
  SettingsRegistry,
  toCapabilities,
  type DefinitionStore,
  type PublishedVersion,
  type ServiceDefinition,
} from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { digdir, principals } from './testkit.js';

const service = (id: string, strategy = { id: 'single-call', version: 1 }) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id, name: id },
  spec: {
    purpose: 'Svarer kort på spørsmål',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { ...strategy, config: { instructions: 'Svar kort.' } },
    model: { primary: 'fake/gpt', residency: 'global' },
  },
});

const stored = (definition: unknown): PublishedVersion => ({
  version: 1,
  definition: definition as ServiceDefinition,
  publishedBy: 'test',
  publishedAt: '2026-10-01T10:00:00.000Z',
  reason: 'lagret før en oppgradering',
  files: {},
});

const retired = stored(
  serviceDefinition.parse(service('gammel', { id: 'retired-strategy', version: 1 })),
);
const broken = stored({ ...service('ødelagt'), spec: { purpose: 'mangler resten' } });

const withStoredLeftovers = (inner: DefinitionStore): DefinitionStore => ({
  get: (...args) => inner.get(...args),
  versions: (...args) => inner.versions(...args),
  list: (...args) => inner.list(...args),
  resolve: (...args) => inner.resolve(...args),
  publish: (...args) => inner.publish(...args),
  capabilities: async (onInvalid) => [
    ...(await inner.capabilities(onInvalid)),
    ...toCapabilities(retired.definition as ServiceDefinition, 1),
    ...compileStoredServices([broken], { strategies: new Map() }, onInvalid),
  ],
});

const boot = async () => {
  const logged: { msg: string; fields: Record<string, unknown> }[] = [];
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: 'http://127.0.0.1:9/v1',
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
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => withStoredLeftovers(new InMemoryDefinitionStore(p)),
    policy: { decide: async () => ({ allow: true }) },
    logger: (msg, fields) => logged.push({ msg, fields }),
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
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
  const get = async (who: string) => {
    const res = await app.request('/operator/definitions/quarantine', {
      headers: { authorization: `Bearer ${who}` },
    });
    return { status: res.status, body: (await res.json()) as { data?: unknown[] } };
  };
  return { platform, logged, get };
};

describe('invalid stored definitions', () => {
  it('boots and serves the other services while an invalid stored service is quarantined', async () => {
    const { platform, logged, get } = await boot();
    const published = await platform.definitions.publish(service('svar'), 'kari', 'ny tjeneste');
    expect(published.ok).toBe(true);

    const served = platform.registry.all().map((c) => c.descriptor.id);
    expect(served).toContain(`${digdir}/svar/default`);
    expect(served).not.toContain(`${digdir}/gammel/default`);
    expect(served).not.toContain(`${digdir}/ødelagt/default`);

    const quarantined = await get('operator');
    expect(quarantined.status).toBe(200);
    expect(quarantined.body.data).toHaveLength(2);
    expect(quarantined.body.data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tenant: digdir,
          kind: 'Service',
          id: 'ødelagt',
          version: 1,
          errors: expect.arrayContaining([expect.objectContaining({ path: 'spec.input' })]),
          at: expect.any(String),
        }),
        expect.objectContaining({
          tenant: digdir,
          kind: 'Service',
          id: 'gammel',
          version: 1,
          errors: [
            expect.objectContaining({ message: expect.stringContaining('retired-strategy') }),
          ],
        }),
      ]),
    );

    const warnings = logged.filter((l) => l.msg === 'definition quarantined');
    expect(warnings.map((w) => w.fields.id).sort()).toEqual(['gammel', 'ødelagt']);
  });

  it('lists the quarantine to operators only', async () => {
    const { get } = await boot();
    expect((await get('kari')).status).toBe(403);
    expect((await get('nobody')).status).toBe(401);
  });
});
