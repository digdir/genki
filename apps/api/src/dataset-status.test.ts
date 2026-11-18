import { describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { IndexWriterRouter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import type { CatalogItem } from './catalog-registry.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { datasetStatus, lastImportAt, publicDatasetState } from './dataset-status.js';
import { indexIngestionBackend, uploadPrefix } from './index-ingestion.js';
import {
  InMemoryExecutionStore,
  IngestionService,
  type Execution,
  type Pipeline,
} from './ingestion.js';

const tenant = '991825827';
const dataset = `${tenant}/filer`;

const item: CatalogItem = {
  kind: 'dataset',
  id: dataset,
  scope: tenant,
  origin: 'api',
  version: 1,
  spec: { name: 'Filer', endpoint: 'local' },
};

const boot = () => {
  const engine = memoryEngine();
  const writers = new IndexWriterRouter({
    catalog: {
      endpoints: { local: { engine: 'memory' } },
      datasets: [{ id: dataset, endpoint: 'local', residency: 'norway' }],
    },
    adapters: [engine.writer],
    knowledgeAdapters: [engine.adapter],
    secrets: envSecrets({}),
  });
  const blobs = new InMemoryBlobStore();
  const clock = { now: new Date('2026-10-07T10:00:00Z') };
  const ingestion = new IngestionService({
    store: new InMemoryConfigEntryStore(),
    executions: new InMemoryExecutionStore(),
    backend: indexIngestionBackend({
      writers,
      residencyOf: () => 'norway',
      platformTenant: tenant,
      uploads: blobs,
    }),
    now: () => clock.now,
  });
  return { writers, blobs, ingestion, clock };
};

describe('the status of a dataset', () => {
  it('counts documents and chunks in the store and shows the last run and the next one', async () => {
    const { writers, blobs, ingestion } = boot();
    const deps = { ingestion, writers, countable: (engine: string) => engine === 'memory' };

    expect(await datasetStatus(deps, item)).toEqual({
      state: 'needs-pipeline',
      source: 'none',
      documents: 0,
      chunks: 0,
      lastExecution: null,
      nextRunAt: null,
      updatedAt: null,
      skipped: [],
    });

    const prefix = uploadPrefix(dataset, tenant);
    for (const [name, text] of [
      ['a.md', '# A\n\nFørste veileder.'],
      ['b.md', '# B\n\nAndre veileder.'],
    ] as const)
      await blobs.put(
        { tenant, path: `${prefix}${name}` },
        new TextEncoder().encode(text),
        'text/markdown',
      );
    await blobs.put({ tenant, path: `${prefix}c.pdf` }, new Uint8Array([1]), 'application/pdf');
    const saved = await ingestion.save({
      scope: tenant,
      dataset,
      id: 'filer',
      spec: {
        name: 'Filer',
        source: { kind: 'upload' },
        chunking: { minimumLength: 1 },
        schedule: 'daily',
      },
      by: 'kari',
      reason: 'Test',
    });
    if (!saved.ok) throw new Error('not saved');
    const started = await ingestion.execute({
      pipeline: saved.value,
      target: { dataset, endpoint: 'local', collections: {} },
      by: 'kari',
      tenant,
    });
    if (!started.ok) throw new Error('not started');
    await started.done;

    expect(await datasetStatus(deps, item)).toEqual({
      state: 'ready',
      source: 'upload',
      documents: 2,
      chunks: 2,
      lastExecution: {
        status: 'succeeded',
        startedBy: 'kari',
        startedAt: '2026-10-07T10:00:00.000Z',
        endedAt: '2026-10-07T10:00:00.000Z',
        stored: 2,
        skipped: 1,
      },
      nextRunAt: '2026-10-08T01:00:00.000Z',
      updatedAt: '2026-10-07T10:00:00.000Z',
      skipped: [{ document: 'c.pdf', reason: 'unsupported_type' }],
    });
    expect(await datasetStatus({ ...deps, countable: () => false }, item)).toMatchObject({
      documents: null,
      chunks: null,
    });
  });

  it('reads the document count from the search engine for a shared dataset genki cannot count in its own store', async () => {
    const { ingestion } = boot();
    const shared: CatalogItem = { ...item, id: 'digdir/kudos', scope: 'platform' };

    const status = await datasetStatus(
      { ingestion, countable: () => false, documentCount: async () => 4210 },
      shared,
    );

    expect(status).toMatchObject({ documents: 4210, chunks: null });
  });

  it('reports a dataset on a search engine the platform does not write to as ingested outside the platform, with the document count read from the engine', async () => {
    const { ingestion } = boot();
    const shared: CatalogItem = { ...item, id: 'digdir/kudos', scope: 'platform' };
    const deps = {
      ingestion,
      countable: (engine: string) => engine === 'memory',
      engineOf: () => 'typesense',
    };

    expect(await datasetStatus({ ...deps, documentCount: async () => 45_321 }, shared)).toEqual({
      state: 'external',
      source: 'none',
      documents: 45_321,
      chunks: null,
      lastExecution: null,
      nextRunAt: null,
      updatedAt: null,
      skipped: [],
    });
    expect(
      await datasetStatus(
        {
          ...deps,
          documentCount: async () => {
            throw new Error('engine down');
          },
        },
        shared,
      ),
    ).toMatchObject({ state: 'external', documents: null });
  });

  it('keeps the real status for a dataset the platform ingests itself', async () => {
    const { ingestion, writers } = boot();
    const deps = {
      ingestion,
      writers,
      countable: (engine: string) => engine === 'memory',
      engineOf: () => 'memory',
      documentCount: async () => 99,
    };

    expect(await datasetStatus(deps, item)).toMatchObject({
      state: 'needs-pipeline',
      documents: 0,
    });
  });

  it('reports a dataset filled outside the platform as external to frontends, not needs-pipeline', async () => {
    const { ingestion } = boot();

    expect(await publicDatasetState(ingestion, tenant, dataset, true)).toBe('external');
    expect(await publicDatasetState(ingestion, tenant, dataset)).toBe('needs-pipeline');
  });
});

describe('the last import of a dataset', () => {
  const run = (pipelineDataset: string, status: Execution['status'], endedAt?: string) =>
    ({
      id: `${pipelineDataset}-${status}-${endedAt ?? 'open'}`,
      dataset: pipelineDataset,
      pipeline: 'p',
      pipelineVersion: 1,
      backend: 'index',
      status,
      startedBy: 'kari',
      startedAt: '2026-11-01T00:00:00.000Z',
      ...(endedAt ? { endedAt } : {}),
    }) satisfies Execution;
  const runs = [
    run(dataset, 'succeeded', '2026-11-10T02:00:00.000Z'),
    run(dataset, 'succeeded', '2026-11-14T02:00:00.000Z'),
    run(dataset, 'failed', '2026-11-15T02:00:00.000Z'),
    run(dataset, 'running'),
    run('923609016/andre', 'succeeded', '2026-11-16T02:00:00.000Z'),
  ];
  const ingestion = {
    list: async (scope: string, id: string) =>
      scope === tenant && id === dataset ? [{ id: 'p' } as Pipeline] : [],
    executions: async (id: string) => runs.filter((r) => r.dataset === id),
  };

  it('is when its newest successful run ended, never a failed or open run or another dataset', async () => {
    expect(await lastImportAt(ingestion, item)).toBe('2026-11-14T02:00:00.000Z');
  });

  it('is unknown for a dataset the platform has never imported', async () => {
    expect(await lastImportAt(ingestion, { scope: 'platform', id: 'digdir/kudos' })).toBe(
      undefined,
    );
  });
});
