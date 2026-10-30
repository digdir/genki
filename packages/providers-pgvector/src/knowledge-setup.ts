import pg, { type Client, type Pool, type PoolClient } from 'pg';

export const knowledgeRoles = {
  owner: 'genai_knowledge_owner',
  writer: 'genai_knowledge_writer',
  reader: 'genai_knowledge_reader',
} as const;

export interface KnowledgeSetupOptions {
  apiLogin: string;
  workerLogin: string;
  platformId: string;
  rebind?: { reason: string };
}

export interface KnowledgeBinding {
  outcome: 'bound' | 'unchanged' | 'rebound';
  platformId: string;
  previous?: string;
}

const roles = Object.values(knowledgeRoles);

const roleName = (name: string) => {
  if (!/^[a-z_][a-z0-9_-]*$/i.test(name)) throw new Error(`invalid login name: ${name}`);
  return `"${name}"`;
};

const createRole = (role: string) => `do $$ begin
    create role ${role} nologin nosuperuser nobypassrls;
  exception when duplicate_object then null;
  end $$`;

const refuseStrongRole = (role: string) => `do $$ begin
    if exists (select from pg_roles where rolname = '${role}' and (rolsuper or rolbypassrls)) then
      raise exception '${role} must not be a superuser or bypass row-level security';
    end if;
  end $$`;

const memberships = async (client: PoolClient, login: string, allowed: string[]) => {
  const { rows } = await client.query<{
    role: string;
    admin_option: boolean;
    inherit_option: boolean;
    set_option: boolean;
  }>(
    `select r.rolname as role, a.admin_option, a.inherit_option, a.set_option
       from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
       where m.rolname = $1 and r.rolname = any($2)`,
    [login, roles],
  );
  for (const row of rows)
    if (!allowed.includes(row.role))
      await client.query(`revoke ${row.role} from ${roleName(login)}`);
  for (const role of allowed) {
    const row = rows.find((r) => r.role === role);
    if (row && !row.admin_option && !row.inherit_option && row.set_option) continue;
    if (row) await client.query(`revoke ${role} from ${roleName(login)}`);
    await client.query(
      `grant ${role} to ${roleName(login)} with admin false, inherit false, set true`,
    );
  }
};

const bind = async (
  client: PoolClient,
  options: KnowledgeSetupOptions,
): Promise<KnowledgeBinding> => {
  const current = await boundPlatformId(client);
  if (current === options.platformId) return { outcome: 'unchanged', platformId: current };
  if (current === undefined) {
    await client.query(`insert into knowledge_binding (platform_id) values ($1)`, [
      options.platformId,
    ]);
    return { outcome: 'bound', platformId: options.platformId };
  }
  if (!options.rebind)
    throw new Error(
      `this knowledge server is bound to platform server ${current}; binding it to ${options.platformId} needs --rebind and a reason`,
    );
  if (!options.rebind.reason.trim()) throw new Error('a rebind needs a reason');
  await client.query(`update knowledge_binding set platform_id = $1, bound_at = now()`, [
    options.platformId,
  ]);
  return { outcome: 'rebound', platformId: options.platformId, previous: current };
};

export const setUpKnowledgeServer = async (
  admin: Pool,
  options: KnowledgeSetupOptions,
): Promise<KnowledgeBinding> => {
  const client = await admin.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('genai-knowledge-setup'))`);
    await client.query('create extension if not exists vector');
    await client.query('create extension if not exists pg_prewarm');
    for (const role of roles) {
      await client.query(createRole(role));
      await client.query(refuseStrongRole(role));
    }
    const { rows } = await client.query<{ db: string }>('select current_database() as db');
    const database = roleName(rows[0]?.db ?? '');
    await client.query(`revoke create on schema public from public`);
    await client.query(`revoke temporary on database ${database} from public`);
    await client.query(`grant create on database ${database} to ${knowledgeRoles.owner}`);
    await client.query(`grant usage, create on schema public to ${knowledgeRoles.owner}`);
    await client.query(
      `grant usage on schema public to ${knowledgeRoles.writer}, ${knowledgeRoles.reader}`,
    );
    await client.query(`create table if not exists knowledge_binding (
        singleton boolean primary key default true check (singleton),
        platform_id uuid not null,
        bound_at timestamptz not null default now()
      )`);
    await client.query(
      `grant select on knowledge_binding to ${knowledgeRoles.owner}, ${knowledgeRoles.writer}`,
    );
    await memberships(client, options.apiLogin, [knowledgeRoles.reader]);
    await memberships(client, options.workerLogin, [knowledgeRoles.owner, knowledgeRoles.writer]);
    const binding = await bind(client, options);
    await client.query('commit');
    return binding;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

export const boundPlatformId = async (
  db: Pool | PoolClient | Client,
): Promise<string | undefined> => {
  const { rows } = await db.query<{ platform_id: string }>(
    `select platform_id from knowledge_binding`,
  );
  return rows[0]?.platform_id;
};

export interface KnowledgePoolSource {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string | (() => Promise<string>);
  ssl?: boolean | { rejectUnauthorized: boolean };
}

const loginRoles = {
  api: { reader: knowledgeRoles.reader },
  worker: { writer: knowledgeRoles.writer, owner: knowledgeRoles.owner },
} as const;

export const openKnowledgePools = (source: KnowledgePoolSource, login: 'api' | 'worker') => {
  const pools = Object.fromEntries(
    Object.entries(loginRoles[login]).map(([name, role]) => {
      const pool = new pg.Pool({
        ...source,
        options: `-c role=${role}`,
        connectionTimeoutMillis: 10_000,
      });
      pool.on('connect', (client) => client.on('error', () => undefined));
      return [name, pool];
    }),
  ) as { reader?: pg.Pool; writer?: pg.Pool; owner?: pg.Pool };
  return {
    pools,
    close: async () => {
      await Promise.all(Object.values(pools).map((pool) => pool.end()));
    },
  };
};
