import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool, createPostgresStores, isPoolExhausted, LocalKeyWrapper } from './index.js';
import { stopPostgres } from './testing/index.js';

let container: StartedPostgreSqlContainer;
const pools: pg.Pool[] = [];
const closers: (() => Promise<void>)[] = [];
const wrapper = new LocalKeyWrapper(randomBytes(32));
const owner = { tenant: '999888777', user: 'person-1' };

const withinSeconds = <T>(seconds: number, work: Promise<T>) =>
  Promise.race([
    work,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`still waiting after ${seconds} s`)), seconds * 1000),
    ),
  ]);

/** A store pool of three, two of them listening: one connection is left for queries. */
const storesWithOneFreeConnection = async () => {
  const stores = await createPostgresStores(
    { connectionString: container.getConnectionUri(), max: 3, connectionTimeoutMillis: 10_000 },
    wrapper,
  );
  pools.push(stores.pool, stores.runtimePool);
  closers.push(() => stores.close());
  return stores;
};

const seedConversations = async (count: number) => {
  const writer = await storesWithOneFreeConnection();
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const created = await writer.conversations.create(owner, {
      agentId: 'agent',
      userId: 'person-1',
      topic: `topic ${i}`,
      tags: ['ka'],
    });
    ids.push(created.id);
  }
  return ids;
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
}, 120_000);

afterAll(async () => {
  for (const close of closers) await close();
  await stopPostgres(container, pools);
});

describe('platform pool connections', () => {
  it("listing a user's conversations needs one connection of the pool, however many conversations it decodes", async () => {
    await seedConversations(5);
    const reader = await storesWithOneFreeConnection();

    const listed = await withinSeconds(
      5,
      reader.conversations.list(owner, { pageIndex: 0, pageSize: 20, tags: ['ka'] }),
    );

    expect(listed.conversations.map((c) => c.topic).sort()).toEqual(
      ['topic 0', 'topic 1', 'topic 2', 'topic 3', 'topic 4'].sort(),
    );
  }, 60_000);

  it('reading and updating a conversation needs one connection of the pool', async () => {
    const [id = ''] = await seedConversations(1);
    const reader = await storesWithOneFreeConnection();

    const read = await withinSeconds(5, reader.conversations.get(owner, id));
    const updated = await withinSeconds(
      5,
      (await storesWithOneFreeConnection()).conversations.update(owner, id, { topic: 'renamed' }),
    );
    const appended = await withinSeconds(
      5,
      (await storesWithOneFreeConnection()).conversations.append(owner, id, {
        role: 'user',
        text: 'hello',
      }),
    );
    const messages = await withinSeconds(
      5,
      (await storesWithOneFreeConnection()).conversations.messages(owner, id),
    );

    expect(read?.topic).toBe('topic 0');
    expect(updated?.topic).toBe('renamed');
    expect(appended).toBeDefined();
    expect(messages?.at(-1)?.text).toBe('hello');
  }, 60_000);

  it("a request that waits longer than the pool's connection timeout fails instead of hanging", async () => {
    const pool = createPool({
      connectionString: container.getConnectionUri(),
      max: 1,
      connectionTimeoutMillis: 200,
    });
    pools.push(pool);
    const held = await pool.connect();

    const waited = await withinSeconds(5, pool.query('select 1')).catch((error: unknown) => error);
    held.release();

    expect(isPoolExhausted(waited)).toBe(true);
  }, 30_000);
});
