import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, grantRuntimeRole, migrate, PostgresApiKeys } from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
const pools: pg.Pool[] = [];
let runtime: pg.Pool;

const ORG_A = '991825827';
const ORG_B = '889640782';
const digest = (n: number) => n.toString(16).padStart(64, '0');

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  pools.push(admin);
  await migrate(admin);
  await admin.query(`create role genai_api login password 'runtime-pw' nosuperuser nobypassrls`);
  await grantRuntimeRole(admin, 'genai_api');
  runtime = createPool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: 'genai_api',
    password: 'runtime-pw',
  });
  pools.push(runtime);
}, 120_000);

afterAll(async () => {
  await stopPostgres(container, pools);
});

describe('keys without the admitted mark, for the production login switch', () => {
  it('lists every live key without the admitted mark in every tenant to the runtime role, and none other', async () => {
    const keys = new PostgresApiKeys(runtime);
    const key = (id: string, tenant: string, n: number, admitted = false) =>
      keys.add({
        id,
        name: id,
        digest: digest(n),
        tenant,
        scopes: ['query'],
        datasets: [],
        agents: [],
        ...(admitted ? { admittedInLockdown: true } : {}),
      });
    await key('testid-a', ORG_A, 1);
    await key('testid-b', ORG_B, 2);
    await key('member-a', ORG_A, 3, true);
    await key('revoked-b', ORG_B, 4);
    await keys.revoke(ORG_B, 'revoked-b');

    expect(await keys.unadmitted()).toEqual([
      { tenant: ORG_B, id: 'testid-b', digest: digest(2) },
      { tenant: ORG_A, id: 'testid-a', digest: digest(1) },
    ]);
  });
});
