import {
  SettingsConflictError,
  type DefaultVersion,
  type SettingsSnapshot,
  type SettingsStore,
  type TenantSettings,
} from '@genai/definitions';
import type { Pool } from 'pg';
import { open, seal } from './crypto.js';
import type { ContentKeys } from './keys.js';
import { withPlatformAccess, withTenant } from './tenancy.js';

const PLATFORM = 'platform';
const SCOPE = 'settings';

export class PostgresSettingsStore implements SettingsStore {
  constructor(
    private readonly pool: Pool,
    private readonly keys: ContentKeys,
  ) {}

  async load(): Promise<SettingsSnapshot> {
    const defaults = await this.pool.query<{
      key: string;
      version: number;
      value: Buffer;
      changed_at: Date;
      changed_by: string;
      reason: string;
    }>('select * from setting_default_versions order by key, version');
    const locks = await this.pool.query<{ key: string; reason: string }>(
      'select key, reason from setting_locks',
    );
    const tenants = await withPlatformAccess(this.pool, 'settings-snapshot', (client) =>
      client.query<{ tenant: string; body: Buffer; version: string }>(
        'select tenant, body, version from platform_tenant_settings()',
      ),
    );
    const platformKey = await this.keys.get(PLATFORM, SCOPE, false);
    return {
      defaults: defaults.rows.flatMap((row) => {
        if (!platformKey) return [];
        return [
          {
            key: row.key,
            version: row.version,
            value: JSON.parse(
              open(platformKey, row.value, `default:${row.key}@${row.version}`).toString(),
            ) as unknown,
            changedAt: row.changed_at.toISOString(),
            changedBy: row.changed_by,
            reason: row.reason,
          },
        ];
      }),
      tenants: Object.fromEntries(
        await Promise.all(
          tenants.rows.map(async (row) => {
            const key = await this.keys.get(row.tenant, SCOPE, false);
            const settings: TenantSettings = key
              ? (JSON.parse(
                  open(key, row.body, `tenant-settings:${row.tenant}`).toString(),
                ) as TenantSettings)
              : { values: {}, pins: {} };
            return [row.tenant, settings] as const;
          }),
        ),
      ),
      tenantVersions: Object.fromEntries(tenants.rows.map((r) => [r.tenant, Number(r.version)])),
      locks: Object.fromEntries(locks.rows.map((r) => [r.key, { reason: r.reason }])),
    };
  }

  async appendDefault(version: DefaultVersion): Promise<void> {
    const key = await this.keys.get(PLATFORM, SCOPE, true);
    if (!key) throw new Error('no content key');
    await this.pool.query(
      `insert into setting_default_versions (key, version, value, changed_at, changed_by, reason)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        version.key,
        version.version,
        seal(
          key,
          Buffer.from(JSON.stringify(version.value ?? null)),
          `default:${version.key}@${version.version}`,
        ),
        version.changedAt ?? new Date().toISOString(),
        version.changedBy ?? 'platform',
        version.reason ?? '',
      ],
    );
  }

  async saveTenant(
    tenant: string,
    settings: TenantSettings,
    expectedVersion: number,
  ): Promise<number> {
    const key = await this.keys.get(tenant, SCOPE, true);
    if (!key) throw new Error('no content key');
    const body = seal(key, Buffer.from(JSON.stringify(settings)), `tenant-settings:${tenant}`);
    const saved = await withTenant(this.pool, tenant, (client) =>
      client.query<{ version: string }>(
        expectedVersion === 0
          ? `insert into tenant_settings (tenant, body, version) values ($1, $2, 1)
             on conflict (tenant) do update set body = excluded.body, version = 1, updated_at = now()
             where tenant_settings.version = 0
             returning version`
          : `update tenant_settings set body = $2, version = version + 1, updated_at = now()
             where tenant = $1 and version = $3
             returning version`,
        expectedVersion === 0 ? [tenant, body] : [tenant, body, expectedVersion],
      ),
    );
    const row = saved.rows[0];
    if (!row) throw new SettingsConflictError(tenant);
    return Number(row.version);
  }

  async saveLock(key: string, lock: { reason: string } | undefined): Promise<void> {
    if (lock)
      await this.pool.query(
        `insert into setting_locks (key, reason) values ($1, $2)
         on conflict (key) do update set reason = excluded.reason, updated_at = now()`,
        [key, lock.reason],
      );
    else await this.pool.query('delete from setting_locks where key = $1', [key]);
  }
}
