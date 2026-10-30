import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { migrate, platformId } from './index.js';
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

describe('the platform id', () => {
  it('the platform server keeps the id its first migration made', async () => {
    await migrate(pool);
    const first = await platformId(pool);
    await migrate(pool);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(await platformId(pool)).toBe(first);
    const { rows } = await pool.query<{ count: number }>(
      'select count(*)::int as count from platform_identity',
    );
    expect(rows[0]?.count).toBe(1);
  });
});
