import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal, Task } from '@genai/contracts';
import {
  InMemoryDefinitionStore,
  SettingsRegistry,
  type DefinitionStore,
} from '@genai/definitions';
import {
  envSecrets,
  InMemoryEventLog,
  InMemoryTaskStore,
  type EventLog,
  type TaskStore,
} from '@genai/kernel';
import { InMemoryConnections } from '@genai/providers-mcp-client';
import { createPostgresStores, LocalKeyWrapper } from '@genai/providers-postgres';
import { createAdmin, type Admin } from './admin.js';
import { approvalKind, policyKind } from './building-blocks.js';
import { createPlatform } from './composition.js';
import {
  appendVersion,
  InMemoryConfigEntryStore,
  platformScope,
  type ConfigEntryStore,
} from './config-store.js';
import {
  InMemoryTenantDirectoryStore,
  TenantDirectory,
  trackTasks,
  type TaskIndex,
  type TenantDirectoryStore,
} from './extensions.js';
import {
  InMemoryExecutionStore,
  staleRunMessage,
  type Execution,
  type ExecutionStore,
} from './ingestion.js';
import { postgresTaskIndex, postgresTenantDirectory } from './postgres-adapters.js';
import { InMemoryTenantApiKeys, registerPortalRoutes } from './routes/portal-routes.js';
import { stopPostgres } from '@genai/providers-postgres/testing';

interface Stores {
  directory: TenantDirectoryStore;
  executions: ExecutionStore;
  tasks: TaskStore;
  taskIndex: TaskIndex;
  log: EventLog;
  configEntries: ConfigEntryStore;
}

interface Backend {
  name: string;
  stores(): Stores;
  reopen(): Promise<Stores>;
}

const ORG_A = '991825827';
const ORG_B = '889640782';

const memory = (): Backend => {
  const tracker = trackTasks(new InMemoryEventLog());
  const stores: Stores = {
    directory: new InMemoryTenantDirectoryStore(),
    executions: new InMemoryExecutionStore(),
    tasks: new InMemoryTaskStore(),
    taskIndex: tracker,
    log: tracker.log,
    configEntries: new InMemoryConfigEntryStore(),
  };
  return { name: 'memory', stores: () => stores, reopen: async () => stores };
};

let container: StartedPostgreSqlContainer;
type Database = Awaited<ReturnType<typeof createPostgresStores>>;
const databases: Database[] = [];
const wrapper = new LocalKeyWrapper(randomBytes(32));
let postgresBackend: Backend;

const openPostgres = async (): Promise<Stores> => {
  const db = await createPostgresStores(
    { connectionString: container.getConnectionUri() },
    wrapper,
  );
  databases.push(db);
  return {
    directory: postgresTenantDirectory(db.tenants),
    executions: db.ingestionExecutions,
    tasks: db.tasks,
    taskIndex: postgresTaskIndex(db.tasks),
    log: db.log,
    configEntries: db.configEntries,
  };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const first = await openPostgres();
  postgresBackend = { name: 'postgres', stores: () => first, reopen: openPostgres };
}, 120_000);

afterAll(async () => {
  for (const db of databases) {
    await db.close();
    await db.runtimePool.end();
    await db.pool.end();
  }
  await stopPostgres(container);
});

const memoryBackend = memory();
const backends = () => [memoryBackend, postgresBackend];

const execution = (id: string, startedAt: string, patch: Partial<Execution> = {}): Execution => ({
  id,
  dataset: `${ORG_A}/kontrakt`,
  pipeline: 'sider',
  pipelineVersion: 1,
  backend: 'pending',
  status: 'running',
  startedBy: 'employee:test:kari',
  startedAt,
  ...patch,
});

const task = (id: string, tenant: string, createdAt: string): Task => ({
  id,
  service: {
    capability: { id: `${tenant}/klarsprak/default`, version: '1' },
    strategy: { id: 'single-call', version: '1' },
    configHash: 'h',
  },
  principal: { kind: 'employee', id: 'kari', tenant },
  tenant,
  owner: tenant,
  status: 'completed',
  artifacts: [],
  usage: { inputTokens: 100, outputTokens: 20, requests: 1 },
  createdAt,
  endedAt: createdAt,
});

const record = async (stores: Stores, t: Task) => {
  const scope = { tenant: t.tenant, key: `task:${t.id}` };
  const principal: Principal = {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: t.tenant,
  };
  await stores.tasks.put({ task: t, principal, lastSeq: 1 }, scope);
  await stores.log.append(
    {
      type: 'kernel.task.status',
      v: 1,
      task: t.id,
      ts: t.createdAt,
      data: { status: t.status },
      actor: 'kernel',
    },
    scope,
  );
};

const operator: Principal = { kind: 'operator', issuer: 'test', subject: 'ola' };

const portal = (stores: Stores) => {
  const app = new Hono();
  registerPortalRoutes(app, {
    admin: {} as Admin,
    authenticate: async () => ({
      kind: 'employee',
      issuer: 'test',
      subject: 'kari',
      tenant: ORG_A,
    }),
    definitions: {
      capabilities: async () => [],
      get: async () => undefined,
    } as unknown as DefinitionStore,
    tasks: (tenant) => stores.taskIndex.all(tenant),
    task: async (id) => (await stores.tasks.get(id))?.task,
    apiKeys: new InMemoryTenantApiKeys(),
    connections: new InMemoryConnections(),
    requirementFor: () => ({ resource: 'urn:altinn:resource:test', action: 'read' }),
  });
  return app;
};

const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: ORG_A },
  operator,
};

const platformOn = async (configEntries: ConfigEntryStore, executions?: ExecutionStore) => {
  const platform = await createPlatform({
    ...(executions ? { ingestionExecutions: executions } : {}),
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: 'http://127.0.0.1:9/v1',
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [
          { id: 'fake/liten', endpoint: 'fake', deployment: 'liten', residency: 'norway' },
          { id: 'fake/stor', endpoint: 'fake', deployment: 'stor', residency: 'eu' },
        ],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    configurables: { store: configEntries },
    authenticate: async (request) => {
      const principal = people[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
  const app = new Hono();
  platform.mount(
    app,
    createAdmin({
      store: platform.definitions,
      plugins: platform.plugins,
      settings: new SettingsRegistry([]),
      extensions: platform.extensions,
    }),
  );
  return async (path: string, init: { method?: string; body?: unknown; as?: string } = {}) => {
    const response = await app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${init.as ?? 'kari'}`,
        'content-type': 'application/json',
        'change-reason': 'Tatt i bruk etter vurdering',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
};

const entry = (kind: string, scope: string, id: string, spec: unknown, reason: string) => ({
  kind,
  scope,
  id,
  spec,
  deleted: false,
  by: 'employee:test:kari',
  reason,
  at: '2026-10-07T10:00:00.000Z',
});

describe.each([['memory'], ['postgres']])('%s durable stores', (name) => {
  const backend = () => backends().find((b) => b.name === name) as Backend;

  it("keeps an onboarded tenant's name and status across a restart", async () => {
    await new TenantDirectory(backend().stores().directory).add(
      { orgNumber: ORG_B, name: 'Kartverket', status: 'onboarding' },
      'operator:test:ola',
    );

    const reopened = new TenantDirectory((await backend().reopen()).directory, async () => [ORG_A]);

    expect(await reopened.list()).toEqual([
      { orgNumber: ORG_B, name: 'Kartverket', status: 'onboarding' },
      { orgNumber: ORG_A, name: ORG_A, status: 'active' },
    ]);
  });

  it('keeps executions and their reports across a restart', async () => {
    const { executions } = backend().stores();
    await executions.save(execution('e1', '2026-10-07T08:00:00.000Z'));
    await executions.save(
      execution('e1', '2026-10-07T08:00:00.000Z', {
        status: 'succeeded',
        endedAt: '2026-10-07T08:05:00.000Z',
        report: { stored: 12, skipped: 1, failed: ['brutt.md'] },
      }),
    );
    await executions.save(
      execution('e2', '2026-10-07T09:00:00.000Z', {
        status: 'failed',
        endedAt: '2026-10-07T09:01:00.000Z',
        error: 'kilden svarte ikke',
      }),
    );

    const reopened = (await backend().reopen()).executions;

    expect(await reopened.get('e1')).toMatchObject({
      status: 'succeeded',
      endedAt: '2026-10-07T08:05:00.000Z',
      report: { stored: 12, skipped: 1, failed: ['brutt.md'] },
    });
    expect(
      (await reopened.list(`${ORG_A}/kontrakt`, 'sider')).map((e) => [e.id, e.status]),
    ).toEqual([
      ['e2', 'failed'],
      ['e1', 'succeeded'],
    ]);
  });

  it('marks runs left running for more than six hours as failed when the platform starts and keeps newer ones', async () => {
    const { executions } = backend().stores();
    const stale = execution(`${name}-stale`, '2026-10-07T01:00:00.000Z', { pipeline: 'restart' });
    const fresh = execution(`${name}-fresh`, new Date().toISOString(), { pipeline: 'restart' });
    await executions.save(stale);
    await executions.save(fresh);

    const reopened = await backend().reopen();
    await platformOn(reopened.configEntries, reopened.executions);

    expect(await reopened.executions.get(stale.id)).toMatchObject({
      status: 'failed',
      endedAt: expect.any(String),
      error: staleRunMessage,
    });
    expect((await reopened.executions.get(fresh.id))?.status).toBe('running');
  });

  it('does not mark a run this process holds as stale', async () => {
    const { executions } = backend().stores();
    const held = execution(`${name}-held`, '2026-10-06T01:00:00.000Z', { pipeline: 'restart' });
    await executions.save(held);

    const changed = await executions.failStale({
      startedBefore: '2026-10-06T02:00:00.000Z',
      except: [held.id],
      endedAt: '2026-10-07T08:00:00.000Z',
      error: staleRunMessage,
    });

    expect(changed).toBe(0);
    expect((await executions.get(held.id))?.status).toBe('running');
  });

  it("shows a tenant's runs in the portal after a restart", async () => {
    const stores = backend().stores();
    await record(stores, task(`${name}-a1`, ORG_A, '2026-10-07T08:00:00.000Z'));
    await record(stores, task(`${name}-b1`, ORG_B, '2026-10-07T08:10:00.000Z'));

    const response = await portal(await backend().reopen()).request(`/tenants/${ORG_A}/tasks`);
    const body = (await response.json()) as { data: { id: string; status: string }[] };

    expect(response.status).toBe(200);
    expect(body.data.map((t) => [t.id, t.status])).toEqual([[`${name}-a1`, 'completed']]);
  });

  it('keeps a building-block adoption across a restart', async () => {
    const send = await platformOn(backend().stores().configEntries);
    const block = `/tenants/${ORG_A}/building-blocks/model/${encodeURIComponent('fake/liten')}`;

    const adopted = await send(`${block}/adopt`, { body: {} });
    const reopened = await platformOn((await backend().reopen()).configEntries);

    expect(adopted.status).toBe(200);
    expect((await reopened(block)).body).toMatchObject({
      status: 'in_use',
      changedBy: { reason: 'Tatt i bruk etter vurdering' },
    });
  });

  it('keeps a building-block approval request across a restart', async () => {
    const stores = backend().stores();
    await appendVersion(
      stores.configEntries,
      entry(
        policyKind,
        platformScope,
        'models',
        {
          rules: [
            {
              id: 'store-modeller',
              match: { kind: 'model', id: 'fake/stor' },
              effect: 'requires_approval',
              ownedBy: 'digdir',
              text: 'Store modeller krever godkjenning.',
              approver: 'digdir',
            },
          ],
        },
        'Krever godkjenning av store modeller',
      ),
    );
    const send = await platformOn(stores.configEntries);
    const block = `/tenants/${ORG_A}/building-blocks/model/${encodeURIComponent('fake/stor')}`;

    const requested = await send(`${block}/approval-requests`, { body: {} });
    const reopened = await platformOn((await backend().reopen()).configEntries);
    const listed = await reopened('/operator/building-blocks/approval-requests', {
      as: 'operator',
    });

    expect(requested.status).toBe(200);
    expect(listed.body.data).toEqual([
      expect.objectContaining({
        tenant: ORG_A,
        block: expect.objectContaining({ id: 'fake/stor' }),
        status: 'pending',
      }),
    ]);
    expect((await reopened(block)).body).toMatchObject({ status: 'pending_approval' });
    const stored = await (
      await backend().reopen()
    ).configEntries.latest({
      kind: approvalKind,
      scope: ORG_A,
    });
    expect(stored).toHaveLength(1);
  });

  it('keeps a skill draft and its revisions across a restart', async () => {
    const send = await platformOn(backend().stores().configEntries);
    const created = await send(`/tenants/${ORG_A}/skills`, {
      body: { id: 'klarsprak', definition: { metadata: { name: 'Klarspråk' } } },
    });
    const definition = {
      metadata: { name: 'Klarspråk' },
      spec: { description: 'Skriv om til klarspråk.', instructions: 'Bruk korte setninger.' },
    };
    const saved = await send(`/tenants/${ORG_A}/skills/klarsprak`, {
      method: 'PUT',
      body: { definition },
    });

    const reopened = await platformOn((await backend().reopen()).configEntries);
    const detail = await reopened(`/tenants/${ORG_A}/skills/klarsprak`);

    expect(created.status).toBe(201);
    expect(saved.status).toBe(200);
    expect(detail.body).toMatchObject({
      status: 'draft',
      draftRevision: 2,
      draft: { revision: 2, definition: { spec: { instructions: 'Bruk korte setninger.' } } },
    });
  });

  it.each([
    [
      'skill-share',
      'klarsprak',
      { skill: 'klarsprak', version: 1, state: 'pending_digdir' },
      { skill: 'klarsprak', version: 1, state: 'shared', decision: { approved: true } },
    ],
    [
      'engine-switch',
      'kudos:1',
      { dataset: `${ORG_A}/kudos`, from: 'ka-typesense', to: 'platform-pg', state: 'ready' },
      {
        dataset: `${ORG_A}/kudos`,
        from: 'ka-typesense',
        to: 'platform-pg',
        state: 'active',
        previous: { endpoint: 'ka-typesense', keptUntil: '2026-10-21T10:00:00.000Z' },
      },
    ],
    [
      'catalog-proposal',
      'fs_12',
      { level: 2, createdBy: 'assistant', forService: { id: 'saksarkiv' }, state: 'pending' },
      {
        level: 2,
        createdBy: 'assistant',
        forService: { id: 'saksarkiv' },
        state: 'approved',
        decision: { by: 'Kari Nordmann', reason: 'Testet mot arkivet' },
      },
    ],
  ])('keeps %s entries and their history across a restart', async (kind, id, first, second) => {
    const { configEntries } = backend().stores();
    await appendVersion(configEntries, entry(kind, ORG_A, id, first, 'Første versjon'));
    await appendVersion(configEntries, {
      ...entry(kind, ORG_A, id, second, 'Andre versjon'),
      ifVersion: 1,
    });

    const reopened = (await backend().reopen()).configEntries;

    expect((await reopened.history(kind, ORG_A, id)).map((e) => [e.version, e.spec])).toEqual([
      [1, first],
      [2, second],
    ]);
    expect(await reopened.latest({ kind, scope: ORG_A })).toEqual([
      { ...entry(kind, ORG_A, id, second, 'Andre versjon'), version: 2 },
    ]);
  });
});

describe('the postgres task index and the monthly quota', () => {
  it('sums the tokens of this month in the store and leaves builder assistant turns out, as the quota does', async () => {
    const stores = await postgresBackend.reopen();
    const quotaOrg = '444555777';
    const assistant: Task = {
      ...task('quota-assistant', quotaOrg, '2026-10-10T08:00:00.000Z'),
      service: {
        capability: { id: 'platform/draft/assistant/0f3a9c2e7b1d4e65', version: '1' },
        strategy: { id: 'builder-assistant', version: '1' },
        configHash: 'h',
      },
    };
    await record(stores, task('quota-now', quotaOrg, '2026-10-09T08:00:00.000Z'));
    await record(stores, task('quota-before', quotaOrg, '2026-09-29T08:00:00.000Z'));
    await record(stores, assistant);

    expect(await stores.taskIndex.tokensUsed?.(quotaOrg, '2026-10-01T00:00:00.000Z')).toBe(120);
  });
});
