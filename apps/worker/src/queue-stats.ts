import type { JobQueue } from '@genai/jobs';

export interface QueueStatsSource {
  server: string;
  jobs: Pick<JobQueue, 'backlog'>;
}

export type Log = (msg: string, extra?: Record<string, unknown>) => void;

export const queueStatsIntervalMs = 5 * 60_000;

/** One `queue stats` line; the worker-jobs alert reads `oldestQueuedSeconds` (docs/runbook.md). */
export const logQueueStats = async (sources: QueueStatsSource[], log: Log, now = new Date()) => {
  const queues = (
    await Promise.all(
      sources.map(async (source) =>
        ((await source.jobs.backlog?.(now)) ?? []).map((entry) => ({
          server: source.server,
          ...entry,
        })),
      ),
    )
  ).flat();
  log('queue stats', {
    oldestQueuedSeconds: Math.max(0, ...queues.map((entry) => entry.oldestQueuedSeconds)),
    queues,
  });
};

export const startQueueStats = (
  sources: () => QueueStatsSource[],
  log: Log,
  everyMs = queueStatsIntervalMs,
) => {
  const tick = () =>
    void logQueueStats(sources(), log).catch((error: unknown) =>
      log('queue stats failed', { error: error instanceof Error ? error.message : String(error) }),
    );
  const timer = setInterval(tick, everyMs);
  return { stop: () => clearInterval(timer) };
};
