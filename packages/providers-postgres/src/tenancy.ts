import type { Pool, PoolClient } from 'pg';

export const withTenant = async <T>(
  pool: Pool,
  tenant: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.tenant', $1, true)`, [tenant]);
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

export const withPlatformAccess = async <T>(
  pool: Pool,
  purpose: string,
  run: (client: PoolClient) => Promise<T>,
): Promise<T> => {
  if (!purpose.trim()) throw new Error('platform access needs a purpose');
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(`select set_config('app.platform_access', $1, true)`, [purpose]);
    const result = await run(client);
    await client.query('commit');
    return result;
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
};

export type TenantStatus = 'active' | 'onboarding' | 'paused';

export interface TenantRecord {
  orgNumber: string;
  name?: string;
  status: TenantStatus;
  createdBy: string;
  createdAt: string;
}

interface TenantRow {
  org_number: string;
  name: string | null;
  status: TenantStatus;
  created_by: string;
  created_at: Date;
}

const toTenant = (row: TenantRow): TenantRecord => ({
  orgNumber: row.org_number,
  ...(row.name === null ? {} : { name: row.name }),
  status: row.status,
  createdBy: row.created_by,
  createdAt: row.created_at.toISOString(),
});

export class PostgresTenants {
  constructor(private readonly pool: Pool) {}

  async ensure(
    orgNumber: string,
    input: { createdBy: string; name?: string; status?: TenantStatus },
  ): Promise<{ tenant: TenantRecord; created: boolean }> {
    if (!/^\d{9}$/.test(orgNumber)) throw new Error('an organisation number has nine digits');
    return withTenant(this.pool, orgNumber, async (client) => {
      const saved = await client.query<TenantRow & { created: boolean }>(
        `insert into tenants (org_number, name, created_by, status) values ($1, $2, $3, $4)
         on conflict (org_number) do update set name = coalesce(tenants.name, excluded.name)
         returning *, (xmax = 0) as created`,
        [orgNumber, input.name ?? null, input.createdBy, input.status ?? 'active'],
      );
      const row = saved.rows[0];
      if (!row) throw new Error(`tenant ${orgNumber} could not be created`);
      return { tenant: toTenant(row), created: row.created };
    });
  }

  async list(): Promise<TenantRecord[]> {
    const found = await withPlatformAccess(this.pool, 'tenant-directory', (client) =>
      client.query<TenantRow>('select * from platform_tenants()'),
    );
    return found.rows.map(toTenant);
  }

  async get(orgNumber: string): Promise<TenantRecord | undefined> {
    return withTenant(this.pool, orgNumber, (client) => this.#read(client, orgNumber));
  }

  async #read(client: PoolClient, orgNumber: string) {
    const found = await client.query<TenantRow>('select * from tenants where org_number = $1', [
      orgNumber,
    ]);
    const row = found.rows[0];
    return row && toTenant(row);
  }
}
