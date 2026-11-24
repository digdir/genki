import { createHash, randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { textPart } from '@genai/contracts';
import {
  createPostgresStores,
  LocalKeyWrapper,
  rewrapContentKeys,
  type RewrapProgress,
  withPlatformAccess,
} from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
let pool: pg.Pool;

const tenant = '991825827';
const other = '889640782';
const first = randomBytes(32);
const second = randomBytes(32);
const oldOnly = new LocalKeyWrapper(first);
const rotated = new LocalKeyWrapper([
  { version: 1, key: first },
  { version: 2, key: second },
]);
const newOnly = new LocalKeyWrapper([{ version: 2, key: second }]);

const asPlatform = <T>(run: (client: pg.PoolClient) => Promise<T>) =>
  withPlatformAccess(pool, 'test', run);

const wrappedRows = () =>
  asPlatform(
    async (client) =>
      (
        await client.query<{ scope: string; wrapped: Buffer }>(
          'select scope, wrapped from content_keys order by tenant, scope',
        )
      ).rows,
  );

const seedKeys = async (wrapper: LocalKeyWrapper, count: number, prefix: string) => {
  for (let i = 0; i < count; i += 1) {
    const wrapped = await wrapper.wrap(randomBytes(32));
    await asPlatform((client) =>
      client.query('insert into content_keys (tenant, scope, wrapped) values ($1, $2, $3)', [
        i % 2 ? tenant : other,
        `${prefix}-${i}`,
        wrapped,
      ]),
    );
  }
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  pool = new pg.Pool({ connectionString: container.getConnectionUri() });
  const stores = await createPostgresStores(pool, oldOnly);
  await stores.close();
  await stores.runtimePool.end();
}, 120_000);

beforeEach(async () => {
  await asPlatform((client) => client.query('delete from content_keys'));
});

afterAll(async () => {
  await pool?.end();
  await stopPostgres(container);
});

describe('re-wrapping content keys', () => {
  it('opens a value sealed under the old master key after the re-wrap, with only the new key', async () => {
    const stores = await createPostgresStores(pool, oldOnly);
    const scope = { tenant, key: 'thread-1' };
    const base = { v: 1, task: 'task-1', ts: '2026-11-21T03:00:00Z', actor: 'kernel' as const };
    await stores.log.append(
      { ...base, type: 'kernel.result', data: [textPart('hemmelig')] },
      scope,
    );
    await stores.close();
    await stores.runtimePool.end();

    const result = await rewrapContentKeys(pool, rotated);
    expect(result).toMatchObject({ pending: 1, rewrapped: 1, failed: 0 });

    const after = await createPostgresStores(pool, newOnly);
    const events = [];
    for await (const event of after.log.read('task-1', 0, () => false)) events.push(event);
    expect(events.map((event) => event.data)).toEqual([[textPart('hemmelig')]]);
    await after.close();
    await after.runtimePool.end();
  });

  it('wraps every old key with the active version and reports its progress per batch', async () => {
    await seedKeys(oldOnly, 5, 'old');
    await seedKeys(rotated, 2, 'new');
    const progress: RewrapProgress[] = [];
    const result = await rewrapContentKeys(pool, rotated, {
      batchSize: 2,
      onProgress: (p) => progress.push(p),
    });
    expect(result).toMatchObject({ active: 2, pending: 5, checked: 5, rewrapped: 5, failed: 0 });
    expect(progress.map((p) => p.checked)).toEqual([0, 2, 4, 5]);
    for (const row of await wrappedRows()) expect(rotated.versionOf(row.wrapped)).toBe(2);
  });

  it('changes nothing in a dry run, but checks that every pending key opens', async () => {
    await seedKeys(oldOnly, 3, 'old');
    const before = await wrappedRows();
    const result = await rewrapContentKeys(pool, rotated, { dryRun: true });
    expect(result).toMatchObject({ dryRun: true, pending: 3, checked: 3, rewrapped: 0, failed: 0 });
    expect(await wrappedRows()).toEqual(before);
  });

  it('does nothing the second time, so it is safe to run again', async () => {
    await seedKeys(oldOnly, 3, 'old');
    await rewrapContentKeys(pool, rotated);
    const before = await wrappedRows();
    const again = await rewrapContentKeys(pool, rotated);
    expect(again).toMatchObject({ pending: 0, checked: 0, rewrapped: 0 });
    expect(await wrappedRows()).toEqual(before);
  });

  it('picks up where a stopped run left off', async () => {
    await seedKeys(oldOnly, 4, 'old');
    const stop = new Error('stopped');
    await expect(
      rewrapContentKeys(pool, rotated, {
        batchSize: 2,
        onProgress: (p) => {
          if (p.checked === 2) throw stop;
        },
      }),
    ).rejects.toBe(stop);
    const resumed = await rewrapContentKeys(pool, rotated);
    expect(resumed).toMatchObject({ pending: 2, rewrapped: 2 });
    for (const row of await wrappedRows()) expect(rotated.versionOf(row.wrapped)).toBe(2);
  });

  it('reports a key it cannot open, leaves it as it was and goes on with the rest', async () => {
    await seedKeys(oldOnly, 2, 'old');
    await seedKeys(new LocalKeyWrapper([{ version: 7, key: randomBytes(32) }]), 1, 'lost');
    const result = await rewrapContentKeys(pool, rotated);
    expect(result).toMatchObject({ pending: 3, rewrapped: 2, failed: 1 });
    expect(result.failures).toEqual([
      {
        tenant: other,
        scopeSha256: createHash('sha256').update('lost-0').digest('hex'),
        reason: 'the content key is wrapped with master key version 7, which is not set',
      },
    ]);
  });

  it('wraps back to version 1 in the untagged form when CONTENT_MASTER_KEY_ACTIVE is 1', async () => {
    await seedKeys(rotated, 2, 'new');
    const back = LocalKeyWrapper.fromEnv({
      CONTENT_MASTER_KEY: first.toString('base64'),
      CONTENT_MASTER_KEY_2: second.toString('base64'),
      CONTENT_MASTER_KEY_ACTIVE: '1',
    });
    expect(await rewrapContentKeys(pool, back)).toMatchObject({ pending: 2, rewrapped: 2 });
    for (const row of await wrappedRows()) {
      expect(row.wrapped).toHaveLength(60);
      expect(await oldOnly.unwrap(row.wrapped)).toHaveLength(32);
    }
  });

  it('refuses a batch size below 1', async () => {
    await expect(rewrapContentKeys(pool, rotated, { batchSize: 0 })).rejects.toThrow('batch size');
  });
});
