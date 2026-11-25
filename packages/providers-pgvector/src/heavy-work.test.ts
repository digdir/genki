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
  heavyApplication,
  lockHolder,
  migrateKnowledgeServer,
  terminateBackend,
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

describe("a run's closing VACUUM (#983)", () => {
  const vecFile = async (generation: string) =>
    (
      await admin.query<{ file: string }>(
        `select relfilenode::text as file from pg_class where relname = $1`,
        [`${partitionOf('kn_chunks', generation)}_vec`],
      )
    ).rows[0]?.file;
  /** Waits until `pg_stat_user_tables` counts a statistic: a backend reports its writes when idle. */
  const counted = async (
    generation: string,
    column: 'n_tup_ins' | 'n_ins_since_vacuum',
    n: number,
  ) => {
    for (let i = 0; i < 150; i += 1) {
      const { rows } = await admin.query<{ n: string }>(
        `select ${column}::text as n from pg_stat_user_tables where relname = $1`,
        [partitionOf('kn_chunks', generation)],
      );
      if (Number(rows[0]?.n) >= n) return;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${column} never reached ${n}`);
  };
  /** Writes on pools of their own, closed after, so their backends report the writes at exit. */
  const writing = async (run: (pool: pg.Pool) => Promise<void>) => {
    const own = openKnowledgePools(
      {
        host: container.getHost(),
        port: container.getPort(),
        database: container.getDatabase(),
        user: 'knowledge_worker',
        password: 'login-pw',
      },
      'worker',
    );
    try {
      await run(own.pools.owner as pg.Pool);
    } finally {
      await own.close();
    }
  };
  /** A generation of `docs` documents, vacuumed once, then `rewritten` of them written again by a run. */
  const afterRun = async (docs: number, rewritten: number) => {
    const generation = `g-heavy-${++generations}`;
    const d = dataset(`digdir/heavy-${generations}`);
    await writing(async (pool) => {
      await prepareGeneration(pool, d, generation);
      const writer = knowledgeWriterOf(pool, async () => undefined, new AbortController().signal);
      for (let i = 0; i < docs; i += 1) await writer.store(d, generation, doc(`doc-${i}`, i));
      await attachGeneration(pool, d, generation);
    });
    await counted(generation, 'n_tup_ins', docs * 3);
    await vacuumGeneration(owner, generation, { throttled: false });
    await writing(async (pool) => {
      const writer = knowledgeWriterOf(pool, async () => undefined, new AbortController().signal);
      for (let i = 0; i < rewritten; i += 1)
        await writer.store(d, generation, doc(`doc-${i}`, i + 100));
    });
    await counted(generation, 'n_ins_since_vacuum', rewritten * 3);
    return generation;
  };

  it("analyzes the generation's partitions before its closing VACUUM, even while a writer holds its lock", async () => {
    const { generation } = await loaded(2);
    const writerSession = await (worker.pools.writer as pg.Pool).connect();
    await writerSession.query('begin');
    await writerSession.query(`select pg_try_advisory_xact_lock_shared($1::int, hashtext($2))`, [
      generationLockSpace,
      generation,
    ]);
    try {
      await expect(
        vacuumGeneration(owner, generation, {
          analyze: true,
          throttled: false,
          lockTimeoutMs: 300,
        }),
      ).rejects.toMatchObject({ code: '55P03' });
      expect((await lastVacuum(generation))?.last_analyze).not.toBeNull();
      expect((await lastVacuum(generation))?.last_vacuum).toBeNull();
    } finally {
      await writerSession.query('commit');
      writerSession.release();
    }
  });

  it('rebuilds the HNSW index before the VACUUM when the chunks written pass a fifth of the live ones', async () => {
    const generation = await afterRun(10, 8);
    const before = await vecFile(generation);
    const result = await vacuumGeneration(owner, generation, {
      analyze: true,
      throttled: false,
      rebuildAbove: 0.2,
    });
    expect(result).toMatchObject({ rebuilt: true, written: 24, live: 30 });
    expect(await vecFile(generation)).not.toBe(before);
    expect((await lastVacuum(generation))?.last_vacuum).not.toBeNull();
  });

  it('keeps the plain VACUUM when the chunks written stay under a fifth of the live ones', async () => {
    const generation = await afterRun(10, 1);
    const before = await vecFile(generation);
    const result = await vacuumGeneration(owner, generation, {
      analyze: true,
      throttled: false,
      rebuildAbove: 0.2,
    });
    expect(result).toMatchObject({ rebuilt: false, written: 3, live: 30 });
    expect(await vecFile(generation)).toBe(before);
    expect((await lastVacuum(generation))?.last_vacuum).not.toBeNull();
  });

  it("holds the generation's lock through the rebuild so no write runs beside it", async () => {
    const generation = await afterRun(10, 8);
    const watched = recording(owner);
    await vacuumGeneration(watched.pool, generation, {
      analyze: true,
      throttled: false,
      rebuildAbove: 0.2,
    });
    const at = (pattern: RegExp) => watched.statements.findIndex((s) => pattern.test(s));
    const lock = at(/pg_advisory_lock\(/);
    const rebuild = at(/reindex index concurrently/);
    const vacuum = at(/^vacuum /);
    expect(lock).toBeGreaterThan(at(/^analyze /));
    expect(rebuild).toBeGreaterThan(lock);
    expect(vacuum).toBeGreaterThan(rebuild);
    // The lock is a session lock, released only when the session closes after the VACUUM.
    expect(at(/pg_advisory_unlock/)).toBe(-1);
  });
});

describe('a VACUUM that outlives its worker (issue 948)', () => {
  it("takes over a VACUUM whose worker's connection is gone instead of failing on the lock", async () => {
    const { generation } = await loaded(2);
    const chunks = partitionOf('kn_chunks', generation);
    // Another session keeps the partition, so the first VACUUM holds the generation's lock and waits.
    const keeper = await admin.connect();
    await keeper.query('begin');
    await keeper.query(`lock table ${chunks} in share update exclusive mode`);
    // The first try, whose client goes away the way a stopped worker's does.
    let lost: pg.PoolClient | undefined;
    const losing = Object.create(owner) as pg.Pool;
    losing.connect = (async () => {
      const client = await owner.connect();
      // Only the VACUUM's own session: the takeover's look-up connects through the pool too.
      lost ??= client;
      return client;
    }) as typeof owner.connect;
    let first: number | undefined;
    const firstTry = vacuumGeneration(losing, generation, {
      throttled: false,
      job: 'job-1',
      onBackend: (pid) => {
        first = pid;
      },
    });
    firstTry.catch(() => undefined);
    const held = async () =>
      (await lockHolder(owner, generation))?.pid === first && first !== undefined;
    for (let i = 0; i < 50 && !(await held()); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await lockHolder(owner, generation)).toMatchObject({
      pid: first,
      application: `${heavyApplication} job-1`,
    });
    (
      lost as unknown as { connection: { stream: { destroy(): void } } }
    ).connection.stream.destroy();
    // The database goes on with the first try's VACUUM, and its lock.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect((await lockHolder(owner, generation))?.pid).toBe(first);
    const tookOver: number[] = [];
    const retry = vacuumGeneration(owner, generation, {
      throttled: false,
      lockTimeoutMs: 5_000,
      takeOver: true,
      onTakeover: (pid) => tookOver.push(pid),
    });
    for (let i = 0; i < 50 && (await lockHolder(owner, generation))?.pid === first; i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    await keeper.query('commit');
    keeper.release();
    await retry;
    expect(tookOver).toEqual([first]);
    expect((await lastVacuum(generation))?.last_vacuum).not.toBeNull();
  }, 60_000);

  /** A `genki-heavy` session left holding the generation's lock, and its partition when `table`. */
  const leftover = async (
    generation: string,
    table = false,
    name = `${heavyApplication} job-0`,
  ) => {
    const session = await owner.connect();
    await session.query(`select set_config('application_name', $1, false)`, [name]);
    await session.query(`select pg_advisory_lock($1::int, hashtext($2))`, [
      generationLockSpace,
      generation,
    ]);
    if (table) {
      await session.query('begin');
      await session.query(
        `lock table ${partitionOf('kn_chunks', generation)} in share update exclusive mode`,
      );
    }
    const { rows } = await session.query<{ pid: number }>(`select pg_backend_pid() as pid`);
    return { session, pid: rows[0]?.pid as number };
  };

  it("ends a leftover that holds the generation's partition before the retry's ANALYZE waits on it", async () => {
    const { generation } = await loaded(2);
    const left = await leftover(generation, true);
    left.session.on('error', () => undefined);
    const tookOver: number[] = [];
    await vacuumGeneration(owner, generation, {
      analyze: true,
      throttled: false,
      lockTimeoutMs: 5_000,
      takeOver: true,
      onTakeover: (pid) => tookOver.push(pid),
    });
    expect(tookOver).toEqual([left.pid]);
    left.session.release(true);
  }, 30_000);

  it('ends no other session unless the VACUUM is asked to take over', async () => {
    const { generation } = await loaded(1);
    const left = await leftover(generation);
    try {
      await expect(
        vacuumGeneration(owner, generation, { throttled: false, lockTimeoutMs: 300 }),
      ).rejects.toMatchObject({ code: '55P03' });
      expect((await lockHolder(owner, generation))?.pid).toBe(left.pid);
    } finally {
      left.session.release(true);
    }
  });

  it("never ends a heavy session that runs for no build job, such as the reconciler's VACUUM", async () => {
    const { generation } = await loaded(1);
    const left = await leftover(generation, false, heavyApplication);
    try {
      await expect(
        vacuumGeneration(owner, generation, {
          throttled: false,
          lockTimeoutMs: 300,
          takeOver: true,
        }),
      ).rejects.toMatchObject({ code: '55P03' });
      expect((await lockHolder(owner, generation))?.pid).toBe(left.pid);
    } finally {
      left.session.release(true);
    }
  });

  it('ends an idle heavy session when the worker stops, which a cancel would not', async () => {
    const { generation } = await loaded(1);
    const left = await leftover(generation);
    left.session.on('error', () => undefined);
    await terminateBackend(owner, left.pid);
    await expect(left.session.query('select 1')).rejects.toThrow();
    left.session.release(true);
    for (let i = 0; i < 50 && (await lockHolder(owner, generation)); i += 1)
      await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await lockHolder(owner, generation)).toBeUndefined();
  });

  it("names the session that holds a generation's lock, and nothing when it is free", async () => {
    const { generation } = await loaded(1);
    expect(await lockHolder(owner, generation)).toBeUndefined();
    const session = await owner.connect();
    await session.query(`select set_config('application_name', $1, false)`, [heavyApplication]);
    await session.query(`select pg_advisory_lock($1::int, hashtext($2))`, [
      generationLockSpace,
      generation,
    ]);
    try {
      const { rows } = await session.query<{ pid: number }>(`select pg_backend_pid() as pid`);
      expect(await lockHolder(owner, generation)).toMatchObject({
        pid: rows[0]?.pid,
        application: heavyApplication,
        since: expect.stringMatching(/^\d{4}-\d\d-\d\dT/),
      });
    } finally {
      session.release(true);
    }
  });
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

  it('the recall check stops starting exact searches once told to stop, and judges the ones it ran', async () => {
    const { generation } = await loaded(30);
    let asked = 0;
    const sample = await sampleRecall(owner, generation, {
      sample: 20,
      // Asked before each exact search: five run, then it stops.
      stop: () => ++asked > 5,
    });
    expect(sample?.queries).toBe(5);
    expect(sample?.cut).toBe(true);
    expect(sample?.recall).toBeGreaterThan(0.9);
    // A sample that ran to its end was not cut.
    expect((await sampleRecall(owner, generation, { sample: 20 }))?.cut).toBe(false);
  });

  it('an expired recall check stops its query', async () => {
    const { generation } = await loaded(10);
    const chunks = partitionOf('kn_chunks', generation);
    // Another session holds the partition, so the check's first query waits on it.
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query(`lock table ${chunks} in access exclusive mode`);
      const expired = new AbortController();
      const check = sampleRecall(owner, generation, { sample: 5, signal: expired.signal });
      check.catch(() => undefined);
      // Abort once the check's query waits on the lock, not after a guessed sleep.
      for (let tries = 0; tries < 100; tries += 1) {
        const { rows: waiting } = await admin.query<{ n: number }>(
          `select count(*)::int as n from pg_stat_activity
            where wait_event_type = 'Lock' and query like $1`,
          [`%from ${chunks}%`],
        );
        if ((waiting[0]?.n ?? 0) > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expired.abort();
      const outcome = await Promise.race([
        check.then(
          () => 'finished',
          () => 'stopped',
        ),
        new Promise((resolve) => setTimeout(() => resolve('still running'), 5_000)),
      ]);
      expect(outcome).toBe('stopped');
      // Stopped on the server too, while the lock is still held: nothing waits on the partition.
      const { rows } = await admin.query(
        `select count(*)::int as waiting from pg_stat_activity
          where state = 'active' and query like $1 and pid <> pg_backend_pid()`,
        [`%from ${chunks}%`],
      );
      expect(rows[0]).toEqual({ waiting: 0 });
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });

  it('an abort that lands before the listener stops the check before its draw', async () => {
    const { generation } = await loaded(10);
    const chunks = partitionOf('kn_chunks', generation);
    // The draw would wait on this lock, and a cancel sent before the listener existed is lost.
    const holder = await admin.connect();
    try {
      await holder.query('begin');
      await holder.query(`lock table ${chunks} in access exclusive mode`);
      const expired = new AbortController();
      const { signal } = expired;
      const listen = signal.addEventListener.bind(signal);
      signal.addEventListener = ((...args: Parameters<AbortSignal['addEventListener']>) => {
        expired.abort();
        listen(...args);
      }) as AbortSignal['addEventListener'];
      const check = sampleRecall(owner, generation, { sample: 5, signal });
      check.catch(() => undefined);
      const outcome = await Promise.race([
        check.then(
          () => 'finished',
          () => 'stopped',
        ),
        new Promise((resolve) => setTimeout(() => resolve('still running'), 5_000)),
      ]);
      expect(outcome).toBe('stopped');
    } finally {
      await holder.query('rollback');
      holder.release();
    }
  });

  it('an abort between two searches stops the check', async () => {
    const { generation } = await loaded(30);
    const expired = new AbortController();
    let asked = 0;
    const check = sampleRecall(owner, generation, {
      sample: 20,
      signal: expired.signal,
      // The abort lands while no query runs, after the second exact search.
      stop: () => {
        asked += 1;
        if (asked === 3) expired.abort();
        return false;
      },
    });
    await expect(check).rejects.toThrow('the recall check was stopped');
    expect(asked).toBe(3);
  });

  it("a generation's first recall check sets its baseline, and a REINDEX resets it", async () => {
    const { generation } = await loaded(4);
    expect(await recallBaseline(owner, generation, 0.99)).toBe(0.99);
    expect(await recallBaseline(owner, generation, 0.9)).toBe(0.99);
    await reindexGeneration(owner, generation, {});
    expect(await recallBaseline(owner, generation, 0.97)).toBe(0.97);
  });
});
