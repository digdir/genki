import type { Principal, PrincipalKind } from '@genai/contracts';
import { lockdownUserScope, trustedEntraScope, type TrustedEntra } from '@genai/identity';

export const configuredCredentialScope = 'grant:configured-credential';

export { lockdownUserScope, trustedEntraScope };

type Env = Record<string, string | undefined>;

const people = new Set<PrincipalKind>(['employee', 'operator', 'citizen']);

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const domain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

export const isLockdown = (env: Env) => env.GENAI_LOCKDOWN === 'true';

export const isTrustedEntraLogin = (principal: Principal) =>
  principal.scopes?.includes(trustedEntraScope) ?? false;

export const isAdmittedEntraLogin = (principal: Principal) =>
  isTrustedEntraLogin(principal) ||
  (people.has(principal.kind) && (principal.scopes?.includes(lockdownUserScope) ?? false));

export const mayUseModels = (principal: Principal | undefined) =>
  principal !== undefined &&
  (isAdmittedEntraLogin(principal) ||
    (!people.has(principal.kind) &&
      (principal.scopes?.includes(configuredCredentialScope) ?? false)));

export const withModelAdmission = (system: Principal): Principal => ({
  ...system,
  scopes: [...new Set([...(system.scopes ?? []), configuredCredentialScope])],
});

export const readOnlyInLockdown = (principal: Principal) =>
  people.has(principal.kind) && !isAdmittedEntraLogin(principal);

const groupList = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);

const entraGroups = (env: Env) => groupList(env.LOCKDOWN_ENTRA_GROUPS);

const userGroups = (env: Env) => groupList(env.LOCKDOWN_USER_GROUPS);

export const operatorClientIds = (env: Env) =>
  (env.OPERATOR_CLIENT_IDS ?? '')
    .split(',')
    .map((c) => c.trim())
    .filter(Boolean);

const entraDomain = (env: Env) => env.LOCKDOWN_ENTRA_EMAIL_DOMAIN?.trim().replace(/^@/, '') ?? '';

export const lockdownEntraProblems = (env: Env): string[] => {
  const notGuids = entraGroups(env).filter((g) => !guid.test(g));
  const notUserGuids = userGroups(env).filter((g) => !guid.test(g));
  const emailDomain = entraDomain(env);
  return [
    ...(notGuids.length > 0
      ? [`LOCKDOWN_ENTRA_GROUPS must list Entra group object ids, got "${notGuids.join(', ')}"`]
      : []),
    ...(notUserGuids.length > 0
      ? [`LOCKDOWN_USER_GROUPS must list Entra group object ids, got "${notUserGuids.join(', ')}"`]
      : []),
    ...(emailDomain && !domain.test(emailDomain)
      ? [`LOCKDOWN_ENTRA_EMAIL_DOMAIN must be a domain such as digdir.no, got "${emailDomain}"`]
      : []),
    ...(isLockdown(env) && entraGroups(env).length > 0 && operatorClientIds(env).length === 0
      ? ['LOCKDOWN_ENTRA_GROUPS needs OPERATOR_CLIENT_IDS, the client ids whose Entra logins count']
      : []),
    ...(isLockdown(env) && userGroups(env).length > 0 && operatorClientIds(env).length === 0
      ? ['LOCKDOWN_USER_GROUPS needs OPERATOR_CLIENT_IDS, the client ids whose Entra logins count']
      : []),
  ];
};

export const trustedEntraFrom = (
  env: Env,
  tenant: string,
  resource: string,
): TrustedEntra | undefined => {
  const groups = entraGroups(env);
  const users = userGroups(env);
  if (!isLockdown(env) || groups.length + users.length === 0) return undefined;
  const emailDomain = entraDomain(env);
  return {
    groups,
    ...(users.length > 0 ? { userGroups: users } : {}),
    clientIds: operatorClientIds(env),
    tenant,
    resource,
    ...(emailDomain ? { emailDomain } : {}),
  };
};
