import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { apiKeyDigest, createAuthenticator } from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import {
  configuredCredentialScope,
  lockedEnvironmentType,
  withCredentialOrigin,
} from './lockdown.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { digdir, files, principals, testService } from './testkit.js';

const configuredKey = 'gp_from-configuration';
const reason = 'Endring i testen';

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const boot = async (lockdown: boolean) => {
  const model = await fakeHttp(() => ({
    status: 200,
    json: {
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
    },
    settings,
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    apiKeys: keys,
    ...(lockdown ? { lockdown: { configuredKeys: new Set([apiKeyDigest(configuredKey)]) } } : {}),
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
  return { app, send, chat, platform, model };
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
