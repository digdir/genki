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

/** Search data belongs on its own server; without one it still runs in the platform database, with a warning. */
export const knowledgeDatabaseWarnings = (env: Env): string[] =>
  !isDevMode(env) && (env.DATABASE_URL || env.PGHOST) && !env.KNOWLEDGE_DATABASE_URL
    ? [
        'KNOWLEDGE_DATABASE_URL is not set, so search data shares the platform database; point it at the knowledge server',
      ]
    : [];

export const unmetOutsideDevMode = (env: Env, requirements: BootRequirement[]): string[] => {
  if (isDevMode(env))
    return isProduction(env) ? ['GENAI_DEV_MODE=true is not allowed in production; remove it'] : [];
  return requirements.filter((requirement) => !requirement.met).map(({ problem }) => problem);
};
