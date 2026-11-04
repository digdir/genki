import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  KnowledgeRouter,
  tombstoneHash,
  type DatasetConfig,
  type IndexDocument,
  type IndexWriter,
  type KnowledgeConnection,
} from '@genai/port-knowledge';
import { envSecrets } from '@genai/kernel';
import { knowledgeContract, knowledgeContractSubject } from '@genai/port-knowledge/contract';
import {
  fixtureFilters,
  fixtureVector,
  indexWriterContract,
  knowledgeAdapterContract,
  seedCorpus,
} from '@genai/port-knowledge/testing';
import { describeContract } from '@genai/plugins/testing';
import { stopPostgres } from '@genai/providers-postgres/testing';
import {
  migrateKnowledgeServer,
  openKnowledgePools,
  partitionOf,
  pgvectorEngine,
  setUpKnowledgeServer,
  type KnowledgePools,
  type PgvectorDatasetOptions,
  type QueryEmbedder,
} from './index.js';
import { knowledgeRoles } from './knowledge-setup.js';
import { filterRows, notReadyCode } from './read-functions.js';

type Dataset = DatasetConfig<PgvectorDatasetOptions>;

const signal = new AbortController().signal;
const endpoint = { options: { connection: 'knowledge' as const }, timeoutMs: 5000 };
const loginPassword = 'login-pw';

interface Server {
  container: StartedPostgreSqlContainer;
  admin: pg.Pool;
  source: { host: string; port: number; database: string; password: string };
}

const startServer = async (): Promise<Server> => {
  const container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17').start();
  const admin = new pg.Pool({ connectionString: container.getConnectionUri() });
  for (const login of ['knowledge_api', 'knowledge_worker'])
    await admin.query(`create role ${login} login password '${loginPassword}'`);
  await setUpKnowledgeServer(admin, {
    apiLogin: 'knowledge_api',
    workerLogin: 'knowledge_worker',
    platformId: '7f3c0d4e-1b2a-4c5d-8e9f-0a1b2c3d4e5f',
  });
  return {
    container,
    admin,
    source: {
      host: container.getHost(),
      port: container.getPort(),
      database: container.getDatabase(),
      password: loginPassword,
    },
  };
};

let primary: Server;
let elsewhere: Server;
let worker: ReturnType<typeof openKnowledgePools>;
let api: ReturnType<typeof openKnowledgePools>;
let owner: pg.Pool;
const extraPools: pg.Pool[] = [];

const readerPool = (server: Server, extra = '') => {
  const pool = new pg.Pool({
    ...server.source,
    user: 'knowledge_api',
    options: `-c role=${knowledgeRoles.reader}${extra}`,
    connectionTimeoutMillis: 5000,
  });
  pool.on('connect', (client) => client.on('error', () => undefined));
  extraPools.push(pool);
  return pool;
};

const fixtureEmbedder = (dataset: DatasetConfig): QueryEmbedder => ({
  embed: async (texts) => texts.map((t) => fixtureVector(t, dataset.embedding?.dimensions ?? 0)),
});

const readEngine = (
  knowledge: KnowledgePools = api.pools,
  embedder: (dataset: DatasetConfig) => QueryEmbedder = fixtureEmbedder,
) => pgvectorEngine({ pool: primary.admin, knowledge, embedder });

const writerEngine = () => pgvectorEngine({ pool: primary.admin, knowledge: worker.pools });

const writer = () =>
  writerEngine().writer.connect(endpoint, { signal }) as IndexWriter<PgvectorDatasetOptions>;

const fill = async (d: Dataset, generation: string, docs: IndexDocument[]) => {
  const w = writer();
  await w.prepare(d, generation);
  for (const document of docs) await w.store(d, generation, document);
  await w.promote(d, generation);
};

const vector = (dimensions: number, seed: number) =>
  Array.from({ length: dimensions }, (_, i) => Math.sin(seed * 7 + i));

const doc = (
  id: string,
  dimensions: number,
  fields: Record<string, unknown> = {},
  text = `Lønn og tilskudd i rapport ${id}`,
): IndexDocument => ({
  id,
  title: `Rapport ${id}`,
  fields,
  chunks: [0, 1].map((position) => ({
    id: `${id}#${position}`,
    position,
    text: `${text}, del ${position}`,
    metadata: {},
    ...(dimensions ? { vector: vector(dimensions, position + id.length) } : {}),
  })),
  phrases: [],
});

const dataset = (id: string, dimensions: number, extra: Partial<Dataset> = {}): Dataset => ({
  id,
  filters: { type: 'multiselect', year: 'range' },
  valueTypes: { year: 'integer' },
  options: {},
  ...(dimensions ? { embedding: { model: 'fake/embed', dimensions } } : {}),
  ...extra,
});

const routed = (d: Dataset, generation: string): Dataset => ({
  ...d,
  generation,
  allowed: [d.id],
});

const connectionOf = (engine = readEngine(), timeoutMs = 5000) =>
  engine.adapter.connect({
    ...endpoint,
    timeoutMs,
  } as never) as KnowledgeConnection<PgvectorDatasetOptions>;

const asReader = async <T extends pg.QueryResultRow>(
  sql: string,
  values: unknown[],
  datasets?: string[],
  pool: pg.Pool = api.pools.reader as pg.Pool,
) => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    if (datasets)
      await client.query(`select set_config('app.datasets', $1, true)`, [JSON.stringify(datasets)]);
    return (await client.query<T>(sql, values)).rows;
  } finally {
    await client.query('rollback').catch(() => undefined);
    client.release();
  }
};

const refusal = (run: () => Promise<unknown>) =>
  run().then(
    () => 'answered',
    (error: { code?: string }) => error.code ?? String(error),
  );

const kudos = dataset('digdir/kudos', 8);
const annet = dataset('digdir/annet', 8);
const kudosGeneration = 'g-20261102-kudos';
const annetGeneration = 'g-20261102-annet';

beforeAll(async () => {
  [primary, elsewhere] = await Promise.all([startServer(), startServer()]);
  const login = (server: Server, user: string) => ({ ...server.source, user });
  worker = openKnowledgePools(login(primary, 'knowledge_worker'), 'worker');
  api = openKnowledgePools(login(primary, 'knowledge_api'), 'api');
  owner = worker.pools.owner as pg.Pool;
  await migrateKnowledgeServer(owner);
  const elsewhereWorker = openKnowledgePools(login(elsewhere, 'knowledge_worker'), 'worker');
  await migrateKnowledgeServer(elsewhereWorker.pools.owner as pg.Pool);
  await elsewhereWorker.close();
  await fill(kudos, kudosGeneration, [doc('a', 8, { type: ['rapport'], year: 2024 }), doc('b', 8)]);
  await fill(annet, annetGeneration, [doc('hemmelig', 8)]);
}, 180_000);

afterAll(async () => {
  await Promise.all(extraPools.map((p) => p.end()));
  await worker?.close();
  await api?.close();
  await primary?.admin.end();
  await elsewhere?.admin.end();
  await stopPostgres(primary?.container);
  await stopPostgres(elsewhere?.container);
});

describe('read functions on the knowledge server', () => {
  it('the reader role cannot select from any knowledge table', async () => {
    const tables = [
      'kn_docs',
      'kn_chunks',
      'kn_phrases',
      'kn_generations',
      'knowledge_binding',
      partitionOf('kn_chunks', kudosGeneration),
      partitionOf('kn_docs', kudosGeneration),
    ];
    for (const table of tables)
      expect(
        await refusal(() => asReader(`select count(*) from ${table}`, [], [kudos.id])),
        table,
      ).toBe('42501');
    expect(
      await refusal(() =>
        asReader(
          `select kn_fetch_sql($1, $2, array['a#0'])`,
          [kudos.id, kudosGeneration],
          [kudos.id],
        ),
      ),
    ).toBe('42501');
  });

  it('each read function refuses a dataset outside `app.datasets`', async () => {
    const calls = [
      `select * from kn_generation($1, $2)`,
      `select * from kn_search($1, $2, 'chunks', 'text', 'lønn', null, null, '[]', 5, 50, 60)`,
      `select * from kn_fetch($1, $2, array['a#0'])`,
      `select * from kn_range($1, $2, 'a', 0, 1)`,
      `select * from kn_facets($1, $2, array['type'], '[]')`,
      `select * from kn_documents($1, $2, null, '[]', 10, 0)`,
      `select * from kn_resolve_citation($1, $2, array['a'], array['hash-a'])`,
    ];
    for (const sql of calls) {
      const args = [kudos.id, kudosGeneration];
      expect(await refusal(() => asReader(sql, args)), `${sql} unset`).toBe('42501');
      expect(await refusal(() => asReader(sql, args, [annet.id])), `${sql} other`).toBe('42501');
      expect(await refusal(() => asReader(sql, args, [kudos.id])), `${sql} allowed`).toBe(
        'answered',
      );
    }
  });

  it('a citation resolves only inside a dataset the caller may read', async () => {
    const sql = `select * from kn_resolve_citation($1, $2, array['hemmelig'], array['hash-h'])`;
    expect(await refusal(() => asReader(sql, [annet.id, annetGeneration], [kudos.id]))).toBe(
      '42501',
    );
    // The allowed dataset paired with another dataset's generation finds nothing of it.
    expect(await refusal(() => asReader(sql, [kudos.id, annetGeneration], [kudos.id]))).toBe(
      notReadyCode,
    );
  });

  it('a cited id resolves to its document in the generation, and an unknown id to unknown', async () => {
    expect(
      await asReader(
        `select cited, status, document, title, url, withdrawn_on
           from kn_resolve_citation($1, $2, array['a', 'finnes-ikke'], array['hash-a', 'hash-f'])`,
        [kudos.id, kudosGeneration],
        [kudos.id],
      ),
    ).toEqual([
      {
        cited: 'a',
        status: 'found',
        document: 'a',
        title: 'Rapport a',
        url: null,
        withdrawn_on: null,
      },
      {
        cited: 'finnes-ikke',
        status: 'unknown',
        document: null,
        title: null,
        url: null,
        withdrawn_on: null,
      },
    ]);
  });

  const cite = (ids: string[], dataset: Dataset = kudos, generation = kudosGeneration) =>
    asReader<Record<string, unknown>>(
      `select cited, status, document, title, url, withdrawn_on::text
         from kn_resolve_citation($1, $2, $3::text[], $4::text[])`,
      [dataset.id, generation, ids, ids.map((id) => tombstoneHash(dataset.id, id))],
      [dataset.id],
    );

  it("a withdrawn document's citation resolves to its tombstone", async () => {
    await owner.query(
      `insert into src_tombstones (dataset, id_hash, deleted_on) values ($1, $2, '2026-10-01')`,
      [kudos.id, tombstoneHash(kudos.id, 'trukket')],
    );
    expect(await cite(['trukket'])).toEqual([
      {
        cited: 'trukket',
        status: 'withdrawn',
        document: null,
        title: null,
        url: null,
        withdrawn_on: '2026-10-01',
      },
    ]);
  });

  it("every tombstone holds only the id's hash and the date, and a citation gets the same answer for both kinds", async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `select column_name from information_schema.columns
         where table_name = 'src_tombstones' order by column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual(['dataset', 'deleted_on', 'id_hash']);
    // A source's delete and a withdrawal on request write the same plain row.
    for (const id of ['slettet-i-kilden', 'trukket-etter-krav'])
      await owner.query(
        `insert into src_tombstones (dataset, id_hash, deleted_on) values ($1, $2, '2026-10-02')`,
        [kudos.id, tombstoneHash(kudos.id, id)],
      );
    const [deleted, withdrawn] = await cite(['slettet-i-kilden', 'trukket-etter-krav']);
    expect(withdrawn).toEqual({ ...deleted, cited: 'trukket-etter-krav' });
    expect(deleted).toMatchObject({ status: 'withdrawn', withdrawn_on: '2026-10-02' });
  });

  it('an earlier id resolves to its document', async () => {
    await owner.query(
      `insert into src_documents (dataset, id, owners, record, metadata_hash, state, earlier_ids, change)
         values ($1, 'b', array['p1'], '{}', 'h', 'stored', array['b-gammel'], 1)`,
      [kudos.id],
    );
    expect(await cite(['b-gammel'])).toEqual([
      {
        cited: 'b-gammel',
        status: 'earlier',
        document: 'b',
        title: 'Rapport b',
        url: null,
        withdrawn_on: null,
      },
    ]);
  });

  it('the knowledge port resolves a citation to found, earlier or withdrawn through kn_resolve_citation', async () => {
    await owner.query(
      `insert into src_tombstones (dataset, id_hash, deleted_on) values ($1, $2, '2026-10-03')
         on conflict do nothing`,
      [kudos.id, tombstoneHash(kudos.id, 'borte')],
    );
    await owner.query(
      `insert into src_documents (dataset, id, owners, record, metadata_hash, state, earlier_ids, change)
         values ($1, 'a', array['p1'], '{}', 'h', 'stored', array['a-gammel'], 2)
         on conflict do nothing`,
      [kudos.id],
    );
    const router = new KnowledgeRouter({
      catalog: {
        endpoints: { knowledge: { engine: 'pgvector', options: { connection: 'knowledge' } } },
        datasets: [
          {
            id: kudos.id,
            endpoint: 'knowledge',
            residency: 'norway',
            filters: kudos.filters,
            valueTypes: kudos.valueTypes,
            options: {},
            generation: kudosGeneration,
          },
        ],
      },
      adapters: [readEngine().adapter],
      secrets: envSecrets({}),
    });
    const port = router.open(
      { kind: 'dataset', id: kudos.id },
      {
        tenant: '991825827',
        principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
        task: 't1',
        signal,
        meter: async () => undefined,
      },
    );
    expect(await port.resolveCitations?.(['a', 'a-gammel', 'borte', 'ingen'])).toEqual([
      { cited: 'a', status: 'found', document: 'a', title: 'Rapport a' },
      { cited: 'a-gammel', status: 'earlier', document: 'a', title: 'Rapport a' },
      { cited: 'borte', status: 'withdrawn', withdrawnOn: '2026-10-03' },
      { cited: 'ingen', status: 'unknown' },
    ]);
  });

  it('every read function returns the data version of the server that answered', async () => {
    const versioned = dataset('digdir/versjon', 8);
    const generation = 'g-20261103-versjon';
    const elsewhereWorker = openKnowledgePools(
      { ...elsewhere.source, user: 'knowledge_worker' },
      'worker',
    );
    try {
      const elsewhereWriter = pgvectorEngine({
        pool: elsewhere.admin,
        knowledge: elsewhereWorker.pools,
      }).writer.connect(endpoint, { signal }) as IndexWriter<PgvectorDatasetOptions>;
      const docs = [doc('v', 8, { type: ['rapport'] })];
      await fill(versioned, generation, docs);
      await elsewhereWriter.prepare(versioned, generation);
      for (const d of docs) await elsewhereWriter.store(versioned, generation, d);
      await elsewhereWriter.promote(versioned, generation);
    } finally {
      await elsewhereWorker.close();
    }
    await primary.admin.query(`update kn_generations set data_version = 7 where generation = $1`, [
      generation,
    ]);
    await elsewhere.admin.query(
      `update kn_generations set data_version = 9 where generation = $1`,
      [generation],
    );
    const calls = [
      `select data_version from kn_search($1, $2, 'chunks', 'text', 'lønn', null, null, '[]', 5, 50, 60)`,
      `select data_version from kn_fetch($1, $2, array['v#0'])`,
      `select data_version from kn_range($1, $2, 'v', 0, 1)`,
      `select data_version from kn_facets($1, $2, array['type'], '[]')`,
      `select data_version from kn_documents($1, $2, null, '[]', 10, 0)`,
      `select data_version from kn_resolve_citation($1, $2, array['v', 'ingen'], array['x', 'y'])`,
      `select (kn_generation($1, $2)->>'dataVersion')::bigint as data_version`,
    ];
    for (const [server, version] of [
      [primary, '7'],
      [elsewhere, '9'],
    ] as const) {
      const pool = readerPool(server);
      for (const sql of calls) {
        const rows = await asReader<{ data_version: string }>(
          sql,
          [versioned.id, generation],
          [versioned.id],
          pool,
        );
        expect(rows.length, sql).toBeGreaterThan(0);
        expect(new Set(rows.map((r) => r.data_version)), sql).toEqual(new Set([version]));
      }
    }

    const config = routed(versioned, generation);
    for (const [read, version] of [
      [readerPool(elsewhere), 9],
      [readerPool(primary), 7],
    ] as const) {
      const connection = connectionOf(readEngine({ read, reader: api.pools.reader as pg.Pool }));
      await connection.fetch(config, ['v#0'], signal);
      expect(await connection.served?.(config, signal)).toEqual({
        generation,
        dataVersion: version,
      });
    }
    // A read pool without the generation sends the read to the primary, whose version is recorded.
    const lacking = connectionOf(
      readEngine({ read: readerPool(elsewhere), reader: api.pools.reader as pg.Pool }),
    );
    const onPrimary = routed(kudos, kudosGeneration);
    await primary.admin.query(`update kn_generations set data_version = 5 where generation = $1`, [
      kudosGeneration,
    ]);
    await lacking.fetch(onPrimary, ['a#0'], signal);
    expect(await lacking.served?.(onPrimary, signal)).toEqual({
      generation: kudosGeneration,
      dataVersion: 5,
    });
    // An empty answer still reports the version of the server that gave it.
    const empty = connectionOf(
      readEngine({ read: readerPool(elsewhere), reader: api.pools.reader as pg.Pool }),
    );
    expect(await empty.fetch(config, ['finnes-ikke'], signal)).toEqual([]);
    expect(await empty.served?.(config, signal)).toEqual({ generation, dataVersion: 9 });
  });

  it('search reads through the read pool and writes nothing', async () => {
    // Sessions on this read pool cannot write, so a search that wrote would fail.
    const read = readerPool(primary, ' -c default_transaction_read_only=on');
    const reader = readerPool(primary);
    const primaryConnect = vi.spyOn(reader, 'connect');
    const connection = connectionOf(readEngine({ read, reader }));
    const [result] = await connection.search(
      routed(kudos, kudosGeneration),
      [{ query: 'tilskudd', profile: 'content' }],
      signal,
    );
    expect(result?.hits.length).toBeGreaterThan(0);
    expect(result?.warning).toBeUndefined();
    expect(primaryConnect).not.toHaveBeenCalled();
  });

  it('a search on a server that lacks its generation, or a replica that does not answer, goes to the primary', async () => {
    const lacking = readerPool(elsewhere);
    const silent = new pg.Pool({
      host: '127.0.0.1',
      port: 1,
      user: 'knowledge_api',
      password: loginPassword,
      connectionTimeoutMillis: 2000,
    });
    extraPools.push(silent);
    for (const read of [lacking, silent]) {
      const connection = connectionOf(readEngine({ read, reader: api.pools.reader as pg.Pool }));
      const [result] = await connection.search(
        routed(kudos, kudosGeneration),
        [{ query: 'tilskudd', profile: 'content' }],
        signal,
      );
      expect(result?.hits.map((h) => h.document)).toContain('a');
      expect(await connection.fetch(routed(kudos, kudosGeneration), ['a#0'], signal)).toHaveLength(
        1,
      );
    }
  });

  it('a read host that did not answer is skipped for a while, so each read does not wait for it again', async () => {
    const silent = new pg.Pool({
      host: '127.0.0.1',
      port: 1,
      user: 'knowledge_api',
      password: loginPassword,
      connectionTimeoutMillis: 2000,
    });
    extraPools.push(silent);
    const tried = vi.spyOn(silent, 'connect');
    const connection = connectionOf(
      readEngine({ read: silent, reader: api.pools.reader as pg.Pool }),
    );
    for (let i = 0; i < 3; i += 1)
      expect(await connection.fetch(routed(kudos, kudosGeneration), ['a#0'], signal)).toHaveLength(
        1,
      );
    expect(tried).toHaveBeenCalledTimes(1);
  });

  it('a refusal on the read pool reaches the caller as forbidden, as on the primary', async () => {
    // Without the reader role the login may execute no read function.
    const roleless = new pg.Pool({ ...primary.source, user: 'knowledge_api' });
    extraPools.push(roleless);
    for (const pools of [
      { read: roleless, reader: api.pools.reader as pg.Pool },
      { reader: roleless },
    ]) {
      const connection = connectionOf(readEngine(pools));
      await expect(
        connection.fetch(routed(kudos, kudosGeneration), ['a#0'], signal),
      ).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('a range filter on the knowledge server matches only a scalar value, never a list', async () => {
    const dated = dataset('digdir/datoer', 0, { filters: { dates: 'range', year: 'range' } });
    const generation = 'g-20261102-datoer';
    await fill(dated, generation, [
      doc('enkel', 0, { dates: '2002-01-10', year: 2002 }),
      doc('liste', 0, { dates: ['2002-01-05', '1990-01-01'], year: [2002, 1990] }),
    ]);
    const config = routed(dated, generation);
    const connection = connectionOf();
    for (const filters of [{ dates: { gte: '2002-01-01' } }, { year: { gte: 2000 } }]) {
      const page = await connection.documents?.(config, { filters }, signal);
      expect(page?.documents.map((d) => d.id)).toEqual(['enkel']);
    }
  });

  it('a document listing past its last page still counts every document', async () => {
    const page = await connectionOf().documents?.(
      routed(kudos, kudosGeneration),
      { limit: 10, offset: 50 },
      signal,
    );
    expect(page).toEqual({ documents: [], found: 2 });
  });

  it('a generation the catalog names but no partition holds yet reads as empty on the primary', async () => {
    const prepared = 'g-20261102-ikke-klar';
    await writer().prepare(kudos, prepared);
    const connection = connectionOf();
    for (const generation of [prepared, 'g-20261102-finnes-ikke']) {
      const config = routed(kudos, generation);
      const [result] = await connection.search(
        config,
        [{ query: 'tilskudd', profile: 'content' }],
        signal,
      );
      expect(result?.hits).toEqual([]);
      expect(await connection.fetch(config, ['a#0'], signal)).toEqual([]);
      expect(await connection.range(config, 'a', 0, 5, signal)).toEqual([]);
      expect(await connection.facets(config, ['type'], {}, signal)).toEqual({ type: [] });
      expect(await connection.documents?.(config, {}, signal)).toEqual({ documents: [], found: 0 });
    }
  });

  it('a statement timeout on the read pool is not repeated on the primary', async () => {
    const read = readerPool(primary);
    const reader = readerPool(primary);
    const primaryConnect = vi.spyOn(reader, 'connect');
    const connection = connectionOf(readEngine({ read, reader }), 300);
    // Warm the recipe so the search itself is what waits.
    await connection.search(
      routed(kudos, kudosGeneration),
      [{ query: 'lønn', profile: 'content' }],
      signal,
    );
    const blocker = await owner.connect();
    try {
      await blocker.query('begin');
      await blocker.query(
        `lock table ${partitionOf('kn_chunks', kudosGeneration)} in access exclusive mode`,
      );
      await expect(
        connection.fetch(routed(kudos, kudosGeneration), ['a#0'], signal),
      ).rejects.toMatchObject({ code: '57014' });
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    expect(primaryConnect).not.toHaveBeenCalled();
  });

  it('a query is embedded with the model and parsed with the text configuration of the generation it reads', async () => {
    const built = dataset('digdir/oppskrift', 8, {
      embedding: { model: 'fake/gammel', dimensions: 8 },
      options: { textSearchConfig: 'simple' },
    });
    await fill(built, 'g-20261102-oppskrift', [doc('c', 8, {}, 'Tilskuddene ble fordelt')]);
    const models: (string | undefined)[] = [];
    const engine = readEngine(api.pools, (d) => ({
      embed: async (texts) => {
        models.push(d.embedding?.model);
        return texts.map((t) => fixtureVector(t, d.embedding?.dimensions ?? 0));
      },
    }));
    const catalog: Dataset = routed(
      {
        ...built,
        embedding: { model: 'fake/ny', dimensions: 8 },
        options: {
          textSearchConfig: 'norwegian',
          profiles: {
            ord: { target: 'chunks', mode: 'text' },
            mening: { target: 'chunks', mode: 'vector' },
          },
        },
      },
      'g-20261102-oppskrift',
    );
    const [words, meaning] = await connectionOf(engine).search(
      catalog,
      [
        { query: 'tilskuddene', profile: 'ord' },
        { query: 'tilskuddene', profile: 'mening' },
      ],
      signal,
    );
    // Norwegian stems the query to `tilskudd`; the generation was parsed with `simple`.
    expect(words?.hits.map((h) => h.document)).toEqual(['c', 'c']);
    expect(meaning?.warning).toBeUndefined();
    expect(meaning?.hits.length).toBeGreaterThan(0);
    expect(models).toEqual(['fake/gammel']);
  });

  it("vector search uses the partition's HNSW index for two dimension sizes, keyword search its GIN index, and a filter on a declared field its partition's filter index, for the SQL the read functions run", async () => {
    const small = dataset('digdir/plan-liten', 1536, {
      filters: { type: 'multiselect', year: 'range', date: 'range' },
    });
    const large = dataset('digdir/plan-stor', 3072);
    await fill(small, 'g-20261102-plan-1', [doc('p', 1536, { type: ['rapport'], year: 2024 })]);
    await fill(large, 'g-20261102-plan-2', [doc('q', 3072, { type: ['evaluering'], year: 2021 })]);
    const statement = async (
      d: Dataset,
      generation: string,
      target: string,
      mode: string,
      query: string,
      filters: unknown[] = [],
    ) => {
      const dims = d.embedding?.dimensions ?? 0;
      const { rows } = await owner.query<{ sql: string }>(
        `select kn_search_sql($1, $2, $3, $4, $5, $6::halfvec, null, $7::jsonb, 5, 50, 60) as sql`,
        [
          d.id,
          generation,
          target,
          mode,
          query,
          mode === 'text' ? null : JSON.stringify(vector(dims, 3)),
          JSON.stringify(filters),
        ],
      );
      return rows[0]?.sql ?? '';
    };
    const plan = async (sql: string, { ordered = false } = {}) => {
      const client = await owner.connect();
      try {
        await client.query('begin');
        await client.query('set local enable_seqscan = off');
        if (ordered) await client.query('set local enable_sort = off');
        const { rows } = await client.query<{ 'QUERY PLAN': string }>(`explain ${sql}`);
        return rows.map((r) => r['QUERY PLAN']).join('\n');
      } finally {
        await client.query('rollback');
        client.release();
      }
    };

    for (const [d, generation] of [
      [small, 'g-20261102-plan-1'],
      [large, 'g-20261102-plan-2'],
    ] as const) {
      const chunks = partitionOf('kn_chunks', generation);
      expect(
        await plan(await statement(d, generation, 'chunks', 'vector', 'lønn'), { ordered: true }),
      ).toContain(`Index Scan using ${chunks}_vec on ${chunks}`);
    }

    const chunks = partitionOf('kn_chunks', 'g-20261102-plan-1');
    const docs = partitionOf('kn_docs', 'g-20261102-plan-1');
    await owner.query(
      `insert into ${docs} (dataset, generation, id, fields, config)
         select 'digdir/plan-liten', 'g-20261102-plan-1', 'bulk-' || n,
           jsonb_build_object('type', jsonb_build_array('notat'), 'year', 1990 + n % 20,
             'date', (date '2000-01-01' + n)::text), 'norwegian'
         from generate_series(1, 1000) n`,
    );
    await owner.query(
      `insert into ${chunks} (dataset, generation, id, doc_id, position, text, config)
         select 'digdir/plan-liten', 'g-20261102-plan-1', 'bulk-' || n, 'bulk-' || n, 0, 'budsjett ' || n, 'norwegian'
         from generate_series(1, 1000) n`,
    );
    await owner.query(`analyze ${docs}`);
    await owner.query(`analyze ${chunks}`);
    expect(
      await plan(await statement(small, 'g-20261102-plan-1', 'chunks', 'text', 'tilskudd')),
    ).toMatch(new RegExp(`Bitmap Index Scan on ${chunks}_tsv`));
    expect(
      await plan(
        await statement(small, 'g-20261102-plan-1', 'docs', 'text', '*', [
          { field: 'type', op: 'in', values: ['rapport'] },
        ]),
      ),
    ).toMatch(new RegExp(`Bitmap Index Scan on ${docs}_fields`));
    expect(
      await plan(
        await statement(small, 'g-20261102-plan-1', 'docs', 'text', '*', [
          { field: 'year', op: 'int', gte: 2020, lte: 2024 },
        ]),
      ),
    ).toMatch(new RegExp(`(Index Scan using|Bitmap Index Scan on) ${docs}_r_\\w+`));
    const dates = filterRows(small, { date: { gte: '2002-01-01', lte: '2002-02-01' } });
    expect(dates).toEqual([{ field: 'date', op: 'str', gte: '2002-01-01', lte: '2002-02-01' }]);
    expect(
      await plan(await statement(small, 'g-20261102-plan-1', 'docs', 'text', '*', dates)),
    ).toMatch(new RegExp(`(Index Scan using|Bitmap Index Scan on) ${docs}_r_\\w+`));
  });
});

let seeded = 0;
const generationFor = (name: string) => {
  seeded += 1;
  return `g-contract-${seeded}-${name.length}`;
};

const adapterTarget =
  (withEmbedding: boolean) =>
  async ({ dataset: d }: { dataset: { id: string } }) => {
    const embedding = { model: 'fixture', dimensions: 32 };
    const config: Dataset = {
      id: d.id,
      filters: fixtureFilters,
      options: {},
      ...(withEmbedding ? { embedding } : {}),
    };
    const generation = generationFor(d.id);
    await seedCorpus(writer(), config, undefined, generation);
    return {
      adapter: readEngine().adapter,
      endpoint,
      ...(withEmbedding ? { embedding } : {}),
      generation: () => generation,
      failingRequest: { query: 'tilskudd '.repeat(300) },
    };
  };

knowledgeAdapterContract('pgvector on the knowledge server', adapterTarget(false));
knowledgeAdapterContract('pgvector on the knowledge server with embedding', adapterTarget(true));

/** Generation ids are unique across datasets on the knowledge server, so each run's `g1` gets its own. */
const catalogWriter = (inner: IndexWriter, prefix: string) => {
  let active: string | undefined;
  const real = (generation: string) => `${prefix}-${generation}`;
  const at = (d: DatasetConfig): DatasetConfig => {
    const rest: DatasetConfig = { ...d };
    delete rest.generation;
    return active ? { ...rest, generation: real(active) } : rest;
  };
  const writer: IndexWriter = {
    prepare: (d, g) => inner.prepare(at(d), real(g)),
    store: (d, g, document) => inner.store(at(d), real(g), document),
    promote: (d, g) => inner.promote(at(d), real(g)),
    drop: (d, g, options) => inner.drop(at(d), real(g), options),
    active: async (d) => (await inner.active(at(d)))?.slice(prefix.length + 1),
    stats: (d, g) => inner.stats(at(d), real(g)),
    read: (d, g) => (inner.read as NonNullable<IndexWriter['read']>)(at(d), g && real(g)),
  };
  return {
    writer,
    activate: (generation: string) => {
      active = generation;
    },
    generation: () => (active ? real(active) : undefined),
  };
};

let writerRuns = 0;
const writerTarget =
  (withEmbedding: boolean) =>
  async ({ dataset: d }: { dataset: { id: string; filters: DatasetConfig['filters'] } }) => {
    writerRuns += 1;
    const embedding = { model: 'fixture', dimensions: 32 };
    const catalog = catalogWriter(writer() as IndexWriter, `w${writerRuns}`);
    return {
      adapter: readEngine().adapter,
      endpoint,
      ...(withEmbedding ? { embedding } : {}),
      writer: catalog.writer,
      activate: catalog.activate,
      generation: catalog.generation,
      // The knowledge server stores vectors as halfvec.
      vectorDigits: 3,
      dataset: { ...d, options: {}, ...(withEmbedding ? { embedding } : {}) },
    };
  };

indexWriterContract('pgvector on the knowledge server', writerTarget(false));
indexWriterContract('pgvector on the knowledge server with embedding', writerTarget(true));

describeContract('pgvector on the knowledge server', knowledgeContract, async () => {
  const generation = 'g-contract-runtime';
  await seedCorpus(
    writer(),
    { id: 'contract/runtime', filters: fixtureFilters, options: {} },
    undefined,
    generation,
  );
  return {
    subject: knowledgeContractSubject({
      adapter: readEngine().adapter,
      datasetOptions: {},
      endpointOptions: { connection: 'knowledge' },
      generation,
    }),
  };
});
