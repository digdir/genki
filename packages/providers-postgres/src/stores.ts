import type { Principal, Ref, Task, TaskStatus } from '@genai/contracts';
import {
  KernelError,
  type ContentScope,
  type StateStore,
  type StoredTask,
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

export class PostgresTaskStore implements TaskStore {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async put(stored: StoredTask, scope: ContentScope): Promise<void> {
    const key = await this.keys.get(scope.tenant, scope.key, true);
    if (!key) throw new Error('no content key');
    const { task } = stored;
    const body = seal(key, Buffer.from(JSON.stringify(stored)), `task:${task.id}`);
    await this.pool.query(
      `insert into tasks (id, tenant, owner, status, principal, assignee, last_seq, created_at, ended_at, envelope, scope, body)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       on conflict (id) do update set status = excluded.status, assignee = excluded.assignee,
         last_seq = excluded.last_seq, ended_at = excluded.ended_at, envelope = excluded.envelope,
         scope = excluded.scope, body = excluded.body`,
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
      ],
    );
  }

  async get(id: string): Promise<StoredTask | undefined> {
    const found = await this.pool.query<TaskRow>('select * from tasks where id = $1', [id]);
    const row = found.rows[0];
    return row && this.#decode(row);
  }

  async pendingFor(who: Ref): Promise<Task[]> {
    const found = await this.pool.query<TaskRow>(
      `select * from tasks where status = 'interrupted' and (principal = $1::jsonb or assignee = $1::jsonb)
       order by created_at`,
      [refJson(who)],
    );
    return Promise.all(found.rows.map(async (row) => (await this.#decode(row)).task));
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
