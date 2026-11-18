import type { ApiContext } from '../api';

export interface SettingOverride {
  service: string;
  name: string;
  value: unknown;
}

export const settingsApi = ({ get, tenantPath }: ApiContext) => ({
  overrides: async (tenant: string, key: string, signal?: AbortSignal) =>
    (
      await get<{ data?: SettingOverride[] }>(
        `${tenantPath(tenant)}/settings/${encodeURIComponent(key)}/overrides`,
        signal,
      )
    ).data ?? [],
});
