import { createHash } from 'node:crypto';
import type { Pool, PoolClient, QueryConfig, QueryResultRow } from 'pg';

const keyOf = (name: string) =>
  createHash('sha256').update(name).digest().readBigInt64BE(0).toString();

export interface LeaderLease {
  readonly held: boolean;
  tryAcquire(): Promise<boolean>;
  release(): Promise<void>;
}

export interface PostgresLeasesOptions {
  queryTimeoutMs?: number;
  checkEveryMs?: number;
  now?: () => number;
}

export class PostgresLeases {
  #client: Promise<PoolClient> | undefined;
  #checkedAt = 0;
  readonly #held = new Set<string>();
  readonly #queryTimeoutMs: number;
  readonly #checkEveryMs: number;
  readonly #now: () => number;

  constructor(
    private readonly pool: Pool,
    options: PostgresLeasesOptions = {},
  ) {
    this.#queryTimeoutMs = options.queryTimeoutMs ?? 5_000;
    this.#checkEveryMs = options.checkEveryMs ?? 10_000;
    this.#now = options.now ?? Date.now;
  }

  get validForMs() {
    return this.#checkEveryMs + this.#queryTimeoutMs;
  }

  #confirmed(name: string) {
    return this.#held.has(name) && this.#now() - this.#checkedAt < this.validForMs;
  }

  lease(name: string): LeaderLease {
    const confirmed = (lease: string) => this.#confirmed(lease);
    return {
      get held() {
        return confirmed(name);
      },
      tryAcquire: () => this.#acquire(name),
      release: () => this.#release(name),
    };
  }

  #connection() {
    if (this.#client) return this.#client;
    const connecting = this.pool.connect().then((client) => {
      const lost = () => this.#drop(connecting, client);
      client.on('error', lost);
      client.on('end', lost);
      return client;
    });
    this.#client = connecting;
    connecting.catch(() => {
      if (this.#client === connecting) this.#client = undefined;
    });
    return connecting;
  }

  #drop(connection: Promise<PoolClient>, client: PoolClient) {
    if (this.#client !== connection) return;
    this.#client = undefined;
    this.#held.clear();
    client.release(true);
  }

  #query<T extends QueryResultRow>(client: PoolClient, text: string, values: unknown[] = []) {
    const config: QueryConfig & { query_timeout: number } = {
      text,
      values,
      query_timeout: this.#queryTimeoutMs,
    };
    return client.query<T>(config);
  }

  async #alive(): Promise<boolean> {
    const connection = this.#client;
    if (!connection || this.#now() - this.#checkedAt < this.#checkEveryMs) return true;
    const client = await connection;
    try {
      await this.#query(client, 'select 1');
      this.#checkedAt = this.#now();
      return true;
    } catch {
      this.#drop(connection, client);
      return false;
    }
  }

  async #acquire(name: string): Promise<boolean> {
    if (this.#held.has(name) && (await this.#alive())) return true;
    const connection = this.#connection();
    const client = await connection;
    try {
      const found = await this.#query<{ ok: boolean }>(
        client,
        'select pg_try_advisory_lock($1::bigint) as ok',
        [keyOf(name)],
      );
      if (!found.rows[0]?.ok) return false;
    } catch (error) {
      this.#drop(connection, client);
      throw error;
    }
    if (this.#client !== connection) return false;
    this.#checkedAt = this.#now();
    this.#held.add(name);
    return true;
  }

  async #release(name: string): Promise<void> {
    if (!this.#held.delete(name)) return;
    const connection = this.#client;
    if (!connection) return;
    const client = await connection;
    await this.#query(client, 'select pg_advisory_unlock($1::bigint)', [keyOf(name)]).catch(
      () => undefined,
    );
    if (this.#held.size === 0) this.#drop(connection, client);
  }
}
