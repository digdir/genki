import { describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { KnowledgeRouter, type DatasetConfig, type KnowledgeAdapter } from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';
import { cachedDocumentCount } from './configurables.js';

const principal = {
  kind: 'employee',
  issuer: 'test',
  subject: 'kari',
  tenant: '991825827',
} as const;

const engineWith = async (dataset: string, count: number) => {
  const { adapter, writer } = memoryEngine();
  const store = writer.connect({ engine: 'memory' } as never, {
    signal: new AbortController().signal,
  });
  const config = { id: dataset, filters: {}, options: {} } as DatasetConfig<never>;
  await store.prepare(config, 'g1');
  await store.promote(config, 'g1');
  const add = async (n: number) => {
    for (let i = 0; i < n; i++)
      await store.store(config, 'g1', {
        id: `${dataset}-${crypto.randomUUID()}`,
        fields: {},
        chunks: [{ id: crypto.randomUUID(), position: 0, text: 'tekst' }],
        phrases: [],
      });
  };
  await add(count);
  const reads = { documents: 0 };
  const counted: KnowledgeAdapter = {
    ...(adapter as KnowledgeAdapter),
    connect: (endpoint) => {
      const inner = (adapter as KnowledgeAdapter).connect(endpoint);
      return {
        ...inner,
        documents: (d, request, signal) => {
          reads.documents += 1;
          if (!inner.documents) throw new Error('the memory engine lists documents');
          return inner.documents(d, request, signal);
        },
      };
    },
  };
  const router = new KnowledgeRouter({
    catalog: {
      endpoints: { lokal: { engine: 'memory' } },
      datasets: [{ id: dataset, endpoint: 'lokal', residency: 'norway', options: {} }],
    },
    adapters: [counted],
    secrets: envSecrets({}),
  });
  return { router, reads, add };
};

describe('counting the documents of a dataset', () => {
  it('reads the count from one document listing and keeps it for a while', async () => {
    const { router, reads } = await engineWith('digdir/kudos', 3);
    const count = cachedDocumentCount(router);
    const input = { dataset: 'digdir/kudos', tenant: '991825827', principal };

    expect(await count(input)).toBe(3);
    expect(await count(input)).toBe(3);
    expect(reads.documents).toBe(1);
  });

  it('reads an empty dataset again, so its first read-in shows its documents at once', async () => {
    const { router, reads, add } = await engineWith('digdir/ny', 0);
    const count = cachedDocumentCount(router);
    const input = { dataset: 'digdir/ny', tenant: '991825827', principal };

    expect(await count(input)).toBe(0);
    await add(1);
    expect(await count(input)).toBe(1);
    expect(await count(input)).toBe(1);
    expect(reads.documents).toBe(2);
  });
});
