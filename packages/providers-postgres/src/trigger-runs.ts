import type { TriggerRunRecord, TriggerRunStore, TriggerRunTally } from '@genai/jobs';
import type { Pool } from 'pg';
import { withTenant } from './tenancy.js';

interface RunRow {
  id: string;
  tenant: string;
  service: string;
  trigger_id: string;
  kind: TriggerRunRecord['kind'];
  target: string;
  task: string | null;
  outcome: TriggerRunRecord['outcome'];
  error: string | null;
  code: string | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cost_micro_nok: string | number | null;
  at: Date;
}

const toRun = (row: RunRow): TriggerRunRecord => ({
  id: row.id,
  tenant: row.tenant,
  service: row.service,
  trigger: row.trigger_id,
  kind: row.kind,
  target: row.target,
  ...(row.task === null ? {} : { task: row.task }),
  outcome: row.outcome,
  ...(row.error === null ? {} : { error: row.error }),
  ...(row.code === null ? {} : { code: row.code }),
  ...(row.input_tokens === null || row.output_tokens === null
    ? {}
    : { usage: { inputTokens: row.input_tokens, outputTokens: row.output_tokens } }),
  ...(row.cost_micro_nok === null ? {} : { costMicroNok: Number(row.cost_micro_nok) }),
  at: row.at.toISOString(),
});

export class PostgresTriggerRuns implements TriggerRunStore {
  constructor(private readonly pool: Pool) {}

  async record(run: TriggerRunRecord): Promise<void> {
    await withTenant(this.pool, run.tenant, (client) =>
      client.query(
        `insert into trigger_runs (id, tenant, service, trigger_id, kind, target, task, outcome, error, at, code, input_tokens, output_tokens, cost_micro_nok)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
        [
          run.id,
          run.tenant,
          run.service,
          run.trigger,
          run.kind,
          run.target,
          run.task ?? null,
          run.outcome,
          run.error ?? null,
          run.at,
          run.code ?? null,
          run.usage?.inputTokens ?? null,
          run.usage?.outputTokens ?? null,
          run.costMicroNok ?? null,
        ],
      ),
    );
  }

  async recent(tenant: string, trigger: string, limit: number): Promise<TriggerRunRecord[]> {
    return withTenant(this.pool, tenant, async (db) =>
      (
        await db.query<RunRow>(
          `select * from trigger_runs where tenant = $1 and trigger_id = $2
           order by at desc, id desc limit $3`,
          [tenant, trigger, limit],
        )
      ).rows.map(toRun),
    );
  }

  async tally(tenant: string, since: string): Promise<TriggerRunTally[]> {
    return withTenant(this.pool, tenant, async (db) => {
      const counts = await db.query<{ trigger_id: string; runs: number; failed: number }>(
        `select trigger_id, count(*)::int as runs,
                count(*) filter (where outcome = 'failed')::int as failed
         from trigger_runs where tenant = $1 and at >= $2 group by trigger_id`,
        [tenant, since],
      );
      const last = await db.query<RunRow>(
        `select distinct on (trigger_id) * from trigger_runs where tenant = $1
         order by trigger_id, at desc, id desc`,
        [tenant],
      );
      const byTrigger = new Map(counts.rows.map((r) => [r.trigger_id, r]));
      return last.rows.map((row) => ({
        trigger: row.trigger_id,
        runs: byTrigger.get(row.trigger_id)?.runs ?? 0,
        failed: byTrigger.get(row.trigger_id)?.failed ?? 0,
        last: toRun(row),
      }));
    });
  }
}
