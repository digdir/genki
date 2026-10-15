import {
  configuredCredentialScope,
  isLockdown,
  mayUseModels,
  readOnlyInLockdown,
  trustedEntraFrom,
  trustedEntraScope,
} from '@genai/composition';
import type { Principal } from '@genai/contracts';
import { admittedCredentialScope, apiKeyDigest } from '@genai/identity';
import type { MiddlewareHandler } from 'hono';
import { decodeJwt } from 'jose';
import { reasonFreeWrites, routeOf, writeMethods } from './change-reason.js';
import { t } from './i18n/index.js';

export const lockedEnvironmentType = 'urn:genai:problem:locked-environment';

export const entraNotTrustedType = 'urn:genai:problem:entra-not-trusted';

export {
  configuredCredentialScope,
  isLockdown,
  mayUseModels,
  readOnlyInLockdown,
  trustedEntraFrom,
  trustedEntraScope,
};

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
  const scopes = (principal.scopes ?? []).filter(
    (s) => s !== configuredCredentialScope && s !== admittedCredentialScope,
  );
  const key = presentedKey(request);
  const configured =
    (key !== undefined && lockdown.configuredKeys.has(apiKeyDigest(key))) ||
    (principal.scopes?.includes(admittedCredentialScope) ?? false);
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

const readableWrites = new Set(['personal', 'feedback', 'check']);

export const secretSendingChecks = new Set([
  'POST /tenants/:tenant/building-blocks/contract-tests',
  'POST /operator/knowledge/endpoints/test',
]);

const changesConfiguration = (route: string) => {
  const kind = reasonFreeWrites[route];
  return writeMethods.has(route.split(' ')[0] ?? '') && !(kind && readableWrites.has(kind));
};

const refusal = (title: string, detail: string) => ({
  type: lockedEnvironmentType,
  status: 403 as const,
  title,
  detail,
});

const lockedProblem = (route: string, principal: Principal) => {
  if (modelRunRoutes.has(route))
    return mayUseModels(principal)
      ? undefined
      : refusal(t('problems.modelsLocked'), t('problems.modelsLockedDetail'));
  if (ingestionRoutes.has(route))
    return mayUseModels(principal)
      ? undefined
      : refusal(t('problems.ingestionLocked'), t('problems.ingestionLockedDetail'));
  if (changesConfiguration(route) && readOnlyInLockdown(principal))
    return refusal(t('problems.changesLocked'), t('problems.changesLockedDetail'));
  if (secretSendingChecks.has(route) && readOnlyInLockdown(principal))
    return refusal(t('problems.secretChecksLocked'), t('problems.secretChecksLockedDetail'));
  return undefined;
};

const problemJson = { 'content-type': 'application/problem+json' };

const presentsCredential = (request: Request) =>
  request.headers.has('x-api-key') || /^bearer /i.test(request.headers.get('authorization') ?? '');

const locks = (route: string) =>
  modelRunRoutes.has(route) ||
  ingestionRoutes.has(route) ||
  secretSendingChecks.has(route) ||
  changesConfiguration(route);

export const refuseLockedRoutes =
  (caller: (request: Request) => Promise<Principal | undefined>): MiddlewareHandler =>
  async (c, next) => {
    const route = routeOf(c);
    if (!route || !locks(route)) return next();
    const principal = await caller(c.req.raw);
    if (!principal) {
      if (!presentsCredential(c.req.raw)) return next();
      return c.json(
        { type: 'about:blank', title: t('problems.status401'), status: 401 },
        401,
        problemJson,
      );
    }
    const locked = lockedProblem(route, principal);
    if (!locked) return next();
    return c.json(locked, 403, problemJson);
  };

const bearerClaims = (request: Request) => {
  const header = request.headers.get('authorization') ?? '';
  const token = /^bearer (.+)$/i.exec(header)?.[1]?.trim();
  if (!token) return undefined;
  try {
    return decodeJwt(token);
  } catch {
    return undefined;
  }
};

export const refuseUntrustedEntra =
  (refusedCode: (request: Request) => Promise<string | undefined>): MiddlewareHandler =>
  async (c, next) => {
    if (bearerClaims(c.req.raw)?.acr !== 'entraid') return next();
    if ((await refusedCode(c.req.raw)) !== 'entra_not_trusted') return next();
    return c.json(
      {
        type: entraNotTrustedType,
        status: 403,
        title: t('problems.entraNotTrusted'),
        detail: t('problems.entraNotTrustedDetail'),
      },
      403,
      problemJson,
    );
  };
