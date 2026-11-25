import type { DatasetConfig } from '@genai/port-knowledge';
import type { Pool, PoolClient } from 'pg';
import {
  attachGeneration,
  dropGeneration,
  generationOf,
  knowledgeTables,
  partitionOf,
} from './partitions.js';

/**
 * The first key of every generation's advisory lock; the second is `hashtext(generation)`. Writers
 * take it shared inside their transaction and VACUUM takes it exclusively, so VACUUM never runs
 * beside a write: pgvector 0.8.2 can corrupt an HNSW index when it does (ADR 0042, "Heavy work").
 */
export const generationLockSpace = 1_802_398_464;

/** How long VACUUM waits for the writers holding its generation before it gives up. */
export const vacuumLockTimeoutMs = 5 * 60_000;

/** `vacuum_cost_delay` outside the night window (ADR 0042, "Heavy work"). */
export const throttledVacuumDelay = '2ms';

/**
 * The `application_name` of every heavy session, so a later try can find one its worker left
 * behind: the database keeps a VACUUM and its session lock after the worker stops (issue 948).
 */
export const heavyApplication = 'genki-heavy';

/**
 * Takes the generation's lock shared for the caller's transaction, without waiting. A VACUUM that
 * holds the lock, or waits for it, makes this fail, so writers give way instead of queueing.
 */
export const tryGenerationWrite = async (client: PoolClient, generation: string) => {
  const { rows } = await client.query<{ ok: boolean }>(
    `select pg_try_advisory_xact_lock_shared($1::int, hashtext($2)) as ok`,
    [generationLockSpace, generation],
  );
  return rows[0]?.ok === true;
};

/**
 * Whether a writer would get the generation's lock now: one statement in a transaction of its own,
 * so the lock ends with it and never stays on a pooled connection.
 */
export const generationWritable = async (pool: Pool, generation: string) => {
  const { rows } = await pool.query<{ ok: boolean }>(
    `select pg_try_advisory_xact_lock_shared($1::int, hashtext($2)) as ok`,
    [generationLockSpace, generation],
  );
  return rows[0]?.ok === true;
};

const partitionsOf = (generation: string) =>
  knowledgeTables.map((table) => partitionOf(table, generation));

/** Runs heavy work on a connection of its own, which is closed after, so no session setting leaks. */
const onSession = async <T>(owner: Pool, run: (client: PoolClient) => Promise<T>) => {
  const client = await owner.connect();
  try {
    return await run(client);
  } finally {
    client.release(true);
  }
};

const setSession = (client: PoolClient, name: string, value: string) =>
  client.query(`select set_config($1, $2, false)`, [name, value]);

export interface MaintenanceOptions {
  /** `max_parallel_maintenance_workers` for the session; PostgreSQL's default when unset. */
  maintenanceWorkers?: number;
  /** Called with the session's backend pid, so a build can be watched and cancelled. */
  onBackend?: (pid: number) => void;
  /** The job the work runs for, which names its session (`genki-heavy <job>`). */
  job?: string;
}

const prepareSession = async (client: PoolClient, options: MaintenanceOptions) => {
  await setSession(
    client,
    'application_name',
    options.job ? `${heavyApplication} ${options.job}` : heavyApplication,
  );
  if (options.maintenanceWorkers !== undefined)
    await setSession(
      client,
      'max_parallel_maintenance_workers',
      String(options.maintenanceWorkers),
    );
  if (options.onBackend) {
    const { rows } = await client.query<{ pid: number }>(`select pg_backend_pid() as pid`);
    if (rows[0]) options.onBackend(rows[0].pid);
  }
};

export interface VacuumOptions extends MaintenanceOptions {
  /** `ANALYZE` the partitions first, before the lock, so search plans are right within minutes. */
  analyze?: boolean;
  freeze?: boolean;
  /** Outside the night window: `vacuum_cost_delay` 2 ms. */
  throttled: boolean;
  lockTimeoutMs?: number;
  /**
   * With `analyze`: when the chunks written since the last VACUUM pass this share of the live ones, rebuild the
   * HNSW indexes from the live rows before the VACUUM, which then has nothing to repair (#983).
   */
  rebuildAbove?: number;
  /**
   * End every other heavy session that holds the generation's lock first: only a
   * `knowledge.build` job asks, since those run one at a time per server (issue 948).
   */
  takeOver?: boolean;
  /** Called with each leftover heavy session that held the lock and was ended. */
  onTakeover?: (pid: number) => void;
}

export interface VacuumResult {
  /** Whether the HNSW indexes were rebuilt before the VACUUM. */
  rebuilt: boolean;
  /** The chunks written since the last VACUUM, and the live ones the `ANALYZE` counted. */
  written?: number;
  live?: number;
}

/** The advisory lock's two keys as `pg_locks` shows them: `classid`, `objid`, `objsubid` 2. */
const lockRows = `l.locktype = 'advisory' and l.objsubid = 2 and l.classid::bigint = $1
  and l.objid::bigint = (hashtext($2)::bigint + 4294967296) % 4294967296`;

/**
 * Ends every other session of a `knowledge.build` job (`genki-heavy <job>`) that holds the
 * generation's lock exclusively, or waits for it: those jobs run one at a time per server, so such
 * a session is one whose worker has stopped (issue 948). The reconciler's own VACUUM names no job,
 * and writers take the lock shared; neither is ever ended.
 */
const endLeftovers = async (owner: Pool, generation: string, own: number) => {
  const ended: number[] = [];
  await asLogin(owner, async (client) => {
    const { rows } = await client.query<{ pid: number; ended: boolean }>(
      `select l.pid, pg_terminate_backend(l.pid) as ended
         from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where ${lockRows} and l.mode = 'ExclusiveLock' and l.pid <> $3
          and a.application_name like $4 || ' %'`,
      [generationLockSpace, generation, own, heavyApplication],
    );
    ended.push(...rows.filter((row) => row.ended).map((row) => row.pid));
  });
  return ended;
};

/** Rebuilds the generation's HNSW indexes concurrently, after dropping a cancelled try's copies. */
const reindexOn = async (client: PoolClient, generation: string) => {
  for (const table of ['kn_chunks', 'kn_phrases'] as const) {
    const index = `${partitionOf(table, generation)}_vec`;
    // A REINDEX CONCURRENTLY cancelled half-way leaves an invalid `_ccnew` copy, or after its
    // swap an invalid `_ccold` one, that nothing else drops.
    const { rows: leftovers } = await client.query<{ name: string }>(
      `select c.relname as name from pg_index i join pg_class c on c.oid = i.indexrelid
        where not i.indisvalid and c.relname like $1`,
      [`${index}\\_cc%`],
    );
    for (const { name } of leftovers)
      await client.query(`drop index concurrently if exists ${name}`);
    const { rows } = await client.query<{ found: string | null }>(
      `select to_regclass($1)::text as found`,
      [index],
    );
    if (rows[0]?.found) await client.query(`reindex index concurrently ${index}`);
  }
  await client.query(`update kn_generations set recall_baseline = null where generation = $1`, [
    generation,
  ]);
};

/**
 * VACUUMs a generation's three partitions under its lock, taken exclusively: it waits for the
 * writers that hold it, and while it waits, new writers give way (ADR 0042, "Heavy work"). With
 * `analyze`, the partitions are analyzed first, outside the lock, and a generation a run has
 * mostly replaced gets its HNSW indexes rebuilt under the lock before the VACUUM.
 */
export const vacuumGeneration = (owner: Pool, generation: string, options: VacuumOptions) =>
  onSession(owner, async (client): Promise<VacuumResult> => {
    await setSession(client, 'vacuum_cost_delay', options.throttled ? throttledVacuumDelay : '0');
    await prepareSession(client, options);
    const partitions = partitionsOf(generation).join(', ');
    // A leftover VACUUM also holds its partitions, which the ANALYZE would wait on, so it goes first.
    if (options.takeOver) {
      const { rows: own } = await client.query<{ pid: number }>(`select pg_backend_pid() as pid`);
      for (const pid of await endLeftovers(owner, generation, own[0]?.pid ?? 0))
        options.onTakeover?.(pid);
    }
    // ANALYZE leaves the HNSW indexes alone, so it needs no lock and runs beside writes.
    if (options.analyze) await client.query(`analyze ${partitions}`);
    await setSession(client, 'lock_timeout', `${options.lockTimeoutMs ?? vacuumLockTimeoutMs}ms`);
    await client.query(`select pg_advisory_lock($1::int, hashtext($2))`, [
      generationLockSpace,
      generation,
    ]);
    await setSession(client, 'lock_timeout', '0');
    let result: VacuumResult = { rebuilt: false };
    if (options.analyze && options.rebuildAbove !== undefined) {
      // Rows written since the last VACUUM, not `n_dead_tup`: an ANALYZE by this login counted 0
      // of 24 deleted rows in a test, and overwrites the count. Every write to an attached
      // generation replaces a document, so what it wrote is what the VACUUM would repair.
      const { rows } = await client.query<{ written: string; live: string }>(
        `select n_ins_since_vacuum::text as written, n_live_tup::text as live
           from pg_stat_user_tables where relid = to_regclass($1)`,
        [partitionOf('kn_chunks', generation)],
      );
      const written = Number(rows[0]?.written ?? 0);
      const live = Number(rows[0]?.live ?? 0);
      const rebuilt = written > options.rebuildAbove * live;
      if (rebuilt) await reindexOn(client, generation);
      result = { rebuilt, written, live };
    }
    await client.query(`vacuum ${options.freeze ? '(freeze) ' : ''}${partitions}`);
    return result;
  });

/** How long a stand-alone ANALYZE waits for its partitions' lock. */
export const analyzeLockTimeoutMs = 30_000;

/** `ANALYZE` of a generation's partitions alone, for a heavy run whose VACUUM waits for the window. */
export const analyzeGeneration = (
  owner: Pool,
  generation: string,
  options: { throttled: boolean },
) =>
  onSession(owner, async (client) => {
    await setSession(client, 'vacuum_cost_delay', options.throttled ? throttledVacuumDelay : '0');
    // The reconciler waits for it, so it gives up rather than wait long for a VACUUM's table lock.
    await setSession(client, 'lock_timeout', `${analyzeLockTimeoutMs}ms`);
    await prepareSession(client, {});
    await client.query(`analyze ${partitionsOf(generation).join(', ')}`);
  });

/** Builds a loaded generation's indexes and attaches it (#137's steps), with the given workers. */
export const buildGeneration = (
  owner: Pool,
  dataset: DatasetConfig,
  generation: string,
  options: MaintenanceOptions,
) =>
  onSession(owner, async (client) => {
    await prepareSession(client, options);
    await attachGeneration(client, dataset, generation);
  });

/** Rebuilds the generation's HNSW indexes without blocking search, and forgets its recall baseline. */
export const reindexGeneration = (owner: Pool, generation: string, options: MaintenanceOptions) =>
  onSession(owner, async (client) => {
    await prepareSession(client, options);
    await reindexOn(client, generation);
  });

/** Reads the generations' indexes back into memory after heavy work; nothing without pg_prewarm. */
export const prewarmIndexes = async (owner: Pool, generations: string[]) => {
  const tables = generations.flatMap(partitionsOf);
  if (tables.length === 0) return 0;
  try {
    const { rows } = await owner.query<{ blocks: string | null }>(
      `select sum(pg_prewarm(i.indexrelid))::text as blocks
         from pg_index i
        where i.indrelid = any(select to_regclass(t) from unnest($1::text[]) t)`,
      [tables],
    );
    return Number(rows[0]?.blocks ?? 0);
  } catch (error) {
    if ((error as { code?: string }).code === '42883') return undefined;
    throw error;
  }
};

/** The chunks a generation holds, which decides whether its VACUUM or build is heavy. */
export const generationChunks = async (db: Pool, generation: string) => {
  const { rows } = await db.query<{ chunks: string }>(
    `select count(*)::text as chunks from ${partitionOf('kn_chunks', generation)}`,
  );
  return Number(rows[0]?.chunks ?? 0);
};

/**
 * Generations whose oldest partition is past half of `autovacuum_freeze_max_age`: PostgreSQL
 * starts an anti-wraparound autovacuum even with autovacuum off, which takes no advisory lock.
 */
export const generationsToFreeze = async (owner: Pool) => {
  const { rows: generations } = await owner.query<{ generation: string }>(
    `select generation from kn_generations order by generation`,
  );
  const tables = generations.flatMap(({ generation }) =>
    partitionsOf(generation).map((name) => ({ generation, name })),
  );
  if (tables.length === 0) return [];
  const { rows } = await owner.query<{ name: string; age: number; max: number }>(
    `select t.name, age(c.relfrozenxid)::int as age,
            current_setting('autovacuum_freeze_max_age')::int as max
       from unnest($1::text[]) as t(name)
       join pg_class c on c.oid = to_regclass(t.name)`,
    [tables.map((t) => t.name)],
  );
  const old = new Set(rows.filter((row) => row.age > row.max / 2).map((row) => row.name));
  return [...new Set(tables.filter((t) => old.has(t.name)).map((t) => t.generation))];
};

/**
 * Reads another backend of the worker's login as that login, not as the owner role it switches to:
 * PostgreSQL shows progress and allows a cancel only to a member of the backend's own role.
 */
const asLogin = (owner: Pool, run: (client: PoolClient) => Promise<unknown>) =>
  onSession(owner, async (client) => {
    await client.query('set role none');
    return run(client);
  });

/** A build's or VACUUM's progress, for the report when it is cancelled at the window's end. */
export const buildProgress = async (owner: Pool, pid: number) => {
  let found: Record<string, string> | undefined;
  await asLogin(owner, async (client) => {
    const { rows } = await client.query<Record<string, string>>(
      `select phase, blocks_done::text || '/' || blocks_total::text as blocks,
              tuples_done::text || '/' || tuples_total::text as tuples
         from pg_stat_progress_create_index where pid = $1
       union all
       select phase, heap_blks_scanned::text || '/' || heap_blks_total::text, null
         from pg_stat_progress_vacuum where pid = $1`,
      [pid],
    );
    found = rows[0];
  });
  return found?.phase
    ? {
        phase: found.phase,
        blocks: found.blocks,
        ...(found.tuples ? { tuples: found.tuples } : {}),
      }
    : undefined;
};

export interface LockHolder {
  pid: number;
  /** `genki-heavy` for a VACUUM or build, else the holder's own name. */
  application: string;
  /** When the holder's current statement started. */
  since?: string;
  progress?: Awaited<ReturnType<typeof buildProgress>>;
}

/** The session that holds the generation's lock exclusively or waits for it, for the log. */
export const lockHolder = async (owner: Pool, generation: string) => {
  let found: { pid: number; application: string; since: string | null } | undefined;
  await asLogin(owner, async (client) => {
    const { rows } = await client.query<{
      pid: number;
      application: string;
      since: string | null;
    }>(
      `select l.pid, a.application_name as application,
              to_char(a.query_start at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as since
         from pg_locks l join pg_stat_activity a on a.pid = l.pid
        where ${lockRows} and l.mode = 'ExclusiveLock'
        order by l.granted desc limit 1`,
      [generationLockSpace, generation],
    );
    found = rows[0];
  });
  if (!found) return undefined;
  const progress = await buildProgress(owner, found.pid);
  const holder: LockHolder = {
    pid: found.pid,
    application: found.application,
    ...(found.since ? { since: found.since } : {}),
    ...(progress ? { progress } : {}),
  };
  return holder;
};

export const cancelBackend = (owner: Pool, pid: number) =>
  asLogin(owner, (client) => client.query(`select pg_cancel_backend($1)`, [pid]));

/** Ends a backend's session: a stopping worker's heavy work, which a cancel misses between statements. */
export const terminateBackend = (owner: Pool, pid: number) =>
  asLogin(owner, (client) => client.query(`select pg_terminate_backend($1)`, [pid]));

export interface RecallSample {
  recall: number;
  /** The exact searches that ran. */
  queries: number;
  /** Whether `stop` ended the sample before all its searches ran. */
  cut: boolean;
}

/**
 * recall@k of the generation's chunk index against exact search, for a random sample of its own
 * vectors as queries, at the server's own `hnsw.ef_search`, below the 200 an unfiltered search
 * raises it to (issue 674). Nothing when it holds no vectors.
 * `stop` is asked before each exact search, and `signal` cancels the running query (issue 615).
 */
export const sampleRecall = async (
  owner: Pool,
  generation: string,
  options: {
    sample: number;
    k?: number;
    efSearch?: number;
    stop?: () => boolean;
    signal?: AbortSignal;
  },
): Promise<RecallSample | undefined> => {
  const k = options.k ?? 10;
  const { rows: found } = await owner.query<{ dims: number | null }>(
    `select (recipe -> 'embedding' ->> 'dimensions')::int as dims from kn_generations where generation = $1`,
    [generation],
  );
  const dims = found[0]?.dims;
  if (!dims) return undefined;
  const chunks = partitionOf('kn_chunks', generation);
  return onSession(owner, async (client) => {
    const { signal } = options;
    signal?.throwIfAborted();
    const { rows: backend } = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
    const pid = backend[0]?.pid;
    const cancel = () => {
      if (pid !== undefined) void cancelBackend(owner, pid).catch(() => undefined);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    // A cancel that reaches an idle backend is ignored, so every query asks the signal first.
    const go = () => signal?.throwIfAborted();
    await client.query('begin');
    try {
      go();
      const { rows: queries } = await client.query<{ vec: string }>(
        `select vec::text as vec from ${chunks} where vec is not null order by random() limit $1`,
        [options.sample],
      );
      if (queries.length === 0) return undefined;
      const nearest = `select id from ${chunks} where vec is not null
                        order by vec::halfvec(${dims}) <=> $1::halfvec(${dims}) limit ${k}`;
      await client.query(`set local enable_seqscan = off`);
      if (options.efSearch !== undefined)
        await client.query(`select set_config('hnsw.ef_search', $1, true)`, [
          String(options.efSearch),
        ]);
      const ann: string[][] = [];
      for (const q of queries) {
        go();
        ann.push((await client.query<{ id: string }>(nearest, [q.vec])).rows.map((r) => r.id));
      }
      await client.query(`set local enable_seqscan = on`);
      await client.query(`set local enable_indexscan = off`);
      await client.query(`set local enable_bitmapscan = off`);
      let hits = 0;
      let wanted = 0;
      let ran = 0;
      let cut = false;
      for (const [i, q] of queries.entries()) {
        go();
        if (options.stop?.()) {
          cut = true;
          break;
        }
        go();
        const exact = (await client.query<{ id: string }>(nearest, [q.vec])).rows.map((r) => r.id);
        const got = new Set(ann[i]);
        hits += exact.filter((id) => got.has(id)).length;
        wanted += exact.length;
        ran += 1;
      }
      return { recall: wanted ? hits / wanted : 1, queries: ran, cut };
    } catch (error) {
      if (signal?.aborted) throw new Error('the recall check was stopped', { cause: error });
      throw error;
    } finally {
      signal?.removeEventListener('abort', cancel);
      await client.query('rollback').catch(() => undefined);
    }
  });
};

/** The generation's recall baseline: its first measured recall, kept until a REINDEX resets it. */
export const recallBaseline = async (owner: Pool, generation: string, measured: number) => {
  const { rows } = await owner.query<{ baseline: number }>(
    `update kn_generations set recall_baseline = coalesce(recall_baseline, $2)
      where generation = $1 returning recall_baseline as baseline`,
    [generation, measured],
  );
  return rows[0]?.baseline ?? measured;
};

/** The heavy work above, bound to the knowledge server's owner login, as the worker runs it. */
export const knowledgeHeavyWork = (owner: Pool) => ({
  state: async (generation: string) => (await generationOf(owner, generation))?.state,
  drop: (generation: string) => dropGeneration(owner, generation),
  chunks: (generation: string) => generationChunks(owner, generation),
  vacuum: (generation: string, options: VacuumOptions) =>
    vacuumGeneration(owner, generation, options),
  build: (dataset: DatasetConfig, generation: string, options: MaintenanceOptions) =>
    buildGeneration(owner, dataset, generation, options),
  reindex: (generation: string, options: MaintenanceOptions) =>
    reindexGeneration(owner, generation, options),
  prewarm: (generations: string[]) => prewarmIndexes(owner, generations),
  toFreeze: () => generationsToFreeze(owner),
  progress: (pid: number) => buildProgress(owner, pid),
  lockHolder: (generation: string) => lockHolder(owner, generation),
  cancel: (pid: number) => cancelBackend(owner, pid),
  terminate: (pid: number) => terminateBackend(owner, pid),
  analyze: (generation: string, options: { throttled: boolean }) =>
    analyzeGeneration(owner, generation, options),
  recall: (
    generation: string,
    options: { sample: number; stop: () => boolean; signal: AbortSignal },
  ) => sampleRecall(owner, generation, options),
  baseline: (generation: string, measured: number) => recallBaseline(owner, generation, measured),
  datasetOf: async (generation: string) => {
    const { rows } = await owner.query<{ dataset: string }>(
      `select dataset from kn_generations where generation = $1`,
      [generation],
    );
    return rows[0]?.dataset;
  },
});
