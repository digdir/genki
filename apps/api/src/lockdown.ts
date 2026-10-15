import { configuredCredentialScope, isLockdown, mayUseModels } from '@genai/composition';
import type { Principal } from '@genai/contracts';
import { apiKeyDigest } from '@genai/identity';
import type { MiddlewareHandler } from 'hono';
import { reasonFreeWrites, routeOf } from './change-reason.js';
import { t } from './i18n/index.js';

export const lockedEnvironmentType = 'urn:genai:problem:locked-environment';

export { configuredCredentialScope, isLockdown, mayUseModels };

export interface Lockdown {
  configuredKeys: ReadonlySet<string>;
}

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

export const ingestionRoutes = new Set([
  'POST /tenants/:tenant/datasets/:dataset/pipelines/:id/execute',
  'POST /operator/datasets/:dataset/pipelines/:id/execute',
  'POST /tenants/:tenant/connectors/:id/sync',
  'POST /tenants/:tenant/datasets/:id/engine-switches',
  'POST /tenants/:tenant/datasets/:id/engine-switches/:sid/retry',
  'POST /operator/datasets/:id/engine-switches',
  'POST /operator/datasets/:id/engine-switches/:sid/retry',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/apply',
]);

const lockedProblem = (route: string) =>
  modelRunRoutes.has(route)
    ? { title: t('problems.modelsLocked'), detail: t('problems.modelsLockedDetail') }
    : ingestionRoutes.has(route)
      ? { title: t('problems.ingestionLocked'), detail: t('problems.ingestionLockedDetail') }
      : undefined;

export const refuseLockedRoutes =
  (caller: (request: Request) => Promise<Principal | undefined>): MiddlewareHandler =>
  async (c, next) => {
    const route = routeOf(c);
    const locked = route ? lockedProblem(route) : undefined;
    if (!locked) return next();
    const principal = await caller(c.req.raw);
    if (!principal || mayUseModels(principal)) return next();
    return c.json({ type: lockedEnvironmentType, status: 403, ...locked }, 403, {
      'content-type': 'application/problem+json',
    });
  };
