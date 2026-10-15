import {
  databaseRequirement,
  lockdownEntraProblems,
  platformTenantProblems,
  unmetOutsideDevMode,
} from '@genai/composition';

export { isDevMode, isProduction } from '@genai/composition';

type Env = Record<string, string | undefined>;

export const hasIdentityProvider = (env: Env) =>
  Boolean(env.ANSATTPORTEN_ISSUER) ||
  (Boolean(env.MASKINPORTEN_ISSUER) && Boolean(env.MASKINPORTEN_JWKS_URI));

export const bootProblems = (env: Env): string[] => [
  ...platformTenantProblems(env),
  ...lockdownEntraProblems(env),
  ...unmetOutsideDevMode(env, [
    {
      met: hasIdentityProvider(env),
      problem:
        'set ANSATTPORTEN_ISSUER, or MASKINPORTEN_ISSUER and MASKINPORTEN_JWKS_URI; the mock login runs only with GENAI_DEV_MODE=true',
    },
    databaseRequirement(env),
    {
      met: Boolean(env.ALTINN_PDP_URL),
      problem:
        'set ALTINN_PDP_URL and its Altinn PDP settings; the mock Altinn rights run only with GENAI_DEV_MODE=true',
    },
  ]),
];

export const devModeWarning =
  'GENAI_DEV_MODE=true: mock Ansattporten and Altinn may issue operator tokens and storage may be in memory. Never use this outside local development.';
