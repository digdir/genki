import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Task } from '@genai/contracts';
import { SettingsConflictError } from '@genai/definitions';
import {
  ContentKeys,
  createPool,
  grantRuntimeRole,
  LocalKeyWrapper,
  migrate,
  PostgresAdminRecords,
  PostgresIngestionExecutions,
  PostgresSettingsStore,
  PostgresTaskStore,
  PostgresTenants,
  type IngestionExecution,
} from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
let runtime: pg.Pool;
const pools: pg.Pool[] = [];
const wrapper = new LocalKeyWrapper(randomBytes(32));

const ORG_A = '991825827';
const ORG_B = '889640782';

const runtimePool = () => {
  const created = createPool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: 'genai_api',
    password: 'runtime-pw',
  });
  pools.push(created);
  return created;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  pools.push(admin);
  await migrate(admin);
  await admin.query(`create role genai_api login password 'runtime-pw' nosuperuser nobypassrls`);
  await grantRuntimeRole(admin, 'genai_api');
  runtime = runtimePool();
}, 120_000);

afterAll(async () => {
  await stopPostgres(container, pools);
});

const asTenant = async (tenant: string | undefined, sql: string) => {
  const client = await runtime.connect();
  try {
    await client.query('begin');
    if (tenant) await client.query(`select set_config('app.tenant', $1, true)`, [tenant]);
    const result = await client.query(sql);
    await client.query('commit');
    return result.rows;
  } finally {
    client.release();
  }
};

describe('tenants', () => {
  it('lists tenants with names and status for the platform only through a definer function with a purpose', async () => {
    const tenants = new PostgresTenants(runtime);
    await tenants.ensure(ORG_A, { createdBy: 'operator:x', name: 'Digdir' });
    await tenants.ensure(ORG_B, { createdBy: 'operator:x', status: 'onboarding' });

    expect(await tenants.list()).toMatchObject([
      { orgNumber: ORG_B, status: 'onboarding' },
      { orgNumber: ORG_A, name: 'Digdir', status: 'active' },
    ]);
    expect(await asTenant(undefined, 'select * from tenants')).toEqual([]);
    await expect(runtimePool().query(`select * from platform_tenants()`)).rejects.toThrow(
      /explicit platform access purpose/,
    );
    await admin.query('create role outsider login password $$x$$ nosuperuser');
    const outsider = createPool({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'outsider',
      password: 'x',
    });
    pools.push(outsider);
    await expect(outsider.query('select * from platform_tenants()')).rejects.toThrow(
      /permission denied/,
    );
  });

  it('fills a missing tenant name on a later ensure but keeps an existing one', async () => {
    const tenants = new PostgresTenants(runtime);

    const filled = await tenants.ensure(ORG_B, { createdBy: 'operator:y', name: 'Skatteetaten' });
    const kept = await tenants.ensure(ORG_A, { createdBy: 'operator:y', name: 'Annet navn' });

    expect(filled).toMatchObject({
      created: false,
      tenant: { name: 'Skatteetaten', createdBy: 'operator:x', status: 'onboarding' },
    });
    expect(kept).toMatchObject({ created: false, tenant: { name: 'Digdir' } });
  });
});

describe('ingestion executions', () => {
  const execution = (id: string, dataset: string, startedAt: string): IngestionExecution => ({
    id,
    dataset,
    pipeline: 'standard',
    pipelineVersion: 2,
    backend: 'typesense',
    status: 'running',
    startedBy: 'operator:x',
    startedAt,
  });

  it('keeps ingestion executions inside their dataset’s tenant', async () => {
    const executions = new PostgresIngestionExecutions(runtime);
    await executions.save(execution('e1', `${ORG_A}/lover`, '2026-10-07T08:00:00.000Z'));
    await executions.save(execution('e2', `${ORG_A}/lover`, '2026-10-07T09:00:00.000Z'));
    await executions.save(execution('e3', 'felles/lover', '2026-10-07T08:30:00.000Z'));
    await executions.save({
      ...execution('e1', `${ORG_A}/lover`, '2026-10-07T08:00:00.000Z'),
      status: 'succeeded',
      endedAt: '2026-10-07T08:05:00.000Z',
      report: { stored: 3, skipped: 1, failed: ['doc-9'] },
    });

    expect((await executions.list(`${ORG_A}/lover`, 'standard')).map((e) => e.id)).toEqual([
      'e2',
      'e1',
    ]);
    expect(await executions.get('e1')).toEqual({
      ...execution('e1', `${ORG_A}/lover`, '2026-10-07T08:00:00.000Z'),
      status: 'succeeded',
      endedAt: '2026-10-07T08:05:00.000Z',
      report: { stored: 3, skipped: 1, failed: ['doc-9'] },
    });
    expect(await executions.get('e3')).toMatchObject({ dataset: 'felles/lover' });
    expect(await asTenant(ORG_B, 'select * from ingestion_executions')).toEqual([]);
    expect(await asTenant(undefined, 'select * from ingestion_executions')).toEqual([]);
    expect(await asTenant(ORG_A, 'select id from ingestion_executions')).toHaveLength(2);
    expect(await asTenant('platform', 'select id from ingestion_executions')).toEqual([
      { id: 'e3' },
    ]);
  });
});

describe('tasks', () => {
  const task = (id: string, tenant: string, status: Task['status'], createdAt: string): Task =>
    ({
      id,
      tenant,
      owner: 'agent:demo',
      status,
      principal: { kind: 'person', id: 'p' },
      createdAt,
    }) as Task;

  it('lists a tenant’s tasks newest first from the tasks table', async () => {
    const tasks = new PostgresTaskStore(admin, new ContentKeys(admin, wrapper));
    const put = (t: Task) =>
      tasks.put(
        {
          task: t,
          principal: { kind: 'employee', issuer: 'i', subject: 's' },
          lastSeq: 0,
        },
        { tenant: t.tenant, key: `thread:${t.id}` },
      );
    await put(task('t1', ORG_A, 'completed', '2026-10-07T08:00:00.000Z'));
    await put(task('t2', ORG_A, 'running', '2026-10-07T09:00:00.000Z'));
    await put(task('t3', ORG_B, 'running', '2026-10-07T10:00:00.000Z'));

    expect(await tasks.list({ tenant: ORG_A })).toMatchObject([
      { id: 't2', tenant: ORG_A, status: 'running', createdAt: '2026-10-07T09:00:00.000Z' },
      { id: 't1', status: 'completed' },
    ]);
    expect((await tasks.list({ status: ['queued', 'running'] })).map((t) => t.id)).toEqual([
      't3',
      't2',
    ]);
    expect((await tasks.list({ limit: 1 })).map((t) => t.id)).toEqual(['t3']);
  });
});

describe('tenant settings version', () => {
  it('refuses a tenant settings save based on a stale version', async () => {
    const keys = new ContentKeys(runtime, wrapper);
    const first = new PostgresSettingsStore(runtime, keys);
    const second = new PostgresSettingsStore(runtimePool(), keys);
    const settings = { values: { 'model.default': 'gpt-4o' }, pins: {} };

    expect(await first.saveTenant(ORG_A, settings, 0)).toBe(1);
    expect((await second.load()).tenantVersions).toMatchObject({ [ORG_A]: 1 });
    expect(await second.saveTenant(ORG_A, settings, 1)).toBe(2);

    await expect(first.saveTenant(ORG_A, settings, 1)).rejects.toBeInstanceOf(
      SettingsConflictError,
    );
    await expect(first.saveTenant(ORG_A, settings, 0)).rejects.toBeInstanceOf(
      SettingsConflictError,
    );
    await expect(first.saveTenant(ORG_B, settings, 3)).rejects.toBeInstanceOf(
      SettingsConflictError,
    );
    expect((await first.load()).tenantVersions).toEqual({ [ORG_A]: 2 });
  });
});

describe('admin audit', () => {
  it('reads audit entries written by another connection without reloading', async () => {
    const reader = await PostgresAdminRecords.open(runtime);
    const writer = await PostgresAdminRecords.open(runtimePool());

    await writer.appendAudit({
      task: 'audit-task',
      tenant: ORG_B,
      action: 'tenant.settings.save',
      actor: 'operator:x',
      onBehalfOf: ORG_B,
      at: '2026-10-07T08:00:00.000Z',
      outcome: 'applied',
      target: 'settings',
      reason: 'Endring fra Digdir',
    });

    expect(await reader.audit(ORG_B)).toEqual([
      expect.objectContaining({ task: 'audit-task', onBehalfOf: ORG_B }),
    ]);
    expect(await reader.audit(ORG_A)).toEqual([]);
    expect((await reader.audit()).map((a) => a.task)).toEqual(['audit-task']);
  });
});
