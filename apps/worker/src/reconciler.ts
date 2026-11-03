import type { RunJobs } from '@genai/jobs';
import type {
  IngestionExecution,
  JobRunRequest,
  QueuedRunRules,
  RunOutcome,
} from '@genai/providers-postgres';
import { queuedRunRules } from './knowledge-jobs.js';

export const failureBudgetMessage = (failed: number) =>
  `${failed} documents failed, which reached the pipeline's failure budget; the run stopped and keeps the documents it replaced`;

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
  /** Cancels a running run whose failed documents reached its failure budget. */
  stopAtBudget?(id: string, at: string): Promise<void>;
}

export interface ReconcilerDeps {
  records: ReconcilerRecords;
  /** A run's jobs on the platform server and on the knowledge server. */
  servers: RunJobs[];
  lockdown: boolean;
  now?: () => Date;
  /** The pipeline's `maxDocumentFailures` for a run: its document dead letters before it stops. */
  failureBudget?: (run: IngestionExecution) => Promise<number>;
  /**
   * The run's `VACUUM (ANALYZE)` once its jobs have ended: true when it ran and the run may end,
   * false when it went as a `knowledge.build` job, which keeps the run open (ADR 0042, "Heavy work").
   */
  finishing?: (run: IngestionExecution) => Promise<boolean>;
}

export interface Reconciled {
  sentBack: number;
  ended: IngestionExecution[];
  started: IngestionExecution[];
  dropped: number;
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

const documentFailures = (dead: Record<string, number>) =>
  sum(
    Object.entries(dead)
      .filter(([queue]) => queue !== 'knowledge.ingest')
      .map(([, count]) => count),
  );

const outcomeOf = (run: IngestionExecution, dead: Record<string, number>): RunOutcome => {
  const failedDocuments = documentFailures(dead);
  if (run.cancelledBy === 'failure-budget')
    return {
      status: 'cancelled',
      error: failureBudgetMessage(failedDocuments),
      report: { failedDocuments },
    };
  if (run.cancelRequestedAt) return { status: 'cancelled' };
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
    let stopping = run;
    if (!run.cancelRequestedAt && deps.failureBudget && deps.records.stopAtBudget) {
      let failed = 0;
      for (const server of deps.servers)
        failed += documentFailures(await server.deadLetters(run.id));
      if (failed > 0 && failed >= (await deps.failureBudget(run))) {
        await deps.records.stopAtBudget(run.id, at);
        stopping = (await deps.records.find(run.id)) ?? run;
      }
    }
    if (stopping.cancelRequestedAt)
      // A cancelled run still ends with its VACUUM, so its build job is kept (ADR 0042, "Heavy work").
      for (const server of deps.servers)
        result.dropped += await server.cancel(run.id, { except: ['knowledge.build'] });
    // One server after the other, the platform server first: an ingest job sends its last
    // document jobs before it completes, so a count taken in this order cannot miss both.
    let open = 0;
    for (const server of deps.servers) open += await server.open(run.id);
    if (open > 0) continue;
    if (deps.finishing && !(await deps.finishing(stopping))) continue;
    const dead: Record<string, number> = {};
    for (const server of deps.servers)
      for (const [queue, count] of Object.entries(await server.deadLetters(run.id)))
        dead[queue] = (dead[queue] ?? 0) + count;
    const { ended, started } = await deps.records.end(
      stopping,
      outcomeOf(stopping, dead),
      at,
      rules,
    );
    if (ended) result.ended.push(ended);
    if (started) result.started.push(started);
  }

  const open = await deps.records.open();
  const live = new Set(
    open.filter((run) => run.status !== 'queued' && !run.cancelRequestedAt).map((run) => run.id),
  );
  // A cancelled run that is still open keeps its VACUUM until it ends (ADR 0042, "Heavy work").
  const cancelling = new Set(
    open.filter((run) => run.status === 'running' && run.cancelRequestedAt).map((run) => run.id),
  );
  for (const [i, server] of deps.servers.entries())
    for (const run of jobRuns[i] ?? [])
      if (!live.has(run))
        result.dropped += await server.cancel(
          run,
          cancelling.has(run) ? { except: ['knowledge.build'] } : {},
        );
  return result;
};
