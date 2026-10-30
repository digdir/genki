import { createHash } from 'node:crypto';
import { KnowledgeError, kindsOf, type DatasetConfig } from '@genai/port-knowledge';
import type { Pool, PoolClient } from 'pg';
import { knowledgeRoles } from './knowledge-setup.js';

export interface PartitionOptions {
  lockTimeoutMs?: number;
}

export type GenerationState = 'standalone' | 'attached' | 'detaching';

export const knowledgeTables = ['kn_docs', 'kn_chunks', 'kn_phrases'] as const;
type KnowledgeTable = (typeof knowledgeTables)[number];

const defaultLockTimeoutMs = 5000;
const generationId = /^[a-z0-9][a-z0-9-]{0,62}$/;

const migrations: string[] = [
  `create table if not exists kn_generations (
     generation text primary key,
     dataset text not null,
     recipe jsonb not null default '{}',
     state text not null check (state in ('standalone', 'attached', 'detaching')),
     created_at timestamptz not null default now()
   )`,
  `create index if not exists kn_generations_dataset on kn_generations (dataset)`,
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
     primary key (generation, id)
   ) partition by list (generation)`,
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
     file text,
     page_from integer,
     page_to integer,
     heading_path text[],
     config regconfig not null,
     tsv tsvector generated always as (to_tsvector(config, text)) stored,
     vec halfvec,
     primary key (generation, id)
   ) partition by list (generation)`,
  `create index if not exists kn_chunks_doc on kn_chunks (generation, doc_id, position)`,
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
     primary key (generation, id)
   ) partition by list (generation)`,
  `create index if not exists kn_phrases_doc on kn_phrases (generation, doc_id)`,
  `create index if not exists kn_phrases_tsv on kn_phrases using gin (tsv)`,
  // Range filter values: a scalar of the declared type, or null, so a bad value never fails a write.
  `create or replace function kn_int(v jsonb) returns bigint
     language sql immutable parallel safe
     as $$ select case
       when jsonb_typeof(v) = 'number' and abs((v #>> '{}')::numeric) < 1e18
         and (v #>> '{}')::numeric = trunc((v #>> '{}')::numeric)
       then (v #>> '{}')::numeric::bigint end $$`,
  `create or replace function kn_text(v jsonb) returns text
     language sql immutable parallel safe
     as $$ select case when jsonb_typeof(v) = 'string' then v #>> '{}' end $$`,
  `grant select, insert, update, delete on kn_docs, kn_chunks, kn_phrases to ${knowledgeRoles.writer}`,
  `grant select on kn_generations to ${knowledgeRoles.writer}`,
];

export const migrateKnowledgeServer = async (owner: Pool) => {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query(`select pg_advisory_xact_lock(hashtext('genai-knowledge-server-migrate'))`);
    for (const sql of migrations) await client.query(sql);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
};

const hash = (value: string, length = 12) =>
  createHash('sha256').update(value).digest('hex').slice(0, length);

export const partitionOf = (table: KnowledgeTable | string, generation: string) =>
  `${table}_g_${hash(generation)}`;

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

const checkedGeneration = (generation: string) => {
  if (!generationId.test(generation))
    throw new KnowledgeError('bad_request', `${generation} is not a valid generation id`);
  return generation;
};

const onClient = async <T>(db: Pool | PoolClient, run: (client: PoolClient) => Promise<T>) => {
  if (!('release' in db)) {
    const client = await db.connect();
    try {
      return await run(client);
    } finally {
      client.release();
    }
  }
  return run(db);
};

const busy = (error: unknown) =>
  (error as { code?: string }).code === '55P03'
    ? new KnowledgeError('unavailable', 'the knowledge server is busy, try again')
    : error;

/** Partition DDL waits at most `lockTimeoutMs` for a lock, after finishing any detach a cancel left pending. */
const partitionDdl = <T>(
  db: Pool | PoolClient,
  options: PartitionOptions,
  run: (client: PoolClient) => Promise<T>,
) =>
  onClient(db, async (client) => {
    await client.query(`select set_config('lock_timeout', $1, false)`, [
      `${options.lockTimeoutMs ?? defaultLockTimeoutMs}ms`,
    ]);
    try {
      const { rows } = await client.query<{ parent: string; child: string }>(
        `select p.relname as parent, c.relname as child from pg_inherits i
           join pg_class p on p.oid = i.inhparent join pg_class c on c.oid = i.inhrelid
           where i.inhdetachpending and p.relname = any($1)`,
        [[...knowledgeTables]],
      );
      for (const row of rows)
        await client.query(`alter table ${row.parent} detach partition ${row.child} finalize`);
      return await run(client);
    } catch (error) {
      throw busy(error);
    } finally {
      await client.query(`reset lock_timeout`).catch(() => undefined);
    }
  });

export const generationOf = async (db: Pool | PoolClient, generation: string) =>
  (
    await db.query<{ dataset: string; state: GenerationState }>(
      `select dataset, state from kn_generations where generation = $1`,
      [generation],
    )
  ).rows[0];

const attached = async (client: PoolClient, table: string) =>
  Boolean(
    (await client.query(`select 1 from pg_inherits where inhrelid = to_regclass($1)`, [table]))
      .rowCount,
  );

export const recipeOf = (dataset: DatasetConfig) => ({
  ...(dataset.embedding ? { embedding: dataset.embedding } : {}),
  textSearchConfig:
    (dataset.options as { textSearchConfig?: string } | undefined)?.textSearchConfig ?? 'norwegian',
});

/** A new generation starts as standalone tables with the parents' columns and its own bounds. */
export const prepareGeneration = (
  owner: Pool | PoolClient,
  dataset: DatasetConfig,
  generation: string,
  options: PartitionOptions = {},
) =>
  partitionDdl(owner, options, async (client) => {
    checkedGeneration(generation);
    const known = await generationOf(client, generation);
    if (known && known.dataset !== dataset.id)
      throw new KnowledgeError(
        'bad_request',
        `generation ${generation} belongs to another dataset`,
      );
    if (known) return;
    await client.query('begin');
    try {
      for (const table of knowledgeTables) {
        const name = partitionOf(table, generation);
        await client.query(
          `create table ${name} (like ${table} including all excluding indexes)
             with (autovacuum_enabled = false)`,
        );
        await client.query(
          `alter table ${name} add constraint ${name}_bounds
             check (dataset = ${literal(dataset.id)} and generation = ${literal(generation)})`,
        );
        // Keys and per-document lookups up front, so each store replaces a document without a scan.
        await client.query(`alter table ${name} add primary key (generation, id)`);
      }
      await client.query(
        `create index ${partitionOf('kn_chunks', generation)}_doc on ${partitionOf('kn_chunks', generation)} (generation, doc_id, position)`,
      );
      await client.query(
        `create index ${partitionOf('kn_phrases', generation)}_doc on ${partitionOf('kn_phrases', generation)} (generation, doc_id)`,
      );
      await client.query(
        `insert into kn_generations (generation, dataset, recipe, state) values ($1, $2, $3, 'standalone')`,
        [generation, dataset.id, JSON.stringify(recipeOf(dataset))],
      );
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    }
  });

type WantedIndex = { name: string; sql: string };

const filterIndexesOf = (dataset: DatasetConfig, table: string): WantedIndex[] => {
  const kinds = Object.entries(dataset.filters).map(([field, f]) => [field, kindsOf(f)] as const);
  const wanted: WantedIndex[] = [];
  if (
    kinds.some(([, k]) =>
      k.some((kind) => kind === 'select' || kind === 'multiselect' || kind === 'boolean'),
    )
  )
    wanted.push({
      name: `${table}_fields`,
      sql: `create index if not exists ${table}_fields on ${table} using gin (fields jsonb_path_ops)`,
    });
  for (const [field, k] of kinds) {
    if (!k.includes('range')) continue;
    const cast = dataset.valueTypes?.[field] === 'integer' ? 'kn_int' : 'kn_text';
    const name = `${table}_r_${hash(`${field}:${cast}`, 10)}`;
    wanted.push({
      name,
      sql: `create index if not exists ${name} on ${table} (${cast}(fields -> ${literal(field)}))`,
    });
  }
  return wanted;
};

/** On a partition searches read, indexes change concurrently so neither search nor writes wait for the build. */
const syncTableFilters = async (
  client: PoolClient,
  dataset: DatasetConfig,
  table: string,
  live = true,
) => {
  const concurrently = live ? ' concurrently' : '';
  const wanted = filterIndexesOf(dataset, table);
  const { rows } = await client.query<{ indexname: string; valid: boolean }>(
    `select c.relname as indexname, i.indisvalid as valid from pg_index i
       join pg_class c on c.oid = i.indexrelid
       where i.indrelid = to_regclass($1)
         and (c.relname = $1 || '_fields' or c.relname like $1 || '\\_r\\_%')`,
    [table],
  );
  // A concurrent build that was cut short leaves an invalid index, which `if not exists` would keep.
  for (const { indexname, valid } of rows)
    if (!valid || !wanted.some((w) => w.name === indexname))
      await client.query(`drop index${concurrently} if exists ${indexname}`);
  for (const index of wanted)
    await client.query(
      index.sql.replace('create index if not exists', `create index${concurrently} if not exists`),
    );
};

/** Adds and drops filter indexes on one dataset's partitions only. */
export const syncFilterIndexes = (
  owner: Pool | PoolClient,
  dataset: DatasetConfig,
  options: PartitionOptions = {},
) =>
  partitionDdl(owner, options, async (client) => {
    const { rows } = await client.query<{ generation: string }>(
      `select generation from kn_generations where dataset = $1 and state <> 'detaching'`,
      [dataset.id],
    );
    for (const { generation } of rows)
      await syncTableFilters(client, dataset, partitionOf('kn_docs', generation));
  });

/** Indexes a loaded generation like its parents, then attaches it without a scan; activating it is a catalog change. */
export const attachGeneration = (
  owner: Pool | PoolClient,
  dataset: DatasetConfig,
  generation: string,
  options: PartitionOptions = {},
) =>
  partitionDdl(owner, options, async (client) => {
    const known = await generationOf(client, checkedGeneration(generation));
    if (!known || known.dataset !== dataset.id)
      throw new KnowledgeError('bad_request', `generation ${generation} is not prepared`);
    if (known.state === 'attached') return;
    const dims = dataset.embedding?.dimensions;
    const docs = partitionOf('kn_docs', generation);
    const chunks = partitionOf('kn_chunks', generation);
    const phrases = partitionOf('kn_phrases', generation);
    const build = [
      `create index if not exists ${docs}_tsv on ${docs} using gin (tsv)`,
      `create index if not exists ${docs}_title_tsv on ${docs} using gin (title_tsv)`,
      `create index if not exists ${chunks}_doc on ${chunks} (generation, doc_id, position)`,
      `create index if not exists ${chunks}_tsv on ${chunks} using gin (tsv)`,
      `create index if not exists ${phrases}_doc on ${phrases} (generation, doc_id)`,
      `create index if not exists ${phrases}_tsv on ${phrases} using gin (tsv)`,
      ...(dims
        ? [chunks, phrases].map(
            (t) =>
              `create index if not exists ${t}_vec on ${t}
                 using hnsw ((vec::halfvec(${dims})) halfvec_cosine_ops) with (m = 16, ef_construction = 64)`,
          )
        : []),
    ];
    for (const table of [docs, chunks, phrases]) {
      const { rowCount } = await client.query(
        `select 1 from pg_constraint where conrelid = $1::regclass and contype = 'p'`,
        [table],
      );
      if (!rowCount) await client.query(`alter table ${table} add primary key (generation, id)`);
    }
    for (const sql of build) await client.query(sql);
    await syncTableFilters(client, dataset, docs, false);
    for (const table of knowledgeTables)
      if (!(await attached(client, partitionOf(table, generation))))
        await client.query(
          `alter table ${table} attach partition ${partitionOf(table, generation)} for values in (${literal(generation)})`,
        );
    await client.query(`update kn_generations set state = 'attached' where generation = $1`, [
      generation,
    ]);
  });

/** Detaches without blocking search, then drops; a detach that is cancelled is finished by the next DDL. */
export const dropGeneration = (
  owner: Pool | PoolClient,
  generation: string,
  options: PartitionOptions = {},
) =>
  partitionDdl(owner, options, async (client) => {
    const known = await generationOf(client, checkedGeneration(generation));
    if (!known) return;
    await client.query(`update kn_generations set state = 'detaching' where generation = $1`, [
      generation,
    ]);
    for (const table of knowledgeTables)
      if (await attached(client, partitionOf(table, generation)))
        await client.query(
          `alter table ${table} detach partition ${partitionOf(table, generation)} concurrently`,
        );
    for (const table of knowledgeTables)
      await client.query(`drop table if exists ${partitionOf(table, generation)}`);
    await client.query(`delete from kn_generations where generation = $1`, [generation]);
  });
