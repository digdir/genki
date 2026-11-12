import type { Principal } from '@genai/contracts';
import {
  admittedCredentialScope,
  ALL_GRANT,
  channelOf,
  grantsOf,
  isApiKeyPrincipal,
  isTestRunnerKey,
  testRunnerScope,
} from '@genai/identity';
import type { Context, MiddlewareHandler } from 'hono';
import { parse as parseYaml } from 'yaml';
import { reasonFreeWrites, routeOf } from './change-reason.js';
import { t } from './i18n/index.js';
import { configuredCredentialScope, secretSendingChecks } from './lockdown.js';

export const testRunnerScopeType = 'urn:genai:problem:test-runner-scope';
export const testRunnerRefusedType = 'urn:genai:problem:test-runner-refused';

export const smokePrefix = 'smoke-';

const isSmoke = (id: unknown) => typeof id === 'string' && id.startsWith(smokePrefix);

const pathOf = (request: Request) => new URL(request.url).pathname;

const operatorViewPaths = new Set([
  '/operator/tenants',
  '/operator/operations',
  '/operator/models',
  '/operator/apis',
  '/operator/plugins',
  '/operator/catalog',
  '/operator/tracing',
  '/operator/quality',
  '/operator/knowledge/engines',
]);
const operatorViewFamilies = ['/operator/plugins/', '/operator/catalog/'];

const plainSegments = (rest: string) =>
  rest.split('/').every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== '.' && s !== '..');

export const inOperatorView = (path: string) =>
  operatorViewPaths.has(path) ||
  operatorViewFamilies.some(
    (family) => path.startsWith(family) && plainSegments(path.slice(family.length)),
  );

const isOperatorRead = (request: Request) =>
  request.method === 'GET' && inOperatorView(pathOf(request));

export const testRunnerView = (
  principal: Principal,
  request: Request,
  allowed: boolean,
): Principal => {
  const scopes = principal.scopes ?? [];
  if (!scopes.includes(testRunnerScope)) return principal;
  if (!allowed || !isApiKeyPrincipal(principal))
    return { ...principal, scopes: scopes.filter((s) => s !== testRunnerScope) };
  if (!isOperatorRead(request)) return principal;
  return {
    ...principal,
    kind: 'operator',
    scopes: scopes.filter((s) => s !== configuredCredentialScope && s !== admittedCredentialScope),
  };
};

const smokeActionTargets: Readonly<Record<string, (input: Record<string, unknown>) => unknown>> = {
  'platform.service.publish': (input) =>
    (input.definition as { metadata?: { id?: unknown } } | undefined)?.metadata?.id,
  'platform.service.lifecycle': (input) => input.id,
  'platform.service.draft.save': (input) => input.service,
  'platform.service.draft.delete': (input) => input.service,
};

export const testRunnerMayPerform = (action: string, input: Record<string, unknown>) => {
  const target = smokeActionTargets[action];
  return target !== undefined && isSmoke(target(input));
};

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};

const isYaml = (contentType: string | undefined) =>
  /^(application|text)\/(x-)?yaml\b/i.test(contentType ?? '');

const definitionIdOf = (definition: unknown) => {
  try {
    const parsed: unknown = typeof definition === 'string' ? parseYaml(definition) : definition;
    return record(record(parsed).metadata).id;
  } catch {
    return undefined;
  }
};

const publishedId = async (c: Context) => {
  try {
    const body: unknown = isYaml(c.req.header('content-type'))
      ? parseYaml(await c.req.text())
      : await c.req.json();
    const wrapped = 'definition' in record(body) && !('apiVersion' in record(body));
    const inner = wrapped ? record(body).definition : body;
    return definitionIdOf(inner);
  } catch {
    return undefined;
  }
};

const playgroundAllowed = async (c: Context, principal: Principal) => {
  const granted = grantsOf(principal)?.agents ?? [];
  const body = record(await c.req.json().catch(() => undefined));
  const setups = [body.setup, ...(body.compareWith === undefined ? [] : [body.compareWith])];
  return setups.every((setup) => {
    const service = record(record(setup).service);
    if (isSmoke(service.id))
      return service.definition === undefined || isSmoke(definitionIdOf(service.definition));
    const bound =
      typeof service.id === 'string' &&
      (granted.includes(ALL_GRANT) || granted.includes(service.id));
    return bound && service.version !== 'draft';
  });
};

const serviceIdInPath = (c: Context) => {
  const segment = c.req.path.split('/')[4];
  try {
    return segment === undefined ? undefined : decodeURIComponent(segment);
  } catch {
    return undefined;
  }
};

const smokeRoutes: Readonly<Record<string, (c: Context) => Promise<unknown> | unknown>> = {
  'POST /definitions': publishedId,
  'PUT /tenants/:tenant/services/:id/lifecycle': serviceIdInPath,
  'PUT /tenants/:tenant/services/:id/draft': serviceIdInPath,
  'DELETE /tenants/:tenant/services/:id/draft': serviceIdInPath,
};

const refusedChecks = new Set(['POST /tenants/:tenant/services/:id/batch-runs/estimate']);

const playgroundRoutes = new Set([
  'POST /tenants/:tenant/playground/runs',
  'POST /tenants/:tenant/playground/runs/stream',
]);

const readPaths = new Set([
  '/me',
  '/models',
  '/definitions',
  '/settings',
  '/shared-services',
  '/schemas',
  '/openapi.json',
]);
const readPrefixes = ['/definitions/', '/settings/', '/schemas/', '/onboarding/'];

const readable = (path: string) =>
  readPaths.has(path) ||
  readPrefixes.some((prefix) => path.startsWith(prefix)) ||
  inOperatorView(path);

const keyChannel = (path: string) =>
  channelOf(path) !== undefined || path === '/a2a' || path.startsWith('/a2a/');

const writable = async (c: Context, principal: Principal) => {
  const route = routeOf(c);
  if (!route) return false;
  const kind = reasonFreeWrites[route];
  const path = route.slice(route.indexOf(' ') + 1);
  if (kind === 'feedback') return true;
  if (kind === 'check')
    return (
      !path.startsWith('/operator/') && !secretSendingChecks.has(route) && !refusedChecks.has(route)
    );
  if (playgroundRoutes.has(route)) return playgroundAllowed(c, principal);
  const target = smokeRoutes[route];
  return target !== undefined && isSmoke(await target(c));
};

const problemJson = { 'content-type': 'application/problem+json' };

const ownTenantOf = (path: string) => /^\/tenants\/([^/]+)(\/|$)/.exec(path)?.[1];

export const refuseOutsideTestRunnerScope =
  (caller: (request: Request) => Promise<Principal | undefined>): MiddlewareHandler =>
  async (c, next) => {
    const principal = await caller(c.req.raw);
    if (!principal || !isTestRunnerKey(principal)) return next();
    const path = c.req.path;
    const tenant = ownTenantOf(path);
    if (tenant !== undefined && tenant !== principal.tenant)
      return c.json(
        { type: 'about:blank', title: t('problems.notFound'), status: 404 },
        404,
        problemJson,
      );
    if (keyChannel(path)) return next();
    const reads = c.req.method === 'GET' || c.req.method === 'HEAD';
    if (reads ? tenant !== undefined || readable(path) : await writable(c, principal))
      return next();
    return c.json(
      {
        type: testRunnerScopeType,
        title: t('problems.testRunnerScope'),
        status: 403,
        detail: t('problems.testRunnerScopeDetail'),
      },
      403,
      problemJson,
    );
  };
