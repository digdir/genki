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
const adapters = [adapter('typesense'), adapter('knowledge')];

const problemsOf = (catalog: unknown): CatalogProblem[] => {
  const parsed = parseKnowledgeCatalog(catalog, adapters);
  return parsed.ok ? [] : parsed.errors;
};

const knowledgeServer = { engine: 'knowledge', options: { connection: 'knowledge' } };
const typesense = { engine: 'typesense' };
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

  it('a dataset replayed from the knowledge database over a seed on another engine keeps its generation', async () => {
    const store = new InMemoryConfigEntryStore();
    const seed = seedWith({
      endpoints: { 'kudos-typesense': typesense },
      datasets: [{ id: 'digdir/kudos', ...dataset('kudos-typesense') }],
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
          engine: 'knowledge',
          generation: 'g-20261116-abc123',
        },
      },
    ]);
  });

  it('an entry that only fits after a later entry is placed on a second pass', async () => {
    const store = new InMemoryConfigEntryStore();
    const seed = seedWith({
      endpoints: { old: typesense },
      datasets: [{ id: 'digdir/docs', ...dataset('old') }],
    });
    await save(store, 'knowledge-endpoint', 'new', typesense, '2026-11-01T00:00:00Z');
    await store.append({
      kind: 'knowledge-endpoint',
      scope: platformScope,
      id: 'old',
      version: 1,
      spec: typesense,
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
