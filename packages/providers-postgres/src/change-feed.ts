import type { Pool, PoolClient } from 'pg';

const CHANNEL = 'genai_changes';

export type ChangeTopic =
  | 'settings'
  | 'support-sessions'
  | 'config-entries'
  | 'definitions'
  | 'model-classifications'
  | 'tool-connections';

export interface PostgresChangeFeedOptions {
  pollMs?: number;
  reconnectMs?: number;
  maxReconnectMs?: number;
  onError?: (error: unknown) => void;
}

type Listener = () => void | Promise<void>;

export class PostgresChangeFeed {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #seen = new Map<string, string>();
  readonly #running = new Set<string>();
  readonly #dirty = new Set<string>();
  readonly #pollMs: number;
  readonly #reconnectMs: number;
  readonly #maxReconnectMs: number;
  readonly #onError: (error: unknown) => void;
  #client: PoolClient | undefined;
  #timer: NodeJS.Timeout | undefined;
  #reconnect: NodeJS.Timeout | undefined;
  #attempts = 0;
  #baseline = false;
  #polling: Promise<void> | undefined;
  #repoll = false;
  #closed = true;

  constructor(
    private readonly pool: Pool,
    options: PostgresChangeFeedOptions = {},
  ) {
    this.#pollMs = options.pollMs ?? 5000;
    this.#reconnectMs = options.reconnectMs ?? 100;
    this.#maxReconnectMs = options.maxReconnectMs ?? 5000;
    this.#onError = options.onError ?? (() => undefined);
  }

  on(topic: string, fn: Listener): () => void {
    const set = this.#listeners.get(topic) ?? new Set<Listener>();
    set.add(fn);
    this.#listeners.set(topic, set);
    return () => {
      set.delete(fn);
    };
  }

  async start(): Promise<void> {
    if (!this.#closed) return;
    this.#closed = false;
    this.#timer = setInterval(() => void this.poll().catch(this.#onError), this.#pollMs);
    this.#timer.unref();
    await this.#connect();
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    clearTimeout(this.#reconnect);
    this.#timer = undefined;
    this.#reconnect = undefined;
    const client = this.#client;
    this.#client = undefined;
    client?.release(true);
    await this.#polling?.catch(() => undefined);
  }

  /** Fires every topic whose stored version differs from the last one seen. */
  poll(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#polling) {
      this.#repoll = true;
      return this.#polling;
    }
    this.#polling = (async () => {
      try {
        do {
          this.#repoll = false;
          await this.#pollOnce();
        } while (this.#repoll && !this.#closed);
      } finally {
        this.#polling = undefined;
      }
    })();
    return this.#polling;
  }

  async #pollOnce() {
    const found = await this.pool.query<{ topic: string; version: string }>(
      'select topic, version from change_versions',
    );
    const changed: string[] = [];
    for (const row of found.rows) {
      if (this.#seen.get(row.topic) !== row.version) changed.push(row.topic);
      this.#seen.set(row.topic, row.version);
    }
    if (!this.#baseline) {
      this.#baseline = true;
      return;
    }
    if (!this.#closed) for (const topic of changed) this.#fire(topic);
  }

  async #connect() {
    let client: PoolClient | undefined;
    try {
      client = await this.pool.connect();
      client.on('error', (error) => this.#lost(client, error));
      client.on('end', () => this.#lost(client, new Error('listener connection ended')));
      client.on('notification', (n) => {
        if (n.channel === CHANNEL) void this.poll().catch(this.#onError);
      });
      await client.query(`listen ${CHANNEL}`);
      if (this.#closed) {
        client.release(true);
        return;
      }
      this.#client = client;
      this.#attempts = 0;
      await this.poll();
    } catch (error) {
      this.#lost(client, error);
    }
  }

  #lost(client: PoolClient | undefined, error: unknown) {
    if (client && this.#client !== undefined && this.#client !== client) return;
    if (client && this.#client === client) this.#client = undefined;
    if (client) {
      client.removeAllListeners('notification');
      try {
        client.release(error instanceof Error ? error : true);
      } catch {
        /* already released */
      }
    }
    if (this.#closed || this.#reconnect) return;
    this.#onError(error);
    const delay = Math.min(this.#reconnectMs * 2 ** this.#attempts, this.#maxReconnectMs);
    this.#attempts += 1;
    this.#reconnect = setTimeout(() => {
      this.#reconnect = undefined;
      void this.#connect();
    }, delay);
    this.#reconnect.unref();
  }

  #fire(topic: string) {
    if (this.#running.has(topic)) {
      this.#dirty.add(topic);
      return;
    }
    this.#running.add(topic);
    void (async () => {
      try {
        do {
          this.#dirty.delete(topic);
          for (const fn of [...(this.#listeners.get(topic) ?? [])]) {
            try {
              await fn();
            } catch (error) {
              this.#onError(error);
            }
          }
        } while (this.#dirty.has(topic) && !this.#closed);
      } finally {
        this.#running.delete(topic);
        this.#dirty.delete(topic);
      }
    })();
  }
}
