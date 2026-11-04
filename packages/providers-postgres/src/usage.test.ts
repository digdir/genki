import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { memoryUsageSource, pollUsage, toUsageRow, type UsageRow } from '@genai/port-usage';
import { createPostgresStores, LocalKeyWrapper, withTenant, workerRole } from './index.js';
import { stopPostgres } from './testing/index.js';

const ORG_A = '991825827';
const ORG_B = '889640782';
const STRANGER = '974760673';
const day = Date.parse('2026-10-12T00:00:00Z');
const hourMs = 3_600_000;

let container: StartedPostgreSqlContainer;
let superuser: pg.Pool;
let stores: Awaited<ReturnType<typeof createPostgresStores>>;
let worker: Awaited<ReturnType<typeof createPostgresStores>>;
const pools: pg.Pool[] = [];

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  superuser = new pg.Pool({ connectionString: container.getConnectionUri() });
  pools.push(superuser);
  await superuser.query(`create role genai_owner login password 'owner-pw' createrole`);
  await superuser.query('grant create on schema public to genai_owner');
  const owner = new pg.Pool({
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    user: 'genai_owner',
    password: 'owner-pw',
  });
  pools.push(owner);
  const wrapper = new LocalKeyWrapper(randomBytes(32));
  stores = await createPostgresStores(owner, wrapper);
  worker = await createPostgresStores(owner, wrapper, { role: workerRole });
  pools.push(stores.runtimePool, worker.runtimePool);
  for (const tenant of [ORG_A, ORG_B]) await stores.tenants.ensure(tenant, { createdBy: 'test' });
}, 120_000);

afterAll(async () => {
  await stores?.close();
  await worker?.close();
  await stopPostgres(container, pools);
});

const setup = () => {
  let now = new Date(day + 30 * 60_000);
  const fake = memoryUsageSource({ id: `gw-${randomBytes(4).toString('hex')}`, now: () => now });
  fake.addKey({ id: 'a', subject: { kind: 'service', id: 'ka', org: ORG_A } });
  fake.addKey({ id: 'b', subject: { kind: 'org', id: ORG_B } });
  fake.addKey({ id: 'stranger', subject: { kind: 'org', id: STRANGER } });
  fake.addKey({ id: 'none' });
  const record = (key: string, hour: number, model = 'gpt-test') => {
    now = new Date(Math.max(now.getTime(), day + hour * hourMs + 2 * 60_000));
    fake.record({
      key,
      model,
      at: new Date(day + hour * hourMs + 60_000),
      inputTokens: 100,
      outputTokens: 10,
      costMicros: 1000,
    });
  };
  const poll = () =>
    pollUsage(fake, worker.usageBuckets, { firstStart: new Date(day), now: () => now });
  const fakeRows = async () =>
    (
      await fake.query({
        from: new Date(day),
        to: new Date(day + 24 * hourMs),
        bucket: 'hour',
        groupBy: ['model', 'subject'],
      })
    ).data.map((r) => toUsageRow(fake.id, r));
  return { fake, record, poll, fakeRows, setNow: (at: number) => (now = new Date(at)) };
};

const window = [new Date(day), new Date(day + 24 * hourMs)] as const;

const stored = async (source: string) => {
  const rows: UsageRow[] = [
    ...(await stores.usageBuckets.tenantRows([ORG_A, ORG_B], ...window)).map(
      ({ tenant: _tenant, ...r }) => r,
    ),
    ...(await stores.usageBuckets.unassignedRows(...window)),
  ];
  return rows
    .filter((r) => r.source === source)
    .map((r) => JSON.stringify(r))
    .sort();
};

describe('usage buckets in Postgres', () => {
  it("leaves the stored rows equal to the fake's after a second poll, and after an open bucket closes", async () => {
    const { fake, record, poll, fakeRows, setNow } = setup();
    record('a', 0);
    record('b', 0);
    record('stranger', 1);
    await poll();
    record('a', 1, 'later');
    await poll();
    await poll();
    const expected = async () => (await fakeRows()).map((r) => JSON.stringify(r)).sort();
    expect(await stored(fake.id)).toEqual(await expected());

    setNow(day + 6 * hourMs);
    await poll();
    expect(await stored(fake.id)).toEqual(await expected());
    expect(await worker.usageBuckets.closedThrough(fake.id)).toBe(
      new Date(day + 5 * hourMs).toISOString(),
    );
  });

  it("keeps a tenant's usage rows from another tenant, and lets only the poll write them", async () => {
    const { fake, record, poll } = setup();
    record('a', 2);
    record('b', 2);
    await poll();
    const seen = async (tenant: string) =>
      (await stores.usageBuckets.tenantRows([tenant], ...window))
        .filter((r) => r.source === fake.id)
        .map((r) => r.tenant);

    expect(await seen(ORG_A)).toEqual([ORG_A]);
    expect(await seen(ORG_B)).toEqual([ORG_B]);
    const asB = await withTenant(
      stores.runtimePool,
      ORG_B,
      async (client) =>
        (await client.query('select tenant from usage_buckets where tenant = $1', [ORG_A])).rows,
    );
    expect(asB).toEqual([]);
    await expect(
      withTenant(stores.runtimePool, ORG_A, (client) =>
        client.query('delete from usage_buckets where tenant = $1', [ORG_A]),
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it('lets only operators read usage that belongs to no tenant', async () => {
    const { fake, record, poll } = setup();
    record('stranger', 3);
    record('none', 3);
    await poll();

    await expect(stores.runtimePool.query('select * from usage_unassigned')).rejects.toThrow(
      /permission denied/,
    );
    await expect(
      stores.runtimePool.query(
        `select * from platform_usage_unassigned(now() - interval '1000 days', now())`,
      ),
    ).rejects.toThrow(/platform access/);
    const unassigned = (await stores.usageBuckets.unassignedRows(...window)).filter(
      (r) => r.source === fake.id,
    );
    expect(unassigned.map((r) => r.subject?.id ?? null).sort()).toEqual([STRANGER, null].sort());
  });

  it('keeps a closed row that comes back different and counts it as a contract breach', async () => {
    const { fake, record, poll, setNow } = setup();
    record('a', 4);
    setNow(day + 8 * hourMs);
    await poll();
    const [row] = (
      await fake.usage({
        from: new Date(day + 4 * hourMs),
        to: new Date(day + 5 * hourMs),
        bucket: 'hour',
      })
    ).rows;
    const changed = { ...(row as UsageRow), requests: 99 };
    const result = await worker.usageBuckets.store(
      fake.id,
      { start: changed.start, closed: true, rows: [changed] },
      undefined,
    );

    expect(result.breaches).toBe(1);
    expect(
      (await stores.usageBuckets.tenantRows([ORG_A], ...window))
        .filter((r) => r.source === fake.id)
        .map((r) => r.requests),
    ).toEqual([1]);
  });

  it('keeps currency rates by currency and day, and a later write corrects a rate', async () => {
    await stores.usageBuckets.putRates([
      { currency: 'USD', day: '2026-10-12', nokPerUnit: 10.9 },
      { currency: 'USD', day: '2026-10-12', nokPerUnit: 10.95 },
      { currency: 'EUR', day: '2026-10-12', nokPerUnit: 11.7 },
    ]);

    expect(await stores.usageBuckets.rates()).toEqual([
      { currency: 'EUR', day: '2026-10-12', nokPerUnit: 11.7 },
      { currency: 'USD', day: '2026-10-12', nokPerUnit: 10.95 },
    ]);
  });
});
