import {
  outsideRunLogPrefix,
  outsideRunTask,
  type OutsideRunCutoff,
  type OutsideRunRetentionStore,
  type PurgeCount,
  type RetentionCutoff,
  type RetentionGroup,
  type RetentionStore,
  type ThreadCutoff,
  type ThreadErasure,
  type ThreadRetentionStore,
} from '@genai/kernel';
import type { Pool, PoolClient } from 'pg';
import { threadScope } from './conversations.js';
import type { ContentKeys } from './keys.js';
import { withTenant } from './tenancy.js';

const capabilityOf = `envelope->'service'->'capability'->>'id'`;
const taskScopePrefix = '["task",';

const dropTaskScopes = async (
  client: PoolClient,
  tenant: string,
  rows: { scope: string }[],
  recordErasure: boolean,
) => {
  const scopes = rows.map((r) => r.scope).filter((s) => s.startsWith(taskScopePrefix));
  if (scopes.length === 0) return;
  await client.query('delete from state where tenant = $1 and scope = any($2)', [tenant, scopes]);
  await client.query('delete from content_keys where tenant = $1 and scope = any($2)', [
    tenant,
    scopes,
  ]);
  if (recordErasure)
    await client.query(
      `insert into erased_scopes (tenant, scope, reason) select $1, unnest($2::text[]), 'retention'
       on conflict (tenant, scope) do update set erased_at = now(), reason = excluded.reason`,
      [tenant, scopes],
    );
  else
    await client.query('delete from erased_scopes where tenant = $1 and scope = any($2)', [
      tenant,
      scopes,
    ]);
};

export class PostgresRetentionStore implements RetentionStore {
  constructor(private readonly pool: Pool) {}

  async groups(): Promise<RetentionGroup[]> {
    const found = await this.pool.query<{ tenant: string; capability: string }>(
      `select distinct tenant, ${capabilityOf} as capability from tasks
       where ended_at is not null order by tenant, capability`,
    );
    return found.rows.map((row) => ({ tenant: row.tenant, capability: row.capability }));
  }

  async purge(cutoff: RetentionCutoff): Promise<PurgeCount> {
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      const expired = await client.query<{ id: string; scope: string }>(
        `delete from tasks where tenant = $1 and ${capabilityOf} = $2 and ended_at < $3
         returning id, scope`,
        [cutoff.tenant, cutoff.capability, cutoff.envelopeBefore],
      );
      const expiredIds = expired.rows.map((r) => r.id);
      await client.query('delete from events where task = any($1)', [expiredIds]);
      await dropTaskScopes(client, cutoff.tenant, expired.rows, false);

      const stale = await client.query<{ id: string; scope: string }>(
        `select id, scope from tasks t
         where tenant = $1 and ${capabilityOf} = $2 and ended_at < $3
           and (body is not null or exists (
             select 1 from events e where e.task = t.id and e.payload is not null))`,
        [cutoff.tenant, cutoff.capability, cutoff.payloadBefore],
      );
      const staleIds = stale.rows.map((r) => r.id);
      await client.query(
        'update events set payload = null where task = any($1) and payload is not null',
        [staleIds],
      );
      await client.query('update tasks set body = null where id = any($1)', [staleIds]);
      await dropTaskScopes(client, cutoff.tenant, stale.rows, true);
      // What went to a trace sink is queued for deletion in the same transaction as the purge.
      await client.query(`select set_config('app.tenant', $1, true)`, [cutoff.tenant]);
      const marked = await client.query(
        `update trace_deliveries set state = 'pending', updated_at = now()
         where tenant = $1 and task = any($2) and state = 'sent'`,
        [cutoff.tenant, [...staleIds, ...expiredIds]],
      );
      await client.query('commit');
      return {
        payloads: staleIds.length,
        envelopes: expiredIds.length,
        tasks: [...staleIds, ...expiredIds],
        traceDeletes: marked.rowCount ?? 0,
      };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresOutsideRunRetention implements OutsideRunRetentionStore {
  constructor(private readonly pool: Pool) {}

  async purge(cutoff: OutsideRunCutoff): Promise<number> {
    const prefix = outsideRunLogPrefix(cutoff.tenant);
    const client = await this.pool.connect();
    try {
      await client.query('begin');
      // The range uses the primary key; starts_with keeps it exact under any collation.
      const expired = await client.query<{ task: string }>(
        `select distinct task from events
         where task >= $2 and task < $3 and starts_with(task, $2) and tenant = $1`,
        [cutoff.tenant, prefix, outsideRunTask(cutoff.tenant, cutoff.before)],
      );
      const tasks = expired.rows.map((r) => r.task);
      await client.query('delete from events where tenant = $1 and task = any($2)', [
        cutoff.tenant,
        tasks,
      ]);
      await dropTaskScopes(
        client,
        cutoff.tenant,
        tasks.map((task) => ({ scope: JSON.stringify(['task', task]) })),
        false,
      );
      await client.query('commit');
      return tasks.length;
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }
}

export class PostgresThreadRetention implements ThreadRetentionStore {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async agents(tenant: string): Promise<string[]> {
    const found = await withTenant(this.pool, tenant, (client) =>
      client.query<{ agent_id: string }>(
        'select distinct agent_id from conversations where tenant = $1 order by agent_id',
        [tenant],
      ),
    );
    return found.rows.map((r) => r.agent_id);
  }

  async purge(cutoff: ThreadCutoff): Promise<number> {
    const removed = await withTenant(this.pool, cutoff.tenant, (client) =>
      client.query<{ id: string }>(
        `delete from conversations c where tenant = $1 and agent_id = $2
           and greatest(c.created, coalesce(
             (select max(m.created) from conversation_messages m where m.conversation = c.id), 0)) < $3
         returning id`,
        [cutoff.tenant, cutoff.agent, cutoff.before.getTime()],
      ),
    );
    for (const { id } of removed.rows)
      await this.keys.erase(cutoff.tenant, threadScope(id), 'retention');
    return removed.rows.length;
  }
}

export class PostgresThreadErasure implements ThreadErasure {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async erase(tenant: string, thread: string): Promise<number> {
    const found = await this.pool.query<{ scope: string }>(
      `select distinct scope from tasks
       where tenant = $1 and envelope->>'thread' = $2 and starts_with(scope, '["thread",')`,
      [tenant, thread],
    );
    for (const { scope } of found.rows)
      await this.keys.erase(tenant, scope, 'conversation-deleted');
    return found.rows.length;
  }
}
