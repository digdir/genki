type Env = Record<string, string | undefined>;

export interface BootRequirement {
  met: boolean;
  problem: string;
}

export const isProduction = (env: Env) =>
  env.NODE_ENV === 'production' || env.GENAI_ENV === 'production';

export const isDevMode = (env: Env) => env.GENAI_DEV_MODE === 'true';

/** Answer text goes to the platform-wide exporter only in development mode (ADR 0040). */
export const tracesContent = (env: Env) => env.TRACES_CONTENT === 'true' && isDevMode(env);

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
