import type { PostgresApiKeys } from '@genai/providers-postgres';
import type { KeyPolicyStore, TenantApiKey, TenantApiKeys } from './routes/portal-routes.js';

export const postgresTenantKeys = (keys: PostgresApiKeys): TenantApiKeys => ({
  list: async (tenant) => (await keys.list(tenant)) as TenantApiKey[],
  add: async (key) => {
    if (!key.tenant) throw new Error('an API key needs a tenant');
    await keys.add({ ...key, tenant: key.tenant } as Parameters<PostgresApiKeys['add']>[0]);
  },
  revoke: async (tenant, id, at) => {
    await keys.revoke(tenant, id, new Date(at));
    return ((await keys.list(tenant)) as TenantApiKey[]).find((k) => k.id === id);
  },
});

export const postgresKeyPolicies = (keys: PostgresApiKeys): KeyPolicyStore => ({
  listPolicies: (tenant) => keys.listPolicies(tenant),
  savePolicy: async (tenant, policy) => {
    const found = (await keys.listPolicies(tenant)).some((p) => p.id === policy.id);
    if (found) return keys.updatePolicy({ ...policy, tenant });
    await keys.addPolicy({ ...policy, tenant });
    return true;
  },
  deletePolicy: (tenant, id) => keys.deletePolicy(tenant, id),
  setKeyPolicy: (tenant, keyId, policyId) => keys.setKeyPolicy(tenant, keyId, policyId ?? null),
});
