type Env = Record<string, string | undefined>;

export const defaultPlatformTenant = '991825827';

const configured = (env: Env) => env.PLATFORM_TENANT?.trim() ?? '';

export const platformTenantFrom = (env: Env) => configured(env) || defaultPlatformTenant;

export const platformTenantProblems = (env: Env): string[] => {
  const value = configured(env);
  return value && !/^\d{9}$/.test(value)
    ? [`PLATFORM_TENANT must be a nine-digit organisation number, got "${value}"`]
    : [];
};

export const ownedByPlatformTenant = <T extends { metadata?: { tenant?: unknown } }>(
  definition: T,
  platformTenant: string,
): T =>
  definition.metadata?.tenant === defaultPlatformTenant && platformTenant !== defaultPlatformTenant
    ? { ...definition, metadata: { ...definition.metadata, tenant: platformTenant } }
    : definition;
