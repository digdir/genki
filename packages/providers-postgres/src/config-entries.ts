import type { Pool } from 'pg';
import { withTenant } from './tenancy.js';

export interface PostgresConfigEntry {
  kind: string;
  scope: string;
  id: string;
  version: number;
  spec: unknown;
  deleted: boolean;
  by: string;
  at: string;
  reason: string;
}

const toEntry = (row: PostgresConfigEntry): PostgresConfigEntry => ({
  kind: row.kind,
  scope: row.scope,
  id: row.id,
  version: row.version,
  spec: row.spec,
  deleted: row.deleted,
  by: row.by,
  at: row.at,
  reason: row.reason,
});

export class PostgresConfigEntries {
  constructor(private readonly pool: Pool) {}

  async append(entry: PostgresConfigEntry): Promise<void> {
    const inserted = await withTenant(this.pool, entry.scope, (client) =>
      client.query(
        `insert into config_entries (kind, scope, id, version, spec, deleted, by, at, reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9) on conflict do nothing`,
        [
          entry.kind,
          entry.scope,
          entry.id,
          entry.version,
          JSON.stringify(entry.spec ?? null),
          entry.deleted,
          entry.by,
          entry.at,
          entry.reason,
        ],
      ),
    );
    if ((inserted.rowCount ?? 0) === 0)
      throw new Error(`${entry.kind} ${entry.id} v${entry.version} already exists`);
  }

  async history(kind: string, scope: string, id: string): Promise<PostgresConfigEntry[]> {
    const found = await this.pool.query<PostgresConfigEntry>(
      'select * from config_entries where kind = $1 and scope = $2 and id = $3 order by version',
      [kind, scope, id],
    );
    return found.rows.map(toEntry);
  }

  async latest(filter: { kind?: string; scope?: string } = {}): Promise<PostgresConfigEntry[]> {
    const found = await this.pool.query<PostgresConfigEntry>(
      `select distinct on (kind, scope, id) * from config_entries
       where ($1::text is null or kind = $1) and ($2::text is null or scope = $2)
       order by kind, scope, id, version desc`,
      [filter.kind ?? null, filter.scope ?? null],
    );
    return found.rows.map(toEntry);
  }
}
