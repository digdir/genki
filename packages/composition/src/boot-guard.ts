import { knowledgeServerEndpoints } from './knowledge-context.js';

type Env = Record<string, string | undefined>;

export interface BootRequirement {
  met: boolean;
  problem: string;
}

export const isProduction = (env: Env) =>
  env.NODE_ENV === 'production' || env.GENAI_ENV === 'production';

export const isDevMode = (env: Env) => env.GENAI_DEV_MODE === 'true';

export const databaseRequirement = (env: Env): BootRequirement => ({
  met: Boolean(env.DATABASE_URL || env.PGHOST),
  problem:
    'set DATABASE_URL, or PGHOST for Entra ID login; in-memory storage runs only with GENAI_DEV_MODE=true',
});

export const unmetOutsideDevMode = (env: Env, requirements: BootRequirement[]): string[] => {
  if (isDevMode(env))
    return isProduction(env) ? ['GENAI_DEV_MODE=true is not allowed in production; remove it'] : [];
  return requirements.filter((requirement) => !requirement.met).map(({ problem }) => problem);
};

export const knowledgeServerProblems = (env: Env, catalog: unknown): string[] => {
  const endpoints = knowledgeServerEndpoints(catalog);
  return unmetOutsideDevMode(env, [
    {
      met: endpoints.length === 0 || Boolean(env.KNOWLEDGE_DATABASE_URL || env.KNOWLEDGE_PGHOST),
      problem: `set KNOWLEDGE_PGHOST, or KNOWLEDGE_DATABASE_URL locally, for the knowledge endpoints ${endpoints.join(', ')}; without a knowledge server they are left out only with GENAI_DEV_MODE=true`,
    },
  ]);
};
