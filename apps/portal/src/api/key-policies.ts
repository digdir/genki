import type { ApiContext } from '../api';

export interface KeyPolicy {
  id: string;
  name: string;
  scopes: string[];
  datasets: string[];
  agents: string[];
  modes: string[];
  allowedConfigKeys: string[];
  keyIds: string[];
  createdAt: string;
}

export type NewKeyPolicy = Omit<KeyPolicy, 'id' | 'keyIds' | 'createdAt'>;

export const keyPoliciesApi = ({ get, request, tenantPath }: ApiContext) => {
  const policies = (tenant: string) => `${tenantPath(tenant)}/api-key-policies`;
  const why = (reason: string) => ({ 'change-reason': reason });
  return {
    list: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data?: KeyPolicy[] }>(policies(tenant), signal)).data ?? [],
    create: (tenant: string, policy: NewKeyPolicy, reason: string) =>
      request<KeyPolicy>('POST', policies(tenant), policy, why(reason)),
    update: (tenant: string, id: string, policy: NewKeyPolicy, reason: string) =>
      request<KeyPolicy>(
        'PUT',
        `${policies(tenant)}/${encodeURIComponent(id)}`,
        policy,
        why(reason),
      ),
    remove: (tenant: string, id: string, reason: string) =>
      request<unknown>('DELETE', `${policies(tenant)}/${encodeURIComponent(id)}`, {}, why(reason)),
    attach: (tenant: string, keyId: string, policyId: string | undefined, reason: string) => {
      const path = `${tenantPath(tenant)}/api-keys/${encodeURIComponent(keyId)}/policy`;
      return policyId === undefined
        ? request<unknown>('DELETE', path, {}, why(reason))
        : request<unknown>('PUT', path, { policyId }, why(reason));
    },
  };
};
