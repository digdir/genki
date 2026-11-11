import type { Principal } from '@genai/contracts';
import { isApiKeyPrincipal, isTestRunnerKey, resourceId } from './claims.js';

export const PLATFORM_RESOURCE = 'urn:altinn:resource:digdir-genai-platform';

export const PLATFORM_RIGHTS = [
  'use-services',
  'manage-services',
  'manage-datasets',
  'register-building-blocks',
  'view-usage',
] as const;

export type PlatformRight = (typeof PLATFORM_RIGHTS)[number];

export const isPlatformRight = (action: string): action is PlatformRight =>
  (PLATFORM_RIGHTS as readonly string[]).includes(action);

export const LEGACY_ACTION_RIGHTS: Readonly<Record<string, readonly PlatformRight[]>> = {
  read: ['use-services', 'view-usage'],
  write: ['manage-services', 'manage-datasets', 'register-building-blocks', 'view-usage'],
};

export const platformRightsFromActions = (actions: readonly string[]): PlatformRight[] => {
  const granted = PLATFORM_RIGHTS.filter((right) => actions.includes(right));
  if (granted.length > 0) return granted;
  const legacy = new Set(actions.flatMap((action) => LEGACY_ACTION_RIGHTS[action] ?? []));
  return PLATFORM_RIGHTS.filter((right) => legacy.has(right));
};

export const KEY_SCOPE_RIGHTS: Readonly<Record<string, readonly PlatformRight[]>> = {
  admin: PLATFORM_RIGHTS,
  ingest: ['manage-datasets'],
};

const platformIssuers = new Set(['platform', 'urn:genai:worker']);

export const carriesAltinnActions = (principal: Principal) =>
  principal.authorizedFor?.some((entry) => entry.actions !== undefined) ?? false;

export const rightsOnlyFromGrants = (principal: Principal) =>
  principal.kind !== 'operator' &&
  principal.kind !== 'employee' &&
  !platformIssuers.has(principal.issuer);

const grantedRights = (principal: Principal, tenant: string): PlatformRight[] => {
  if (principal.tenant !== tenant || !isApiKeyPrincipal(principal)) return [];
  if (isTestRunnerKey(principal)) return [...PLATFORM_RIGHTS];
  const granted = new Set(
    (principal.scopes ?? []).flatMap((s) => {
      const scope = s.startsWith('legacy:') ? s.slice('legacy:'.length) : '';
      return Object.hasOwn(KEY_SCOPE_RIGHTS, scope) ? (KEY_SCOPE_RIGHTS[scope] ?? []) : [];
    }),
  );
  return PLATFORM_RIGHTS.filter((right) => granted.has(right));
};

/** Operators get every right; keys and clients only what they were granted. */
export const platformRightsOf = (
  principal: Principal,
  tenant: string,
  resource: string = PLATFORM_RESOURCE,
): PlatformRight[] => {
  if (principal.kind === 'operator') return [...PLATFORM_RIGHTS];
  const entries = (principal.authorizedFor ?? []).filter(
    (entry) =>
      entry.org === tenant &&
      (entry.resource === undefined || resourceId(entry.resource) === resourceId(resource)),
  );
  if (carriesAltinnActions(principal))
    return platformRightsFromActions(entries.flatMap((entry) => entry.actions ?? []));
  if (rightsOnlyFromGrants(principal)) return grantedRights(principal, tenant);
  return entries.length > 0 || principal.tenant === tenant ? [...PLATFORM_RIGHTS] : [];
};
