import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GenerationBusy, type DatasetConfig, type IndexDocument } from '@genai/port-knowledge';
import { stopPostgres } from '@genai/providers-postgres/testing';
import {
  attachGeneration,
  buildGeneration,
  buildProgress,
  cancelBackend,
  generationChunks,
  generationLockSpace,
  generationsToFreeze,
  migrateKnowledgeServer,
  openKnowledgePools,
  partitionOf,
  prepareGeneration,
  prewarmIndexes,
  recallBaseline,
  reindexGeneration,
  sampleRecall,
  setUpKnowledgeServer,
  vacuumGeneration,
  type PgvectorDatasetOptions,
} from './index.js';
import { knowledgeRecordsOf } from './knowledge-records.js';
import { knowledgeWriterOf } from './knowledge-writer.js';

let container: StartedPostgreSqlContainer;
let admin: pg.Pool;
let worker: ReturnType<typeof openKnowledgePools>;
let owner: pg.Pool;

const dims = 8;
const dataset = (id: string): DatasetConfig<PgvectorDatasetOptions> => ({
  id,
  filters: {},
  options: {},
  embedding: { model: 'fake/embed', dimensions: dims },
});

const vector = (seed: number) =>
  Array.from({ length: dims }, (_, i) => Math.sin(seed * 7.3 + i * 1.7) + 1.1);

const doc = (id: string, seed: number): IndexDocument => ({
  id,
  title: `Tittel ${id}`,
  fields: {},
  chunks: [0, 1, 2].map((position) => ({
    id: `${id}#${position}`,
    position,
    text: `Tekst ${id} ${position}`,
    vector: vector(seed * 3 + position),
  })),
  phrases: [],
});

let generations = 0;
/** A generation loaded with `docs` documents of three chunks each, then attached. */
const loaded = async (docs = 4) => {
  const generation = `g-heavy-${++generations}`;
  const d = dataset(`digdir/heavy-${generations}`);
  await prepareGeneration(owner, d, generation);
  const writer = knowledgeWriterOf(owner, async () => undefined, new AbortController().signal);
  for (let i = 0; i < docs; i += 1) await writer.store(d, generation, doc(`doc-${i}`, i));
  await attachGeneration(owner, d, generation);
  return { generation, dataset: d };
};

/** Records every statement a pool's clients run, to read the session settings heavy work sets. */
const recording = (pool: pg.Pool) => {
  const statements: string[] = [];
  const wrapped = Object.create(pool) as pg.Pool;
  wrapped.connect = (async () => {
    const client = await pool.connect();
    const query = client.query.bind(client);
    client.query = ((text: string, values?: unknown[]) => {
      statements.push(`${text} ${JSON.stringify(values ?? [])}`);
      return query(text, values);
    }) as typeof client.query;
    return client;
  }) as typeof pool.connect;
  return { pool: wrapped, statements };
};

const lastVacuum = async (generation: string) => {
  const { rows } = await admin.query<{ last_vacuum: Date | null; last_analyze: Date | null }>(
    `select last_vacuum, last_analyze from pg_stat_user_tables where relname = $1`,
    [partitionOf('kn_chunks', generation)],
  );
  return rows[0];
};

beforeAll(async () => {
  // The lowest freeze age PostgreSQL takes, so a test can age a partition past half of it.
  container = await new PostgreSqlContainer('pgvector/pgvector:0.8.2-pg17')
    .withCommand(['postgres', '-c', 'autovacuum_freeze_max_age=100000'])
    .start();
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

describe('the VACUUM workaround for pgvector 0.8.2', () => {
  it("VACUUM never runs while a writer holds its generation's lock", async () => {
    const { generation } = await loaded();
    const writerSession = await (worker.pools.writer as pg.Pool).connect();
    await writerSession.query('begin');
    await writerSession.query(`select pg_try_advisory_xact_lock_shared($1::int, hashtext($2))`, [
      generationLockSpace,
      generation,
    ]);
    let done = false;
    const vacuum = vacuumGeneration(owner, generation, { analyze: true, throttled: false }).then(
      () => {
        done = true;
      },
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    expect(done).toBe(false);
    expect((await lastVacuum(generation))?.last_vacuum).toBeNull();
    await writerSession.query('commit');
    writerSession.release();
    await vacuum;
    expect((await lastVacuum(generation))?.last_vacuum).not.toBeNull();
    expect((await lastVacuum(generation))?.last_analyze).not.toBeNull();
  });

  it("a writer that cannot get its generation's lock gives way and writes nothing", async () => {
    const { generation, dataset: d } = await loaded(1);
    const records = knowledgeRecordsOf(worker.pools.writer as pg.Pool);
    const vacuumSession = await owner.connect();
    await vacuumSession.query(`select pg_advisory_lock($1::int, hashtext($2))`, [
      generationLockSpace,
      generation,
    ]);
    try {
      expect(await records.writable(generation)).toBe(false);
      const record = {
        number: '1',
        dataset: d.id,
        id: 'doc-0',
        record: {},
        state: null,
        change: 1,
        gone: 0,
      } as const;
      await expect(records.replace(record, generation, { skip: 'no_text' })).rejects.toBeInstanceOf(
        GenerationBusy,
      );
      await expect(records.remove(record, generation)).rejects.toBeInstanceOf(GenerationBusy);
    } finally {
      await vacuumSession.query(`select pg_advisory_unlock($1::int, hashtext($2))`, [
        generationLockSpace,
        generation,
      ]);
      vacuumSession.release();
    }
    expect(await records.writable(generation)).toBe(true);
  });

  it('VACUUM outside the window is throttled', async () => {
    const { generation } = await loaded(1);
    const throttled = recording(owner);
    await vacuumGeneration(throttled.pool, generation, { analyze: true, throttled: true });
    expect(throttled.statements.join('\n')).toContain('["vacuum_cost_delay","2ms"]');
    const full = recording(owner);
    await vacuumGeneration(full.pool, generation, { analyze: true, throttled: false });
    expect(full.statements.join('\n')).toContain('["vacuum_cost_delay","0"]');
  });

  it("a build runs with the server's vCores minus one maintenance workers", async () => {
    const d = dataset('digdir/heavy-build');
    const generation = 'g-heavy-build';
    await prepareGeneration(owner, d, generation);
    const build = recording(owner);
    let backend: number | undefined;
    await buildGeneration(build.pool, d, generation, {
      maintenanceWorkers: 3,
      onBackend: (pid) => {
        backend = pid;
      },
    });
    expect(build.statements.join('\n')).toContain('["max_parallel_maintenance_workers","3"]');
    expect(backend).toBeGreaterThan(0);
    const { rows } = await admin.query(`select state from kn_generations where generation = $1`, [
      generation,
    ]);
    expect(rows[0]?.state).toBe('attached');
  });

  it('the active indexes are prewarmed after a heavy job', async () => {
    const { generation } = await loaded();
    expect(await prewarmIndexes(owner, [generation])).toBeGreaterThan(0);
  });

  it('VACUUM (FREEZE) takes a fresh partition, not past half the freeze age, back to zero', async () => {
    const { generation } = await loaded(1);
    expect(await generationsToFreeze(owner)).not.toContain(generation);
    await admin.query(`select txid_current()`);
    await vacuumGeneration(owner, generation, { freeze: true, throttled: false });
    const { rows } = await admin.query<{ age: number }>(
      `select age(relfrozenxid)::int as age from pg_class where oid = to_regclass($1)`,
      [partitionOf('kn_chunks', generation)],
    );
    expect(rows[0]?.age).toBeLessThan(5);
  });

  it('a partition past half the freeze age is found for VACUUM (FREEZE)', async () => {
    const { generation } = await loaded(1);
    expect(await generationsToFreeze(owner)).not.toContain(generation);
    // Each committed transaction takes one transaction id: 50,500 of them age every partition.
    await admin.query(
      `do $$ begin for i in 1..50500 loop perform txid_current(); commit; end loop; end $$`,
    );
    expect(await generationsToFreeze(owner)).toContain(generation);
    await vacuumGeneration(owner, generation, { freeze: true, throttled: false });
    expect(await generationsToFreeze(owner)).not.toContain(generation);
  }, 120_000);

  it('counts the chunks a generation holds', async () => {
    const { generation } = await loaded(4);
    expect(await generationChunks(owner, generation)).toBe(12);
  });
});

describe('the knowledge writer', () => {
  it('a document with U+0000 in its title, fields, chunks and phrases is written without it', async () => {
    const generation = `g-heavy-${++generations}`;
    const d = dataset(`digdir/heavy-${generations}`);
    await prepareGeneration(owner, d, generation);
    const writer = knowledgeWriterOf(owner, async () => undefined, new AbortController().signal);

    await writer.store(d, generation, {
      id: 'nul',
      title: 'Tittel\u0000 med nulltegn',
      fields: { kind: 'rap\u0000port' },
      chunks: [{ id: 'nul#0', position: 0, text: 'Tekst\u0000 her', vector: vector(1) }],
      phrases: [{ id: 'nul#p0', chunkId: 'nul#0', text: 'Fra\u0000se', vector: vector(2) }],
    });

    const read = async (sql: string) => JSON.stringify((await admin.query(sql)).rows);
    const docs = await read(
      `select title, fields, fields_text from ${partitionOf('kn_docs', generation)}`,
    );
    const chunks = await read(`select text from ${partitionOf('kn_chunks', generation)}`);
    const phrases = await read(`select text from ${partitionOf('kn_phrases', generation)}`);
    expect(docs).toContain('Tittel med nulltegn');
    expect(docs).toContain('rapport');
    expect(chunks).toContain('Tekst her');
    expect(phrases).toContain('Frase');
    expect(docs + chunks + phrases).not.toContain('\\u0000');
  });
});

describe('builds the worker watches', () => {
  it("a build's progress is read and the build cancelled from the worker's owner login", async () => {
    // A slow index expression keeps CREATE INDEX running long enough to watch and cancel it.
    await owner.query(`create table if not exists slow_build (x int)`);
    await owner.query(`insert into slow_build select generate_series(1, 200)`);
    await owner.query(
      `create or replace function slow_id(x int) returns int immutable language sql
         as $$ select x from (select pg_sleep(0.05)) s $$`,
    );
    const session = await owner.connect();
    const { rows } = await session.query<{ pid: number }>(`select pg_backend_pid() as pid`);
    const pid = rows[0]?.pid as number;
    const building = session.query(`create index slow_build_x on slow_build ((slow_id(x)))`);
    building.catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    const progress = await buildProgress(owner, pid);
    expect(progress?.phase).toMatch(/building index/);
    await cancelBackend(owner, pid);
    await expect(building).rejects.toThrow(/canceling statement/);
    session.release(true);
  }, 60_000);
});

describe('REINDEX', () => {
  const vecIndex = (generation: string) => `${partitionOf('kn_chunks', generation)}_vec`;
  const fileOf = async (index: string) =>
    (
      await admin.query<{ file: string }>(
        `select relfilenode::text as file from pg_class where relname = $1`,
        [index],
      )
    ).rows[0]?.file;

  it("REINDEX rebuilds the generation's HNSW indexes", async () => {
    const { generation } = await loaded(4);
    const before = await fileOf(vecIndex(generation));
    expect(before).toBeDefined();
    await reindexGeneration(owner, generation, {});
    expect(await fileOf(vecIndex(generation))).not.toBe(before);
  });

  it('a cancelled REINDEX leaves no invalid index behind', async () => {
    const { generation } = await loaded(4);
    const chunks = partitionOf('kn_chunks', generation);
    // What a REINDEX CONCURRENTLY cancelled half-way leaves: an invalid copy named _ccnew.
    await owner.query(
      `create index ${vecIndex(generation)}_ccnew on ${chunks}
         using hnsw ((vec::halfvec(${dims})) halfvec_cosine_ops)`,
    );
    await admin.query(`update pg_index set indisvalid = false where indexrelid = $1::regclass`, [
      `${vecIndex(generation)}_ccnew`,
    ]);
    // And what one cancelled after its swap leaves: the old index, invalid, named _ccold.
    await owner.query(
      `create index ${vecIndex(generation)}_ccold on ${chunks}
         using hnsw ((vec::halfvec(${dims})) halfvec_cosine_ops)`,
    );
    await admin.query(`update pg_index set indisvalid = false where indexrelid = $1::regclass`, [
      `${vecIndex(generation)}_ccold`,
    ]);
    await reindexGeneration(owner, generation, {});
    const { rows } = await admin.query(
      `select relname from pg_class where relname like $1 or relname like $2`,
      [`${chunks}%ccnew%`, `${chunks}%ccold%`],
    );
    expect(rows).toEqual([]);
  });
});

describe('the recall check', () => {
  it('measures the HNSW index against exact search on its own vectors', async () => {
    const { generation } = await loaded(30);
    const sample = await sampleRecall(owner, generation, { sample: 20 });
    expect(sample?.queries).toBe(20);
    expect(sample?.recall).toBeGreaterThan(0.9);
    // An index search that may visit one candidate finds one of the ten: the index was asked.
    const starved = await sampleRecall(owner, generation, { sample: 20, efSearch: 1 });
    expect(starved?.recall).toBeLessThan(0.5);
  });

  it("a generation's first recall check sets its baseline, and a REINDEX resets it", async () => {
    const { generation } = await loaded(4);
    expect(await recallBaseline(owner, generation, 0.99)).toBe(0.99);
    expect(await recallBaseline(owner, generation, 0.9)).toBe(0.99);
    await reindexGeneration(owner, generation, {});
    expect(await recallBaseline(owner, generation, 0.97)).toBe(0.97);
  });
});
