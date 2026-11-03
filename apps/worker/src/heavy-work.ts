import {
  heavyWorkStart,
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

/** Session settings of heavy work; the knowledge server's provider takes the same shape. */
export interface MaintenanceOptions {
  maintenanceWorkers?: number;
  onBackend?: (pid: number) => void;
}

export interface VacuumOptions extends MaintenanceOptions {
  analyze?: boolean;
  freeze?: boolean;
  throttled: boolean;
}

export interface RecallSample {
  recall: number;
  queries: number;
}

/** The knowledge server's heavy work, as the worker's owner login runs it (ADR 0042, "Heavy work"). */
export interface HeavyServer {
  chunks(generation: string): Promise<number>;
  vacuum(generation: string, options: VacuumOptions): Promise<void>;
  build(dataset: DatasetConfig, generation: string, options: MaintenanceOptions): Promise<void>;
  reindex(generation: string, options: MaintenanceOptions): Promise<void>;
  prewarm(generations: string[]): Promise<number | undefined>;
  toFreeze(): Promise<string[]>;
  progress(pid: number): Promise<unknown>;
  cancel(pid: number): Promise<unknown>;
  recall(generation: string, options: { sample: number }): Promise<RecallSample | undefined>;
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
  /** `KNOWLEDGE_VCORES`: the server's vCores, for build parallelism. */
  vcores?: number;
  now?: () => Date;
  log?: (event: string, fields: Record<string, unknown>) => void;
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

export const recallQueries = (chunks: number) => {
  const sample = Math.max(
    fewestRecallQueries,
    Math.min(recallSampleSize, Math.floor(recallBudget / Math.max(chunks, 1))),
  );
  return {
    sample,
    margin: Number((recallMargin * Math.sqrt(recallSampleSize / sample)).toFixed(4)),
  };
};

/** A build still running this long after the window's end is cancelled (ADR 0042, "Heavy work"). */
export const buildOverrunMs = 60 * 60_000;

type BuildData = (typeof knowledgeBuildQueue)['payload']['_output'];

const nowOf = (deps: HeavyDeps) => deps.now?.() ?? new Date();

const tenantOf = (dataset: string) => executionScope(dataset);

const activeGenerations = (deps: HeavyDeps) =>
  deps.datasets().flatMap((d) => (d.generation ? [d.generation] : []));

const maintenance = (deps: HeavyDeps): MaintenanceOptions =>
  deps.vcores === undefined ? {} : { maintenanceWorkers: Math.max(deps.vcores - 1, 0) };

/** Sends a `knowledge.build` job to start at the next window start, or at once inside it. */
export const sendHeavy = (deps: HeavyDeps, data: BuildData) =>
  deps.queue.send(knowledgeBuildQueue, data, {
    key: knowledgeKeys.build(),
    startAfter: heavyWorkStart(deps.window(), nowOf(deps)),
  });

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
    await sendHeavy(deps, {
      tenant: tenantOf(run.dataset),
      generation,
      kind: 'vacuum',
      run: run.id,
    });
    return 'sent';
  }
  await deps.server.vacuum(generation, {
    analyze: true,
    throttled: !inNightWindow(deps.window(), nowOf(deps)),
  });
  return 'done';
};

const datasetConfig = async (deps: HeavyDeps, generation: string) => {
  const id = await deps.server.datasetOf(generation);
  const dataset = deps.datasets().find((d) => d.id === id);
  if (!dataset) throw new Error(`generation ${generation} belongs to no dataset the catalog names`);
  return dataset;
};

/**
 * `knowledge.build`, worked only inside the night window: builds, VACUUM and REINDEX at full
 * speed, cancelled when still running an hour after the window ends, then prewarms.
 */
export const buildWork = (deps: HeavyDeps) =>
  queueWork(knowledgeBuildQueue, async (job) => {
    const { generation, kind } = job.data;
    if (kind === 'catch-up')
      throw new Error('a catch-up build comes with candidate generations, which do not exist yet');
    const started = nowOf(deps);
    const end = nightWindowEnd(deps.window(), started);
    let backend: number | undefined;
    let overrun: unknown;
    const options: MaintenanceOptions = {
      ...maintenance(deps),
      onBackend: (pid) => {
        backend = pid;
      },
    };
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
    try {
      if (kind === 'index')
        await deps.server.build(await datasetConfig(deps, generation), generation, options);
      else if (kind === 'reindex') await deps.server.reindex(generation, options);
      else
        await deps.server.vacuum(generation, {
          ...options,
          analyze: kind === 'vacuum',
          freeze: kind === 'freeze',
          throttled: !inNightWindow(deps.window(), nowOf(deps)),
        });
    } catch (error) {
      deps.log?.('knowledge build failed', { generation, kind, error: String(error) });
      if (overrun !== undefined)
        throw new Error(
          `the build was cancelled an hour after the night window ended, at ${JSON.stringify(overrun)}`,
          { cause: error },
        );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
    }
    const blocks = await deps.server.prewarm(activeGenerations(deps));
    deps.log?.('knowledge build done', { generation, kind, prewarmedBlocks: blocks ?? null });
  });

/**
 * `knowledge.check`, nightly at the window start: sends `VACUUM (FREEZE)` for partitions past half
 * the freeze age, and a REINDEX for an active generation whose sampled recall dropped.
 */
export const checkWork = (deps: HeavyDeps) =>
  queueWork(knowledgeCheckQueue, async () => {
    for (const generation of await deps.server.toFreeze()) {
      const dataset = await deps.server.datasetOf(generation);
      if (!dataset) continue;
      await sendHeavy(deps, { tenant: tenantOf(dataset), generation, kind: 'freeze' });
    }
    for (const dataset of deps.datasets()) {
      const generation = dataset.generation;
      if (!generation) continue;
      const { sample: size, margin } = recallQueries(await deps.server.chunks(generation));
      const sample = await deps.server.recall(generation, { sample: size });
      if (!sample) continue;
      const baseline = await deps.server.baseline(generation, sample.recall);
      const dropped = sample.recall < baseline - margin;
      deps.log?.('knowledge recall checked', { generation, ...sample, baseline, dropped });
      if (dropped)
        await sendHeavy(deps, { tenant: tenantOf(dataset.id), generation, kind: 'reindex' });
    }
  });

/**
 * The worker's side of the night window: works `knowledge.build` and `knowledge.fill` only inside
 * it and stops at its end, and when the window setting changes, moves waiting heavy jobs to its
 * next start and schedules the nightly checks at it (ADR 0042, "Jobs").
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
        const moved = await deps.queue.retime(
          [knowledgeBuildQueue, knowledgeFillQueue],
          heavyWorkStart(window, now),
        );
        await deps.queue.schedule(
          knowledgeCheckQueue,
          nightlyCron(window),
          {},
          { tz: nightWindowZone, key: knowledgeKeys.check() },
        );
        deps.log?.('knowledge night window', { window, moved });
        seen = window;
      }
      const inside = inNightWindow(window, now);
      if (inside && !offs)
        offs = [
          await deps.queue.work(work.build.queue, work.build.handler),
          await deps.queue.work(work.fill.queue, work.fill.handler),
        ];
      else if (!inside && offs) await stop();
    },
    stop,
  };
};

/**
 * The reconciler's last step of a run whose jobs have ended: its `VACUUM (ANALYZE)` of the dataset's
 * active generation, or the `knowledge.build` job for it, after which the run ends once that job
 * has. A VACUUM that fails, as one that waited too long for writers, is tried again on the next pass.
 */
export const finishRun =
  (
    deps: HeavyDeps,
    report: (id: string, counts: Record<string, number>, mode: 'add') => Promise<void>,
  ) =>
  async (run: IngestionExecution): Promise<boolean> => {
    if (run.report?.vacuumSent) return true;
    const generation = deps.datasets().find((d) => d.id === run.dataset)?.generation;
    if (!generation) return true;
    try {
      if ((await runVacuum(deps, run, generation)) === 'done') return true;
      await report(run.id, { vacuumSent: 1 }, 'add');
      return false;
    } catch (error) {
      deps.log?.('knowledge run vacuum failed', { run: run.id, generation, error: String(error) });
      // Only a partition that no longer exists has nothing left to VACUUM; anything else is tried again.
      return (error as { code?: string }).code === '42P01';
    }
  };
