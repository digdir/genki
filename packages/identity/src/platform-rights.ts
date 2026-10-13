import type { Principal } from '@genai/contracts';
import { resourceId } from './claims.js';

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

/** Operators get every right; principals without Altinn actions keep today's tenant-wide access. */
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
  const fromAltinn = principal.authorizedFor?.some((entry) => entry.actions !== undefined);
  if (fromAltinn) return platformRightsFromActions(entries.flatMap((entry) => entry.actions ?? []));
  return entries.length > 0 || principal.tenant === tenant ? [...PLATFORM_RIGHTS] : [];
};
