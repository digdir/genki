import {
  queueWork,
  usageGatewayPollCron,
  usageGatewayPollQueue,
  type JobQueue,
  type QueueWork,
} from '@genai/jobs';
import {
  pollUsage,
  UsageGatewayError,
  type UsageBucketStore,
  type UsageSource,
} from '@genai/port-usage';

export interface PolledSource {
  source: UsageSource;
  since: Date;
}

export interface UsagePollDeps {
  sources: PolledSource[];
  store: UsageBucketStore;
  now?: () => Date;
  log(msg: string, extra?: Record<string, unknown>): void;
}

/** Statuses the next scheduled run gets past on its own; the rest stop and alert operators. */
const waitsForNextRun = [429, 502, 503, 504];

/** Works `usage-gateway-poll`: the source comes from configuration, never from the job's data. */
export const usagePollWork = (deps: UsagePollDeps): QueueWork =>
  queueWork(usageGatewayPollQueue, async (job) => {
    const entry = deps.sources.find((s) => s.source.id === job.data.source);
    if (!entry) {
      deps.log('usage poll skipped: no such source', { source: job.data.source });
      return;
    }
    try {
      const result = await pollUsage(entry.source, deps.store, {
        firstStart: entry.since,
        ...(deps.now ? { now: deps.now } : {}),
        onBreach: (source, start, rows) =>
          deps.log('usage contract breach: a closed bucket came back different', {
            source,
            start,
            rows,
          }),
      });
      deps.log('usage polled', { source: entry.source.id, ...result });
    } catch (error) {
      if (error instanceof UsageGatewayError && waitsForNextRun.includes(error.status)) {
        deps.log('usage poll waits for the next run', {
          source: entry.source.id,
          status: error.status,
          ...(error.retryAfterSeconds === undefined
            ? {}
            : { retryAfterSeconds: error.retryAfterSeconds }),
        });
        return;
      }
      throw error;
    }
  });

export const scheduleUsagePolls = async (jobs: JobQueue, sources: PolledSource[]) => {
  for (const { source } of sources)
    await jobs.schedule(
      usageGatewayPollQueue,
      usageGatewayPollCron,
      { source: source.id },
      { tz: 'Europe/Oslo', key: source.id },
    );
};
