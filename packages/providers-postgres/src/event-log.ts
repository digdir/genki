import { envelopeEventTypes, type Event, type EventActor, type Part } from '@genai/contracts';
import type { ContentScope, EventLog } from '@genai/kernel';
import type { Pool, PoolClient } from 'pg';
import { open, seal } from './crypto.js';
import type { ContentKeys } from './keys.js';

const CHANNEL = 'genai_events';
const envelopeTypes = new Set<string>(envelopeEventTypes);

interface Row {
  task: string;
  seq: number;
  type: string;
  v: number;
  ts: Date;
  actor: EventActor;
  audience: Event['audience'] | null;
  span: Event['span'] | null;
  tenant: string;
  scope: string;
  envelope: { data: unknown; fallback?: Part[] } | null;
  payload: Buffer | null;
}

export const erased = { erased: true } as const;

export class PostgresEventLog implements EventLog {
  readonly #waiters = new Map<string, (() => void)[]>();
  #listener: PoolClient | undefined;

  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
    private readonly pollMs = 1000,
    private readonly onError: (error: unknown) => void = () => undefined,
  ) {}

  async start(): Promise<void> {
    const listener = await this.pool.connect();
    this.#listener = listener;
    listener.on('error', (error) => {
      if (this.#listener !== listener) return;
      this.#listener = undefined;
      listener.release(error);
      this.onError(error);
    });
    listener.on('notification', (n) => {
      if (n.channel === CHANNEL && n.payload) this.#wakeLocal(n.payload);
    });
    await listener.query(`listen ${CHANNEL}`);
  }

  async close(): Promise<void> {
    const listener = this.#listener;
    if (!listener) return;
    this.#listener = undefined;
    await listener.query(`unlisten ${CHANNEL}`).catch(() => undefined);
    listener.removeAllListeners('notification');
    listener.release(true);
  }

  async append(event: Omit<Event, 'seq'>, scope: ContentScope): Promise<Event> {
    const isEnvelope = envelopeTypes.has(event.type);
    const content = { data: event.data, ...(event.fallback ? { fallback: event.fallback } : {}) };
    let payload: Buffer | null = null;
    if (!isEnvelope) {
      const key = await this.keys.get(scope.tenant, scope.key, true);
      if (!key) throw new Error('no content key');
      payload = seal(key, Buffer.from(JSON.stringify(content)), `${event.task}:${event.type}`);
    }

    const client = await this.pool.connect();
    try {
      await client.query('begin');
      await client.query('select pg_advisory_xact_lock(hashtext($1))', [event.task]);
      const next = await client.query<{ seq: number }>(
        'select coalesce(max(seq) + 1, 0)::int as seq from events where task = $1',
        [event.task],
      );
      const seq = next.rows[0]?.seq ?? 0;
      await client.query(
        `insert into events (task, seq, type, v, ts, actor, audience, span, tenant, scope, envelope, payload)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          event.task,
          seq,
          event.type,
          event.v,
          event.ts,
          JSON.stringify(event.actor),
          event.audience ?? null,
          event.span ? JSON.stringify(event.span) : null,
          scope.tenant,
          scope.key,
          isEnvelope ? JSON.stringify(content) : null,
          payload,
        ],
      );
      await client.query('select pg_notify($1, $2)', [CHANNEL, event.task]);
      await client.query('commit');
      return { ...event, seq } as Event;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  wake(task: string): void {
    this.#wakeLocal(task);
    this.pool.query('select pg_notify($1, $2)', [CHANNEL, task]).catch(() => undefined);
  }

  async *read(task: string, fromSeq: number, isLive: () => boolean): AsyncIterable<Event> {
    let next = Math.max(0, Math.trunc(fromSeq));
    for (;;) {
      const rows = await this.pool.query<Row>(
        'select * from events where task = $1 and seq >= $2 order by seq',
        [task, next],
      );
      for (const row of rows.rows) {
        next = row.seq + 1;
        yield await this.#decode(row);
      }
      if (!isLive()) return;
      await this.#wait(task);
    }
  }

  async #decode(row: Row): Promise<Event> {
    let content: { data: unknown; fallback?: Part[] } = { data: erased };
    if (row.envelope) {
      content = row.envelope;
    } else if (row.payload) {
      const key = await this.keys.get(row.tenant, row.scope, false);
      if (key) {
        try {
          content = JSON.parse(
            open(key, row.payload, `${row.task}:${row.type}`).toString(),
          ) as typeof content;
        } catch {
          content = { data: erased };
        }
      }
    }
    return {
      type: row.type,
      v: row.v,
      task: row.task,
      seq: row.seq,
      ts: row.ts.toISOString(),
      data: content.data,
      actor: row.actor,
      ...(row.span ? { span: row.span } : {}),
      ...(content.fallback ? { fallback: content.fallback } : {}),
      ...(row.audience ? { audience: row.audience } : {}),
    };
  }

  #wakeLocal(task: string) {
    const waiters = this.#waiters.get(task) ?? [];
    this.#waiters.delete(task);
    for (const w of waiters) w();
  }

  #wait(task: string) {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.pollMs);
      const waiters = this.#waiters.get(task) ?? [];
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
      this.#waiters.set(task, waiters);
    });
  }
}
