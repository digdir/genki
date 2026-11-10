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

  async set(tenant: string, name: string, value: string, hosts?: readonly string[]): Promise<void> {
    const key = await this.keys.get(tenant, SCOPE, true);
    if (!key) throw new Error('no content key');
    const sealed = seal(key, Buffer.from(value), aad(tenant, name));
    await withTenant(this.pool, tenant, (client) =>
      client.query(
        `insert into tenant_secrets (tenant, name, value, allowed_hosts) values ($1, $2, $3, $4)
         on conflict (tenant, name) do update set value = excluded.value,
           allowed_hosts = coalesce(excluded.allowed_hosts, tenant_secrets.allowed_hosts),
           updated_at = now()`,
        [tenant, name, sealed, hosts ? [...hosts] : null],
      ),
    );
  }

  async hosts(tenant: string, name: string): Promise<string[] | undefined> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ allowed_hosts: string[] | null }>(
        'select allowed_hosts from tenant_secrets where tenant = $1 and name = $2',
        [tenant, name],
      );
      return found.rows[0]?.allowed_hosts ?? undefined;
    });
  }

  async setHosts(tenant: string, name: string, hosts: readonly string[]): Promise<boolean> {
    return withTenant(this.pool, tenant, async (client) => {
      const updated = await client.query(
        `update tenant_secrets set allowed_hosts = $3, updated_at = now()
         where tenant = $1 and name = $2`,
        [tenant, name, [...hosts]],
      );
      return (updated.rowCount ?? 0) > 0;
    });
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
