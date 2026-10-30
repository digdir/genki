import type { TraceDelivery, TraceDeliveryStore, TraceSent } from '@genai/jobs';
import type { Pool } from 'pg';
import { withPlatformAccess, withTenant } from './tenancy.js';

interface DeliveryRow {
  tenant: string;
  sink: string;
  task: string;
  trace: string;
  state: TraceDelivery['state'];
  attempts: number;
  last_error: string | null;
  judges: string[] | null;
  updated_at: Date;
}

const toDelivery = (row: DeliveryRow): TraceDelivery => ({
  tenant: row.tenant,
  sink: row.sink,
  task: row.task,
  trace: row.trace,
  state: row.state,
  attempts: row.attempts,
  ...(row.last_error === null ? {} : { lastError: row.last_error }),
  ...(row.judges && row.judges.length > 0 ? { judges: row.judges } : {}),
  updatedAt: row.updated_at.toISOString(),
});

export class PostgresTraceDeliveries implements TraceDeliveryStore {
  constructor(private readonly pool: Pool) {}

  async record(sent: TraceSent[], at: string): Promise<void> {
    for (const tenant of new Set(sent.map((s) => s.tenant)))
      await withTenant(this.pool, tenant, async (client) => {
        for (const s of sent.filter((x) => x.tenant === tenant))
          await client.query(
            `insert into trace_deliveries (tenant, sink, task, trace, state, attempts, updated_at)
             values ($1, $2, $3, $4, 'sent', 0, $5) on conflict do nothing`,
            [s.tenant, s.sink, s.task, s.trace, at],
          );
      });
  }

  async markPending(tenant: string, by: { tasks: string[] } | { sink: string }, at: string) {
    return withTenant(this.pool, tenant, async (client) => {
      const marked = await client.query(
        'tasks' in by
          ? `update trace_deliveries set state = 'pending', updated_at = $3
             where tenant = $1 and state = 'sent' and task = any($2)`
          : `update trace_deliveries set state = 'pending', updated_at = $3
             where tenant = $1 and state = 'sent' and sink = $2`,
        [tenant, 'tasks' in by ? by.tasks : by.sink, at],
      );
      return marked.rowCount ?? 0;
    });
  }

  async pending(limit: number): Promise<TraceDelivery[]> {
    return withPlatformAccess(this.pool, 'trace-sink-deletes', async (client) =>
      (
        await client.query<DeliveryRow>('select * from pending_trace_deletes($1)', [limit])
      ).rows.map(toDelivery),
    );
  }

  async settle(
    delivery: TraceDelivery,
    outcome: { deleted: true } | { error: string },
    at: string,
  ): Promise<void> {
    await withTenant(this.pool, delivery.tenant, (client) =>
      client.query(
        'deleted' in outcome
          ? `update trace_deliveries set state = 'deleted', last_error = null, updated_at = $4
             where tenant = $1 and sink = $2 and trace = $3`
          : `update trace_deliveries set attempts = attempts + 1, last_error = $5, updated_at = $4
             where tenant = $1 and sink = $2 and trace = $3`,
        'deleted' in outcome
          ? [delivery.tenant, delivery.sink, delivery.trace, at]
          : [delivery.tenant, delivery.sink, delivery.trace, at, outcome.error],
      ),
    );
  }

  async noteJudges(delivery: TraceDelivery, judges: string[], at: string): Promise<void> {
    await withTenant(this.pool, delivery.tenant, (client) =>
      client.query(
        `update trace_deliveries set judges = $4, updated_at = $5
         where tenant = $1 and sink = $2 and trace = $3`,
        [delivery.tenant, delivery.sink, delivery.trace, judges, at],
      ),
    );
  }

  async outstanding(tenant: string, sink: string): Promise<number> {
    return withTenant(this.pool, tenant, async (client) =>
      Number(
        (
          await client.query<{ n: string }>(
            `select count(*) as n from trace_deliveries
             where tenant = $1 and sink = $2 and state <> 'deleted'`,
            [tenant, sink],
          )
        ).rows[0]?.n ?? 0,
      ),
    );
  }
}
