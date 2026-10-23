import {
  KnowledgeError,
  filterKinds,
  knowledgeProfiles,
  localKnowledgeAdapter,
  type DatasetConfig,
  type DatasetDraft,
  type FacetValue,
  type Hit,
  type IndexDocument,
  type IndexWriter,
  type IndexWriterAdapter,
  type KnowledgeAdapter,
  type KnowledgeCapability,
  type KnowledgeConnection,
  type SearchRequest,
  type SearchResult,
} from '@genai/port-knowledge';
import type { Pool, PoolClient } from 'pg';
import { z } from 'zod';
import { ensureVectorIndexes, migrateKnowledge, transaction } from './schema.js';
import { facetSql, hitColumns, searchSql, type Profile } from './sql.js';

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

export const pgvectorEndpointOptions = z.strictObject({
  connection: z
    .literal('platform', {
      error: 'pgvector runs in the platform database; external connections are not accepted',
    })
    .meta({ enumTitles: ['Plattformens database'] })
    .default('platform'),
});

export type PgvectorDatasetOptions = z.infer<typeof pgvectorDatasetOptions>;
export type PgvectorEndpointOptions = z.infer<typeof pgvectorEndpointOptions>;
export type PgvectorProfile = z.infer<typeof profile>;

export interface QueryEmbedder {
  embed(texts: string[]): Promise<number[][]>;
}

export interface PgvectorEngineOptions {
  pool: Pool;
  embedder?: (dataset: DatasetConfig) => QueryEmbedder;
  maxQueryLength?: number;
}

export interface PgvectorEngine {
  adapter: KnowledgeAdapter<PgvectorEndpointOptions, PgvectorDatasetOptions>;
  writer: IndexWriterAdapter<PgvectorEndpointOptions, PgvectorDatasetOptions>;
}

type Dataset = DatasetConfig<PgvectorDatasetOptions>;

interface HitRow {
  id: string;
  text: string;
  doc_id: string;
  position: number;
  metadata: Record<string, unknown>;
  title: string | null;
  url: string | null;
  fields: Record<string, unknown>;
  score?: number;
  found?: number;
}

interface DocRow {
  id: string;
  pipeline: string | null;
  title: string | null;
  url: string | null;
  fields: Record<string, unknown>;
}

interface ChunkRow {
  doc_id: string;
  id: string;
  position: number;
  text: string;
  metadata: Record<string, unknown>;
  vec: string | null;
}

interface PhraseRow {
  doc_id: string;
  id: string;
  chunk_id: string;
  text: string;
  vec: string | null;
}

const readPage = 200;

const vectorField = (vec: string | null) =>
  vec === null ? {} : { vector: JSON.parse(vec) as number[] };

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

const hitOf = (row: HitRow): Hit => ({
  id: row.id,
  score: row.score ?? 0,
  text: row.text,
  ...(row.title === null ? {} : { title: row.title }),
  ...(row.url === null ? {} : { url: row.url }),
  document: row.doc_id,
  position: row.position,
  fields: { ...row.fields, ...row.metadata },
});

const failIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw signal.reason ?? new Error('aborted');
};

const configOf = (dataset: Dataset) => dataset.options.textSearchConfig ?? defaultConfig;

const fieldsText = (fields: Record<string, unknown>) =>
  Object.values(fields)
    .flatMap((v) => (Array.isArray(v) ? v : [v]))
    .filter((v) => typeof v === 'string' || typeof v === 'number')
    .join(' ');

export const pgvectorEngine = (options: PgvectorEngineOptions): PgvectorEngine => {
  const { pool } = options;
  let ready: Promise<void> | undefined;
  const migrated = () => {
    ready ??= migrateKnowledge(pool).catch((error: unknown) => {
      ready = undefined;
      throw error;
    });
    return ready;
  };

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

  const run = async <T>(
    timeoutMs: number,
    vectors: boolean,
    query: (c: PoolClient) => Promise<T>,
  ) =>
    transaction(pool, async (client) => {
      await client.query(
        `select set_config('statement_timeout', $1, true)${vectors ? `, set_config('hnsw.iterative_scan', 'relaxed_order', true)` : ''}`,
        [String(Math.max(1, Math.trunc(timeoutMs)))],
      );
      return query(client);
    });

  const connect = (timeoutMs: number): KnowledgeConnection<PgvectorDatasetOptions> => {
    const searchOne = async (
      dataset: Dataset,
      p: Profile,
      request: SearchRequest,
      vector: number[] | undefined,
      warning: string | undefined,
    ): Promise<SearchResult> => {
      if (p.mode === 'vector' && vector === undefined)
        return { hits: [], warning: warning ?? 'no query vector' };
      const limit = request.limit ?? 10;
      const built = searchSql({
        dataset,
        profile: p,
        query: request.query,
        filters: request.filters ?? {},
        limit,
        candidates: Math.max(limit * 4, 50),
        config: configOf(dataset),
        rrfK: dataset.options.rrfK ?? defaultRrfK,
        vector,
      });
      const { rows } = await run(timeoutMs, built.usesVectors, (c) =>
        c.query<HitRow>(built.sql, built.values),
      );
      return {
        hits: rows.map(hitOf),
        found: rows[0]?.found ?? 0,
        ...(warning === undefined ? {} : { warning }),
      };
    };

    return {
      served: async (dataset, signal) => {
        failIfAborted(signal);
        await migrated();
        const { rows } = await pool.query<{ generation: string }>(
          `select generation from kn_active where dataset = $1`,
          [dataset.id],
        );
        const generation = rows[0]?.generation;
        return generation === undefined ? {} : { generation };
      },
      profiles: (dataset) => profilesOf(dataset).map(([name]) => name),
      search: async (dataset, requests, signal) => {
        failIfAborted(signal);
        await migrated();
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
            return searchOne(
              dataset,
              x.p,
              x.request,
              vectorOf.get(x),
              x.wantsVector ? embedWarning : undefined,
            );
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
      },
      fetch: async (dataset, ids, signal) => {
        failIfAborted(signal);
        await migrated();
        const { rows } = await run(timeoutMs, false, (c) =>
          c.query<HitRow>(
            `select ${hitColumns} from kn_chunks c
               join kn_docs d on d.dataset = c.dataset and d.generation = c.generation and d.id = c.doc_id
               where c.dataset = $1 and c.generation = (select generation from kn_active where dataset = $1)
                 and c.id = any($2::text[])`,
            [dataset.id, ids],
          ),
        );
        const byId = new Map(rows.map((r) => [r.id, hitOf(r)]));
        return ids.flatMap((id) => byId.get(id) ?? []);
      },
      range: async (dataset, document, from, to, signal) => {
        failIfAborted(signal);
        await migrated();
        const { rows } = await run(timeoutMs, false, (c) =>
          c.query<HitRow>(
            `select ${hitColumns} from kn_chunks c
               join kn_docs d on d.dataset = c.dataset and d.generation = c.generation and d.id = c.doc_id
               where c.dataset = $1 and c.generation = (select generation from kn_active where dataset = $1)
                 and c.doc_id = $2 and c.position between $3 and $4
               order by c.position, c.id`,
            [dataset.id, document, from, to],
          ),
        );
        return rows.map(hitOf);
      },
      facets: async (dataset, fields, filters, signal) => {
        failIfAborted(signal);
        await migrated();
        const result: Record<string, FacetValue[]> = {};
        await run(timeoutMs, false, async (c) => {
          for (const field of fields) {
            const built = facetSql(dataset, field, filters, configOf(dataset));
            result[field] = (await c.query<FacetValue>(built.sql, built.values)).rows;
          }
        });
        return result;
      },
    };
  };

  const adapter = localKnowledgeAdapter({
    engine: pgvectorEngineName,
    title: 'Innebygd søk',
    tech: 'Postgres med pgvector',
    endpointOptions: pgvectorEndpointOptions,
    datasetOptions: pgvectorDatasetOptions,
    capabilities,
    defaults: (draft: DatasetDraft) =>
      draft.options['profiles']
        ? {}
        : { profiles: defaultPgvectorProfiles(draft.embedding !== undefined) },
    connect: (endpoint) => connect(endpoint.timeoutMs),
    probe: async (endpoint) => {
      const { rowCount } = await run(endpoint.timeoutMs, false, (c) =>
        c.query(`select 1 from pg_available_extensions where name = 'vector'`),
      );
      if (!rowCount)
        throw new KnowledgeError(
          'unavailable',
          'the platform database does not have the vector extension',
        );
    },
  });

  async function* readGeneration(
    dataset: Dataset,
    generation: string | undefined,
    begin: () => Promise<void>,
  ): AsyncIterable<IndexDocument> {
    await begin();
    const chosen =
      generation ??
      (
        await pool.query<{ generation: string }>(
          `select generation from kn_active where dataset = $1`,
          [dataset.id],
        )
      ).rows[0]?.generation;
    if (chosen === undefined) return;
    const { rowCount } = await pool.query(
      `select 1 from kn_generations where dataset = $1 and generation = $2`,
      [dataset.id, chosen],
    );
    if (!rowCount) throw new KnowledgeError('bad_request', `generation ${chosen} is not prepared`);
    let after: string | null = null;
    for (;;) {
      await begin();
      const key = [dataset.id, chosen];
      const docs: DocRow[] = (
        await pool.query<DocRow>(
          `select id, pipeline, title, url, fields from kn_docs
             where dataset = $1 and generation = $2 and ($3::text is null or id > $3)
             order by id limit $4`,
          [...key, after, readPage],
        )
      ).rows;
      if (docs.length === 0) return;
      const ids = docs.map((d) => d.id);
      const chunks = await pool.query<ChunkRow>(
        `select doc_id, id, position, text, metadata, vec::text as vec from kn_chunks
           where dataset = $1 and generation = $2 and doc_id = any($3::text[])
           order by doc_id, position, id`,
        [...key, ids],
      );
      const phrases = await pool.query<PhraseRow>(
        `select doc_id, id, chunk_id, text, vec::text as vec from kn_phrases
           where dataset = $1 and generation = $2 and doc_id = any($3::text[])
           order by doc_id, id`,
        [...key, ids],
      );
      for (const doc of docs)
        yield {
          id: doc.id,
          ...(doc.pipeline === null ? {} : { pipeline: doc.pipeline }),
          ...(doc.title === null ? {} : { title: doc.title }),
          ...(doc.url === null ? {} : { url: doc.url }),
          fields: doc.fields,
          chunks: chunks.rows
            .filter((c) => c.doc_id === doc.id)
            .map((c) => ({
              id: c.id,
              position: c.position,
              text: c.text,
              metadata: c.metadata,
              ...vectorField(c.vec),
            })),
          phrases: phrases.rows
            .filter((p) => p.doc_id === doc.id)
            .map((p) => ({ id: p.id, chunkId: p.chunk_id, text: p.text, ...vectorField(p.vec) })),
        };
      after = ids.at(-1) ?? null;
    }
  }

  const writerOf = (signal: AbortSignal): IndexWriter<PgvectorDatasetOptions> => {
    const prepared = async (client: PoolClient, dataset: Dataset, generation: string) => {
      const { rowCount } = await client.query(
        `select 1 from kn_generations where dataset = $1 and generation = $2`,
        [dataset.id, generation],
      );
      if (!rowCount)
        throw new KnowledgeError('bad_request', `generation ${generation} is not prepared`);
    };
    const vectorOf = (dataset: Dataset, vector: number[] | undefined, id: string) => {
      if (vector === undefined) return null;
      if (vector.length !== dataset.embedding?.dimensions || !vector.every(Number.isFinite))
        throw new KnowledgeError(
          'bad_request',
          `${id} needs a vector of ${dataset.embedding?.dimensions ?? 0} finite numbers`,
        );
      return JSON.stringify(vector);
    };
    const begin = async () => {
      failIfAborted(signal);
      await migrated();
    };

    const promote = async (
      dataset: Dataset,
      generation: string,
      expected?: { active: string | undefined },
    ) => {
      await begin();
      return transaction(pool, async (client) => {
        await client.query(`select pg_advisory_xact_lock(hashtext('kn_active:' || $1))`, [
          dataset.id,
        ]);
        await prepared(client, dataset, generation);
        const { rows } = await client.query<{ generation: string }>(
          `select generation from kn_active where dataset = $1`,
          [dataset.id],
        );
        const previous = rows[0]?.generation;
        if (expected && previous !== expected.active)
          throw new KnowledgeError(
            'bad_request',
            `dataset ${dataset.id} changed during ingestion; run the pipeline again`,
          );
        await client.query(
          `insert into kn_active (dataset, generation) values ($1, $2)
           on conflict (dataset) do update set generation = excluded.generation`,
          [dataset.id, generation],
        );
        return previous;
      });
    };

    return {
      prepare: async (dataset, generation) => {
        await begin();
        await pool.query(
          `insert into kn_generations (dataset, generation) values ($1, $2) on conflict do nothing`,
          [dataset.id, generation],
        );
        if (dataset.embedding)
          await ensureVectorIndexes(pool, dataset.id, dataset.embedding.dimensions);
      },
      store: async (dataset, generation, doc: IndexDocument) => {
        await begin();
        const chunks = doc.chunks.map((c) => ({
          id: c.id,
          position: c.position,
          text: c.text,
          metadata: c.metadata ?? {},
          vec: vectorOf(dataset, c.vector, c.id),
        }));
        const phrases = doc.phrases.map((p) => ({
          id: p.id,
          chunk_id: p.chunkId,
          text: p.text,
          vec: vectorOf(dataset, p.vector, p.id),
        }));
        const config = configOf(dataset);
        await transaction(pool, async (client) => {
          await prepared(client, dataset, generation);
          const key = [dataset.id, generation, doc.id];
          await client.query(
            `delete from kn_phrases where dataset = $1 and generation = $2 and doc_id = $3`,
            key,
          );
          await client.query(
            `delete from kn_chunks where dataset = $1 and generation = $2 and doc_id = $3`,
            key,
          );
          await client.query(
            `insert into kn_docs (dataset, generation, id, title, url, fields, fields_text, config, pipeline)
             values ($1, $2, $3, $4, $5, $6, $7, $8::regconfig, $9)
             on conflict (dataset, generation, id) do update set
               title = excluded.title, url = excluded.url, fields = excluded.fields,
               fields_text = excluded.fields_text, config = excluded.config, pipeline = excluded.pipeline`,
            [
              ...key,
              doc.title ?? null,
              doc.url ?? null,
              JSON.stringify(doc.fields),
              fieldsText(doc.fields),
              config,
              doc.pipeline ?? null,
            ],
          );
          await client.query(
            `insert into kn_chunks (dataset, generation, id, doc_id, position, text, metadata, config, vec)
             select $1, $2, x.id, $3, x.position, x.text, x.metadata, $4::regconfig, x.vec::vector
             from jsonb_to_recordset($5::jsonb) as x(id text, position integer, text text, metadata jsonb, vec text)`,
            [...key, config, JSON.stringify(chunks)],
          );
          await client.query(
            `insert into kn_phrases (dataset, generation, id, doc_id, chunk_id, text, config, vec)
             select $1, $2, x.id, $3, x.chunk_id, x.text, $4::regconfig, x.vec::vector
             from jsonb_to_recordset($5::jsonb) as x(id text, chunk_id text, text text, vec text)`,
            [...key, config, JSON.stringify(phrases)],
          );
        });
      },
      promote,
      promoteIfActive: (dataset, generation, expected) =>
        promote(dataset, generation, { active: expected }),
      drop: async (dataset, generation, options = {}) => {
        await begin();
        await transaction(pool, async (client) => {
          await client.query(`select pg_advisory_xact_lock(hashtext('kn_active:' || $1))`, [
            dataset.id,
          ]);
          const { rowCount } = await client.query(
            `select 1 from kn_active where dataset = $1 and generation = $2`,
            [dataset.id, generation],
          );
          if (rowCount && !options.force)
            throw new KnowledgeError('bad_request', `generation ${generation} is active`);
          for (const table of ['kn_active', 'kn_phrases', 'kn_chunks', 'kn_docs', 'kn_generations'])
            await client.query(`delete from ${table} where dataset = $1 and generation = $2`, [
              dataset.id,
              generation,
            ]);
        });
      },
      active: async (dataset) => {
        await begin();
        const { rows } = await pool.query<{ generation: string }>(
          `select generation from kn_active where dataset = $1`,
          [dataset.id],
        );
        return rows[0]?.generation;
      },
      read: (dataset, generation) => readGeneration(dataset, generation, begin),
      stats: async (dataset, generation) => {
        await begin();
        return transaction(pool, async (client) => {
          await prepared(client, dataset, generation);
          const { rows } = await client.query<{
            documents: number;
            chunks: number;
            phrases: number;
          }>(
            `select
               (select count(*)::int from kn_docs where dataset = $1 and generation = $2) as documents,
               (select count(*)::int from kn_chunks where dataset = $1 and generation = $2) as chunks,
               (select count(*)::int from kn_phrases where dataset = $1 and generation = $2) as phrases`,
            [dataset.id, generation],
          );
          return rows[0] ?? { documents: 0, chunks: 0, phrases: 0 };
        });
      },
    };
  };

  const writer: IndexWriterAdapter<PgvectorEndpointOptions, PgvectorDatasetOptions> = {
    engine: pgvectorEngineName,
    needs: { vectors: true },
    endpointOptions: pgvectorEndpointOptions,
    datasetOptions: pgvectorDatasetOptions,
    connect: (_endpoint, context) => writerOf(context.signal),
  };

  return { adapter, writer };
};
