import type { Locale } from '@genai/i18n';
import type { ApiContext } from '../api';

export interface UserPreferences {
  writtenStandard: 'user' | 'bokmal' | 'nynorsk' | null;
  language: Locale | null;
}

export const preferencesApi = ({ get, request, tenantPath }: ApiContext) => {
  const path = (tenant: string) => `${tenantPath(tenant)}/me/preferences`;
  return {
    get: (tenant: string, signal?: AbortSignal) => get<UserPreferences>(path(tenant), signal),
    save: (tenant: string, change: Partial<UserPreferences>, reason: string) =>
      request<UserPreferences>('PUT', path(tenant), change, { 'change-reason': reason }),
  };
};
