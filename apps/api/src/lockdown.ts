import type { Principal, PrincipalKind } from '@genai/contracts';
import { apiKeyDigest } from '@genai/identity';
import type { MiddlewareHandler } from 'hono';
import { reasonFreeWrites, routeOf } from './change-reason.js';
import { t } from './i18n/index.js';

export const lockedEnvironmentType = 'urn:genai:problem:locked-environment';

export const configuredCredentialScope = 'grant:configured-credential';

const people = new Set<PrincipalKind>(['employee', 'operator', 'citizen']);

export const isLockdown = (env: Record<string, string | undefined>) =>
  env.GENAI_LOCKDOWN === 'true';

export interface Lockdown {
  configuredKeys: ReadonlySet<string>;
}

export const mayUseModels = (principal: Principal | undefined) =>
  principal !== undefined &&
  !people.has(principal.kind) &&
  (principal.scopes?.includes(configuredCredentialScope) ?? false);

const presentedKey = (request: Request) => {
  const header = request.headers.get('x-api-key');
  if (header) return header;
  const bearer = request.headers.get('authorization');
  return bearer?.toLowerCase().startsWith('bearer ') ? bearer.slice(7).trim() : undefined;
};

export const withCredentialOrigin = (
  lockdown: Lockdown,
  request: Request,
  principal: Principal,
): Principal => {
  const scopes = (principal.scopes ?? []).filter((s) => s !== configuredCredentialScope);
  const key = presentedKey(request);
  const configured = key !== undefined && lockdown.configuredKeys.has(apiKeyDigest(key));
  return {
    ...principal,
    scopes: configured ? [...scopes, configuredCredentialScope] : scopes,
  };
};

export const modelRunRoutes = new Set([
  ...Object.entries(reasonFreeWrites)
    .filter(([, kind]) => kind === 'run')
    .map(([route]) => route),
  'POST /operator/quality/matrix/runs',
  'POST /tenants/:tenant/projects/:project/runs',
  'POST /tenants/:tenant/projects/:project/runs/:run/retry',
  'POST /tenants/:tenant/services/:id/batch-runs',
  'POST /tenants/:tenant/services/:id/batch-runs/:runId/retry',
  'POST /tenants/:tenant/skills/:id/fix',
]);

export const refuseModelUse =
  (caller: (request: Request) => Promise<Principal | undefined>): MiddlewareHandler =>
  async (c, next) => {
    const route = routeOf(c);
    if (!route || !modelRunRoutes.has(route)) return next();
    const principal = await caller(c.req.raw);
    if (!principal || mayUseModels(principal)) return next();
    return c.json(
      {
        type: lockedEnvironmentType,
        title: t('problems.modelsLocked'),
        status: 403,
        detail: t('problems.modelsLockedDetail'),
      },
      403,
      { 'content-type': 'application/problem+json' },
    );
  };
