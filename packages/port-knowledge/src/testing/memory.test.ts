import {
  indexWriterContract,
  knowledgeAdapterContract,
  memoryEngine,
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

knowledgeAdapterContract('memory', seeded(memoryEngine(), false));

knowledgeAdapterContract('memory with vectors', seeded(memoryEngine({ vectors: true }), true));

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
