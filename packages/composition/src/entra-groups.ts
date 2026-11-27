import type { TrustedEntra } from '@genai/identity';

type Env = Record<string, string | undefined>;

const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const domain = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/i;

const listOf = (value: string | undefined) =>
  (value ?? '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);

export const operatorEntraGroups = (env: Env) => listOf(env.OPERATOR_ENTRA_GROUPS);

export const memberEntraGroups = (env: Env) => listOf(env.MEMBER_ENTRA_GROUPS);

const serviceEntraGroups = (env: Env) => listOf(env.SERVICE_ENTRA_GROUPS);

const serviceEntraClientIds = (env: Env) => listOf(env.SERVICE_ENTRA_CLIENT_IDS);

const entraEmailDomain = (env: Env) => env.ENTRA_EMAIL_DOMAIN?.trim().replace(/^@/, '') ?? '';

export const operatorClientIds = (env: Env) => listOf(env.OPERATOR_CLIENT_IDS);

export const employeeClientIds = (env: Env) => listOf(env.EMPLOYEE_CLIENT_IDS);

/** The portal and console sign in through the platform login client (ADR 0061). */
export const platformAppsSignIn = (env: Env) =>
  Boolean(env.PLATFORM_LOGIN_CLIENT_ID?.trim() && env.PLATFORM_APP_ORIGINS?.trim());

/** True when operator or member groups give people their rights in the platform organisation (ADR 0033). */
export const rightsFromEntraGroups = (env: Env) =>
  operatorEntraGroups(env).length + memberEntraGroups(env).length > 0;

const renamed = {
  LOCKDOWN_ENTRA_GROUPS: 'OPERATOR_ENTRA_GROUPS',
  LOCKDOWN_USER_GROUPS: 'MEMBER_ENTRA_GROUPS',
  LOCKDOWN_SERVICE_GROUPS: 'SERVICE_ENTRA_GROUPS',
  LOCKDOWN_SERVICE_CLIENT_IDS: 'SERVICE_ENTRA_CLIENT_IDS',
  LOCKDOWN_ENTRA_EMAIL_DOMAIN: 'ENTRA_EMAIL_DOMAIN',
} as const;

const notGroupIds = (name: string, groups: string[]) => {
  const wrong = groups.filter((g) => !guid.test(g));
  return wrong.length > 0
    ? [`${name} must list Entra group object ids, got "${wrong.join(', ')}"`]
    : [];
};

export const entraGroupProblems = (env: Env): string[] => {
  const platformClients = new Set([...operatorClientIds(env), ...employeeClientIds(env)]);
  const platformClientsAsService = serviceEntraClientIds(env).filter((id) =>
    platformClients.has(id),
  );
  const emailDomain = entraEmailDomain(env);
  return [
    ...Object.entries(renamed).flatMap(([old, current]) =>
      env[old]?.trim() ? [`${old} is now ${current}; rename it`] : [],
    ),
    ...notGroupIds('OPERATOR_ENTRA_GROUPS', operatorEntraGroups(env)),
    ...notGroupIds('MEMBER_ENTRA_GROUPS', memberEntraGroups(env)),
    ...notGroupIds('SERVICE_ENTRA_GROUPS', serviceEntraGroups(env)),
    ...(emailDomain && !domain.test(emailDomain)
      ? [`ENTRA_EMAIL_DOMAIN must be a domain such as digdir.no, got "${emailDomain}"`]
      : []),
    ...(rightsFromEntraGroups(env) &&
    operatorClientIds(env).length === 0 &&
    !platformAppsSignIn(env)
      ? [
          'OPERATOR_ENTRA_GROUPS and MEMBER_ENTRA_GROUPS need PLATFORM_LOGIN_CLIENT_ID and PLATFORM_APP_ORIGINS, or OPERATOR_CLIENT_IDS, the clients whose Entra logins count',
        ]
      : []),
    ...(platformClientsAsService.length > 0
      ? [
          `SERVICE_ENTRA_CLIENT_IDS must name registered service clients, not platform clients, got "${platformClientsAsService.join(', ')}"`,
        ]
      : []),
  ];
};

export const trustedEntraFrom = (
  env: Env,
  tenant: string,
  resource: string,
): TrustedEntra | undefined => {
  const groups = operatorEntraGroups(env);
  const members = memberEntraGroups(env);
  const services = serviceEntraGroups(env);
  if (groups.length + members.length + services.length === 0) return undefined;
  const emailDomain = entraEmailDomain(env);
  return {
    groups,
    ...(members.length > 0 ? { userGroups: members } : {}),
    ...(services.length > 0
      ? { serviceGroups: services, serviceClientIds: serviceEntraClientIds(env) }
      : {}),
    clientIds: operatorClientIds(env),
    tenant,
    resource,
    ...(emailDomain ? { emailDomain } : {}),
  };
};
