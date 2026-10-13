import type { Pool } from 'pg';
import { withTenant } from './tenancy.js';

type Scope = 'query' | 'ingest' | 'admin';

export interface PostgresApiKey {
  id: string;
  name: string;
  digest: string;
  tenant?: string;
  scopes: Scope[];
  datasets: string[];
  agents: string[];
  clientId?: string;
  service?: string;
  allowedOverrides?: string[];
  callsPerMinute?: number;
  skillGraphs?: string[];
  allowedConfigKeys?: string[];
  policy?: PostgresKeyPolicy;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
}

export interface PostgresKeyPolicy {
  id: string;
  scopes?: Scope[];
  datasets?: string[];
  agents?: string[];
  skillGraphs?: string[];
  allowedConfigKeys?: string[];
}

export interface NewKeyPolicy extends PostgresKeyPolicy {
  tenant: string;
  name: string;
}

export interface StoredKeyPolicy extends PostgresKeyPolicy {
  name: string;
  createdAt: string;
}

export interface NewApiKey extends PostgresApiKey {
  tenant: string;
  prefix?: string;
  lastFour?: string;
  createdAt?: string;
}

export interface RestoredApiKey extends NewApiKey {
  usageCount?: number;
}

interface KeyRow {
  id: string;
  name: string;
  digest: string;
  tenant: string;
  scopes: string[];
  dataset_grants: string[];
  agent_grants: string[];
  client_id: string | null;
  service: string | null;
  allowed_overrides: string[] | null;
  calls_per_minute: number | null;
  skill_graph_grants: string[];
  allowed_config_keys: string[];
  policy_id: string | null;
  last_used_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date | null;
}

interface PolicyRow {
  id: string;
  name?: string;
  created_at?: Date;
  scopes: string[];
  dataset_grants: string[];
  agent_grants: string[];
  skill_graph_grants: string[];
  allowed_config_keys: string[];
}

const toPolicy = (row: PolicyRow): PostgresKeyPolicy => ({
  id: row.id,
  scopes: row.scopes as Scope[],
  datasets: row.dataset_grants,
  agents: row.agent_grants,
  skillGraphs: row.skill_graph_grants,
  allowedConfigKeys: row.allowed_config_keys,
});

const toKey = (row: KeyRow): PostgresApiKey => ({
  id: row.id,
  name: row.name,
  digest: row.digest.trim(),
  tenant: row.tenant.trim(),
  scopes: row.scopes as Scope[],
  datasets: row.dataset_grants,
  agents: row.agent_grants,
  ...(row.client_id === null ? {} : { clientId: row.client_id }),
  ...(row.service === null ? {} : { service: row.service }),
  ...(row.allowed_overrides === null ? {} : { allowedOverrides: row.allowed_overrides }),
  ...(row.calls_per_minute === null ? {} : { callsPerMinute: row.calls_per_minute }),
  ...(row.skill_graph_grants.length ? { skillGraphs: row.skill_graph_grants } : {}),
  ...(row.allowed_config_keys.length ? { allowedConfigKeys: row.allowed_config_keys } : {}),
  ...(row.policy_id === null ? {} : { policy: { id: row.policy_id } }),
  ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at.toISOString() }),
  ...(row.revoked_at === null ? {} : { revokedAt: row.revoked_at.toISOString() }),
  ...(row.expires_at === null ? {} : { expiresAt: row.expires_at.toISOString() }),
});

export class PostgresApiKeys {
  constructor(private readonly pool: Pool) {}

  async findByDigest(digest: string): Promise<PostgresApiKey | undefined> {
    if (!/^[0-9a-f]{64}$/.test(digest)) return undefined;
    const found = await this.pool.query<KeyRow>('select * from find_legacy_api_key($1)', [digest]);
    const row = found.rows[0];
    if (!row) return undefined;
    const key = toKey(row);
    if (row.policy_id === null) return key;
    const policy = await this.pool.query<PolicyRow>('select * from find_api_key_policy($1)', [
      row.policy_id,
    ]);
    const policyRow = policy.rows[0];
    return policyRow ? { ...key, policy: toPolicy(policyRow) } : key;
  }

  async addPolicy(policy: NewKeyPolicy): Promise<void> {
    await withTenant(this.pool, policy.tenant, (client) =>
      client.query(
        `insert into api_key_policies (id, tenant, name, scopes, dataset_grants, agent_grants,
           skill_graph_grants, allowed_config_keys)
         values ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          policy.id,
          policy.tenant,
          policy.name,
          policy.scopes ?? [],
          policy.datasets ?? [],
          policy.agents ?? [],
          policy.skillGraphs ?? [],
          policy.allowedConfigKeys ?? [],
        ],
      ),
    );
  }

  async listPolicies(tenant: string): Promise<StoredKeyPolicy[]> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<Required<PolicyRow>>(
        'select * from api_key_policies order by created_at, id',
      );
      return found.rows.map((row) => ({
        ...toPolicy(row),
        name: row.name,
        createdAt: row.created_at.toISOString(),
      }));
    });
  }

  async updatePolicy(policy: NewKeyPolicy): Promise<boolean> {
    return withTenant(this.pool, policy.tenant, async (client) => {
      const result = await client.query(
        `update api_key_policies set name = $2, scopes = $3, dataset_grants = $4, agent_grants = $5,
           skill_graph_grants = $6, allowed_config_keys = $7 where id = $1`,
        [
          policy.id,
          policy.name,
          policy.scopes ?? [],
          policy.datasets ?? [],
          policy.agents ?? [],
          policy.skillGraphs ?? [],
          policy.allowedConfigKeys ?? [],
        ],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async deletePolicy(tenant: string, id: string): Promise<boolean> {
    return withTenant(this.pool, tenant, async (client) => {
      await client.query('update legacy_api_keys set policy_id = null where policy_id = $1', [id]);
      const result = await client.query('delete from api_key_policies where id = $1', [id]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async setKeyPolicy(tenant: string, keyId: string, policyId: string | null): Promise<boolean> {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query('update legacy_api_keys set policy_id = $2 where id = $1', [
        keyId,
        policyId,
      ]);
      return (result.rowCount ?? 0) > 0;
    });
  }

  async touch(id: string, at: Date): Promise<void> {
    await this.pool.query('select touch_legacy_api_key($1, $2)', [id, at]);
  }

  async add(key: NewApiKey): Promise<void> {
    await withTenant(this.pool, key.tenant, (client) =>
      client.query(
        `insert into legacy_api_keys (id, digest, prefix, last_four, name, tenant, legacy, scopes, dataset_grants,
           agent_grants, client_id, revoked_at, expires_at, created_at, service, allowed_overrides, calls_per_minute,
           skill_graph_grants, allowed_config_keys, policy_id)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
        [
          key.id,
          key.digest,
          key.prefix ?? null,
          key.lastFour ?? null,
          key.name,
          key.tenant,
          false,
          key.scopes,
          key.datasets,
          key.agents,
          key.clientId ?? null,
          key.revokedAt ?? null,
          key.expiresAt ?? null,
          key.createdAt ?? new Date().toISOString(),
          key.service ?? null,
          key.allowedOverrides ?? null,
          key.callsPerMinute ?? null,
          key.skillGraphs ?? [],
          key.allowedConfigKeys ?? [],
          key.policy?.id ?? null,
        ],
      ),
    );
  }

  async restore(key: RestoredApiKey, policy?: NewKeyPolicy): Promise<boolean> {
    return withTenant(this.pool, key.tenant, async (client) => {
      if (policy)
        await client.query(
          `insert into api_key_policies (id, tenant, name, scopes, dataset_grants, agent_grants,
             skill_graph_grants, allowed_config_keys)
           values ($1, $2, $3, $4, $5, $6, $7, $8)
           on conflict (id) do update set name = excluded.name, scopes = excluded.scopes,
             dataset_grants = excluded.dataset_grants, agent_grants = excluded.agent_grants,
             skill_graph_grants = excluded.skill_graph_grants,
             allowed_config_keys = excluded.allowed_config_keys
             where api_key_policies.tenant = excluded.tenant`,
          [
            policy.id,
            policy.tenant,
            policy.name,
            policy.scopes ?? [],
            policy.datasets ?? [],
            policy.agents ?? [],
            policy.skillGraphs ?? [],
            policy.allowedConfigKeys ?? [],
          ],
        );
      const result = await client.query(
        `insert into legacy_api_keys (id, digest, prefix, last_four, name, tenant, legacy, scopes, dataset_grants,
           agent_grants, client_id, revoked_at, expires_at, created_at, last_used_at, usage_count,
           skill_graph_grants, allowed_config_keys, policy_id, service)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
         on conflict (id) do update set digest = excluded.digest, prefix = excluded.prefix,
           last_four = excluded.last_four, name = excluded.name, legacy = excluded.legacy,
           scopes = excluded.scopes, dataset_grants = excluded.dataset_grants,
           agent_grants = excluded.agent_grants, client_id = excluded.client_id,
           revoked_at = excluded.revoked_at, expires_at = excluded.expires_at,
           created_at = excluded.created_at, last_used_at = excluded.last_used_at,
           usage_count = excluded.usage_count, skill_graph_grants = excluded.skill_graph_grants,
           allowed_config_keys = excluded.allowed_config_keys, policy_id = excluded.policy_id,
           service = excluded.service
           where legacy_api_keys.tenant = excluded.tenant`,
        [
          key.id,
          key.digest,
          key.prefix ?? null,
          key.lastFour ?? null,
          key.name,
          key.tenant,
          false,
          key.scopes,
          key.datasets,
          key.agents,
          key.clientId ?? null,
          key.revokedAt ?? null,
          key.expiresAt ?? null,
          key.createdAt ?? new Date().toISOString(),
          key.lastUsedAt ?? null,
          key.usageCount ?? 0,
          key.skillGraphs ?? [],
          key.allowedConfigKeys ?? [],
          key.policy?.id ?? null,
          key.service ?? null,
        ],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async list(tenant: string): Promise<PostgresApiKey[]> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<KeyRow>(
        'select * from legacy_api_keys order by created_at, id',
      );
      return found.rows.map(toKey);
    });
  }

  async revoke(tenant: string, id: string, at: Date = new Date()): Promise<boolean> {
    return withTenant(this.pool, tenant, async (client) => {
      const result = await client.query(
        'update legacy_api_keys set revoked_at = $2 where id = $1 and revoked_at is null',
        [id, at],
      );
      return (result.rowCount ?? 0) > 0;
    });
  }

  async usage(
    tenant: string,
    id: string,
  ): Promise<{ count: number; lastUsedAt?: string } | undefined> {
    return withTenant(this.pool, tenant, async (client) => {
      const found = await client.query<{ usage_count: string; last_used_at: Date | null }>(
        'select usage_count, last_used_at from legacy_api_keys where id = $1',
        [id],
      );
      const row = found.rows[0];
      return (
        row && {
          count: Number(row.usage_count),
          ...(row.last_used_at === null ? {} : { lastUsedAt: row.last_used_at.toISOString() }),
        }
      );
    });
  }
}
