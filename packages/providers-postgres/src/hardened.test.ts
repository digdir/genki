import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPostgresStores, LocalKeyWrapper } from './index.js';

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:17-alpine').start();
  const admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  await admin.query('revoke all on schema public from public');
  await admin.end();
}, 120_000);

afterAll(async () => {
  await container?.stop();
});

describe('a hardened database', () => {
  it('starts when the public schema grants nothing to everyone', async () => {
    const stores = await createPostgresStores(
      { connectionString: container.getConnectionUri() },
      new LocalKeyWrapper(randomBytes(32)),
    );

    expect(stores.log).toBeDefined();
    await stores.close();
  });
});
