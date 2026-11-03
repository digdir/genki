import type { DatasetConfig } from '@genai/port-knowledge';
import type { Pool, PoolClient } from 'pg';
import { attachGeneration, knowledgeTables, partitionOf } from './partitions.js';

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

/** Whether a writer would get the generation's lock now: taken shared and let go at once. */
export const generationWritable = async (pool: Pool, generation: string) => {
  const client = await pool.connect();
  try {
    const { rows } = await client.query<{ ok: boolean }>(
      `select pg_try_advisory_lock_shared($1::int, hashtext($2)) as ok`,
      [generationLockSpace, generation],
    );
    const ok = rows[0]?.ok === true;
    if (ok)
      await client.query(`select pg_advisory_unlock_shared($1::int, hashtext($2))`, [
        generationLockSpace,
        generation,
      ]);
    return ok;
  } finally {
    client.release();
  }
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
}

const prepareSession = async (client: PoolClient, options: MaintenanceOptions) => {
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
  analyze?: boolean;
  freeze?: boolean;
  /** Outside the night window: `vacuum_cost_delay` 2 ms. */
  throttled: boolean;
  lockTimeoutMs?: number;
}

/**
 * VACUUMs a generation's three partitions under its lock, taken exclusively: it waits for the
 * writers that hold it, and while it waits, new writers give way (ADR 0042, "Heavy work").
 */
export const vacuumGeneration = (owner: Pool, generation: string, options: VacuumOptions) =>
  onSession(owner, async (client) => {
    await setSession(client, 'lock_timeout', `${options.lockTimeoutMs ?? vacuumLockTimeoutMs}ms`);
    await client.query(`select pg_advisory_lock($1::int, hashtext($2))`, [
      generationLockSpace,
      generation,
    ]);
    await setSession(client, 'lock_timeout', '0');
    await setSession(client, 'vacuum_cost_delay', options.throttled ? throttledVacuumDelay : '0');
    await prepareSession(client, options);
    const flags = [options.analyze ? 'analyze' : '', options.freeze ? 'freeze' : ''].filter(
      Boolean,
    );
    await client.query(
      `vacuum ${flags.length ? `(${flags.join(', ')}) ` : ''}${partitionsOf(generation).join(', ')}`,
    );
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
    for (const table of ['kn_chunks', 'kn_phrases'] as const) {
      const index = `${partitionOf(table, generation)}_vec`;
      const { rows } = await client.query<{ found: string | null }>(
        `select to_regclass($1)::text as found`,
        [index],
      );
      if (rows[0]?.found) await client.query(`reindex index concurrently ${index}`);
    }
    await client.query(`update kn_generations set recall_baseline = null where generation = $1`, [
      generation,
    ]);
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

/** A build's progress, for the report when it is cancelled at the window's end. */
export const buildProgress = async (owner: Pool, pid: number) => {
  const { rows } = await owner.query<{
    phase: string;
    blocks_done: string;
    blocks_total: string;
    tuples_done: string;
    tuples_total: string;
  }>(
    `select phase, blocks_done::text, blocks_total::text, tuples_done::text, tuples_total::text
       from pg_stat_progress_create_index where pid = $1`,
    [pid],
  );
  const row = rows[0];
  return row
    ? {
        phase: row.phase,
        blocks: `${row.blocks_done}/${row.blocks_total}`,
        tuples: `${row.tuples_done}/${row.tuples_total}`,
      }
    : undefined;
};

export const cancelBackend = (owner: Pool, pid: number) =>
  owner.query(`select pg_cancel_backend($1)`, [pid]);

export interface RecallSample {
  recall: number;
  queries: number;
}

/**
 * recall@k of the generation's chunk index against exact search, for a random sample of its own
 * vectors as queries, at the `hnsw.ef_search` search uses. Nothing when it holds no vectors.
 */
export const sampleRecall = async (
  owner: Pool,
  generation: string,
  options: { sample: number; k?: number; efSearch?: number },
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
    await client.query('begin');
    try {
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
      for (const q of queries)
        ann.push((await client.query<{ id: string }>(nearest, [q.vec])).rows.map((r) => r.id));
      await client.query(`set local enable_seqscan = on`);
      await client.query(`set local enable_indexscan = off`);
      await client.query(`set local enable_bitmapscan = off`);
      let hits = 0;
      let wanted = 0;
      for (const [i, q] of queries.entries()) {
        const exact = (await client.query<{ id: string }>(nearest, [q.vec])).rows.map((r) => r.id);
        const got = new Set(ann[i]);
        hits += exact.filter((id) => got.has(id)).length;
        wanted += exact.length;
      }
      return { recall: wanted ? hits / wanted : 1, queries: queries.length };
    } finally {
      await client.query('rollback');
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
  cancel: (pid: number) => cancelBackend(owner, pid),
  recall: (generation: string, options: { sample: number }) =>
    sampleRecall(owner, generation, options),
  baseline: (generation: string, measured: number) => recallBaseline(owner, generation, measured),
  datasetOf: async (generation: string) => {
    const { rows } = await owner.query<{ dataset: string }>(
      `select dataset from kn_generations where generation = $1`,
      [generation],
    );
    return rows[0]?.dataset;
  },
});
