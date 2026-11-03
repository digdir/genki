import type { RunJobs } from '@genai/jobs';
import type {
  IngestionExecution,
  JobRunRequest,
  QueuedRunRules,
  RunOutcome,
} from '@genai/providers-postgres';
import { queuedRunRules } from './knowledge-jobs.js';

export const listingFailedMessage =
  'listing the source failed after its retries; send the run back once the source answers';

export interface ReconcilerRecords {
  open(): Promise<IngestionExecution[]>;
  find(id: string): Promise<IngestionExecution | undefined>;
  requests(): Promise<JobRunRequest[]>;
  applied(id: string, at: string): Promise<void>;
  end(
    run: IngestionExecution,
    outcome: RunOutcome,
    at: string,
    rules: QueuedRunRules,
  ): Promise<{ ended?: IngestionExecution; started?: IngestionExecution }>;
  startQueued(
    run: { dataset: string; pipeline: string },
    at: string,
    rules: QueuedRunRules,
  ): Promise<IngestionExecution | undefined>;
}

export interface ReconcilerDeps {
  records: ReconcilerRecords;
  /** A run's jobs on the platform server and on the knowledge server. */
  servers: RunJobs[];
  lockdown: boolean;
  now?: () => Date;
}

export interface Reconciled {
  sentBack: number;
  ended: IngestionExecution[];
  started: IngestionExecution[];
  dropped: number;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

const outcomeOf = (run: IngestionExecution, dead: Record<string, number>): RunOutcome => {
  if (run.cancelRequestedAt) return { status: 'cancelled' };
  const failedDocuments = sum(
    Object.entries(dead)
      .filter(([queue]) => queue !== 'knowledge.ingest')
      .map(([, count]) => count),
  );
  return dead['knowledge.ingest']
    ? { status: 'failed', error: listingFailedMessage, report: { failedDocuments } }
    : { status: 'succeeded', report: { failedDocuments } };
};

/**
 * One pass of the knowledge reconciler (ADR 0042, "Jobs"): applies send-backs the API recorded,
 * ends runs whose jobs have all ended, starts queued runs whose pipeline has no open run, leaves
 * runs waiting for approval alone, and drops jobs of runs that are gone, finished or cancelled.
 */
export const reconcileKnowledgeRuns = async (deps: ReconcilerDeps): Promise<Reconciled> => {
  const now = deps.now?.() ?? new Date();
  const at = now.toISOString();
  const rules = queuedRunRules(now, deps.lockdown);
  const result: Reconciled = { sentBack: 0, ended: [], started: [], dropped: 0 };

  for (const request of await deps.records.requests()) {
    let sent = 0;
    for (const server of deps.servers) sent += await server.redrive(request.run);
    result.sentBack += sent;
    await deps.records.applied(request.id, at);
    // Nothing went back, so nothing will end the reopened run: end it as it had ended.
    const reopened = sent === 0 ? await deps.records.find(request.run) : undefined;
    if (reopened?.status === 'running') {
      const { ended } = await deps.records.end(
        reopened,
        {
          status: request.previousStatus,
          ...(request.previousError ? { error: request.previousError } : {}),
        },
        at,
        rules,
      );
      if (ended) result.ended.push(ended);
    }
  }

  // Read the jobs before the runs: a run commits with its first job, so every job seen here has
  // a run the read below sees.
  const jobRuns = await Promise.all(deps.servers.map((server) => server.runs()));

  for (const run of await deps.records.open()) {
    if (run.status === 'waiting') continue;
    if (run.status === 'queued') {
      const started = await deps.records.startQueued(run, at, rules);
      if (started) result.started.push(started);
      continue;
    }
    if (run.cancelRequestedAt)
      for (const server of deps.servers) result.dropped += await server.cancel(run.id);
    // One server after the other, the platform server first: an ingest job sends its last
    // document jobs before it completes, so a count taken in this order cannot miss both.
    let open = 0;
    for (const server of deps.servers) open += await server.open(run.id);
    if (open > 0) continue;
    const dead: Record<string, number> = {};
    for (const server of deps.servers)
      for (const [queue, count] of Object.entries(await server.deadLetters(run.id)))
        dead[queue] = (dead[queue] ?? 0) + count;
    const { ended, started } = await deps.records.end(run, outcomeOf(run, dead), at, rules);
    if (ended) result.ended.push(ended);
    if (started) result.started.push(started);
  }

  const live = new Set(
    (await deps.records.open())
      .filter((run) => run.status !== 'queued' && !run.cancelRequestedAt)
      .map((run) => run.id),
  );
  for (const [i, server] of deps.servers.entries())
    for (const run of jobRuns[i] ?? [])
      if (!live.has(run)) result.dropped += await server.cancel(run);
  return result;
};
