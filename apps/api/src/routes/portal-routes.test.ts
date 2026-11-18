import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Event, Principal, Task } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import {
  apiKeyDigest,
  createAuthenticator,
  InMemoryApiKeys,
  keyReaches,
  LEGACY_KEY_ISSUER,
} from '@genai/identity';
import { InMemoryUsageBuckets, memoryUsageSource, pollUsage } from '@genai/port-usage';
import { InMemoryConnections } from '@genai/providers-mcp-client';
import { createAdmin } from '../admin.js';
import { failureReason } from '../failures.js';
import {
  auth,
  digdir,
  files,
  klarsprak,
  other,
  plugins,
  principals,
  settingDefinitions,
} from '../testkit.js';
import {
  InMemoryTenantApiKeys,
  portalAdminHandlers,
  registerPortalRoutes,
  tallyOf,
  usageView,
  type PortalTaskRow,
  type TenantApiKey,
} from './portal-routes.js';

const task = (
  id: string,
  tenant: string,
  at: string,
  status: Task['status'] = 'completed',
  capability = `${tenant}/klarsprak/default`,
): Task => ({
  id,
  service: {
    capability: { id: capability, version: '1' },
    strategy: { id: 'single-call', version: '1' },
    configHash: 'h',
  },
  principal: { kind: 'employee', id: 'kari' },
  tenant,
  owner: tenant,
  status,
  artifacts: [],
  usage: { inputTokens: 1000, outputTokens: 200, requests: 1 },
  createdAt: at,
  ...(status === 'completed' || status === 'failed' ? { endedAt: at } : {}),
});

const now = () => new Date('2026-10-06T12:00:00Z');

const setup = async (extra: Partial<Parameters<typeof registerPortalRoutes>[1]> = {}) => {
  const store = new InMemoryDefinitionStore({
    ...plugins,
    models: new Map([['foundry/gpt-4o', { residency: 'norway', capabilities: ['stream'] }]]),
  });
  await store.publish(klarsprak(), 'employee:test:kari', 'first', files);
  await store.publish(klarsprak({ tenant: other }), 'employee:test:ola', 'first', files);
  const legacy = new InMemoryApiKeys();
  const keys = new InMemoryTenantApiKeys(legacy);
  const admin = createAdmin({
    store,
    plugins,
    settings: new SettingsRegistry(settingDefinitions),
    extensions: portalAdminHandlers({ apiKeys: keys }),
  });
  const tasks: Task[] = [
    task('t1', digdir, '2026-10-05T09:00:00Z'),
    task('t2', digdir, '2026-10-06T08:00:00Z', 'failed'),
    task('t3', other, '2026-10-06T08:30:00Z'),
  ];
  const rows: PortalTaskRow[] = tasks.map((t) => ({
    task: t.id,
    tenant: t.tenant,
    status: t.status,
    at: t.createdAt,
  }));
  const connections = new InMemoryConnections();
  await connections.register({
    id: 'arkiv',
    tenant: digdir,
    name: 'Arkivsøk',
    endpoint: 'https://mcp.example.no/mcp',
    version: '1.0',
    allow: [{ host: 'mcp.example.no' }],
    auth: { kind: 'bearer', secret: `secret://tenant/${digdir}/arkiv-token` },
  });
  const app = new Hono();
  registerPortalRoutes(app, {
    admin,
    authenticate: auth.authenticate,
    definitions: store,
    tasks: () => rows,
    task: async (id) => tasks.find((t) => t.id === id),
    events: async function* (id): AsyncIterable<Event> {
      if (id !== 't1') return;
      yield {
        task: 't1',
        seq: 3,
        type: 'kernel.usage',
        v: 1,
        ts: '2026-10-05T09:00:01Z',
        actor: { kind: 'kernel', id: 'kernel' },
        data: {
          usage: { inputTokens: 1000, outputTokens: 200, requests: 1 },
          model: { kind: 'model', id: 'foundry/gpt-4o' },
        },
      } as Event;
    },
    apiKeys: keys,
    connections,
    requirementFor: () => ({
      resource: 'urn:altinn:resource:digdir-genai-platform',
      action: 'read',
      scope: 'legacy:query',
    }),
    prices: { 'foundry/gpt-4o': { inputPerThousand: 0.0238, outputPerThousand: 0.0952 } },
    traces: { enabled: true, content: false },
    now,
    newKey: () => 'gp_testkey_abcdefghijklmnop1234',
    newId: () => 'key-1',
    ...extra,
  });
  const send = (
    path: string,
    who: string | undefined,
    init: { method?: string; body?: unknown; reason?: string; session?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body !== undefined ? 'POST' : 'GET'),
      headers: {
        ...(who ? { authorization: `Bearer ${who}` } : {}),
        ...(init.session ? { 'support-session': init.session } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...(init.reason ? { 'change-reason': init.reason } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
  return { send, admin, legacy, store, keys };
};

const withPlaygroundRuns = () => {
  const tasks = [
    task('t1', digdir, '2026-10-05T09:00:00Z'),
    task('p1', digdir, '2026-10-06T09:00:00Z', 'completed', 'platform/draft/playground/p1'),
    task('p2', other, '2026-10-06T09:30:00Z', 'completed', 'platform/draft/playground/p2'),
    task('b1', digdir, '2026-10-06T10:00:00Z', 'completed', 'platform/draft/trial/svar/b1'),
    task('e1', digdir, '2026-10-06T10:30:00Z', 'completed', 'platform/draft/builder/svar/e1'),
  ];
  return setup({
    tasks: () =>
      tasks.map((t) => ({ task: t.id, tenant: t.tenant, status: t.status, at: t.createdAt })),
    task: async (id: string) => tasks.find((t) => t.id === id),
  });
};

const json = async <T>(res: Response) => (await res.json()) as T;

Object.assign(principals, {
  ingrid: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ingrid',
    authorizedFor: [
      { org: '405003309', actions: ['use-services'] },
      { org: digdir, actions: ['use-services', 'manage-services', 'view-usage'] },
    ],
  },
  per: {
    kind: 'employee',
    issuer: 'test',
    subject: 'per',
    authorizedFor: [{ org: digdir, actions: ['use-services', 'manage-services'] }],
  },
});

const operatorPrincipal: Principal = {
  kind: 'operator',
  issuer: 'test',
  subject: 'drift',
  tenant: digdir,
};
const anonymous: Principal = { kind: 'citizen', issuer: 'none', subject: 'none' };

const areas = ['overview', 'access', 'usage', 'tasks', 'integrations'];

describe('portal routes', () => {
  it('keeps every tenant route to its own tenant, and refuses anonymous callers', async () => {
    const { send } = await setup();
    for (const area of ['overview', 'access', 'usage', 'tasks', 'integrations']) {
      expect((await send(`/tenants/${digdir}/${area}`, 'ola')).status).toBe(404);
      expect((await send(`/tenants/${digdir}/${area}`, undefined)).status).toBe(401);
      expect((await send(`/tenants/${digdir}/${area}`, 'kari')).status).toBe(200);
    }
  });

  it('hides every tenant route from an operator without a support session', async () => {
    const { send } = await setup();
    for (const area of areas)
      expect((await send(`/tenants/${digdir}/${area}`, 'operator')).status).toBe(404);
    expect(
      (
        await send(`/tenants/${digdir}/api-keys`, 'operator', {
          body: { name: 'Bakdør' },
          reason: 'test av endringen',
        })
      ).status,
    ).toBe(404);
  });

  it('lets an operator read tenant routes in a support session, but never create a key the tenant would not see', async () => {
    const { send, admin } = await setup();
    const opened = await admin.openSupportSession(operatorPrincipal, digdir, 'feilsøking', 30);
    const session = opened.ok ? opened.value.id : '';
    for (const area of areas)
      expect((await send(`/tenants/${digdir}/${area}`, 'operator', { session })).status).toBe(200);
    const created = await send(`/tenants/${digdir}/api-keys`, 'operator', {
      body: { name: 'Bakdør' },
      reason: 'test av endringen',
      session,
    });
    expect(created.status).toBe(403);
  });

  it('lets a person authorized for several organisations use the routes of each', async () => {
    const { send } = await setup();
    for (const area of areas)
      expect((await send(`/tenants/${digdir}/${area}`, 'ingrid')).status).toBe(200);
    expect((await send(`/tenants/${other}/overview`, 'ingrid')).status).toBe(404);
  });

  it('stores a key made for all services and datasets as an explicit all grant', async () => {
    const { send, legacy } = await setup();
    const created = await json<{
      key: string;
      apiKey: { agents: string[]; datasets: string[]; callsPerMinute: number };
    }>(
      await send(`/tenants/${digdir}/api-keys`, 'kari', {
        body: { name: 'Alt', callsPerMinute: 120 },
        reason: 'test av endringen',
      }),
    );
    const found = await createAuthenticator({ apiKeys: legacy }).authenticate(
      new Request('http://x', { headers: { 'x-api-key': created.key } }),
    );

    expect(created.apiKey).toMatchObject({ agents: [], datasets: [], callsPerMinute: 120 });
    expect(
      keyReaches(found?.principal ?? anonymous, 'query', { agents: ['klarsprak__default'] }),
    ).toBe(true);
    expect(found?.grants?.callsPerMinute).toBe(120);
  });

  it('gives an overview with services, recent tasks, usage this month and items to review', async () => {
    const { send } = await setup();
    const body = await json<{
      services: { id: string }[];
      recentTasks: { id: string; service: string }[];
      usageThisMonth: { inputTokens: number };
      review: { failedTasksLastDay: number };
    }>(await send(`/tenants/${digdir}/overview`, 'kari'));

    expect(body.services.map((s) => s.id)).toEqual(['klarsprak']);
    expect(body.recentTasks.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(body.recentTasks[0]?.service).toBe('klarsprak');
    expect(body.usageThisMonth.inputTokens).toBe(2000);
    expect(body.review.failedTasksLastDay).toBe(1);
  });

  it('leaves usage this month out of the overview for a person without view-usage', async () => {
    const { send } = await setup();

    const res = await send(`/tenants/${digdir}/overview`, 'per');
    const body = await json<Record<string, unknown>>(res);

    expect(res.status).toBe(200);
    expect(body).not.toHaveProperty('usageThisMonth');
    expect(body.services).toEqual([expect.objectContaining({ id: 'klarsprak' })]);
  });

  it('leaves per-task usage out of the overview recent tasks for a person without view-usage', async () => {
    const { send } = await setup();

    const without = await json<{ recentTasks: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/overview`, 'per'),
    );
    const withUsage = await json<{ recentTasks: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/overview`, 'ingrid'),
    );

    expect(without.recentTasks.map((t) => t.id)).toEqual(['t2', 't1']);
    for (const task of without.recentTasks) expect(task).not.toHaveProperty('usage');
    for (const task of withUsage.recentTasks) expect(task).toHaveProperty('usage');
  });

  it('leaves per-task usage out of the task list and the single task for a person without view-usage', async () => {
    const { send } = await setup();

    const list = await json<{ data: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/tasks`, 'per'),
    );
    const one = await json<Record<string, unknown>>(
      await send(`/tenants/${digdir}/tasks/t1`, 'per'),
    );
    const seen = await json<{ data: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/tasks`, 'ingrid'),
    );

    expect(list.data.map((t) => t.id)).toEqual(['t2', 't1']);
    for (const task of list.data) expect(task).not.toHaveProperty('usage');
    expect(one).toMatchObject({ id: 't1' });
    expect(one).not.toHaveProperty('usage');
    for (const task of seen.data) expect(task).toHaveProperty('usage');
  });

  it('lists tasks newest first, filtered by status and service, without other tenants', async () => {
    const { send } = await setup();
    const all = await json<{ data: { id: string }[]; total: number }>(
      await send(`/tenants/${digdir}/tasks`, 'kari'),
    );
    const failed = await json<{ data: { id: string }[] }>(
      await send(`/tenants/${digdir}/tasks?status=failed`, 'kari'),
    );
    const none = await json<{ data: unknown[] }>(
      await send(`/tenants/${digdir}/tasks?service=nope`, 'kari'),
    );

    expect(all.data.map((t) => t.id)).toEqual(['t2', 't1']);
    expect(failed.data.map((t) => t.id)).toEqual(['t2']);
    expect(none.data).toEqual([]);
  });

  it('lists playground runs only when asked for them, without other tenants', async () => {
    const { send } = await withPlaygroundRuns();
    const services = await json<{ data: { id: string }[] }>(
      await send(`/tenants/${digdir}/tasks`, 'kari'),
    );
    const playground = await json<{ data: { id: string }[] }>(
      await send(`/tenants/${digdir}/tasks?origin=playground`, 'kari'),
    );

    expect(services.data.map((t) => t.id)).toEqual(['t1']);
    expect(playground.data.map((t) => t.id)).toEqual(['b1', 'p1']);
  });

  it('lists the trial runs of a draft in the builder with the playground runs, but not test case runs', async () => {
    const { send } = await withPlaygroundRuns();

    const trials = await json<{ data: { id: string }[] }>(
      await send(`/tenants/${digdir}/tasks?origin=playground`, 'kari'),
    );
    const one = await send(`/tenants/${digdir}/tasks/b1`, 'kari');

    expect(trials.data.map((t) => t.id)).toContain('b1');
    expect(trials.data.map((t) => t.id)).not.toContain('e1');
    expect(one.status).toBe(200);
  });

  it('reads a playground run by id like a service run, but not one from another tenant', async () => {
    const { send } = await withPlaygroundRuns();

    const own = await send(`/tenants/${digdir}/tasks/p1`, 'kari');
    const foreign = await send(`/tenants/${digdir}/tasks/p2`, 'kari');

    expect(own.status).toBe(200);
    expect(await json<{ id: string }>(own)).toMatchObject({ id: 'p1' });
    expect(foreign.status).toBe(404);
  });

  it('adds up usage per day, service and model, and prices model tokens', async () => {
    const { send } = await setup();
    const body = await json<{
      priced: boolean;
      daily: { date: string; usage: { inputTokens: number } }[];
      byService: { service: string; usage: { inputTokens: number } }[];
      byModel: { model: string; usage: { costMicroNok: number } }[];
    }>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));

    expect(body.priced).toBe(false);
    expect(body.daily.map((d) => [d.date, d.usage.inputTokens])).toEqual([
      ['2026-10-04', 0],
      ['2026-10-05', 1000],
      ['2026-10-06', 1000],
    ]);
    expect(body.byService).toEqual([
      expect.objectContaining({
        service: 'klarsprak',
        usage: expect.objectContaining({ inputTokens: 2000 }),
      }),
    ]);
    expect(body.byModel[0]?.model).toBe('foundry/gpt-4o');
    expect(body.byModel[0]?.usage.costMicroNok).toBe(
      Math.round((0.0238 + 0.2 * 0.0952) * 1_000_000),
    );
  });

  it('splits each day by service and model with its own cost and counts runs as tasks, not model requests', async () => {
    const { send } = await setup();
    type Totals = {
      inputTokens: number;
      requests: number;
      costMicroNok: number | null;
      runs?: number;
    };
    const body = await json<{
      totals: Totals;
      daily: { date: string; byService: Record<string, Totals>; byModel: Record<string, Totals> }[];
      byService: { service: string; usage: Totals }[];
    }>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));

    const oct5 = body.daily.find((d) => d.date === '2026-10-05');
    expect(oct5?.byService.klarsprak).toMatchObject({ inputTokens: 1000, runs: 1 });
    expect(oct5?.byModel['foundry/gpt-4o']?.costMicroNok).toBe(
      Math.round((0.0238 + 0.2 * 0.0952) * 1_000_000),
    );
    expect(body.daily.find((d) => d.date === '2026-10-04')?.byService).toEqual({});
    expect(body.totals.runs).toBe(2);
    expect(body.byService[0]?.usage.runs).toBe(2);
  });

  it('counts the failed runs next to the runs, in total, per service and per day', async () => {
    const { send } = await setup();
    type Runs = { runs: number; failedRequests: number };
    const body = await json<{
      totals: Runs;
      daily: { date: string; byService: Record<string, Runs> }[];
      byService: { service: string; usage: Runs }[];
    }>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));

    expect(body.totals).toMatchObject({ runs: 2, failedRequests: 1 });
    expect(body.byService[0]?.usage).toMatchObject({ runs: 2, failedRequests: 1 });
    expect(body.daily.find((d) => d.date === '2026-10-05')?.byService.klarsprak).toMatchObject({
      failedRequests: 0,
    });
    expect(body.daily.find((d) => d.date === '2026-10-06')?.byService.klarsprak).toMatchObject({
      failedRequests: 1,
    });
  });

  it('gives operators the usage of this month for every tenant they ask about, and nobody else', async () => {
    const { send } = await setup();
    const body = await json<{ data: { orgNumber: string; usage: { inputTokens: number } }[] }>(
      await send(`/operator/usage?tenants=${digdir},${other}`, 'operator'),
    );

    expect(body.data.map((d) => d.orgNumber)).toEqual([digdir, other]);
    expect(body.data[0]?.usage.inputTokens).toBe(2000);
    expect((await send(`/operator/usage?tenants=${digdir}`, 'kari')).status).toBe(403);
  });

  it('answers a repeated operator usage request from a short cache instead of recounting', async () => {
    let reads = 0;
    const { send } = await setup({
      tasks: () => {
        reads += 1;
        return [];
      },
    });

    await send(`/operator/usage?tenants=${digdir}`, 'operator');
    const afterFirst = reads;
    const again = await send(`/operator/usage?tenants=${digdir}`, 'operator');

    expect(again.status).toBe(200);
    expect(afterFirst).toBeGreaterThan(0);
    expect(reads).toBe(afterFirst);
  });

  it('names each service in the usage by its title, also a service shared from another organisation', async () => {
    const shared: Task = {
      ...task('s1', other, '2026-10-06T09:00:00Z'),
      service: {
        capability: { id: `${digdir}/klarsprak/default`, version: '1' },
        strategy: { id: 'single-call', version: '1' },
        configHash: 'h',
      },
    };
    const { send } = await setup({
      tasks: () => [{ task: 's1', tenant: other, status: 'completed', at: shared.createdAt }],
      task: async (id) => (id === 's1' ? shared : undefined),
    });
    const body = await json<{ byService: { service: string; title?: string }[] }>(
      await send(`/tenants/${other}/usage?days=3`, 'ola'),
    );

    expect(body.byService).toEqual([
      expect.objectContaining({ service: `${digdir}/klarsprak/default`, title: 'Klarspråk' }),
    ]);
  });

  it('names a service by its own name in usage and access, never by the title of a mode', async () => {
    const quick: Task = {
      ...task('q1', digdir, '2026-10-06T09:00:00Z'),
      service: {
        capability: { id: `${digdir}/klarsprak/quick`, version: '2' },
        strategy: { id: 'single-call', version: '1' },
        configHash: 'h',
      },
    };
    const { send, store } = await setup({
      tasks: () => [{ task: 'q1', tenant: digdir, status: 'completed', at: quick.createdAt }],
      task: async (id) => (id === 'q1' ? quick : undefined),
    });
    await store.publish(
      klarsprak({ variants: ['quick', 'default'] }),
      'employee:test:kari',
      'modes',
      files,
    );
    const usage = await json<{ byService: { title?: string }[] }>(
      await send(`/tenants/${digdir}/usage?days=3`, 'kari'),
    );
    const access = await json<{ services: { id: string; name: string }[] }>(
      await send(`/tenants/${digdir}/access`, 'kari'),
    );

    expect(usage.byService.map((s) => s.title)).toEqual(['Klarspråk']);
    expect(access.services.find((s) => s.id === 'klarsprak')?.name).toBe('Klarspråk');
  });

  it('lists only shared services in the catalogue', async () => {
    const { send } = await setup();
    const body = await json<{ data: unknown[] }>(await send('/shared-services', 'kari'));
    expect(body.data).toEqual([]);
    expect((await send('/shared-services', undefined)).status).toBe(401);
  });

  it('names the model of a shared service from its definition', async () => {
    const { send, store } = await setup();
    const shared = klarsprak({ id: 'delt-klarsprak' });
    await store.publish(
      { ...shared, spec: { ...shared.spec, availableTo: '*' } },
      'employee:test:kari',
      'shared',
      files,
    );
    const body = await json<{ data: { id: string; model: string | null }[] }>(
      await send('/shared-services', 'kari'),
    );
    expect(body.data).toEqual([
      expect.objectContaining({ id: 'delt-klarsprak', model: 'foundry/gpt-4o' }),
    ]);
  });

  it('tells what a shared service keeps, which languages it answers in and what a thousand runs cost', async () => {
    const { send, store } = await setup({ retentionOf: () => ({ payloadDays: 90 }) });
    const shared = klarsprak();
    const published = await store.publish(
      {
        ...shared,
        spec: {
          ...shared.spec,
          availableTo: '*',
          languages: ['nb', 'nn'],
          guardrails: { language: { mode: 'nn' } },
        },
      },
      'employee:test:kari',
      'shared',
      files,
    );

    const body = await json<{ data: Record<string, unknown>[] }>(
      await send('/shared-services', 'kari'),
    );

    expect(published.ok ? [] : published.errors).toEqual([]);

    expect(body.data[0]).toMatchObject({
      storage: { keepsText: true, logDays: 90 },
      languages: { in: ['nb', 'nn'], out: 'nn' },
    });
  });

  it('estimates the cost of a thousand runs only from at least 20 runs, rounded, so no single run can be worked out', async () => {
    const runs = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        ...task(`r${i}`, digdir, '2026-10-05T09:00:00Z'),
        usage: { inputTokens: 1000 + i, outputTokens: 200, requests: 1 },
      }));
    const shared = klarsprak();
    const estimateFrom = async (count: number) => {
      const { send, store } = await setup({ taskEnvelopes: async () => runs(count) });
      await store.publish(
        { ...shared, spec: { ...shared.spec, availableTo: '*' } },
        'employee:test:kari',
        'shared',
        files,
      );
      const body = await json<{ data: Record<string, unknown>[] }>(
        await send('/shared-services', 'kari'),
      );
      return body.data[0]?.estimatedCostPerThousandRuns as
        { microNok: number; basis: string } | undefined;
    };

    const few = await estimateFrom(19);
    const enough = await estimateFrom(20);
    const one = await estimateFrom(21);

    expect(few).toBeUndefined();
    expect(enough).toEqual({ microNok: 43_000_000, basis: expect.not.stringContaining('20') });
    expect(one?.microNok).toBe(enough?.microNok);
  });

  it('creates an API key shown once, stores only its digest, audits it, and lets it authenticate', async () => {
    const { send, admin, legacy } = await setup();

    const missingReason = await send(`/tenants/${digdir}/api-keys`, 'kari', {
      body: { name: 'Arkiv' },
    });
    const created = await send(`/tenants/${digdir}/api-keys`, 'kari', {
      body: { name: 'Arkiv', datasets: ['digdir/kudos'], expiresInDays: 30 },
      reason: 'integrasjon mot arkivet',
    });
    const body = await json<{
      key: string;
      apiKey: { id: string; lastFour: string; datasets: string[]; expiresAt: string };
    }>(created);
    const listed = await json<{ keys: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/access`, 'kari'),
    );
    const authenticator = createAuthenticator({ apiKeys: legacy, now });
    const principal = await authenticator.principalOf(
      new Request('http://x', { headers: { 'x-api-key': body.key } }),
    );

    expect(missingReason.status).toBe(400);
    expect(created.status).toBe(201);
    expect(body.key).toBe('gp_testkey_abcdefghijklmnop1234');
    expect(body.apiKey).toMatchObject({
      id: 'key-1',
      lastFour: '1234',
      datasets: ['digdir/kudos'],
      expiresAt: '2026-11-05T12:00:00.000Z',
    });
    expect(JSON.stringify(listed.keys)).not.toContain(body.key);
    expect(JSON.stringify(listed.keys)).not.toContain(apiKeyDigest(body.key));
    expect(principal?.tenant).toBe(digdir);
    const entry = (await admin.audit(digdir)).find((a) => a.action === 'platform.apikeys.create');
    expect(entry).toMatchObject({ outcome: 'applied', reason: 'integrasjon mot arkivet' });
  });

  it('needs a change reason of at least 10 characters to create a key', async () => {
    const { send } = await setup();

    const short = await send(`/tenants/${digdir}/api-keys`, 'kari', {
      body: { name: 'Arkiv' },
      reason: '123456789',
    });
    const enough = await send(`/tenants/${digdir}/api-keys`, 'kari', {
      body: { name: 'Arkiv' },
      reason: '1234567890',
    });

    expect(short.status).toBe(400);
    expect(await json(short)).toMatchObject({
      errors: [{ path: 'change-reason', message: 'Skriv en begrunnelse på minst 10 tegn.' }],
    });
    expect(enough.status).toBe(201);
  });

  it('revokes a key for its own tenant only, and the revoked key no longer authenticates', async () => {
    const { send, legacy } = await setup();
    const created = await json<{ key: string }>(
      await send(`/tenants/${digdir}/api-keys`, 'kari', {
        body: { name: 'Arkiv' },
        reason: 'test av endringen',
      }),
    );

    const elsewhere = await send(`/tenants/${digdir}/api-keys/key-1/revoke`, 'ola', {
      method: 'POST',
      reason: 'nei, ikke min nøkkel',
    });
    const revoked = await send(`/tenants/${digdir}/api-keys/key-1/revoke`, 'kari', {
      method: 'POST',
      reason: 'ikke i bruk',
    });
    const authenticator = createAuthenticator({ apiKeys: legacy, now });
    const principal = await authenticator.principalOf(
      new Request('http://x', { headers: { 'x-api-key': created.key } }),
    );

    expect(elsewhere.status).toBe(404);
    expect(revoked.status).toBe(200);
    expect((await json<{ revokedAt: string }>(revoked)).revokedAt).toBe('2026-10-06T12:00:00.000Z');
    expect(principal).toBeUndefined();
  });

  it('shows integrations with pinned tools and the secret name, never its reference path', async () => {
    const { send } = await setup();
    const body = await json<{
      connections: { id: string; auth: { secret: string } }[];
      traces: { enabled: boolean };
    }>(await send(`/tenants/${digdir}/integrations`, 'kari'));
    expect(body.connections).toEqual([
      expect.objectContaining({ id: 'arkiv', auth: { kind: 'bearer', secret: 'arkiv-token' } }),
    ]);
    expect(body.traces.enabled).toBe(true);
  });
});

describe('usage you can trust', () => {
  it('reports tokens without a price as unpriced, never as 0 kr', async () => {
    const { send } = await setup({ prices: {} });
    const body = await json<{
      priced: boolean;
      totals: { costMicroNok: number | null; priced: boolean; unpricedTokens: number };
      byModel: { model: string; usage: { costMicroNok: number | null; priced: boolean } }[];
    }>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));

    expect(body.priced).toBe(false);
    expect(body.totals).toMatchObject({ costMicroNok: null, priced: false, unpricedTokens: 2400 });
    expect(body.byModel).toEqual([
      {
        model: 'foundry/gpt-4o',
        usage: expect.objectContaining({ costMicroNok: null, priced: false }),
      },
    ]);
  });

  it('keeps the priced part of a mixed total and says that part of it is unpriced', async () => {
    const { send } = await setup();
    const body = await json<{
      totals: { costMicroNok: number | null; priced: boolean; unpricedTokens: number };
    }>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));

    expect(body.totals).toEqual(
      expect.objectContaining({
        costMicroNok: Math.round((0.0238 + 0.2 * 0.0952) * 1_000_000),
        priced: false,
        unpricedTokens: 1200,
      }),
    );
  });

  it('breaks usage down per project and filters to one project without counting anything twice', async () => {
    const { send } = await setup({
      projectTasks: async (tenant) =>
        tenant === digdir
          ? [{ task: 't1', project: 'arsrapporter', name: 'Årsrapporter 2024' }]
          : [],
      ingestionUsage: async () => [
        {
          at: '2026-10-06T07:00:00Z',
          dataset: `${digdir}/veiledning`,
          model: 'foundry/text-embedding-3-small',
          usage: { inputTokens: 500 },
        },
      ],
    });
    type Report = {
      project?: string;
      totals: { inputTokens: number };
      byService: { usage: { inputTokens: number } }[];
      byProject: { project: string; name: string; usage: { inputTokens: number } }[];
      ingestion: { usage: { inputTokens: number } };
    };

    const all = await json<Report>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));
    const one = await json<Report>(
      await send(`/tenants/${digdir}/usage?days=3&project=arsrapporter`, 'kari'),
    );

    expect(all.totals.inputTokens).toBe(2500);
    expect(all.byProject).toEqual([
      {
        project: 'arsrapporter',
        name: 'Årsrapporter 2024',
        usage: expect.objectContaining({ inputTokens: 1000 }),
      },
    ]);
    expect(all.byService.reduce((sum, s) => sum + s.usage.inputTokens, 0)).toBe(2000);
    expect(one.project).toBe('arsrapporter');
    expect(one.totals.inputTokens).toBe(1000);
    expect(one.byService.map((s) => s.usage.inputTokens)).toEqual([1000]);
    expect(one.ingestion.usage.inputTokens).toBe(0);
    expect(
      (await json<Report>(await send(`/tenants/${digdir}/usage?days=3&project=ukjent`, 'kari')))
        .totals.inputTokens,
    ).toBe(0);
  });

  it('counts ingestion embedding tokens in the tenant usage', async () => {
    const { send } = await setup({
      prices: {
        'foundry/text-embedding-3-small': { inputPerThousand: 0.0002, outputPerThousand: 0 },
      },
      ingestionUsage: async (tenant) =>
        tenant === digdir
          ? [
              {
                at: '2026-10-06T07:00:00Z',
                dataset: `${digdir}/veiledning`,
                model: 'foundry/text-embedding-3-small',
                usage: { inputTokens: 38_000, requests: 600 },
              },
            ]
          : [],
    });
    const body = await json<{
      totals: { inputTokens: number };
      byModel: { model: string; usage: { costMicroNok: number | null; priced: boolean } }[];
      ingestion: { usage: { inputTokens: number }; byDataset: { dataset: string }[] };
    }>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));

    expect(body.totals.inputTokens).toBe(40_000);
    expect(body.ingestion.usage.inputTokens).toBe(38_000);
    expect(body.ingestion.byDataset.map((d) => d.dataset)).toEqual([`${digdir}/veiledning`]);
    expect(body.byModel.find((m) => m.model === 'foundry/text-embedding-3-small')?.usage).toEqual(
      expect.objectContaining({ costMicroNok: 7600, priced: true }),
    );
  });

  it('flags the monthly quota once usage reaches 80 percent of it, and not before', async () => {
    const used: Record<string, number> = { [digdir]: 40_000, [other]: 39_999 };
    const { send } = await setup({
      quota: async (tenant) => ({ usedTokens: used[tenant] ?? 0, monthlyTokens: 50_000 }),
    });
    const quotaOf = async (tenant: string, who: string) =>
      (
        await json<{ quota: { usedPercent: number; alertPercent: number; alert: boolean } }>(
          await send(`/tenants/${tenant}/usage`, who),
        )
      ).quota;

    expect(await quotaOf(digdir, 'kari')).toMatchObject({
      usedPercent: 80,
      alertPercent: 80,
      alert: true,
    });
    expect(await quotaOf(other, 'ola')).toMatchObject({ alert: false });
  });

  it('splits ingestion usage per day', async () => {
    const { send } = await setup({
      ingestionUsage: async () => [
        {
          at: '2026-10-05T07:00:00Z',
          dataset: `${digdir}/veiledning`,
          model: 'foundry/text-embedding-3-small',
          usage: { inputTokens: 1_000, requests: 10 },
        },
        {
          at: '2026-10-06T07:00:00Z',
          dataset: `${digdir}/veiledning`,
          model: 'foundry/text-embedding-3-small',
          usage: { inputTokens: 3_000, requests: 30 },
        },
      ],
    });
    const body = await json<{
      daily: {
        date: string;
        ingestion: { inputTokens: number };
        testing: { inputTokens: number };
      }[];
    }>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));

    expect(body.daily.map((d) => [d.date, d.ingestion.inputTokens, d.testing.inputTokens])).toEqual(
      [
        ['2026-10-04', 0, 0],
        ['2026-10-05', 1_000, 0],
        ['2026-10-06', 3_000, 0],
      ],
    );
  });

  it('shows a service whose primary model is retired as paused in the overview', async () => {
    const { send } = await setup({
      serviceHealth: async () => ({
        status: 'paused',
        reason: 'Modellen tjenesten bruker er tatt ut av bruk (foundry/gpt-4o).',
        warnings: [],
      }),
    });
    const body = await json<{ services: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/overview`, 'kari'),
    );

    expect(body.services[0]).toMatchObject({
      id: 'klarsprak',
      status: 'paused',
      statusReason: 'Modellen tjenesten bruker er tatt ut av bruk (foundry/gpt-4o).',
    });
  });
});

describe('service summaries and run headers', () => {
  const named = (id: string, name: string, spec: Record<string, unknown> = {}) => {
    const base = klarsprak({ id });
    return {
      ...base,
      metadata: { ...base.metadata, name },
      spec: { ...base.spec, ...spec },
    };
  };

  const prepare = async (extra: Partial<Parameters<typeof registerPortalRoutes>[1]> = {}) => {
    const loaded: string[] = [];
    const tasks: Task[] = [
      {
        ...task('t1', digdir, '2026-10-05T09:00:00Z'),
        principal: { kind: 'employee', id: '["test","kari"]' },
      },
      {
        ...task('t2', digdir, '2026-10-06T08:00:00Z'),
        principal: { kind: 'agency-system', id: '["urn:genai:legacy-api-key","key-7"]' },
      },
      {
        ...task('t3', digdir, '2026-09-01T08:00:00Z'),
        service: {
          ...task('x', digdir, 'x').service,
          capability: { id: `${digdir}/beta/default`, version: '1' },
        },
      },
    ];
    const rows: PortalTaskRow[] = tasks.map((t) => ({
      task: t.id,
      tenant: t.tenant,
      status: t.status,
      at: t.createdAt,
    }));
    const env = await setup({
      tasks: () => rows,
      task: async (id) => {
        loaded.push(id);
        return tasks.find((t) => t.id === id);
      },
      events: async function* (id): AsyncIterable<Event> {
        yield {
          task: id,
          seq: 2,
          type: 'kernel.task.input',
          v: 1,
          ts: '2026-10-06T08:00:00Z',
          actor: { kind: 'kernel', id: 'kernel' },
          data: {
            input: {
              parts: [
                {
                  mime: 'text/plain',
                  body: { kind: 'text', text: 'Hva er fristen for søknaden?' },
                },
              ],
            },
          },
        } as Event;
      },
      names: { namesOf: async () => new Map([['employee:test:kari', 'Kari Testansatt']]) },
      ...extra,
    });
    await env.store.publish(
      named('beta', 'Beta', { exposure: { chat: true, rest: true } }),
      'employee:test:kari',
      'ny',
      files,
    );
    await env.store.publish(
      named('alfa', 'Alfa', { purpose: 'Svarer på alt' }),
      'employee:test:kari',
      'ny',
      files,
    );
    return { ...env, loaded };
  };

  Object.assign(principals, {
    erik: {
      kind: 'employee',
      issuer: 'test',
      subject: 'erik',
      authorizedFor: [{ org: digdir, actions: ['use-services'] }],
    },
  });

  it('lists every service in one call with purpose, channels, last change and runs this week, most used first then by name', async () => {
    const { send, loaded } = await prepare();

    const body = await json<{ data: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/services`, 'kari'),
    );

    expect(body.data.map((s) => [s.id, s.runsThisWeek])).toEqual([
      ['klarsprak', 2],
      ['alfa', 0],
      ['beta', 0],
    ]);
    expect(body.data[0]).toMatchObject({
      name: 'Klarspråk',
      purpose: 'Skriv om tekst til klart språk',
      outputKind: 'answer',
      channels: ['api'],
      status: 'active',
      latestVersion: 1,
      updatedBy: 'employee:test:kari',
    });
    expect(body.data[2]).toMatchObject({ channels: ['chatOwn', 'api'] });
    expect(body.data[0]?.updatedAt).toEqual(expect.any(String));
    expect(loaded.sort()).toEqual(['t1', 't2']);
  });

  it("shows the primary model's own residency from the model list, not the widest residency the service allows", async () => {
    const { send } = await prepare({
      modelResidency: (id) => (id === 'foundry/gpt-4o' ? 'eu' : undefined),
    });

    const body = await json<{ data: { id: string; model: unknown }[] }>(
      await send(`/tenants/${digdir}/services`, 'kari'),
    );

    expect(body.data.find((s) => s.id === 'klarsprak')?.model).toEqual({
      id: 'foundry/gpt-4o',
      residency: 'eu',
    });
  });

  it('answers no residency for a primary model the model list does not know', async () => {
    const { send } = await prepare({ modelResidency: () => undefined });

    const body = await json<{ data: { id: string; model: unknown }[] }>(
      await send(`/tenants/${digdir}/services`, 'kari'),
    );

    expect(body.data.find((s) => s.id === 'klarsprak')?.model).toEqual({
      id: 'foundry/gpt-4o',
      residency: null,
    });
  });

  it('keeps the service list to the tenant of the caller', async () => {
    const { send } = await prepare();

    expect((await send(`/tenants/${digdir}/services`, 'ola')).status).toBe(404);
    expect((await send(`/tenants/${digdir}/services`, undefined)).status).toBe(401);
  });

  it('orders the overview services like the service list', async () => {
    const { send } = await prepare();

    const body = await json<{ services: { id: string }[] }>(
      await send(`/tenants/${digdir}/overview`, 'kari'),
    );

    expect(body.services.map((s) => s.id)).toEqual(['klarsprak', 'alfa', 'beta']);
  });

  it('names the person, the API key and the service of a run, with an excerpt of the question for those who manage services', async () => {
    const { send } = await prepare();

    const manager = await json<{ data: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/tasks`, 'kari'),
    );
    const reader = await json<{ data: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/tasks`, 'erik'),
    );
    const byId = (rows: Record<string, unknown>[], id: string) => rows.find((r) => r.id === id);

    expect(byId(manager.data, 't1')).toMatchObject({
      serviceName: 'Klarspråk',
      excerpt: 'Hva er fristen for søknaden?',
      actor: { kind: 'person', name: 'Kari Testansatt' },
    });
    expect(byId(manager.data, 't2')).toMatchObject({ actor: { kind: 'api-key' } });
    expect(byId(reader.data, 't1')).toMatchObject({ serviceName: 'Klarspråk' });
    expect(byId(reader.data, 't1')).not.toHaveProperty('excerpt');
  });

  it('the run list marks erased runs instead of showing an empty input', async () => {
    const asked: [string, string[]][] = [];
    const { send } = await prepare({
      erasures: async (tenant, ids) => {
        asked.push([tenant, ids]);
        return [{ task: 't1', reason: 'conversation-deleted', at: '2026-11-03T17:41:00.000Z' }];
      },
    });

    const list = await json<{ data: Record<string, unknown>[] }>(
      await send(`/tenants/${digdir}/tasks`, 'kari'),
    );
    const one = await json<Record<string, unknown>>(
      await send(`/tenants/${digdir}/tasks/t1`, 'erik'),
    );

    const t1 = list.data.find((r) => r.id === 't1');
    expect(t1).toMatchObject({
      erasure: { reason: 'conversation-deleted', at: '2026-11-03T17:41:00.000Z' },
    });
    expect(t1).not.toHaveProperty('excerpt');
    expect(list.data.find((r) => r.id === 't2')).not.toHaveProperty('erasure');
    expect(one).toMatchObject({ erasure: { reason: 'conversation-deleted' } });
    expect(asked.every(([tenant]) => tenant === digdir)).toBe(true);
  });

  it('shows the API key by its name, and the document title of a batch item instead of the whole prompt', async () => {
    const { send, keys } = await prepare({
      events: async function* (id): AsyncIterable<Event> {
        yield {
          task: id,
          seq: 2,
          type: 'kernel.task.input',
          v: 1,
          ts: '2026-10-06T08:00:00Z',
          actor: { kind: 'kernel', id: 'kernel' },
          data: {
            input: {
              parts: [
                {
                  mime: 'text/plain',
                  body: { kind: 'text', text: 'Hent målene.\n\nDokument: Tildelingsbrev 2024' },
                },
              ],
            },
          },
        } as Event;
      },
    });
    await keys.add({
      id: 'key-7',
      name: 'Fagsystemet',
      digest: 'd'.repeat(64),
      tenant: digdir,
      scopes: ['query'],
      datasets: [],
      agents: [],
    });

    const one = await json<Record<string, unknown>>(
      await send(`/tenants/${digdir}/tasks/t2`, 'kari'),
    );

    expect(one).toMatchObject({
      excerpt: 'Tildelingsbrev 2024',
      actor: { kind: 'api-key', name: 'Fagsystemet' },
    });
  });
});

describe('the dashboard on a busy tenant', () => {
  const busy = async () => {
    const tasks = Array.from({ length: 3000 }, (_, i) =>
      task(
        `b${i}`,
        digdir,
        new Date(Date.parse('2026-10-01T00:00:00Z') + i * 150_000).toISOString(),
        i % 100 === 0 ? 'failed' : 'completed',
      ),
    );
    const calls = { envelopes: 0, usage: 0, inputs: 0 };
    const env = await setup({
      tasks: () => {
        throw new Error('the dashboard must not list task rows one by one');
      },
      task: async () => {
        throw new Error('the dashboard must not read tasks one by one');
      },
      events: () => {
        throw new Error('the dashboard must not read the event log task by task');
      },
      taskEnvelopes: async (tenant, query) => {
        calls.envelopes++;
        return tasks
          .filter((t) => t.tenant === tenant && (!query.since || t.createdAt >= query.since))
          .reverse()
          .slice(0, query.limit ?? 1000);
      },
      usageEvents: async (ids) => {
        calls.usage++;
        return ids.map((id) => ({
          task: id,
          data: {
            usage: { inputTokens: 1000, outputTokens: 200, requests: 1 },
            model: { kind: 'model', id: 'foundry/gpt-4o' },
          },
        }));
      },
      eventsOfType: async (ids, type) => {
        calls.inputs++;
        return ids.map(
          (id) =>
            ({
              task: id,
              seq: 0,
              type,
              v: 1,
              ts: '2026-10-01T00:00:00Z',
              actor: { kind: 'kernel', id: 'kernel' },
              data: { input: { data: { query: `question ${id}` } } },
            }) as Event,
        );
      },
    });
    return { ...env, calls };
  };

  it('builds the overview from one envelope query and counts every task of the month, past the newest thousand', async () => {
    const { send, calls } = await busy();
    const body = await json<{
      recentTasks: { id: string; usage: { inputTokens: number } }[];
      usageThisMonth: { inputTokens: number; runs: number };
      review: { failedTasksLastDay: number };
    }>(await send(`/tenants/${digdir}/overview`, 'kari'));

    expect(body.usageThisMonth.runs).toBe(3000);
    expect(body.usageThisMonth.inputTokens).toBe(3_000_000);
    expect(body.recentTasks.map((t) => t.id)).toEqual([
      'b2999',
      'b2998',
      'b2997',
      'b2996',
      'b2995',
    ]);
    expect(body.recentTasks[0]?.usage.inputTokens).toBe(1000);
    expect(body.review.failedTasksLastDay).toBe(4);
    expect(calls.envelopes).toBe(1);
    expect(calls.usage).toBe(2);
    expect(calls.inputs).toBe(0);
  });

  it('builds the usage report from one envelope query and one usage query', async () => {
    const { send, calls } = await busy();
    const body = await json<{ totals: { runs: number; inputTokens: number } }>(
      await send(`/tenants/${digdir}/usage?days=30`, 'kari'),
    );

    expect(body.totals.runs).toBe(3000);
    expect(body.totals.inputTokens).toBe(3_000_000);
    expect(calls).toEqual({ envelopes: 1, usage: 1, inputs: 0 });
  });

  it('lists tasks from one envelope query and one input query, without decrypting tasks one by one', async () => {
    const { send, calls } = await busy();
    const body = await json<{ data: { id: string; excerpt?: string }[]; total: number }>(
      await send(`/tenants/${digdir}/tasks?status=completed`, 'kari'),
    );

    expect(body.total).toBe(990);
    expect(body.data).toHaveLength(100);
    expect(body.data[0]).toMatchObject({ id: 'b2999', excerpt: 'question b2999' });
    expect(calls).toEqual({ envelopes: 1, usage: 1, inputs: 1 });
  });
});

describe('usage from an AI gateway', () => {
  const direct = 'foundry/gpt-4o';
  const routed = 'gateway/gpt-6.1-sol';
  const price = { inputPerThousand: 0.0238, outputPerThousand: 0.0952 };
  const genkiCost = Math.round((0.0238 + 0.2 * 0.0952) * 1_000_000);
  const usdNok = 10;

  const genkiCall = (id: string, model: string, at: string) => ({
    task: task(id, digdir, at),
    event: {
      task: id,
      seq: 3,
      type: 'kernel.usage',
      v: 1,
      ts: at,
      actor: { kind: 'kernel', id: 'kernel' },
      data: {
        usage: { inputTokens: 1000, outputTokens: 200, requests: 1 },
        model: { kind: 'model', id: model },
      },
    } as Event,
  });

  const genkiApp = '334f8fa1-437e-4b84-bceb-f320fb60f3ed';

  const threeCalls = async (extra: Partial<Parameters<typeof registerPortalRoutes>[1]> = {}) => {
    let now = new Date('2026-10-06T08:00:00Z');
    const gateway = memoryUsageSource({ now: () => now, genkiClients: [genkiApp] });
    gateway.record({
      client: 'portal',
      org: digdir,
      model: 'gpt-6.1-sol',
      at: '2026-10-06T08:10:00Z',
      inputTokens: 500,
      outputTokens: 50,
      costMicros: 2000,
    });
    gateway.record({
      client: genkiApp,
      org: digdir,
      model: routed,
      at: '2026-10-06T08:20:00Z',
      inputTokens: 1000,
      outputTokens: 200,
      costMicros: 5000,
    });
    const store = new InMemoryUsageBuckets(() => [digdir, other]);
    store.setRates([{ currency: 'USD', day: '2026-10-01', nokPerUnit: usdNok }]);
    now = new Date('2026-10-06T12:00:00Z');
    await pollUsage(gateway, store, {
      firstStart: new Date('2026-10-06T00:00:00Z'),
      now: () => now,
    });
    const calls = [
      genkiCall('own', direct, '2026-10-06T08:15:00Z'),
      genkiCall('through', routed, '2026-10-06T08:20:00Z'),
    ];
    const rows: PortalTaskRow[] = calls.map((c) => ({
      task: c.task.id,
      tenant: digdir,
      status: 'completed',
      at: c.task.createdAt,
    }));
    return setup({
      tasks: () => rows,
      task: async (id) => calls.find((c) => c.task.id === id)?.task,
      events: async function* (id): AsyncIterable<Event> {
        const found = calls.find((c) => c.task.id === id);
        if (found) yield found.event;
      },
      prices: { [direct]: price, [routed]: price },
      gatewayUsage: store,
      ...extra,
    });
  };

  type Totals = {
    inputTokens: number;
    outputTokens: number;
    costMicroNok: number | null;
    bySource?: { source: string; usage: Totals }[];
  };
  type Report = {
    totals: Totals;
    daily: { date: string; usage: Totals }[];
    byModel: { model: string; source?: string; usage: Totals }[];
    bySubject?: {
      subject: { kind: string; id: string } | null;
      cost: { currency: string; micros: number };
      rate: number | null;
      rateDay: string | null;
    }[];
  };

  it('a call is counted once whether genki or the gateway measured it', async () => {
    const { send } = await threeCalls();
    const body = await json<Report>(await send(`/tenants/${digdir}/usage?days=1`, 'kari'));

    expect(body.totals).toMatchObject({
      inputTokens: 500 + 1000 + 1000,
      outputTokens: 50 + 200 + 200,
      costMicroNok: 2000 * usdNok + genkiCost + genkiCost,
    });
    expect(body.totals.bySource?.map((s) => [s.source, s.usage.inputTokens])).toEqual([
      ['genki', 2000],
      ['gateway', 500],
    ]);
  });

  it("counts the cost of a call through the gateway from the gateway once genki's endpoint runs through it", async () => {
    const { send } = await threeCalls({
      countingRule: () => ({ throughGateway: (model) => model === routed }),
    });
    const body = await json<Report>(await send(`/tenants/${digdir}/usage?days=1`, 'kari'));

    expect(body.totals).toMatchObject({
      inputTokens: 500 + 1000 + 1000,
      outputTokens: 50 + 200 + 200,
      costMicroNok: 2000 * usdNok + genkiCost + 5000 * usdNok,
    });
  });

  it('marks each model row with its source and shows gateway rows per owner with the amount, rate and day', async () => {
    const { send } = await threeCalls();
    const body = await json<Report>(await send(`/tenants/${digdir}/usage?days=1`, 'kari'));

    expect(body.byModel.map((r) => [r.source, r.model])).toEqual([
      ['genki', direct],
      ['genki', routed],
      ['gateway', 'gpt-6.1-sol'],
    ]);
    expect(body.bySubject).toEqual([
      {
        subject: { kind: 'org', id: digdir },
        usage: expect.objectContaining({ inputTokens: 500, costMicroNok: 20_000 }),
        cost: { currency: 'USD', micros: 2000 },
        rate: usdNok,
        rateDay: '2026-10-01',
      },
    ]);
    expect(body.daily.at(-1)?.usage.bySource?.[1]?.usage.inputTokens).toBe(500);
  });

  it('counts a gateway amount without a rate as unpriced in kroner, never as 0', async () => {
    const store = await threeRows();
    const { send: withoutRate } = await threeCalls({
      gatewayUsage: {
        tenantRows: (...args) => store.tenantRows(...args),
        unassignedRows: async () => [],
        rates: async () => [],
      },
    });
    const body = await json<Report & { priced: boolean }>(
      await withoutRate(`/tenants/${digdir}/usage?days=1`, 'kari'),
    );

    expect(body.priced).toBe(false);
    expect(body.totals.bySource?.[1]?.usage).toMatchObject({ costMicroNok: null });
    expect(body.totals.costMicroNok).toBe(2 * genkiCost);
  });

  it("leaves usage genki's own, with no source fields, when no gateway is configured", async () => {
    const { send } = await setup();
    const body = await json<Report>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));

    expect(body.totals.bySource).toBeUndefined();
    expect(body.bySubject).toBeUndefined();
    expect(body.byModel.every((r) => r.source === undefined)).toBe(true);
  });

  it('gives operators both sources for every tenant from one gateway read', async () => {
    let reads = 0;
    const store = await threeRows();
    const counted = await threeCalls({
      gatewayUsage: {
        tenantRows: (...args) => {
          reads += 1;
          return store.tenantRows(...args);
        },
        unassignedRows: () => store.unassignedRows(new Date(0), new Date()),
        rates: () => store.rates(),
      },
    });
    const body = await json<{ data: { orgNumber: string; usage: Totals }[] }>(
      await counted.send(`/operator/usage?tenants=${digdir},${other}`, 'operator'),
    );

    expect(reads).toBe(1);
    expect(body.data.map((d) => [d.orgNumber, d.usage.bySource?.[1]?.usage.inputTokens])).toEqual([
      [digdir, 500],
      [other, 0],
    ]);
    expect((await counted.send('/operator/usage/unassigned', 'kari')).status).toBe(403);
    expect((await counted.send('/operator/usage/unassigned', 'operator')).status).toBe(200);
  });

  it("shows a tenant only its own organisation's gateway usage, whatever tenant or organisation the request names", async () => {
    let now = new Date('2026-10-06T08:00:00Z');
    const gateway = memoryUsageSource({ now: () => now });
    for (const [org, inputTokens] of [
      [digdir, 500],
      [other, 7000],
    ] as const)
      gateway.record({
        client: 'portal',
        org,
        model: 'gpt-6.1-sol',
        at: '2026-10-06T08:10:00Z',
        inputTokens,
        outputTokens: 50,
        costMicros: 2000,
      });
    const store = new InMemoryUsageBuckets(() => [digdir, other]);
    now = new Date('2026-10-06T12:00:00Z');
    await pollUsage(gateway, store, {
      firstStart: new Date('2026-10-06T00:00:00Z'),
      now: () => now,
    });
    const { send } = await threeCalls({ gatewayUsage: store });
    const fromGateway = async (path: string, who: string) => {
      const body = await json<Report>(await send(path, who));
      return body.totals.bySource?.find((s) => s.source === 'gateway')?.usage.inputTokens;
    };

    expect(await fromGateway(`/tenants/${digdir}/usage?days=1`, 'kari')).toBe(500);
    expect(
      await fromGateway(`/tenants/${digdir}/usage?days=1&tenant=${other}&org=${other}`, 'kari'),
    ).toBe(500);
    expect((await send(`/tenants/${other}/usage?days=1`, 'kari')).status).toBe(404);
    expect(await fromGateway(`/tenants/${other}/usage?days=1`, 'ola')).toBe(7000);
  });

  const threeRows = async () => {
    let now = new Date('2026-10-06T08:00:00Z');
    const gateway = memoryUsageSource({ now: () => now });
    gateway.record({
      client: 'portal',
      org: digdir,
      model: 'gpt-6.1-sol',
      at: '2026-10-06T08:10:00Z',
      inputTokens: 500,
      outputTokens: 50,
      costMicros: 2000,
    });
    const store = new InMemoryUsageBuckets(() => [digdir, other]);
    store.setRates([{ currency: 'USD', day: '2026-10-01', nokPerUnit: usdNok }]);
    now = new Date('2026-10-06T12:00:00Z');
    await pollUsage(gateway, store, {
      firstStart: new Date('2026-10-06T00:00:00Z'),
      now: () => now,
    });
    return store;
  };
});

describe('usage totals with open units', () => {
  it('shows units besides tokens and marks a unit without a price as not priced', () => {
    const view = usageView(tallyOf({ units: { page: 3 }, audioSeconds: 7 }));

    expect(view).toMatchObject({
      priced: false,
      units: { page: 3, 'audio-second': 7 },
      unpricedUnits: { page: 3, 'audio-second': 7 },
    });
  });

  it('counts a unit as priced when the call that reported it was priced', () => {
    const view = usageView(tallyOf({ units: { page: 3 }, costMicroNok: 30_000 }));

    expect(view).toMatchObject({ priced: true, units: { page: 3 }, unpricedUnits: {} });
  });
});

describe('the failure cause on the run list', () => {
  const failed = (task: string, message: string, code = 'deadline_exceeded'): Event =>
    ({
      task,
      seq: 4,
      type: 'kernel.error',
      v: 1,
      ts: '2026-10-06T08:00:02Z',
      actor: { kind: 'kernel', id: 'kernel' },
      audience: 'audit',
      data: { code, message },
    }) as Event;
  const leaky = 'provider said: invalid key sk-hemmelig-1234 for https://intern.example';
  const withErrors = () =>
    setup({
      events: async function* (id): AsyncIterable<Event> {
        if (id === 't2') yield failed('t2', leaky);
        if (id === 't3') yield failed('t3', 'step summarize failed: timeout');
      },
    });
  const reader: Principal = {
    kind: 'employee',
    issuer: 'test',
    subject: 'leser',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['read'] }],
  };
  Object.assign(principals, { leser: reader });

  it('gives each failed run on the tenant run list a code and a fixed reason, for any member', async () => {
    const { send } = await withErrors();

    const body = await json<{ data: { id: string; failure?: unknown }[] }>(
      await send(`/tenants/${digdir}/tasks`, 'leser'),
    );

    expect(body.data.find((r) => r.id === 't2')?.failure).toEqual({
      code: 'deadline_exceeded',
      reason: expect.any(String),
    });
    expect(body.data.find((r) => r.id === 't1')).not.toHaveProperty('failure');
  });

  it('never puts the provider or model error text in a failure on the run list', async () => {
    const { send } = await withErrors();

    const text = await (await send(`/tenants/${digdir}/tasks?status=failed`, 'leser')).text();

    expect(text).not.toContain('sk-hemmelig');
    expect(text).not.toContain('intern.example');
  });

  it('gives a failed run its failure cause when read on its own', async () => {
    const { send } = await withErrors();

    const body = await json<{ failure?: { code: string } }>(
      await send(`/tenants/${digdir}/tasks/t2`, 'leser'),
    );

    expect(body.failure?.code).toBe('deadline_exceeded');
  });

  it('reads failure causes in one batch of error events and gives the fixed reason of the audit event', async () => {
    const asked: { tasks: string[]; type: string }[] = [];
    const error = (audience: string, code: string, message: string) =>
      ({ ...failed('t2', message), audience, data: { code, message } }) as Event;
    const { send } = await setup({
      events: async function* (): AsyncIterable<Event> {},
      eventsOfType: async (tasks, type) => {
        asked.push({ tasks, type });
        if (type !== 'kernel.error') return [];
        return [
          error('client', 'model_error', 'kunden ser dette'),
          error('audit', 'deadline_exceeded', leaky),
        ];
      },
    });

    const body = await json<{ data: { id: string; failure?: { code: string; reason: string } }[] }>(
      await send(`/tenants/${digdir}/tasks?status=failed`, 'leser'),
    );

    expect(asked.filter((a) => a.type === 'kernel.error')).toEqual([
      { tasks: ['t2'], type: 'kernel.error' },
    ]);
    expect(body.data.find((r) => r.id === 't2')?.failure).toEqual({
      code: 'deadline_exceeded',
      reason: failureReason({ code: 'deadline_exceeded' }),
    });
  });

  it('names the searches as the cause only when every search failed and that explains the failure, in fixed words and never with the engine text', async () => {
    const searchNotice = (data: Record<string, unknown>) =>
      ({
        task: 't2',
        seq: 2,
        type: 'kernel.notice',
        v: 1,
        ts: '2026-10-06T08:00:01Z',
        actor: { kind: 'kernel', id: 'kernel' },
        audience: 'client',
        data: { kind: 'retrieval', queries: ['ventetid'], hits: [], ...data },
      }) as unknown as Event;
    const failureWith = async (notice: Event, code: string) => {
      const { send } = await setup({
        events: async function* (id): AsyncIterable<Event> {
          if (id !== 't2') return;
          yield notice;
          yield failed('t2', leaky, code);
        },
      });
      const listed = await json<{ data: { id: string; failure?: Record<string, unknown> }[] }>(
        await send(`/tenants/${digdir}/tasks`, 'leser'),
      );
      const one = await json<{ failure?: Record<string, unknown> }>(
        await send(`/tenants/${digdir}/tasks/t2`, 'leser'),
      );
      expect(JSON.stringify(listed)).not.toContain('ventetid');
      expect(one.failure).toEqual(listed.data.find((r) => r.id === 't2')?.failure);
      return one.failure;
    };

    const timedOut = await failureWith(
      searchNotice({ failedCompletely: 'timeout' }),
      'deadline_exceeded',
    );
    const modelAfterPartial = await failureWith(
      searchNotice({ failed: [{ strategy: 'content', reason: 'timeout' }] }),
      'model_unavailable',
    );
    const deadlineAfterPartial = await failureWith(
      searchNotice({ failed: [{ strategy: 'content', reason: 'timeout' }] }),
      'deadline_exceeded',
    );
    const modelAfterAll = await failureWith(
      searchNotice({ failedCompletely: 'timeout' }),
      'model_unavailable',
    );

    expect(timedOut).toEqual({
      code: 'deadline_exceeded',
      reason: failureReason({ code: 'deadline_exceeded' }),
      detail: 'Alle søkene tok for lang tid.',
    });
    expect(modelAfterPartial).not.toHaveProperty('detail');
    expect(deadlineAfterPartial).not.toHaveProperty('detail');
    expect(modelAfterAll).not.toHaveProperty('detail');
  });

  it("never lists another tenant's failed runs or their causes", async () => {
    const { send } = await withErrors();

    const text = await (await send(`/tenants/${digdir}/tasks`, 'leser')).text();

    expect(text).not.toContain('t3');
    expect(text).not.toContain('summarize');
    expect((await send(`/tenants/${other}/tasks`, 'leser')).status).toBe(404);
  });
});

describe('one price source for every cost figure', () => {
  const usageEvent = (task: string, model: string): Event =>
    ({
      task,
      seq: 3,
      type: 'kernel.usage',
      v: 1,
      ts: '2026-10-06T08:00:01Z',
      actor: { kind: 'kernel', id: 'kernel' },
      data: {
        usage: { inputTokens: 1000, outputTokens: 200, requests: 1 },
        model: { kind: 'model', id: model },
      },
    }) as Event;
  const withModels = (models: Record<string, string>, extra = {}) =>
    setup({
      events: async function* (id): AsyncIterable<Event> {
        const model = models[id];
        if (model) yield usageEvent(id, model);
      },
      ...extra,
    });

  it('names the models without a price in usage totals and counts only the priced part', async () => {
    const { send } = await withModels({ t1: 'foundry/gpt-4o', t2: 'foundry/uten-pris' });

    const body = await json<{
      priced: boolean;
      totals: { priced: boolean; costMicroNok: number | null; unpricedModels: string[] };
    }>(await send(`/tenants/${digdir}/usage?days=30`, 'kari'));

    expect(body.totals.unpricedModels).toEqual(['foundry/uten-pris']);
    expect(body.totals.priced).toBe(false);
    expect(body.totals.costMicroNok).toBe(42_840);
  });

  it('gives the overview the same unpriced models and cost as the usage report', async () => {
    const { send } = await withModels({ t1: 'foundry/gpt-4o', t2: 'foundry/uten-pris' });

    const usage = await json<{ totals: { costMicroNok: number; unpricedModels: string[] } }>(
      await send(`/tenants/${digdir}/usage?days=6`, 'kari'),
    );
    const overview = await json<{
      usageThisMonth: { costMicroNok: number; unpricedModels: string[] };
    }>(await send(`/tenants/${digdir}/overview`, 'kari'));

    expect(overview.usageThisMonth.unpricedModels).toEqual(['foundry/uten-pris']);
    expect(overview.usageThisMonth.unpricedModels).toEqual(usage.totals.unpricedModels);
    expect(overview.usageThisMonth.costMicroNok).toBe(usage.totals.costMicroNok);
  });

  it('marks the usage report unpriced whenever its totals are, also for an open unit without a price', async () => {
    const { send } = await withModels(
      { t1: 'foundry/gpt-4o', t2: 'foundry/gpt-4o' },
      {
        ingestionUsage: async () => [
          {
            at: '2026-10-06T07:00:00Z',
            dataset: 'filer',
            model: 'foundry/gpt-4o',
            usage: { inputTokens: 10, units: { page: 3 } },
          },
        ],
      },
    );

    const body = await json<{ priced: boolean; totals: { priced: boolean } }>(
      await send(`/tenants/${digdir}/usage?days=30`, 'kari'),
    );

    expect(body.totals.priced).toBe(false);
    expect(body.priced).toBe(body.totals.priced);
  });
});

describe('service tabs: latency, failure causes and run search', () => {
  const ended = (
    id: string,
    at: string,
    ms: number,
    status: Task['status'] = 'completed',
  ): Task => ({
    ...task(id, digdir, at, status),
    endedAt: new Date(Date.parse(at) + ms).toISOString(),
  });
  const error = (id: string, code: string): Event =>
    ({
      task: id,
      seq: 4,
      type: 'kernel.error',
      v: 1,
      ts: '2026-10-06T08:00:02Z',
      actor: { kind: 'kernel', id: 'kernel' },
      audience: 'audit',
      data: { code, message: 'hemmelig detalj' },
    }) as Event;
  const question = (id: string, text: string): Event =>
    ({
      task: id,
      seq: 1,
      type: 'kernel.task.input',
      v: 1,
      ts: '2026-10-06T08:00:00Z',
      actor: { kind: 'kernel', id: 'kernel' },
      data: { input: { data: { query: text } } },
    }) as Event;
  const withTasks = (tasks: Task[], events: Event[] = []) =>
    setup({
      tasks: () =>
        tasks.map((t) => ({ task: t.id, tenant: t.tenant, status: t.status, at: t.createdAt })),
      task: async (id: string) => tasks.find((t) => t.id === id),
      events: async function* (id): AsyncIterable<Event> {
        for (const e of events) if (e.task === id) yield e;
      },
    });

  it('gives each service the p50 and p95 time of the runs that ended in the period', async () => {
    const { send } = await withTasks([
      ended('a', '2026-10-06T08:00:00Z', 1000),
      ended('b', '2026-10-06T08:01:00Z', 4000),
      ended('c', '2026-10-06T08:02:00Z', 2000),
      ended('d', '2026-10-06T08:03:00Z', 3000, 'failed'),
      task('e', digdir, '2026-10-06T08:04:00Z', 'running'),
    ]);

    const body = await json<{ byService: { service: string; latency: unknown }[] }>(
      await send(`/tenants/${digdir}/usage?days=3`, 'kari'),
    );

    expect(body.byService[0]?.latency).toEqual({ p50Ms: 2000, p95Ms: 4000, runs: 4 });
  });

  it("groups today's failed runs per service by failure code, the most common first", async () => {
    const { send } = await withTasks(
      [
        ended('a', '2026-10-06T08:00:00Z', 10, 'failed'),
        ended('b', '2026-10-06T09:00:00Z', 10, 'failed'),
        ended('c', '2026-10-06T10:00:00Z', 10, 'failed'),
        ended('old', '2026-10-05T09:00:00Z', 10, 'failed'),
      ],
      [error('a', 'model_error'), error('b', 'deadline_exceeded'), error('c', 'model_error')],
    );

    const response = await send(`/tenants/${digdir}/service-failures`, 'kari');
    const body = await json<{
      from: string;
      data: { service: string; failed: number; causes: { code: string; count: number }[] }[];
    }>(response);

    expect(body.from).toBe('2026-10-05T22:00:00.000Z');
    expect(body.data).toEqual([
      {
        service: 'klarsprak',
        failed: 3,
        causes: [
          { code: 'model_error', reason: expect.any(String), count: 2 },
          { code: 'deadline_exceeded', reason: expect.any(String), count: 1 },
        ],
      },
    ]);
    expect(JSON.stringify(body)).not.toContain('hemmelig');
  });

  it("never counts another organisation's failed runs", async () => {
    const { send } = await withTasks(
      [{ ...ended('x', '2026-10-06T08:00:00Z', 10, 'failed'), tenant: other, owner: other }],
      [error('x', 'model_error')],
    );

    const body = await json<{ data: unknown[] }>(
      await send(`/tenants/${digdir}/service-failures`, 'kari'),
    );

    expect(body.data).toEqual([]);
    expect((await send(`/tenants/${digdir}/service-failures`, 'ola')).status).toBe(404);
  });

  it('pages through the run list with offset and keeps the total', async () => {
    const { send } = await withTasks([
      ended('a', '2026-10-06T08:00:00Z', 10),
      ended('b', '2026-10-06T09:00:00Z', 10),
      ended('c', '2026-10-06T10:00:00Z', 10),
    ]);

    const body = await json<{ data: { id: string }[]; total: number; offset: number }>(
      await send(`/tenants/${digdir}/tasks?limit=2&offset=2`, 'kari'),
    );

    expect(body.data.map((r) => r.id)).toEqual(['a']);
    expect(body).toMatchObject({ total: 3, offset: 2, limit: 2 });
  });

  it('finds runs by run id or by the question, but only searches questions for people who manage services', async () => {
    const tasks = [
      ended('run-tilskudd', '2026-10-06T08:00:00Z', 10),
      ended('run-2', '2026-10-06T09:00:00Z', 10),
      ended('run-3', '2026-10-06T10:00:00Z', 10),
    ];
    const { send } = await withTasks(tasks, [
      question('run-2', 'Hva er reglene for tilskudd?'),
      question('run-3', 'Noe annet'),
    ]);
    const reader: Principal = {
      kind: 'employee',
      issuer: 'test',
      subject: 'soker',
      tenant: digdir,
      authorizedFor: [{ org: digdir, actions: ['read'] }],
    };
    Object.assign(principals, { soker: reader });

    const manager = await json<{ data: { id: string }[]; total: number }>(
      await send(`/tenants/${digdir}/tasks?q=Tilskudd`, 'kari'),
    );
    const member = await json<{ data: { id: string }[] }>(
      await send(`/tenants/${digdir}/tasks?q=tilskudd`, 'soker'),
    );

    expect(manager.data.map((r) => r.id)).toEqual(['run-2', 'run-tilskudd']);
    expect(manager.total).toBe(2);
    expect(member.data.map((r) => r.id)).toEqual(['run-tilskudd']);
  });

  it('never finds a run by the question of an erased run', async () => {
    const { send } = await setup({
      tasks: () => [
        { task: 't9', tenant: digdir, status: 'completed', at: '2026-10-06T08:00:00Z' },
      ],
      task: async () => ended('t9', '2026-10-06T08:00:00Z', 10),
      events: async function* (): AsyncIterable<Event> {
        yield question('t9', 'Personnummer 12345678901');
      },
      erasures: async () => [
        {
          task: 't9',
          tenant: digdir,
          at: '2026-10-06T09:00:00Z',
          by: 'kari',
          reason: 'Innsyn',
        } as never,
      ],
    });

    const body = await json<{ data: unknown[] }>(
      await send(`/tenants/${digdir}/tasks?q=12345678901`, 'kari'),
    );

    expect(body.data).toEqual([]);
  });
});

describe('who started a run and how it came in', () => {
  const by = (
    id: string,
    at: string,
    principal: Task['principal'],
    more: Partial<Task> = {},
  ): Task => ({ ...task(id, digdir, at), principal, ...more });
  const person = (subject: string, tenant = digdir) => ({
    kind: 'employee',
    id: JSON.stringify(['test', subject]),
    tenant,
  });
  const key = (id: string) => ({
    kind: 'service',
    id: JSON.stringify([LEGACY_KEY_ISSUER, id]),
    tenant: digdir,
  });
  const tasks = [
    by('api', '2026-10-06T08:00:00Z', person('kari'), { entryPoint: 'openai' }),
    by('key', '2026-10-06T08:01:00Z', key('k1'), { entryPoint: 'openai' }),
    by('frontend', '2026-10-06T08:02:00Z', key('k2'), { entryPoint: 'openai' }),
    by('batch', '2026-10-06T08:03:00Z', person('per')),
    by('trigger', '2026-10-06T08:04:00Z', { kind: 'workload', id: '["platform","trigger"]' }),
    {
      ...by('shared', '2026-10-06T08:05:00Z', person('kari', other), { entryPoint: 'openai' }),
      tenant: other,
    },
    task('trial', digdir, '2026-10-06T08:06:00Z', 'completed', 'platform/draft/playground/p1'),
  ];
  const stored = (id: string, clientId?: string): TenantApiKey => ({
    id,
    tenant: digdir,
    name: `Nøkkel ${id}`,
    digest: id,
    scopes: [],
    datasets: [],
    agents: [],
    ...(clientId ? { clientId } : {}),
  });
  const boot = () =>
    setup({
      tasks: () =>
        tasks.map((t) => ({ task: t.id, tenant: t.owner, status: t.status, at: t.createdAt })),
      task: async (id: string) => tasks.find((t) => t.id === id),
      apiKeys: {
        list: async (tenant: string) =>
          tenant === digdir ? [stored('k1'), stored('k2', 'nettside')] : [],
        add: async () => undefined,
        revoke: async () => undefined,
      },
      batchTasks: async (tenant: string) => new Set(tenant === digdir ? ['batch'] : []),
    });
  const list = async (send: Awaited<ReturnType<typeof boot>>['send'], query = '', who = 'kari') =>
    json<{ data: { id: string; channel: unknown; actor: { id?: string } }[]; total: number }>(
      await send(`/tenants/${digdir}/tasks${query}`, who),
    );

  it('says through which channel each run came in, from what the run records', async () => {
    const { send } = await boot();

    const service = await list(send);
    const trials = await list(send, '?origin=playground');
    const channels = Object.fromEntries(service.data.map((r) => [r.id, r.channel]));

    expect(channels).toEqual({
      api: 'api',
      key: 'api-key',
      frontend: 'interface',
      batch: 'batch',
      trigger: null,
      shared: 'api',
    });
    expect(trials.data.map((r) => [r.id, r.channel])).toEqual([['trial', 'playground']]);
  });

  it("filters the run list by the caller's own runs or by an actor id from a row", async () => {
    const { send } = await boot();

    const mine = await list(send, '?actor=me');
    const byKey = await list(send, '?actor=api-key%3Ak1');
    const byPer = await list(send, `?actor=${encodeURIComponent('employee:test:per')}`);

    expect(mine.data.map((r) => r.id)).toEqual(['api']);
    expect(byKey.data.map((r) => r.id)).toEqual(['key']);
    expect(byPer).toMatchObject({ total: 1, data: [{ id: 'batch' }] });
    expect(byPer.data[0]?.actor.id).toBe('employee:test:per');
  });

  it('never names or matches an actor from another tenant, even on a run of its own service', async () => {
    const { send } = await boot();

    const all = await list(send);
    const asOther = await list(send, `?actor=${encodeURIComponent('employee:test:kari')}`);

    expect(all.data.find((r) => r.id === 'shared')?.actor.id).toBeUndefined();
    expect(asOther.data.map((r) => r.id)).toEqual(['api']);
    expect((await send(`/tenants/${digdir}/tasks?actor=me`, 'ola')).status).toBe(404);
  });

  it('refuses an actor filter that is neither me nor an actor id', async () => {
    const { send } = await boot();

    const res = await send(`/tenants/${digdir}/tasks?actor=kari`, 'kari');

    expect(res.status).toBe(400);
  });

  it("gives each day of a service's usage the p50 and p95 time of that day's ended runs", async () => {
    const ended = (id: string, at: string, ms: number): Task => ({
      ...task(id, digdir, at),
      endedAt: new Date(Date.parse(at) + ms).toISOString(),
    });
    const daily = [
      ended('a', '2026-10-05T08:00:00Z', 1000),
      ended('b', '2026-10-05T09:00:00Z', 3000),
      ended('c', '2026-10-06T08:00:00Z', 500),
      task('d', digdir, '2026-10-06T09:00:00Z', 'running'),
    ];
    const { send } = await setup({
      tasks: () =>
        daily.map((t) => ({ task: t.id, tenant: t.tenant, status: t.status, at: t.createdAt })),
      task: async (id: string) => daily.find((t) => t.id === id),
    });

    const body = await json<{
      daily: { date: string; byService: Record<string, { latency: unknown }> }[];
    }>(await send(`/tenants/${digdir}/usage?days=3`, 'kari'));
    const latency = Object.fromEntries(
      body.daily.map((d) => [d.date, d.byService.klarsprak?.latency]),
    );

    expect(latency).toEqual({
      '2026-10-04': undefined,
      '2026-10-05': { p50Ms: 1000, p95Ms: 3000, runs: 2 },
      '2026-10-06': { p50Ms: 500, p95Ms: 500, runs: 1 },
    });
  });
});
