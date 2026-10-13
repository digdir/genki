import {
  SourceCheckError,
  sqlIdentifier,
  type ResolvedConnection,
  type RowCondition,
  type RowReader,
  type TableQuery,
} from '@genai/ingest';
import pg from 'pg';

export interface PostgresRowReaderOptions {
  statementTimeoutMs?: number;
  connectTimeoutMs?: number;
  pageSize?: number;
  resolveHost?: (host: string, privateNetworks: string[]) => Promise<string>;
}

export class SourceQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SourceQueryError';
  }
}

const quoted = (name: string) => {
  if (!sqlIdentifier.safeParse(name).success)
    throw new SourceQueryError(`${JSON.stringify(name)} is not a plain table or column name`);
  return `"${name}"`;
};

const comparisons: Record<string, string> = {
  eq: '=',
  neq: 'IS DISTINCT FROM',
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
};

export const whereClause = (filter: RowCondition[], params: unknown[]) =>
  filter.map((c) => {
    const column = quoted(c.column);
    if (c.op === 'is_null') return `${column} IS NULL`;
    if (c.op === 'not_null') return `${column} IS NOT NULL`;
    params.push(c.value);
    const at = `$${params.length}`;
    if (c.op === 'in') return `${column} = ANY(${at})`;
    if (c.op === 'not_in') return `NOT (${column} = ANY(${at}))`;
    const operator = comparisons[c.op];
    if (!operator) throw new SourceQueryError(`unknown operator ${c.op}`);
    return `${column} ${operator} ${at}`;
  });

export const pageStatement = (query: TableQuery, after: unknown, limit: number) => {
  const params: unknown[] = [];
  const conditions = whereClause(query.filter, params);
  if (after !== undefined) {
    params.push(after);
    conditions.push(`${quoted(query.orderBy)} > $${params.length}`);
  }
  params.push(limit);
  const text = [
    `SELECT ${query.columns.map(quoted).join(', ')}`,
    `FROM ${quoted(query.schema)}.${quoted(query.table)}`,
    ...(conditions.length ? [`WHERE ${conditions.join(' AND ')}`] : []),
    `ORDER BY ${quoted(query.orderBy)}`,
    `LIMIT $${params.length}`,
  ].join(' ');
  return { text, values: params };
};

const knownColumns = async (client: pg.Client, query: TableQuery) => {
  const result = await client.query<{ column_name: string }>(
    'SELECT column_name FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2',
    [query.schema, query.table],
  );
  if (result.rows.length === 0)
    throw new SourceCheckError(
      `the table ${query.schema}.${query.table} does not exist or the user cannot read it`,
      'table',
    );
  const known = new Set(result.rows.map((r) => r.column_name));
  const unknown = [
    ...new Set([query.orderBy, ...query.columns, ...query.filter.map((c) => c.column)]),
  ].filter((c) => !known.has(c));
  if (unknown.length > 0)
    throw new SourceCheckError(
      `unknown columns in ${query.schema}.${query.table}: ${unknown.join(', ')}`,
      'columns',
      { missing: unknown, known: result.rows.map((r) => r.column_name) },
    );
};

const sqlState = (error: unknown) =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

const loginRefused = (error: unknown) => ['28P01', '28000'].includes(sqlState(error));

const tableRefused = (error: unknown, query: TableQuery) =>
  sqlState(error) === '42501'
    ? new SourceCheckError(`the user cannot read the table ${query.schema}.${query.table}`, 'table')
    : error;

export const postgresRowReader = (options: PostgresRowReaderOptions = {}): RowReader => {
  const timeout = Math.max(1, Math.floor(options.statementTimeoutMs ?? 15_000));
  const pageSize = options.pageSize ?? 500;

  const connect = async (connection: ResolvedConnection) => {
    const address = options.resolveHost
      ? await options.resolveHost(connection.host, connection.privateNetworks ?? [])
      : connection.host;
    const client = new pg.Client({
      host: address,
      port: connection.port,
      database: connection.database,
      user: connection.user,
      password: connection.password,
      ssl: connection.tls ? { rejectUnauthorized: true, servername: connection.host } : false,
      connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
      query_timeout: timeout + 5_000,
      application_name: 'genki-connector',
      options: `-c default_transaction_read_only=on -c statement_timeout=${timeout}`,
    });
    client.on('error', () => undefined);
    await client.connect().catch((error: unknown) => {
      throw loginRefused(error) ? new SourceCheckError((error as Error).message, 'auth') : error;
    });
    return client;
  };

  const readOnly = async <T>(client: pg.Client, work: () => Promise<T>) => {
    await client.query('BEGIN TRANSACTION READ ONLY');
    try {
      await client.query(`SET LOCAL statement_timeout = ${timeout}`);
      return await work();
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
    }
  };

  return {
    async check(connection, query) {
      const client = await connect(connection);
      try {
        return await readOnly(client, async () => {
          await knownColumns(client, query);
          const params: unknown[] = [];
          const conditions = whereClause(query.filter, params);
          const result = await client
            .query<{ rows: string }>(
              `SELECT count(*) AS rows FROM ${quoted(query.schema)}.${quoted(query.table)}${
                conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''
              }`,
              params,
            )
            .catch((error: unknown) => {
              throw tableRefused(error, query);
            });
          return { rows: Math.min(Number(result.rows[0]?.rows ?? 0), query.maxRows) };
        });
      } finally {
        await client.end().catch(() => undefined);
      }
    },

    async *rows(connection, query, signal) {
      const client = await connect(connection);
      try {
        await readOnly(client, () => knownColumns(client, query));
        let after: unknown;
        let read = 0;
        while (read < query.maxRows) {
          signal?.throwIfAborted();
          const limit = Math.min(pageSize, query.maxRows - read);
          const page = await readOnly(client, () =>
            client.query<Record<string, unknown>>(pageStatement(query, after, limit)),
          );
          for (const row of page.rows) yield row;
          read += page.rows.length;
          if (page.rows.length < limit) break;
          after = page.rows.at(-1)?.[query.orderBy];
        }
      } finally {
        await client.end().catch(() => undefined);
      }
    },
  };
};
