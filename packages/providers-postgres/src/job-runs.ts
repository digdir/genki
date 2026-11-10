import { randomUUID } from 'node:crypto';
import {
  knowledgeIngestQueue,
  knowledgeKeys,
  type JobQueue,
  type JobTransaction,
} from '@genai/jobs';
import type { Pool, PoolClient } from 'pg';
import {
  executionScope,
  toExecution,
  type IngestionExecution,
  type IngestionExecutionReport,
  type Row,
} from './executions.js';
import { withPlatformAccess, withTenant } from './tenancy.js';

/** Sends a run's `knowledge.ingest` job inside the transaction that makes the run `running`. */
export interface IngestSender {
  send(run: IngestionExecution, transaction: JobTransaction): Promise<string | null>;
}

export const ingestSender = (jobs: Pick<JobQueue, 'send'>): IngestSender => ({
  send: (run, transaction) =>
    jobs.send(
      knowledgeIngestQueue,
      { run: run.id, tenant: executionScope(run.dataset) },
      { key: knowledgeKeys.ingest({ dataset: run.dataset, id: run.pipeline }), transaction },
    ),
});

export const queuedRunExistsMessage = (dataset: string, pipeline: string) =>
  `a run of ${dataset}/${pipeline} already waits for the open one; wait for it or cancel it`;

export const sentBackMessage = 'only an ended run that runs as jobs can be sent back';

export const ingestStillEndingMessage = (dataset: string, pipeline: string) =>
  `the last ingest job of ${dataset}/${pipeline} is still ending; start the run again in a minute`;

const openRunMessage = (dataset: string, pipeline: string) =>
  `${dataset}/${pipeline} has an open run; wait for it or cancel it before sending this one back`;

/** pg-boss answers a send with null when the queue's key is taken: `knowledge.ingest` per pipeline. */
class IngestKeyTaken extends Error {}

const uniqueViolation = (error: unknown) =>
  typeof error === 'object' && error !== null && (error as { code?: string }).code === '23505';

export type JobRunResult =
  { ok: true; value: IngestionExecution } | { ok: false; message: string; conflict?: boolean };

interface StartInput {
  id: string;
  dataset: string;
  pipeline: string;
  pipelineVersion: number;
  backend: string;
  startedBy: string;
  startedAt: string;
  admittedAt: string;
  /** A switch's run writes into the switch's generation (ADR 0025). */
  generation?: string;
  engineSwitch?: string;
}

/**
 * The API's side of runs that run as jobs, as genai_runtime: a run's record and its ingest job
 * commit together, at most one run per pipeline is open and at most one waits (ADR 0042).
 */
export class PostgresJobRuns {
  constructor(
    private readonly pool: Pool,
    private readonly sender: IngestSender,
  ) {}

  async start(input: StartInput): Promise<JobRunResult> {
    const scope = executionScope(input.dataset);
    try {
      return await withTenant(this.pool, scope, async (client) => {
        const { rows: open } = await client.query<{ status: string }>(
          `select status from ingestion_executions
            where dataset = $1 and pipeline = $2 and runs_as_jobs and status in ('queued', 'running')`,
          [input.dataset, input.pipeline],
        );
        if (open.some((row) => row.status === 'queued'))
          return {
            ok: false as const,
            conflict: true,
            message: queuedRunExistsMessage(input.dataset, input.pipeline),
          };
        const status = open.length > 0 ? 'queued' : 'running';
        const { rows } = await client.query<Row>(
          `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
             status, started_by, started_at, runs_as_jobs, admitted_at, generation, engine_switch)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, true, $10, $11, $12) returning *`,
          [
            input.id,
            scope,
            input.dataset,
            input.pipeline,
            input.pipelineVersion,
            input.backend,
            status,
            input.startedBy,
            input.startedAt,
            input.admittedAt,
            input.generation ?? null,
            input.engineSwitch ?? null,
          ],
        );
        const run = toExecution(rows[0] as Row);
        if (status === 'running' && (await this.sender.send(run, client)) === null)
          throw new IngestKeyTaken();
        return { ok: true as const, value: run };
      });
    } catch (error) {
      if (error instanceof IngestKeyTaken)
        return {
          ok: false,
          conflict: true,
          message: ingestStillEndingMessage(input.dataset, input.pipeline),
        };
      if (!uniqueViolation(error)) throw error;
      return {
        ok: false,
        conflict: true,
        message: queuedRunExistsMessage(input.dataset, input.pipeline),
      };
    }
  }

  /** Marks the run cancelled; one that has not started ends at once, a running one with its jobs. */
  async cancel(input: {
    dataset: string;
    execution: string;
    by: string;
    at: string;
  }): Promise<IngestionExecution | undefined> {
    return withTenant(this.pool, executionScope(input.dataset), async (client) => {
      const { rows } = await client.query<Row>(
        `update ingestion_executions
            set cancel_requested_at = $3, cancelled_by = $4,
                status = case when status = 'running' then status else 'cancelled' end,
                ended_at = case when status = 'running' then ended_at else $3 end
          where id = $1 and dataset = $2 and runs_as_jobs and status in ('queued', 'running', 'waiting')
            and cancel_requested_at is null
          returning *`,
        [input.execution, input.dataset, input.at, input.by],
      );
      return rows[0] && toExecution(rows[0]);
    });
  }

  /** Reopens an ended run, admits it from now and asks the worker to send its dead letters back. */
  async redrive(input: {
    dataset: string;
    pipeline: string;
    execution: string;
    by: string;
    reason: string;
    at: string;
  }): Promise<JobRunResult> {
    try {
      return await withTenant(this.pool, executionScope(input.dataset), async (client) => {
        const { rows: found } = await client.query<Row>(
          `select * from ingestion_executions
            where id = $1 and dataset = $2 and pipeline = $3 for update`,
          [input.execution, input.dataset, input.pipeline],
        );
        const run = found[0];
        if (!run || !run.runs_as_jobs || !['succeeded', 'failed'].includes(run.status))
          return { ok: false as const, message: sentBackMessage };
        const { rows: reopened } = await client.query<Row>(
          `update ingestion_executions
              set status = 'running', ended_at = null, error = null, admitted_at = $2,
                  cancel_requested_at = null, cancelled_by = null
            where id = $1 returning *`,
          [run.id, input.at],
        );
        await client.query(
          `insert into knowledge_job_requests (id, scope, run, kind, requested_by, reason,
             requested_at, previous_status, previous_error)
           values ($1, $2, $3, 'redrive', $4, $5, $6, $7, $8)`,
          [
            randomUUID(),
            run.scope,
            run.id,
            input.by,
            input.reason,
            input.at,
            run.status,
            run.error,
          ],
        );
        return { ok: true as const, value: toExecution(reopened[0] as Row) };
      });
    } catch (error) {
      if (!uniqueViolation(error)) throw error;
      return {
        ok: false,
        conflict: true,
        message: openRunMessage(input.dataset, input.pipeline),
      };
    }
  }
}

export interface JobRunRequest {
  id: string;
  run: string;
  kind: 'redrive';
  /** How the run had ended before it was sent back, to end it so again when nothing went back. */
  previousStatus: 'succeeded' | 'failed';
  previousError?: string;
}

export interface RunOutcome {
  status: 'succeeded' | 'failed' | 'cancelled';
  /** Merged into the report the run's handlers wrote. */
  report?: Partial<IngestionExecutionReport>;
  error?: string;
}

export interface QueuedRunRules {
  /** In lockdown, a queued run admitted before this time fails without starting. */
  admittedAfter?: string;
  expiredError: string;
}

/**
 * The worker's side, as genai_worker: every organisation's runs that run as jobs, read and ended
 * through definer functions that need platform access. It never sets a run's admission.
 */
export class PostgresJobRunRecords {
  constructor(
    private readonly pool: Pool,
    private readonly sender: IngestSender,
  ) {}

  #platform<T>(purpose: string, run: (client: PoolClient) => Promise<T>) {
    return withPlatformAccess(this.pool, purpose, run);
  }

  async open(): Promise<IngestionExecution[]> {
    const { rows } = await this.#platform('knowledge-runs', (client) =>
      client.query<Row>('select * from job_ingestion_executions()'),
    );
    return rows.map(toExecution);
  }

  async find(id: string): Promise<IngestionExecution | undefined> {
    const { rows } = await this.#platform('knowledge-run-admission', (client) =>
      client.query<Row>('select * from find_ingestion_execution($1)', [id]),
    );
    return rows[0] && toExecution(rows[0]);
  }

  async requests(): Promise<JobRunRequest[]> {
    const { rows } = await this.#platform('knowledge-run-requests', (client) =>
      client.query<{
        id: string;
        run: string;
        kind: 'redrive';
        previous_status: 'succeeded' | 'failed' | null;
        previous_error: string | null;
      }>(
        'select id, run, kind, previous_status, previous_error from pending_knowledge_job_requests()',
      ),
    );
    return rows.map((row) => ({
      id: row.id,
      run: row.run,
      kind: row.kind,
      previousStatus: row.previous_status ?? 'failed',
      ...(row.previous_error === null ? {} : { previousError: row.previous_error }),
    }));
  }

  async applied(id: string, at: string): Promise<void> {
    await this.#platform('knowledge-run-requests', (client) =>
      client.query('select apply_knowledge_job_request($1, $2)', [id, at]),
    );
  }

  async #startQueued(
    client: PoolClient,
    run: { dataset: string; pipeline: string },
    at: string,
    rules: QueuedRunRules,
  ) {
    await client.query('savepoint start_queued');
    const { rows } = await client.query<Row>(
      'select * from start_queued_job_ingestion_execution($1, $2, $3, $4, $5)',
      [run.dataset, run.pipeline, rules.admittedAfter ?? null, at, rules.expiredError],
    );
    const started = rows[0] && toExecution(rows[0]);
    // The pipeline's last ingest job may still be ending (a refused run ends from inside it);
    // the queued run then stays queued, and the reconciler starts it on a later pass.
    if (started && (await this.sender.send(started, client)) === null) {
      await client.query('rollback to savepoint start_queued');
      return undefined;
    }
    await client.query('release savepoint start_queued');
    return started;
  }

  /** Sets a running run's listing counts, or adds its documents' outcomes to them. */
  async report(id: string, counts: Record<string, number>, mode: 'set' | 'add'): Promise<void> {
    await this.#platform('knowledge-run-report', (client) =>
      client.query('select report_job_ingestion_execution($1, $2, $3)', [
        id,
        JSON.stringify(counts),
        mode === 'add',
      ]),
    );
  }

  /** Cancels a running run whose failed documents reached its pipeline's failure budget. */
  async stopAtBudget(id: string, at: string): Promise<void> {
    await this.#platform('knowledge-run-budget', (client) =>
      client.query('select stop_job_ingestion_execution_at_budget($1, $2)', [id, at]),
    );
  }

  /** Ends a running run and, in the same transaction, starts its pipeline's queued run. */
  async end(
    run: IngestionExecution,
    outcome: RunOutcome,
    at: string,
    rules: QueuedRunRules,
  ): Promise<{ ended?: IngestionExecution; started?: IngestionExecution }> {
    return this.#platform('knowledge-run-end', async (client) => {
      const { rows } = await client.query<Row>(
        'select * from end_job_ingestion_execution($1, $2, $3, $4, $5)',
        [
          run.id,
          outcome.status,
          at,
          outcome.report ? JSON.stringify(outcome.report) : null,
          outcome.error ?? null,
        ],
      );
      const ended = rows[0] && toExecution(rows[0]);
      if (!ended) return {};
      const started = await this.#startQueued(client, ended, at, rules);
      return { ended, ...(started ? { started } : {}) };
    });
  }

  /** Starts a pipeline's queued run when it has no open run, in case the run before did not. */
  async startQueued(
    run: { dataset: string; pipeline: string },
    at: string,
    rules: QueuedRunRules,
  ): Promise<IngestionExecution | undefined> {
    return this.#platform('knowledge-run-start', (client) =>
      this.#startQueued(client, run, at, rules),
    );
  }
}
