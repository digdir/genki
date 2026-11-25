import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type {
  DatasetConfig,
  IndexDocument,
  IndexWriter,
  KnowledgeConnection,
} from '@genai/port-knowledge';
import { stopPostgres } from '@genai/providers-postgres/testing';
import {
  migrateKnowledgeServer,
  openKnowledgePools,
  partitionOf,
  pgvectorEngine,
  setUpKnowledgeServer,
  type PgvectorDatasetOptions,
} from './index.js';
import { knowledgeRoles } from './knowledge-setup.js';
import { readFunctionMigrations } from './read-functions.js';

// Issue 800: a filtered vector search ranks small filters exactly and raises the index limits for large ones;
// issue 674: an unfiltered search reads the index deeper too.
type Dataset = DatasetConfig<PgvectorDatasetOptions>;

const signal = new AbortController().signal;
const endpoint = { options: { connection: 'knowledge' as const }, timeoutMs: 10_000 };
const loginPassword = 'login-pw';
const dims = 8;

/** Small enough that the partitions below fall on both sides of it. */
const exactChunks = 100;
const raised = {
  efSearch: 120,
  maxScanTuples: 50_000,
  scanMemMultiplier: 3,
  unfilteredEfSearch: 80,
};
/** The server's own settings, low enough that today's search falls short on a rare value. */
const server = { efSearch: 10, maxScanTuples: 200 };

// 300 documents of 10 chunks: 6 rare (60 chunks), 30 middling (300) and the rest common.
const documents = 300;
const chunksPerDocument = 10;

const vectors: Dataset = {
  id: 'digdir/filtrert',
  filters: { type: 'multiselect' },
  options: { profiles: { near: { target: 'chunks', mode: 'vector' } } },
  embedding: { model: 'fake/embed', dimensions: dims },
};
const generation = 'g-20261119-filtrert';
const other = 'g-20261119-filtrert-2';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
let worker: ReturnType<typeof openKnowledgePools>;
let api: ReturnType<typeof openKnowledgePools>;
let owner: pg.Pool;

const queryVector = Array.from({ length: dims }, (_, i) => Math.cos(i * 3 + 1));

const fill = async (g: string, rareOnEvery: boolean) => {
  const w = pgvectorEngine({ knowledge: worker.pools }).writer.connect(endpoint, {
    signal,
  }) as IndexWriter<PgvectorDatasetOptions>;
  const seed: IndexDocument = { id: 'seed', title: 'seed', fields: {}, chunks: [], phrases: [] };
  await w.prepare(vectors, g);
  await w.store(vectors, g, seed);
  await w.promote(vectors, g);
  const docs = partitionOf('kn_docs', g);
  const chunks = partitionOf('kn_chunks', g);
  await owner.query(
    `insert into ${docs} (dataset, generation, id, fields, config)
       select $1, $2, 'd' || n, jsonb_build_object('type', jsonb_build_array(
         case when $3 then 'sjelden' when n % 50 = 0 then 'sjelden' when n % 10 = 5 then 'middels' else 'vanlig' end)), 'norwegian'
       from generate_series(1, $4::int) n`,
    [vectors.id, g, rareOnEvery, documents],
  );
  await owner.query(
    `insert into ${chunks} (dataset, generation, id, doc_id, position, text, config, vec)
       select $1, $2, 'd' || n || '#' || p, 'd' || n, p, 'del ' || p, 'norwegian',
         array(select sin(n * 7.0 + p * 13.0 + i) from generate_series(0, $5::int - 1) i)::real[]::halfvec
       from generate_series(1, $3::int) n cross join generate_series(0, $4::int - 1) p`,
    [vectors.id, g, documents, chunksPerDocument, dims],
  );
  await owner.query(`vacuum (analyze) ${docs}`);
  await owner.query(`vacuum (analyze) ${chunks}`);
};

/** The search as the API runs it: the knowledge port, as the reader, through `kn_search`. */
const search = async (type?: string) => {
  const connection = pgvectorEngine({
    knowledge: api.pools,
    embedder: () => ({ embed: async (texts) => texts.map(() => queryVector) }),
  }).adapter.connect(endpoint as never) as KnowledgeConnection<PgvectorDatasetOptions>;
  const [result] = await connection.search(
    { ...vectors, generation, allowed: [vectors.id] },
    [{ query: 'spørsmål', profile: 'near', limit: 10, ...(type ? { filters: { type } } : {}) }],
    signal,
  );
  if (!result) throw new Error('no result');
  return result;
};

/** Exact search over the filter's chunks: no index, every distance computed. */
const exact = async (type: string, limit: number) => {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query('set local enable_indexscan = off');
    await client.query('set local enable_bitmapscan = off');
    const { rows } = await client.query<{ id: string }>(
      `select c.id from ${partitionOf('kn_chunks', generation)} c
         join ${partitionOf('kn_docs', generation)} d on d.id = c.doc_id
         where d.fields @> jsonb_build_object('type', jsonb_build_array($1::text))
         order by c.vec::halfvec(${dims}) <=> $2::halfvec(${dims}), c.id limit ${limit}`,
      [type, JSON.stringify(queryVector)],
    );
    return rows.map((r) => r.id);
  } finally {
    await client.query('rollback');
    client.release();
  }
};

/** Runs `kn_search` as the reader, then reads the HNSW settings in the same transaction and in the next one. */
const settingsAround = async (
  filters: unknown[],
  g = generation,
  own?: { ef: number; tuples: number; mem: number },
) => {
  const client = await (api.pools.reader as pg.Pool).connect();
  const read = async () =>
    (
      await client.query<{ ef: string; tuples: string; mem: string }>(
        `select current_setting('hnsw.ef_search') as ef, current_setting('hnsw.max_scan_tuples') as tuples,
                current_setting('hnsw.scan_mem_multiplier') as mem`,
      )
    ).rows[0];
  try {
    await client.query('begin');
    await client.query(
      `select set_config('app.datasets', $1, true), set_config('hnsw.iterative_scan', 'relaxed_order', true)`,
      [JSON.stringify([vectors.id])],
    );
    if (own)
      await client.query(
        `select set_config('hnsw.ef_search', $1, true), set_config('hnsw.max_scan_tuples', $2, true),
                set_config('hnsw.scan_mem_multiplier', $3, true)`,
        [String(own.ef), String(own.tuples), String(own.mem)],
      );
    await client.query(
      `select * from kn_search($1, $2, 'chunks', 'vector', 'x', $3::halfvec, null, $4::jsonb, 10, 50, 60)`,
      [vectors.id, g, JSON.stringify(queryVector), JSON.stringify(filters)],
    );
    const during = await read();
    await client.query('commit');
    const after = await read();
    return { during, after };
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
};

/** The plan of the statement `kn_search_sql` builds for this filter; `join` sets how the planner may join. */
const planOf = async (
  filters: unknown[],
  join: 'index' | 'any join' = 'index',
  verbose = false,
) => {
  const client = await owner.connect();
  try {
    await client.query('begin');
    // On Kudos a large document guess made the planner rank every chunk first; dear nested loops do the same here.
    if (join === 'any join') await client.query('set local enable_nestloop = off');
    const { rows } = await client.query<{ sql: string }>(
      `select kn_search_sql($1, $2, 'chunks', 'vector', 'x', $3::halfvec, null, $4::jsonb, 10, 50, 60) as sql`,
      [vectors.id, generation, JSON.stringify(queryVector), JSON.stringify(filters)],
    );
    if (join === 'index') await client.query('set local enable_seqscan = off');
    const plan = await client.query<{ 'QUERY PLAN': string }>(
      `explain ${verbose ? '(verbose) ' : ''}${rows[0]?.sql ?? ''}`,
    );
    return plan.rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    await client.query('rollback');
    client.release();
  }
};

/** The chunk partition's table blocks `kn_search_sql` reads as it builds the search for this filter, counting its chunks. */
const chunkBlocksToBuild = async (filters: unknown[]) => {
  // A fresh session: a pooled one still holds unflushed counts from its earlier transactions.
  const client = new pg.Client({ connectionString: container.getConnectionUri() });
  await client.connect();
  try {
    await client.query('begin');
    await client.query(
      `select kn_search_sql($1, $2, 'chunks', 'vector', 'x', $3::halfvec, null, $4::jsonb, 10, 50, 60)`,
      [vectors.id, generation, JSON.stringify(queryVector), JSON.stringify(filters)],
    );
    const { rows } = await client.query<{ blocks: string }>(
      `select pg_stat_get_xact_blocks_fetched($1::regclass) as blocks`,
      [partitionOf('kn_chunks', generation)],
    );
    return Number(rows[0]?.blocks);
  } finally {
    await client.query('rollback');
    await client.end();
  }
};

const typeIs = (type: string) => [{ field: 'type', op: 'in', values: [type] }];

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  for (const login of ['knowledge_api', 'knowledge_worker'])
    await admin.query(`create role ${login} login password '${loginPassword}'`);
  await setUpKnowledgeServer(admin, {
    apiLogin: 'knowledge_api',
    workerLogin: 'knowledge_worker',
    platformId: '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
  });
  // The server's own limits, as `hnsw.*` in the server parameters would set them.
  await admin.query(`alter role knowledge_api set hnsw.ef_search = ${server.efSearch}`);
  await admin.query(`alter role knowledge_api set hnsw.max_scan_tuples = ${server.maxScanTuples}`);
  // On Kudos the planner reads the HNSW index for a rare value too; dear sorting makes this small partition do so.
  await admin.query(`alter role knowledge_api set enable_sort = off`);
  const source = {
    host: container.getHost(),
    port: container.getPort(),
    database: container.getDatabase(),
    password: loginPassword,
  };
  worker = openKnowledgePools({ ...source, user: 'knowledge_worker' }, 'worker');
  api = openKnowledgePools({ ...source, user: 'knowledge_api' }, 'api');
  owner = worker.pools.owner as pg.Pool;
  await migrateKnowledgeServer(owner);
  await fill(generation, false);
  // A second generation of the same dataset, where every document has the rare value.
  await fill(other, true);
  // After the writer's own migration, which builds the read functions with the measured settings.
  for (const sql of readFunctionMigrations(knowledgeRoles.reader, { exactChunks, ...raised }))
    await owner.query(sql);
}, 180_000);

afterAll(async () => {
  await worker?.close();
  await api?.close();
  await admin?.end();
  await stopPostgres(container);
});

describe('filtered vector search on the knowledge server', () => {
  it('a filtered vector search returns as many candidates as it asks for when enough chunks match the filter', async () => {
    // 60 rare chunks (below the threshold) and 300 middling ones (above it): each fills the 50 candidates.
    for (const type of ['sjelden', 'middels']) {
      const result = await search(type);
      expect({ type, found: result.found }).toEqual({ type, found: 50 });
    }
  });

  it('a filter that keeps fewer chunks than the threshold ranks its chunks exactly', async () => {
    const result = await search('sjelden');
    expect(result.hits.map((h) => h.id)).toEqual(await exact('sjelden', 10));
    expect(await planOf(typeIs('sjelden'))).not.toContain(
      `${partitionOf('kn_chunks', generation)}_vec`,
    );
  });

  it("an exact ranking reads only the chunks of the filter's documents", async () => {
    // The ranking reads the chunks as `x`; the hits are fetched afterwards as `c`.
    const chunks = partitionOf('kn_chunks', generation);
    const plan = await planOf(typeIs('sjelden'), 'any join');
    expect(plan).toContain(`Index Scan using ${chunks}_doc on ${chunks} x`);
    expect(plan).not.toContain(`Seq Scan on ${chunks} x`);
  });

  it("an exact ranking computes each chunk's distance once", async () => {
    // On Kudos, computing it for the score, the zero-vector check and the order took 2.5 s instead of 1 s.
    const plan = await planOf(typeIs('sjelden'), 'index', true);
    expect(plan.split('<=>').length - 1).toBe(1);
  });

  it("counting a filter's chunks reads the chunks' doc index, not the chunks", async () => {
    // Reading the chunks reads a block per chunk counted (101); the doc index reads none, planning at most one.
    expect(await chunkBlocksToBuild(typeIs('middels'))).toBeLessThanOrEqual(1);
  });

  it('a filter that keeps more chunks than the threshold searches the HNSW index', async () => {
    expect(await planOf(typeIs('vanlig'))).toContain(
      `Index Scan using ${partitionOf('kn_chunks', generation)}_vec`,
    );
  });

  it('a filtered vector search raises the scan limits for its own transaction only', async () => {
    const { during, after } = await settingsAround(typeIs('vanlig'));
    expect(during).toEqual({
      ef: String(raised.efSearch),
      tuples: String(raised.maxScanTuples),
      mem: String(raised.scanMemMultiplier),
    });
    expect(after).toEqual({
      ef: String(server.efSearch),
      tuples: String(server.maxScanTuples),
      mem: '1',
    });
  });

  it("a filtered vector search never lowers the server's own scan limits", async () => {
    const { during } = await settingsAround(typeIs('vanlig'), generation, {
      ef: 400,
      tuples: 90_000,
      mem: 5,
    });
    expect(during).toEqual({ ef: '400', tuples: '90000', mem: '5' });
  });

  it('an exact ranking leaves out a chunk without a direction', async () => {
    // One document of three chunks, fewer than the 50 candidates, so nothing is cut before the final order.
    const docs = partitionOf('kn_docs', generation);
    const chunks = partitionOf('kn_chunks', generation);
    await owner.query(
      `insert into ${docs} (dataset, generation, id, fields, config)
         values ($1, $2, 'enkel', '{"type": ["enkel"]}', 'norwegian')`,
      [vectors.id, generation],
    );
    await owner.query(
      `insert into ${chunks} (dataset, generation, id, doc_id, position, text, config, vec)
         select $1, $2, 'enkel#' || p, 'enkel', p, 'del', 'norwegian',
           case when p = 0 then array_fill(0, array[$3::int])::real[]
                else array(select sin(p + i) from generate_series(0, $3::int - 1) i)::real[] end::halfvec
         from generate_series(0, 2) p`,
      [vectors.id, generation, dims],
    );
    try {
      const result = await search('enkel');
      expect(result.hits.map((h) => h.id).sort()).toEqual(['enkel#1', 'enkel#2']);
    } finally {
      await owner.query(`delete from ${chunks} where doc_id = 'enkel'`);
      await owner.query(`delete from ${docs} where id = 'enkel'`);
    }
  });

  it('an unfiltered search raises hnsw.ef_search for its own transaction, and leaves the other limits', async () => {
    const { during, after } = await settingsAround([]);
    expect(during?.ef).toBe(String(raised.unfilteredEfSearch));
    expect(during?.tuples).toBe(String(server.maxScanTuples));
    expect(after?.ef).toBe(String(server.efSearch));
  });

  it('an unfiltered search never lowers a higher hnsw.ef_search', async () => {
    const { during } = await settingsAround([], generation, { ef: 400, tuples: 90_000, mem: 5 });
    expect(during?.ef).toBe('400');
  });

  it("the filter's chunk count is read from the generation's own partition", async () => {
    // The other generation holds 3,000 rare chunks; this one 60, so this one is ranked exactly.
    const { during } = await settingsAround(typeIs('sjelden'));
    expect(during?.ef).toBe(String(server.efSearch));
    const { during: there } = await settingsAround(typeIs('sjelden'), other);
    expect(there?.ef).toBe(String(raised.efSearch));
  });
});
