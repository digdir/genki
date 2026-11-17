import { adoptionKind, blockKey } from '@genai/composition';
import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { datasetReaderCounts } from './dataset-readers.js';

const adopt = (store: InMemoryConfigEntryStore, tenant: string, dataset: string) =>
  store.append({
    kind: adoptionKind,
    scope: tenant,
    id: blockKey('dataset', dataset),
    version: 1,
    spec: {},
    deleted: false,
    by: 'test',
    reason: 'test',
    at: '2026-10-06T10:00:00Z',
  });

describe('dataset reader counts', () => {
  it("counts a tenant's adoption of a dataset block, and not another tenant's", async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await adopt(configEntries, '991825827', 'digdir/kudos');
    await adopt(configEntries, '999888777', 'digdir/kudos');
    await adopt(configEntries, '999888777', 'digdir/lovdata');

    const counts = await datasetReaderCounts(
      { definitions: { capabilities: async () => [] }, configEntries, resolve: (id) => id },
      '991825827',
    );

    expect([...counts]).toEqual([['digdir/kudos', 1]]);
  });
});
