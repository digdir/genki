import { InMemoryTestSetStore, parseTestSet } from '@genai/eval';
import { describe, expect, it } from 'vitest';
import { InMemoryConfigEntryStore } from './config-store.js';
import { traceDatasets } from './trace-datasets.js';

const tenant = '991825827';
const connection = {
  id: 'lokal',
  host: 'https://langfuse.etaten.example.no',
  publicKey: 'pk',
  services: ['svar'],
};

describe('trace datasets', () => {
  it('logs each dataset Langfuse could not make when a connection is saved, by connection and test set', async () => {
    const testSets = new InMemoryTestSetStore();
    await testSets.put(
      parseTestSet({
        apiVersion: 'genai/v1',
        kind: 'TestSet',
        metadata: { tenant, id: 'svar-frister', name: 'Frister', version: 1 },
        spec: { service: 'svar', cases: [] },
      }),
    );
    const logged: { msg: string; fields: Record<string, unknown> }[] = [];
    const datasets = traceDatasets({
      configEntries: new InMemoryConfigEntryStore(),
      testSets,
      traceSinks: {
        dataset: async () => {
          throw new Error('Langfuse answered HTTP 503 for /api/public/v2/datasets/{name}');
        },
      },
      log: (msg, fields) => logged.push({ msg, fields }),
    });

    await datasets.forConnection(tenant, connection);

    expect(logged).toEqual([
      {
        msg: 'langfuse dataset not made',
        fields: {
          tenant,
          connection: 'lokal',
          testSet: 'svar-frister',
          error: 'Langfuse answered HTTP 503 for /api/public/v2/datasets/{name}',
        },
      },
    ]);
  });
});
