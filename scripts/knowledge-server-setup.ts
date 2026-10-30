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
  }
  return binding;
};

const createLocalLogin = async (admin: Pool, login: string, password: string) => {
  await admin.query(`do $$ begin
      create role ${login} login;
    exception when duplicate_object then null;
    end $$`);
  await admin.query(`alter role ${login} with login password ${pg.escapeLiteral(password)}`);
};

const usage = `Usage:
  npm run knowledge:setup -- --local
  npm run knowledge:setup -- --admin-user <name> --api-login <name> --worker-login <name> [--rebind --reason "<why>"]

The platform server comes from DATABASE_URL or PGHOST, the knowledge server from KNOWLEDGE_PGHOST and
KNOWLEDGE_PGDATABASE. In Azure both log in as you, with your Entra ID token (az login).`;

const main = async () => {
  const envFile = join(repoRoot, '.env.local');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  const { values } = parseArgs({
    options: {
      local: { type: 'boolean', default: false },
      'admin-user': { type: 'string' },
      'api-login': { type: 'string' },
      'worker-login': { type: 'string' },
      rebind: { type: 'boolean', default: false },
      reason: { type: 'string' },
    },
  });
  const platformSource = postgresSourceFromEnv(process.env);
  if (!platformSource) throw new Error(`no platform server configured\n\n${usage}`);
  if (values.rebind && !values.reason?.trim())
    throw new Error(`--rebind needs --reason\n\n${usage}`);

  const knowledge = values.local
    ? createPool({
        connectionString: knowledgeAdminUrlFor(
          Number(new URL(process.env.KNOWLEDGE_DATABASE_URL ?? 'postgres://x').port) ||
            localPorts().knowledge,
        ),
      })
    : (() => {
        if (!process.env.KNOWLEDGE_PGHOST || !values['admin-user'])
          throw new Error(`set KNOWLEDGE_PGHOST and pass --admin-user\n\n${usage}`);
        return createPool({
          host: process.env.KNOWLEDGE_PGHOST,
          database: process.env.KNOWLEDGE_PGDATABASE ?? 'genai_knowledge',
          user: values['admin-user'],
          password: cachedEntraPassword(managedIdentityTokenSource()),
          ssl: { rejectUnauthorized: true },
        });
      })();
  const platform = createPool(platformSource);
  try {
    const apiLogin = values.local ? knowledgeLocalLogins.api : values['api-login'];
    const workerLogin = values.local ? knowledgeLocalLogins.worker : values['worker-login'];
    if (!apiLogin || !workerLogin)
      throw new Error(`pass --api-login and --worker-login\n\n${usage}`);
    if (values.local) {
      await migrate(platform);
      await createLocalLogin(knowledge, apiLogin, process.env.KNOWLEDGE_API_PASSWORD ?? '');
      await createLocalLogin(knowledge, workerLogin, process.env.KNOWLEDGE_WORKER_PASSWORD ?? '');
    }
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
  } finally {
    await Promise.all([platform.end(), knowledge.end()]);
  }
};

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href)
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
