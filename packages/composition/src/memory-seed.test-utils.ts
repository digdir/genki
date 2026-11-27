import {
  matchAllQuery,
  type DatasetConfig,
  type FilterValue,
  type IndexDocument,
  type IndexWriterAdapter,
  type KnowledgeAdapter,
  type KnowledgeConnection,
} from '@genai/port-knowledge';
import { memoryEngine } from '@genai/port-knowledge/testing';

export const memoryTestEndpoint = 'memory-test';

export interface KnowledgeRead {
  op: 'search' | 'fetch' | 'range' | 'facets' | 'documents';
  dataset: string;
  filters?: Record<string, FilterValue>;
  query?: string;
  profile?: string;
  document?: string;
}

export const kudosDocument = (id = 'd1', chunks = ['c1', 'c2']): IndexDocument => ({
  id,
  title: 'Tildelingsbrev 2025',
  url: `https://kudos.dfo.no/dokument/${id}`,
  fields: {
    type: 'Tildelingsbrev',
    orgs_short: ['DIGDIR'],
    orgs_long: ['Digitaliseringsdirektoratet'],
    concerned_years: [2025],
  },
  chunks: chunks.map((chunk, position) => ({
    id: chunk,
    position,
    text: `Tildelingsbrevet for 2025 sier ${chunk}.`,
  })),
  phrases: chunks.map((chunk) => ({
    id: `${chunk}-p`,
    chunkId: chunk,
    text: `tildelingsbrev ${chunk}`,
  })),
});

export const publicDocsDocument = (): IndexDocument => ({
  id: 'w1',
  title: 'Om Digdir',
  url: 'https://www.digdir.no/om-oss',
  fields: {},
  chunks: [
    { id: 'w1-0', position: 0, text: 'Digdir er direktoratet for forvaltning og digitalisering.' },
  ],
  phrases: [],
});

export const defaultCorpus = (): Record<string, IndexDocument[]> => ({
  'digdir/kudos': [kudosDocument()],
  'digdir/public-docs': [publicDocsDocument()],
});

type Corpus = Record<string, IndexDocument[]>;

// Every query matches, so a test controls hits through filters alone; the corpus is read again on every call.
export const seededKnowledge = async (corpus: Corpus | (() => Corpus) = defaultCorpus()) => {
  const { adapter, writer } = memoryEngine();
  const current = typeof corpus === 'function' ? corpus : () => corpus;
  const reads: KnowledgeRead[] = [];
  const store = writer.connect({ engine: 'memory' } as never, {
    signal: new AbortController().signal,
  });
  const sync = async () => {
    for (const [id, docs] of Object.entries(current())) {
      const dataset = { id, filters: {}, options: {} } as DatasetConfig<never>;
      if (!(await store.active(dataset))) {
        await store.prepare(dataset, 'g1');
        await store.promote(dataset, 'g1');
      }
      for (const doc of docs) await store.store(dataset, 'g1', doc);
    }
  };
  await sync();
  const declaredChunks = (dataset: string) =>
    new Map((current()[dataset] ?? []).map((d) => [d.id, d.fields.total_chunks]));
  const recorded: KnowledgeAdapter = {
    ...(adapter as KnowledgeAdapter),
    connect: (endpoint) => {
      const inner = (adapter as KnowledgeAdapter).connect(endpoint);
      const documents = inner.documents?.bind(inner);
      const connection: KnowledgeConnection = {
        ...inner,
        search: async (dataset, requests, signal) => {
          await sync();
          for (const r of requests)
            reads.push({
              op: 'search',
              dataset: dataset.id,
              filters: r.filters ?? {},
              query: r.query,
              ...(r.profile ? { profile: r.profile } : {}),
            });
          return inner.search(
            dataset,
            requests.map((r) => ({ ...r, query: matchAllQuery })),
            signal,
          );
        },
        fetch: async (dataset, ids, signal) => {
          await sync();
          reads.push({ op: 'fetch', dataset: dataset.id });
          return inner.fetch(dataset, ids, signal);
        },
        range: async (dataset, document, from, to, signal) => {
          await sync();
          reads.push({ op: 'range', dataset: dataset.id, document });
          return inner.range(dataset, document, from, to, signal);
        },
        facets: async (dataset, fields, filters, signal) => {
          await sync();
          reads.push({ op: 'facets', dataset: dataset.id, filters });
          return inner.facets(dataset, fields, filters, signal);
        },
        ...(documents
          ? {
              documents: async (
                dataset: DatasetConfig,
                request: Parameters<typeof documents>[1],
                signal: AbortSignal,
              ) => {
                await sync();
                reads.push({
                  op: 'documents',
                  dataset: dataset.id,
                  filters: request.filters ?? {},
                });
                const page = await documents(dataset, request, signal);
                const declared = declaredChunks(dataset.id);
                return {
                  ...page,
                  documents: page.documents.map((d) =>
                    declared.get(d.id) === undefined
                      ? d
                      : { ...d, fields: { ...d.fields, total_chunks: declared.get(d.id) } },
                  ),
                };
              },
            }
          : {}),
      };
      return connection;
    },
  };
  return {
    engine: { adapter: recorded, writer: writer as IndexWriterAdapter },
    reads,
    searches: () => reads.filter((r) => r.op === 'search'),
  };
};

export const seedOnMemory = (seed: unknown): unknown => {
  const catalog = seed as { endpoints?: Record<string, unknown>; datasets?: { id: string }[] };
  const moved = new Set(['digdir/kudos', 'digdir/public-docs']);
  return {
    ...catalog,
    endpoints: { ...catalog.endpoints, [memoryTestEndpoint]: { engine: 'memory' } },
    datasets: (catalog.datasets ?? []).map((dataset) =>
      moved.has(dataset.id) ? { ...dataset, endpoint: memoryTestEndpoint, options: {} } : dataset,
    ),
  };
};
