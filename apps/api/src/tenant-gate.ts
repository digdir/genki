import type { Principal } from '@genai/contracts';
import {
  grantsOf,
  isApiKeyPrincipal,
  isTestRunnerKey,
  keyReaches,
  platformRightsOf,
  rightsOnlyFromGrants,
} from '@genai/identity';
import type { Context, MiddlewareHandler } from 'hono';
import { t } from './i18n/index.js';

export const tenantNotRegisteredType = 'urn:genai:problem:tenant-not-registered';
export const keyScopeType = 'urn:genai:problem:api-key-scope';
export const clientScopeType = 'urn:genai:problem:client-scope';

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

export const keyReachesDataset = (principal: Principal, datasets: string[]) => {
  const grants = grantsOf(principal);
  if (!grants || grants.scopes.includes('admin')) return true;
  return keyReaches(principal, 'ingest', { datasets });
};

export const tenantNotRegistered = (c: Context, tenant: string) =>
  refuse(
    c,
    tenantNotRegisteredType,
    t('problems.tenantNotRegistered'),
    t('problems.tenantNotRegisteredDetail', { tenant }),
  );

const holdsNoRight = (principal: Principal, tenant: string) =>
  rightsOnlyFromGrants(principal) && platformRightsOf(principal, tenant).length === 0;

const clientScope = (c: Context) =>
  refuse(c, clientScopeType, t('problems.clientScope'), t('problems.clientScopeDetail'));

export const adminKeysOnly =
  (caller: (request: Request) => Promise<Principal | undefined>): MiddlewareHandler =>
  async (c, next) => {
    const principal = await caller(c.req.raw);
    if (principal && isApiKeyPrincipal(principal) && !keyReachesRoute(principal, c))
      return refuse(c, keyScopeType, t('problems.keyScope'), t('problems.keyScopeDetail'));
    if (principal && holdsNoRight(principal, principal.tenant ?? '')) return clientScope(c);
    return next();
  };

export const tenantGate =
  (deps: TenantGateDeps): MiddlewareHandler =>
  async (c, next) => {
    const tenant = c.req.param('tenant');
    const principal = tenant ? await deps.caller(c.req.raw) : undefined;
    if (!tenant || !principal || principal.kind === 'operator') return next();
    if (isTestRunnerKey(principal) && principal.tenant !== tenant)
      return c.json({ type: 'about:blank', title: t('problems.notFound'), status: 404 }, 404, {
        'content-type': 'application/problem+json',
      });
    if (
      isApiKeyPrincipal(principal) &&
      !isTestRunnerKey(principal) &&
      !keyReachesRoute(principal, c)
    )
      return refuse(c, keyScopeType, t('problems.keyScope'), t('problems.keyScopeDetail'));
    const member =
      principal.tenant === tenant || principal.authorizedFor?.some((a) => a.org === tenant);
    if (member && holdsNoRight(principal, tenant)) return clientScope(c);
    if (member && !(await deps.registered(tenant))) return tenantNotRegistered(c, tenant);
    return next();
  };
