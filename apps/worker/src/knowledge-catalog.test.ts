import { describe, expect, it, vi } from 'vitest';
import { createRuntime, TenantSecretVault } from '@genai/composition';
import { InMemoryDefinitionStore } from '@genai/definitions';
import { envSecrets, InMemoryEventLog, InMemoryStateStore, InMemoryTaskStore } from '@genai/kernel';
import { ownTenantOnly } from './worker.js';

const fakePool = () => {
  const query = vi.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [], rowCount: 0 }));
  const connect = vi.fn(async () => ({ query, release: () => undefined }));
  return { pool: { query, connect, on: () => undefined } as never, query };
};

const syncedDatasets = (query: ReturnType<typeof fakePool>['query']) =>
  query.mock.calls
    .filter(([sql]) => String(sql).includes('from kn_generations where dataset'))
    .map(([, params]) => params?.[0]);

describe('the knowledge catalog in the worker', () => {
  it("the worker changes a dataset's filter indexes when its filters change in the catalog", async () => {
    const owner = fakePool();
    const dataset = {
      id: 'digdir/kudos',
      endpoint: 'knowledge-pg',
      residency: 'norway',
      filters: { type: 'multiselect' },
      generation: 'g-20261030-7f3c2a',
    };
    const runtime = await createRuntime({
      platformTenant: '991825827',
      catalogs: {
        models: { endpoints: {}, models: [] },
        knowledge: {
          endpoints: {
            'knowledge-pg': { engine: 'pgvector', options: { connection: 'knowledge' } },
          },
          datasets: [dataset],
        },
        rerank: { endpoints: {}, rerankers: [] },
      },
      secrets: envSecrets({}),
      vault: new TenantSecretVault(),
      definitions: (plugins) => new InMemoryDefinitionStore(plugins),
      policy: ownTenantOnly(),
      log: new InMemoryEventLog(),
      tasks: new InMemoryTaskStore(),
      state: new InMemoryStateStore(),
      knowledgePool: fakePool().pool,
      knowledgeServer: { owner: owner.pool, writer: owner.pool },
    });
    await vi.waitFor(() => expect(syncedDatasets(owner.query)).toEqual(['digdir/kudos']));

    const published = await runtime.catalog.publish({
      kind: 'dataset',
      scope: 'platform',
      id: 'digdir/kudos',
      spec: {
        ...dataset,
        filters: { type: 'multiselect', year: 'range' },
        valueTypes: { year: 'integer' },
      },
      by: 'test',
      reason: 'year as a range',
    });
    expect(published).toMatchObject({ ok: true });
    await vi.waitFor(() =>
      expect(syncedDatasets(owner.query)).toEqual(['digdir/kudos', 'digdir/kudos']),
    );
  });
});
