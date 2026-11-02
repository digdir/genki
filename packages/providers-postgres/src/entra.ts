import { entraPostgresScope, type PostgresPoolOptions } from './pool.js';

export interface AccessToken {
  token: string;
  expiresOnTimestamp: number;
}

export type TokenSource = (scope: string) => Promise<AccessToken | null>;

const refreshBeforeMs = 5 * 60_000;

export const cachedEntraPassword = (
  getToken: TokenSource,
  now: () => number = Date.now,
): (() => Promise<string>) => {
  let current: AccessToken | undefined;
  let pending: Promise<AccessToken> | undefined;
  return async () => {
    if (current && current.expiresOnTimestamp - refreshBeforeMs > now()) return current.token;
    pending ??= getToken(entraPostgresScope)
      .then((token) => {
        if (!token) throw new Error('Entra ID returned no token for Postgres');
        current = token;
        return token;
      })
      .finally(() => {
        pending = undefined;
      });
    return (await pending).token;
  };
};

export const managedIdentityTokenSource = (clientId?: string): TokenSource => {
  let credential: Promise<{ getToken: TokenSource }> | undefined;
  return async (scope) => {
    credential ??= import('@azure/identity').then(({ DefaultAzureCredential }) =>
      clientId
        ? new DefaultAzureCredential({ managedIdentityClientId: clientId })
        : new DefaultAzureCredential(),
    );
    return (await credential).getToken(scope);
  };
};

type Env = Record<string, string | undefined>;

export const usesEntraPostgres = (env: Env) => !env.DATABASE_URL && Boolean(env.PGHOST);

export const postgresSourceFromEnv = (
  env: Env,
  tokens: TokenSource = managedIdentityTokenSource(env.AZURE_CLIENT_ID),
): PostgresPoolOptions | undefined => {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  if (!env.PGHOST) return undefined;
  return {
    host: env.PGHOST,
    ...(env.PGPORT ? { port: Number(env.PGPORT) } : {}),
    database: env.PGDATABASE ?? 'genai',
    ...(env.PGUSER ? { user: env.PGUSER } : {}),
    password: cachedEntraPassword(tokens),
    ssl: env.PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  };
};

export type KnowledgeLogin = 'api' | 'worker';

export const knowledgeLocalLogins: Record<KnowledgeLogin, string> = {
  api: 'genai_knowledge_api',
  worker: 'genai_knowledge_worker',
};

export const knowledgeIdentityTokenSource = (clientId: string): TokenSource => {
  let credential: Promise<{ getToken: TokenSource }> | undefined;
  return async (scope) => {
    credential ??= import('@azure/identity').then(
      ({ ManagedIdentityCredential }) => new ManagedIdentityCredential({ clientId }),
    );
    return (await credential).getToken(scope);
  };
};

const knowledgePasswords: Record<KnowledgeLogin, string> = {
  api: 'KNOWLEDGE_API_PASSWORD',
  worker: 'KNOWLEDGE_WORKER_PASSWORD',
};

export const knowledgeSourceFromEnv = (
  env: Env,
  login: KnowledgeLogin,
  identity: (clientId: string) => TokenSource = knowledgeIdentityTokenSource,
): PostgresPoolOptions | undefined => {
  if (env.KNOWLEDGE_DATABASE_URL) {
    const url = new URL(env.KNOWLEDGE_DATABASE_URL);
    url.username = knowledgeLocalLogins[login];
    url.password = encodeURIComponent(env[knowledgePasswords[login]] ?? '');
    return { connectionString: url.toString() };
  }
  if (!env.KNOWLEDGE_PGHOST) return undefined;
  if (!env.KNOWLEDGE_AZURE_CLIENT_ID)
    throw new Error(
      "set KNOWLEDGE_AZURE_CLIENT_ID to the client id of this app's own knowledge identity",
    );
  if (!env.KNOWLEDGE_PGUSER)
    throw new Error("set KNOWLEDGE_PGUSER to the Postgres name of this app's knowledge identity");
  return {
    host: env.KNOWLEDGE_PGHOST,
    ...(env.KNOWLEDGE_PGPORT ? { port: Number(env.KNOWLEDGE_PGPORT) } : {}),
    database: env.KNOWLEDGE_PGDATABASE ?? 'genai_knowledge',
    user: env.KNOWLEDGE_PGUSER,
    password: cachedEntraPassword(identity(env.KNOWLEDGE_AZURE_CLIENT_ID)),
    ssl: env.KNOWLEDGE_PGSSLMODE === 'disable' ? false : { rejectUnauthorized: true },
  };
};
