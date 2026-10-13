import type { ClientStore, StoredClient } from '@genai/identity';
import type { Pool } from 'pg';
import { withPlatformAccess, withTenant } from './tenancy.js';

interface ClientRow {
  definition: StoredClient['definition'];
  version: number;
  updated_at: Date;
  updated_by: string;
}

const toClient = (row: ClientRow): StoredClient => ({
  definition: row.definition,
  version: row.version,
  updatedAt: row.updated_at.toISOString(),
  updatedBy: row.updated_by,
});

export class PostgresClients implements ClientStore {
  constructor(private readonly pool: Pool) {}

  async list(tenant?: string): Promise<StoredClient[]> {
    if (tenant === undefined)
      return withPlatformAccess(this.pool, 'client-registry', async (client) =>
        (await client.query<ClientRow>('select * from platform_clients()')).rows.map(toClient),
      );
    return withTenant(this.pool, tenant, async (client) =>
      (
        await client.query<ClientRow>('select * from clients where tenant = $1 order by id', [
          tenant,
        ])
      ).rows.map(toClient),
    );
  }

  async get(tenant: string, id: string): Promise<StoredClient | undefined> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<ClientRow>(
        'select * from clients where tenant = $1 and id = $2',
        [tenant, id],
      );
      const row = found.rows[0];
      return row && toClient(row);
    });
  }

  async save(stored: StoredClient): Promise<void> {
    const { tenant, id } = stored.definition.metadata;
    await withTenant(this.pool, tenant, (client) =>
      client.query(
        `insert into clients (tenant, id, version, definition, updated_at, updated_by)
         values ($1, $2, $3, $4, $5, $6)
         on conflict (tenant, id) do update set version = excluded.version,
           definition = excluded.definition, updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
        [
          tenant,
          id,
          stored.version,
          JSON.stringify(stored.definition),
          stored.updatedAt,
          stored.updatedBy,
        ],
      ),
    );
  }

  async remove(tenant: string, id: string): Promise<boolean> {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query('delete from clients where tenant = $1 and id = $2', [
        tenant,
        id,
      ]);
      return (result.rowCount ?? 0) > 0;
    });
  }
}
