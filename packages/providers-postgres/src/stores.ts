import { randomUUID } from 'node:crypto';
import type { Principal, Ref, Task, TaskStatus } from '@genai/contracts';
import {
  KernelError,
  type ContentScope,
  type ErasureReason,
  type StateStore,
  type StoredTask,
  type TaskErasure,
  type TaskStore,
} from '@genai/kernel';
import type { Pool } from 'pg';
import { open, seal } from './crypto.js';
import type { ContentKeys } from './keys.js';

const refJson = (ref: Ref) =>
  JSON.stringify({
    kind: ref.kind,
    id: ref.id,
    ...(ref.tenant === undefined ? {} : { tenant: ref.tenant }),
  });

const envelopeOf = (task: Task): Task => {
  const { pendingInterrupt, ...rest } = task;
  delete rest.result;
  return {
    ...rest,
    ...(pendingInterrupt
      ? {
          pendingInterrupt: {
            id: pendingInterrupt.id,
            reason: '',
            prompt: [],
            ...(pendingInterrupt.assignee ? { assignee: pendingInterrupt.assignee } : {}),
            ...(pendingInterrupt.expiresAt ? { expiresAt: pendingInterrupt.expiresAt } : {}),
          },
        }
      : {}),
  };
};

interface TaskRow {
  id: string;
  envelope: Task;
  principal: Ref;
  tenant: string;
  scope: string;
  last_seq: number;
  body: Buffer | null;
}

export interface TaskSummary {
  id: string;
  tenant: string;
  status: TaskStatus;
  createdAt: string;
  endedAt?: string;
}

export interface TaskQuery {
  tenant?: string;
  status?: TaskStatus | TaskStatus[];
  limit?: number;
}

export interface TaskLeaseOptions {
  instance?: string;
  leaseMs?: number;
  unleasedMs?: number;
  now?: () => Date;
}

export interface StoppedTask {
  id: string;
  tenant: string;
  scope: string;
}

export class PostgresTaskStore implements TaskStore {
  readonly instance: string;
  readonly #leaseMs: number;
  readonly #unleasedMs: number;
  readonly #now: () => Date;

  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
    private readonly lease: TaskLeaseOptions = {},
  ) {
    this.instance = lease.instance ?? randomUUID();
    this.#leaseMs = lease.leaseMs ?? 120_000;
    this.#unleasedMs = lease.unleasedMs ?? 60 * 60_000;
    this.#now = lease.now ?? (() => new Date());
  }

  withLease(lease: TaskLeaseOptions): PostgresTaskStore {
    return new PostgresTaskStore(this.pool, this.keys, { ...this.lease, ...lease });
  }

  #leaseEnd() {
    return new Date(this.#now().getTime() + this.#leaseMs).toISOString();
  }

  async put(stored: StoredTask, scope: ContentScope): Promise<void> {
    const key = await this.keys.get(scope.tenant, scope.key, true);
    if (!key) throw new Error('no content key');
    const { task } = stored;
    const body = seal(key, Buffer.from(JSON.stringify(stored)), `task:${task.id}`);
    await this.pool.query(
      `insert into tasks (id, tenant, owner, status, principal, assignee, last_seq, created_at, ended_at, envelope, scope, body, lease_owner, lease_until)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
         case when $4 in ('queued', 'running') then $13 end,
         case when $4 in ('queued', 'running') then $14::timestamptz end)
       on conflict (id) do update set status = excluded.status, assignee = excluded.assignee,
         last_seq = excluded.last_seq, ended_at = excluded.ended_at, envelope = excluded.envelope,
         scope = excluded.scope, body = excluded.body,
         cancel_requested_at = case when excluded.status in ('queued', 'running')
           then tasks.cancel_requested_at end,
         lease_owner = case when excluded.status in ('queued', 'running')
           then coalesce(tasks.lease_owner, excluded.lease_owner) end,
         lease_until = case when excluded.status in ('queued', 'running')
           then coalesce(tasks.lease_until, excluded.lease_until) end
       where tasks.status = 'interrupted'
         or (tasks.status in ('queued', 'running')
           and (tasks.lease_owner is null or tasks.lease_owner = $13))
         or (tasks.status in ('completed', 'failed', 'cancelled') and tasks.status = excluded.status
           and tasks.ended_at is not distinct from excluded.ended_at)`,
      [
        task.id,
        task.tenant,
        task.owner,
        task.status,
        refJson(task.principal),
        task.pendingInterrupt?.assignee ? refJson(task.pendingInterrupt.assignee) : null,
        stored.lastSeq,
        task.createdAt,
        task.endedAt ?? null,
        JSON.stringify(envelopeOf(task)),
        scope.key,
        body,
        this.instance,
        this.#leaseEnd(),
      ],
    );
  }

  async renewLeases(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const found = await this.pool.query<{ id: string }>(
      `update tasks set lease_until = $3
        where id = any($1) and status in ('queued', 'running') and lease_owner = $2
        returning id`,
      [ids, this.instance, this.#leaseEnd()],
    );
    return found.rows.map((row) => row.id);
  }

  async claimStopped(limit: number): Promise<StoppedTask[]> {
    const now = this.#now();
    const found = await this.pool.query<StoppedTask>(
      `update tasks t set lease_owner = $1, lease_until = $2
         from (select id from tasks
                where status in ('queued', 'running')
                  and coalesce(lease_until, created_at + make_interval(secs => $4)) < $3
                order by created_at limit $5 for update skip locked) stopped
        where t.id = stopped.id
        returning t.id, t.tenant, t.scope`,
      [this.instance, this.#leaseEnd(), now.toISOString(), this.#unleasedMs / 1000, limit],
    );
    return found.rows;
  }

  async get(id: string): Promise<StoredTask | undefined> {
    const found = await this.pool.query<TaskRow>('select * from tasks where id = $1', [id]);
    const row = found.rows[0];
    return row && this.#decode(row);
  }

  async requestCancel(id: string, at: string): Promise<void> {
    await this.pool.query(
      `update tasks set cancel_requested_at = $2
        where id = $1 and status in ('queued', 'running') and cancel_requested_at is null`,
      [id, at],
    );
  }

  async cancelRequested(ids: readonly string[]): Promise<string[]> {
    if (ids.length === 0) return [];
    const found = await this.pool.query<{ id: string }>(
      'select id from tasks where id = any($1) and cancel_requested_at is not null',
      [ids],
    );
    return found.rows.map((row) => row.id);
  }

  async pendingFor(who: Ref): Promise<Task[]> {
    const found = await this.pool.query<TaskRow>(
      `select * from tasks where status = 'interrupted' and (principal = $1::jsonb or assignee = $1::jsonb)
       order by created_at`,
      [refJson(who)],
    );
    return Promise.all(found.rows.map(async (row) => (await this.#decode(row)).task));
  }

  async erasures(tenant: string, tasks: string[]): Promise<TaskErasure[]> {
    if (tasks.length === 0) return [];
    const found = await this.pool.query<{
      id: string;
      scope: string;
      reason: ErasureReason | null;
      erased_at: Date | null;
    }>(
      `select t.id, t.scope, e.reason, e.erased_at from tasks t
       left join erased_scopes e on e.tenant = t.tenant and e.scope = t.scope
       where t.tenant = $1 and t.id = any($2) and (e.scope is not null or t.body is null)`,
      [tenant, tasks],
    );
    return found.rows.map((row) => ({
      task: row.id,
      reason:
        row.reason ??
        (row.erased_at === null || row.scope.startsWith('["task",') ? 'retention' : 'erased'),
      ...(row.erased_at ? { at: row.erased_at.toISOString() } : {}),
    }));
  }

  async list(query: TaskQuery = {}): Promise<TaskSummary[]> {
    const status = query.status === undefined ? null : [query.status].flat();
    const found = await this.pool.query<{
      id: string;
      tenant: string;
      status: TaskStatus;
      created_at: Date;
      ended_at: Date | null;
    }>(
      `select id, tenant, status, created_at, ended_at from tasks
       where ($1::text is null or tenant = $1) and ($2::text[] is null or status = any($2))
       order by created_at desc limit $3`,
      [query.tenant ?? null, status, query.limit ?? 200],
    );
    return found.rows.map((row) => ({
      id: row.id,
      tenant: row.tenant,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at.toISOString() }),
    }));
  }

  async envelopes(query: { tenant: string; since?: string; limit?: number }): Promise<Task[]> {
    const found = await this.pool.query<{ envelope: Task }>(
      `select envelope from tasks
       where tenant = $1 and ($2::timestamptz is null or created_at >= $2)
       order by created_at desc limit $3`,
      [query.tenant, query.since ?? null, query.limit ?? 1000],
    );
    return found.rows.map((row) => row.envelope);
  }

  async tokensUsed(query: {
    tenant: string;
    since: string;
    excludeCapabilityPrefix?: string;
  }): Promise<number> {
    const found = await this.pool.query<{ tokens: string }>(
      `select coalesce(sum(
         coalesce((envelope->'usage'->>'inputTokens')::numeric, 0) +
         coalesce((envelope->'usage'->>'outputTokens')::numeric, 0)), 0) as tokens
       from tasks
       where tenant = $1 and created_at >= $2
         and ($3::text is null
           or not starts_with(coalesce(envelope->'service'->'capability'->>'id', ''), $3))`,
      [query.tenant, query.since, query.excludeCapabilityPrefix ?? null],
    );
    return Number(found.rows[0]?.tokens ?? 0);
  }

  async #decode(row: TaskRow): Promise<StoredTask> {
    if (row.body) {
      const key = await this.keys.get(row.tenant, row.scope, false);
      if (key) {
        try {
          return JSON.parse(open(key, row.body, `task:${row.id}`).toString()) as StoredTask;
        } catch {
          /* falls through to the envelope */
        }
      }
    }
    const principal: Principal = {
      kind: row.principal.kind as Principal['kind'],
      issuer: 'erased',
      subject: 'erased',
      ...(row.principal.tenant === undefined ? {} : { tenant: row.principal.tenant }),
    };
    return { task: row.envelope, principal, lastSeq: row.last_seq };
  }
}

export class PostgresStateStore implements StateStore {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async get(key: string, scope: ContentScope): Promise<{ v: number; value: unknown } | undefined> {
    const found = await this.pool.query<{
      v: number;
      value: Buffer;
      tenant: string;
      scope: string;
    }>('select v, value, tenant, scope from state where key = $1', [key]);
    const row = found.rows[0];
    if (!row) return undefined;
    const contentKey = await this.keys.get(row.tenant, row.scope, false);
    if (!contentKey || row.tenant !== scope.tenant) return { v: row.v, value: null };
    try {
      return {
        v: row.v,
        value: JSON.parse(open(contentKey, row.value, `state:${key}`).toString()) as unknown,
      };
    } catch {
      return { v: row.v, value: null };
    }
  }

  async put(key: string, value: unknown, scope: ContentScope, expectV?: number): Promise<number> {
    const contentKey = await this.keys.get(scope.tenant, scope.key, true);
    if (!contentKey) throw new Error('no content key');
    const sealed = seal(contentKey, Buffer.from(JSON.stringify(value ?? null)), `state:${key}`);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const current = await client.query<{ v: number }>(
        'select v from state where key = $1 for update',
        [key],
      );
      const v = current.rows[0]?.v ?? 0;
      if (expectV !== undefined && v !== expectV) {
        throw new KernelError('invalid_state', `state ${key} changed since version ${expectV}`);
      }
      await client.query(
        `insert into state (key, v, tenant, scope, value) values ($1, $2, $3, $4, $5)
         on conflict (key) do update set v = excluded.v, tenant = excluded.tenant, scope = excluded.scope, value = excluded.value`,
        [key, v + 1, scope.tenant, scope.key, sealed],
      );
      await client.query('commit');
      return v + 1;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}
