import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envSecrets } from '@genai/kernel';
import {
  inMemoryDiscoveredModels,
  ListingError,
  listingErrorKind,
  ModelRouter,
  type DiscoveredDeployment,
  type DiscoveredModelStore,
  type ModelAdapter,
} from './index.js';

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

const catalog = {
  endpoints: {
    gateway: {
      baseURL: 'https://gateway.example',
      auth: { kind: 'api-key', secret: 'secret://env/key' },
      families: { proto: '/v1' },
      discovery: [{ source: 'stub', capabilities: ['stream'] }],
    },
  },
  models: [],
};

const start = new Date('2026-11-21T10:00:00Z');
const hours = (n: number) => new Date(start.getTime() + n * 3_600_000);

const replica = (store: DiscoveredModelStore, clock: { now: Date }) => {
  const source = {
    kind: 'stub',
    found: [] as DiscoveredDeployment[] | Error,
    calls: 0,
    async list() {
      this.calls += 1;
      if (this.found instanceof Error) throw this.found;
      return this.found;
    },
  };
  const router = new ModelRouter({
    catalog,
    adapters: [adapter],
    secrets: envSecrets({ KEY: 'k' }),
    sources: [source],
    discovered: store,
    now: () => clock.now,
  });
  return { router, source, ids: () => router.describe().map((m) => m.id) };
};

const named = (...deployments: string[]) => deployments.map((deployment) => ({ deployment }));

describe('discovered models kept in a store every replica reads', () => {
  it('a replica that cannot list serves the last persisted set', async () => {
    const store = inMemoryDiscoveredModels();
    const clock = { now: start };
    const first = replica(store, clock);
    first.source.found = named('borealis', 'normistral');
    await first.router.refresh();

    const fresh = replica(store, clock);
    fresh.source.found = new ListingError('listing models failed with HTTP 503', 503);
    const result = await fresh.router.refresh();

    expect(result.failed.map((f) => f.endpoint)).toEqual(['gateway']);
    expect(fresh.ids()).toEqual(['gateway/borealis', 'gateway/normistral']);
  });

  it('a model missing from one listing stays until the grace period passes', async () => {
    const clock = { now: start };
    const { router, source, ids } = replica(inMemoryDiscoveredModels(), clock);
    source.found = named('borealis', 'normistral');
    await router.refresh();

    source.found = named('borealis');
    clock.now = hours(23);
    await router.refresh();
    expect(ids()).toEqual(['gateway/borealis', 'gateway/normistral']);

    clock.now = hours(24);
    await router.refresh();
    expect(ids()).toEqual(['gateway/borealis']);
  });

  it('a model named again before the grace period passes starts a new grace period', async () => {
    const clock = { now: start };
    const { router, source, ids } = replica(inMemoryDiscoveredModels(), clock);
    source.found = named('borealis', 'normistral');
    await router.refresh();
    source.found = named('borealis');
    clock.now = hours(20);
    await router.refresh();
    source.found = named('borealis', 'normistral');
    clock.now = hours(22);
    await router.refresh();

    source.found = named('borealis');
    clock.now = hours(45);
    await router.refresh();

    expect(ids()).toEqual(['gateway/borealis', 'gateway/normistral']);
  });

  it('a failed listing changes nothing', async () => {
    const store = inMemoryDiscoveredModels();
    const clock = { now: start };
    const { router, source, ids } = replica(store, clock);
    source.found = named('borealis');
    await router.refresh();
    const [before] = await store.load();

    source.found = new ListingError('listing models failed with HTTP 401', 401);
    clock.now = hours(48);
    await router.refresh();
    const [after] = await store.load();

    expect(ids()).toEqual(['gateway/borealis']);
    expect(after?.deployments).toEqual(before?.deployments);
    expect(after?.listedAt).toBe(before?.listedAt);
  });

  it('two replicas serve the same set', async () => {
    const store = inMemoryDiscoveredModels();
    const clock = { now: start };
    const lister = replica(store, clock);
    const other = replica(store, clock);
    await other.router.loadDiscovered();
    lister.source.found = named('borealis', 'normistral', 'qwen');
    await lister.router.refresh();

    await other.router.loadDiscovered();

    expect(other.ids()).toEqual(lister.ids());
    expect(other.ids()).toHaveLength(3);
    expect(other.source.calls).toBe(0);
  });

  it('a connection moved to another address serves none of the old address models, even while its listing fails', async () => {
    const clock = { now: start };
    const { router, source, ids } = replica(inMemoryDiscoveredModels(), clock);
    source.found = named('borealis');
    await router.refresh();

    router.reload({
      ...catalog,
      endpoints: {
        gateway: { ...catalog.endpoints.gateway, baseURL: 'https://other-gateway.example' },
      },
    });
    expect(ids()).toEqual([]);
    source.found = new ListingError('listing models failed with HTTP 503', 503);
    await router.refresh();

    expect(ids()).toEqual([]);
  });

  it('a store that cannot save serves the new listing and names no database error', async () => {
    const store = inMemoryDiscoveredModels();
    const clock = { now: start };
    const { router, source, ids } = replica(
      {
        ...store,
        update: async () => {
          throw new Error('relation "discovered_models" does not exist');
        },
      },
      clock,
    );
    source.found = named('borealis');

    const result = await router.refresh();

    expect(ids()).toEqual(['gateway/borealis']);
    expect(result.failed).toEqual([{ endpoint: 'gateway', error: 'the listing was not stored' }]);
  });

  it('reports per connection what it serves, when it last listed and the kind of its last failure', async () => {
    const clock = { now: start };
    const { router, source } = replica(inMemoryDiscoveredModels(), clock);
    source.found = named('borealis', 'normistral');
    await router.refresh();
    source.found = new ListingError('listing models failed with HTTP 401', 401);
    clock.now = hours(1);
    await router.refresh();

    expect(router.discoveryStatus()).toEqual([
      {
        connection: 'gateway',
        source: 'stub',
        discovered: 2,
        listed: 2,
        listedAt: '2026-11-21T10:00:00.000Z',
        lastError: { kind: 'unauthorized', at: '2026-11-21T11:00:00.000Z' },
      },
    ]);
  });

  it('names the kind of a failed listing from its status, a timeout or a network failure', () => {
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';

    expect(
      [
        new ListingError('x', 403),
        new ListingError('x', 404),
        new ListingError('x', 429),
        new ListingError('x', 502),
        timeout,
        new TypeError('fetch failed'),
        new Error('federated sign-in is not ready'),
      ].map(listingErrorKind),
    ).toEqual([
      'unauthorized',
      'not-found',
      'rate-limited',
      'provider-error',
      'timeout',
      'unreachable',
      'error',
    ]);
  });
});

describe('the in-memory discovery store', () => {
  it('gives the re-list to one caller per interval', async () => {
    const store = inMemoryDiscoveredModels();
    const every = 30 * 60_000;

    const claims = [
      await store.claim('relist', start, every),
      await store.claim('relist', start, every),
      await store.claim('relist', new Date(start.getTime() + every - 1), every),
      await store.claim('relist', new Date(start.getTime() + every), every),
    ];

    expect(claims).toEqual([true, false, false, true]);
  });
});
