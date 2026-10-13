import type { Pool } from 'pg';

export type PostgresRateDecision = { ok: true } | { ok: false; retryAfterSeconds: number };

export class PostgresRateLimiter {
  #calls = 0;

  constructor(
    private readonly pool: Pool,
    private readonly windowMs = 60_000,
    private readonly sweepEvery = 1_000,
  ) {}

  async take(bucket: string, perMinute: number): Promise<PostgresRateDecision> {
    if (++this.#calls % this.sweepEvery === 0)
      void this.pool
        .query(
          `delete from rate_limit_windows where updated_at < now() - make_interval(secs => $1)`,
          [(this.windowMs * 2) / 1000],
        )
        .catch(() => undefined);
    const found = await this.pool.query<{ wait: string }>(
      'select take_rate_limit($1, $2, $3) as wait',
      [bucket, this.windowMs, perMinute],
    );
    const wait = Number(found.rows[0]?.wait ?? 0);
    return wait > 0
      ? { ok: false, retryAfterSeconds: Math.max(1, Math.ceil(wait / 1000)) }
      : { ok: true };
  }
}
