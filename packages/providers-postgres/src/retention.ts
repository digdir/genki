import type {
  PurgeCount,
  RetentionCutoff,
  RetentionGroup,
  RetentionStore,
  ThreadCutoff,
  ThreadErasure,
  ThreadRetentionStore,
} from '@genai/kernel';
import type { Pool, PoolClient } from 'pg';
import { threadScope } from './conversations.js';
import type { ContentKeys } from './keys.js';
import { withTenant } from './tenancy.js';

const capabilityOf = `envelope->'service'->'capability'->>'id'`;
const taskScopePrefix = '["task",';

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
      await this.#dropTaskScopes(client, cutoff.tenant, expired.rows, false);

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
      await this.#dropTaskScopes(client, cutoff.tenant, stale.rows, true);
      await client.query('commit');
      return { payloads: staleIds.length, envelopes: expiredIds.length };
    } catch (error) {
      await client.query('rollback');
      throw error;
    } finally {
      client.release();
    }
  }

  async #dropTaskScopes(
    client: PoolClient,
    tenant: string,
    rows: { scope: string }[],
    recordErasure: boolean,
  ) {
    const scopes = rows.map((r) => r.scope).filter((s) => s.startsWith(taskScopePrefix));
    if (scopes.length === 0) return;
    await client.query('delete from state where tenant = $1 and scope = any($2)', [tenant, scopes]);
    await client.query('delete from content_keys where tenant = $1 and scope = any($2)', [
      tenant,
      scopes,
    ]);
    if (recordErasure)
      await client.query(
        `insert into erased_scopes (tenant, scope) select $1, unnest($2::text[])
         on conflict (tenant, scope) do update set erased_at = now()`,
        [tenant, scopes],
      );
    else
      await client.query('delete from erased_scopes where tenant = $1 and scope = any($2)', [
        tenant,
        scopes,
      ]);
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
    for (const { id } of removed.rows) await this.keys.erase(cutoff.tenant, threadScope(id));
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
    for (const { scope } of found.rows) await this.keys.erase(tenant, scope);
    return found.rows.length;
  }
}
