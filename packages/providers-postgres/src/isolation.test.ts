import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createPool,
  createPostgresStores,
  grantRuntimeRole,
  LocalKeyWrapper,
  migrate,
  runtimeRole,
  withPlatformAccess,
  withTenant,
  workerRole,
} from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let superuser: pg.Pool;
let owner: pg.Pool;
let stores: Awaited<ReturnType<typeof createPostgresStores>>;
const pools: pg.Pool[] = [];
const wrapper = new LocalKeyWrapper(randomBytes(32));

const ORG_A = '991825827';
const ORG_B = '889640782';

const login = (user: string, password: string) => {
  const pool = createPool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user,
    password,
  });
  pools.push(pool);
  return pool;
};

const asTenant = <T = Record<string, unknown>>(
  pool: pg.Pool,
  tenant: string,
  sql: string,
  params: unknown[] = [],
) => withTenant(pool, tenant, async (client) => (await client.query(sql, params)).rows as T[]);

const tenantRows: Record<string, (tenant: string, key: string) => [string, unknown[]]> = {
  tenants: (tenant, key) => [
    `insert into tenants (org_number, created_by) values ($1, $2)`,
    [tenant, key],
  ],
  conversations: (tenant, key) => [
    `insert into conversations (id, tenant, owner_hash, agent_id, created, body)
     values ($2, $1, 'h', 'a', 0, '\\x00')`,
    [tenant, key],
  ],
  conversation_messages: (tenant, key) => [
    `insert into conversation_messages (conversation, seq, tenant, created, body)
     values ('conversation-' || $1, $2::int, $1, 0, '\\x00')`,
    [tenant, key.length],
  ],
  legacy_api_keys: (tenant, key) => [
    `insert into legacy_api_keys (id, digest, name, tenant, scopes, created_at)
     values ($2, md5($2) || md5($2), 'n', $1, '{query}', now())`,
    [tenant, key],
  ],
  api_key_policies: (tenant, key) => [
    `insert into api_key_policies (id, tenant, name) values ($2, $1, 'n')`,
    [tenant, key],
  ],
  tenant_settings: (tenant) => [
    `insert into tenant_settings (tenant, body) values ($1, '\\x00')`,
    [tenant],
  ],
  admin_audit: (tenant, key) => [
    `insert into admin_audit (task, tenant, action, actor, at, outcome, target, reason)
     values ($2, $1, 'a', 'operator:x', now(), 'applied', 't', 'r')`,
    [tenant, key],
  ],
  support_sessions: (tenant, key) => [
    `insert into support_sessions (id, tenant, operator, reason, opened_at, expires_at)
     values ($2, $1, 'operator:x', 'r', now(), now())`,
    [tenant, key],
  ],
  tenant_secrets: (tenant, key) => [
    `insert into tenant_secrets (tenant, name, value) values ($1, $2, '\\x00')`,
    [tenant, key],
  ],
  tool_connections: (tenant, key) => [
    `insert into tool_connections (tenant, id, state) values ($1, $2, '{}')`,
    [tenant, key],
  ],
  eval_test_sets: (tenant, key) => [
    `insert into eval_test_sets (tenant, id, version, body) values ($1, $2, 1, '{}')`,
    [tenant, key],
  ],
  eval_runs: (tenant, key) => [
    `insert into eval_runs (id, tenant, task, test_set, ended_at, body)
     values ($2, $1, 't', 's', '2026-10-07', '{}')`,
    [tenant, key],
  ],
  eval_feedback: (tenant, key) => [
    `insert into eval_feedback (tenant, task, rating, at, body)
     values ($1, $2, 'up', '2026-10-07', '\\x00')`,
    [tenant, key],
  ],
  eval_candidates: (tenant, key) => [
    `insert into eval_candidates (id, tenant, status, proposed_at, body)
     values ($2, $1, 'proposed', '2026-10-07', '\\x00')`,
    [tenant, key],
  ],
  clients: (tenant, key) => [
    `insert into clients (tenant, id, version, definition, updated_at, updated_by)
     values ($1, $2, 1, '{}', now(), 'x')`,
    [tenant, key],
  ],
  webhook_deliveries: (tenant, key) => [
    `insert into webhook_deliveries (id, tenant, client, event, at, ok)
     values ($2, $1, 'c', 'ping', now(), true)`,
    [tenant, key],
  ],
  trigger_runs: (tenant, key) => [
    `insert into trigger_runs (id, tenant, service, trigger_id, kind, target, outcome, at)
     values ($2, $1, 's', 't', 'schedule', '0 2 * * *', 'completed', now())`,
    [tenant, key],
  ],
  ingestion_executions: (tenant, key) => [
    `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
       status, started_by, started_at)
     values ($2, $1, $1 || '/d', 'p', 1, 'b', 'running', 'x', '2026-10-07')`,
    [tenant, key],
  ],
};

const tenantColumn = (table: string) =>
  table === 'tenants' ? 'org_number' : table === 'ingestion_executions' ? 'scope' : 'tenant';

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  superuser = new pg.Pool({ connectionString: container.getConnectionUri() });
  pools.push(superuser);
  await superuser.query(`create role genai_owner login password 'owner-pw' createrole`);
  await superuser.query('grant create on schema public to genai_owner');
  owner = login('genai_owner', 'owner-pw');
  stores = await createPostgresStores(owner, wrapper);
  pools.push(stores.runtimePool);
  for (const tenant of [ORG_A, ORG_B]) {
    await asTenant(
      stores.runtimePool,
      tenant,
      `insert into conversations (id, tenant, owner_hash, agent_id, created, body)
       values ('conversation-' || $1, $1, 'h', 'a', 0, '\\x00')`,
      [tenant],
    );
    for (const [table, row] of Object.entries(tenantRows)) {
      const [sql, params] = row(tenant, `${table}-${tenant}`);
      await asTenant(stores.runtimePool, tenant, sql, params);
    }
  }
}, 120_000);

afterAll(async () => {
  await stores?.close();
  await stopPostgres(container, pools);
});

describe('database roles', () => {
  it('runs store queries as a runtime role that owns no tables and cannot bypass row-level security', async () => {
    const [role] = (
      await stores.runtimePool.query<{ name: string; rolsuper: boolean; rolbypassrls: boolean }>(
        `select current_user as name, rolsuper, rolbypassrls from pg_roles where rolname = current_user`,
      )
    ).rows;
    const owned = await stores.runtimePool.query(
      `select tablename from pg_tables where schemaname = 'public' and tableowner = current_user`,
    );

    expect(role).toEqual({ name: runtimeRole, rolsuper: false, rolbypassrls: false });
    expect(owned.rows).toEqual([]);
    expect(stores.pool).toBe(owner);
  });

  it('connects through a separate login that is a member of the runtime role', async () => {
    await superuser.query(`create role genai_api login password 'api-pw'`);
    await grantRuntimeRole(owner, 'genai_api');
    const separate = await createPostgresStores(owner, wrapper, {
      runtime: {
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        user: 'genai_api',
        password: 'api-pw',
      },
    });
    pools.push(separate.runtimePool);

    const [who] = (
      await separate.runtimePool.query<{ name: string }>('select current_user as name')
    ).rows;
    expect(who?.name).toBe('genai_api');
    expect(
      await asTenant(separate.runtimePool, ORG_B, 'select * from tenant_secrets'),
    ).toHaveLength(1);
    expect((await separate.tenants.list()).map((t) => t.orgNumber).sort()).toEqual(
      [ORG_A, ORG_B].sort(),
    );
    await separate.close();
  });

  it('runs the worker as genai_worker, a member of genai_runtime under the same row-level security', async () => {
    const worker = await createPostgresStores(owner, wrapper, { role: workerRole });
    pools.push(worker.runtimePool);
    try {
      const [role] = (
        await worker.runtimePool.query<{
          name: string;
          rolsuper: boolean;
          rolbypassrls: boolean;
          runtime: boolean;
        }>(
          `select current_user as name, rolsuper, rolbypassrls,
                  pg_has_role(current_user, '${runtimeRole}', 'USAGE') as runtime
             from pg_roles where rolname = current_user`,
        )
      ).rows;
      expect(role).toEqual({
        name: workerRole,
        rolsuper: false,
        rolbypassrls: false,
        runtime: true,
      });
      for (const table of Object.keys(tenantRows)) {
        const sql = `select * from ${table} order by 1`;
        const seen = await asTenant(worker.runtimePool, ORG_A, sql);
        expect(seen.length, table).toBeGreaterThan(0);
        expect(seen, table).toEqual(await asTenant(stores.runtimePool, ORG_A, sql));
        expect((await worker.runtimePool.query(sql)).rows, table).toEqual(
          (await stores.runtimePool.query(sql)).rows,
        );
      }
    } finally {
      await worker.close();
    }
  });

  it('the migration refuses a genai_worker that is a superuser or bypasses row-level security', async () => {
    for (const [unsafe, safe] of [
      ['bypassrls', 'nobypassrls'],
      ['superuser', 'nosuperuser'],
    ]) {
      await superuser.query(`alter role ${workerRole} ${unsafe}`);
      try {
        await expect(migrate(owner)).rejects.toThrow(
          `${workerRole} must not be a superuser or bypass row-level security`,
        );
      } finally {
        await superuser.query(`alter role ${workerRole} ${safe}`);
      }
    }
    await expect(migrate(owner)).resolves.toBeUndefined();
  });
});

describe('row-level security under a non-superuser owner', () => {
  it('leaves only kernel tables (ADR 0022) and platform-wide tables without a tenant unforced', async () => {
    const unforced = await superuser.query<{ relname: string }>(
      `select relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'public' and c.relkind = 'r'
         and not (c.relrowsecurity and c.relforcerowsecurity)
       order by relname`,
    );

    expect(unforced.rows.map((r) => r.relname)).toEqual([
      'change_versions',
      'content_keys',
      'erased_scopes',
      'events',
      'identities',
      'judge_labels',
      'model_classifications',
      'rate_limit_windows',
      'setting_default_versions',
      'setting_locks',
      'state',
      'tasks',
    ]);
  });

  it.each(Object.entries(tenantRows))(
    'keeps %s rows of one tenant invisible and unwritable to another',
    async (table, row) => {
      const column = tenantColumn(table);
      const runtime = stores.runtimePool;
      const [forged, params] = row(ORG_A, `${table}-forged`);

      const seenByB = await asTenant<{ owner: string }>(
        runtime,
        ORG_B,
        `select ${column} as owner from ${table}`,
      );
      const updated = await asTenant(
        runtime,
        ORG_B,
        `update ${table} set ${column} = ${column} where ${column} = $1 returning 1`,
        [ORG_A],
      );
      const deleted = await asTenant(
        runtime,
        ORG_B,
        `delete from ${table} where ${column} = $1 returning 1`,
        [ORG_A],
      );
      const seenWithoutTenant = await runtime.query(`select * from ${table}`);

      expect(seenByB.length).toBeGreaterThan(0);
      expect(seenByB.every((r) => r.owner.trim() === ORG_B)).toBe(true);
      expect(updated).toEqual([]);
      expect(deleted).toEqual([]);
      expect(seenWithoutTenant.rows).toEqual([]);
      await expect(asTenant(runtime, ORG_B, forged, params)).rejects.toThrow(/row-level security/);
    },
  );

  it.each(Object.keys(tenantRows))(
    'applies row-level security on %s to the owning role too',
    async (table) => {
      expect((await owner.query(`select * from ${table}`)).rows).toEqual([]);
      expect(
        (await superuser.query(`select 1 from ${table} where ${tenantColumn(table)} = $1`, [ORG_A]))
          .rowCount,
      ).toBeGreaterThan(0);
    },
  );

  it('ignores a platform access purpose on direct table reads by the runtime role', async () => {
    const rows = await withPlatformAccess(stores.runtimePool, 'test', async (client) => {
      const found = await client.query('select * from tenant_settings');
      return found.rows;
    });

    expect(rows).toEqual([]);
  });

  it('reads published definitions and config entries platform-wide but writes them only for the tenant in context', async () => {
    const runtime = stores.runtimePool;
    await asTenant(
      runtime,
      ORG_A,
      `insert into definition_versions (kind, tenant, id, version, definition, published_by, published_at, reason)
       values ('Service', $1, 'svc', 1, '{}', 'x', now(), 'r')`,
      [ORG_A],
    );
    await asTenant(
      runtime,
      'platform',
      `insert into config_entries (kind, scope, id, version, spec, deleted, by, at, reason)
       values ('catalog', 'platform', 'm', 1, '{}', false, 'x', 'now', 'r')`,
    );

    expect(await asTenant(runtime, ORG_B, 'select id from definition_versions')).toEqual([
      { id: 'svc' },
    ]);
    expect(await asTenant(runtime, ORG_B, 'select id from config_entries')).toEqual([{ id: 'm' }]);
    await expect(
      asTenant(
        runtime,
        ORG_B,
        `insert into definition_versions (kind, tenant, id, version, definition, published_by, published_at, reason)
         values ('Service', $1, 'svc', 2, '{}', 'x', now(), 'r')`,
        [ORG_A],
      ),
    ).rejects.toThrow(/row-level security/);
    await expect(
      asTenant(
        runtime,
        ORG_B,
        `insert into config_entries (kind, scope, id, version, spec, deleted, by, at, reason)
         values ('catalog', 'platform', 'm', 2, '{}', false, 'x', 'now', 'r')`,
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await asTenant(runtime, ORG_A, `delete from definition_versions returning id`)).toEqual(
      [],
    );
  });
});

describe('cross-tenant definer functions', () => {
  const definers = [
    'platform_tenant_settings()',
    'platform_admin_audit()',
    'platform_support_sessions()',
    `find_eval_run('eval_runs-${ORG_A}')`,
    `find_eval_candidate('eval_candidates-${ORG_A}')`,
    'platform_clients()',
    'platform_tenants()',
    `find_ingestion_execution('ingestion_executions-${ORG_A}')`,
  ];

  it.each(definers)('refuses %s without an explicit platform access purpose', async (call) => {
    await expect(stores.runtimePool.query(`select * from ${call}`)).rejects.toThrow(
      /explicit platform access purpose/,
    );
  });

  it.each(definers)('refuses %s inside a tenant transaction', async (call) => {
    await expect(
      withTenant(stores.runtimePool, ORG_B, async (client) => {
        await client.query(`select set_config('app.platform_access', 'test', true)`);
        return client.query(`select * from ${call}`);
      }),
    ).rejects.toThrow(/inside a tenant transaction/);
  });

  it.each(definers)('answers %s across tenants with a purpose', async (call) => {
    const rows = await withPlatformAccess(stores.runtimePool, 'test', async (client) => {
      const found = await client.query(`select * from ${call}`);
      return found.rows;
    });

    expect(rows.length).toBeGreaterThan(0);
  });

  it('refuses every definer function to a role outside the runtime role', async () => {
    await superuser.query(`create role outsider login password 'x'`);
    const outsider = login('outsider', 'x');

    for (const call of [...definers, `find_legacy_api_key('x')`]) {
      await expect(outsider.query(`select * from ${call}`)).rejects.toThrow(/permission denied/);
    }
  });

  it('finds an API key by digest before the tenant is known, and counts its use', async () => {
    const digest = 'ab'.repeat(32);
    await stores.apiKeys.add({
      id: 'key-digest',
      name: 'n',
      digest,
      tenant: ORG_A,
      scopes: ['query'],
      datasets: [],
      agents: [],
    });

    const found = await stores.apiKeys.findByDigest(digest);
    await stores.apiKeys.touch('key-digest', new Date('2026-10-07T12:00:00Z'));

    expect(found?.tenant).toBe(ORG_A);
    expect(await stores.apiKeys.usage(ORG_A, 'key-digest')).toEqual({
      count: 1,
      lastUsedAt: '2026-10-07T12:00:00.000Z',
    });
  });

  it('keeps the lockdown admission of an API key, and none on keys stored without it', async () => {
    const add = (id: string, digest: string, admitted?: boolean) =>
      stores.apiKeys.add({
        id,
        name: 'n',
        digest,
        tenant: ORG_A,
        scopes: ['query'],
        datasets: [],
        agents: [],
        ...(admitted ? { admittedInLockdown: true } : {}),
      });
    await add('key-admitted', 'cd'.repeat(32), true);
    await add('key-plain', 'ef'.repeat(32));

    expect(await stores.apiKeys.findByDigest('cd'.repeat(32))).toMatchObject({
      admittedInLockdown: true,
    });
    expect(await stores.apiKeys.findByDigest('ef'.repeat(32))).not.toHaveProperty(
      'admittedInLockdown',
    );
  });

  it('serves the platform reads of the stores through the runtime role', async () => {
    expect((await stores.tenants.list()).map((t) => t.orgNumber).sort()).toEqual(
      [ORG_A, ORG_B].sort(),
    );
    expect(await stores.clients.list()).toHaveLength(2);
    expect((await stores.adminRecords.audit()).map((a) => a.tenant).sort()).toEqual(
      [ORG_A, ORG_B].sort(),
    );
    expect(await stores.ingestionExecutions.get(`ingestion_executions-${ORG_A}`)).toBeDefined();
    expect(await stores.eval.runs.get(`eval_runs-${ORG_A}`)).toBeDefined();
  });
});

describe('migration', () => {
  it('runs again on a database with data and keeps every row', async () => {
    const count = async () =>
      (await superuser.query<{ n: string }>('select count(*) as n from tenant_secrets')).rows[0]?.n;
    const before = await count();

    await migrate(owner);
    await migrate(owner);

    expect(await count()).toBe(before);
  });

  it('refuses a runtime role that can bypass row-level security', async () => {
    await superuser.query(`alter role ${runtimeRole} bypassrls`);
    try {
      await expect(migrate(owner)).rejects.toThrow(/must not be a superuser or bypass/);
    } finally {
      await superuser.query(`alter role ${runtimeRole} nobypassrls`);
    }
  });
});
