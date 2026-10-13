import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import {
  rowMapping,
  SourceCheckError,
  tableQuery,
  type ResolvedConnection,
  type TableQuery,
} from '@genai/ingest';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pageStatement, postgresRowReader } from './index.js';
import { stopPostgres } from '@genai/providers-postgres/testing';

let container: StartedPostgreSqlContainer;
let admin: pg.Client;
let connection: ResolvedConnection;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
  admin = new pg.Client({ connectionString: container.getConnectionUri() });
  await admin.connect();
  await admin.query(`
    CREATE TABLE saker (id int PRIMARY KEY, tittel text, sammendrag text, status text, hemmelig text);
    INSERT INTO saker VALUES
      (1, 'Klage på vedtak', 'Klagen ble tatt til følge.', 'avsluttet', 'x'),
      (2, 'Søknad om tilskudd', 'Søknaden behandles.', 'åpen', 'x'),
      (3, 'Innsyn i dokumenter', 'Innsyn ble gitt.', 'avsluttet', 'x'),
      (4, 'Tilsyn med kommune', 'Tilsynet er avsluttet.', 'avsluttet', 'x');
    CREATE TABLE logg (n int);
    CREATE FUNCTION skriv() RETURNS int LANGUAGE sql AS $$ INSERT INTO logg VALUES (1) RETURNING n $$;
    CREATE VIEW skrivende AS SELECT id, tittel, sammendrag, skriv() AS n FROM saker;
    CREATE VIEW treg AS SELECT id, tittel, sammendrag, pg_sleep(2)::text AS pause FROM saker;
  `);
  connection = {
    engine: 'postgres',
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: container.getUsername(),
    password: container.getPassword(),
    tls: false,
  };
}, 120_000);

afterAll(async () => {
  await admin?.end();
  await stopPostgres(container);
});

const query = (overrides: Record<string, unknown> = {}): TableQuery =>
  tableQuery(
    rowMapping.parse({
      table: 'saker',
      fields: { id: 'id', title: 'tittel', text: ['sammendrag'] },
      filter: [{ column: 'status', op: 'eq', value: 'avsluttet' }],
      ...overrides,
    }),
  );

const all = async (rows: AsyncIterable<Record<string, unknown>>) => {
  const out: Record<string, unknown>[] = [];
  for await (const row of rows) out.push(row);
  return out;
};

describe('reading rows from a tenant Postgres database', () => {
  it('reads only the mapped columns of the rows the filter selects, page by page', async () => {
    const reader = postgresRowReader({ pageSize: 2 });
    expect(await all(reader.rows(connection, query()))).toEqual([
      { id: 1, tittel: 'Klage på vedtak', sammendrag: 'Klagen ble tatt til følge.' },
      { id: 3, tittel: 'Innsyn i dokumenter', sammendrag: 'Innsyn ble gitt.' },
      { id: 4, tittel: 'Tilsyn med kommune', sammendrag: 'Tilsynet er avsluttet.' },
    ]);
    expect(await reader.check(connection, query())).toEqual({ rows: 3 });
  });

  it('stops at the row limit', async () => {
    const rows = await all(postgresRowReader().rows(connection, query({ maxRows: 2 })));
    expect(rows.map((r) => r.id)).toEqual([1, 3]);
  });

  it('refuses unknown columns and tables', async () => {
    const reader = postgresRowReader();
    await expect(
      reader.check(
        connection,
        query({ fields: { id: 'id', title: 'tittel', text: ['finnes_ikke'] } }),
      ),
    ).rejects.toThrow('unknown columns in public.saker: finnes_ikke');
    await expect(reader.check(connection, query({ table: 'borte' }))).rejects.toThrow(
      'the table public.borte does not exist',
    );
  });

  it('says whether the login, the table or the columns failed', async () => {
    const reader = postgresRowReader();
    const failure = (q: TableQuery, c = connection) =>
      reader.check(c, q).then(
        () => {
          throw new Error('expected the check to fail');
        },
        (e: unknown) => e as SourceCheckError,
      );
    expect(await failure(query({ table: 'borte' }))).toMatchObject({ problem: 'table' });
    const columns = await failure(
      query({ fields: { id: 'id', title: 'tittel', text: ['finnes_ikke'] } }),
    );
    expect(columns).toMatchObject({ problem: 'columns', columns: { missing: ['finnes_ikke'] } });
    expect(columns.columns.known).toEqual(
      expect.arrayContaining(['id', 'tittel', 'sammendrag', 'status']),
    );
    const login = await failure(query(), {
      ...connection,
      password: randomBytes(9).toString('base64url'),
    });
    expect(login).toBeInstanceOf(SourceCheckError);
    expect(login.problem).toBe('auth');
  });

  it('never runs raw SQL from a mapping', async () => {
    expect(() =>
      pageStatement({ ...query(), table: 'saker; DROP TABLE saker' }, undefined, 10),
    ).toThrow('is not a plain table or column name');
    expect(() =>
      pageStatement(
        { ...query(), filter: [{ column: 'status = status OR 1', op: 'eq', value: 'x' }] },
        undefined,
        10,
      ),
    ).toThrow('is not a plain table or column name');
    const injected = query({
      filter: [{ column: 'status', op: 'eq', value: "avsluttet' OR '1'='1" }],
    });
    expect(await all(postgresRowReader().rows(connection, injected))).toEqual([]);
    expect((await admin.query('SELECT count(*)::int AS n FROM saker')).rows[0]).toEqual({ n: 4 });
  });

  it('reads in a read-only transaction, so a view that writes fails', async () => {
    const writing = query({ table: 'skrivende', filter: [] });
    await expect(all(postgresRowReader().rows(connection, writing))).rejects.toThrow(
      /read-only transaction/,
    );
    expect((await admin.query('SELECT count(*)::int AS n FROM logg')).rows[0]).toEqual({ n: 0 });
  });

  it('stops a slow read at the statement timeout', async () => {
    const slow = query({ table: 'treg', filter: [] });
    await expect(
      all(postgresRowReader({ statementTimeoutMs: 200 }).rows(connection, slow)),
    ).rejects.toThrow(/statement timeout/);
  });

  it('checks the host before it connects', async () => {
    const reader = postgresRowReader({
      resolveHost: async () => {
        throw new Error('10.0.0.5 is a private address');
      },
    });
    await expect(reader.check(connection, query())).rejects.toThrow('private address');
  });

  it('connects to the address the host check returns, given the tenant private networks', async () => {
    const seen: string[][] = [];
    const reader = postgresRowReader({
      resolveHost: async (host, privateNetworks) => {
        seen.push(privateNetworks);
        return host;
      },
    });
    await reader.check({ ...connection, privateNetworks: ['10.20.0.0/16'] }, query());
    expect(seen).toEqual([['10.20.0.0/16']]);
  });

  it('does not put the password in the error when the login fails', async () => {
    const wrong = { ...connection, password: randomBytes(9).toString('base64url') };
    const error = await postgresRowReader()
      .check(wrong, query())
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toContain('feil-passord-123');
  });
});
