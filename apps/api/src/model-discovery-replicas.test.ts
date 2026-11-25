import { randomBytes } from 'node:crypto';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envSecrets } from '@genai/kernel';
import {
  ListingError,
  ModelRouter,
  type DiscoveredDeployment,
  type DiscoveryListing,
  type ModelAdapter,
} from '@genai/port-model';
import {
  createPostgresStores,
  LocalKeyWrapper,
  PostgresDiscoveredModels,
} from '@genai/providers-postgres';
import { stopPostgres } from '@genai/providers-postgres/testing';
import { followChanges } from './change-feed.js';

let container: StartedPostgreSqlContainer;
let db: Awaited<ReturnType<typeof createPostgresStores>>;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  db = await createPostgresStores(
    { connectionString: container.getConnectionUri() },
    new LocalKeyWrapper(randomBytes(32)),
    {
      changePollMs: 50,
    },
  );
}, 120_000);

afterAll(async () => {
  await db?.close();
  await db?.runtimePool.end();
  await db?.pool.end();
  await stopPostgres(container);
});

const adapter: ModelAdapter<Record<string, never>> = {
  apis: [
    {
      id: 'proto/chat@1',
      kind: 'chat',
      family: 'proto',
      modelOptions: z.strictObject({}),
      default: true,
    },
  ],
  connect: () => ({
    chat: async () => {
      throw new Error('not called');
    },
    async *chatStream() {
      yield* [];
      throw new Error('not called');
    },
  }),
};

const now = () => new Date('2026-11-21T10:00:00Z');

const replica = (connection: string, found: DiscoveredDeployment[] | Error) => {
  const listed = { calls: 0 };
  const store = new PostgresDiscoveredModels<DiscoveryListing>(db.runtimePool);
  const router = new ModelRouter({
    catalog: {
      endpoints: {
        [connection]: {
          baseURL: 'https://gateway.example',
          auth: { kind: 'api-key', secret: 'secret://env/key' },
          families: { proto: '/v1' },
          discovery: [{ source: 'stub' }],
        },
      },
      models: [],
    },
    adapters: [adapter],
    secrets: envSecrets({ KEY: 'k' }),
    sources: [
      {
        kind: 'stub',
        list: async () => {
          listed.calls += 1;
          if (found instanceof Error) throw found;
          return found;
        },
      },
    ],
    discovered: store,
    now,
  });
  return { router, store, listed, ids: () => router.describe().map((m) => m.id) };
};

const named = (...deployments: string[]) => deployments.map((deployment) => ({ deployment }));

describe('discovered models in postgres', () => {
  it('two replicas serve the same set', async () => {
    const lister = replica('gw-same', named('borealis', 'normistral'));
    const other = replica('gw-same', new Error('not asked'));
    await other.router.loadDiscovered();
    const stop = followChanges(db.changes, {
      settings: { reload: async () => undefined },
      contentReasons: { reload: async () => undefined },
      catalog: { refresh: async () => undefined },
      definitions: { sync: async () => undefined },
      models: other.router,
      toolConnections: { reload: async () => undefined },
    });

    try {
      await lister.router.refresh();

      await expect.poll(other.ids, { timeout: 5_000 }).toEqual(lister.ids());
      expect(other.ids()).toEqual(['gw-same/borealis', 'gw-same/normistral']);
      expect(other.listed.calls).toBe(0);
    } finally {
      stop();
    }
  });

  it('a replica that cannot list serves the last persisted set', async () => {
    await replica('gw-down', named('borealis')).router.refresh();

    const fresh = replica('gw-down', new ListingError('listing models failed with HTTP 503', 503));
    await fresh.router.loadDiscovered();
    const result = await fresh.router.refresh();

    expect(result.failed.map((f) => f.endpoint)).toEqual(['gw-down']);
    expect(fresh.ids()).toEqual(['gw-down/borealis']);
    expect(fresh.router.discoveryStatus()[0]).toMatchObject({
      discovered: 1,
      lastError: { kind: 'provider-error' },
    });
  });

  it('a failed listing changes nothing', async () => {
    const { store } = replica('gw-failed', []);
    await replica('gw-failed', named('borealis')).router.refresh();
    const before = (await store.load()).find((l) => l.connection === 'gw-failed');

    await replica('gw-failed', new TypeError('fetch failed')).router.refresh();
    const after = (await store.load()).find((l) => l.connection === 'gw-failed');

    expect(after?.deployments).toEqual(before?.deployments);
    expect(after?.listedAt).toBe(before?.listedAt);
    expect(after?.errorKind).toBe('unreachable');
  });

  it('the scheduled re-list runs on one replica per interval', async () => {
    const stores = Array.from(
      { length: 5 },
      () => new PostgresDiscoveredModels<DiscoveryListing>(db.runtimePool),
    );
    const every = 30 * 60_000;
    const at = new Date('2026-11-21T10:00:00Z');

    const first = await Promise.all(stores.map((s) => s.claim('relist-test', at, every)));
    const early = await Promise.all(
      stores.map((s) => s.claim('relist-test', new Date(at.getTime() + every - 1_000), every)),
    );
    const next = await Promise.all(
      stores.map((s) => s.claim('relist-test', new Date(at.getTime() + every), every)),
    );

    expect(first.filter(Boolean)).toHaveLength(1);
    expect(early.filter(Boolean)).toHaveLength(0);
    expect(next.filter(Boolean)).toHaveLength(1);
  });

  it('two listings at once both land, neither overwriting the other', async () => {
    const { store } = replica('gw-race', []);
    const seen = (deployment: string) => ({
      deployment,
      firstSeenAt: '2026-11-21T10:00:00.000Z',
      lastSeenAt: '2026-11-21T10:00:00.000Z',
    });

    await Promise.all(
      ['a', 'b', 'c', 'd'].map((d) =>
        store.update('gw-race', 'stub', (current) => ({
          connection: 'gw-race',
          source: 'stub',
          deployments: [...(current?.deployments ?? []), seen(d)],
          listedAt: '2026-11-21T10:00:00.000Z',
        })),
      ),
    );

    const stored = (await store.load()).find((l) => l.connection === 'gw-race');
    expect(stored?.deployments.map((d) => d.deployment).sort()).toEqual(['a', 'b', 'c', 'd']);
  });
});
