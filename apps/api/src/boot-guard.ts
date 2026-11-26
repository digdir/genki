import {
  databaseRequirement,
  employeeClientIds,
  platformAppsSignIn,
  flagEnvProblems,
  flagEnvRequirement,
  entraGroupProblems,
  rightsFromEntraGroups,
  platformTenantProblems,
  traceContentRequirement,
  unmetOutsideDevMode,
} from '@genai/composition';
import { altinnEnvironmentProblems } from './altinn-environment.js';
import { operatorSubjectProblems } from './operators.js';

export {
  isDevMode,
  isProduction,
  knowledgeServerProblems,
  tracesContent,
} from '@genai/composition';

type Env = Record<string, string | undefined>;

export const hasIdentityProvider = (env: Env) =>
  Boolean(env.ANSATTPORTEN_ISSUER) ||
  (Boolean(env.MASKINPORTEN_ISSUER) && Boolean(env.MASKINPORTEN_JWKS_URI));

export const bootProblems = (env: Env): string[] => [
  ...platformTenantProblems(env),
  ...entraGroupProblems(env),
  ...operatorSubjectProblems(env),
  ...flagEnvProblems(env),
  ...altinnEnvironmentProblems(env),
  ...unmetOutsideDevMode(env, [
    {
      met: hasIdentityProvider(env),
      problem:
        'set ANSATTPORTEN_ISSUER, or MASKINPORTEN_ISSUER and MASKINPORTEN_JWKS_URI; the mock login runs only with GENAI_DEV_MODE=true',
    },
    {
      met: !env.ANSATTPORTEN_ISSUER || employeeClientIds(env).length > 0 || platformAppsSignIn(env),
      problem:
        'set PLATFORM_LOGIN_CLIENT_ID and PLATFORM_APP_ORIGINS so the portal, workspace and console sign in through the platform login, or EMPLOYEE_CLIENT_IDS',
    },
    databaseRequirement(env),
    {
      met: Boolean(env.ALTINN_PDP_URL) || rightsFromEntraGroups(env),
      problem:
        'set MEMBER_ENTRA_GROUPS or OPERATOR_ENTRA_GROUPS, or ALTINN_PDP_URL and its Altinn PDP settings; the mock Altinn rights run only with GENAI_DEV_MODE=true',
    },
    traceContentRequirement(env),
    flagEnvRequirement(env),
    {
      met: env.GENAI_MOCK_RIGHTS !== 'true',
      problem: 'GENAI_MOCK_RIGHTS=true runs only with GENAI_DEV_MODE=true; remove it',
    },
  ]),
];

export const devModeWarning =
  'GENAI_DEV_MODE=true: mock Ansattporten and Altinn may issue operator tokens and storage may be in memory. Never use this outside local development.';
