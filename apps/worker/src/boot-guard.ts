import { databaseRequirement, unmetOutsideDevMode } from '@genai/composition';

export { isDevMode } from '@genai/composition';

export const workerBootProblems = (env: Record<string, string | undefined>): string[] =>
  unmetOutsideDevMode(env, [databaseRequirement(env)]);

export const workerDevModeWarning =
  'GENAI_DEV_MODE=true: storage may be in memory. Never use this outside local development.';
