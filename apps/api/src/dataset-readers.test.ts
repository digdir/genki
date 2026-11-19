import { adoptionKind, blockKey } from '@genai/composition';
import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { datasetReaderCounts, datasetReaders } from './dataset-readers.js';

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

describe('when a reader started reading a dataset', () => {
  const service = (datasets: string[]) => ({
    kind: 'Service',
    metadata: { tenant: '991825827', id: 'svar' },
    spec: {
      strategy: { config: { knowledge: { datasets: datasets.map((dataset) => ({ dataset })) } } },
    },
  });
  const version = (n: number, datasets: string[], by: string) => ({
    version: n,
    definition: service(datasets),
    publishedBy: by,
    publishedAt: `2026-10-0${n}T10:00:00Z`,
    reason: 'test',
    files: {},
  });
  const compiled = {
    service: { tenant: '991825827', id: 'svar' },
    serviceName: 'Svar',
    capability: { config: { knowledge: { datasets: [{ dataset: 'sider' }] } } },
  };

  it('dates a service from the first version of its newest unbroken run that names the dataset, by alias or id', async () => {
    const versions = [
      version(1, ['991825827/sider'], 'employee:test:ola'),
      version(2, [], 'employee:test:ola'),
      version(3, ['sider'], 'employee:test:kari'),
      version(4, ['991825827/sider'], 'employee:test:per'),
    ];
    const readers = await datasetReaders(
      {
        definitions: {
          capabilities: async () => [compiled] as never,
          versions: async () => versions as never,
        },
        configEntries: new InMemoryConfigEntryStore(),
        resolve: (id) => (id === 'sider' ? '991825827/sider' : id),
        names: { namesOf: async () => new Map([['employee:test:kari', 'Kari Nordmann']]) },
      },
      '991825827/sider',
    );

    expect(readers).toEqual([
      {
        kind: 'service',
        tenant: '991825827',
        id: 'svar',
        name: 'Svar',
        addedAt: '2026-10-03T10:00:00Z',
        addedBy: 'employee:test:kari',
        addedByName: 'Kari Nordmann',
      },
    ]);
  });

  it('dates an adoption from the adoption entry that is still in force', async () => {
    const configEntries = new InMemoryConfigEntryStore();
    await adopt(configEntries, '991825827', 'digdir/kudos');

    const readers = await datasetReaders(
      { definitions: { capabilities: async () => [] }, configEntries, resolve: (id) => id },
      'digdir/kudos',
    );

    expect(readers[0]).toMatchObject({ addedAt: '2026-10-06T10:00:00Z', addedBy: 'test' });
  });
});
