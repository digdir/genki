import type { Pool } from 'pg';
import { withPlatformAccess, withTenant } from './tenancy.js';

export interface PostgresSupportSession {
  id: string;
  operator: string;
  operatorName?: string;
  tenant: string;
  reason: string;
  openedAt: string;
  expiresAt: string;
  endedAt?: string;
}

export interface PostgresAuditEntry {
  task: string;
  tenant: string;
  action: string;
  actor: string;
  onBehalfOf?: string;
  at: string;
  outcome: 'applied' | 'rejected';
  target: string;
  reason: string;
}

interface SessionRow {
  id: string;
  tenant: string;
  operator: string;
  operator_name: string | null;
  reason: string;
  opened_at: Date;
  expires_at: Date;
  ended_at: Date | null;
}

interface AuditRow {
  task: string;
  tenant: string;
  action: string;
  actor: string;
  on_behalf_of: string | null;
  at: Date;
  outcome: 'applied' | 'rejected';
  target: string;
  reason: string;
}

const toSession = (row: SessionRow): PostgresSupportSession => ({
  id: row.id,
  operator: row.operator,
  ...(row.operator_name ? { operatorName: row.operator_name } : {}),
  tenant: row.tenant,
  reason: row.reason,
  openedAt: row.opened_at.toISOString(),
  expiresAt: row.expires_at.toISOString(),
  ...(row.ended_at === null ? {} : { endedAt: row.ended_at.toISOString() }),
});

const toAudit = (row: AuditRow): PostgresAuditEntry => ({
  task: row.task,
  tenant: row.tenant,
  action: row.action,
  actor: row.actor,
  ...(row.on_behalf_of === null ? {} : { onBehalfOf: row.on_behalf_of }),
  at: row.at.toISOString(),
  outcome: row.outcome,
  target: row.target,
  reason: row.reason,
});

export class PostgresAdminRecords {
  readonly #sessions = new Map<string, PostgresSupportSession>();

  private constructor(private readonly pool: Pool) {}

  static async open(pool: Pool): Promise<PostgresAdminRecords> {
    const records = new PostgresAdminRecords(pool);
    await records.reload();
    return records;
  }

  async reload(): Promise<void> {
    const sessions = await withPlatformAccess(this.pool, 'support-sessions', (client) =>
      client.query<SessionRow>('select * from platform_support_sessions()'),
    );
    this.#sessions.clear();
    for (const row of sessions.rows) this.#sessions.set(row.id, toSession(row));
  }

  sessions(): PostgresSupportSession[] {
    return [...this.#sessions.values()].map((s) => structuredClone(s));
  }

  async saveSession(session: PostgresSupportSession): Promise<void> {
    await withTenant(this.pool, session.tenant, (client) =>
      client.query(
        `insert into support_sessions (id, tenant, operator, reason, opened_at, expires_at, ended_at, operator_name)
         values ($1, $2, $3, $4, $5, $6, $7, $8)
         on conflict (id) do update set ended_at = excluded.ended_at`,
        [
          session.id,
          session.tenant,
          session.operator,
          session.reason,
          session.openedAt,
          session.expiresAt,
          session.endedAt ?? null,
          session.operatorName ?? null,
        ],
      ),
    );
    this.#sessions.set(session.id, structuredClone(session));
  }

  async audit(tenant?: string): Promise<PostgresAuditEntry[]> {
    const rows =
      tenant === undefined
        ? await withPlatformAccess(this.pool, 'operator-audit', async (client) => {
            const found = await client.query<AuditRow>('select * from platform_admin_audit()');
            return found.rows;
          })
        : await withTenant(this.pool, tenant, async (client) => {
            const found = await client.query<AuditRow>(
              'select * from admin_audit where tenant = $1 order by seq',
              [tenant],
            );
            return found.rows;
          });
    return rows.map(toAudit);
  }

  async appendAudit(entry: PostgresAuditEntry): Promise<void> {
    await withTenant(this.pool, entry.tenant, (client) =>
      client.query(
        `insert into admin_audit (task, tenant, action, actor, on_behalf_of, at, outcome, target, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.task,
          entry.tenant,
          entry.action,
          entry.actor,
          entry.onBehalfOf ?? null,
          entry.at,
          entry.outcome,
          entry.target,
          entry.reason,
        ],
      ),
    );
  }
}
