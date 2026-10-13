import type { Principal } from '@genai/contracts';
import type { WrittenStandard } from '@genai/guardrails';
import type { Locale } from '@genai/i18n';
import type { ConfigEntry, ConfigEntryStore } from './config-store.js';

export const userPreferenceKind = 'user-preferences';

export interface UserPreferences {
  writtenStandard?: WrittenStandard;
  language?: Locale;
}

export const preferenceOwner = (principal: Principal) =>
  JSON.stringify([principal.issuer, principal.subject]);

export const userPreferenceReader = (store: ConfigEntryStore) => {
  const latest = async (tenant: string, principal: Principal) =>
    (await store.history(userPreferenceKind, tenant, preferenceOwner(principal))).at(-1) as
      ConfigEntry<UserPreferences> | undefined;
  return {
    latest,
    writtenStandard: async (tenant: string, principal: Principal) =>
      (await latest(tenant, principal))?.spec.writtenStandard,
    of: async (tenant: string, principal: Principal): Promise<UserPreferences> =>
      (await latest(tenant, principal))?.spec ?? {},
  };
};
