import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  KnowledgeError,
  type DatasetConfig,
  type IndexDocument,
  type IndexWriter,
} from '@genai/port-knowledge';
import { stopPostgres } from '@genai/providers-postgres/testing';
import {
  attachGeneration,
  migrateKnowledgeServer,
  openKnowledgePools,
  partitionOf,
  pgvectorEngine,
  prepareGeneration,
  setUpKnowledgeServer,
  type PgvectorDatasetOptions,
} from './index.js';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
let worker: ReturnType<typeof openKnowledgePools>;
let owner: pg.Pool;
const signal = new AbortController().signal;
const endpoint = { options: { connection: 'knowledge' as const }, timeoutMs: 5000 };

type Dataset = DatasetConfig<PgvectorDatasetOptions>;
const dataset = (id: string, dimensions: number, extra: Partial<Dataset> = {}): Dataset => ({
  id,
  filters: { type: 'multiselect', year: 'range' },
  valueTypes: { year: 'integer' },
  options: {},
  embedding: { model: 'fake/embed', dimensions },
  ...extra,
});

const vector = (dimensions: number, seed: number) =>
  Array.from({ length: dimensions }, (_, i) => Math.sin(seed * 7 + i));

const doc = (id: string, dimensions: number, fields: Record<string, unknown>): IndexDocument => ({
  id,
  title: `Rapport ${id}`,
  fields,
  chunks: [0, 1].map((position) => ({
    id: `${id}#${position}`,
    position,
    text: `Lønn og tilskudd i rapport ${id}, del ${position}`,
    metadata: {},
    vector: vector(dimensions, position + id.length),
  })),
  phrases: [],
});

const writerFor = (engine = pgvectorEngine({ pool: admin, knowledge: worker.pools })) =>
  engine.writer.connect(endpoint, { signal }) as IndexWriter<PgvectorDatasetOptions>;

const fill = async (d: Dataset, generation: string, docs: IndexDocument[]) => {
  const writer = writerFor();
  await writer.prepare(d, generation);
  for (const document of docs) await writer.store(d, generation, document);
  await writer.promote(d, generation);
};

// With sorting off too, a nearest-neighbour query can only be served in order by an index that matches its cast.
const plan = async (sql: string, { ordered = false } = {}) => {
  const client = await owner.connect();
  try {
    await client.query('begin');
    await client.query('set local enable_seqscan = off');
    if (ordered) await client.query('set local enable_sort = off');
    const { rows } = await client.query<{ 'QUERY PLAN': string }>(`explain ${sql}`);
    await client.query('rollback');
    return rows.map((r) => r['QUERY PLAN']).join('\n');
  } finally {
    client.release();
  }
};

const indexesOf = async (table: string) =>
  (
    await admin.query<{ indexname: string }>(
      `select indexname from pg_indexes where tablename = $1 order by indexname`,
      [table],
    )
  ).rows.map((r) => r.indexname);

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  for (const login of ['knowledge_api', 'knowledge_worker'])
    await admin.query(`create role ${login} login password 'login-pw'`);
  await setUpKnowledgeServer(admin, {
    apiLogin: 'knowledge_api',
    workerLogin: 'knowledge_worker',
    platformId: '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
  });
  worker = openKnowledgePools(
    {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      user: 'knowledge_worker',
      password: 'login-pw',
    },
    'worker',
  );
  owner = worker.pools.owner as pg.Pool;
  await migrateKnowledgeServer(owner);
}, 120_000);

afterAll(async () => {
  await worker?.close();
  await admin?.end();
  await stopPostgres(container);
});

describe('generations as partitions on the knowledge server', () => {
  it("vector search uses the partition's HNSW index for two dimension sizes, keyword search its GIN index, and a filter on a declared field its partition's filter index (checked with `EXPLAIN`)", async () => {
    const small = dataset('digdir/kudos', 1536);
    const large = dataset('digdir/large', 3072);
    await fill(small, 'g-20261030-0001', [doc('a', 1536, { type: ['rapport'], year: 2024 })]);
    await fill(large, 'g-20261030-0002', [doc('b', 3072, { type: ['evaluering'], year: 2021 })]);

    for (const [d, generation] of [
      [small, 'g-20261030-0001'],
      [large, 'g-20261030-0002'],
    ] as const) {
      const dims = d.embedding?.dimensions ?? 0;
      const chunks = partitionOf('kn_chunks', generation);
      const vectorPlan = await plan(
        `select id from kn_chunks where dataset = '${d.id}' and generation = '${generation}'
           order by vec::halfvec(${dims}) <=> '${JSON.stringify(vector(dims, 3))}'::halfvec(${dims}) limit 5`,
        { ordered: true },
      );
      expect(vectorPlan).toContain(`Index Scan using ${chunks}_vec on ${chunks}`);
    }

    const chunks = partitionOf('kn_chunks', 'g-20261030-0001');
    const docs = partitionOf('kn_docs', 'g-20261030-0001');
    await owner.query(
      `insert into ${docs} (dataset, generation, id, fields, config)
         select 'digdir/kudos', 'g-20261030-0001', 'bulk-' || n,
           jsonb_build_object('type', jsonb_build_array('notat'), 'year', 1990 + n % 20), 'norwegian'
         from generate_series(1, 1000) n`,
    );
    await owner.query(
      `insert into ${chunks} (dataset, generation, id, doc_id, position, text, config)
         select 'digdir/kudos', 'g-20261030-0001', 'bulk-' || n, 'bulk-' || n, 0, 'budsjett ' || n, 'norwegian'
         from generate_series(1, 1000) n`,
    );
    await owner.query(`analyze ${docs}`);
    await owner.query(`analyze ${chunks}`);
    expect(
      await plan(
        `select id from kn_chunks where dataset = 'digdir/kudos' and generation = 'g-20261030-0001'
           and tsv @@ plainto_tsquery('norwegian', 'tilskudd')`,
      ),
    ).toMatch(new RegExp(`Bitmap Index Scan on ${chunks}_tsv`));
    expect(
      await plan(
        `select id from kn_docs where dataset = 'digdir/kudos' and generation = 'g-20261030-0001'
           and fields @> '{"type": ["rapport"]}'`,
      ),
    ).toMatch(new RegExp(`Bitmap Index Scan on ${docs}_fields`));
    expect(
      await plan(
        `select id from kn_docs where dataset = 'digdir/kudos' and generation = 'g-20261030-0001'
           and kn_int(fields -> 'year') between 2020 and 2024`,
      ),
    ).toMatch(new RegExp(`Index Scan using ${docs}_r_\\w+ on ${docs}`));
  });

  it("changing a dataset's filters changes indexes on its own partitions only", async () => {
    const kudos = dataset('digdir/filters-a', 8);
    const other = dataset('digdir/filters-b', 8);
    await fill(kudos, 'g-20261030-0101', [doc('a', 8, { type: ['rapport'], year: 2024 })]);
    await fill(other, 'g-20261030-0102', [doc('b', 8, { type: ['rapport'], year: 2024 })]);
    const otherIndexes = await indexesOf(partitionOf('kn_docs', 'g-20261030-0102'));

    const engine = pgvectorEngine({ pool: admin, knowledge: worker.pools });
    await engine.followCatalog([
      {
        ...kudos,
        filters: { type: 'multiselect', year: 'range', grade: 'range' },
        valueTypes: { year: 'integer' },
      },
      other,
    ]);

    const kudosIndexes = await indexesOf(partitionOf('kn_docs', 'g-20261030-0101'));
    expect(kudosIndexes.filter((n) => n.includes('_r_'))).toHaveLength(2);
    expect(await indexesOf(partitionOf('kn_docs', 'g-20261030-0102'))).toEqual(otherIndexes);

    await engine.followCatalog([{ ...kudos, filters: { type: 'multiselect' } }, other]);
    const after = await indexesOf(partitionOf('kn_docs', 'g-20261030-0101'));
    expect(after.filter((n) => n.includes('_r_'))).toEqual([]);
    expect(after.filter((n) => n.endsWith('_fields'))).toHaveLength(1);
  });

  it("the worker changes a dataset's filter indexes when its filters change in the catalog", async () => {
    const d = dataset('digdir/follow', 8, { filters: { type: 'multiselect' }, valueTypes: {} });
    await fill(d, 'g-20261030-0201', [doc('a', 8, { type: ['rapport'], year: 2023 })]);
    const table = partitionOf('kn_docs', 'g-20261030-0201');
    const worker = pgvectorEngine({ pool: admin, knowledge: { owner, writer: owner } });
    const api = pgvectorEngine({ pool: admin, knowledge: { reader: owner } });
    const changed: Dataset = {
      ...d,
      filters: { type: 'multiselect', year: 'range' },
      valueTypes: { year: 'integer' },
    };

    await api.followCatalog([changed]);
    expect((await indexesOf(table)).filter((n) => n.includes('_r_'))).toEqual([]);
    await worker.followCatalog([changed]);
    expect((await indexesOf(table)).filter((n) => n.includes('_r_'))).toHaveLength(1);
  });

  it('attaching a generation does not scan it', async () => {
    const d = dataset('digdir/attach', 8);
    const writer = writerFor();
    await writer.prepare(d, 'g-20261030-0301');
    await writer.store(d, 'g-20261030-0301', doc('a', 8, { type: ['rapport'] }));
    const notices: string[] = [];
    const client = await owner.connect();
    client.on('notice', (n) => notices.push(n.message ?? ''));
    try {
      await client.query(`set client_min_messages = debug1`);
      await attachGeneration(client, d, 'g-20261030-0301');
    } finally {
      await client.query('reset client_min_messages');
      client.release();
    }
    for (const table of ['kn_docs', 'kn_chunks', 'kn_phrases'])
      expect(notices).toContain(
        `partition constraint for table "${partitionOf(table, 'g-20261030-0301')}" is implied by existing constraints`,
      );
  });

  it('a pending detach is finished before the next partition DDL', async () => {
    const d = dataset('digdir/detach', 8);
    await fill(d, 'g-20261030-0401', [doc('a', 8, {})]);
    const table = partitionOf('kn_chunks', 'g-20261030-0401');
    const reader = await owner.connect();
    const detacher = await owner.connect();
    try {
      await reader.query('begin');
      await reader.query(`select count(*) from kn_chunks`);
      await detacher.query(`set statement_timeout = '500ms'`);
      await expect(
        detacher.query(`alter table kn_chunks detach partition ${table} concurrently`),
      ).rejects.toThrow(/statement timeout/);
      await reader.query('commit');
    } finally {
      await detacher.query('reset statement_timeout');
      reader.release();
      detacher.release();
    }
    const pending = async () =>
      (
        await admin.query<{ inhdetachpending: boolean }>(
          `select inhdetachpending from pg_inherits where inhrelid = $1::regclass`,
          [table],
        )
      ).rows[0]?.inhdetachpending;
    expect(await pending()).toBe(true);

    await prepareGeneration(owner, dataset('digdir/detach-next', 8), 'g-20261030-0402');
    expect(await pending()).toBeUndefined();
  });

  it('partition DDL gives up after `lock_timeout`', async () => {
    const d = dataset('digdir/locked', 8);
    const writer = writerFor();
    await writer.prepare(d, 'g-20261030-0501');
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query('lock table kn_chunks in access exclusive mode');
      const started = Date.now();
      const client = await owner.connect();
      try {
        await expect(
          attachGeneration(client, d, 'g-20261030-0501', { lockTimeoutMs: 300 }),
        ).rejects.toEqual(
          new KnowledgeError('unavailable', 'the knowledge server is busy, try again'),
        );
      } finally {
        client.release();
      }
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });

  it('a partition that takes in-place updates has autovacuum off', async () => {
    const d = dataset('digdir/vacuum', 8);
    await fill(d, 'g-20261030-0601', [doc('a', 8, {})]);
    for (const table of ['kn_docs', 'kn_chunks', 'kn_phrases']) {
      const { rows } = await admin.query<{ reloptions: string[] | null }>(
        `select reloptions from pg_class where relname = $1`,
        [partitionOf(table, 'g-20261030-0601')],
      );
      expect(rows[0]?.reloptions).toContain('autovacuum_enabled=false');
    }
  });

  it('a partition holds only its own dataset and generation', async () => {
    const d = dataset('digdir/own', 8);
    await fill(d, 'g-20261030-0701', [doc('a', 8, {})]);
    const table = partitionOf('kn_docs', 'g-20261030-0701');
    await expect(
      owner.query(
        `insert into ${table} (dataset, generation, id, config) values ('digdir/other', 'g-20261030-0701', 'x', 'simple')`,
      ),
    ).rejects.toThrow(/violates/);
    await expect(
      owner.query(
        `insert into ${table} (dataset, generation, id, config) values ('digdir/own', 'g-20261030-9999', 'x', 'simple')`,
      ),
    ).rejects.toThrow(/violates/);
  });

  it('attaching a generation does not make it active; only the catalog does', async () => {
    const first = dataset('digdir/active', 8, { generation: 'g-20261030-0801' });
    await fill(first, 'g-20261030-0801', [doc('a', 8, {})]);
    const writer = writerFor();
    await writer.prepare(first, 'g-20261030-0802');
    await writer.store(first, 'g-20261030-0802', doc('b', 8, {}));
    expect(await writer.promote(first, 'g-20261030-0802')).toBeUndefined();
    expect(await writer.active(first)).toBe('g-20261030-0801');
    expect(await writer.active({ ...first, generation: 'g-20261030-0802' })).toBe(
      'g-20261030-0802',
    );
  });

  it('a generation records the embedding and text configuration it was built with', async () => {
    const d = dataset('digdir/recipe', 8, {
      options: { textSearchConfig: 'simple' },
      embedding: { model: 'foundry/text-embedding-3-large', dimensions: 8 },
    });
    await writerFor().prepare(d, 'g-20261030-0901');
    const { rows } = await admin.query<{ dataset: string; recipe: unknown; state: string }>(
      `select dataset, recipe, state from kn_generations where generation = 'g-20261030-0901'`,
    );
    expect(rows[0]).toEqual({
      dataset: 'digdir/recipe',
      state: 'standalone',
      recipe: {
        embedding: { model: 'foundry/text-embedding-3-large', dimensions: 8 },
        textSearchConfig: 'simple',
      },
    });
  });

  it('dropping the active generation is refused unless forced', async () => {
    const d = dataset('digdir/drop', 8, { generation: 'g-20261030-1001' });
    await fill(d, 'g-20261030-1001', [doc('a', 8, {})]);
    const writer = writerFor();
    await expect(writer.drop(d, 'g-20261030-1001')).rejects.toThrow('is active');
    await writer.drop(d, 'g-20261030-1001', { force: true });
    const { rows } = await admin.query(`select 1 from pg_class where relname = $1`, [
      partitionOf('kn_chunks', 'g-20261030-1001'),
    ]);
    expect(rows).toEqual([]);
    expect(
      (await admin.query(`select 1 from kn_generations where generation = 'g-20261030-1001'`))
        .rowCount,
    ).toBe(0);
  });

  it('knowledge writes are refused where there is no owner pool, as in the API', () => {
    const api = pgvectorEngine({ pool: admin, knowledge: { reader: owner } });
    expect(() => api.writer.connect(endpoint, { signal })).toThrow(
      new KnowledgeError('unavailable', 'knowledge data is written by the worker'),
    );
  });

  it('a range filter value that is a list or not of its type is stored and left out of its index', async () => {
    const d = dataset('digdir/ranges', 8);
    await fill(d, 'g-20261030-1101', [
      doc('list', 8, { year: [2020, 2021] }),
      doc('text', 8, { year: 'ukjent' }),
      doc('big', 8, { year: 1e30 }),
      doc('ok', 8, { year: 2022 }),
    ]);
    const { rows } = await owner.query<{ id: string; year: string | null }>(
      `select id, kn_int(fields -> 'year')::text as year from kn_docs
         where generation = 'g-20261030-1101' order by id`,
    );
    expect(rows).toEqual([
      { id: 'big', year: null },
      { id: 'list', year: null },
      { id: 'ok', year: '2022' },
      { id: 'text', year: null },
    ]);
  });

  it('reads a stored generation back with its vectors', async () => {
    const d = dataset('digdir/read', 8, { generation: 'g-20261030-1201' });
    const stored = doc('a', 8, { type: ['rapport'] });
    await fill(d, 'g-20261030-1201', [stored]);
    const writer = writerFor();
    const read: IndexDocument[] = [];
    for await (const document of writer.read?.(d) ?? []) read.push(document);
    expect(read).toHaveLength(1);
    expect(read[0]?.chunks.map((c) => c.id)).toEqual(['a#0', 'a#1']);
    expect(read[0]?.chunks[0]?.vector?.[0]).toBeCloseTo(stored.chunks[0]?.vector?.[0] ?? 0, 2);
    expect(await writer.stats(d, 'g-20261030-1201')).toEqual({
      documents: 1,
      chunks: 2,
      phrases: 0,
    });
  });
});
