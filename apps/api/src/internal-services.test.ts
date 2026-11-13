import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { createAuthenticator, trustedEntraScope } from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform, platformModules } from './composition.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { kernelTaskReader } from './timeline.js';
import { digdir, files, other, testService } from './testkit.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const people: Record<string, Principal> = {
  eva: {
    kind: 'employee',
    issuer: 'test',
    subject: 'eva',
    tenant: digdir,
    scopes: [trustedEntraScope],
  },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  operator: {
    kind: 'operator',
    issuer: 'test',
    subject: 'drift',
    tenant: digdir,
    scopes: [trustedEntraScope],
  },
};

const internal = (id: string, extra: Record<string, unknown> = {}) => {
  const definition = testService(id);
  return {
    ...definition,
    spec: { ...definition.spec, exposure: { openai: true }, visibility: 'internal', ...extra },
  };
};

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

const boot = async () => {
  const model = await fakeHttp(() => answer);
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
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p, skill, flow) => new InMemoryDefinitionStore(p, undefined, skill, flow),
    configurables: { store: configEntries, scheduleIntervalMs: 0 },
    modules: platformModules,
    policy: { decide: async () => ({ allow: true }) },
    apiKeys: keys,
    environmentTier: 'test',
    lockdown: { configuredKeys: new Set<string>() },
    authenticate: async (request) => {
      const person = people[request.headers.get('authorization')?.slice(7) ?? ''];
      if (person) return { principal: person };
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  await platform.definitions.publish(testService('klarsprak'), 'test', 'test', files);
  await platform.definitions.publish(internal('smoke'), 'test', 'test', files);
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
      lockdown: true,
    },
  });
  platform.mount(app, admin);
  const send = (path: string, as: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': 'Røyktest etter utrulling',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const key = async (body: Record<string, unknown> = {}) => {
    const created = await send(`/tenants/${digdir}/api-keys`, 'eva', {
      body: { name: 'Nøkkel', expiresInDays: 30, callsPerMinute: 600, ...body },
    });
    expect(created.status).toBe(201);
    return ((await created.json()) as { key: string }).key;
  };
  const keyId = async (body: Record<string, unknown>) => {
    const created = await send(`/tenants/${digdir}/api-keys`, 'eva', {
      body: { name: 'Nøkkel', expiresInDays: 30, callsPerMinute: 600, ...body },
    });
    return ((await created.json()) as { apiKey: { id: string } }).apiKey.id;
  };
  const run = (as: string, service: string) =>
    send('/v1/chat/completions', as, {
      body: { model: `${service}__default`, messages: [{ role: 'user', content: 'Hei' }] },
    });
  return { app, send, key, keyId, run, platform };
};

const ids = async (response: Response) =>
  ((await response.json()) as { data: { id: string }[] }).data.map((d) => d.id);

const modelIds = async (response: Response) =>
  ((await response.json()) as { data: { _service?: string }[] }).data.map((d) => d._service);

describe('an internal service', () => {
  it('is left out of the tenant service list for a tenant admin', async () => {
    const { send } = await boot();

    const listed = await send(`/tenants/${digdir}/services`, 'eva');

    expect(listed.status).toBe(200);
    expect(await ids(listed)).toEqual(['klarsprak']);
  });

  it('is left out of the overview for a tenant admin', async () => {
    const { send } = await boot();

    const overview = (await (await send(`/tenants/${digdir}/overview`, 'eva')).json()) as {
      services: { id: string }[];
    };

    expect(overview.services.map((s) => s.id)).toEqual(['klarsprak']);
  });

  it('is left out of the tenant definition list for a tenant admin', async () => {
    const { send } = await boot();

    const listed = await send(`/tenants/${digdir}/definitions`, 'eva');

    expect(await ids(listed)).not.toContain('smoke');
  });

  it.each([
    `/tenants/${digdir}/services/smoke/lifecycle`,
    `/tenants/${digdir}/services/smoke/draft`,
    `/tenants/${digdir}/services/smoke/environments`,
    `/tenants/${digdir}/definitions/services/smoke`,
    `/tenants/${digdir}/definitions/services/smoke/versions/1`,
    `/services/by-name/smoke__default`,
  ])('answers 404 to a tenant admin at %s', async (path) => {
    const { send } = await boot();

    const read = await send(path, 'eva');

    expect(read.status).toBe(404);
  });

  it('answers a tenant admin the same as for a service that does not exist', async () => {
    const { send } = await boot();

    const hidden = await send(`/tenants/${digdir}/definitions/services/smoke`, 'eva');
    const missing = await send(`/tenants/${digdir}/definitions/services/finnes-ikke`, 'eva');

    expect(hidden.status).toBe(missing.status);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('is left out of the shared services when it is also shared', async () => {
    const { send, platform } = await boot();
    await platform.definitions.publish(
      internal('smoke', { availableTo: '*' }),
      'test',
      'test',
      files,
    );

    const shared = await send('/shared-services', 'ola');

    expect(await ids(shared)).not.toContain('smoke');
  });

  it('is listed and marked internal for an operator in the console', async () => {
    const { send } = await boot();

    const listed = (await (
      await send(`/operator/tenants/${digdir}/definitions`, 'operator')
    ).json()) as { data: { id: string; internal?: boolean }[] };

    expect(listed.data.find((d) => d.id === 'smoke')).toMatchObject({ internal: true });
    expect(listed.data.find((d) => d.id === 'klarsprak')?.internal).toBeUndefined();
  });

  it('opens for an operator in the console', async () => {
    const { send } = await boot();

    const read = await send(`/operator/tenants/${digdir}/definitions/services/smoke`, 'operator');

    expect(read.status).toBe(200);
  });

  it('is not a model for an API key without the test-runner grant', async () => {
    const { send, key } = await boot();
    const plain = await key();

    expect(await modelIds(await send('/v1/models', plain))).not.toContain('smoke');
  });

  it('cannot be run by an API key without the test-runner grant', async () => {
    const { run, key } = await boot();
    const plain = await key();

    const refused = await run(plain, 'smoke');

    expect(refused.status).toBe(404);
  });

  it('is a model the test-runner key lists and runs', async () => {
    const { send, run, key } = await boot();
    const runner = await key({ testRunner: true });

    expect(await modelIds(await send('/v1/models', runner))).toContain('smoke');
    expect((await run(runner, 'smoke')).status).toBe(200);
  });

  it('is shown to the test-runner key in the portal service list', async () => {
    const { send, key } = await boot();
    const runner = await key({ testRunner: true });

    expect(await ids(await send(`/tenants/${digdir}/services`, runner))).toContain('smoke');
  });

  it('is left out of the playground for a tenant admin and offered to the test-runner key', async () => {
    const { send, key } = await boot();
    const runner = await key({ testRunner: true });
    const services = async (as: string) =>
      (
        (await (await send(`/tenants/${digdir}/playground/options`, as)).json()) as {
          services: { id: string }[];
        }
      ).services.map((s) => s.id);

    expect(await services('eva')).not.toContain('smoke');
    expect(await services(runner)).toContain('smoke');
  });

  it('leaves its runs out of the log and usage for a tenant admin', async () => {
    const { send, run, key } = await boot();
    const runner = await key({ testRunner: true });
    const ran = await run(runner, 'smoke');
    const task = ran.headers.get('genai-task') ?? '';

    const log = (await (await send(`/tenants/${digdir}/tasks`, 'eva')).json()) as {
      data: { id: string }[];
    };
    const usage = (await (await send(`/tenants/${digdir}/usage`, 'eva')).json()) as {
      byService: { service: string }[];
    };
    const detail = await send(`/tenants/${digdir}/tasks/${task}`, 'eva');
    const seen = (await (await send(`/tenants/${digdir}/tasks`, runner)).json()) as {
      data: { id: string }[];
    };

    expect(task).not.toBe('');
    expect(log.data.map((t) => t.id)).not.toContain(task);
    expect(usage.byService.map((r) => r.service)).not.toContain('smoke');
    expect(detail.status).toBe(404);
    expect(seen.data.map((t) => t.id)).toContain(task);
  });

  it('keeps a draft of an internal service out of the draft list for a tenant admin', async () => {
    const { send, key } = await boot();
    const runner = await key({ testRunner: true });
    const saved = await send(`/tenants/${digdir}/services/smoke-utkast/draft`, runner, {
      method: 'PUT',
      body: { definition: internal('smoke-utkast'), files },
    });

    const drafts = await send(`/tenants/${digdir}/service-drafts`, 'eva');
    const own = await send(`/tenants/${digdir}/service-drafts`, runner);

    expect(saved.status).toBeLessThan(300);
    expect(await ids(drafts)).not.toContain('smoke-utkast');
    expect(await ids(own)).toContain('smoke-utkast');
  });
});

describe('publishing an internal service', () => {
  it('refuses a tenant admin who marks a service internal', async () => {
    const { send } = await boot();

    const refused = await send('/definitions', 'eva', {
      body: { definition: internal('hemmelig'), files },
    });

    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ errors: [{ path: 'spec.visibility' }] });
  });

  it('refuses a tenant admin who publishes over an internal service, and keeps it internal', async () => {
    const { send } = await boot();

    const refused = await send('/definitions', 'eva', {
      body: { definition: testService('smoke'), files },
    });
    const after = (await (
      await send(`/operator/tenants/${digdir}/definitions`, 'operator')
    ).json()) as { data: { id: string; internal?: boolean; latestVersion: number }[] };

    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ errors: [{ path: 'metadata.id' }] });
    expect(after.data.find((d) => d.id === 'smoke')).toMatchObject({
      internal: true,
      latestVersion: 1,
    });
  });

  it('lets the test-runner key publish an internal smoke- service', async () => {
    const { send, key } = await boot();
    const runner = await key({ testRunner: true });

    const published = await send('/definitions', runner, {
      body: { definition: internal('smoke-throwaway'), files },
    });

    expect(published.status).toBe(201);
  });
});

describe('runs, audit and drafts of an internal service', () => {
  it.each([
    ['GET', 'tasks/{task}'],
    ['GET', 'tasks/{task}/timeline'],
    ['GET', 'tasks/{task}/review'],
    ['POST', 'tasks/{task}/export'],
  ])('answers 404 to a tenant admin at %s %s for one of its runs', async (method, path) => {
    const { send, run, key } = await boot();
    const runner = await key({ testRunner: true });
    const task = (await run(runner, 'smoke')).headers.get('genai-task') ?? '';

    const read = await send(`/tenants/${digdir}/${path.replace('{task}', task)}`, 'eva', {
      method,
      ...(method === 'POST' ? { body: {} } : {}),
    });

    expect(task).not.toBe('');
    expect(read.status).toBe(404);
  });

  it('opens the timeline of its run for the test-runner key', async () => {
    const { send, run, key } = await boot();
    const runner = await key({ testRunner: true });
    const task = (await run(runner, 'smoke')).headers.get('genai-task') ?? '';

    expect((await send(`/tenants/${digdir}/tasks/${task}/timeline`, runner)).status).toBe(200);
  });

  it('leaves changes to it out of the audit log for a tenant admin', async () => {
    const { send, key } = await boot();
    const runner = await key({ testRunner: true });
    const published = await send('/definitions', runner, {
      body: { definition: internal('smoke-throwaway'), files },
    });
    const task = published.headers.get('genai-task') ?? '';
    const audit = async (as: string) =>
      (
        (await (await send(`/tenants/${digdir}/audit`, as)).json()) as {
          data: { task: string }[];
        }
      ).data.map((e) => e.task);

    expect(published.status).toBe(201);
    expect(await audit('eva')).not.toContain(task);
    expect(await audit(runner)).toContain(task);
    expect((await send(`/tenants/${digdir}/audit/${task}`, 'eva')).status).toBe(404);
  });

  it.each(['GET', 'PUT', 'DELETE'])(
    'answers 404 to a tenant admin at %s of a draft marked internal that was never published',
    async (method) => {
      const { send, key } = await boot();
      const runner = await key({ testRunner: true });
      await send(`/tenants/${digdir}/services/smoke-utkast/draft`, runner, {
        method: 'PUT',
        body: { definition: internal('smoke-utkast'), files },
      });

      const read = await send(`/tenants/${digdir}/services/smoke-utkast/draft`, 'eva', {
        method,
        ...(method === 'PUT' ? { body: { definition: testService('smoke-utkast'), files } } : {}),
      });

      expect(read.status).toBe(404);
    },
  );

  it('refuses a tenant admin who saves a draft marked internal', async () => {
    const { send } = await boot();

    const refused = await send(`/tenants/${digdir}/services/hemmelig/draft`, 'eva', {
      method: 'PUT',
      body: { definition: internal('hemmelig'), files },
    });

    expect(refused.status).toBe(422);
  });
});

describe('what an internal service does not give away', () => {
  it('answers an anonymous caller 401 at its paths, as for an id that does not exist', async () => {
    const { app } = await boot();

    const hidden = await app.request(`/tenants/${digdir}/services/smoke/environments`);
    const missing = await app.request(`/tenants/${digdir}/services/finnes-ikke/environments`);

    expect(hidden.status).toBe(401);
    expect(missing.status).toBe(401);
  });

  it('answers a tenant admin at its service path with the body of a missing service', async () => {
    const { send } = await boot();

    const hidden = await send(`/tenants/${digdir}/services/smoke/environments`, 'eva');
    const missing = await send(`/tenants/${digdir}/services/finnes-ikke/environments`, 'eva');

    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('does not name it when a tenant admin publishes one of its public names', async () => {
    const { send } = await boot();
    const definition = testService('annen');

    const refused = await send('/definitions', 'eva', {
      body: {
        definition: {
          ...definition,
          spec: { ...definition.spec, variants: [{ id: 'default', publicName: 'smoke__default' }] },
        },
        files,
      },
    });
    const body = JSON.stringify(await refused.json());

    expect(refused.status).toBe(422);
    expect(body).not.toContain('Service:');
    expect(body).not.toContain('/smoke');
  });

  it('refuses a tenant admin who validates a definition marked internal', async () => {
    const { send } = await boot();

    const refused = await send('/definitions/validate', 'eva', {
      body: { definition: internal('hemmelig'), files },
    });

    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({ errors: [{ path: 'spec.visibility' }] });
  });

  it('refuses a tenant admin whose import dry run publishes over it', async () => {
    const { send } = await boot();

    const refused = await send(`/tenants/${digdir}/import?dryRun=true`, 'eva', {
      body: {
        format: 'genai-tenant-export/v1',
        tenant: digdir,
        exportedAt: '2026-10-06T10:00:00.000Z',
        definitions: [{ definition: testService('smoke'), files }],
        settings: { values: {}, pins: {} },
      },
    });

    expect(refused.status).toBe(422);
  });

  it('leaves its test sets out for a tenant admin', async () => {
    const { send, platform } = await boot();
    await platform.evalStores.testSets.put({
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant: digdir, id: 'smoke-sett', name: 'Røyk', version: 1 },
      spec: { service: 'smoke', cases: [] },
    } as never);

    const sets = (await (await send(`/tenants/${digdir}/test-sets`, 'eva')).json()) as {
      data: { metadata: { id: string } }[];
    };

    expect(sets.data.map((x) => x.metadata.id)).not.toContain('smoke-sett');
  });

  it('answers a tenant admin at one of its test sets as for a test set that does not exist', async () => {
    const { send, platform } = await boot();
    await platform.evalStores.testSets.put({
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant: digdir, id: 'smoke-sett', name: 'Røyk', version: 1 },
      spec: { service: 'smoke', cases: [] },
    } as never);
    const at = async (id: string, method = 'GET', body?: unknown) => {
      const response = await send(`/tenants/${digdir}/test-sets/${id}`, 'eva', {
        method,
        ...(body ? { body } : {}),
      });
      return { status: response.status, body: JSON.stringify(await response.json()) };
    };
    const kase = { input: 'hei', expected: 'svar' };

    for (const [path, method, body] of [
      ['', 'GET', undefined],
      ['', 'PUT', { name: 'Ny' }],
      ['/cases', 'GET', undefined],
      ['/cases', 'POST', kase],
      ['/cases/a', 'PUT', kase],
      ['/cases/a', 'DELETE', undefined],
    ] as const) {
      const hidden = await at(`smoke-sett${path}`, method, body);
      const missing = await at(`finnes-ikke${path}`, method, body);
      expect(hidden.status, `${method} ${path}`).toBe(missing.status);
      expect(hidden.body.replaceAll('smoke-sett', 'finnes-ikke')).toBe(missing.body);
    }
    expect((await at('smoke-sett', 'GET')).status).toBe(404);
  });

  it('keeps one of its test sets unchanged when a tenant admin creates one with its id', async () => {
    const { send, platform } = await boot();
    await platform.evalStores.testSets.put({
      apiVersion: 'genai/v1',
      kind: 'TestSet',
      metadata: { tenant: digdir, id: 'smoke-sett', name: 'Røyk', version: 1 },
      spec: { service: 'smoke', cases: [] },
    } as never);

    const created = await send(`/tenants/${digdir}/test-sets`, 'eva', {
      body: { id: 'smoke-sett', name: 'Annen', cases: [] },
    });

    expect(created.status).toBeGreaterThanOrEqual(400);
    expect(created.status).toBeLessThan(500);
    expect(await platform.evalStores.testSets.get(digdir, 'smoke-sett')).toMatchObject({
      metadata: { name: 'Røyk', version: 1 },
    });
  });

  it('leaves a key bound only to it out of the access view for a tenant admin', async () => {
    const { send, key } = await boot();
    await key({ agents: ['smoke'] });
    await key({ agents: ['klarsprak', 'smoke'] });

    const access = (await (await send(`/tenants/${digdir}/access`, 'eva')).json()) as {
      keys: { agents: string[] }[];
    };

    expect(access.keys.map((k) => k.agents)).toEqual([['klarsprak']]);
  });
});

const evalRun = (id: string) =>
  ({
    id,
    status: 'completed',
    startedAt: '2026-10-07T10:00:00.000Z',
    endedAt: '2026-10-07T10:01:00.000Z',
    metrics: {},
    byTag: {},
    cases: [],
  }) as never;

describe('eval runs, keys and drafts of an internal service', () => {
  it('answers 404 to a tenant admin who opens or compares one of its eval runs', async () => {
    const { send, platform } = await boot();
    await platform.evalStores.runs.save({
      run: evalRun('kjoring-1'),
      tenant: digdir,
      task: 't1',
      service: 'smoke',
    });
    await platform.evalStores.runs.save({
      run: evalRun('kjoring-2'),
      tenant: digdir,
      task: 't2',
      service: 'klarsprak',
    });

    const opened = await send('/eval-runs/kjoring-1', 'eva');
    const shown = await send('/eval-runs/kjoring-2', 'eva');
    const compared = await send(
      '/eval-runs/compare?baseline=kjoring-2&candidate=kjoring-1&metric=score',
      'eva',
    );

    expect(opened.status).toBe(404);
    expect(shown.status).toBe(200);
    expect(compared.status).toBe(404);
  });

  it('answers a tenant admin at a path with no route the same as for an unknown id', async () => {
    const { send } = await boot();

    const hidden = await send(`/tenants/${digdir}/services/smoke`, 'eva');
    const missing = await send(`/tenants/${digdir}/services/finnes-ikke`, 'eva');

    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
  });

  it('reports one of its public names as taken with the text used for another organisation', async () => {
    const { send } = await boot();
    const definition = testService('annen');

    const refused = await send('/definitions', 'eva', {
      body: {
        definition: {
          ...definition,
          spec: { ...definition.spec, variants: [{ id: 'default', publicName: 'smoke__default' }] },
        },
        files,
      },
    });

    expect(await refused.json()).toMatchObject({
      errors: [{ message: 'public name smoke__default is already taken' }],
    });
  });

  it('leaves a key bound only to it out of the key policies for a tenant admin', async () => {
    const { send, keyId } = await boot();
    const created = await send(`/tenants/${digdir}/api-key-policies`, 'eva', {
      body: { name: 'Røyk' },
    });
    const policy = ((await created.json()) as { id: string }).id;
    const bound = await keyId({ agents: ['smoke'] });
    const open = await keyId({ agents: ['klarsprak'] });
    for (const id of [bound, open])
      await send(`/tenants/${digdir}/api-keys/${id}/policy`, 'eva', {
        method: 'PUT',
        body: { policyId: policy },
      });

    const listed = (await (await send(`/tenants/${digdir}/api-key-policies`, 'eva')).json()) as {
      data: { id: string; keyIds: string[] }[];
    };

    expect(created.status).toBe(201);
    expect(listed.data.find((p) => p.id === policy)?.keyIds).toEqual([open]);
  });

  it('lets a tenant admin save unchanged a draft that is already internal', async () => {
    const { send, key } = await boot();
    const runner = await key({ testRunner: true });
    await send('/definitions', runner, {
      body: { definition: testService('smoke-delt'), files },
    });
    await send(`/tenants/${digdir}/services/smoke-delt/draft`, runner, {
      method: 'PUT',
      body: { definition: internal('smoke-delt'), files },
    });

    const saved = await send(`/tenants/${digdir}/services/smoke-delt/draft`, 'eva', {
      method: 'PUT',
      body: { definition: internal('smoke-delt'), files },
    });

    expect(saved.status).toBeLessThan(300);
  });

  it('leaves out feedback whose run cannot be looked up for a tenant admin', async () => {
    const { send, platform } = await boot();
    await platform.evalStores.feedback.save({
      tenant: digdir,
      task: 'finnes-ikke',
      rating: 'up',
      at: '2026-10-07T10:00:00.000Z',
      by: { kind: 'person', id: 'kari' },
    } as never);

    const feedback = (await (await send(`/tenants/${digdir}/feedback`, 'eva')).json()) as {
      data: unknown[];
    };

    expect(feedback.data).toEqual([]);
  });
});
