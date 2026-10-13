import { describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import {
  apiKeyDigest,
  createAuthenticator,
  InMemoryApiKeys,
  type StoredApiKey,
} from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import { digdir, files, klarsprak } from './testkit.js';

const faithful = 'radgiver__faithful';
const bundled = 'radgiver__bundled';

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

const service = (id: string, variants?: unknown[]) => {
  const definition = klarsprak({ id, ...(variants ? { variants } : {}) });
  return {
    ...definition,
    spec: { ...definition.spec, model: { primary: 'fake/gpt', residency: 'norway' } },
  };
};

const boot = async () => {
  const keys = new InMemoryApiKeys();
  keys.add(key('alle', { agents: ['*'], datasets: ['*'] }));
  keys.add(key('trofast', { agents: ['*'], skillGraphs: ['faithful'] }));
  keys.add(
    key('policy', {
      scopes: [],
      policy: { id: 'p1', scopes: ['query'], agents: ['klarsprak__default'] },
    }),
  );
  keys.add(key('to', { agents: ['klarsprak__default', faithful] }));
  keys.add(key('en', { agents: ['klarsprak__default'] }));
  keys.add(key('tom'));
  const authenticator = createAuthenticator({ apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
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
  await platform.definitions.publish(service('klarsprak'), 'test', 'test', files);
  await platform.definitions.publish(
    service('radgiver', [{ id: 'faithful' }, { id: 'bundled' }]),
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
  const send = (path: string, as: string, body?: unknown) =>
    app.request(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { 'x-api-key': `gp_${as}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const tools = async (as: string) => {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'x-api-key': `gp_${as}`,
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    return body.result.tools.map((t) => t.name).sort();
  };
  return { send, tools };
};

describe('skill-graph grants as headless-rag enforced them', () => {
  it('lists only the tools whose mode the key grants', async () => {
    const { tools } = await boot();
    expect(await tools('trofast')).toEqual([faithful]);
    expect(await tools('alle')).toEqual(expect.arrayContaining([faithful, bundled]));
  });

  it('refuses a call to a mode the key does not grant with mode_not_authorized', async () => {
    const { send } = await boot();
    const tool = await send(`/api/tools/call/${bundled}`, 'trofast', { query: 'hei' });
    const chat = await send('/v1/chat/completions', 'trofast', {
      model: bundled,
      messages: [{ role: 'user', content: 'hei' }],
    });

    expect(tool.status).toBe(403);
    expect(chat.status).toBe(403);
    expect(JSON.stringify(await chat.json())).toContain('mode_not_authorized');
  });
});

describe('access policies as headless-rag unioned them', () => {
  it("gives a key the union of its own grants and its access policy's grants", async () => {
    const { tools } = await boot();
    expect(await tools('policy')).toEqual(['klarsprak__default']);
  });
});

describe('conversation agent defaulting as headless-rag chose it', () => {
  const create = async (as: string, body: Record<string, unknown> = {}) => {
    const { send } = await boot();
    return send('/api/conversations', as, body);
  };

  it('defaults to the only agent the key can reach', async () => {
    const res = await create('en');
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ conversation: { agentId: 'klarsprak' } });
  });

  it('answers 400 asking for agent-id when the key reaches several agents', async () => {
    const res = await create('to');
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({
      error: 'Multiple agents are available; specify agent-id',
    });
  });

  it('answers 403 for a named agent the key is not granted', async () => {
    const res = await create('en', { 'agent-id': 'radgiver' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({
      error: 'API key is not allowed to access the selected agent',
    });
  });

  it('answers 404 for a named agent that does not exist', async () => {
    const res = await create('alle', { 'agent-id': 'no/such-agent' });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'Agent not found: no/such-agent' });
  });

  it('creates the conversation for a granted agent named by agent-id', async () => {
    const res = await create('to', { agentId: 'radgiver' });
    expect(res.status).toBe(201);
  });

  it('answers 503 when none of the key grants reach an agent', async () => {
    const res = await create('tom');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: "None of this API key's granted agents are available",
    });
  });
});
