import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemorySettingsStore, type SettingsStore } from '@genai/definitions';
import {
  InMemoryCandidateStore,
  InMemoryEvalRunStore,
  InMemoryFeedbackStore,
  InMemoryLabelStore,
  InMemoryTestSetStore,
  type CandidateStore,
  type EvalRun,
  type EvalRunStore,
  type FeedbackStore,
  type LabelStore,
  type TestCaseCandidate,
  type TestSet,
  type TestSetStore,
} from '@genai/eval';
import { InMemoryTraceDeliveries, type TraceDelivery, type TraceDeliveryStore } from '@genai/jobs';
import { InMemoryClients, type ClientStore, type StoredClient } from '@genai/identity';
import { InMemoryConnections, type ConnectionRegistry } from '@genai/providers-mcp-client';
import { createPostgresStores, LocalKeyWrapper } from '@genai/providers-postgres';
import { InMemoryAdminRecords, type AdminRecordStore, type AuditEntry } from './admin.js';
import { CatalogRegistry } from './catalog-registry.js';
import { InMemoryConfigEntryStore, type ConfigEntryStore } from './config-store.js';
import { InMemoryExecutionStore, IngestionService, pendingIngestionBackend } from './ingestion.js';
import { createGateRegistry } from './scoped-registry.js';
import { InMemoryTenantSecrets, type TenantSecretStore } from './extensions.js';
import { stopPostgres } from '@genai/providers-postgres/testing';

interface Stores {
  settings: SettingsStore;
  admin: AdminRecordStore;
  secrets: TenantSecretStore;
  connections: ConnectionRegistry;
  testSets: TestSetStore;
  runs: EvalRunStore;
  feedback: FeedbackStore;
  candidates: CandidateStore;
  labels: LabelStore;
  clients: ClientStore;
  configEntries: ConfigEntryStore;
  traceDeliveries: TraceDeliveryStore;
}

interface Backend {
  name: string;
  stores(): Stores;
  reopen(): Promise<Stores>;
  raw?(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
}

const ORG_A = '991825827';
const ORG_B = '889640782';

const memory = (): Backend => {
  const stores: Stores = {
    settings: new InMemorySettingsStore(),
    admin: new InMemoryAdminRecords(),
    secrets: new InMemoryTenantSecrets(),
    connections: new InMemoryConnections(),
    testSets: new InMemoryTestSetStore(),
    runs: new InMemoryEvalRunStore(),
    feedback: new InMemoryFeedbackStore(),
    candidates: new InMemoryCandidateStore(),
    labels: new InMemoryLabelStore(),
    clients: new InMemoryClients(),
    configEntries: new InMemoryConfigEntryStore(),
    traceDeliveries: new InMemoryTraceDeliveries(),
  };
  return { name: 'memory', stores: () => stores, reopen: async () => stores };
};

let container: StartedPostgreSqlContainer;
type Database = Awaited<ReturnType<typeof createPostgresStores>>;
const databases: Database[] = [];
const wrapper = new LocalKeyWrapper(randomBytes(32));
let postgresBackend: Backend;

const connect = async () => {
  const db = await createPostgresStores(
    { connectionString: container.getConnectionUri() },
    wrapper,
  );
  databases.push(db);
  return db;
};

const openPostgres = async (): Promise<Stores> => {
  const db = await connect();
  return {
    settings: db.settings,
    admin: db.adminRecords,
    secrets: db.tenantSecrets,
    connections: db.connections,
    ...db.eval,
    labels: db.labels,
    clients: db.clients,
    configEntries: db.configEntries,
    traceDeliveries: db.traceDeliveries,
  };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const first = await openPostgres();
  const pool = (databases[0] as Database).pool;
  postgresBackend = {
    name: 'postgres',
    stores: () => first,
    reopen: openPostgres,
    raw: async (sql, params = []) => (await pool.query(sql, params)).rows,
  };
}, 120_000);

afterAll(async () => {
  for (const db of databases) {
    await db.close();
    await db.runtimePool.end();
    await db.pool.end();
  }
  await stopPostgres(container);
});

const testSet = (tenant: string, id: string, version: number, service?: string): TestSet => ({
  apiVersion: 'genai/v1',
  kind: 'TestSet',
  metadata: { tenant, id, name: `Testsett ${id}`, version },
  spec: {
    ...(service ? { service } : {}),
    cases: [
      {
        id: 'c1',
        split: 'validation',
        input: 'Hva er klarspråk?',
        expected: { sources: [] },
        grounding: 'sources-and-answer',
        tags: [],
        needsReview: false,
      },
    ],
  },
});

const run = (id: string, testSetId: string, endedAt: string): EvalRun => ({
  id,
  testSet: { tenant: ORG_A, id: testSetId, version: 1 },
  capability: `${ORG_A}/svar`,
  splits: ['validation'],
  repeats: 1,
  startedAt: endedAt,
  endedAt,
  provenance: { commit: 'abc', data: 'd1', servedModels: ['m'], judges: [], services: [] },
  results: [],
  metrics: {},
  byTag: {},
  incomplete: [],
});

const candidate = (id: string, tenant: string, proposedAt: string): TestCaseCandidate => ({
  id,
  tenant,
  task: `task-${id}`,
  question: 'Hvordan søker jeg om [national-id]?',
  sources: [],
  findings: [{ category: 'national-id', count: 1 }],
  status: 'pending-review',
  proposedBy: 'person:a',
  proposedAt,
  expiresAt: '2027-04-01T00:00:00.000Z',
});

const audit = (tenant: string, task: string): AuditEntry => ({
  task,
  tenant,
  action: 'platform.setting.set',
  actor: 'operator:platform:ola',
  at: '2026-10-07T08:00:00.000Z',
  outcome: 'applied',
  target: 'setting:retrieval.topK',
  reason: 'justering',
});

const memoryBackend = memory();
const backends = () => [memoryBackend, postgresBackend];

describe.each([['memory'], ['postgres']])('%s admin stores', (name) => {
  const backend = () => backends().find((b) => b.name === name) as Backend;

  it('keeps settings defaults, tenant values and locks across a reopen', async () => {
    const { settings } = backend().stores();
    await settings.appendDefault({
      key: 'retrieval.topK',
      version: 2,
      value: 12,
      changedAt: '2026-10-07T08:00:00.000Z',
      changedBy: 'operator:ola',
      reason: 'flere treff',
    });
    await settings.saveTenant(ORG_A, { values: { 'retrieval.topK': 8 }, pins: { other: 2 } }, 0);
    await settings.saveTenant(ORG_A, { values: { 'retrieval.topK': 9 }, pins: {} }, 1);
    await settings.saveLock('model.residency', { reason: 'norsk drift' });
    await settings.saveLock('gone', { reason: 'midlertidig' });
    await settings.saveLock('gone', undefined);

    const loaded = await (await backend().reopen()).settings.load();

    expect(loaded.defaults).toEqual([
      expect.objectContaining({
        key: 'retrieval.topK',
        version: 2,
        value: 12,
        reason: 'flere treff',
      }),
    ]);
    expect(loaded.tenants[ORG_A]).toEqual({ values: { 'retrieval.topK': 9 }, pins: {} });
    expect(loaded.tenantVersions[ORG_A]).toBe(2);
    expect(loaded.locks).toEqual({ 'model.residency': { reason: 'norsk drift' } });
  });

  it('refuses to rewrite a published default version', async () => {
    const { settings } = backend().stores();
    const version = { key: 'answer.length', version: 2, value: 'kort', reason: 'a' };
    await settings.appendDefault(version);
    await expect(settings.appendDefault({ ...version, value: 'lang' })).rejects.toThrow();
  });

  it('keeps support sessions and audit entries per tenant across a reopen', async () => {
    const { admin } = backend().stores();
    const session = {
      id: `s-${name}`,
      operator: 'operator:platform:ola',
      tenant: ORG_A,
      reason: 'feilsøking',
      openedAt: '2026-10-07T08:00:00.000Z',
      expiresAt: '2026-10-07T09:00:00.000Z',
    };
    await admin.saveSession(session);
    await admin.saveSession({ ...session, endedAt: '2026-10-07T08:30:00.000Z' });
    await admin.appendAudit(audit(ORG_A, 'task-a'));
    await admin.appendAudit({ ...audit(ORG_B, 'task-b'), onBehalfOf: ORG_B });

    const reopened = (await backend().reopen()).admin;

    expect(reopened.sessions()).toEqual([{ ...session, endedAt: '2026-10-07T08:30:00.000Z' }]);
    expect(await reopened.audit(ORG_A)).toEqual([audit(ORG_A, 'task-a')]);
    expect(await reopened.audit(ORG_B)).toEqual([{ ...audit(ORG_B, 'task-b'), onBehalfOf: ORG_B }]);
  });

  it('keeps tenant secrets apart per tenant and replaces them on set', async () => {
    const { secrets } = backend().stores();
    await secrets.set(ORG_A, 'mcp-token', 'first-value');
    await secrets.set(ORG_A, 'mcp-token', 'second-value');

    const reopened = (await backend().reopen()).secrets;

    expect(await reopened.get(ORG_A, 'mcp-token')).toBe('second-value');
    expect(await reopened.get(ORG_B, 'mcp-token')).toBeUndefined();

    await reopened.delete(ORG_B, 'mcp-token');
    expect(await reopened.get(ORG_A, 'mcp-token')).toBe('second-value');
    await reopened.delete(ORG_A, 'mcp-token');
    expect(await reopened.get(ORG_A, 'mcp-token')).toBeUndefined();
    expect(await reopened.list(ORG_A)).not.toContain('mcp-token');
  });

  it('registers a tool connection once and saves its pinned tools', async () => {
    const { connections } = backend().stores();
    const input = {
      id: 'lovdata',
      tenant: ORG_A,
      name: 'Lovdata',
      endpoint: 'https://mcp.example.no/mcp',
      version: '1.0',
      allow: [{ host: 'mcp.example.no' }],
      auth: { kind: 'bearer', secret: `secret://tenant/${ORG_A}/mcp-token` },
    };
    const connection = await connections.register(input);
    await expect(connections.register(input)).rejects.toThrow(/exists/);
    const tool = { remoteName: 'search', name: 'lovdata-search', description: 'Søk', input: {} };
    await connections.save({ connection, tools: [tool], pending: [] });

    const reopened = (await backend().reopen()).connections;

    expect(await reopened.get(ORG_A, 'lovdata')).toEqual({
      connection,
      tools: [tool],
      pending: [],
    });
    expect(await reopened.list(ORG_A)).toHaveLength(1);
    expect(await reopened.list(ORG_B)).toEqual([]);
  });

  it('versions test sets immutably and lists the latest per id', async () => {
    const { testSets } = backend().stores();
    await testSets.put(testSet(ORG_A, 'klarsprak', 1, 'svar'));
    await testSets.put(testSet(ORG_A, 'klarsprak', 2, 'svar'));
    await testSets.put(testSet(ORG_A, 'annet', 1));
    await expect(testSets.put(testSet(ORG_A, 'klarsprak', 2, 'svar'))).rejects.toThrow(/exists/);

    const reopened = (await backend().reopen()).testSets;

    expect((await reopened.get(ORG_A, 'klarsprak'))?.metadata.version).toBe(2);
    expect((await reopened.get(ORG_A, 'klarsprak', 1))?.metadata.version).toBe(1);
    expect((await reopened.list(ORG_A)).map((s) => s.metadata.id)).toEqual(['annet', 'klarsprak']);
    expect((await reopened.list(ORG_A, 'svar')).map((s) => s.metadata.id)).toEqual(['klarsprak']);
    expect(await reopened.list(ORG_B)).toEqual([]);
  });

  it('reads a test set stored before expected.criteria with its criteria moved there', async () => {
    const { testSets } = backend().stores();
    const old = testSet(ORG_A, 'nynorsk', 1);
    await testSets.put({
      ...old,
      spec: {
        cases: [
          {
            ...(old.spec.cases[0] as TestSet['spec']['cases'][number]),
            type: 'criteria',
            expected: { sources: [], referenceAnswer: 'Svaret er skrive på nynorsk.' },
          },
        ],
      },
    });

    const reopened = (await backend().reopen()).testSets;
    const [read] = (await reopened.get(ORG_A, 'nynorsk'))?.spec.cases ?? [];
    const [listed] = (await reopened.list(ORG_A))
      .filter((s) => s.metadata.id === 'nynorsk')
      .flatMap((s) => s.spec.cases);

    expect(read?.expected).toEqual({
      sources: [],
      criteria: { criteria: 'Svaret er skrive på nynorsk.' },
    });
    expect(listed?.expected).toEqual(read?.expected);
  });

  it('keeps each trace sent to a sink until its delete is confirmed, per tenant', async () => {
    const { traceDeliveries } = backend().stores();
    const at = '2026-10-29T02:00:00.000Z';
    await traceDeliveries.record(
      [
        { tenant: ORG_A, sink: 'etaten', task: 't1', trace: 'case-1' },
        { tenant: ORG_A, sink: 'etaten', task: 't2', trace: 'case-2' },
        { tenant: ORG_B, sink: 'etaten', task: 't3', trace: 'case-3' },
      ],
      at,
    );
    await traceDeliveries.record(
      [{ tenant: ORG_A, sink: 'etaten', task: 't1', trace: 'case-1' }],
      at,
    );

    expect(await traceDeliveries.markPending(ORG_A, { tasks: ['t1', 't3'] }, at)).toBe(1);
    const [pending] = await traceDeliveries.pending(10);
    expect(pending).toMatchObject({
      tenant: ORG_A,
      trace: 'case-1',
      state: 'pending',
      attempts: 0,
    });
    await traceDeliveries.settle(pending as TraceDelivery, { error: 'HTTP 503' }, at);
    expect(await traceDeliveries.pending(10)).toEqual([
      expect.objectContaining({ trace: 'case-1', attempts: 1, lastError: 'HTTP 503' }),
    ]);
    await traceDeliveries.settle(pending as TraceDelivery, { deleted: true }, at);

    const reopened = (await backend().reopen()).traceDeliveries;
    expect(await reopened.pending(10)).toEqual([]);
    expect(await reopened.outstanding(ORG_A, 'etaten')).toBe(1);
    expect(await reopened.markPending(ORG_B, { sink: 'etaten' }, at)).toBe(1);
    expect(await reopened.outstanding(ORG_B, 'etaten')).toBe(1);
  });

  it('stores eval runs and filters them newest first', async () => {
    const { runs } = backend().stores();
    await runs.save({
      run: run('r1', 'klarsprak', '2026-10-07T08:00:00.000Z'),
      tenant: ORG_A,
      task: 't1',
      service: 'svar',
      subject: 'v1',
    });
    await runs.save({
      run: run('r2', 'klarsprak', '2026-10-07T09:00:00.000Z'),
      tenant: ORG_A,
      task: 't2',
      service: 'svar',
      subject: 'v2',
    });
    await runs.save({
      run: run('r3', 'annet', '2026-10-07T10:00:00.000Z'),
      tenant: ORG_A,
      task: 't3',
    });

    const reopened = (await backend().reopen()).runs;

    expect(await reopened.get('r2')).toMatchObject({ tenant: ORG_A, task: 't2', subject: 'v2' });
    expect(await reopened.get('missing')).toBeUndefined();
    expect((await reopened.list({ tenant: ORG_A })).map((s) => s.run.id)).toEqual([
      'r3',
      'r2',
      'r1',
    ]);
    expect(
      (await reopened.list({ tenant: ORG_A, service: 'svar', subject: 'v1' })).map((s) => s.run.id),
    ).toEqual(['r1']);
    expect((await reopened.list({ tenant: ORG_A, testSet: 'annet' })).map((s) => s.run.id)).toEqual(
      ['r3'],
    );
    expect(await reopened.list({ tenant: ORG_B })).toEqual([]);
  });

  it('replaces a run only while it is still as it was read, so a late recovery never overwrites a finished run', async () => {
    const { runs } = backend().stores();
    const running = {
      ...run('r4', 'klarsprak', '2026-10-07T08:00:00.000Z'),
      status: 'running' as const,
      owner: 'instans-a',
      heartbeatAt: '2026-10-07T08:00:00.000Z',
    };
    await runs.save({ run: running, tenant: ORG_A, task: 't4' });
    const read = { status: running.status, heartbeatAt: running.heartbeatAt };
    await runs.save({
      run: { ...running, status: 'completed', heartbeatAt: '2026-10-07T08:05:00.000Z' },
      tenant: ORG_A,
      task: 't4',
    });

    const replaced = await runs.replace(
      { run: { ...running, status: 'interrupted' }, tenant: ORG_A, task: 't4' },
      read,
    );
    const current = await runs.replace(
      { run: { ...running, status: 'interrupted' }, tenant: ORG_A, task: 't4' },
      { status: 'completed', heartbeatAt: '2026-10-07T08:05:00.000Z' },
    );

    expect(replaced).toBe(false);
    expect(current).toBe(true);
    expect((await (await backend().reopen()).runs.get('r4'))?.run.status).toBe('interrupted');
  });

  it('appends feedback and filters it by task and rating', async () => {
    const { feedback } = backend().stores();
    const entry = (task: string, rating: 'up' | 'down', at: string) => ({
      tenant: ORG_A,
      task,
      rating,
      comment: 'Svaret var nyttig',
      by: { kind: 'person', id: 'idporten:abc' },
      at,
    });
    await feedback.save(entry('t1', 'up', '2026-10-07T08:00:00.000Z'));
    await feedback.save(entry('t2', 'down', '2026-10-07T09:00:00.000Z'));

    const reopened = (await backend().reopen()).feedback;

    expect((await reopened.list(ORG_A)).map((f) => f.task)).toEqual(['t2', 't1']);
    expect(await reopened.list(ORG_A, { rating: 'up' })).toEqual([
      entry('t1', 'up', '2026-10-07T08:00:00.000Z'),
    ]);
    expect(await reopened.list(ORG_A, { task: 't2' })).toHaveLength(1);
    expect(await reopened.list(ORG_B)).toEqual([]);
  });

  it('saves test case candidates and updates their status', async () => {
    const { candidates } = backend().stores();
    await candidates.save(candidate('c1', ORG_A, '2026-10-07T08:00:00.000Z'));
    await candidates.save(candidate('c2', ORG_A, '2026-10-07T09:00:00.000Z'));
    await candidates.save({
      ...candidate('c1', ORG_A, '2026-10-07T08:00:00.000Z'),
      status: 'rejected',
      reviewedBy: 'person:b',
    });

    const reopened = (await backend().reopen()).candidates;

    expect(await reopened.get('c1')).toMatchObject({ status: 'rejected', reviewedBy: 'person:b' });
    expect((await reopened.list(ORG_A)).map((c) => c.id)).toEqual(['c2', 'c1']);
    expect((await reopened.list(ORG_A, 'pending-review')).map((c) => c.id)).toEqual(['c2']);
    expect(await reopened.list(ORG_B)).toEqual([]);
  });

  it('appends judge labels and filters them by judge', async () => {
    const { labels } = backend().stores();
    const label = (judge: string) => ({
      item: 'i1',
      judge,
      judgeLabel: 'ok',
      humanLabel: 'ok',
      labeller: 'person:a',
    });
    await labels.add([label('klarsprak'), label('nynorsk')]);

    const reopened = (await backend().reopen()).labels;

    expect(await reopened.list('klarsprak')).toEqual([label('klarsprak')]);
    expect(await reopened.list()).toHaveLength(2);
  });
});

const client = (tenant: string, id: string, version: number): StoredClient => ({
  definition: {
    apiVersion: 'genai/v1',
    kind: 'Client',
    metadata: { tenant, id },
    spec: { service: 'svar', kind: 'server', channels: ['openai'], allowedOrigins: [] },
  },
  version,
  updatedAt: '2026-10-07T08:00:00.000Z',
  updatedBy: 'person:a',
});

const entry = (scope: string, id: string, version: number, deleted = false) => ({
  kind: 'model',
  scope,
  id,
  version,
  spec: { endpoint: 'foundry', deployment: id },
  deleted,
  by: 'operator:ola',
  at: `2026-10-07T08:0${version}:00.000Z`,
  reason: 'ny modell',
});

describe.each([['memory'], ['postgres']])('%s stores added alongside', (name) => {
  const backend = () => backends().find((b) => b.name === name) as Backend;

  it('saves, replaces, lists and removes clients per tenant', async () => {
    const { clients } = backend().stores();
    await clients.save(client(ORG_A, 'nettside', 1));
    await clients.save(client(ORG_A, 'nettside', 2));
    await clients.save(client(ORG_B, 'intranett', 1));

    const reopened = (await backend().reopen()).clients;

    expect((await reopened.get(ORG_A, 'nettside'))?.version).toBe(2);
    expect((await reopened.list(ORG_A)).map((c) => c.definition.metadata.id)).toEqual(['nettside']);
    expect(await reopened.list()).toHaveLength(2);
    expect(await reopened.remove(ORG_A, 'nettside')).toBe(true);
    expect(await reopened.remove(ORG_A, 'nettside')).toBe(false);
    expect(await reopened.get(ORG_A, 'nettside')).toBeUndefined();
  });

  it('appends config entries immutably and returns the latest per id', async () => {
    const { configEntries } = backend().stores();
    await configEntries.append(entry('platform', 'gpt', 1));
    await configEntries.append(entry('platform', 'gpt', 2, true));
    await configEntries.append(entry(ORG_A, 'egen', 1));
    await expect(configEntries.append(entry('platform', 'gpt', 2))).rejects.toThrow(/exists/);

    const reopened = (await backend().reopen()).configEntries;

    expect((await reopened.history('model', 'platform', 'gpt')).map((e) => e.version)).toEqual([
      1, 2,
    ]);
    expect(await reopened.latest({ scope: 'platform' })).toEqual([
      entry('platform', 'gpt', 2, true),
    ]);
    expect(await reopened.latest({ kind: 'model' })).toHaveLength(2);
    expect(await reopened.latest({ kind: 'dataset' })).toEqual([]);
  });

  it('keeps catalog entries, gates and pipelines published through the registries across a restart', async () => {
    const registry = (store: ConfigEntryStore) =>
      new CatalogRegistry({
        seed: { models: {}, knowledge: {}, rerank: {}, prices: {} },
        store,
        checks: { models: () => [], knowledge: () => [], rerank: () => [] },
        apply: () => undefined,
      });
    const { configEntries } = backend().stores();
    const first = registry(configEntries);
    await first.initialize();
    const price = await first.publish({
      kind: 'price',
      scope: 'platform',
      id: 'contract/model',
      spec: { inputPerThousand: 1, outputPerThousand: 2 },
      by: 'test',
      reason: 'kontrakt',
    });
    expect(price.ok).toBe(true);
    const gates = createGateRegistry({ store: configEntries, builtins: new Map() });
    await gates.save({
      scope: ORG_A,
      id: 'kontrakt',
      spec: { id: 'kontrakt', metric: 'recall@10', kind: 'no-regression' },
      by: 'test',
      reason: 'kontrakt',
    });
    const ingestion = new IngestionService({
      store: configEntries,
      executions: new InMemoryExecutionStore(),
      backend: pendingIngestionBackend(),
    });
    await ingestion.save({
      scope: ORG_A,
      dataset: `${ORG_A}/kontrakt`,
      id: 'sider',
      spec: { name: 'Sider', source: { kind: 'folder', path: 'docs' } },
      by: 'test',
      reason: 'kontrakt',
    });

    const reopened = (await backend().reopen()).configEntries;
    const second = registry(reopened);
    await second.initialize();

    expect(second.effective().prices['contract/model']).toEqual({
      inputPerThousand: 1,
      outputPerThousand: 2,
    });
    expect(
      (await createGateRegistry({ store: reopened, builtins: new Map() }).forTenant(ORG_A)).has(
        'kontrakt',
      ),
    ).toBe(true);
    const pipelines = await new IngestionService({
      store: reopened,
      executions: new InMemoryExecutionStore(),
      backend: pendingIngestionBackend(),
    }).list(ORG_A, `${ORG_A}/kontrakt`);
    expect(pipelines.map((p) => [p.id, p.version])).toEqual([['sider', 1]]);
  });
});

describe('postgres admin stores at rest', () => {
  it('keeps the bound service and allowed overrides of an API key', async () => {
    const db = await connect();
    await db.apiKeys.add({
      id: 'k-service',
      name: 'Tjenestenøkkel',
      digest: 'a'.repeat(64),
      tenant: ORG_A,
      scopes: ['query'],
      datasets: [],
      agents: [],
      service: 'svar',
      allowedOverrides: ['search.topK'],
    });

    expect(await db.apiKeys.findByDigest('a'.repeat(64))).toMatchObject({
      service: 'svar',
      allowedOverrides: ['search.topK'],
    });
  });

  it('encrypts secrets, feedback, candidates and tenant settings', async () => {
    const stores = postgresBackend.stores();
    await stores.secrets.set(ORG_B, 'plain-check', 'klartekst-hemmelighet');
    await stores.settings.saveTenant(
      ORG_B,
      { values: { note: 'klartekst-innstilling' }, pins: {} },
      0,
    );
    const raw = postgresBackend.raw as NonNullable<Backend['raw']>;

    const dump = JSON.stringify([
      await raw(`select encode(value, 'escape') as v from tenant_secrets`),
      await raw(`select encode(body, 'escape') as v from tenant_settings`),
      await raw(`select encode(body, 'escape') as v from eval_feedback`),
      await raw(`select encode(body, 'escape') as v from eval_candidates`),
    ]);

    expect(dump).not.toContain('klartekst');
    expect(dump).not.toContain('Svaret var nyttig');
    expect(dump).not.toContain('Hvordan søker');
  });

  it('refuses to change or delete audit entries, feedback, labels and default versions', async () => {
    const raw = postgresBackend.raw as NonNullable<Backend['raw']>;
    for (const sql of [
      `update admin_audit set reason = 'endret'`,
      `delete from admin_audit`,
      `delete from eval_feedback`,
      `update judge_labels set judge = 'x'`,
      `delete from setting_default_versions`,
      `delete from eval_test_sets`,
      `delete from config_entries`,
    ])
      await expect(raw(sql)).rejects.toThrow(/append-only/);
  });
});
