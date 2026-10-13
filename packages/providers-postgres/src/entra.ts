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
