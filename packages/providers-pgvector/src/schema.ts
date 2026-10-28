import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const migrations: string[] = [
  `create extension if not exists vector`,
  `create table if not exists kn_generations (
     dataset text not null,
     generation text not null,
     created_at timestamptz not null default now(),
     primary key (dataset, generation)
   )`,
  `create table if not exists kn_active (
     dataset text primary key,
     generation text not null
   )`,
  `create table if not exists kn_docs (
     dataset text not null,
     generation text not null,
     id text not null,
     title text,
     url text,
     fields jsonb not null default '{}',
     fields_text text not null default '',
     config regconfig not null,
     title_tsv tsvector generated always as (to_tsvector(config, coalesce(title, ''))) stored,
     tsv tsvector generated always as (to_tsvector(config, coalesce(title, '') || ' ' || fields_text)) stored,
     primary key (dataset, generation, id)
   )`,
  `create index if not exists kn_docs_tsv on kn_docs using gin (tsv)`,
  `create index if not exists kn_docs_title_tsv on kn_docs using gin (title_tsv)`,
  `create table if not exists kn_chunks (
     dataset text not null,
     generation text not null,
     id text not null,
     doc_id text not null,
     position integer not null,
     text text not null,
     metadata jsonb not null default '{}',
     config regconfig not null,
     tsv tsvector generated always as (to_tsvector(config, text)) stored,
     vec halfvec,
     primary key (dataset, generation, id)
   )`,
  `create index if not exists kn_chunks_doc on kn_chunks (dataset, generation, doc_id, position)`,
  `create index if not exists kn_chunks_tsv on kn_chunks using gin (tsv)`,
  `create table if not exists kn_phrases (
     dataset text not null,
     generation text not null,
     id text not null,
     doc_id text not null,
     chunk_id text not null,
     text text not null,
     config regconfig not null,
     tsv tsvector generated always as (to_tsvector(config, text)) stored,
     vec halfvec,
     primary key (dataset, generation, id)
   )`,
  `create index if not exists kn_phrases_doc on kn_phrases (dataset, generation, doc_id)`,
  `create index if not exists kn_phrases_tsv on kn_phrases using gin (tsv)`,
  // Vectors stored before halfvec: drop their vector indexes, convert once; ensureVectorIndexes builds new ones
  `do $$
   declare
     t text;
     idx record;
   begin
     foreach t in array array['kn_chunks', 'kn_phrases'] loop
       if (select format_type(atttypid, atttypmod) from pg_attribute
           where attrelid = t::regclass and attname = 'vec') = 'vector' then
         for idx in select indexname from pg_indexes
                    where tablename = t and indexdef like '%vector_cosine_ops%' loop
           execute format('drop index %I', idx.indexname);
         end loop;
         execute format('alter table %I alter column vec type halfvec using vec::halfvec', t);
       end if;
     end loop;
   end $$`,
  // What a converter such as Marker made of a file, so the text can be rebuilt without converting again
  `create table if not exists src_conversions (
     sha256 text not null,
     producer text not null,
     version text not null,
     settings jsonb not null,
     settings_key text generated always as (md5(settings::text)) stored,
     markdown text not null,
     output jsonb not null,
     saved_at timestamptz not null default clock_timestamp(),
     primary key (sha256, producer, version, settings_key)
   )`,
  `create index if not exists src_conversions_latest on src_conversions (sha256, producer, saved_at desc)`,
  // Vectors by the sha256 of their text, per embedding model and number of dimensions
  `create table if not exists kn_embeddings (
     model text not null,
     dimensions integer not null,
     hash text not null,
     vec halfvec not null,
     primary key (model, dimensions, hash)
   )`,
];

export const transaction = async <T>(
  pool: Pool,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

export const migrateKnowledge = (pool: Pool) =>
  transaction(pool, async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('genai-knowledge-migrate'))`);
    for (const sql of migrations) await client.query(sql);
  });

// pgvector indexes halfvec up to 4,000 dimensions (vector only to 2,000)
export const maxIndexedDimensions = 4000;

/** One partial HNSW index per dataset over vec cast to its dimension; larger dimensions search exactly. */
export const ensureVectorIndexes = (pool: Pool, dataset: string, dimensions: number) => {
  if (!Number.isInteger(dimensions) || dimensions < 1 || dimensions > maxIndexedDimensions)
    return Promise.resolve();
  const suffix = createHash('sha256').update(`${dataset}:${dimensions}`).digest('hex').slice(0, 24);
  return transaction(pool, async (client) => {
    await client.query(`select pg_advisory_xact_lock(hashtext('genai-knowledge-migrate'))`);
    for (const table of ['kn_chunks', 'kn_phrases'])
      await client.query(
        `create index if not exists ${table}_vec_${suffix} on ${table}
           using hnsw ((vec::halfvec(${dimensions})) halfvec_cosine_ops)
           where dataset = ${client.escapeLiteral(dataset)}`,
      );
  });
};
