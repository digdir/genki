import type { Pool } from 'pg';
import { open, seal } from './crypto.js';
import type { ContentKeys } from './keys.js';
import { withTenant } from './tenancy.js';

const SCOPE = 'tenant-secrets';
const aad = (tenant: string, name: string) => `secret:${tenant}/${name}`;

export class PostgresTenantSecrets {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async set(tenant: string, name: string, value: string): Promise<void> {
    const key = await this.keys.get(tenant, SCOPE, true);
    if (!key) throw new Error('no content key');
    const sealed = seal(key, Buffer.from(value), aad(tenant, name));
    await withTenant(this.pool, tenant, (client) =>
      client.query(
        `insert into tenant_secrets (tenant, name, value) values ($1, $2, $3)
         on conflict (tenant, name) do update set value = excluded.value, updated_at = now()`,
        [tenant, name, sealed],
      ),
    );
  }

  async get(tenant: string, name: string): Promise<string | undefined> {
    const row = await withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ value: Buffer }>(
        'select value from tenant_secrets where tenant = $1 and name = $2',
        [tenant, name],
      );
      return found.rows[0];
    });
    const key = row && (await this.keys.get(tenant, SCOPE, false));
    if (!row || !key) return undefined;
    try {
      return open(key, row.value, aad(tenant, name)).toString();
    } catch {
      return undefined;
    }
  }

  async delete(tenant: string, name: string): Promise<void> {
    await withTenant(this.pool, tenant, (client) =>
      client.query('delete from tenant_secrets where tenant = $1 and name = $2', [tenant, name]),
    );
  }

  async list(tenant: string): Promise<string[]> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ name: string }>(
        'select name from tenant_secrets where tenant = $1 order by name',
        [tenant],
      );
      return found.rows.map((r) => r.name);
    });
  }
}
