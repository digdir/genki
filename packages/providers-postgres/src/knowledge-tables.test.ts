import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate } from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
});

const knowledgeTables = ['kn_generations', 'kn_active', 'kn_docs', 'kn_chunks', 'kn_phrases'];

describe('search data on the platform server', () => {
  it('the platform database has no kn_ tables after its migrations', async () => {
    // As #128 left them: the shared tables of the retired `connection: platform` (issue 151).
    await pool.query(`create table kn_generations (dataset text, generation text)`);
    await pool.query(`create table kn_active (dataset text primary key, generation text)`);
    await pool.query(`create table kn_docs (dataset text, generation text, id text)`);
    await pool.query(`create table kn_chunks (dataset text, generation text, id text)`);
    await pool.query(`create table kn_phrases (dataset text, generation text, id text)`);
    await pool.query(`insert into kn_chunks values ('digdir/genki-docs', 'g1', 'a')`);
    await migrate(pool);
    await migrate(pool);
    const { rows } = await pool.query<{ table: string | null }>(
      `select to_regclass(t) as table from unnest($1::text[]) t`,
      [knowledgeTables],
    );
    expect(rows.map((r) => r.table)).toEqual(knowledgeTables.map(() => null));
  });
});
