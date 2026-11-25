import type { FlagKey, FlagState } from '@genai/contracts/flags';
import type { ApiContext } from '../api';

export const flagsApi = ({ get, request, tenantPath }: ApiContext) => {
  const flagPath = (tenant: string, key: FlagKey) =>
    `${tenantPath(tenant)}/flags/${encodeURIComponent(key)}`;
  return {
    mine: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data: FlagState[] }>(`${tenantPath(tenant)}/me/flags`, signal)).data,
    setMine: (tenant: string, key: FlagKey, on: boolean | null) =>
      request<FlagState>('PUT', `${tenantPath(tenant)}/me/flags/${encodeURIComponent(key)}`, {
        on,
      }),
    setTenant: (tenant: string, key: FlagKey, on: boolean | null, reason: string) =>
      request<FlagState>('PUT', flagPath(tenant, key), { on }, { 'change-reason': reason }),
  };
};
