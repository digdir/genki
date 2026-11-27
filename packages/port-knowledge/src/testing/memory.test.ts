import { describe, expect, it } from 'vitest';
import type { FilterValue } from '../port.js';
import {
  fixtureFilters,
  indexWriterContract,
  knowledgeAdapterContract,
  memoryEngine,
  openTarget,
  partsDocuments,
  partsFiles,
  seedCorpus,
} from './index.js';

const signal = new AbortController().signal;
const embedding = { model: 'fixture', dimensions: 32 };

const seeded =
  (engine: ReturnType<typeof memoryEngine>, withEmbedding: boolean) =>
  async ({ dataset }: { dataset: { id: string; filters: Record<string, never> | object } }) => {
    const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
    const config = {
      id: dataset.id,
      filters: {},
      options: {},
      ...(withEmbedding ? { embedding } : {}),
    };
    await seedCorpus(writer, config);
    return {
      adapter: engine.adapter,
      ...(withEmbedding ? { embedding } : {}),
      failingRequest: { query: 'tilskudd '.repeat(200) },
    };
  };

/** Stores the parts fixture's two files and seeds the documents whose chunks name them. */
const seededParts =
  (engine: ReturnType<typeof memoryEngine>) =>
  async ({ dataset }: { dataset: { id: string } }) => {
    const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
    const [report, attachment] = partsFiles;
    const ids: [string, string] = [
      engine.conversions.store(report),
      engine.conversions.store(attachment),
    ];
    await seedCorpus(writer, { id: dataset.id, filters: {}, options: {} }, partsDocuments(ids));
    return { adapter: engine.adapter };
  };

const plain = memoryEngine();
knowledgeAdapterContract('memory', seeded(plain, false), seededParts(plain));

const withVectors = memoryEngine({ vectors: true });
knowledgeAdapterContract(
  'memory with vectors',
  seeded(withVectors, true),
  seededParts(withVectors),
);

knowledgeAdapterContract(
  'memory with text search and fetch only',
  seeded(memoryEngine({ capabilities: ['search.text', 'fetch', 'filter.select'] }), false),
);

indexWriterContract('memory', async ({ dataset }) => {
  const engine = memoryEngine();
  return {
    adapter: engine.adapter,
    writer: engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal }),
    dataset: { ...dataset, options: {} },
  };
});

indexWriterContract('memory with vectors and no range', async ({ dataset }) => {
  const engine = memoryEngine({ vectors: true, capabilities: ['search.vector', 'filter.select'] });
  return {
    adapter: engine.adapter,
    embedding,
    writer: engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal }),
    dataset: { ...dataset, options: {}, embedding },
  };
});

describe('the in-memory engine searching inside one document', () => {
  const open = async () => {
    const engine = memoryEngine();
    const dataset = {
      id: 'memory/rapporter',
      filters: { ...fixtureFilters, doc_num: 'multiselect' as const, title: 'text' as const },
    };
    const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
    await seedCorpus(writer, { id: dataset.id, filters: {}, options: {} });
    return openTarget({ adapter: engine.adapter }, dataset);
  };
  const documents = async (filters: Record<string, FilterValue>) =>
    new Set(
      (await (await open()).search({ query: 'tilskudd', filters })).hits.map((h) => h.document),
    );

  it("a doc_num filter returns only that document's chunks", async () => {
    expect(await documents({ doc_num: ['dok-3'] })).toEqual(new Set(['dok-3']));
  });

  it('a title filter keeps documents whose title holds every word of one option', async () => {
    expect(await documents({ title: { contains: ['tilskudd til forskning'] } })).toEqual(
      new Set(['dok-5']),
    );
    expect(await documents({ title: { contains: ['tilskudd 2021', 'opplæring'] } })).toEqual(
      new Set(['dok-2', 'dok-3']),
    );
    expect(await documents({ title: 'tilskudd til forskning' })).toEqual(new Set(['dok-5']));
  });
});
