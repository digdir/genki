import { z } from 'zod';
import {
  localKnowledgeAdapter,
  type DatasetConfig,
  type KnowledgeAdapter,
  type KnowledgeConnection,
} from '../adapter.js';
import {
  KnowledgeError,
  kindsOf,
  knowledgeCapabilities,
  knowledgeProfiles,
  matchAllQuery,
  type FacetValue,
  type FilterClause,
  type FilterValue,
  type Hit,
  type KnowledgeCapability,
  type SearchRequest,
  type SearchResult,
} from '../port.js';
import { clauseFits } from '../router.js';
import type { IndexDocument, IndexWriter, IndexWriterAdapter } from '../writer.js';
import { fixtureVector } from './corpus.js';

const profile = z.strictObject({
  mode: z.enum(['text', 'vector', 'hybrid']),
  over: z.enum(['chunks', 'phrases', 'documents', 'titles']),
});

const datasetOptions = z.strictObject({
  index: z.string().min(1).optional(),
  profiles: z.record(z.string(), profile).optional(),
});

export type MemoryDatasetOptions = z.infer<typeof datasetOptions>;
type Profile = z.infer<typeof profile>;
type Dataset = DatasetConfig<MemoryDatasetOptions>;

export interface MemoryEngineOptions {
  engine?: string;
  capabilities?: KnowledgeCapability[];
  embed?: (text: string, dimensions: number) => number[];
  maxQueryLength?: number;
  vectors?: boolean;
}

interface Index {
  active?: string;
  generations: Map<string, Map<string, IndexDocument>>;
}

const tokens = (text: string): string[] => text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const cosine = (a: number[], b: number[]) => {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
    na += (a[i] ?? 0) ** 2;
    nb += (b[i] ?? 0) ** 2;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
};

const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [value]);

const clauseMatches = (kind: string, value: unknown, clause: FilterClause): boolean => {
  const values = asList(value);
  if (typeof clause === 'boolean') return value === clause;
  if (Array.isArray(clause)) return values.some((v) => (clause as unknown[]).includes(v));
  if (typeof clause !== 'object') {
    if (kind === 'text')
      return values.some((v) => tokens(String(v)).includes(String(clause).toLowerCase()));
    return values.includes(clause);
  }
  if ('not' in clause) return !values.some((v) => (clause.not as unknown[]).includes(v));
  if ('contains' in clause)
    return clause.contains.some((term) =>
      values.some((v) => tokens(String(v)).includes(term.toLowerCase())),
    );
  return values.some(
    (v) =>
      (clause.gte === undefined || (v as number | string) >= clause.gte) &&
      (clause.lte === undefined || (v as number | string) <= clause.lte),
  );
};

const matches = (dataset: Dataset, doc: IndexDocument, filters: Record<string, FilterValue>) =>
  Object.entries(filters).every(([field, value]) => {
    const clauses =
      typeof value === 'object' && value !== null && !Array.isArray(value) && 'all' in value
        ? value.all
        : [value];
    const kinds = kindsOf(dataset.filters[field] ?? 'select');
    return clauses.every((clause) => {
      const kind = kinds.find((k) => clauseFits(k, clause)) ?? 'select';
      return clauseMatches(kind, doc.fields[field], clause);
    });
  });

const hitOf = (doc: IndexDocument, chunk: IndexDocument['chunks'][number], score: number): Hit => ({
  id: chunk.id,
  score,
  text: chunk.text,
  ...(doc.title !== undefined ? { title: doc.title } : {}),
  ...(doc.url !== undefined ? { url: doc.url } : {}),
  document: doc.id,
  position: chunk.position,
  fields: { ...doc.fields, ...chunk.metadata },
});

const failIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
};

export const memoryEngine = (options: MemoryEngineOptions = {}) => {
  const indexes = new Map<string, Index>();
  const embed = options.embed ?? fixtureVector;
  const keyOf = (dataset: Dataset) => dataset.options.index ?? dataset.id;
  const indexOf = (dataset: Dataset) => {
    const key = keyOf(dataset);
    const found: Index = indexes.get(key) ?? { generations: new Map() };
    indexes.set(key, found);
    return found;
  };
  const activeDocs = (dataset: Dataset) => {
    const index = indexOf(dataset);
    const docs = index.active ? index.generations.get(index.active) : undefined;
    return [...(docs?.values() ?? [])];
  };

  const capabilitiesOf = (dataset: Dataset): KnowledgeCapability[] => {
    const all = knowledgeCapabilities.filter(
      (c) => dataset.embedding || (c !== 'search.vector' && c !== 'search.hybrid'),
    );
    return options.capabilities ? all.filter((c) => options.capabilities?.includes(c)) : all;
  };

  const defaultProfiles = (vectors: boolean): Record<string, Profile> => ({
    [knowledgeProfiles.content]: { mode: 'text', over: 'chunks' },
    [knowledgeProfiles.phrase]: { mode: 'text', over: 'phrases' },
    [knowledgeProfiles.metadata]: { mode: 'text', over: 'documents' },
    [knowledgeProfiles.docTitle]: { mode: 'text', over: 'titles' },
    ...(vectors
      ? {
          vector: { mode: 'vector', over: 'chunks' } as Profile,
          hybrid: { mode: 'hybrid', over: 'chunks' } as Profile,
        }
      : {}),
  });

  const profilesOf = (dataset: Dataset) => {
    const declared = new Set(capabilitiesOf(dataset));
    return Object.entries(
      dataset.options.profiles ?? defaultProfiles(dataset.embedding !== undefined),
    ).filter(([, p]) => declared.has(`search.${p.mode}`));
  };

  const rank = (
    dataset: Dataset,
    docs: IndexDocument[],
    p: Profile,
    query: string,
  ): { doc: IndexDocument; chunk: IndexDocument['chunks'][number]; score: number }[] => {
    const wanted = new Set(tokens(query));
    const textScore = (text: string) =>
      query.trim() === matchAllQuery ? 1 : tokens(text).filter((t) => wanted.has(t)).length;
    const queryVector = p.mode === 'text' ? [] : embed(query, dataset.embedding?.dimensions ?? 16);
    const scoreOf = (text: string, vector: number[] | undefined) =>
      p.mode === 'text' ? textScore(text) : vector ? cosine(queryVector, vector) : 0;
    const candidates = docs.flatMap((doc) => {
      const first = [...doc.chunks].sort((a, b) => a.position - b.position)[0];
      if (p.over === 'chunks')
        return doc.chunks.map((chunk) => ({
          doc,
          chunk,
          text: textScore(chunk.text),
          vector: chunk.vector ? cosine(queryVector, chunk.vector) : 0,
          score: scoreOf(chunk.text, chunk.vector),
        }));
      if (p.over === 'phrases')
        return doc.phrases.flatMap((phrase) => {
          const chunk = doc.chunks.find((c) => c.id === phrase.chunkId);
          return chunk
            ? [
                {
                  doc,
                  chunk,
                  text: textScore(phrase.text),
                  vector: phrase.vector ? cosine(queryVector, phrase.vector) : 0,
                  score: scoreOf(phrase.text, phrase.vector),
                },
              ]
            : [];
        });
      if (!first) return [];
      const text =
        p.over === 'titles'
          ? (doc.title ?? '')
          : [doc.title ?? '', ...Object.values(doc.fields).flatMap(asList).map(String)].join(' ');
      const score = textScore(text);
      return [{ doc, chunk: first, text: score, vector: 0, score }];
    });
    const best = new Map<string, (typeof candidates)[number]>();
    for (const c of candidates) {
      const known = best.get(c.chunk.id);
      if (!known || c.score > known.score) best.set(c.chunk.id, c);
    }
    const unique = [...best.values()];
    if (p.mode !== 'hybrid')
      return unique
        .filter((c) => c.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(({ doc, chunk, score }) => ({ doc, chunk, score }));
    const byText = [...unique].filter((c) => c.text > 0).sort((a, b) => b.text - a.text);
    const byVector = [...unique].filter((c) => c.vector > 0).sort((a, b) => b.vector - a.vector);
    const fused = new Map<string, number>();
    for (const list of [byText, byVector])
      list.forEach((c, i) => fused.set(c.chunk.id, (fused.get(c.chunk.id) ?? 0) + 1 / (60 + i)));
    return unique
      .filter((c) => fused.has(c.chunk.id))
      .map(({ doc, chunk }) => ({ doc, chunk, score: fused.get(chunk.id) ?? 0 }))
      .sort((a, b) => b.score - a.score);
  };

  const connection: KnowledgeConnection<MemoryDatasetOptions> = {
    profiles: (dataset) => profilesOf(dataset).map(([name]) => name),
    search: async (dataset, requests: SearchRequest[], signal) => {
      failIfAborted(signal);
      const profiles = new Map(profilesOf(dataset));
      return requests.map((r): SearchResult => {
        const p = profiles.get(r.profile ?? '');
        if (!p)
          throw new KnowledgeError(
            'bad_request',
            `dataset ${dataset.id} has no search profile ${r.profile}`,
          );
        if (r.query.length > (options.maxQueryLength ?? 1000))
          return { hits: [], warning: 'the query is too long' };
        const docs = activeDocs(dataset).filter((d) => matches(dataset, d, r.filters ?? {}));
        const ranked = rank(dataset, docs, p, r.query);
        return {
          hits: ranked.slice(0, r.limit ?? 10).map((c) => hitOf(c.doc, c.chunk, c.score)),
          found: ranked.length,
        };
      });
    },
    fetch: async (dataset, ids, signal) => {
      failIfAborted(signal);
      const all = new Map(
        activeDocs(dataset).flatMap((doc) => doc.chunks.map((c) => [c.id, hitOf(doc, c, 0)])),
      );
      return ids.flatMap((id) => all.get(id) ?? []);
    },
    range: async (dataset, document, from, to, signal) => {
      failIfAborted(signal);
      const doc = activeDocs(dataset).find((d) => d.id === document);
      if (!doc) return [];
      return doc.chunks
        .filter((c) => c.position >= from && c.position <= to)
        .sort((a, b) => a.position - b.position)
        .map((c) => hitOf(doc, c, 0));
    },
    facets: async (dataset, fields, filters, signal) => {
      failIfAborted(signal);
      const docs = activeDocs(dataset).filter((d) => matches(dataset, d, filters));
      return Object.fromEntries(
        fields.map((field): [string, FacetValue[]] => {
          const counts = new Map<string, number>();
          for (const doc of docs)
            for (const v of asList(doc.fields[field]))
              if (v !== undefined && v !== null)
                counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
          return [
            field,
            [...counts]
              .map(([value, count]) => ({ value, count }))
              .sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)),
          ];
        }),
      );
    },
    documents: async (dataset, request, signal) => {
      failIfAborted(signal);
      const ids = request.ids ? new Set(request.ids) : undefined;
      const docs = activeDocs(dataset)
        .filter((d) => (!ids || ids.has(d.id)) && matches(dataset, d, request.filters ?? {}))
        .sort((a, b) => a.id.localeCompare(b.id));
      const offset = request.offset ?? 0;
      return {
        documents: docs.slice(offset, offset + (request.limit ?? 100)).map((d) => ({
          id: d.id,
          ...(d.title !== undefined ? { title: d.title } : {}),
          ...(d.url !== undefined ? { url: d.url } : {}),
          fields: { ...d.fields, total_chunks: d.chunks.length },
        })),
        found: docs.length,
      };
    },
  };

  const adapter: KnowledgeAdapter<
    Record<string, never>,
    MemoryDatasetOptions
  > = localKnowledgeAdapter({
    engine: options.engine ?? 'memory',
    endpointOptions: z.strictObject({}),
    datasetOptions,
    capabilities: capabilitiesOf,
    defaults: (draft) =>
      draft.options.profiles ? {} : { profiles: defaultProfiles(draft.embedding !== undefined) },
    connect: () => connection,
    probe: async () => undefined,
  });

  const generationOf = (dataset: Dataset, generation: string) => {
    const docs = indexOf(dataset).generations.get(generation);
    if (!docs) throw new KnowledgeError('bad_request', `generation ${generation} is not prepared`);
    return docs;
  };

  const writer: IndexWriter<MemoryDatasetOptions> = {
    prepare: async (dataset, generation) => {
      const index = indexOf(dataset);
      if (!index.generations.has(generation)) index.generations.set(generation, new Map());
    },
    store: async (dataset, generation, doc) => {
      generationOf(dataset, generation).set(doc.id, structuredClone(doc));
    },
    promote: async (dataset, generation) => {
      generationOf(dataset, generation);
      const index = indexOf(dataset);
      const previous = index.active;
      index.active = generation;
      return previous;
    },
    drop: async (dataset, generation, options = {}) => {
      const index = indexOf(dataset);
      if (index.active === generation) {
        if (!options.force)
          throw new KnowledgeError('bad_request', `generation ${generation} is active`);
        delete index.active;
      }
      index.generations.delete(generation);
    },
    active: async (dataset) => indexOf(dataset).active,
    stats: async (dataset, generation) => {
      const docs = [...generationOf(dataset, generation).values()];
      return {
        documents: docs.length,
        chunks: docs.reduce((n, d) => n + d.chunks.length, 0),
        phrases: docs.reduce((n, d) => n + d.phrases.length, 0),
      };
    },
    async *read(dataset, generation) {
      const chosen = generation ?? indexOf(dataset).active;
      if (chosen === undefined) return;
      for (const doc of [...generationOf(dataset, chosen).values()]) yield structuredClone(doc);
    },
  };

  const indexWriter: IndexWriterAdapter<Record<string, never>, MemoryDatasetOptions> = {
    engine: options.engine ?? 'memory',
    needs: { vectors: options.vectors ?? false },
    endpointOptions: z.strictObject({}),
    datasetOptions,
    connect: () => writer,
  };

  return { adapter, writer: indexWriter };
};
