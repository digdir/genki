import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';

const keyOf = (name: string) => createHash('sha256').update(name).digest().readBigInt64BE(0);

export class PostgresLeaderLease {
  #client: PoolClient | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly name: string,
  ) {}

  get held() {
    return this.#client !== undefined;
  }

  async tryAcquire(): Promise<boolean> {
    if (this.#client) return true;
    const client = await this.pool.connect();
    try {
      const found = await client.query<{ ok: boolean }>(
        'select pg_try_advisory_lock($1::bigint) as ok',
        [keyOf(this.name).toString()],
      );
      if (!found.rows[0]?.ok) {
        client.release();
        return false;
      }
    } catch (error) {
      client.release(true);
      throw error;
    }
    const lost = () => {
      if (this.#client !== client) return;
      this.#client = undefined;
      client.release(true);
    };
    client.on('error', lost);
    client.on('end', lost);
    this.#client = client;
    return true;
  }

  async release(): Promise<void> {
    const client = this.#client;
    this.#client = undefined;
    client?.release(true);
  }
}
