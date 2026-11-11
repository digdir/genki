import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import {
  apiKeyDigest,
  createAuthenticator,
  LEGACY_KEY_ISSUER,
  lockdownUserScope,
  testRunnerScope,
  trustedEntraScope,
} from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import type { EnvironmentTier } from '@genai/composition';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform, platformModules } from './composition.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import { refusedAction, rights, rightsOf } from './rights.js';
import { InMemoryTenantApiKeys, portalAdminHandlers } from './routes/portal-routes.js';
import { testRunnerRefusedType, testRunnerScopeType, testRunnerView } from './test-runner.js';
import { configuredCredentialScope, mayUseModels, readOnlyInLockdown } from './lockdown.js';
import { kernelTaskReader } from './timeline.js';
import { keyScopeType } from './tenant-gate.js';
import { digdir, files, other, testService } from './testkit.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const reason = 'Røyktest etter utrulling';

const testRunner: Principal = {
  kind: 'agency-system',
  issuer: LEGACY_KEY_ISSUER,
  subject: 'k',
  tenant: digdir,
  scopes: [testRunnerScope],
};

const people: Record<string, Principal> = {
  eva: {
    kind: 'employee',
    issuer: 'test',
    subject: 'eva',
    tenant: digdir,
    scopes: [trustedEntraScope],
  },
  system: { kind: 'agency-system', issuer: 'test', subject: 'fagsystem', tenant: digdir },
  user: {
    kind: 'employee',
    issuer: 'test',
    subject: 'una',
    tenant: digdir,
    scopes: [lockdownUserScope],
  },
};

const completion = (body: Record<string, unknown>) =>
  body.stream
    ? {
        status: 200,
        sse: [
          {
            data: {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt',
              choices: [{ index: 0, delta: { content: 'Svar.' }, finish_reason: 'stop' }],
            },
          },
          {
            data: {
              id: 'c',
              object: 'chat.completion.chunk',
              created: 0,
              model: 'gpt',
              choices: [],
              usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 },
            },
          },
          { data: '[DONE]' },
        ],
      }
    : {
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

const boot = async ({
  lockdown = true,
  tier = 'test',
}: { lockdown?: boolean; tier?: EnvironmentTier } = {}) => {
  const model = await fakeHttp(completion);
  servers.push(model);
  const keys = new InMemoryTenantApiKeys();
  const authenticator = createAuthenticator({ apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
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
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            families: { openai: '' },
            baseURL: `${model.url}/v1`,
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [
          {
            id: 'fake/gpt',
            endpoint: 'fake',
            deployment: 'gpt',
            residency: 'norway',
            capabilities: ['stream', 'json-schema'],
          },
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: { 'fake/gpt': { inputPerThousand: 1, outputPerThousand: 2 } },
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p, skill, flow) => new InMemoryDefinitionStore(p, undefined, skill, flow),
    configurables: { store: configEntries, scheduleIntervalMs: 0 },
    modules: platformModules,
    policy: { decide: async () => ({ allow: true }) },
    apiKeys: keys,
    environmentTier: tier,
    ...(lockdown ? { lockdown: { configuredKeys: new Set<string>() } } : {}),
    authenticate: async (request) => {
      const person = people[request.headers.get('authorization')?.slice(7) ?? ''];
      if (person) return { principal: person };
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  for (const id of ['klarsprak', 'annen'])
    await platform.definitions.publish(testService(id), 'test', 'test', files);
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
      lockdown,
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
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': reason,
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const createKey = (as: string, body: Record<string, unknown>) =>
    send(`/tenants/${digdir}/api-keys`, as, {
      body: {
        name: 'Røyktest',
        agents: ['klarsprak'],
        expiresInDays: 30,
        callsPerMinute: 600,
        ...body,
      },
    });
  const testRunnerKey = async (agents = ['klarsprak']) => {
    const created = await createKey('eva', { testRunner: true, agents });
    expect(created.status).toBe(201);
    return ((await created.json()) as { key: string }).key;
  };
  return { app, send, keys, model, createKey, testRunnerKey };
};

const problemType = async (response: Response) =>
  ((await response.json()) as { type?: string }).type;

const throwaway = (id: string) => ({ definition: testService(id), files });

describe('creating a test-runner key', () => {
  it('gives the grant to an admitted Entra login in lockdown on the test tier', async () => {
    const { createKey } = await boot();

    const created = await createKey('eva', { testRunner: true });

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({ apiKey: { testRunner: true } });
  });

  it('shows the key as admitted to models in lockdown when an Entra login made it', async () => {
    const { send, createKey } = await boot();
    const id = (
      (await (await createKey('eva', { testRunner: true })).json()) as {
        apiKey: { id: string };
      }
    ).apiKey.id;

    const access = (await (await send(`/tenants/${digdir}/access`, 'eva')).json()) as {
      keys: { id: string; testRunner: boolean; modelsInLockdown?: boolean }[];
    };

    expect(access.keys.find((k) => k.id === id)).toMatchObject({
      testRunner: true,
      modelsInLockdown: true,
    });
  });

  it.each([
    ['no expiry', { expiresInDays: undefined }, 'expiresInDays'],
    ['an expiry over 90 days', { expiresInDays: 91 }, 'expiresInDays'],
    ['no rate limit', { callsPerMinute: undefined }, 'callsPerMinute'],
  ])('refuses the grant with %s', async (_name, limits, path) => {
    const { createKey, keys } = await boot();

    const refused = await createKey('eva', { testRunner: true, ...limits });

    expect(refused.status).toBe(400);
    expect(await refused.json()).toMatchObject({ errors: [{ path }] });
    expect(await keys.list(digdir)).toHaveLength(0);
  });

  it('refuses the grant outside lockdown', async () => {
    const { createKey } = await boot({ lockdown: false });

    const refused = await createKey('eva', { testRunner: true });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerRefusedType);
  });

  it('refuses the grant outside the test tier', async () => {
    const { createKey } = await boot({ tier: 'production' });

    const refused = await createKey('eva', { testRunner: true });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerRefusedType);
  });

  it('refuses the grant to a creator who is not an admitted Entra login', async () => {
    const { createKey } = await boot();

    const refused = await createKey('system', { testRunner: true });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerRefusedType);
  });

  it('refuses the grant to a lockdown user who is not an operator', async () => {
    const { createKey } = await boot();

    const refused = await createKey('user', { testRunner: true });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerRefusedType);
  });

  it('says through the access view whether the caller may give the grant here', async () => {
    const allowed = await boot();
    const production = await boot({ tier: 'production' });
    const view = async (b: typeof allowed, as: string) =>
      (
        (await (await b.send(`/tenants/${digdir}/access`, as)).json()) as {
          testRunnerKeys: boolean;
        }
      ).testRunnerKeys;

    expect(await view(allowed, 'eva')).toBe(true);
    expect(await view(allowed, 'system')).toBe(false);
    expect(await view(allowed, 'user')).toBe(false);
    expect(await view(production, 'eva')).toBe(false);
  });
});

describe('rotating a test-runner key', () => {
  it('drops the grant, which is only given on creation', async () => {
    const { send, createKey } = await boot();
    const created = (await (await createKey('eva', { testRunner: true })).json()) as {
      apiKey: { id: string };
    };

    const rotated = await send(`/tenants/${digdir}/api-keys/${created.apiKey.id}/rotate`, 'eva', {
      body: {},
    });

    expect(rotated.status).toBe(201);
    expect(await rotated.json()).toMatchObject({ apiKey: { testRunner: false } });
  });
});

describe('a stored test-runner grant', () => {
  it('is ignored when the server is not in lockdown on the test tier', async () => {
    for (const setting of [{ lockdown: false }, { tier: 'production' as const }]) {
      const { send, keys } = await boot(setting);
      await keys.add({
        id: 'stored',
        name: 'Lagret',
        digest: apiKeyDigest('gp_stored-test-runner'),
        tenant: digdir,
        scopes: ['query'],
        datasets: [],
        agents: ['klarsprak'],
        admittedInLockdown: true,
        testRunner: true,
      });

      const read = await send(`/tenants/${digdir}/services`, 'gp_stored-test-runner');
      const validate = await send('/definitions/validate', 'gp_stored-test-runner', {
        body: testService('smoke-x'),
      });

      expect(read.status).toBe(403);
      expect(await problemType(read)).toBe(keyScopeType);
      expect(validate.status).toBe(401);
    }
  });
});

describe('a test-runner key in its own tenant', () => {
  it('reads the timeline of a run someone else started, with provider details and token stats', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();
    const run = await send('/v1/chat/completions', 'eva', {
      body: { model: 'klarsprak__default', messages: [{ role: 'user', content: 'Hei' }] },
    });
    expect(run.status).toBe(200);
    const task = run.headers.get('genai-task');

    const timeline = await send(`/tenants/${digdir}/tasks/${task}/timeline`, key);

    expect(timeline.status).toBe(200);
    const body = (await timeline.json()) as {
      steps: { type: string; raw?: unknown }[];
      stats: { inputTokens: number; byModel: unknown[] };
    };
    expect(body.steps.find((s) => s.type === 'model')?.raw).toMatchObject({
      model: { kind: 'model', id: 'fake/gpt' },
      usage: { inputTokens: 12, outputTokens: 3 },
    });
    expect(body.stats).toMatchObject({ inputTokens: 12, byModel: [{ model: 'fake/gpt' }] });
    expect(body).toMatchObject({
      caller: 'employee',
      inputTokens: 12,
      outputTokens: 3,
      costMicroNok: 18000,
      priced: true,
    });
  });

  it('holds all five platform rights in its own tenant and none in another', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const me = (await (await send('/me', key)).json()) as Record<string, unknown>;

    expect(JSON.stringify(me)).toContain('view-usage');
    expect(rightsOf(testRunner, digdir)).toEqual(new Set(rights));
    expect(rightsOf(testRunner, other)).toEqual(new Set());
  });

  it('gets 404 on another tenant', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const services = await send(`/tenants/${other}/services`, key);
    const timeline = await send(`/tenants/${other}/tasks/any/timeline`, key);

    expect(services.status).toBe(404);
    expect(timeline.status).toBe(404);
  });

  it('may publish and archive a smoke- service', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const published = await send('/definitions', key, { body: throwaway('smoke-throwaway') });
    const archived = await send(`/tenants/${digdir}/services/smoke-throwaway/lifecycle`, key, {
      method: 'PUT',
      body: { state: 'archived' },
    });

    expect(published.status).toBe(201);
    expect(archived.status).toBe(200);
  });

  it('is refused publishing over a service without the smoke- prefix', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const refused = await send('/definitions', key, { body: throwaway('klarsprak') });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
  });

  it('is refused archiving a service without the smoke- prefix', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const refused = await send(`/tenants/${digdir}/services/klarsprak/lifecycle`, key, {
      method: 'PUT',
      body: { state: 'archived' },
    });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
  });

  it('may save and delete the draft of a smoke- service', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();
    await send('/definitions', key, { body: throwaway('smoke-utkast') });

    const saved = await send(`/tenants/${digdir}/services/smoke-utkast/draft`, key, {
      method: 'PUT',
      body: { definition: testService('smoke-utkast'), files },
    });
    const deleted = await send(`/tenants/${digdir}/services/smoke-utkast/draft`, key, {
      method: 'DELETE',
      body: {},
    });

    expect(saved.status).toBe(200);
    expect(deleted.status).toBe(200);
  });

  it('opens a draft that is behind without rebasing it', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();
    await send('/definitions', key, { body: throwaway('smoke-bak') });
    await send(`/tenants/${digdir}/services/smoke-bak/draft`, key, {
      method: 'PUT',
      body: { definition: testService('smoke-bak'), files, baseVersion: 1 },
    });
    const newer = testService('smoke-bak');
    await send('/definitions', key, {
      body: { definition: { ...newer, metadata: { ...newer.metadata, name: 'Nyere' } }, files },
    });

    const opened = await send(`/tenants/${digdir}/services/smoke-bak/draft?rebase=clean`, key);

    expect(opened.status).toBe(200);
  });

  it('is refused saving the draft of a service without the smoke- prefix', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const refused = await send(`/tenants/${digdir}/services/klarsprak/draft`, key, {
      method: 'PUT',
      body: { definition: testService('klarsprak'), files },
    });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
  });

  it('may validate a definition', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const validated = await send('/definitions/validate', key, { body: throwaway('klarsprak') });

    expect(validated.status).toBe(200);
  });

  it('may run the playground on a published service its grants reach', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey([]);

    const run = await send(`/tenants/${digdir}/playground/runs`, key, {
      body: {
        setup: { service: { id: 'klarsprak', version: 1 }, output: 'text' },
        input: { text: 'Hei' },
      },
    });

    expect(run.status).toBe(200);
  });

  it('is refused the playground on a service it is not bound to', async () => {
    const { send, testRunnerKey, model } = await boot();
    const key = await testRunnerKey();

    const refused = await send(`/tenants/${digdir}/playground/runs`, key, {
      body: {
        setup: { service: { id: 'annen', version: 1 }, output: 'text' },
        input: { text: 'Hei' },
      },
    });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
    expect(model.seen).toHaveLength(0);
  });

  it('is refused the playground when the compared setup is a service it is not bound to', async () => {
    const { send, testRunnerKey, model } = await boot();
    const key = await testRunnerKey();

    const refused = await send(`/tenants/${digdir}/playground/runs`, key, {
      body: {
        setup: { service: { id: 'klarsprak', version: 1 }, output: 'text' },
        compareWith: { service: { id: 'annen', version: 1 }, output: 'text' },
        input: { text: 'Hei' },
      },
    });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
    expect(model.seen).toHaveLength(0);
  });

  it('may run a smoke- draft in the playground', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey([]);

    const run = await send(`/tenants/${digdir}/playground/runs`, key, {
      body: {
        setup: {
          service: { id: 'smoke-x', version: 'draft', definition: testService('smoke-x'), files },
          output: 'text',
        },
        input: { text: 'Hei' },
      },
    });

    expect(run.status).toBe(200);
  });

  it('is refused a smoke- draft run whose definition is another service', async () => {
    const { send, testRunnerKey, model } = await boot();
    const key = await testRunnerKey([]);

    const refused = await send(`/tenants/${digdir}/playground/runs`, key, {
      body: {
        setup: {
          service: { id: 'smoke-x', version: 'draft', definition: testService('klarsprak') },
          output: 'text',
        },
        input: { text: 'Hei' },
      },
    });

    expect(refused.status).toBe(403);
    expect(model.seen).toHaveLength(0);
  });

  it('is refused a draft run of a bound service without the smoke- prefix', async () => {
    const { send, testRunnerKey, model } = await boot();
    const key = await testRunnerKey([]);

    const refused = await send(`/tenants/${digdir}/playground/runs`, key, {
      body: {
        setup: {
          service: { id: 'klarsprak', version: 'draft', definition: testService('klarsprak') },
          output: 'text',
        },
        input: { text: 'Hei' },
      },
    });

    expect(refused.status).toBe(403);
    expect(model.seen).toHaveLength(0);
  });

  it.each([
    ['support sessions', 'POST', '/support-sessions', { tenant: digdir, reason }],
    ['key creation', 'POST', `/tenants/${digdir}/api-keys`, { name: 'Ny' }],
    ['secret values', 'PUT', `/tenants/${digdir}/secrets/token`, { value: 'hemmelig' }],
    ['Maskinporten clients', 'POST', `/tenants/${digdir}/maskinporten-clients`, {}],
    ['settings writes', 'PUT', `/tenants/${digdir}/settings/search.topK`, { value: 3 }],
    [
      'batch estimates',
      'POST',
      `/tenants/${digdir}/services/klarsprak/batch-runs/estimate`,
      { rows: 10 },
    ],
  ])('is refused %s', async (_name, method, path, body) => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const refused = await send(path, key, { method, body });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
  });
});

describe('a test-runner key on operator routes', () => {
  it('reads GET /operator/tenants', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    expect((await send('/operator/tenants', key)).status).toBe(200);
  });

  it.each([
    ['audit', '/operator/audit'],
    ['onboarding requests', '/operator/onboarding/requests'],
    ['tenant definitions', `/operator/tenants/${digdir}/definitions`],
    ['usage', '/operator/usage'],
    ['support sessions', '/operator/support-sessions'],
    ['running tasks', '/operator/running-tasks'],
    ['label queue', '/operator/quality/label-queue'],
    ['secret names', '/operator/knowledge/secrets'],
    ['an encoded slash', '/operator/plugins/..%2Faudit'],
    ['a trailing segment', `/operator/tenants/${digdir}`],
  ])('is refused reading %s', async (_name, path) => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const refused = await send(path, key);

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
  });

  it('is refused a write on an operator route', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const refused = await send('/operator/tenants', key, {
      body: { orgNumber: other, name: 'Annen' },
    });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
  });

  it.each([
    ['POST', '/operator/plugins/manifest-check'],
    ['POST', '/operator/models/refresh'],
    ['DELETE', '/operator/plugins/any'],
    ['PUT', '/operator/tenants/999888777/private-networks'],
  ])('is refused %s %s', async (method, path) => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const refused = await send(path, key, { method, body: {} });

    expect(refused.status).toBe(403);
    expect(await problemType(refused)).toBe(testRunnerScopeType);
  });

  it('gets no rights in another tenant from the operator view', async () => {
    const { send, testRunnerKey } = await boot();
    const key = await testRunnerKey();

    const services = await send(`/tenants/${other}/services`, key);
    const definitions = await send(`/tenants/${other}/definitions`, key);

    expect(services.status).toBe(404);
    expect(definitions.status).toBe(404);
  });
});

describe('a key without the test-runner grant', () => {
  it('still reaches no tenant route and no platform route', async () => {
    const { send, createKey } = await boot();
    const key = ((await (await createKey('eva', {})).json()) as { key: string }).key;

    const read = await send(`/tenants/${digdir}/services`, key);
    const operator = await send('/operator/tenants', key);
    const validate = await send('/definitions/validate', key, { body: testService('smoke-x') });

    expect(read.status).toBe(403);
    expect(await problemType(read)).toBe(keyScopeType);
    expect(operator.status).toBe(401);
    expect(validate.status).toBe(401);
  });
});

describe('the admin action rule for test-runner keys', () => {
  const key = testRunner;

  it('allows only publish, lifecycle and draft changes on smoke- definitions', () => {
    const smoke = { tenant: digdir, id: 'smoke-x', service: 'smoke-x' };
    const definition = { metadata: { id: 'smoke-x' } };

    expect(refusedAction(key, 'platform.service.publish', digdir, { definition })).toBeUndefined();
    expect(refusedAction(key, 'platform.service.lifecycle', digdir, smoke)).toBeUndefined();
    expect(refusedAction(key, 'platform.service.draft.save', digdir, smoke)).toBeUndefined();
    expect(refusedAction(key, 'platform.service.draft.delete', digdir, smoke)).toBeUndefined();
    expect(
      refusedAction(key, 'platform.service.publish', digdir, {
        definition: { metadata: { id: 'klarsprak' } },
      }),
    ).toEqual({ kind: 'test-runner' });
    expect(refusedAction(key, 'platform.service.draft.rebase', digdir, smoke)).toEqual({
      kind: 'test-runner',
    });
    expect(refusedAction(key, 'platform.apikeys.create', digdir, smoke)).toEqual({
      kind: 'test-runner',
    });
  });
});

describe('the principal a test-runner key acts as', () => {
  const request = (method: string, path: string) =>
    new Request(`http://genki.test${path}`, { method });
  const admitted = { ...testRunner, scopes: [testRunnerScope, configuredCredentialScope] };

  it('is a read-only operator without model admission on GET /operator only', () => {
    const view = testRunnerView(admitted, request('GET', '/operator/tenants'), true);

    expect(view.kind).toBe('operator');
    expect(view.scopes).toEqual([testRunnerScope]);
    expect(readOnlyInLockdown(view)).toBe(true);
    expect(mayUseModels(view)).toBe(false);
  });

  it.each([
    '/operator/tenants?x=1',
    '/operator/plugins',
    '/operator/plugins/some-plugin',
    '/operator/catalog/model/fake',
    '/operator/knowledge/engines',
  ])('is an operator on the platform configuration route %s', (path) => {
    expect(testRunnerView(admitted, request('GET', path), true).kind).toBe('operator');
  });

  it.each([
    '/operator/audit',
    '/operator/onboarding/requests',
    `/operator/tenants/${digdir}/definitions`,
    '/operator/usage',
    '/operator/support-sessions',
    '/operator/tasks',
    '/operator/tenants/',
    '/operator/tenants/x',
    '/operator/models/../audit',
    '/operator/plugins/..%2Faudit',
    '/operator/plugins/%2E%2E/audit',
    '/operator/catalog%2F..%2Faudit',
    '/operator/plugins/',
    '/operator/tracing/x?y=/operator/tracing',
    '/x/operator/tenants',
  ])('is not an operator on %s', (path) => {
    expect(testRunnerView(admitted, request('GET', path), true).kind).toBe('agency-system');
  });

  it('is never an operator outside GET /operator', () => {
    for (const [method, path] of [
      ['POST', '/operator/tenants'],
      ['HEAD', '/operator/tenants'],
      ['GET', `/tenants/${digdir}/services`],
      ['GET', '/definitions'],
    ] as const)
      expect(testRunnerView(admitted, request(method, path), true).kind).toBe('agency-system');
  });

  it('loses the grant when the server is not in lockdown on the test tier', () => {
    const view = testRunnerView(admitted, request('GET', '/operator/tenants'), false);

    expect(view).toMatchObject({ kind: 'agency-system', scopes: [configuredCredentialScope] });
  });

  it('loses the grant when it is not an API key', () => {
    const person: Principal = {
      ...people.eva,
      scopes: [trustedEntraScope, testRunnerScope],
    } as Principal;

    expect(testRunnerView(person, request('GET', '/operator/tenants'), true)).toMatchObject({
      kind: 'employee',
      scopes: [trustedEntraScope],
    });
  });
});

describe('the key creation handler', () => {
  const eva = people.eva as Principal;
  const input = {
    tenant: digdir,
    reason,
    id: 'k1',
    name: 'Røyktest',
    digest: 'ab'.repeat(32),
    testRunner: true,
  };

  it('stores the grant only when the environment allows it, whatever the request carries', async () => {
    const apiKeys = new InMemoryTenantApiKeys();
    const create = portalAdminHandlers({ apiKeys, testRunnerKeys: false })[
      'platform.apikeys.create'
    ];

    await create?.(input, eva);

    expect((await apiKeys.list(digdir))[0]).not.toHaveProperty('testRunner');
  });

  it('stores the grant only for a trusted Entra login', async () => {
    const apiKeys = new InMemoryTenantApiKeys();
    const create = portalAdminHandlers({ apiKeys, testRunnerKeys: true })[
      'platform.apikeys.create'
    ];

    await create?.(input, people.user as Principal);
    await create?.({ ...input, id: 'k2', digest: 'cd'.repeat(32) }, eva);

    const stored = await apiKeys.list(digdir);
    expect(stored.find((k) => k.id === 'k1')).not.toHaveProperty('testRunner');
    expect(stored.find((k) => k.id === 'k2')).toMatchObject({ testRunner: true });
  });
});
