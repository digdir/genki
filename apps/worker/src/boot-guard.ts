import {
  databaseRequirement,
  platformTenantProblems,
  unmetOutsideDevMode,
} from '@genai/composition';

export { isDevMode, knowledgeServerProblems } from '@genai/composition';

const markerTimeoutProblems = (env: Record<string, string | undefined>) => {
  if (env.MARKER_TIMEOUT_MS === undefined) return [];
  const ms = Number(env.MARKER_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? [] : ['MARKER_TIMEOUT_MS is a positive number'];
};

export const workerBootProblems = (env: Record<string, string | undefined>): string[] => [
  ...platformTenantProblems(env),
  ...unmetOutsideDevMode(env, [databaseRequirement(env)]),
  ...markerTimeoutProblems(env),
];

export const workerDevModeWarning =
  'GENAI_DEV_MODE=true: storage may be in memory. Never use this outside local development.';
