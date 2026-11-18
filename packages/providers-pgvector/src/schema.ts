import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

/** The tables with vector indexes, which pgvector 0.8.2 can corrupt when VACUUM runs during writes. */
const vacuumedTables = ['kn_docs', 'kn_chunks', 'kn_phrases'];

const vacuumKey = `hashtext('genai-knowledge-vacuum')`;

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
     vec vector,
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
     vec vector,
     primary key (dataset, generation, id)
   )`,
  `create index if not exists kn_phrases_doc on kn_phrases (dataset, generation, doc_id)`,
  `create index if not exists kn_phrases_tsv on kn_phrases using gin (tsv)`,
  `do $$ declare t text; begin
     foreach t in array array[${vacuumedTables.map((t) => `'${t}'`).join(', ')}] loop
       if not exists (select from pg_class where oid = t::regclass
                        and 'autovacuum_enabled=false' = any(coalesce(reloptions, '{}'))) then
         execute format('alter table %I set (autovacuum_enabled = false)', t);
       end if;
     end loop;
   end $$`,
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

/** Taken first by every transaction that writes the vacuumed tables, so VACUUM never runs beside one. */
export const holdWriteLock = (client: PoolClient) =>
  client.query(`select pg_advisory_xact_lock_shared(${vacuumKey})`);

/**
 * VACUUM the vacuumed tables when no write is open. It never waits for the lock, since a waiting
 * exclusive request would hold back every later writer; the next run's end tries again. On a
 * failure the connection is destroyed, so the lock cannot stay held.
 */
export const vacuumKnowledge = async (pool: Pool) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ locked: boolean }>(
      `select pg_try_advisory_lock(${vacuumKey}) as locked`,
    );
    if (rows[0]?.locked) {
      await client.query(`vacuum (analyze) ${vacuumedTables.join(', ')}`);
      await client.query(`select pg_advisory_unlock(${vacuumKey})`);
    }
    client.release();
  } catch (error) {
    client.release(true);
    throw error;
  }
};

export const maxIndexedDimensions = 2000;

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
           using hnsw ((vec::vector(${dimensions})) vector_cosine_ops)
           where dataset = ${client.escapeLiteral(dataset)}`,
      );
  });
};
