import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { InMemoryUsageBuckets } from '@genai/port-usage';
import { createAdmin } from './admin.js';
import { createPlatform, platformModules } from './composition.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import { createApp } from './app.js';
import { kernelTaskReader } from './timeline.js';
import { digdir, files, testService } from './testkit.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const eva: Principal = { kind: 'employee', issuer: 'test', subject: 'eva', tenant: digdir };
const usdNok = 10;
const gatewayMicros = 2000;
const genkiMicroNok = 15_000;

const answer = {
  status: 200,
  json: {
    id: 'c',
    object: 'chat.completion',
    created: 0,
    model: 'gpt',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Svar.' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
  },
};

const serviceOn = (id: string, model: string) => {
  const definition = testService(id);
  return {
    ...definition,
    spec: {
      ...definition.spec,
      exposure: { openai: true },
      model: { primary: model, residency: 'norway' },
    },
  };
};

const boot = async () => {
  const model = await fakeHttp(() => answer);
  servers.push(model);
  const connection = {
    families: { openai: '' },
    baseURL: `${model.url}/v1`,
    auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
  };
  const configEntries = new InMemoryConfigEntryStore();
  await configEntries.append({
    kind: 'block-policy',
    scope: platformScope,
    id: 'platform',
    version: 1,
    spec: { rules: [] },
    deleted: false,
    by: 'drift',
    at: '2026-10-07T10:00:00.000Z',
    reason: 'Alle modeller er tillatt i testene',
  });
  const gatewayUsage = new InMemoryUsageBuckets(() => [digdir]);
  gatewayUsage.setRates([{ currency: 'USD', day: '2026-01-01', nokPerUnit: usdNok }]);
  const settings = new SettingsRegistry(platformSettings);
  const price = { inputPerThousand: 1, outputPerThousand: 1 };
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: { direct: connection, 'ai-gateway': { ...connection, gateway: true } },
        models: [
          { id: 'direct/gpt', endpoint: 'direct', deployment: 'gpt', residency: 'norway' },
          {
            id: 'ai-gateway/borealis',
            endpoint: 'ai-gateway',
            deployment: 'aivar:borealis',
            residency: 'norway',
          },
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: { 'direct/gpt': price, 'ai-gateway/borealis': price },
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p, skill, flow) => new InMemoryDefinitionStore(p, undefined, skill, flow),
    configurables: { store: configEntries, scheduleIntervalMs: 0 },
    modules: platformModules,
    policy: { decide: async () => ({ allow: true }) },
    environmentTier: 'test',
    gatewayUsage,
    authenticate: async (request) =>
      request.headers.get('authorization') === 'Bearer eva' ? { principal: eva } : undefined,
  });
  await platform.definitions.publish(serviceOn('direkte', 'direct/gpt'), 'test', 'test', files);
  await platform.definitions.publish(
    serviceOn('gjennom', 'ai-gateway/borealis'),
    'test',
    'test',
    files,
  );
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
      tenantGate: platform.tenantGate,
      registered: platform.registered,
      caller: platform.caller,
      tasks: kernelTaskReader(platform.kernel, {
        kind: 'operator',
        issuer: 'platform',
        subject: 'task-reader',
      }),
    },
  });
  platform.mount(app, admin);
  const send = (path: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: 'Bearer eva', 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const run = async (service: string) => {
    const ran = await send('/v1/chat/completions', {
      model: `${service}__default`,
      messages: [{ role: 'user', content: 'Hei' }],
    });
    expect(ran.status).toBe(200);
  };
  const chargedByGateway = async (deployment: string) => {
    const hour = new Date();
    hour.setUTCMinutes(0, 0, 0);
    await gatewayUsage.store(
      'gateway',
      {
        start: hour.toISOString(),
        closed: false,
        rows: [
          {
            source: 'gateway',
            start: hour.toISOString(),
            closed: false,
            model: deployment,
            subject: { kind: 'genki', id: digdir, org: digdir },
            inputTokens: 12,
            outputTokens: 3,
            cachedInputTokens: 0,
            cacheWriteTokens: 0,
            requests: 1,
            unpricedRequests: 0,
            cost: { currency: 'USD', micros: gatewayMicros },
          },
        ],
      },
      undefined,
    );
  };
  return { send, run, chargedByGateway };
};

type Totals = { inputTokens: number; outputTokens: number; costMicroNok: number | null };

describe('usage of a tenant whose calls go through a connection marked as the AI gateway', () => {
  it("counts the gateway's charge for a call through a marked connection and genki's own measure for an unmarked one, each once", async () => {
    const { send, run, chargedByGateway } = await boot();
    await run('direkte');
    await run('gjennom');
    await chargedByGateway('aivar:borealis');

    const usage = (await (await send(`/tenants/${digdir}/usage?days=1`)).json()) as {
      totals: Totals;
    };

    expect(usage.totals).toMatchObject({
      inputTokens: 12 + 12,
      outputTokens: 3 + 3,
      costMicroNok: genkiMicroNok + gatewayMicros * usdNok,
    });
  });
});
