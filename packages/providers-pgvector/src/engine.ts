import {
  KnowledgeError,
  filterKinds,
  knowledgeProfiles,
  localKnowledgeAdapter,
  type DatasetConfig,
  type DatasetDraft,
  type IndexWriterAdapter,
  type KnowledgeAdapter,
  type KnowledgeCapability,
  type KnowledgeConnection,
  type SearchRequest,
  type SearchResult,
} from '@genai/port-knowledge';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Profile } from './sql.js';
import { searchHybrid, textSearchMs, type SearchOne } from './hybrid.js';
import { knowledgeWriterOf } from './knowledge-writer.js';
import { knowledgeReads } from './knowledge-reads.js';
import { migrateKnowledgeServer, syncFilterIndexes } from './partitions.js';

const profile = z
  .strictObject({
    target: z
      .enum(['chunks', 'phrases', 'docs'])
      .meta({ enumTitles: ['Tekstbiter', 'Søkefraser', 'Dokumenter'] }),
    mode: z
      .enum(['text', 'vector', 'hybrid'])
      .meta({ enumTitles: ['Ordsøk', 'Betydningssøk', 'Kombinert søk'] }),
    fields: z.array(z.string().min(1)).min(1).optional(),
  })
  .refine((p) => (p.target === 'docs' ? p.mode === 'text' : p.fields === undefined), {
    message: 'docs profiles search text and may name fields; chunk and phrase profiles take none',
  });

export const pgvectorDatasetOptions = z.strictObject({
  textSearchConfig: z
    .string()
    .regex(/^[a-z_][a-z0-9_]*$/)
    .optional(),
  rrfK: z.number().int().positive().optional(),
  profiles: z.record(z.string().min(1), profile).optional(),
});

/** pgvector runs only on the knowledge server; `platform`, the shared tables, went with issue 151. */
export const pgvectorEndpointOptions = z.strictObject({
  connection: z
    .enum(['knowledge'], {
      error:
        'pgvector runs on the knowledge server; the platform database and external connections are not accepted',
    })
    .meta({ enumTitles: ['Kunnskapsserveren'] })
    .default('knowledge'),
});

const noKnowledgeServer = 'no knowledge server configured';

export type PgvectorDatasetOptions = z.infer<typeof pgvectorDatasetOptions>;
export type PgvectorEndpointOptions = z.infer<typeof pgvectorEndpointOptions>;
export type PgvectorProfile = z.infer<typeof profile>;

export interface QueryEmbedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface KnowledgePools {
  /** The read pool on `KNOWLEDGE_READ_PGHOST`, as the reader; reads fall back to `reader` on the primary. */
  read?: Pool;
  reader?: Pool;
  writer?: Pool;
  owner?: Pool;
}

export interface PgvectorEngineOptions {
  knowledge?: KnowledgePools;
  knowledgeGuard?: () => void;
  embedder?: (dataset: DatasetConfig) => QueryEmbedder;
  maxQueryLength?: number;
  /** How long a hybrid search's text half may run; `textSearchMs` unless a test shortens it. */
  textSearchMs?: number;
  /** The knowledge server's migrations ran at this process's first knowledge use, in `ms`. */
  onServerMigrated?: (ms: number) => void;
}

export interface PgvectorEngine {
  adapter: KnowledgeAdapter<PgvectorEndpointOptions, PgvectorDatasetOptions>;
  writer: IndexWriterAdapter<PgvectorEndpointOptions, PgvectorDatasetOptions>;
  /** Brings the filter indexes of datasets on the knowledge server in line with the catalog. */
  followCatalog(datasets: DatasetConfig[]): Promise<void>;
}

type Dataset = DatasetConfig<PgvectorDatasetOptions>;

export const pgvectorEngineName = 'pgvector';

const defaultConfig = 'norwegian';
const defaultRrfK = 60;

export const defaultPgvectorProfiles = (vectors: boolean): Record<string, PgvectorProfile> => {
  const mode = vectors ? 'hybrid' : 'text';
  return {
    [knowledgeProfiles.content]: { target: 'chunks', mode },
    [knowledgeProfiles.metadata]: { target: 'docs', mode: 'text' },
    [knowledgeProfiles.phrase]: { target: 'phrases', mode },
    [knowledgeProfiles.docTitle]: { target: 'docs', mode: 'text', fields: ['title'] },
  };
};

const failIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
};

export const pgvectorEngine = (options: PgvectorEngineOptions = {}): PgvectorEngine => {
  const capabilities = (dataset: Dataset): KnowledgeCapability[] => [
    'search.text',
    ...(dataset.embedding && options.embedder ? (['search.vector', 'search.hybrid'] as const) : []),
    'fetch',
    'range',
    'facets',
    ...filterKinds.map((k) => `filter.${k}` as const),
  ];

  const profilesOf = (dataset: Dataset): [string, Profile][] => {
    const declared = new Set(capabilities(dataset));
    return Object.entries(
      dataset.options.profiles ?? defaultPgvectorProfiles(declared.has('search.hybrid')),
    ).filter(([, p]) => declared.has(`search.${p.mode}`));
  };

  const queryVectors = async (dataset: Dataset, queries: string[]) => {
    if (queries.length === 0 || !options.embedder) return [];
    const vectors = await options.embedder(dataset).embed(queries);
    const dims = dataset.embedding?.dimensions;
    if (vectors.length !== queries.length || vectors.some((v) => v.length !== dims))
      throw new Error(
        `the embedder did not return ${queries.length} vectors of ${dims} dimensions`,
      );
    return vectors;
  };

  /** Embeds the queries that need a vector once, runs each search, and turns a failed one into a warning. */
  const searchBatch = async (
    dataset: Dataset,
    requests: SearchRequest[],
    signal: AbortSignal,
    one: SearchOne,
  ): Promise<SearchResult[]> => {
    const profiles = new Map(profilesOf(dataset));
    const planned = requests.map((request) => {
      const p = profiles.get(request.profile ?? '');
      if (!p)
        throw new KnowledgeError(
          'bad_request',
          `dataset ${dataset.id} has no search profile ${request.profile}`,
        );
      const tooLong = request.query.length > (options.maxQueryLength ?? 2000);
      return { request, p, tooLong, wantsVector: !tooLong && p.mode !== 'text' };
    });
    const wanting = planned.filter((x) => x.wantsVector);
    let vectors: number[][] = [];
    let embedWarning: string | undefined;
    try {
      vectors = await queryVectors(
        dataset,
        wanting.map((x) => x.request.query),
      );
    } catch (error) {
      failIfAborted(signal);
      embedWarning = `vector search is unavailable: ${error instanceof Error ? error.message : String(error)}`;
    }
    const vectorOf = new Map(wanting.map((x, i) => [x, vectors[i]]));
    const settled = await Promise.allSettled(
      planned.map(async (x): Promise<SearchResult> => {
        if (x.tooLong) return { hits: [], warning: 'the query is too long' };
        failIfAborted(signal);
        const vector = vectorOf.get(x);
        const warning = x.wantsVector ? embedWarning : undefined;
        if (x.p.mode === 'vector' && vector === undefined)
          return { hits: [], warning: warning ?? 'no query vector' };
        const result =
          x.p.mode !== 'hybrid'
            ? await one(x.p, x.request, vector)
            : vector === undefined
              ? // Without its vector half, a hybrid profile searches text as a text profile does.
                await one({ ...x.p, mode: 'text' }, x.request, undefined)
              : await searchHybrid(
                  one,
                  x.p,
                  x.request,
                  vector,
                  dataset.options.rrfK ?? defaultRrfK,
                  options.textSearchMs ?? textSearchMs,
                );
        return warning === undefined ? result : { ...result, warning };
      }),
    );
    failIfAborted(signal);
    if (settled.every((s) => s.status === 'rejected')) throw settled[0]?.reason;
    return settled.map((s) =>
      s.status === 'fulfilled'
        ? s.value
        : {
            hits: [],
            warning: s.reason instanceof Error ? s.reason.message : String(s.reason),
          },
    );
  };

  const knowledgePool = (() => {
    const { reader, writer, owner } = options.knowledge ?? {};
    return reader ?? writer ?? owner;
  })();
  const endpointOptions = knowledgePool
    ? pgvectorEndpointOptions
    : pgvectorEndpointOptions.refine(() => false, {
        message: noKnowledgeServer,
        path: ['connection'],
      });
  const requireKnowledgeServer = () => {
    if (!knowledgePool) throw new KnowledgeError('unavailable', noKnowledgeServer);
  };
  const readerPool = options.knowledge?.reader ?? options.knowledge?.read;
  const knowledgeConnection = (timeoutMs: number): KnowledgeConnection<PgvectorDatasetOptions> => {
    const profiles = (dataset: Dataset) => profilesOf(dataset).map(([name]) => name);
    if (!readerPool) {
      // The worker has no reader login; a router there still connects every endpoint it loads.
      const unread = async (): Promise<never> => {
        throw new KnowledgeError('unavailable', 'knowledge data is read by the API, as the reader');
      };
      return { profiles, search: unread, fetch: unread, range: unread, facets: unread };
    }
    const reads = knowledgeReads<PgvectorDatasetOptions>({
      read: options.knowledge?.read,
      primary: readerPool,
      timeoutMs,
      profilesOf,
      rrfK: (dataset) => dataset.options.rrfK ?? defaultRrfK,
      searchBatch,
    });
    return { ...reads, profiles };
  };
  const owner = options.knowledge?.owner;
  let serverReady: Promise<void> | undefined;
  const knowledgeServerReady = () => {
    if (!owner) return Promise.resolve();
    if (!serverReady) {
      const started = performance.now();
      serverReady = migrateKnowledgeServer(owner).then(
        () => options.onServerMigrated?.(Math.round(performance.now() - started)),
        (error: unknown) => {
          serverReady = undefined;
          throw error;
        },
      );
    }
    return serverReady;
  };
  const followedFilters = new Map<string, string>();
  let following: Promise<void> = Promise.resolve();
  const followCatalog = (datasets: DatasetConfig[]) => {
    if (!owner) return Promise.resolve();
    // One sync at a time; a dataset that failed is tried again on the next call.
    following = following
      .catch(() => undefined)
      .then(async () => {
        // A worker bound to another platform server changes nothing on the knowledge server.
        options.knowledgeGuard?.();
        await knowledgeServerReady();
        for (const dataset of datasets) {
          const filters = JSON.stringify([dataset.filters, dataset.valueTypes ?? {}]);
          if (followedFilters.get(dataset.id) === filters) continue;
          await syncFilterIndexes(owner, dataset);
          followedFilters.set(dataset.id, filters);
        }
      });
    return following;
  };

  const adapter = localKnowledgeAdapter({
    engine: pgvectorEngineName,
    title: 'Innebygd søk',
    tech: 'Postgres med pgvector',
    endpointOptions,
    datasetOptions: pgvectorDatasetOptions,
    capabilities,
    defaults: (draft: DatasetDraft) =>
      draft.options['profiles']
        ? {}
        : { profiles: defaultPgvectorProfiles(draft.embedding !== undefined) },
    connect: (endpoint) => {
      requireKnowledgeServer();
      return knowledgeConnection(endpoint.timeoutMs);
    },
    probe: async () => {
      requireKnowledgeServer();
      await knowledgePool?.query('select 1');
    },
  });

  const writer: IndexWriterAdapter<PgvectorEndpointOptions, PgvectorDatasetOptions> = {
    engine: pgvectorEngineName,
    needs: { vectors: true },
    endpointOptions,
    datasetOptions: pgvectorDatasetOptions,
    connect: (_endpoint, context) => {
      requireKnowledgeServer();
      try {
        options.knowledgeGuard?.();
      } catch (error) {
        throw new KnowledgeError(
          'unavailable',
          error instanceof Error ? error.message : String(error),
        );
      }
      if (!owner)
        throw new KnowledgeError('unavailable', 'knowledge data is written by the worker');
      return knowledgeWriterOf<PgvectorDatasetOptions>(owner, knowledgeServerReady, context.signal);
    },
  };

  return { adapter, writer, followCatalog };
};
