import { Hono } from 'hono';
import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { createAuthenticator } from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { environmentEvents } from './service-environments.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';

const digdir = '991825827';
const reason = 'Prøver ny instruks på testerne først';
const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  lise: {
    kind: 'employee',
    issuer: 'test',
    subject: 'lise',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: '999888777',
    authorizedFor: [{ org: '999888777' }],
  },
};

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const completion = {
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-test',
  choices: [{ index: 0, message: { role: 'assistant', content: 'Svar.' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
};

const service = (instructions: string) => ({
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant: digdir, id: 'svar', name: 'Svar' },
  spec: {
    purpose: 'Svarer kort',
    riskClass: 'minimal',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions } },
    model: { primary: 'test/chat', residency: 'norway' },
    exposure: { openai: true, rest: true, mcp: true, a2a: true },
  },
});

const ask = { model: 'svar__default', messages: [{ role: 'user', content: 'Hei' }] };

const boot = async () => {
  const model = await fakeHttp(() => ({ status: 200, json: completion }));
  servers.push(model);
  const keys = new InMemoryTenantApiKeys();
  const keyAuth = createAuthenticator({ apiKeys: keys });
  const auth = { kind: 'api-key', secret: 'secret://env/model-key' } as const;
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: { test: { families: { openai: '' }, baseURL: `${model.url}/v1`, auth } },
        models: [
          {
            id: 'test/chat',
            endpoint: 'test',
            deployment: 'chat',
            residency: 'norway',
            capabilities: ['stream'],
          },
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ MODEL_KEY: 'k' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    apiKeys: keys,
    authenticate: async (request) => {
      const bearer = request.headers.get('authorization')?.slice(7) ?? '';
      const person = people[bearer];
      if (person) return { principal: person };
      const found = await keyAuth.authenticate(request);
      return found && { principal: found.principal };
    },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
    models: platform.models,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (
    path: string,
    init: {
      body?: unknown;
      as?: string;
      method?: string;
      reason?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${init.as ?? 'kari'}`,
        'content-type': 'application/json',
        ...(init.reason ? { 'change-reason': init.reason } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const publish = async (instructions: string) =>
    expect((await platform.definitions.publish(service(instructions), 'test', 'test')).ok).toBe(
      true,
    );
  const environments = `/tenants/${digdir}/services/svar/environments`;
  const addTest = () => call(environments, { body: { name: 'test' }, reason });
  const newKey = async (body: Record<string, unknown>) => {
    const created = await call(`/tenants/${digdir}/services/svar/api-keys`, {
      body: { name: 'Nettside', ...body },
      reason: 'Nøkkel til nettsiden',
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as { key: string }).key;
  };
  const versionRun = async (headers: Record<string, string> = {}, as = 'kari') => {
    const response = await call('/v1/chat/completions', { body: ask, headers, as });
    return {
      status: response.status,
      version: response.headers.get('genai-service-version'),
      environment: response.headers.get('genai-environment'),
      task: response.headers.get('genai-task') ?? '',
      body: (await response.json()) as { error?: { code: string } },
    };
  };
  return { platform, admin, app, call, publish, environments, addTest, newKey, versionRun };
};

describe('a service without environments', () => {
  it('runs the latest published version in prod, as before environments', async () => {
    const { call, publish, environments, versionRun } = await boot();
    await publish('Første.');
    await publish('Andre.');

    const run = await versionRun();
    const listed = await (await call(environments)).json();

    expect(run).toMatchObject({ status: 200, version: '2', environment: 'prod' });
    expect(listed).toEqual({
      environments: [{ name: 'prod', version: 2, followsPublishes: true, previousVersion: null }],
      latestVersion: 2,
    });
  });
});

describe('adding test', () => {
  it('keeps prod on its version while publishing moves test', async () => {
    const { call, publish, environments, addTest, versionRun } = await boot();
    await publish('Første.');
    expect((await addTest()).status).toBe(201);
    await publish('Andre.');

    expect(await versionRun()).toMatchObject({ version: '1', environment: 'prod' });
    expect(await versionRun({ 'GenAI-Environment': 'test' })).toMatchObject({
      version: '2',
      environment: 'test',
    });
    expect(
      ((await (await call(environments)).json()) as { environments: unknown[] }).environments,
    ).toEqual([
      { name: 'prod', version: 1, followsPublishes: false, previousVersion: null },
      { name: 'test', version: 2, followsPublishes: true, previousVersion: null },
    ]);
  });

  it('needs manage-services and a change reason', async () => {
    const { call, publish, environments } = await boot();
    await publish('Første.');

    expect((await call(environments, { body: { name: 'test' }, reason, as: 'lise' })).status).toBe(
      403,
    );
    expect((await call(environments, { body: { name: 'test' } })).status).toBe(400);
  });

  it('refuses prod, an invalid name, and an environment the service has', async () => {
    const { call, publish, environments, addTest } = await boot();
    await publish('Første.');
    await addTest();

    expect((await call(environments, { body: { name: 'prod' }, reason })).status).toBe(400);
    expect((await call(environments, { body: { name: 'Test!' }, reason })).status).toBe(400);
    expect((await addTest()).status).toBe(409);
  });
});

describe('describing an environment', () => {
  const listed = async (call: (path: string) => Response | Promise<Response>, path: string) =>
    ((await (await call(path)).json()) as { environments: Record<string, unknown>[] }).environments;

  it('keeps the description given when test is added, through promotions and rollbacks', async () => {
    const { call, publish, environments } = await boot();
    await publish('Første.');
    await call(environments, { body: { name: 'test', description: ' testerne i HR ' }, reason });
    await publish('Andre.');
    await call(`${environments}/test/rollback`, { body: { version: 1 }, reason });

    expect((await listed(call, environments))[1]).toMatchObject({
      name: 'test',
      version: 1,
      description: 'testerne i HR',
    });
  });

  it('changes and clears the description with manage-services and a reason, and records it in the history', async () => {
    const { call, publish, environments, addTest } = await boot();
    await publish('Første.');
    await addTest();
    const path = `${environments}/test`;

    expect(
      (await call(path, { method: 'PATCH', body: { description: 'HR' }, as: 'lise', reason }))
        .status,
    ).toBe(403);
    expect((await call(path, { method: 'PATCH', body: { description: 'HR' } })).status).toBe(400);
    expect(
      (await call(path, { method: 'PATCH', body: { description: 'HR' }, reason })).status,
    ).toBe(200);
    expect((await listed(call, environments))[1]?.description).toBe('HR');
    expect(
      (await call(path, { method: 'PATCH', body: { description: null }, reason })).status,
    ).toBe(200);
    expect((await listed(call, environments))[1]).not.toHaveProperty('description');
    const history = (await (
      await call(`/tenants/${digdir}/services/svar/environment-history`)
    ).json()) as { data: { action: string }[] };
    expect(history.data.slice(0, 2).map((e) => e.action)).toEqual(['described', 'described']);
  });

  it('refuses a description over 200 characters, and one for an environment the service does not have', async () => {
    const { call, publish, environments } = await boot();
    await publish('Første.');
    const long = 'x'.repeat(201);

    expect(
      (await call(environments, { body: { name: 'test', description: long }, reason })).status,
    ).toBe(400);
    expect(
      (await call(`${environments}/test`, { method: 'PATCH', body: { description: 'HR' }, reason }))
        .status,
    ).toBe(404);
  });

  it("never lets one organisation describe another's environment", async () => {
    const { call, publish, environments, addTest } = await boot();
    await publish('Første.');
    await addTest();

    const res = await call(`${environments}/test`, {
      method: 'PATCH',
      body: { description: 'HR' },
      as: 'ola',
      reason,
    });
    expect(res.status).toBe(404);
    expect((await listed(call, environments))[1]).not.toHaveProperty('description');
  });
});

describe('choosing the environment per call', () => {
  it('runs the version of the environment the key is bound to', async () => {
    const { publish, addTest, newKey, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    const testKey = await newKey({ environments: ['test'] });
    const prodKey = await newKey({ environments: ['prod'] });

    expect(await versionRun({}, testKey)).toMatchObject({ version: '2', environment: 'test' });
    expect(await versionRun({}, prodKey)).toMatchObject({ version: '1', environment: 'prod' });
  });

  it('lets a key allowed test and prod pick with the header, defaulting to prod', async () => {
    const { publish, addTest, newKey, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    const key = await newKey({ environments: ['prod', 'test'] });

    expect(await versionRun({}, key)).toMatchObject({ version: '1', environment: 'prod' });
    expect(await versionRun({ 'GenAI-Environment': 'test' }, key)).toMatchObject({
      version: '2',
      environment: 'test',
    });
  });

  it('refuses an environment the key may not use, and one the service does not have', async () => {
    const { publish, addTest, newKey, versionRun } = await boot();
    await publish('Første.');
    const prodOnly = await newKey({ environments: ['prod'] });
    const unbound = await newKey({});

    const notAllowed = await versionRun({ 'GenAI-Environment': 'test' }, prodOnly);
    const missing = await versionRun({ 'GenAI-Environment': 'test' }, unbound);
    await addTest();
    const afterAdding = await versionRun({ 'GenAI-Environment': 'test' }, prodOnly);

    expect(notAllowed).toMatchObject({
      status: 403,
      body: { error: { code: 'environment_not_authorized' } },
    });
    expect(missing).toMatchObject({
      status: 409,
      body: { error: { code: 'environment_not_found' } },
    });
    expect(afterAdding.status).toBe(403);
  });

  it('refuses an environment header that is not a name', async () => {
    const { publish, versionRun } = await boot();
    await publish('Første.');

    expect(await versionRun({ 'GenAI-Environment': 'TEST; drop' })).toMatchObject({
      status: 400,
      body: { error: { code: 'invalid_environment' } },
    });
  });

  it('runs a frontend bound to test on the version test runs', async () => {
    const { call, publish, addTest, newKey, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    const saved = await call(`/tenants/${digdir}/clients/svar-test`, {
      method: 'PUT',
      body: {
        spec: { service: 'svar', kind: 'server', channels: ['openai'], environments: ['test'] },
      },
      reason: 'Testappen til svar',
    });
    expect(saved.status).toBe(200);
    const key = await newKey({ client: 'svar-test' });

    expect(await versionRun({}, key)).toMatchObject({ version: '2', environment: 'test' });
    expect((await versionRun({ 'GenAI-Environment': 'prod' }, key)).status).toBe(403);
  });

  it('lets a bound key pin only a version one of its environments runs', async () => {
    const { publish, addTest, newKey, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    const testKey = await newKey({ environments: ['test'] });
    const bothKey = await newKey({ environments: ['prod', 'test'] });

    expect(await versionRun({ 'GenAI-Version': '1' }, testKey)).toMatchObject({
      status: 403,
      body: { error: { code: 'environment_not_authorized' } },
    });
    expect(await versionRun({ 'GenAI-Version': '2' }, testKey)).toMatchObject({
      version: '2',
      environment: 'test',
    });
    expect(await versionRun({ 'GenAI-Version': '1' }, bothKey)).toMatchObject({
      version: '1',
      environment: 'prod',
    });
  });

  it('lets an unbound caller pin any version and records the environment that runs it, or none', async () => {
    const { publish, addTest, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    await publish('Tredje.');

    expect(await versionRun({ 'GenAI-Version': '1', 'GenAI-Environment': 'test' })).toMatchObject({
      version: '1',
      environment: 'prod',
    });
    expect(await versionRun({ 'GenAI-Version': '2' })).toMatchObject({
      status: 200,
      version: '2',
      environment: null,
    });
    expect((await versionRun({ 'GenAI-Version': '9' })).status).toBe(409);
  });

  it('confines a key bound to a client to the environments both name', async () => {
    const { call, publish, addTest, newKey, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    await call(`/tenants/${digdir}/clients/svar-test`, {
      method: 'PUT',
      body: {
        spec: { service: 'svar', kind: 'server', channels: ['openai'], environments: ['test'] },
      },
      reason: 'Testappen til svar',
    });
    const key = await newKey({ client: 'svar-test', environments: ['prod', 'test'] });

    expect(await versionRun({}, key)).toMatchObject({ version: '2', environment: 'test' });
    expect((await versionRun({ 'GenAI-Environment': 'prod' }, key)).status).toBe(403);
  });

  it('treats an object property name as an environment the service does not have', async () => {
    const { publish, versionRun } = await boot();
    await publish('Første.');

    expect(await versionRun({ 'GenAI-Environment': 'constructor' })).toMatchObject({
      status: 409,
      body: { error: { code: 'environment_not_found' } },
    });
  });

  it('applies the same rule on the REST, MCP and A2A channels, for keys and people alike', async () => {
    const { app, publish, addTest, newKey } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    const key = await newKey({ environments: ['prod', 'test'] });
    const headers = (extra: Record<string, string>) => ({
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
      ...extra,
    });

    const rest = await app.request('/api/tools/call/svar__default', {
      method: 'POST',
      headers: headers({ 'genai-environment': 'test' }),
      body: JSON.stringify({ query: 'Hei' }),
    });
    const restProd = await app.request('/api/tools/call/svar__default', {
      method: 'POST',
      headers: headers({}),
      body: JSON.stringify({ query: 'Hei' }),
    });
    const mcp = await app.request('/api/mcp', {
      method: 'POST',
      headers: headers({
        'genai-environment': 'test',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': 'svar__default',
      }),
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'svar__default', arguments: { query: 'Hei' } },
      }),
    });
    const a2a = await app.request('/a2a/svar__default', {
      method: 'POST',
      headers: { ...headers({ 'genai-environment': 'test' }), authorization: 'Bearer kari' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hei' }] } },
      }),
    });
    const refusedA2a = await app.request('/a2a/svar__default', {
      method: 'POST',
      headers: { ...headers({ 'genai-environment': 'staging' }), authorization: 'Bearer kari' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: { message: { messageId: 'm1', role: 'ROLE_USER', parts: [{ text: 'Hei' }] } },
      }),
    });

    expect(rest.status).toBe(200);
    expect(rest.headers.get('genai-service-version')).toBe('2');
    expect(rest.headers.get('genai-environment')).toBe('test');
    expect(restProd.headers.get('genai-service-version')).toBe('1');
    expect(mcp.status).toBe(200);
    expect(mcp.headers.get('genai-service-version')).toBe('2');
    expect(mcp.headers.get('genai-environment')).toBe('test');
    expect(a2a.status).toBe(200);
    expect(await a2a.json()).toMatchObject({
      result: { task: { metadata: { serviceVersion: 2, environment: 'test' } } },
    });
    expect(refusedA2a.status).toBe(409);
  });
});

describe('promoting and rolling back', () => {
  it('promotes test to prod in one audited action with a reason, without publishing', async () => {
    const { platform, admin, call, publish, environments, addTest, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');

    const promoted = await call(`${environments}/prod/promote`, { body: {}, reason });

    expect(promoted.status).toBe(200);
    expect(promoted.headers.get('genai-task')).toBeTruthy();
    expect(await versionRun()).toMatchObject({ version: '2', environment: 'prod' });
    expect(await platform.definitions.versions('Service', digdir, 'svar')).toHaveLength(2);
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({
        action: 'platform.service.environments.promote',
        outcome: 'applied',
        reason,
      }),
    );
  });

  it('rolls prod back to the version it ran before, without publishing', async () => {
    const { platform, call, publish, environments, addTest, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    await call(`${environments}/prod/promote`, { body: {}, reason });

    const rolledBack = await call(`${environments}/prod/rollback`, { body: {}, reason });

    expect(rolledBack.status).toBe(200);
    expect(await versionRun()).toMatchObject({ version: '1', environment: 'prod' });
    expect(await platform.definitions.versions('Service', digdir, 'svar')).toHaveLength(2);
  });

  it('rolls an environment back to a named published version and refuses one that is not', async () => {
    const { call, publish, environments, addTest, versionRun } = await boot();
    await publish('Første.');
    await publish('Andre.');
    await addTest();
    await publish('Tredje.');

    const named = await call(`${environments}/prod/rollback`, { body: { version: 1 }, reason });
    const unknown = await call(`${environments}/prod/rollback`, { body: { version: 7 }, reason });

    expect(named.status).toBe(200);
    expect(await versionRun()).toMatchObject({ version: '1' });
    expect(unknown.status).toBe(400);
  });

  it('refuses to promote or roll back while prod is the only environment', async () => {
    const { call, publish, environments, versionRun } = await boot();
    await publish('Første.');
    await publish('Andre.');

    const promoted = await call(`${environments}/prod/promote`, { body: { from: 'prod' }, reason });
    const rolledBack = await call(`${environments}/prod/rollback`, {
      body: { version: 1 },
      reason,
    });
    await publish('Tredje.');

    expect(promoted.status).toBe(409);
    expect(rolledBack.status).toBe(409);
    expect(await versionRun()).toMatchObject({ version: '3', environment: 'prod' });
  });

  it('refuses an environment path that is not a name, such as __proto__', async () => {
    const { call, publish, environments, addTest } = await boot();
    await publish('Første.');
    await addTest();

    const promoted = await call(`${environments}/__proto__/promote`, { body: {}, reason });
    const rolledBack = await call(`${environments}/__proto__/rollback`, {
      body: { version: 1 },
      reason,
    });
    const fromProto = await call(`${environments}/prod/promote`, {
      body: { from: '__proto__' },
      reason,
    });
    const removed = await call(`${environments}/constructor`, { method: 'DELETE', reason });

    expect(promoted.status).toBe(400);
    expect(rolledBack.status).toBe(400);
    expect(fromProto.status).toBe(400);
    expect(removed.status).toBe(404);
  });

  it('needs manage-services to promote or roll back', async () => {
    const { call, publish, environments, addTest } = await boot();
    await publish('Første.');
    await addTest();

    expect(
      (await call(`${environments}/prod/promote`, { body: {}, reason, as: 'lise' })).status,
    ).toBe(403);
    expect(
      (await call(`${environments}/prod/rollback`, { body: { version: 1 }, reason, as: 'lise' }))
        .status,
    ).toBe(403);
  });
});

describe('removing an environment', () => {
  it('refuses to remove the last one while prod is behind, and lets prod follow publishes again after promoting', async () => {
    const { call, publish, environments, addTest, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');

    const behind = await call(`${environments}/test`, { method: 'DELETE', reason });
    await call(`${environments}/prod/promote`, { body: {}, reason });
    const removed = await call(`${environments}/test`, { method: 'DELETE', reason });
    await publish('Tredje.');

    expect(behind.status).toBe(409);
    expect(removed.status).toBe(200);
    expect(await versionRun()).toMatchObject({ version: '3', environment: 'prod' });
    expect((await call(`${environments}/prod`, { method: 'DELETE', reason })).status).toBe(400);
  });
});

describe('runs and usage per environment', () => {
  it('records the environment on the run and filters the run log and usage by it', async () => {
    const { platform, call, publish, addTest, versionRun } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    const prod = await versionRun();
    const test = await versionRun({ 'GenAI-Environment': 'test' });

    const task = await platform.kernel.task(people.kari as Principal, test.task);
    const testRuns = (await (await call(`/tenants/${digdir}/tasks?environment=test`)).json()) as {
      data: { id: string; environment: string; version: number }[];
    };
    const prodRuns = (await (await call(`/tenants/${digdir}/tasks?environment=prod`)).json()) as {
      data: { id: string }[];
    };
    const usage = (await (await call(`/tenants/${digdir}/usage`)).json()) as {
      byEnvironment: { environment: string; usage: { runs: number } }[];
    };
    const testUsage = (await (await call(`/tenants/${digdir}/usage?environment=test`)).json()) as {
      totals: { runs: number };
      environment: string;
    };

    expect(task.service.environment).toBe('test');
    expect(testRuns.data).toEqual([
      expect.objectContaining({ id: test.task, environment: 'test', version: 2 }),
    ]);
    expect(prodRuns.data.map((r) => r.id)).toEqual([prod.task]);
    expect(usage.byEnvironment).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          environment: 'prod',
          usage: expect.objectContaining({ runs: 1 }),
        }),
        expect.objectContaining({
          environment: 'test',
          usage: expect.objectContaining({ runs: 1 }),
        }),
      ]),
    );
    expect(testUsage).toMatchObject({ environment: 'test', totals: { runs: 1 } });
  });
});

describe('environment history', () => {
  const history = async (
    call: (path: string, init?: { as?: string }) => Response | Promise<Response>,
    query = '',
    as = 'kari',
  ) => {
    const res = await call(`/tenants/${digdir}/services/svar/environment-history${query}`, { as });
    return {
      status: res.status,
      body: (await res.json()) as { data: Record<string, unknown>[]; total: number },
    };
  };

  it('lists additions, promotions and rollbacks per environment, newest first, with who and why', async () => {
    const { call, publish, environments, addTest } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    await call(`${environments}/prod/promote`, { body: {}, reason });
    await call(`${environments}/prod/rollback`, { body: {}, reason: 'Andre versjon svarte feil' });

    const { status, body } = await history(call, '', 'lise');

    expect(status).toBe(200);
    expect(body.total).toBe(3);
    expect(body.data).toEqual([
      expect.objectContaining({
        environment: 'prod',
        action: 'rolled-back',
        version: 1,
        previousVersion: 2,
        by: 'employee:test:kari',
        reason: 'Andre versjon svarte feil',
      }),
      expect.objectContaining({
        environment: 'prod',
        action: 'promoted',
        from: 'test',
        version: 2,
        previousVersion: 1,
        reason,
      }),
      expect.objectContaining({ environment: 'test', action: 'added', version: null }),
    ]);
    expect(body.data[0]?.at).toEqual(expect.any(String));
  });

  it('filters the history to one environment and pages it with limit', async () => {
    const { call, publish, environments, addTest } = await boot();
    await publish('Første.');
    await addTest();
    await publish('Andre.');
    await call(`${environments}/prod/promote`, { body: {}, reason });
    await call(`${environments}/prod/rollback`, { body: {}, reason });

    const prod = await history(call, '?environment=prod&limit=1');
    const invalid = await history(call, '?environment=__proto__');

    expect(prod.body.total).toBe(2);
    expect(prod.body.data.map((e) => e.action)).toEqual(['rolled-back']);
    expect(invalid.status).toBe(400);
  });

  it("never shows one organisation's environment history to another", async () => {
    const { call, publish, addTest } = await boot();
    await publish('Første.');
    await addTest();

    expect((await history(call, '', 'ola')).status).toBe(404);
  });

  it('infers what changed from versions saved before changes were recorded', () => {
    const at = '2026-11-01T10:00:00.000Z';
    const saved = (environments: unknown, deleted = false) => ({
      spec: { environments },
      deleted,
      at,
      by: 'employee:test:kari',
      reason,
    });

    const events = environmentEvents([
      saved({ prod: { version: 1 }, test: {} }),
      saved({ prod: { version: 2, previousVersion: 1 }, test: {} }),
      saved({ prod: {} }, true),
    ]);

    expect(events.map((e) => [e.environment, e.action, e.version])).toEqual([
      ['test', 'removed', null],
      ['prod', 'changed', 2],
      ['test', 'added', null],
    ]);
  });
});
