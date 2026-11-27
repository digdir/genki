import { parseKnowledgeCatalog, type KnowledgeAdapter } from '@genai/port-knowledge';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { CatalogRegistry, type CatalogProblem, type CatalogSeed } from './catalog-registry.js';
import { InMemoryConfigEntryStore, platformScope } from './config-store.js';

const adapter = (engine: string): KnowledgeAdapter => ({
  engine,
  requiresBaseURL: false,
  endpointOptions: z.record(z.string(), z.unknown()),
  datasetOptions: z.record(z.string(), z.unknown()),
  connect: () => {
    throw new Error('not used');
  },
});
const adapters = [adapter('http-search'), adapter('pgvector')];

const problemsOf = (catalog: unknown): CatalogProblem[] => {
  const parsed = parseKnowledgeCatalog(catalog, adapters);
  return parsed.ok ? [] : parsed.errors;
};

const knowledgeServer = { engine: 'pgvector', options: { connection: 'knowledge' } };
const remote = { engine: 'http-search' };
const dataset = (endpoint: string, extra: Record<string, unknown> = {}) => ({
  endpoint,
  residency: 'norway',
  ...extra,
});

const seedWith = (knowledge: unknown): CatalogSeed => ({
  models: { endpoints: {}, models: [] },
  knowledge,
  rerank: { endpoints: {}, rerankers: [] },
});
const emptySeed = seedWith({ endpoints: {}, datasets: [] });

const save = async (
  store: InMemoryConfigEntryStore,
  kind: string,
  id: string,
  spec: unknown,
  at: string,
) => {
  const version = ((await store.history(kind, platformScope, id)).at(-1)?.version ?? 0) + 1;
  await store.append({
    kind,
    scope: platformScope,
    id,
    version,
    spec,
    deleted: false,
    by: 'drift',
    reason: 'test',
    at,
  });
};

const registryOn = (
  store: InMemoryConfigEntryStore,
  seed = emptySeed,
  logged: { msg: string; fields: Record<string, unknown> }[] = [],
) =>
  new CatalogRegistry({
    seed,
    store,
    checks: { models: () => [], knowledge: problemsOf, rerank: () => [] },
    apply: () => {},
    logger: (msg, fields) => logged.push({ msg, fields }),
    now: () => new Date('2026-11-20T10:35:00Z'),
  });

const endpointOf = (registry: CatalogRegistry, id: string) =>
  registry.effective().knowledge.datasets.find((d) => d.id === id)?.endpoint;

describe('catalog replay', () => {
  it('a dataset stays on an endpoint whose entry was saved after it', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'dataset', 'digdir/docs', dataset('server'), '2026-11-17T09:22:00Z');
    await save(store, 'knowledge-endpoint', 'server', knowledgeServer, '2026-11-20T10:35:00Z');
    const registry = registryOn(store);

    await registry.initialize();

    expect(endpointOf(registry, 'digdir/docs')).toBe('server');
    expect(registry.skipped()).toEqual([]);
  });

  it('saving an endpoint again keeps every dataset on it', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'knowledge-endpoint', 'server', knowledgeServer, '2026-11-05T08:26:00Z');
    await save(store, 'dataset', 'digdir/docs', dataset('server'), '2026-11-17T09:22:00Z');
    await save(store, 'dataset', 'digdir/public', dataset('server'), '2026-11-18T09:00:00Z');
    const registry = registryOn(store);
    await registry.initialize();

    const saved = await registry.publish({
      kind: 'knowledge-endpoint',
      scope: platformScope,
      id: 'server',
      spec: { ...knowledgeServer, sharing: { tenants: '*' } },
      by: 'drift',
      reason: 'share it',
    });
    expect(saved.ok).toBe(true);
    await registry.refresh();

    expect(endpointOf(registry, 'digdir/docs')).toBe('server');
    expect(endpointOf(registry, 'digdir/public')).toBe('server');
    expect(registry.skipped()).toEqual([]);
  });

  it('an endpoint stored with sharing fields the schema no longer has stays shared, and a new save refuses them', async () => {
    const store = new InMemoryConfigEntryStore();
    const stored = { tenants: '*', collectionPrefixes: ['digdir_'] };
    await save(
      store,
      'knowledge-endpoint',
      'server',
      { ...knowledgeServer, sharing: stored },
      '2026-11-05T08:26:00Z',
    );
    const registry = registryOn(store);
    await registry.initialize();

    expect(
      registry.sharedWith(registry.sharingOf('knowledge-endpoint', 'server'), '991825827'),
    ).toBe(true);
    const saved = await registry.publish({
      kind: 'knowledge-endpoint',
      scope: platformScope,
      id: 'server',
      spec: { ...knowledgeServer, sharing: stored },
      by: 'drift',
      reason: 'share it',
    });
    expect(saved.ok).toBe(false);
  });

  it('a dataset replayed from the knowledge database over a seed on another engine keeps its generation', async () => {
    const store = new InMemoryConfigEntryStore();
    const seed = seedWith({
      endpoints: { 'kudos-sok': remote },
      datasets: [{ id: 'digdir/kudos', ...dataset('kudos-sok') }],
    });
    await save(
      store,
      'dataset',
      'digdir/kudos',
      dataset('kunnskapsserveren', { generation: 'g-20261116-abc123' }),
      '2026-11-17T09:22:00Z',
    );
    await save(
      store,
      'knowledge-endpoint',
      'kunnskapsserveren',
      knowledgeServer,
      '2026-11-20T10:35:00Z',
    );
    const registry = registryOn(store, seed);

    await registry.initialize();

    expect(registry.skipped()).toEqual([]);
    expect(registry.datasetOnKnowledgeServer('digdir/kudos')).toBe(true);
    expect(registry.get('dataset', 'digdir/kudos')).toMatchObject({
      origin: 'api',
      spec: { endpoint: 'kunnskapsserveren', generation: 'g-20261116-abc123' },
    });
  });

  it('a skipped catalog entry is reported with its reason', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'dataset', 'digdir/lost', dataset('gone'), '2026-11-17T09:22:00Z');
    const logged: { msg: string; fields: Record<string, unknown> }[] = [];
    const registry = registryOn(store, emptySeed, logged);

    await registry.initialize();

    expect(registry.skipped()).toEqual([
      {
        kind: 'dataset',
        id: 'digdir/lost',
        problems: [{ path: 'datasets.0.endpoint', message: 'unknown endpoint gone' }],
      },
    ]);
    expect(logged.filter((l) => l.msg === 'catalog entry skipped')).toEqual([
      {
        msg: 'catalog entry skipped',
        fields: {
          level: 'error',
          kind: 'dataset',
          id: 'digdir/lost',
          reason: 'datasets.0.endpoint: unknown endpoint gone',
        },
      },
    ]);
  });

  it('logs the endpoint each dataset reads from after every replay', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'knowledge-endpoint', 'server', knowledgeServer, '2026-11-05T08:26:00Z');
    await save(
      store,
      'dataset',
      'digdir/docs',
      dataset('server', { generation: 'g-20261116-abc123' }),
      '2026-11-17T09:22:00Z',
    );
    const logged: { msg: string; fields: Record<string, unknown> }[] = [];
    const registry = registryOn(store, emptySeed, logged);

    await registry.initialize();

    expect(logged).toEqual([
      {
        msg: 'catalog dataset endpoint',
        fields: {
          level: 'info',
          dataset: 'digdir/docs',
          endpoint: 'server',
          engine: 'pgvector',
          generation: 'g-20261116-abc123',
        },
      },
    ]);
  });

  it('an entry that only fits after a later entry is placed on a second pass', async () => {
    const store = new InMemoryConfigEntryStore();
    const seed = seedWith({
      endpoints: { old: remote },
      datasets: [{ id: 'digdir/docs', ...dataset('old') }],
    });
    await save(store, 'knowledge-endpoint', 'new', remote, '2026-11-01T00:00:00Z');
    await store.append({
      kind: 'knowledge-endpoint',
      scope: platformScope,
      id: 'old',
      version: 1,
      spec: remote,
      deleted: true,
      by: 'drift',
      reason: 'test',
      at: '2026-11-02T00:00:00Z',
    });
    await save(store, 'dataset', 'digdir/docs', dataset('new'), '2026-11-03T00:00:00Z');
    const registry = registryOn(store, seed);

    await registry.initialize();

    expect(registry.skipped()).toEqual([]);
    expect(registry.get('knowledge-endpoint', 'old')).toBeUndefined();
    expect(endpointOf(registry, 'digdir/docs')).toBe('new');
  });
});

const unknownEndpoints = (catalog: unknown): CatalogProblem[] => {
  const { endpoints, models } = catalog as {
    endpoints: Record<string, unknown>;
    models: { id: string; endpoint: string }[];
  };
  return models
    .filter((m) => !(m.endpoint in endpoints))
    .map((m) => ({ path: 'models', message: `unknown endpoint ${m.endpoint}` }));
};

const leftoverOn = (
  store: InMemoryConfigEntryStore,
  used: { models?: string[]; rerankers?: string[] } = {},
) =>
  new CatalogRegistry({
    seed: emptySeed,
    store,
    checks: { models: unknownEndpoints, knowledge: problemsOf, rerank: () => [] },
    apply: () => {},
    references: async () => ({
      models: new Set(used.models),
      datasets: new Set(),
      rerankers: new Set(used.rerankers),
    }),
    now: () => new Date('2026-11-20T10:35:00Z'),
  });

const leftover = 'nimbrel-cortex/cortex';

describe('skipped entries', () => {
  it('a leftover model nobody uses is marked unused', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'model', leftover, { endpoint: 'gone' }, '2026-11-17T09:22:00Z');
    const registry = leftoverOn(store);

    await registry.initialize();

    expect(registry.skipped()).toMatchObject([{ kind: 'model', id: leftover, unused: true }]);
  });

  it('a skipped model a published service uses is not marked unused', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'model', leftover, { endpoint: 'gone' }, '2026-11-17T09:22:00Z');
    const registry = leftoverOn(store, { models: [leftover] });

    await registry.initialize();

    expect(registry.skipped()[0]?.unused).toBeUndefined();
  });

  it('a skipped model a dataset embeds with is not marked unused', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'knowledge-endpoint', 'server', remote, '2026-11-05T08:26:00Z');
    await save(
      store,
      'dataset',
      'digdir/docs',
      dataset('server', { embedding: { model: leftover, dimensions: 1024 } }),
      '2026-11-06T08:26:00Z',
    );
    await save(store, 'model', leftover, { endpoint: 'gone' }, '2026-11-17T09:22:00Z');
    const registry = leftoverOn(store);

    await registry.initialize();

    expect(registry.skipped()).toHaveLength(1);
    expect(registry.skipped()[0]?.unused).toBeUndefined();
  });

  it('a skipped dataset is never marked unused', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'dataset', 'digdir/lost', dataset('gone'), '2026-11-17T09:22:00Z');
    const registry = leftoverOn(store);

    await registry.initialize();

    expect(registry.skipped()).toHaveLength(1);
    expect(registry.skipped()[0]?.unused).toBeUndefined();
  });

  it('an operator can delete a skipped entry, and replay never reports it again', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'model', leftover, { endpoint: 'gone' }, '2026-11-17T09:22:00Z');
    const registry = leftoverOn(store);
    await registry.initialize();

    const result = await registry.remove({
      kind: 'model',
      scope: platformScope,
      id: leftover,
      by: 'drift',
      reason: 'its APIs were deleted',
      ifVersion: 1,
    });

    expect(result.ok).toBe(true);
    expect(registry.skipped()).toEqual([]);
    expect((await store.history('model', platformScope, leftover)).at(-1)).toMatchObject({
      version: 2,
      deleted: true,
      by: 'drift',
      reason: 'its APIs were deleted',
      spec: { endpoint: 'gone' },
    });
    const replayed = leftoverOn(store);
    await replayed.initialize();
    expect(replayed.skipped()).toEqual([]);
  });

  it('a skipped entry is deleted only in its own scope', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'model', leftover, { endpoint: 'gone' }, '2026-11-17T09:22:00Z');
    const registry = leftoverOn(store);
    await registry.initialize();

    const result = await registry.remove({
      kind: 'model',
      scope: '312521172',
      id: leftover,
      by: 'drift',
      reason: 'test',
    });

    expect(result.ok).toBe(false);
    expect(registry.skipped()).toHaveLength(1);
  });

  it('a skipped entry a published service uses cannot be deleted', async () => {
    const store = new InMemoryConfigEntryStore();
    await save(store, 'model', leftover, { endpoint: 'gone' }, '2026-11-17T09:22:00Z');
    const registry = leftoverOn(store, { models: [leftover] });
    await registry.initialize();

    const result = await registry.remove({
      kind: 'model',
      scope: platformScope,
      id: leftover,
      by: 'drift',
      reason: 'test',
    });

    expect(result).toMatchObject({
      ok: false,
      errors: [{ message: `${leftover} is used by a published service` }],
    });
  });

  it('deleting an id with no journal entry is still refused', async () => {
    const registry = leftoverOn(new InMemoryConfigEntryStore());
    await registry.initialize();

    const result = await registry.remove({
      kind: 'model',
      scope: platformScope,
      id: 'nobody/none',
      by: 'drift',
      reason: 'test',
    });

    expect(result).toMatchObject({ ok: false, errors: [{ message: 'no model nobody/none' }] });
  });
});
