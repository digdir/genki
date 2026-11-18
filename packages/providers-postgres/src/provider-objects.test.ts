import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LedgerObject } from '@genai/kernel';
import { createPostgresStores, LocalKeyWrapper } from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let stores: Awaited<ReturnType<typeof createPostgresStores>>;
let pool: pg.Pool;

const tenant = '991825827';
const other = '889640782';

const object = (id: string, over: Partial<LedgerObject> = {}): LedgerObject => ({
  tenant,
  run: 'run-1',
  connection: 'openai',
  descriptor: 'openai/batch@1',
  deployment: 'gpt-x',
  step: 'upload',
  field: 'id',
  objectId: id,
  deleteBy: '2026-11-06T01:00:00.000Z',
  deletable: true,
  ...over,
});

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  stores = await createPostgresStores(pool, new LocalKeyWrapper(randomBytes(32)));
}, 120_000);

afterAll(async () => {
  await stores?.close();
  await stores?.runtimePool.end();
  await pool?.end();
  await stopPostgres(container);
});

describe('the provider object ledger in postgres', () => {
  it('lists an object as open until the call that made it deletes it', async () => {
    const ledger = stores.providerObjects;
    await ledger.created(object('file-1'));
    expect((await ledger.list(tenant, 'open')).map((r) => r.objectId)).toEqual(['file-1']);
    await ledger.deleted({ tenant, connection: 'openai', objectId: 'file-1' });
    expect(await ledger.list(tenant, 'open')).toEqual([]);
    expect((await ledger.list(tenant, 'deleted'))[0]?.settledAt).toBeDefined();
  });

  it('offers the sweep every tenant open object past its delete-by time', async () => {
    const ledger = stores.providerObjects;
    await ledger.created(object('file-2'));
    await ledger.created(object('file-3', { tenant: other }));
    await ledger.created(object('file-4', { deleteBy: '2026-12-01T00:00:00.000Z' }));
    const due = await ledger.due(new Date('2026-11-06T03:00:00Z'), 10);
    expect(due.map((r) => r.objectId).sort()).toEqual(['file-2', 'file-3']);
  });

  it('keeps an incident with its reason and takes it out of the sweep', async () => {
    const ledger = stores.providerObjects;
    const key = { tenant, connection: 'openai', objectId: 'file-2' };
    await ledger.incident(key, 'the provider answered 500', new Date('2026-11-06T03:00:00Z'));
    expect((await ledger.list(tenant, 'incident'))[0]?.incident).toBe('the provider answered 500');
    expect((await ledger.due(new Date('2026-11-06T03:00:00Z'), 10)).map((r) => r.objectId)).toEqual(
      ['file-3'],
    );
  });

  it('shows a tenant only its own objects', async () => {
    expect((await stores.providerObjects.list(other)).map((r) => r.objectId)).toEqual(['file-3']);
  });

  it('records an object kept at the provider as retained, never due', async () => {
    const ledger = stores.providerObjects;
    await ledger.created(object('file-5', { deletable: false }));
    expect((await ledger.list(tenant, 'retained')).map((r) => r.objectId)).toEqual(['file-5']);
  });
});
