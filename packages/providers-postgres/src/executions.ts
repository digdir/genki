import type { Pool } from 'pg';
import { withPlatformAccess, withTenant } from './tenancy.js';

export type IngestionExecutionStatus =
  'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export interface IngestionExecutionReport {
  stored: number;
  skipped: number;
  failed: string[];
  /** Documents whose jobs ended as dead letters, for a run that runs as jobs. */
  failedDocuments?: number;
  /** For a run on the knowledge database: what its listing found against its pipeline's records. */
  new?: number;
  changed?: number;
  deleted?: number;
  unchanged?: number;
}

export interface IngestionExecution {
  id: string;
  dataset: string;
  pipeline: string;
  pipelineVersion: number;
  backend: string;
  status: IngestionExecutionStatus;
  startedBy: string;
  startedAt: string;
  endedAt?: string;
  report?: IngestionExecutionReport;
  error?: string;
  /** Runs as knowledge jobs, ends with them, and is left alone by the check for stopped runs. */
  runsAsJobs?: boolean;
  /** When the API admitted the run; only the API sets it (ADR 0042, "Jobs"). */
  admittedAt?: string;
  cancelRequestedAt?: string;
  cancelledBy?: string;
}

export interface Row {
  id: string;
  scope: string;
  dataset: string;
  pipeline: string;
  pipeline_version: number;
  backend: string;
  status: IngestionExecutionStatus;
  started_by: string;
  started_at: string;
  ended_at: string | null;
  report: IngestionExecutionReport | null;
  error: string | null;
  runs_as_jobs?: boolean;
  admitted_at?: string | null;
  cancel_requested_at?: string | null;
  cancelled_by?: string | null;
}

export const executionScope = (dataset: string) => /^(\d{9})\//.exec(dataset)?.[1] ?? 'platform';

export const toExecution = (row: Row): IngestionExecution => ({
  id: row.id,
  dataset: row.dataset,
  pipeline: row.pipeline,
  pipelineVersion: row.pipeline_version,
  backend: row.backend,
  status: row.status,
  startedBy: row.started_by,
  startedAt: row.started_at,
  ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
  ...(row.report === null ? {} : { report: row.report }),
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.runs_as_jobs ? { runsAsJobs: true } : {}),
  ...(row.admitted_at ? { admittedAt: row.admitted_at } : {}),
  ...(row.cancel_requested_at ? { cancelRequestedAt: row.cancel_requested_at } : {}),
  ...(row.cancelled_by ? { cancelledBy: row.cancelled_by } : {}),
});

export class PostgresIngestionExecutions {
  constructor(private readonly pool: Pool) {}

  async save(execution: IngestionExecution): Promise<void> {
    const scope = executionScope(execution.dataset);
    await withTenant(this.pool, scope, (client) =>
      client.query(
        `insert into ingestion_executions (id, scope, dataset, pipeline, pipeline_version, backend,
           status, started_by, started_at, ended_at, report, error)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (id) do update set status = excluded.status, ended_at = excluded.ended_at,
           report = excluded.report, error = excluded.error`,
        [
          execution.id,
          scope,
          execution.dataset,
          execution.pipeline,
          execution.pipelineVersion,
          execution.backend,
          execution.status,
          execution.startedBy,
          execution.startedAt,
          execution.endedAt ?? null,
          execution.report === undefined ? null : JSON.stringify(execution.report),
          execution.error ?? null,
        ],
      ),
    );
  }

  async get(id: string): Promise<IngestionExecution | undefined> {
    const found = await withPlatformAccess(this.pool, 'ingestion-execution-lookup', (client) =>
      client.query<Row>('select * from find_ingestion_execution($1)', [id]),
    );
    const row = found.rows[0];
    return row && toExecution(row);
  }

  async beat(execution: IngestionExecution, at: string): Promise<void> {
    await withTenant(this.pool, executionScope(execution.dataset), (client) =>
      client.query(
        `update ingestion_executions set heartbeat_at = $2 where id = $1 and status = 'running'`,
        [execution.id, at],
      ),
    );
  }

  async failStale(input: {
    heartbeatBefore: string;
    except: string[];
    endedAt: string;
    error: string;
  }): Promise<number> {
    const result = await withPlatformAccess(this.pool, 'ingestion-stale-runs', (client) =>
      client.query<{ changed: number }>(
        'select fail_stopped_ingestion_executions($1, $2, $3, $4) as changed',
        [input.heartbeatBefore, input.except, input.endedAt, input.error],
      ),
    );
    return result.rows[0]?.changed ?? 0;
  }

  async list(dataset: string, pipeline: string): Promise<IngestionExecution[]> {
    const rows = await withTenant(this.pool, executionScope(dataset), async (client) => {
      const found = await client.query<Row>(
        `select * from ingestion_executions where dataset = $1 and pipeline = $2
         order by started_at desc`,
        [dataset, pipeline],
      );
      return found.rows;
    });
    return rows.map(toExecution);
  }
}
