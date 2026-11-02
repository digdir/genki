import {
  knowledgeProfiles,
  matchAllQuery,
  type DocumentSummary,
  type FilterValue,
  type Hit,
  type KnowledgePort,
} from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import type { RerankPort } from '@genai/port-rerank';
import { retrievalConfig } from './config.js';
import {
  callerFirst,
  toFilterMapFields,
  type FilterInput,
  type HeadlessFilterField,
} from './filters.js';
import {
  FacetCache,
  isUnsupported,
  retrieve,
  type PassTrace,
  type SkippedDocument,
} from './pipeline.js';
import { createPlanner } from './planner.js';
import type { Chunk } from './stages.js';
import {
  bestContentWindows,
  formatMetadataHeaders,
  metadataHeaders,
  truncateHeadTail,
} from './text.js';

export interface RetrievedSummary {
  chunkId: string;
  document?: string;
  position?: number;
  totalChunks?: number;
  contentLength?: number;
  title?: string;
  url?: string;
  headers?: string[];
  score?: number;
  rerankScore?: number;
  rank?: number;
  version?: string;
  publishedAt?: string;
}

export interface RetrievedChunk extends RetrievedSummary {
  content: string;
}

export interface RetrievalAttribution {
  phrase?: number;
  metadata?: number;
  content?: number;
  autoFilter?: { field: string; options: string[] };
  autoFilterFallback?: boolean;
  rerankEnabled?: boolean;
  rerankMs?: number;
  rerankError?: string;
  callerFilter?: HeadlessFilterField[];
  warnings?: string[];
  skipped?: SkippedDocument[];
}

export interface FilterSelection {
  field: string;
  selectedOptions: string[];
  valueType?: 'string' | 'integer';
}

export interface Turn {
  role: 'user' | 'assistant';
  text: string;
}

export type Planner = (
  query: string,
  history: Turn[],
  signal: AbortSignal,
) => Promise<{ queries: string[]; userIntent?: string }>;

export interface RetrievalFactoryOptions {
  knowledge: KnowledgePort;
  rerank?: RerankPort;
  model?: ModelPort;
  config?: unknown;
  plan?: Planner;
  planner?: unknown;
  valueTypes?: Record<string, 'string' | 'integer'>;
  rerankTopK?: number;
  facetCache?: FacetCache;
  now?: () => number;
  filters?: Record<string, FilterInput>;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

const joined = (fields: Record<string, unknown>, name: string): unknown => {
  if (name in fields) return fields[name];
  for (const value of Object.values(fields))
    if (value && typeof value === 'object' && !Array.isArray(value) && name in value)
      return (value as Record<string, unknown>)[name];
  return undefined;
};

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const isoDate = (value: unknown): string | undefined => {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0)
    return new Date(value < 1e11 ? value * 1000 : value).toISOString();
  if (typeof value !== 'string' || !value.trim()) return undefined;
  return Number.isNaN(Date.parse(value)) ? undefined : value.trim();
};

const publishedAtOf = (fields: Record<string, unknown>) =>
  ['publish_date', 'published_at', 'publishedAt', 'ingested_at']
    .map((name) => isoDate(joined(fields, name)))
    .find((v) => v !== undefined);

const versionOf = (fields: Record<string, unknown>) => {
  const value = joined(fields, 'document_version') ?? joined(fields, 'version');
  return typeof value === 'string' && value.trim()
    ? value.trim()
    : typeof value === 'number' && Number.isFinite(value)
      ? String(value)
      : undefined;
};

const describe = (
  id: string,
  base: {
    document?: string;
    position?: number;
    title?: string;
    url?: string;
    fields: Record<string, unknown>;
  },
): RetrievedSummary => {
  const headers = metadataHeaders(base.fields.metadata);
  return {
    chunkId: id,
    ...optional('document', base.document),
    ...optional('position', base.position),
    ...optional('totalChunks', num(joined(base.fields, 'total_chunks'))),
    ...optional('contentLength', num(base.fields.content_length)),
    ...optional('title', base.title),
    ...optional('url', base.url),
    ...(headers.length > 0 ? { headers } : {}),
    ...optional('version', versionOf(base.fields)),
    ...optional('publishedAt', publishedAtOf(base.fields)),
  };
};

const summarize = (c: Chunk): RetrievedSummary => ({
  ...describe(c.id, c),
  ...optional('score', c.retrievalPrior),
  ...optional('rerankScore', c.rerankScore),
  rank: c.originalRank,
});

const fromHit = (h: Hit): RetrievedChunk => ({ ...describe(h.id, h), content: h.text });

const attributionOf = (
  trace: PassTrace,
  caller?: Record<string, FilterInput>,
): RetrievalAttribution => {
  const detected = Object.entries(trace.detectedFilter ?? {})[0];
  const options = (v: FilterInput): string[] => {
    if (Array.isArray(v)) return v.map(String);
    if (typeof v !== 'object') return [String(v)];
    if ('all' in v) return v.all.flatMap(options);
    if ('contains' in v) return v.contains;
    if ('not' in v) return v.not.map(String);
    return [];
  };
  return {
    ...optional('phrase', trace.hitsPerStrategy.phrase),
    ...optional('metadata', trace.hitsPerStrategy.metadata),
    ...optional('content', trace.hitsPerStrategy.content),
    ...(detected ? { autoFilter: { field: detected[0], options: options(detected[1]) } } : {}),
    ...(trace.autoFilterFallback ? { autoFilterFallback: true } : {}),
    ...(trace.rerank.status === 'off' ? {} : { rerankEnabled: true, rerankMs: trace.rerank.ms }),
    ...optional('rerankError', trace.rerank.error),
    ...(caller ? { callerFilter: toFilterMapFields(caller) } : {}),
    ...(trace.warnings.length > 0 ? { warnings: trace.warnings } : {}),
    ...(trace.skipped?.length ? { skipped: trace.skipped } : {}),
  };
};

const toFilters = (
  selections: FilterSelection[] | undefined,
): Record<string, FilterValue> | undefined => {
  const entries = (selections ?? [])
    .filter((s) => s.selectedOptions.length > 0)
    .map((s): [string, FilterValue] => [
      s.field,
      s.valueType === 'integer' ? s.selectedOptions.map(Number) : s.selectedOptions,
    ]);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
};

const kindName: Record<string, string> = { text: 'contains' };

export const createRetrievalBackend = (options: RetrievalFactoryOptions) => {
  const config = retrievalConfig.parse(options.config ?? {});
  const facetCache = options.facetCache ?? new FacetCache();
  const metadata = new Map<string, unknown>();
  const remember = (id: string, fields: Record<string, unknown>) => {
    if (fields.metadata !== undefined) metadata.set(id, fields.metadata);
  };
  const run = async (
    queries: string[],
    userIntent: string | undefined,
    filters: Record<string, FilterInput> | undefined,
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const result = await retrieve({
      knowledge: options.knowledge,
      ...optional('rerank', options.rerank),
      ...optional('model', options.model),
      queries,
      ...optional('userIntent', userIntent),
      ...optional('filters', callerFirst(options.filters, filters)),
      config,
      facetCache,
      ...optional('now', options.now),
    });
    for (const c of result.chunks) remember(c.id, c.fields);
    return result;
  };
  const read = async (ids: string[], signal: AbortSignal) => {
    signal.throwIfAborted();
    const hits = await options.knowledge.fetch(ids);
    for (const h of hits) remember(h.id, h.fields);
    return hits.map(fromHit);
  };

  return {
    run,
    read,
    plan:
      options.plan ??
      (options.model
        ? createPlanner({
            model: options.model,
            knowledge: options.knowledge,
            config: options.planner,
          })
        : async (query: string) => ({ queries: [query] })),
    readRange: async (document: string, from: number, to: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      const hits = await options.knowledge.range(document, from, to);
      for (const h of hits) remember(h.id, h.fields);
      return hits.map(fromHit);
    },
    rerank: async <C extends RetrievedChunk>(
      query: string,
      chunks: C[],
      signal: AbortSignal,
    ): Promise<C[]> => {
      signal.throwIfAborted();
      if (!options.rerank || chunks.length === 0) return chunks;
      const candidates = chunks.slice(0, options.rerankTopK ?? 100);
      const documents = candidates.map((c) => {
        const headers = formatMetadataHeaders(metadata.get(c.chunkId));
        const prefix = `${c.title === undefined ? '' : `Title: ${c.title}\n\n`}${headers ?? ''}`;
        return config.rerank.windowing
          ? prefix +
              bestContentWindows(
                c.content,
                query,
                Math.max(200, config.rerank.maxChunkLength - prefix.length),
              )
          : truncateHeadTail(prefix + c.content, config.rerank.maxChunkLength);
      });
      const response = await options.rerank.rerank({ query, documents });
      if (response.degraded || response.ranking.length === 0) return chunks;
      return response.ranking.flatMap((r) => {
        const c = candidates[r.index];
        return c ? [{ ...c, rerankScore: r.score }] : [];
      });
    },
    attribution: (trace: PassTrace) => attributionOf(trace, options.filters),
    summarize,
    toFilters,
    fromHit,
  };
};

const searchRerankByDefault = (raw: unknown, rerank: RerankPort | undefined): unknown => {
  const config = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const settings =
    config.rerank && typeof config.rerank === 'object'
      ? (config.rerank as Record<string, unknown>)
      : {};
  if (!rerank || settings.enabled !== undefined) return raw;
  return { ...config, rerank: { ...settings, enabled: true } };
};

export const createAgentRetrieval = (options: RetrievalFactoryOptions) => {
  const backend = createRetrievalBackend({
    ...options,
    config: searchRerankByDefault(options.config, options.rerank),
  });
  return {
    search: async (
      queries: string[],
      opts: { filters?: FilterSelection[]; userIntent?: string },
      signal: AbortSignal,
    ): Promise<{ chunks: RetrievedSummary[]; attribution?: RetrievalAttribution }> => {
      const result = await backend.run(
        queries,
        opts.userIntent,
        backend.toFilters(opts.filters),
        signal,
      );
      return {
        chunks: result.chunks.map(backend.summarize),
        attribution: backend.attribution(result.trace.expansion),
      };
    },
    read: backend.read,
    readRange: backend.readRange,
    plan: backend.plan,
    rerank: backend.rerank,
    filterFields: async (signal: AbortSignal) => {
      signal.throwIfAborted();
      return Object.entries(options.knowledge.info().filters).map(([field, declared]) => {
        const kind = (Array.isArray(declared) ? declared[0] : declared) ?? 'select';
        return {
          field,
          type: kindName[kind] ?? kind,
          valueType: options.valueTypes?.[field] ?? ('string' as const),
        };
      });
    },
    facets: async (fields: string[], maxOptions: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      const declared = options.knowledge.info().filters;
      const known = fields.filter((f) => f in declared);
      if (known.length === 0) return {};
      const values = await options.knowledge.facets(known);
      return Object.fromEntries(
        Object.entries(values).map(([f, list]) => [f, list.slice(0, maxOptions)]),
      );
    },
  };
};

const readTolerant = async (
  read: (ids: string[], signal: AbortSignal) => Promise<RetrievedChunk[]>,
  ids: string[],
  signal: AbortSignal,
) => {
  try {
    return await read(ids, signal);
  } catch (error) {
    if (isUnsupported(error)) return [];
    throw error;
  }
};

export interface ListedDocument {
  id: string;
  title?: string;
  url?: string;
  publishedAt?: string;
  fields: Record<string, unknown>;
}

export interface DocumentQuery {
  ids?: string[];
  filters?: Record<string, FilterInput>;
  limit: number;
}

const listedFrom = (hit: Hit, id = hit.document ?? hit.id): ListedDocument => ({
  id,
  ...optional('title', hit.title),
  ...optional('url', hit.url),
  ...optional('publishedAt', publishedAtOf(hit.fields)),
  fields: hit.fields,
});

const documentPage = 250;
const rangeWindow = 50;

const inBatches = async <T, R>(items: T[], size: number, map: (item: T) => Promise<R>) => {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size)
    out.push(...(await Promise.all(items.slice(i, i + size).map(map))));
  return out;
};

export const listDocuments = async (
  knowledge: KnowledgePort,
  query: DocumentQuery,
  caller: Record<string, FilterInput> | undefined,
  signal: AbortSignal,
): Promise<ListedDocument[]> => {
  signal.throwIfAborted();
  const filters = callerFirst(caller, query.filters);
  const ids = query.ids?.length ? [...new Set(query.ids)].slice(0, query.limit) : undefined;
  if (knowledge.documents) {
    const listed: DocumentSummary[] = [];
    while (listed.length < query.limit) {
      const want = Math.min(documentPage, query.limit - listed.length);
      const page = await knowledge.documents({
        ...optional('ids', ids),
        ...optional('filters', filters),
        limit: want,
        offset: listed.length,
      });
      listed.push(...page.documents);
      if (page.documents.length < want) break;
    }
    return listed.map((d) => ({
      id: d.id,
      ...optional('title', d.title),
      ...optional('url', d.url),
      ...optional('publishedAt', publishedAtOf(d.fields)),
      fields: d.fields,
    }));
  }
  if (ids) {
    const firsts = await inBatches(ids, 10, async (id) => (await knowledge.range(id, 0, 0))[0]);
    return firsts.flatMap((hit, i) => (hit ? [listedFrom(hit, ids[i])] : []));
  }
  const profiles = knowledge.info().profiles;
  const profile = [knowledgeProfiles.docTitle, knowledgeProfiles.metadata].find((p) =>
    profiles.includes(p),
  );
  if (!profile) throw new Error('the dataset has no profile that lists documents');
  const result = await knowledge.search({
    query: matchAllQuery,
    profile,
    ...optional('filters', filters),
    limit: query.limit,
  });
  const seen = new Set<string>();
  return result.hits.flatMap((hit) => {
    const doc = listedFrom(hit);
    if (seen.has(doc.id)) return [];
    seen.add(doc.id);
    return [doc];
  });
};

export const createRagRetrieval = (options: RetrievalFactoryOptions) => {
  const backend = createRetrievalBackend(options);
  return {
    plan: backend.plan,
    rerank: backend.rerank,
    facets: async (fields: string[], maxValues: number, signal: AbortSignal) => {
      signal.throwIfAborted();
      if (!Number.isInteger(maxValues) || maxValues < 1 || maxValues > 1000)
        throw new Error('facets maxValues must be an integer from 1 to 1000');
      if (fields.length < 1 || fields.length > 20)
        throw new Error('facets needs between 1 and 20 fields');
      const declared = options.knowledge.info().filters;
      for (const field of fields)
        if (!Object.hasOwn(declared, field))
          throw new Error(`the service datasets have no filter field ${field}`);
      const requested = [...new Set(fields)];
      const values = await options.knowledge.facets(requested, options.filters);
      signal.throwIfAborted();
      return Object.fromEntries(
        requested.map((field) => [field, (values[field] ?? []).slice(0, maxValues)]),
      );
    },
    documents: (query: DocumentQuery, signal: AbortSignal) =>
      listDocuments(options.knowledge, query, options.filters, signal),
    readDocument: async (document: string, maxChunks: number, signal: AbortSignal) => {
      const chunks: RetrievedChunk[] = [];
      for (let from = 0; from < maxChunks; from += rangeWindow) {
        const to = Math.min(from + rangeWindow, maxChunks) - 1;
        const window = await backend.readRange(document, from, to, signal);
        chunks.push(...window);
        if (window.length < to - from + 1) break;
      }
      return chunks;
    },
    retrieve: async (
      queries: string[],
      opts: { userIntent?: string; filters?: Record<string, FilterInput> },
      signal: AbortSignal,
    ): Promise<{ chunks: RetrievedChunk[]; attribution?: RetrievalAttribution }> => {
      const result = await backend.run(queries, opts.userIntent, opts.filters, signal);
      const missing = result.chunks.filter((c) => c.text === undefined).map((c) => c.id);
      const read = missing.length > 0 ? await readTolerant(backend.read, missing, signal) : [];
      const fetched = new Map(read.map((c) => [c.chunkId, c.content]));
      return {
        chunks: result.chunks.map((c) => ({
          ...backend.summarize(c),
          content: c.text ?? fetched.get(c.id) ?? '',
        })),
        attribution: backend.attribution(result.trace.expansion),
      };
    },
  };
};
