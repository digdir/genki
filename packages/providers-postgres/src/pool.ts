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

export const createPool = (options: PostgresPoolOptions): pg.Pool =>
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
  });
