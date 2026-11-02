import {
  databaseRequirement,
  platformTenantProblems,
  unmetOutsideDevMode,
} from '@genai/composition';

export { isDevMode, knowledgeServerProblems } from '@genai/composition';

export const workerBootProblems = (env: Record<string, string | undefined>): string[] => [
  ...platformTenantProblems(env),
  ...unmetOutsideDevMode(env, [databaseRequirement(env)]),
];

export const workerDevModeWarning =
  'GENAI_DEV_MODE=true: storage may be in memory. Never use this outside local development.';
