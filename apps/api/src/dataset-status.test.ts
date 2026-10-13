import { describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { InMemoryBlobStore } from '@genai/port-blob';
import { IndexWriterRouter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import type { CatalogItem } from './catalog-registry.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { datasetStatus, publicDatasetState } from './dataset-status.js';
import { indexIngestionBackend, uploadPrefix } from './index-ingestion.js';
import { InMemoryExecutionStore, IngestionService } from './ingestion.js';

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
        startedAt: '2026-10-07T10:00:00.000Z',
        endedAt: '2026-10-07T10:00:00.000Z',
        stored: 2,
        skipped: 1,
      },
      nextRunAt: '2026-10-08T01:00:00.000Z',
      skipped: [{ document: 'c.pdf', reason: 'unsupported_type' }],
    });
    expect(await datasetStatus({ ...deps, countable: () => false }, item)).toMatchObject({
      documents: null,
      chunks: null,
    });
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
