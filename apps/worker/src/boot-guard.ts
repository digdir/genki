import {
  databaseRequirement,
  platformTenantProblems,
  traceContentRequirement,
  unmetOutsideDevMode,
} from '@genai/composition';

export { isDevMode, knowledgeServerProblems } from '@genai/composition';

const markerTimeoutProblems = (env: Record<string, string | undefined>) => {
  if (env.MARKER_TIMEOUT_MS === undefined) return [];
  const ms = Number(env.MARKER_TIMEOUT_MS);
  return Number.isFinite(ms) && ms > 0 ? [] : ['MARKER_TIMEOUT_MS is a positive number'];
};

const vcoresProblems = (env: Record<string, string | undefined>) => {
  if (env.KNOWLEDGE_VCORES === undefined) return [];
  return /^[1-9]\d*$/.test(env.KNOWLEDGE_VCORES)
    ? []
    : ['KNOWLEDGE_VCORES is a positive whole number'];
};

export const workerBootProblems = (env: Record<string, string | undefined>): string[] => [
  ...platformTenantProblems(env),
  ...unmetOutsideDevMode(env, [databaseRequirement(env), traceContentRequirement(env)]),
  ...markerTimeoutProblems(env),
  ...vcoresProblems(env),
];

export const workerDevModeWarning =
  'GENAI_DEV_MODE=true: storage may be in memory. Never use this outside local development.';
