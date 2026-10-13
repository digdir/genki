import pg from 'pg';

export const entraPostgresScope = 'https://ossrdbms-aad.database.windows.net/.default';

export type PasswordProvider = string | (() => Promise<string>);

export interface PostgresPoolOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: PasswordProvider;
  ssl?: boolean | { rejectUnauthorized: boolean };
  max?: number;
}

export const withClientErrorListener = (pool: pg.Pool): pg.Pool => {
  // A client the pool is closing can still get a server error, which crashes the process without a listener.
  pool.on('connect', (client) => client.on('error', () => undefined));
  return pool;
};

export const createPool = (options: PostgresPoolOptions): pg.Pool =>
  withClientErrorListener(
    new pg.Pool({
      ...(options.connectionString === undefined
        ? {}
        : { connectionString: options.connectionString }),
      ...(options.host === undefined ? {} : { host: options.host }),
      ...(options.port === undefined ? {} : { port: options.port }),
      ...(options.database === undefined ? {} : { database: options.database }),
      ...(options.user === undefined ? {} : { user: options.user }),
      ...(options.password === undefined ? {} : { password: options.password }),
      ...(options.ssl === undefined ? {} : { ssl: options.ssl }),
      ...(options.max === undefined ? {} : { max: options.max }),
    }),
  );
