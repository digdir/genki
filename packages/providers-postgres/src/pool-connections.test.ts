import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { strategyKey, versionedRef, type PluginSchemas } from '@genai/definitions';
import {
  createPool,
  createPostgresStores,
  isPoolExhausted,
  LocalKeyWrapper,
  PostgresDefinitionStore,
} from './index.js';
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

  const session = (payload: string) => ({
    hostname: 'ka.example',
    client: 'ka',
    expiresAt: Date.UTC(2099, 0, 1),
    payload,
  });

  it('changing a BFF session holds no connection of the pool while the change waits on other work', async () => {
    const stores = await storesWithOneFreeConnection();
    await stores.bffSessions.create(owner.tenant, 'refresh-1', session('old'));

    const changed = await withinSeconds(
      5,
      stores.bffSessions.update(owner.tenant, 'refresh-1', async (current) => {
        await stores.runtimePool.query('select 1');
        return { ...current, payload: 'refreshed' };
      }),
    );

    expect(changed?.payload).toBe('refreshed');
    expect((await stores.bffSessions.get(owner.tenant, 'refresh-1'))?.payload).toBe('refreshed');
  }, 60_000);

  it('two changes of one BFF session at once run one after the other, each on the last one saved', async () => {
    const stores = await storesWithOneFreeConnection();
    const other = await storesWithOneFreeConnection();
    await stores.bffSessions.create(owner.tenant, 'refresh-2', session('0'));
    const seen: string[] = [];
    const bump = async (current: { payload: string }) => {
      seen.push(current.payload);
      await new Promise((resolve) => setTimeout(resolve, 300));
      return { ...session(String(Number(current.payload) + 1)) };
    };

    await withinSeconds(
      10,
      Promise.all([
        stores.bffSessions.update(owner.tenant, 'refresh-2', bump),
        other.bffSessions.update(owner.tenant, 'refresh-2', bump),
      ]),
    );

    expect(seen.sort()).toEqual(['0', '1']);
    expect((await stores.bffSessions.get(owner.tenant, 'refresh-2'))?.payload).toBe('2');
  }, 60_000);

  it('exclusive sink-label work holds no connection of the pool while it runs', async () => {
    const stores = await storesWithOneFreeConnection();

    const labels = await withinSeconds(
      5,
      stores.sinkLabels.exclusive(owner.tenant, 'langfuse', () =>
        stores.sinkLabels.list(owner.tenant),
      ),
    );

    expect(labels).toEqual([]);
  }, 60_000);

  it('exclusive sink-label work for one connection never overlaps, across store instances', async () => {
    const stores = await storesWithOneFreeConnection();
    const other = await storesWithOneFreeConnection();
    let running = 0;
    let most = 0;
    const work = async () => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => setTimeout(resolve, 200));
      running -= 1;
    };

    await withinSeconds(
      10,
      Promise.all([
        stores.sinkLabels.exclusive(owner.tenant, 'langfuse-2', work),
        other.sinkLabels.exclusive(owner.tenant, 'langfuse-2', work),
        stores.sinkLabels.exclusive(owner.tenant, 'langfuse-2', work),
      ]),
    );

    expect(most).toBe(1);
  }, 60_000);

  it('publishing a service on a recipe shared from another organisation needs one connection of the pool', async () => {
    const stores = await storesWithOneFreeConnection();
    const plugins: PluginSchemas = {
      strategies: new Map<string, z.ZodType>([
        [strategyKey('single-call', 1), z.strictObject({ instructions: z.string() })],
        [
          strategyKey('step-flow', 1),
          z.strictObject({
            flow: versionedRef,
            settings: z.record(z.string(), z.unknown()).optional(),
          }),
        ],
      ]),
      tools: new Map(),
      guardrails: new Map(),
      blocks: new Set(['classify@1']),
      models: new Map([
        [
          'foundry/gpt-4o',
          { residency: 'norway', capabilities: ['stream', 'tools', 'json-schema'] },
        ],
      ]),
    };
    const sharer = '991825827';
    const store: PostgresDefinitionStore = new PostgresDefinitionStore(
      stores.runtimePool,
      plugins,
      undefined,
      undefined,
      async (tenant, id, version) =>
        tenant === sharer
          ? undefined
          : ((await store.get('StepFlow', sharer, id, version))?.definition as never),
    );
    const recipe = {
      apiVersion: 'genai/v1',
      kind: 'StepFlow',
      metadata: { tenant: sharer, id: 'shared-sorting', name: 'shared-sorting' },
      spec: {
        purpose: 'Sorter post',
        steps: [{ id: 'sort', block: 'classify@1' }],
        recipe: { title: { nb: 'Sorter', en: 'Sort' }, summary: { nb: 'Velg', en: 'Pick' } },
      },
    };
    const using = {
      apiVersion: 'genai/v1',
      kind: 'Service',
      metadata: { tenant: owner.tenant, id: 'mail', name: 'mail' },
      spec: {
        purpose: 'Sorter post',
        riskClass: 'limited',
        input: { accepts: ['text/plain'] },
        output: { kind: 'answer' },
        strategy: {
          id: 'step-flow',
          version: 1,
          config: { flow: 'shared-sorting@1', settings: {} },
        },
        model: { primary: 'foundry/gpt-4o', residency: 'norway' },
        exposure: { rest: true },
      },
    };
    expect((await store.publish(recipe, 'employee:kari', 'recipe')).ok).toBe(true);

    const published = await withinSeconds(5, store.publish(using, 'employee:ola', 'uses it'));

    expect(published.ok ? [] : published.errors).toEqual([]);
  }, 60_000);
});
