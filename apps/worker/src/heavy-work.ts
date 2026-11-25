import {
  convertPriority,
  defaultMarkerTimeoutMs,
  heavyWorkStart,
  knowledgeConvertQueue,
  inNightWindow,
  knowledgeBuildQueue,
  knowledgeCheckQueue,
  knowledgeFillQueue,
  knowledgeKeys,
  nightlyCron,
  nightWindowEnd,
  nightWindowZone,
  queueWork,
  type JobQueue,
  type QueueWork,
} from '@genai/jobs';
import type { DatasetConfig } from '@genai/port-knowledge';
import { executionScope, type IngestionExecution } from '@genai/providers-postgres';

/** The convert queue by its name, as the night window moves its waiting jobs. */
const convertQueue = knowledgeConvertQueue(defaultMarkerTimeoutMs);

/** Session settings of heavy work; the knowledge server's provider takes the same shape. */
export interface MaintenanceOptions {
  maintenanceWorkers?: number;
  onBackend?: (pid: number) => void;
  /** The job the work runs for, which names its database session. */
  job?: string;
}

export interface VacuumOptions extends MaintenanceOptions {
  analyze?: boolean;
  freeze?: boolean;
  throttled: boolean;
  rebuildAbove?: number;
  takeOver?: boolean;
  onTakeover?: (pid: number) => void;
}

/** What a VACUUM did: whether it rebuilt the HNSW indexes first, from the chunks written and live. */
export interface VacuumResult {
  rebuilt: boolean;
  written?: number;
  live?: number;
}

/** The backends of this worker's heavy work, and whether the worker is stopping. */
export interface HeavyRunning {
  backends: Set<number>;
  stopping: boolean;
}

export const heavyRunning = (): HeavyRunning => ({ backends: new Set(), stopping: false });

/** The session holding a generation's lock, as writers that give way log it (issue 948). */
export interface LockHolder {
  pid: number;
  application: string;
  since?: string;
  progress?: unknown;
}

export interface RecallSample {
  recall: number;
  /** The exact searches that ran. */
  queries: number;
  /** Whether `stop` ended the sample before all its searches ran. */
  cut: boolean;
}

/** The knowledge server's heavy work, as the worker's owner login runs it (ADR 0042, "Heavy work"). */
export interface HeavyServer {
  /** Whether a generation is standalone, attached or being dropped; nothing when it does not exist. */
  state(generation: string): Promise<'standalone' | 'attached' | 'detaching' | undefined>;
  chunks(generation: string): Promise<number>;
  vacuum(generation: string, options: VacuumOptions): Promise<VacuumResult | undefined>;
  build(dataset: DatasetConfig, generation: string, options: MaintenanceOptions): Promise<void>;
  reindex(generation: string, options: MaintenanceOptions): Promise<void>;
  prewarm(generations: string[]): Promise<number | undefined>;
  toFreeze(): Promise<string[]>;
  progress(pid: number): Promise<unknown>;
  cancel(pid: number): Promise<unknown>;
  /** Ends a backend's session, which a cancel misses between two statements. */
  terminate(pid: number): Promise<unknown>;
  /** `ANALYZE` of a generation's partitions alone. */
  analyze(generation: string, options: { throttled: boolean }): Promise<unknown>;
  /** The session that holds the generation's lock exclusively, or nothing. */
  lockHolder?(generation: string): Promise<LockHolder | undefined>;
  /** recall@10 on a sample: `stop` is asked before each exact search, `signal` cancels it. */
  recall(
    generation: string,
    options: { sample: number; stop: () => boolean; signal: AbortSignal },
  ): Promise<RecallSample | undefined>;
  baseline(generation: string, measured: number): Promise<number>;
  /** The dataset a generation on the server belongs to. */
  datasetOf(generation: string): Promise<string | undefined>;
}

export interface HeavyDeps {
  server: HeavyServer;
  /** The knowledge server's job queue. */
  queue: Pick<JobQueue, 'send' | 'work' | 'retime' | 'schedule'>;
  /** `knowledge.nightWindow`, read again on every call. */
  window(): string;
  /** `knowledge.heavyThreshold`, in chunks. */
  threshold(): number;
  /** The catalog's datasets on the knowledge database, each with its active generation. */
  datasets(): DatasetConfig[];
  /**
   * The dataset an open engine switch fills a generation for, at the switch's endpoint: the
   * catalog does not name it until the switch is activated (ADR 0025).
   */
  datasetOfGeneration?(generation: string): Promise<DatasetConfig | undefined>;
  /** `KNOWLEDGE_VCORES`: the server's vCores, for build parallelism. */
  vcores?: number;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
  /** Adds to a run's report: a closing VACUUM records its duration there. */
  report?: (id: string, counts: Record<string, number>, mode: 'add') => Promise<void>;
  /**
   * This worker's running heavy work, which `cancelHeavyWork` cancels when the worker stops, so
   * none outlives it holding a generation's lock (issue 948).
   */
  running?: HeavyRunning;
}

/**
 * The recall check samples up to 200 of a generation's own vectors and sends a REINDEX when
 * recall@10 falls more than the margin below the generation's baseline. Measured with
 * `scripts/knowledge-recall-noise.sql` on the Kudos pilot's 20,248 page vectors (1,536 dimensions,
 * m 16, ef_construction 64, ef_search 40, pgvector 0.8.2), 20 samples per size on one unchanged
 * index: recall@10 0.9970 ± 0.0031 at 50 vectors, 0.9977 ± 0.0023 at 100, 0.9982 ± 0.0014 at 200
 * and 0.9976 ± 0.0013 at 500, lowest 0.9945 at 200. So 200 is where the spread stops shrinking.
 * A night and its baseline are two samples, so their difference spreads by about √2 · 0.0014 ≈
 * 0.002; a margin of 0.01 is five of those, three times the largest healthy gap seen (0.0037),
 * while a corrupted graph loses far more.
 *
 * Each exact search reads every vector of the partition, so a generation's queries share a
 * budget of `recallBudget` vector reads a night: 200 up to 500,000 chunks, fewer above, and never
 * under 50, which is reached at 2 million chunks (Kudos's 3 million then reads 150 million).
 * Fewer queries are noisier, by √(200 / n) as measured (0.0031 at 50 against 0.0014 at 200), so
 * the margin widens by the same factor: 0.02 at 50.
 */
export const recallSampleSize = 200;
export const recallMargin = 0.01;
export const recallBudget = recallSampleSize * 500_000;
const fewestRecallQueries = 50;

/** The margin for a recall measured on `queries` exact searches. */
export const recallMarginFor = (queries: number) =>
  Number((recallMargin * Math.sqrt(recallSampleSize / queries)).toFixed(4));

export const recallQueries = (chunks: number) => {
  const sample = Math.max(
    fewestRecallQueries,
    Math.min(recallSampleSize, Math.floor(recallBudget / Math.max(chunks, 1))),
  );
  return { sample, margin: recallMarginFor(sample) };
};

/** No exact search starts this long after the check starts (ADR 0042, "Heavy work"). */
export const recallDeadlineMs = 90 * 60_000;
/** Fewer searches cut by the deadline give no verdict (ADR 0042, "Heavy work"). */
export const fewestRecallVerdict = 20;

/** A build still running this long after the window's end is cancelled (ADR 0042, "Heavy work"). */
export const buildOverrunMs = 60 * 60_000;

/** A running `knowledge.build` job logs its phase and blocks this often (#983). */
export const buildProgressMs = 10 * 60_000;

/** Writers that give way log the lock's holder at most this often per generation (issue 948). */
export const givingWayLogMs = 60_000;

/**
 * A closing VACUUM rebuilds the HNSW indexes first when the chunks written since the last VACUUM
 * pass this share of the live ones (each write replaces a document, so leaves a dead entry): patching the graph around each removed entry reads it at random, one entry at
 * a time, and took Kudos's 13.6 GB index more than 21 h on 24 Nov, while a rebuild reads only the
 * live rows, in parallel (#983). A fifth is the issue's starting point, to be checked against the
 * first measured rebuild and VACUUM of Kudos.
 */
export const rebuildDeadShare = 0.2;

type BuildData = (typeof knowledgeBuildQueue)['payload']['_output'];

const nowOf = (deps: HeavyDeps) => deps.now?.() ?? new Date();

const tenantOf = (dataset: string) => executionScope(dataset);

const activeGenerations = (deps: HeavyDeps) =>
  deps.datasets().flatMap((d) => (d.generation ? [d.generation] : []));

const maintenance = (deps: HeavyDeps): MaintenanceOptions =>
  deps.vcores === undefined ? {} : { maintenanceWorkers: Math.max(deps.vcores - 1, 0) };

/**
 * Whether heavy work may run at full speed now: only inside a night window with an end. With the
 * window `always`, heavy jobs start at any hour, but services may be searching, so a VACUUM stays
 * throttled and a rebuild leaves half the cores to search (#983).
 */
export const fullSpeed = (deps: HeavyDeps) => {
  const now = nowOf(deps);
  return inNightWindow(deps.window(), now) && nightWindowEnd(deps.window(), now) !== undefined;
};

/** The maintenance workers of a closing VACUUM's rebuild: half the vCores outside a real window. */
const closingMaintenance = (deps: HeavyDeps): MaintenanceOptions =>
  deps.vcores === undefined || fullSpeed(deps)
    ? maintenance(deps)
    : { maintenanceWorkers: Math.max(Math.floor(deps.vcores / 2), 0) };

/**
 * The options of a run's closing `VACUUM (ANALYZE)`, which rebuilds first after a big run, but
 * not right after a build: its fresh index has nothing to repair, while every row it loaded counts
 * as written since the last VACUUM.
 */
const closingVacuum = (
  deps: HeavyDeps,
  options: MaintenanceOptions,
  how: { afterBuild?: boolean; takeOver?: boolean },
): VacuumOptions => ({
  ...options,
  ...closingMaintenance(deps),
  analyze: true,
  ...(how.afterBuild ? {} : { rebuildAbove: rebuildDeadShare }),
  ...(how.takeOver ? { takeOver: true } : {}),
  throttled: !fullSpeed(deps),
  onTakeover: (pid) => deps.log?.('knowledge build took over', { pid }),
});

/** Tracks a heavy backend in `deps.running` while its work runs. */
const tracked = (deps: HeavyDeps, onBackend?: (pid: number) => void) => {
  const pids = new Set<number>();
  return {
    onBackend: (backend: number) => {
      // Called before the session's long statement: a stopping worker starts no more heavy work.
      if (deps.running?.stopping) throw new Error('the worker is stopping');
      pids.add(backend);
      deps.running?.backends.add(backend);
      onBackend?.(backend);
    },
    done: () => {
      for (const pid of pids) deps.running?.backends.delete(pid);
    },
  };
};

/**
 * Ends this worker's running heavy work when it stops: the database would otherwise go on with a
 * VACUUM and keep the generation's lock for hours with no worker left (issue 948). It ends the
 * sessions, since a cancel is lost on one between two statements. Each job ended this way sends
 * itself again, so a deploy does not spend its retry.
 */
export const cancelHeavyWork = async (deps: HeavyDeps) => {
  if (!deps.running) return;
  deps.running.stopping = true;
  for (const pid of [...deps.running.backends]) {
    deps.log?.('knowledge build stopped with the worker', { pid });
    await deps.server
      .terminate(pid)
      .catch((error: unknown) =>
        deps.log?.('knowledge build stop failed', { pid, error: String(error) }),
      );
  }
};

/**
 * Logs, when a writer gives way, which session holds the generation's lock, since when and how far
 * it has got, at most once a minute per generation (issue 948).
 */
export const givingWay = (deps: HeavyDeps) => {
  const last = new Map<string, number>();
  return async (generation: string) => {
    const now = nowOf(deps).getTime();
    const seen = last.get(generation);
    if (seen !== undefined && now - seen < givingWayLogMs) return;
    last.set(generation, now);
    const holder = await deps.server.lockHolder?.(generation);
    deps.log?.('knowledge writers giving way', { generation, holder: holder ?? null });
  };
};

/** Sends a `knowledge.build` job to start at the next window start, or at once inside it. */
export const sendHeavy = (deps: HeavyDeps, data: BuildData) =>
  deps.queue.send(knowledgeBuildQueue, data, {
    key: knowledgeKeys.build(),
    startAfter: heavyWorkStart(deps.window(), nowOf(deps)),
  });

/** A stopping worker's job is sent again this much later, so its own poller does not take it. */
export const stoppingResendMs = 60_000;

/** Sends a job this stopping worker gives up again, for the next worker (issue 948). */
const sendForNextWorker = (deps: HeavyDeps, data: BuildData) => {
  const start = heavyWorkStart(deps.window(), nowOf(deps));
  const later = new Date(nowOf(deps).getTime() + stoppingResendMs);
  return deps.queue.send(knowledgeBuildQueue, data, {
    key: knowledgeKeys.build(),
    startAfter: start > later ? start : later,
  });
};

/**
 * The `VACUUM (ANALYZE)` a run ends with: at once below the heavy threshold (throttled outside the
 * window), or as a `knowledge.build` job naming the run above it, which keeps the run open.
 */
export const runVacuum = async (
  deps: HeavyDeps,
  run: { id: string; dataset: string },
  generation: string,
): Promise<'done' | 'sent'> => {
  if ((await deps.server.chunks(generation)) > deps.threshold()) {
    // Statistics now, not when the VACUUM's window comes: ANALYZE leaves the HNSW indexes alone.
    await deps.server
      .analyze(generation, { throttled: !fullSpeed(deps) })
      .catch((error: unknown) =>
        deps.log?.('knowledge run analyze failed', { generation, error: String(error) }),
      );
    await sendHeavy(deps, {
      tenant: tenantOf(run.dataset),
      generation,
      kind: 'vacuum',
      run: run.id,
    });
    return 'sent';
  }
  await closingVacuumOf(deps, run.id, generation, {}, {});
  return 'done';
};

/** Runs a run's closing VACUUM and adds its duration, and whether it rebuilt, to the run's report. */
const closingVacuumOf = async (
  deps: HeavyDeps,
  run: string | undefined,
  generation: string,
  options: MaintenanceOptions,
  how: { afterBuild?: boolean; takeOver?: boolean },
) => {
  const backend = tracked(deps, options.onBackend);
  const started = nowOf(deps).getTime();
  try {
    const result = await deps.server.vacuum(generation, {
      ...closingVacuum(deps, options, how),
      onBackend: backend.onBackend,
    });
    const vacuumMs = nowOf(deps).getTime() - started;
    // The VACUUM is done either way, so a report that cannot be written is only logged.
    if (run)
      await deps
        .report?.(run, { vacuumMs, ...(result?.rebuilt ? { vacuumRebuilt: 1 } : {}) }, 'add')
        .catch((error: unknown) =>
          deps.log?.('knowledge run report failed', { run, error: String(error) }),
        );
    return { vacuumMs, rebuilt: result?.rebuilt ?? false };
  } finally {
    backend.done();
  }
};

const datasetConfig = async (deps: HeavyDeps, generation: string) => {
  const switched = await deps.datasetOfGeneration?.(generation);
  if (switched) return switched;
  const id = await deps.server.datasetOf(generation);
  const dataset = deps.datasets().find((d) => d.id === id);
  if (!dataset) throw new Error(`generation ${generation} belongs to no dataset the catalog names`);
  return dataset;
};

/**
 * `knowledge.build`, worked only inside the night window: builds and REINDEX with the window's
 * workers, VACUUM throttled unless the window has an end, cancelled when still running an hour
 * after the window ends, then prewarms. It ends a leftover session of an earlier try first.
 */
export const buildWork = (deps: HeavyDeps) =>
  queueWork(knowledgeBuildQueue, async (job) => {
    const { generation, kind } = job.data;
    if (kind === 'catch-up')
      throw new Error('a catch-up build comes with candidate generations, which do not exist yet');
    // Taken by this worker's poller after it began to stop: the next worker runs it.
    if (deps.running?.stopping) {
      await sendForNextWorker(deps, job.data);
      deps.log?.('knowledge build sent again', { generation, kind, reason: 'worker stopped' });
      return;
    }
    const started = nowOf(deps);
    const end = nightWindowEnd(deps.window(), started);
    const run = 'run' in job.data ? job.data.run : undefined;
    let backend: number | undefined;
    let overrun: unknown;
    const watched = tracked(deps, (pid) => {
      backend = pid;
    });
    const options: MaintenanceOptions = {
      ...maintenance(deps),
      onBackend: watched.onBackend,
      job: job.id,
    };
    deps.log?.('knowledge build started', { generation, kind, ...(run ? { run } : {}) });
    const timer =
      end &&
      setTimeout(
        () =>
          void (async () => {
            if (backend === undefined) return;
            overrun = (await deps.server.progress(backend).catch(() => undefined)) ?? 'unknown';
            deps.log?.('knowledge build cancelled', { generation, kind, progress: overrun });
            await deps.server.cancel(backend);
          })().catch((error: unknown) => {
            overrun = undefined;
            deps.log?.('knowledge build cancel failed', { generation, kind, error: String(error) });
          }),
        Math.max(end.getTime() + buildOverrunMs - started.getTime(), 0),
      );
    const ticker = setInterval(
      () =>
        void (async () => {
          if (backend === undefined) return;
          const progress = await deps.server.progress(backend);
          deps.log?.('knowledge build progress', {
            generation,
            kind,
            minutes: Math.round((nowOf(deps).getTime() - started.getTime()) / 60_000),
            progress: progress ?? null,
          });
        })().catch(() => undefined),
      buildProgressMs,
    );
    let closing: { vacuumMs: number; rebuilt: boolean } | undefined;
    try {
      if (kind === 'index') {
        await deps.server.build(await datasetConfig(deps, generation), generation, options);
        // A build that ends a run is that run's last step, so it also leaves the planner statistics.
        if (run)
          closing = await closingVacuumOf(deps, run, generation, options, {
            afterBuild: true,
            takeOver: true,
          });
      } else if (kind === 'reindex') await deps.server.reindex(generation, options);
      else if (kind === 'vacuum')
        closing = await closingVacuumOf(deps, run, generation, options, { takeOver: true });
      else
        await deps.server.vacuum(generation, {
          ...options,
          freeze: true,
          takeOver: true,
          throttled: !fullSpeed(deps),
        });
    } catch (error) {
      if (deps.running?.stopping) {
        // Ended because the worker stops: the same job again, which waits for the next worker.
        await sendForNextWorker(deps, job.data);
        deps.log?.('knowledge build sent again', { generation, kind, reason: 'worker stopped' });
        return;
      }
      deps.log?.('knowledge build failed', { generation, kind, error: String(error) });
      if (overrun !== undefined)
        throw new Error(
          `the build was cancelled an hour after the night window ended, at ${JSON.stringify(overrun)}`,
          { cause: error },
        );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      clearInterval(ticker);
      watched.done();
    }
    const blocks = await deps.server.prewarm(activeGenerations(deps));
    deps.log?.('knowledge build done', {
      generation,
      kind,
      durationMs: nowOf(deps).getTime() - started.getTime(),
      ...(closing ? { rebuilt: closing.rebuilt } : {}),
      prewarmedBlocks: blocks ?? null,
    });
  });

/**
 * `knowledge.check`, nightly at the window start: sends `VACUUM (FREEZE)` for partitions past half
 * the freeze age, and a REINDEX for an active generation whose sampled recall dropped.
 */
export const checkWork = (deps: HeavyDeps) =>
  queueWork(knowledgeCheckQueue, async (job) => {
    const deadline = nowOf(deps).getTime() + recallDeadlineMs;
    const stop = () => nowOf(deps).getTime() >= deadline;
    for (const generation of await deps.server.toFreeze()) {
      const dataset = await deps.server.datasetOf(generation);
      if (!dataset) continue;
      await sendHeavy(deps, { tenant: tenantOf(dataset), generation, kind: 'freeze' });
    }
    // Smallest first, so a large generation takes only the time left.
    const active: { dataset: DatasetConfig; generation: string; chunks: number }[] = [];
    for (const dataset of deps.datasets())
      if (dataset.generation)
        active.push({
          dataset,
          generation: dataset.generation,
          chunks: await deps.server.chunks(dataset.generation),
        });
    active.sort((a, b) => a.chunks - b.chunks);
    for (const { dataset, generation, chunks } of active) {
      const { sample: planned } = recallQueries(chunks);
      // Past the deadline no sample is drawn: the draw alone reads the partition.
      if (stop()) {
        deps.log?.('knowledge recall check cut short', { generation, planned, queries: 0 });
        continue;
      }
      deps.log?.('knowledge recall check started', { generation, chunks, planned });
      const sample = await deps.server.recall(generation, {
        sample: planned,
        stop,
        signal: job.signal,
      });
      if (!sample) {
        deps.log?.('knowledge recall check skipped', { generation, reason: 'no vectors' });
        continue;
      }
      // Only a sample the deadline cut goes without a verdict.
      if (sample.cut && sample.queries < fewestRecallVerdict) {
        deps.log?.('knowledge recall check cut short', {
          generation,
          planned,
          queries: sample.queries,
        });
        continue;
      }
      const baseline = await deps.server.baseline(generation, sample.recall);
      const dropped = sample.recall < baseline - recallMarginFor(sample.queries);
      deps.log?.('knowledge recall checked', {
        generation,
        recall: sample.recall,
        queries: sample.queries,
        cut: sample.cut,
        planned,
        baseline,
        dropped,
      });
      if (dropped)
        await sendHeavy(deps, { tenant: tenantOf(dataset.id), generation, kind: 'reindex' });
    }
  });

/**
 * The worker's side of the night window: works `knowledge.build` and `knowledge.fill` only inside
 * it and stops at its end, and when the window setting changes, moves waiting heavy jobs and
 * replacement runs' convert jobs to its next start and schedules the nightly checks at it (ADR
 * 0042, "Jobs").
 */
export const heavyWindow = (deps: HeavyDeps, work: { build: QueueWork; fill: QueueWork }) => {
  let offs: (() => Promise<void>)[] | undefined;
  let seen: string | undefined;
  const stop = async () => {
    for (const off of offs ?? []) await off();
    offs = undefined;
  };
  return {
    tick: async () => {
      const window = deps.window();
      const now = nowOf(deps);
      if (window !== seen) {
        const start = heavyWorkStart(window, now);
        const moved = await deps.queue.retime([knowledgeBuildQueue, knowledgeFillQueue], start);
        // A replacement run's convert jobs wait for the window too, and only they are sent at
        // their priority; a run's own conversions keep their start (issue 477).
        const conversions = await deps.queue.retime([convertQueue], start, {
          priority: convertPriority.replacement,
        });
        await deps.queue.schedule(
          knowledgeCheckQueue,
          nightlyCron(window),
          {},
          { tz: nightWindowZone, key: knowledgeKeys.check() },
        );
        deps.log?.('knowledge night window', { window, moved, conversions });
        seen = window;
      }
      const inside = inNightWindow(window, now);
      if (inside && !offs)
        offs = [
          await deps.queue.work(work.build.queue, work.build.handler, work.build.options),
          await deps.queue.work(work.fill.queue, work.fill.handler, work.fill.options),
        ];
      else if (!inside && offs) await stop();
    },
    stop,
  };
};

export const buildFailedMessage = (generation: string) =>
  `the generation ${generation} was not built: its build job ended without attaching it; retry the switch`;

/**
 * The reconciler's last step of a run whose jobs have ended, on the generation the run wrote: its
 * own, or else the dataset's active one. A standalone generation is built and attached, at once at
 * or below the heavy threshold and as a `knowledge.build` job naming the run above it; an attached
 * one gets its `VACUUM (ANALYZE)`, or the `knowledge.build` job for it. The run ends once that job
 * has. A step that fails, as a VACUUM that waited too long for writers, is tried again on the next
 * pass; a build job that ended without attaching fails the run.
 */
export const finishRun =
  (
    deps: HeavyDeps,
    report: (id: string, counts: Record<string, number>, mode: 'add') => Promise<void>,
  ) =>
  async (run: IngestionExecution): Promise<boolean | { error: string }> => {
    if (run.report?.vacuumSent) return true;
    const generation =
      run.generation ?? deps.datasets().find((d) => d.id === run.dataset)?.generation;
    if (!generation) return true;
    try {
      const state = await deps.server.state(generation);
      if (state === undefined) return true;
      if (state === 'standalone') {
        // A cancelled switch's generation is dropped, not built; the catalog's own is still needed.
        if (run.cancelRequestedAt && run.generation) return true;
        if (run.report?.buildSent) return { error: buildFailedMessage(generation) };
        if ((await deps.server.chunks(generation)) > deps.threshold()) {
          await sendHeavy(deps, {
            tenant: tenantOf(run.dataset),
            generation,
            kind: 'index',
            run: run.id,
          });
          await report(run.id, { buildSent: 1 }, 'add');
          return false;
        }
        const built = tracked(deps);
        try {
          await deps.server.build(await datasetConfig(deps, generation), generation, {
            ...maintenance(deps),
            onBackend: built.onBackend,
          });
        } finally {
          built.done();
        }
        await closingVacuumOf(deps, run.id, generation, {}, { afterBuild: true });
        return true;
      }
      // The build job that attached it also ran its VACUUM (ANALYZE).
      if (run.report?.buildSent) return true;
      if ((await runVacuum(deps, run, generation)) === 'done') return true;
      await report(run.id, { vacuumSent: 1 }, 'add');
      return false;
    } catch (error) {
      deps.log?.('knowledge run vacuum failed', { run: run.id, generation, error: String(error) });
      // Only a partition that no longer exists has nothing left to VACUUM; anything else is tried again.
      return (error as { code?: string }).code === '42P01';
    }
  };
