import { afterEach, describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import {
  apiKeyDigest,
  createAuthenticator,
  InMemoryApiKeys,
  type StoredApiKey,
} from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import { digdir, files, klarsprak } from './testkit.js';

const otherTenant = '889640782';
const servers: FakeServer[] = [];
const gates: (() => void)[] = [];
afterEach(async () => {
  for (const open of gates.splice(0)) open();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const key = (id: string, extra: Partial<StoredApiKey> = {}): StoredApiKey => ({
  id,
  name: id,
  digest: apiKeyDigest(`gp_${id}`),
  tenant: digdir,
  scopes: ['query'],
  datasets: [],
  agents: [],
  ...extra,
});

const boot = async () => {
  const model = await fakeHttp(async () => {
    await new Promise<void>((resolve) => gates.push(resolve));
    return {
      status: 200,
      json: {
        id: 'c1',
        object: 'chat.completion',
        created: 0,
        model: 'gpt-test',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hele svaret.' },
            finish_reason: 'stop',
          },
        ],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      },
    };
  });
  servers.push(model);
  const keys = new InMemoryApiKeys();
  keys.add(key('frontend', { service: 'klarsprak' }));
  keys.add(key('elsewhere', { tenant: otherTenant, agents: ['*'] }));
  const authenticator = createAuthenticator({ apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            families: { openai: '' },
            baseURL: model.url,
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
    authenticate: async (request) => {
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  const definition = klarsprak({ id: 'klarsprak' });
  await platform.definitions.publish(
    {
      ...definition,
      spec: { ...definition.spec, model: { primary: 'fake/gpt', residency: 'norway' } },
    },
    'test',
    'test',
    files,
  );
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      auth: { authenticate: async () => undefined },
      tenantGate: platform.tenantGate,
    },
  });
  platform.mount(app, admin);
  const send = (path: string, keyId: string, user: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-api-key': `gp_${keyId}`,
        'x-user-id': user,
        'content-type': 'application/json',
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  return { send, model };
};

describe('stopping a run through /v1', () => {
  it('stops a run on a service key only for the end user whose thread it is, never for another organisation', async () => {
    const { send, model } = await boot();
    const asked = await send('/v1/chat/completions', 'frontend', 'ola', {
      model: 'klarsprak__default',
      messages: [{ role: 'user', content: 'Skriv enklere.' }],
      genai_conversation: true,
      stream: true,
    });
    const task = asked.headers.get('genai-task') ?? '';
    const thread = asked.headers.get('genai-conversation') ?? '';
    await expect.poll(() => model.seen.length).toBe(1);

    const otherUser = await send(`/v1/tasks/${task}/cancel`, 'frontend', 'kari', {});
    const otherOrg = await send(`/v1/tasks/${task}/cancel`, 'elsewhere', 'ola', {});
    const own = await send(`/v1/tasks/${task}/cancel`, 'frontend', 'ola', {});
    await asked.text();
    const stored = (await (
      await send(`/api/conversations/${thread}`, 'frontend', 'ola')
    ).json()) as {
      messages: { role: string; text: string; task?: string; stopped?: boolean }[];
    };

    expect([otherUser.status, otherOrg.status, own.status]).toEqual([404, 404, 200]);
    expect(await own.json()).toEqual({ id: task, object: 'task', status: 'cancelled' });
    expect(stored.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'Skriv enklere.'],
      ['assistant', ''],
    ]);
    expect(stored.messages.at(-1)).toMatchObject({ task, stopped: true });
  });
});
