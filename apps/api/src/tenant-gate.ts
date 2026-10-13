import type { Principal } from '@genai/contracts';
import { isApiKeyPrincipal } from '@genai/identity';
import type { Context, MiddlewareHandler } from 'hono';
import { t } from './i18n/index.js';

export const tenantNotRegisteredType = 'urn:genai:problem:tenant-not-registered';
export const keyScopeType = 'urn:genai:problem:api-key-scope';

export interface TenantGateDeps {
  caller(request: Request): Promise<Principal | undefined>;
  registered(tenant: string): Promise<boolean>;
}

const ingestRoute = /\/datasets\/[^/]+\/pipelines\/[^/]+\/(execute|executions)$/;

const keyReachesRoute = (principal: Principal, c: Context) => {
  const scopes = principal.scopes ?? [];
  if (scopes.includes('legacy:admin')) return true;
  return scopes.includes('legacy:ingest') && ingestRoute.test(c.req.path);
};

const refuse = (c: Context, type: string, title: string, detail: string) =>
  c.json({ type, title, status: 403, detail }, 403, {
    'content-type': 'application/problem+json',
  });

export const tenantGate =
  (deps: TenantGateDeps): MiddlewareHandler =>
  async (c, next) => {
    const tenant = c.req.param('tenant');
    const principal = tenant ? await deps.caller(c.req.raw) : undefined;
    if (!tenant || !principal || principal.kind === 'operator') return next();
    if (isApiKeyPrincipal(principal) && !keyReachesRoute(principal, c))
      return refuse(c, keyScopeType, t('problems.keyScope'), t('problems.keyScopeDetail'));
    const member =
      principal.tenant === tenant || principal.authorizedFor?.some((a) => a.org === tenant);
    if (member && !(await deps.registered(tenant)))
      return refuse(
        c,
        tenantNotRegisteredType,
        t('problems.tenantNotRegistered'),
        t('problems.tenantNotRegisteredDetail', { tenant }),
      );
    return next();
  };
