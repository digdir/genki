import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Event, Principal, Task } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { apiKeyDigest, createAuthenticator, InMemoryApiKeys, keyReaches } from '@genai/identity';
import { InMemoryConnections } from '@genai/providers-mcp-client';
import { createAdmin } from '../admin.js';
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
  type PortalTaskRow,
} from './portal-routes.js';

const task = (
  id: string,
  tenant: string,
  at: string,
  status: Task['status'] = 'completed',
): Task => ({
  id,
  service: {
    capability: { id: `${tenant}/klarsprak/default`, version: '1' },
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
    now: () => new Date('2026-10-06T12:00:00Z'),
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
    const authenticator = createAuthenticator({ apiKeys: legacy });
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
    const authenticator = createAuthenticator({ apiKeys: legacy });
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
