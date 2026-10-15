import type { Principal, PrincipalKind } from '@genai/contracts';
import { trustedEntraScope, type TrustedEntra } from '@genai/identity';

export const configuredCredentialScope = 'grant:configured-credential';

export { trustedEntraScope };

type Env = Record<string, string | undefined>;

const people = new Set<PrincipalKind>(['employee', 'operator', 'citizen']);

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const domain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export const isLockdown = (env: Env) => env.GENAI_LOCKDOWN === 'true';

export const isTrustedEntraLogin = (principal: Principal) =>
  principal.scopes?.includes(trustedEntraScope) ?? false;

export const mayUseModels = (principal: Principal | undefined) =>
  principal !== undefined &&
  (isTrustedEntraLogin(principal) ||
    (!people.has(principal.kind) &&
      (principal.scopes?.includes(configuredCredentialScope) ?? false)));

export const withModelAdmission = (system: Principal): Principal => ({
  ...system,
  scopes: [...new Set([...(system.scopes ?? []), configuredCredentialScope])],
});

export const readOnlyInLockdown = (principal: Principal) =>
  people.has(principal.kind) && !isTrustedEntraLogin(principal);

const entraGroups = (env: Env) =>
  (env.LOCKDOWN_ENTRA_GROUPS ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);

const entraDomain = (env: Env) => env.LOCKDOWN_ENTRA_EMAIL_DOMAIN?.trim().replace(/^@/, '') ?? '';

export const lockdownEntraProblems = (env: Env): string[] => {
  const notGuids = entraGroups(env).filter((g) => !guid.test(g));
  const emailDomain = entraDomain(env);
  return [
    ...(notGuids.length > 0
      ? [`LOCKDOWN_ENTRA_GROUPS must list Entra group object ids, got "${notGuids.join(', ')}"`]
      : []),
    ...(emailDomain && !domain.test(emailDomain)
      ? [`LOCKDOWN_ENTRA_EMAIL_DOMAIN must be a domain such as digdir.no, got "${emailDomain}"`]
      : []),
  ];
};

export const trustedEntraFrom = (
  env: Env,
  tenant: string,
  resource: string,
): TrustedEntra | undefined => {
  const groups = entraGroups(env);
  if (!isLockdown(env) || groups.length === 0) return undefined;
  const emailDomain = entraDomain(env);
  return { groups, tenant, resource, ...(emailDomain ? { emailDomain } : {}) };
};
