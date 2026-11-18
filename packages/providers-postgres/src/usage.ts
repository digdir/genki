import {
  organisationOf,
  type AssignedUsageRow,
  type CurrencyRate,
  type UsageBucketStore,
  type UsageBucketWrite,
  type UsageReads,
  type UsageRow,
} from '@genai/port-usage';
import type { Pool } from 'pg';
import { withPlatformAccess, withTenant } from './tenancy.js';

interface BucketRow {
  tenant?: string;
  source: string;
  start: Date;
  model: string;
  subject_kind: string;
  subject_id: string;
  subject_org: string;
  closed: boolean;
  input_tokens: string;
  output_tokens: string;
  cached_input_tokens: string;
  cache_write_tokens: string;
  requests: string;
  unpriced_requests: string;
  currency: string;
  micros: string;
}

const toRow = (row: BucketRow): UsageRow => ({
  source: row.source,
  start: row.start.toISOString(),
  closed: row.closed,
  ...(row.model ? { model: row.model } : {}),
  ...(row.subject_kind
    ? {
        subject: {
          kind: row.subject_kind,
          id: row.subject_id,
          ...(row.subject_org ? { org: row.subject_org } : {}),
        },
      }
    : {}),
  inputTokens: Number(row.input_tokens),
  outputTokens: Number(row.output_tokens),
  cachedInputTokens: Number(row.cached_input_tokens),
  cacheWriteTokens: Number(row.cache_write_tokens),
  requests: Number(row.requests),
  unpricedRequests: Number(row.unpriced_requests),
  cost: { currency: row.currency, micros: Number(row.micros) },
});

const toAssigned = (row: BucketRow): AssignedUsageRow => ({
  ...toRow(row),
  tenant: row.tenant ?? '',
});

const incoming = (row: UsageRow) => ({
  model: row.model ?? '',
  subject_kind: row.subject?.kind ?? '',
  subject_id: row.subject?.id ?? '',
  subject_org: row.subject?.org ?? '',
  org: organisationOf(row.subject) ?? null,
  input_tokens: row.inputTokens,
  output_tokens: row.outputTokens,
  cached_input_tokens: row.cachedInputTokens,
  cache_write_tokens: row.cacheWriteTokens,
  requests: row.requests,
  unpriced_requests: row.unpricedRequests,
  currency: row.cost.currency,
  micros: row.cost.micros,
});

const markSql = `insert into usage_marks (source, closed_through) values ($1, $2)
  on conflict (source) do update
  set closed_through = greatest(usage_marks.closed_through, excluded.closed_through)`;

/** Hourly usage of outside sources; the worker writes it, tenants read their own rows. */
export class PostgresUsageBuckets implements UsageBucketStore, UsageReads {
  constructor(private readonly pool: Pool) {}

  async closedThrough(source: string) {
    const found = await this.pool.query<{ closed_through: Date }>(
      'select closed_through from usage_marks where source = $1',
      [source],
    );
    return found.rows[0]?.closed_through.toISOString();
  }

  async openStarts(source: string) {
    const found = await withPlatformAccess(this.pool, 'usage-poll', (client) =>
      client.query<{ start: Date }>(
        'select usage_open_starts as start from usage_open_starts($1)',
        [source],
      ),
    );
    return found.rows.map((r) => r.start.toISOString());
  }

  async store(source: string, bucket: UsageBucketWrite, closedThrough: string | undefined) {
    return withPlatformAccess(this.pool, 'usage-poll', async (client) => {
      const found = await client.query<{ differing: number }>(
        'select store_usage_bucket($1, $2, $3, $4) as differing',
        [source, bucket.start, bucket.closed, JSON.stringify(bucket.rows.map(incoming))],
      );
      if (closedThrough !== undefined) await client.query(markSql, [source, closedThrough]);
      return { breaches: Number(found.rows[0]?.differing ?? 0) };
    });
  }

  async advance(source: string, closedThrough: string) {
    await this.pool.query(markSql, [source, closedThrough]);
  }

  async tenantRows(tenants: readonly string[], from: Date, to: Date) {
    if (tenants.length === 0) return [];
    if (tenants.length === 1) {
      const tenant = tenants[0] as string;
      return withTenant(this.pool, tenant, async (client) =>
        (
          await client.query<BucketRow>(
            `select * from usage_buckets where tenant = $1 and start >= $2 and start < $3
             order by start, source, model, subject_kind, subject_id, subject_org`,
            [tenant, from, to],
          )
        ).rows.map(toAssigned),
      );
    }
    return withPlatformAccess(this.pool, 'operator-usage', async (client) =>
      (
        await client.query<BucketRow>('select * from platform_usage_buckets($1, $2, $3)', [
          [...tenants],
          from,
          to,
        ])
      ).rows.map(toAssigned),
    );
  }

  async unassignedRows(from: Date, to: Date) {
    return withPlatformAccess(this.pool, 'operator-usage', async (client) =>
      (
        await client.query<BucketRow>('select * from platform_usage_unassigned($1, $2)', [from, to])
      ).rows.map(toRow),
    );
  }

  async rates(): Promise<CurrencyRate[]> {
    const found = await this.pool.query<{ currency: string; day: string; nok_per_unit: string }>(
      `select currency, to_char(day, 'YYYY-MM-DD') as day, nok_per_unit::text as nok_per_unit
         from currency_rates order by currency, day`,
    );
    return found.rows.map((r) => ({
      currency: r.currency,
      day: r.day,
      nokPerUnit: Number(r.nok_per_unit),
    }));
  }

  async putRates(rates: readonly CurrencyRate[]) {
    for (const rate of rates)
      await this.pool.query(
        `insert into currency_rates (currency, day, nok_per_unit) values ($1, $2, $3)
         on conflict (currency, day) do update set nok_per_unit = excluded.nok_per_unit`,
        [rate.currency, rate.day, rate.nokPerUnit],
      );
  }
}
