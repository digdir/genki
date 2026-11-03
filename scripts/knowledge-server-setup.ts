import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import pg, { type Pool } from 'pg';
import { platformTenantFrom } from '@genai/composition';
import { setUpKnowledgeServer, type KnowledgeBinding } from '@genai/providers-pgvector';
import {
  cachedEntraPassword,
  createPool,
  knowledgeLocalLogins,
  managedIdentityTokenSource,
  migrate,
  platformId,
  postgresSourceFromEnv,
  PostgresAdminRecords,
} from '@genai/providers-postgres';
import { knowledgeAdminUrlFor, localPorts, repoRoot } from './setup.ts';

export const setUpKnowledge = async (options: {
  platform: Pool;
  knowledge: Pool;
  apiLogin: string;
  workerLogin: string;
  tenant: string;
  rebind?: { reason: string };
}): Promise<KnowledgeBinding> => {
  const binding = await setUpKnowledgeServer(options.knowledge, {
    apiLogin: options.apiLogin,
    workerLogin: options.workerLogin,
    platformId: await platformId(options.platform),
    ...(options.rebind ? { rebind: options.rebind } : {}),
  });
  if (binding.outcome === 'rebound') {
    try {
      const { rows } = await options.platform.query<{ actor: string }>(
        'select current_user as actor',
      );
      await (
        await PostgresAdminRecords.open(options.platform)
      ).appendAudit({
        task: `knowledge-rebind-${randomUUID()}`,
        tenant: options.tenant,
        action: 'platform.knowledge.rebind',
        actor: rows[0]?.actor ?? 'unknown',
        at: new Date().toISOString(),
        outcome: 'applied',
        target: `knowledge server binding: ${binding.previous} -> ${binding.platformId}`,
        reason: options.rebind?.reason ?? '',
      });
    } catch (error) {
      throw new Error(
        `the knowledge server was rebound from platform server ${binding.previous} to ${binding.platformId}, but its audit entry failed: ${String(error)}. Record it in the audit log by hand.`,
        { cause: error },
      );
    }
  }
  return binding;
};

/** Azure only: an Entra admin makes each app identity's login by object id, in the `postgres` database. */
export const createPrincipals = async (
  admin: Pool,
  principals: { login: string; objectId: string }[],
) => {
  for (const { login, objectId } of principals) {
    const { rowCount } = await admin.query('select from pg_roles where rolname = $1', [login]);
    if (rowCount) {
      console.log(`Login ${login} exists`);
      continue;
    }
    await admin.query(
      `select * from pgaadauth_create_principal_with_oid($1, $2, 'service', false, false)`,
      [login, objectId],
    );
    console.log(`Login ${login} created for object ${objectId}`);
  }
};

/** What an admin checks after setup, printed to the log since the server is private. */
export const knowledgeServerReport = async (knowledge: Pool, logins: string[]) => {
  const query = async (sql: string, values: unknown[] = []) =>
    (await knowledge.query(sql, values)).rows;
  const [settings] = await query(
    `select current_database() as database, current_setting('server_version') as server_version,
            current_setting('azure.extensions', true) as azure_extensions,
            current_setting('shared_preload_libraries') as shared_preload_libraries,
            current_setting('max_connections') as max_connections`,
  );
  return {
    settings,
    extensions: await query(`select extname, extversion from pg_extension order by extname`),
    logins: (await query(`select rolname from pg_roles where rolcanlogin order by rolname`)).map(
      (row: { rolname: string }) => row.rolname,
    ),
    // Every role the two logins hold, so a role that is not a knowledge role shows too.
    memberships: await query(
      `select m.rolname as login, r.rolname as role, a.inherit_option, a.set_option
         from pg_auth_members a join pg_roles r on r.oid = a.roleid join pg_roles m on m.oid = a.member
        where m.rolname = any($1) order by login, role`,
      [logins],
    ),
    connect: (
      await query(
        `select coalesce(r.rolname, 'public') as grantee
           from pg_database d cross join aclexplode(coalesce(d.datacl, acldefault('d', d.datdba))) a
           left join pg_roles r on r.oid = a.grantee
          where d.datname = current_database() and a.privilege_type = 'CONNECT' order by grantee`,
      )
    ).map((row: { grantee: string }) => row.grantee),
  };
};

const usage = `Usage:
  npm run knowledge:setup -- --local
  npm run knowledge:setup -- --admin-user <name> --api-login <name> --worker-login <name>
      [--database <name>] [--rebind --reason "<why>"]
      [--principals --api-object-id <id> --worker-object-id <id>]

The platform server comes from DATABASE_URL or PGHOST, the knowledge server from KNOWLEDGE_PGHOST and
--database (or KNOWLEDGE_PGDATABASE, genai_knowledge by default). In Azure both log in with an Entra ID
token: the platform server as AZURE_CLIENT_ID, the knowledge server as KNOWLEDGE_ADMIN_AZURE_CLIENT_ID;
unset, as you (az login).
--principals first makes the two logins by object id, as an Entra admin, in the postgres database.`;

/** Outside --local the platform server must be named by PGHOST, so a local DATABASE_URL in .env.local is never bound to. */
export const platformSourceForSetup = (
  env: Record<string, string | undefined>,
  local: boolean,
): ReturnType<typeof postgresSourceFromEnv> => {
  if (local) return postgresSourceFromEnv(env);
  if (!env.PGHOST) throw new Error(`set PGHOST to the platform server to bind to\n\n${usage}`);
  if (env.DATABASE_URL)
    throw new Error(
      `unset DATABASE_URL (it may come from .env.local); outside --local the platform server is PGHOST\n\n${usage}`,
    );
  return postgresSourceFromEnv(env);
};

const createLocalLogin = async (admin: Pool, login: string, password: string) => {
  await admin.query(`do $$ begin
      create role ${login} login;
    exception when duplicate_object then null;
    end $$`);
  await admin.query(`alter role ${login} with login password ${pg.escapeLiteral(password)}`);
};

const main = async () => {
  const envFile = join(repoRoot, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { values } = parseArgs({
    options: {
      local: { type: 'boolean', default: false },
      'admin-user': { type: 'string' },
      'api-login': { type: 'string' },
      'worker-login': { type: 'string' },
      database: { type: 'string' },
      principals: { type: 'boolean', default: false },
      'api-object-id': { type: 'string' },
      'worker-object-id': { type: 'string' },
      rebind: { type: 'boolean', default: false },
      reason: { type: 'string' },
    },
  });
  if (values.local && values.principals)
    throw new Error(`--principals is for Azure; --local makes password logins\n\n${usage}`);
  if (values.rebind && !values.reason?.trim())
    throw new Error(`--rebind needs --reason\n\n${usage}`);
  const platformSource = platformSourceForSetup(process.env, values.local);
  if (!platformSource) throw new Error(`no platform server configured\n\n${usage}`);

  const apiLogin = values.local ? knowledgeLocalLogins.api : values['api-login'];
  const workerLogin = values.local ? knowledgeLocalLogins.worker : values['worker-login'];
  if (!apiLogin || !workerLogin) throw new Error(`pass --api-login and --worker-login\n\n${usage}`);
  const adminPassword = cachedEntraPassword(
    managedIdentityTokenSource(process.env.KNOWLEDGE_ADMIN_AZURE_CLIENT_ID),
  );
  const azureAdmin = (database: string) => {
    if (!process.env.KNOWLEDGE_PGHOST || !values['admin-user'])
      throw new Error(`set KNOWLEDGE_PGHOST and pass --admin-user\n\n${usage}`);
    return createPool({
      host: process.env.KNOWLEDGE_PGHOST,
      database,
      user: values['admin-user'],
      password: adminPassword,
      ssl: { rejectUnauthorized: true },
    });
  };

  if (values.principals) {
    const apiObjectId = values['api-object-id'];
    const workerObjectId = values['worker-object-id'];
    if (!apiObjectId || !workerObjectId)
      throw new Error(`--principals needs --api-object-id and --worker-object-id\n\n${usage}`);
    const postgres = azureAdmin('postgres');
    try {
      await createPrincipals(postgres, [
        { login: apiLogin, objectId: apiObjectId },
        { login: workerLogin, objectId: workerObjectId },
      ]);
    } finally {
      await postgres.end();
    }
  }

  const knowledge = values.local
    ? createPool({
        connectionString: knowledgeAdminUrlFor(
          Number(new URL(process.env.KNOWLEDGE_DATABASE_URL ?? 'postgres://x').port) ||
            localPorts().knowledge,
        ),
      })
    : azureAdmin(values.database ?? process.env.KNOWLEDGE_PGDATABASE ?? 'genai_knowledge');
  const platform = createPool(platformSource);
  try {
    if (values.local) {
      await migrate(platform);
      await createLocalLogin(knowledge, apiLogin, process.env.KNOWLEDGE_API_PASSWORD ?? '');
      await createLocalLogin(knowledge, workerLogin, process.env.KNOWLEDGE_WORKER_PASSWORD ?? '');
    }
    console.log(
      `Platform server ${platformSource.host ?? 'from DATABASE_URL'}, id ${await platformId(platform).catch(() => 'not migrated yet')}`,
    );
    const binding = await setUpKnowledge({
      platform,
      knowledge,
      apiLogin,
      workerLogin,
      tenant: platformTenantFrom(process.env),
      ...(values.rebind ? { rebind: { reason: values.reason ?? '' } } : {}),
    });
    console.log(
      binding.outcome === 'rebound'
        ? `Knowledge server rebound from platform server ${binding.previous} to ${binding.platformId}, and audited`
        : `Knowledge server set up, bound to platform server ${binding.platformId}`,
    );
    console.log(
      JSON.stringify(await knowledgeServerReport(knowledge, [apiLogin, workerLogin]), null, 2),
    );
  } finally {
    await Promise.all([platform.end(), knowledge.end()]);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
