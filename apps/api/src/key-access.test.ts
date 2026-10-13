import { afterEach, describe, expect, it } from 'vitest';
import type { Principal, Task } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import {
  apiKeyDigest,
  createAuthenticator,
  InMemoryApiKeys,
  type StoredApiKey,
} from '@genai/identity';
import { envSecrets, type StoredTask, type TaskStore } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import { digdir, files, klarsprak } from './testkit.js';

const unregistered = '405003309';

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

const kari: Principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: digdir,
  authorizedFor: [{ org: digdir }],
};

const people: Record<string, Principal> = {
  kari,
  ingrid: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ingrid',
    authorizedFor: [{ org: digdir }, { org: unregistered }],
  },
};

const service = (id: string) => {
  const definition = klarsprak({ id });
  return {
    ...definition,
    spec: { ...definition.spec, model: { primary: 'fake/gpt', residency: 'norway' } },
  };
};

const fakes: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(fakes.splice(0).map((f) => f.close()));
});

const boot = async (
  options: {
    tenantCallsPerMinute?: number;
    monthlyTokens?: number;
    usedTokens?: number;
    knowledgeService?: boolean;
  } = {},
) => {
  const keys = new InMemoryApiKeys();
  keys.add(key('veileder', { agents: ['veileder__default'] }));
  keys.add(key('alle', { agents: ['*'], datasets: ['*'] }));
  keys.add(key('tom'));
  keys.add(key('ka', { agents: ['kunnskap'] }));
  keys.add(key('treg', { agents: ['*'], datasets: ['*'], callsPerMinute: 3 }));
  keys.add(key('admin', { agents: ['*'], datasets: ['*'], scopes: ['query', 'admin'] }));
  const authenticator = createAuthenticator({ apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
  if (options.monthlyTokens)
    settings.setTenant(digdir, 'usage.monthlyTokens', options.monthlyTokens);
  if (options.tenantCallsPerMinute)
    settings.setTenant(digdir, 'usage.tenantCallsPerMinute', options.tenantCallsPerMinute);
  const used: Task = {
    id: 'brukt',
    service: {
      capability: { id: `${digdir}/klarsprak/default`, version: '1' },
      strategy: { id: 'single-call', version: '1' },
      configHash: 'h',
    },
    principal: { kind: 'employee', id: 'kari' },
    tenant: digdir,
    owner: digdir,
    status: 'completed',
    artifacts: [],
    usage: { inputTokens: options.usedTokens ?? 0, outputTokens: 0 },
    createdAt: new Date().toISOString(),
  };
  const stored = new Map<string, StoredTask>([
    ['brukt', { task: used, principal: kari, lastSeq: 0 }],
  ]);
  const tasks: TaskStore = {
    put: async (s) => {
      stored.set(s.task.id, s);
    },
    get: async (id) => stored.get(id),
    pendingFor: async () => [],
  };
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
    tasks,
    taskIndex: {
      all: async () =>
        [...stored.values()].map((s) => ({
          task: s.task.id,
          tenant: s.task.tenant,
          status: s.task.status,
          at: s.task.createdAt,
        })),
      running: async () => [],
    },
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const person = people[request.headers.get('authorization')?.slice(7) ?? ''];
      if (person) return { principal: person };
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  for (const id of ['veileder', 'klarsprak'])
    await platform.definitions.publish(service(id), 'test', 'test', files);
  if (options.knowledgeService) {
    const base = service('kunnskap');
    await platform.definitions.publish(
      {
        ...base,
        spec: {
          ...base.spec,
          output: { kind: 'answer', withSources: true },
          variants: [
            'default',
            {
              id: 'retrieve-only',
              aliases: ['kunnskap-raw'],
            },
          ],
        },
      },
      'test',
      'test',
      files,
    );
    const other = service('altinn');
    await platform.definitions.publish(
      {
        ...other,
        spec: {
          ...other.spec,
          variants: [{ id: 'default', aliases: ['altinn-fact'] }],
        },
      },
      'test',
      'test',
      files,
    );
  }
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
  const send = (
    path: string,
    as: string,
    init: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(people[as] ? { authorization: `Bearer ${as}` } : { 'x-api-key': `gp_${as}` }),
        'content-type': 'application/json',
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const mcp = (as: string, method: string, params: Record<string, unknown> = {}) =>
    send('/api/mcp', as, {
      body: { jsonrpc: '2.0', id: 1, method, params },
      headers: {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
      },
    });
  return { send, mcp, platform, settings };
};

const json = async <T>(res: Response) => (await res.json()) as T;

describe('API key grants', () => {
  it('lists only the granted services on /v1/models, the OpenAPI document and MCP tools/list', async () => {
    const { send, mcp } = await boot();

    const models = await json<{ data: { id: string }[] }>(await send('/v1/models', 'veileder'));
    const openapi = await json<{ paths: Record<string, unknown> }>(
      await send('/api/tools/openapi.json', 'veileder'),
    );
    const tools = await json<{ result: { tools: { name: string }[] } }>(
      await mcp('veileder', 'tools/list'),
    );

    expect(models.data.map((m) => m.id)).toEqual(['veileder__default']);
    expect(Object.keys(openapi.paths)).toEqual(['/api/tools/call/veileder__default']);
    expect(tools.result.tools.map((t) => t.name)).toEqual(['veileder__default']);
  });

  it('refuses a call to a service the key is not granted with 403', async () => {
    const { send, mcp } = await boot();

    const rest = await send('/api/tools/call/klarsprak__default', 'veileder', {
      body: { query: 'Skriv dette enklere' },
    });
    const chat = await send('/v1/chat/completions', 'veileder', {
      body: { model: 'klarsprak__default', messages: [{ role: 'user', content: 'hei' }] },
    });
    const tool = await json<{ result?: { isError: boolean }; error?: unknown }>(
      await mcp('veileder', 'tools/call', {
        name: 'klarsprak__default',
        arguments: { query: 'hei' },
      }),
    );

    expect(rest.status).toBe(403);
    expect(chat.status).toBe(403);
    expect(tool.result?.isError ?? tool.error !== undefined).toBe(true);
  });

  it('gives a key with no grants no services, and a key for all services every service', async () => {
    const { send } = await boot();
    const ids = async (as: string) =>
      (await json<{ data: { id: string }[] }>(await send('/v1/models', as))).data
        .map((m) => m.id)
        .sort();

    expect(await ids('tom')).toEqual([]);
    expect(await ids('alle')).toEqual(['klarsprak__default', 'veileder__default']);
  });

  it('answers a query key on a tenant route with a 403 problem, never a bare 404', async () => {
    const { send } = await boot();
    for (const path of [
      `/tenants/${digdir}/datasets`,
      `/tenants/${digdir}/overview`,
      `/tenants/${digdir}/definitions`,
    ]) {
      const response = await send(path, 'alle');
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
    }
    expect((await send(`/tenants/${digdir}/datasets`, 'admin')).status).toBe(200);
  });

  it('answers an unknown /api route with headless-rag not-found body', async () => {
    const { send } = await boot();
    const response = await send('/api/v1/models', 'alle');
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ status: 404, error: 'API endpoint not found' });
  });
});

describe('a key bound to a service', () => {
  type Listed = {
    id: string;
    title?: string;
    _agent_id?: string;
    _mode?: string;
    _default?: boolean;
  };
  const listed = async (as: string, boots = boot()) => {
    const { send } = await boots;
    return (await json<{ data: Listed[] }>(await send('/v1/models', as))).data;
  };

  it('lists only that service as its own variants, default first, with display names and its own aliases grouped under it', async () => {
    const models = await listed('ka', boot({ knowledgeService: true }));

    expect(models.map((m) => m.id)).toEqual([
      'kunnskap__default',
      'kunnskap__retrieve-only',
      'kunnskap-raw',
    ]);
    expect(models.map((m) => m._agent_id)).toEqual(['kunnskap', 'kunnskap', 'kunnskap']);
    expect(models.map((m) => m._default)).toEqual([true, undefined, undefined]);
    expect(models.map((m) => m.title)).toEqual(['Svar med kilder', 'Bare søk', 'Bare søk']);
    expect(models.map((m) => m.id)).not.toContain('altinn__default');
  });

  it('lists the same variants in English for an English caller', async () => {
    const { send } = await boot({ knowledgeService: true });

    const response = await send('/v1/models', 'ka', { headers: { 'accept-language': 'en' } });

    expect((await json<{ data: Listed[] }>(response)).data.map((m) => m.title)).toEqual([
      'Answers with sources',
      'Search only',
      'Search only',
    ]);
  });

  it('gives the MCP tool list the same variants', async () => {
    const { mcp } = await boot({ knowledgeService: true });

    const tools = await json<{ result: { tools: { name: string }[] } }>(
      await mcp('ka', 'tools/list'),
    );

    expect(tools.result.tools.map((t) => t.name)).toEqual([
      'kunnskap__default',
      'kunnskap__retrieve-only',
      'kunnskap-raw',
    ]);
  });

  it('keeps listing every service and alias for a key that is not bound', async () => {
    const models = await listed('alle', boot({ knowledgeService: true }));

    expect(models.map((m) => m.id)).toContain('kunnskap-raw');
    expect(models.map((m) => m.id)).toContain('altinn__default');
  });

  it('resolves an alias of its own variant', async () => {
    const { send } = await boot({ knowledgeService: true });

    const response = await send('/v1/chat/completions', 'ka', {
      body: {
        model: 'kunnskap-raw',
        messages: [{ role: 'user', content: 'hei' }],
      },
    });

    expect(response.status).toBe(200);
  });

  it('starts a conversation on the service id of its own variant, and refuses another service', async () => {
    const { send } = await boot({ knowledgeService: true });
    const start = (agentId: string) =>
      send('/api/conversations', 'ka', {
        body: { agentId, title: 'Paritet' },
        headers: { 'x-user-id': 'kari' },
      });

    expect((await start('kunnskap')).status).toBe(201);
    expect((await start('altinn')).status).toBe(403);
  });

  it('refuses another service, also by its alias, with a problem that names the bound service', async () => {
    const { send } = await boot({ knowledgeService: true });

    for (const model of ['altinn__default', 'altinn-fact']) {
      const response = await send('/v1/chat/completions', 'ka', {
        body: { model, messages: [{ role: 'user', content: 'hei' }] },
      });
      expect(response.status).toBe(403);
      expect(JSON.stringify(await response.json())).toContain('kunnskap');
    }
  });
});

describe('rate limits and quota', () => {
  it('refuses calls over the key limit with 429, Retry-After and headless-rag body', async () => {
    const { mcp } = await boot();
    const statuses = [];
    for (let i = 0; i < 4; i++) statuses.push((await mcp('treg', 'tools/list')).status);
    const refused = await mcp('treg', 'tools/list');

    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(refused.headers.get('retry-after')).toMatch(/^\d+$/);
    expect(await refused.json()).toEqual({
      error: { code: 'rate_limited', message: 'Too many requests', limit: 3, window_ms: 60000 },
    });
    expect((await mcp('alle', 'tools/list')).status).toBe(200);
  });

  it('shares one limit of 120 calls a minute per key across MCP, tool calls and /v1 chat', async () => {
    const { send, mcp } = await boot();
    const statuses = new Set<number>();
    for (let i = 0; i < 40; i++) {
      statuses.add((await mcp('alle', 'tools/list')).status);
      statuses.add((await send('/api/tools/call/no-such__tool', 'alle', { body: {} })).status);
      statuses.add(
        (await send('/v1/chat/completions', 'alle', { body: { model: 'no-such', messages: [] } }))
          .status,
      );
    }
    expect(statuses.has(429)).toBe(false);
    const refused = await mcp('alle', 'tools/list');
    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ error: { code: 'rate_limited', limit: 120 } });
  });

  it('does not count conversation and dataset reads against the key limit, as headless-rag did not', async () => {
    const { send, mcp } = await boot();
    for (let i = 0; i < 5; i++) {
      expect((await send('/api/conversations', 'treg')).status).not.toBe(429);
      expect((await send('/api/datasets', 'treg')).status).not.toBe(429);
    }
    expect((await mcp('treg', 'tools/list')).status).toBe(200);
  });

  it('never rate-limits /v1/models, as headless-rag did not', async () => {
    const { send } = await boot({ tenantCallsPerMinute: 1 });
    for (let i = 0; i < 5; i++) expect((await send('/v1/models', 'treg')).status).toBe(200);
  });

  it('refuses calls over the tenant limit across keys', async () => {
    const { mcp } = await boot({ tenantCallsPerMinute: 2 });
    expect((await mcp('alle', 'tools/list')).status).toBe(200);
    expect((await mcp('veileder', 'tools/list')).status).toBe(200);
    expect((await mcp('alle', 'tools/list')).status).toBe(429);
  });

  it('follows a change to the tenant call limit setting', async () => {
    const { mcp, settings } = await boot();
    for (let i = 0; i < 3; i++) expect((await mcp('veileder', 'tools/list')).status).toBe(200);

    settings.setTenant(digdir, 'usage.tenantCallsPerMinute', 4);

    expect((await mcp('alle', 'tools/list')).status).toBe(200);
    expect((await mcp('alle', 'tools/list')).status).toBe(429);
  });

  it('refuses a service call once the monthly token quota is used', async () => {
    const { send } = await boot({ monthlyTokens: 100, usedTokens: 150 });
    const refused = await send('/api/tools/call/veileder__default', 'veileder', {
      body: { query: 'hei' },
    });

    expect(refused.status).toBe(429);
    expect(await refused.json()).toMatchObject({ type: 'urn:genai:problem:quota-exhausted' });
    expect((await send('/v1/models', 'veileder')).status).toBe(200);
  });
});

describe('unregistered organisations', () => {
  it('refuses an employee of an organisation Digdir has not registered', async () => {
    const { send } = await boot();
    const refused = await send(`/tenants/${unregistered}/datasets`, 'ingrid');

    expect(refused.status).toBe(403);
    expect(refused.headers.get('content-type')).toContain('application/problem+json');
    expect(await refused.json()).toMatchObject({
      type: 'urn:genai:problem:tenant-not-registered',
      title: 'Virksomheten er ikke registrert på plattformen',
    });
    expect((await send(`/tenants/${unregistered}/definitions`, 'ingrid')).status).toBe(403);
  });

  it('lets the same person use the registered Digdir tenant', async () => {
    const { send } = await boot();
    expect((await send(`/tenants/${digdir}/datasets`, 'ingrid')).status).toBe(200);
    expect((await send(`/tenants/${digdir}/datasets`, 'kari')).status).toBe(200);
  });
});

describe('kernel limits on services', () => {
  it('gives every published service a deadline and a token budget', async () => {
    const { platform } = await boot();
    const services = platform.registry
      .all()
      .filter((c) => c.descriptor.id.startsWith(`${digdir}/`));

    expect(services.length).toBeGreaterThan(0);
    for (const c of services) {
      expect(c.deadlineMs).toBeGreaterThan(0);
      expect(c.budget?.inputTokens).toBeGreaterThan(0);
    }
  });
});
