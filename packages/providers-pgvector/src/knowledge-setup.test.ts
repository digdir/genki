import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stopPostgres } from '@genai/providers-postgres/testing';
import {
  boundPlatformId,
  knowledgeRoles,
  openKnowledgePools,
  setUpKnowledgeServer,
} from './index.js';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
const platform = '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f';
const otherPlatform = '0b8e2f61-5c3d-4e7a-9b1c-2d3e4f5a6b7c';
const logins = { apiLogin: 'knowledge_api', workerLogin: 'knowledge_worker' };
const roles = Object.values(knowledgeRoles);

const loginAs = (user: string, role?: string) =>
  new pg.Client({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user,
    password: 'login-pw',
    ...(role ? { options: `-c role=${role}` } : {}),
  });

const asLogin = async <T>(
  user: string,
  role: string | undefined,
  run: (client: pg.Client) => Promise<T>,
) => {
  const client = loginAs(user, role);
  await client.connect();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
};

const snapshot = async () => {
  const query = async (sql: string) => (await admin.query(sql)).rows;
  return {
    roles: await query(
      `select rolname, rolsuper, rolbypassrls, rolcanlogin, rolcreaterole, rolcreatedb
         from pg_roles where rolname like 'genai_knowledge_%' order by rolname`,
    ),
    members: await query(
      `select r.rolname as role, m.rolname as member, a.admin_option, a.inherit_option, a.set_option
         from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
         where r.rolname like 'genai_knowledge_%' order by role, member`,
    ),
    database: await query(
      `select datacl::text from pg_database where datname = current_database()`,
    ),
    schema: await query(`select nspacl::text from pg_namespace where nspname = 'public'`),
    extensions: await query(`select extname from pg_extension order by extname`),
    binding: await query(`select platform_id, bound_at from knowledge_binding`),
  };
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  for (const login of Object.values(logins))
    await admin.query(`create role ${login} login password 'login-pw'`);
  await setUpKnowledgeServer(admin, { ...logins, platformId: platform });
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await stopPostgres(container);
});

describe('knowledge server setup', () => {
  it('no knowledge role is a superuser or bypasses row-level security', async () => {
    const { rows } = await admin.query<{
      rolname: string;
      rolsuper: boolean;
      rolbypassrls: boolean;
    }>(`select rolname, rolsuper, rolbypassrls from pg_roles where rolname = any($1)`, [roles]);
    expect(rows.map((r) => r.rolname).sort()).toEqual([...roles].sort());
    expect(rows.filter((r) => r.rolsuper || r.rolbypassrls)).toEqual([]);
  });

  it("the API's identity can log in to the knowledge server only as the reader", async () => {
    expect(
      await asLogin(
        logins.apiLogin,
        knowledgeRoles.reader,
        async (c) =>
          (await c.query<{ current_user: string }>('select current_user')).rows[0]?.current_user,
      ),
    ).toBe(knowledgeRoles.reader);
    for (const role of [knowledgeRoles.writer, knowledgeRoles.owner])
      await expect(asLogin(logins.apiLogin, role, async () => undefined)).rejects.toThrow(
        /permission denied/,
      );
    const { rows } = await admin.query<{ role: string; inherit_option: boolean }>(
      `select r.rolname as role, a.inherit_option from pg_auth_members a
         join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
         where m.rolname = $1`,
      [logins.apiLogin],
    );
    expect(rows).toEqual([{ role: knowledgeRoles.reader, inherit_option: false }]);
  });

  it("the worker's login can take the writer and owner roles and no other", async () => {
    for (const role of [knowledgeRoles.writer, knowledgeRoles.owner])
      expect(
        await asLogin(
          logins.workerLogin,
          role,
          async (c) =>
            (await c.query<{ current_user: string }>('select current_user')).rows[0]?.current_user,
        ),
      ).toBe(role);
    await expect(
      asLogin(logins.workerLogin, knowledgeRoles.reader, async () => undefined),
    ).rejects.toThrow(/permission denied/);
    const { rows } = await admin.query(
      `select r.rolname as role, a.admin_option, a.inherit_option, a.set_option
         from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
         where m.rolname = $1 order by role`,
      [logins.workerLogin],
    );
    expect(rows).toEqual([
      { role: knowledgeRoles.owner, admin_option: false, inherit_option: false, set_option: true },
      { role: knowledgeRoles.writer, admin_option: false, inherit_option: false, set_option: true },
    ]);
  });

  it('the writer and reader roles cannot create objects', async () => {
    for (const [login, role] of [
      [logins.workerLogin, knowledgeRoles.writer],
      [logins.apiLogin, knowledgeRoles.reader],
      [logins.apiLogin, undefined],
    ] as const)
      await asLogin(login, role, async (c) => {
        await expect(c.query('create table probe (id int)')).rejects.toThrow(/permission denied/);
        await expect(c.query('create schema probe')).rejects.toThrow(/permission denied/);
        await expect(
          c.query('create function probe() returns int language sql as $$ select 1 $$'),
        ).rejects.toThrow(/permission denied/);
      });
    await asLogin(logins.workerLogin, knowledgeRoles.owner, async (c) => {
      await c.query('create table owner_probe (id int)');
      await c.query('create schema owner_probe');
      await c.query('drop table owner_probe');
      await c.query('drop schema owner_probe');
    });
  });

  it('opens the API only a reader pool and the worker a writer and an owner pool', async () => {
    const source = (user: string) => ({
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user,
      password: 'login-pw',
    });
    const roleOf = async (pool: pg.Pool | undefined) =>
      (await pool?.query<{ current_user: string }>('select current_user'))?.rows[0]?.current_user;
    const api = openKnowledgePools(source(logins.apiLogin), 'api');
    const worker = openKnowledgePools(source(logins.workerLogin), 'worker');
    try {
      expect(Object.keys(api.pools)).toEqual(['reader']);
      expect(await roleOf(api.pools.reader)).toBe(knowledgeRoles.reader);
      expect(await roleOf(worker.pools.writer)).toBe(knowledgeRoles.writer);
      expect(await roleOf(worker.pools.owner)).toBe(knowledgeRoles.owner);
    } finally {
      await Promise.all([api.close(), worker.close()]);
    }
  });

  it('server setup run twice changes nothing', async () => {
    const before = await snapshot();
    expect(await setUpKnowledgeServer(admin, { ...logins, platformId: platform })).toEqual({
      outcome: 'unchanged',
      platformId: platform,
    });
    expect(await snapshot()).toEqual(before);
    expect(before.extensions.map((e) => e.extname)).toEqual(
      expect.arrayContaining(['pg_prewarm', 'vector']),
    );
  });

  it('setup refuses to change a binding without `--rebind` and a reason', async () => {
    await expect(
      setUpKnowledgeServer(admin, { ...logins, platformId: otherPlatform }),
    ).rejects.toThrow(`bound to platform server ${platform}`);
    await expect(
      setUpKnowledgeServer(admin, {
        ...logins,
        platformId: otherPlatform,
        rebind: { reason: ' ' },
      }),
    ).rejects.toThrow('reason');
    expect(await boundPlatformId(admin)).toBe(platform);
  });

  it('rebinding stores the new platform id and returns the old one', async () => {
    expect(
      await setUpKnowledgeServer(admin, {
        ...logins,
        platformId: otherPlatform,
        rebind: { reason: 'test gets a copy of production for #132' },
      }),
    ).toEqual({ outcome: 'rebound', platformId: otherPlatform, previous: platform });
    expect(
      await asLogin(logins.workerLogin, knowledgeRoles.writer, (c) => boundPlatformId(c)),
    ).toBe(otherPlatform);
  });
});
