import { perThousandView, type Principal } from '@genai/contracts';
import { allowedHostPattern } from '@genai/port-model';
import type { Context } from 'hono';
import type { CatalogItem } from './catalog-registry.js';
import { platformScope } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { candidateRelease } from './model-access.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import type { ServiceModels } from './service-health.js';

export const platformSecretPattern = /^secret:\/\/platform\/([a-z0-9][a-z0-9._-]*)$/;

const endpointId = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const familyBase = /^(\/[A-Za-z0-9._~-]+)*\/?$/;

type Problem = { path: string; message: string };

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: Problem[] = [],
  extra: Record<string, unknown> = {},
) =>
  c.json({ type: 'about:blank', title, status, errors, ...extra }, status, {
    'content-type': 'application/problem+json',
  });

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const httpsURL = (value: unknown) => {
  let url: URL | undefined;
  try {
    url = new URL(String(value));
  } catch {
    return false;
  }
  return url.protocol === 'https:' && !url.username && !url.password;
};

/** What is wrong with a connection: its id, an HTTPS root, a platform secret, and families Genki has APIs for. */
export const endpointProblems = (
  body: Record<string, unknown>,
  knownFamilies: readonly string[],
): Problem[] => {
  const errors: Problem[] = [];
  if (!endpointId.test(String(body.id ?? '')))
    errors.push({ path: 'id', message: 'lowercase letters, digits, dots, dashes' });
  if (!httpsURL(body.baseURL))
    errors.push({ path: 'baseURL', message: 'an HTTPS address without credentials' });
  const families = record(body.families);
  if (Object.keys(families).length === 0)
    errors.push({ path: 'families', message: 'name at least one API family and its base' });
  for (const [family, base] of Object.entries(families)) {
    if (!knownFamilies.includes(family))
      errors.push({
        path: `families.${family}`,
        message: `no API in the ${family} family; one of ${knownFamilies.join(', ')}`,
      });
    if (typeof base !== 'string' || !(familyBase.test(base) || httpsURL(base)))
      errors.push({
        path: `families.${family}`,
        message: 'a path under baseURL, or an HTTPS address without credentials',
      });
  }
  if (body.discovery !== undefined && !Array.isArray(body.discovery))
    errors.push({ path: 'discovery', message: 'a list of discovery rules' });
  if (
    body.allowedHosts !== undefined &&
    (!Array.isArray(body.allowedHosts) ||
      body.allowedHosts.length > 20 ||
      body.allowedHosts.some((h) => typeof h !== 'string' || !allowedHostPattern.test(h)))
  )
    errors.push({
      path: 'allowedHosts',
      message: 'a list of at most 20 host names, each with an optional port',
    });
  const auth = record(body.auth);
  if (auth.kind !== 'api-key' && auth.kind !== 'bearer')
    errors.push({ path: 'auth.kind', message: 'api-key or bearer' });
  if (!platformSecretPattern.test(String(auth.secret ?? '')))
    errors.push({
      path: 'auth.secret',
      message: 'use a platform secret: secret://platform/<name>',
    });
  return errors;
};

const modelsUsedBy = (config: unknown) => {
  const model = record(config).model as ServiceModels | undefined;
  return [
    model?.primary,
    model?.fallback,
    ...Object.values(model?.roles ?? {}),
    ...Object.values(model?.operations ?? {}),
  ].filter((m): m is string => typeof m === 'string');
};

export const operatorModelsModule: PlatformModuleFactory = (deps) => ({
  id: 'operator-models',
  mount: (app, mounted: MountDeps) => {
    const operator = async (c: Context) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return { response: problem(c, 401, 'Unauthorized') };
      if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
      return { principal: { ...principal, tenant: deps.platformTenant } };
    };
    const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';
    const body = async (c: Context) => record(await c.req.json().catch(() => ({})));
    const catalogChange = async (
      c: Context,
      principal: Principal,
      action: 'platform.catalog.publish' | 'platform.catalog.delete',
      data: Record<string, unknown>,
    ) => {
      const result = await mounted.admin.perform<CatalogItem>(principal, action, {
        ...data,
        scope: platformScope,
        tenant: deps.platformTenant,
        reason: reasonOf(c),
      });
      c.header('genai-task', result.task);
      return result;
    };
    const needReason = (c: Context) =>
      isReasonLongEnough(reasonOf(c))
        ? undefined
        : problem(c, 400, 'Invalid request', [{ path: 'change-reason', message: reasonTooShort }]);

    const knownFamilies = () =>
      [
        ...new Set(
          deps.models
            .apis()
            .list()
            .map((a) => a.family),
        ),
      ].sort();
    const connectionSpec = (input: Record<string, unknown>) => {
      const auth = record(input.auth);
      return {
        baseURL: input.baseURL,
        auth: {
          kind: auth.kind,
          secret: auth.secret,
          ...(typeof auth.header === 'string' && auth.header ? { header: auth.header } : {}),
        },
        families: input.families,
        ...(Array.isArray(input.discovery) ? { discovery: input.discovery } : {}),
        ...(Array.isArray(input.allowedHosts) ? { allowedHosts: input.allowedHosts } : {}),
      };
    };

    app.get('/operator/apis', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const apis = deps.models.apis();
      await deps.operations?.descriptors.refresh();
      const models = deps.models.describe();
      return c.json({
        data: apis.list().map((api) => ({
          ...api,
          models: models.filter((m) => Object.values(m.apis).includes(api.id)).map((m) => m.id),
        })),
      });
    });

    app.post('/operator/model-endpoints', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const missing = needReason(c);
      if (missing) return missing;
      const input = await body(c);
      const errors = endpointProblems(input, knownFamilies());
      if (errors.length > 0) return problem(c, 400, 'Invalid request', errors);
      const id = String(input.id);
      if (deps.catalog.get('model-endpoint', id))
        return problem(c, 409, 'Endepunktet finnes allerede', [
          { path: 'id', message: `${id} exists` },
        ]);
      const result = await catalogChange(c, guard.principal, 'platform.catalog.publish', {
        kind: 'model-endpoint',
        id,
        spec: connectionSpec(input),
      });
      if (!result.ok) return problem(c, 400, 'Invalid request', result.errors);
      return c.json(result.value, 201);
    });

    app.put('/operator/model-endpoints/:id', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      const endpoint = deps.catalog.get('model-endpoint', id);
      if (!endpoint || endpoint.scope !== platformScope) return problem(c, 404, 'Not found');
      const missing = needReason(c);
      if (missing) return missing;
      const input: Record<string, unknown> = { ...(await body(c)), id };
      const errors = endpointProblems(input, knownFamilies());
      if (errors.length > 0) return problem(c, 400, 'Invalid request', errors);
      const result = await catalogChange(c, guard.principal, 'platform.catalog.publish', {
        kind: 'model-endpoint',
        id,
        spec: {
          ...connectionSpec(input),
          ...(input.discovery === undefined && endpoint.spec.discovery
            ? { discovery: endpoint.spec.discovery }
            : {}),
          ...(input.allowedHosts === undefined && endpoint.spec.allowedHosts
            ? { allowedHosts: endpoint.spec.allowedHosts }
            : {}),
          ...(endpoint.spec.sharing ? { sharing: endpoint.spec.sharing } : {}),
        },
      });
      if (!result.ok) return problem(c, 400, 'Invalid request', result.errors);
      return c.json(result.value);
    });

    app.delete('/operator/model-endpoints/:id', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const id = c.req.param('id') ?? '';
      const endpoint = deps.catalog.get('model-endpoint', id);
      if (!endpoint || endpoint.scope !== platformScope) return problem(c, 404, 'Not found');
      const missing = needReason(c);
      if (missing) return missing;
      const catalogModels = deps.catalog
        .list({ kind: 'model' })
        .filter((m) => m.spec.endpoint === id);
      const ids = new Set([
        ...catalogModels.map((m) => m.id),
        ...deps.models
          .describe()
          .filter((m) => m.endpoint === id)
          .map((m) => m.id),
      ]);
      const names = await mounted.admin.tenantNames();
      const services = (await deps.definitions.capabilities())
        .filter((cap) => modelsUsedBy(cap.capability.config).some((m) => ids.has(m)))
        .map((cap) => ({
          service: cap.service.id,
          tenant: cap.service.tenant,
          tenantName: names.get(cap.service.tenant) ?? cap.service.tenant,
        }));
      const tenantModels = catalogModels.filter((m) => m.scope !== platformScope);
      if (services.length > 0 || tenantModels.length > 0)
        return problem(
          c,
          409,
          'Modellene fra endepunktet er i bruk',
          [
            ...services.map((s) => ({
              path: 'services',
              message: `${s.tenant}/${s.service} uses a model from ${id}`,
            })),
            ...tenantModels.map((m) => ({
              path: 'models',
              message: `${m.scope} registered ${m.id} on ${id}`,
            })),
          ],
          { services, models: tenantModels.map((m) => ({ id: m.id, tenant: m.scope })) },
        );
      for (const model of catalogModels) {
        const removed = await catalogChange(c, guard.principal, 'platform.catalog.delete', {
          kind: 'model',
          id: model.id,
        });
        if (!removed.ok) return problem(c, 400, 'Invalid request', removed.errors);
      }
      const removed = await catalogChange(c, guard.principal, 'platform.catalog.delete', {
        kind: 'model-endpoint',
        id,
      });
      if (!removed.ok) return problem(c, 400, 'Invalid request', removed.errors);
      return c.body(null, 204);
    });

    app.put('/operator/models/:id{.+}/price', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const missing = needReason(c);
      if (missing) return missing;
      const id = c.req.param('id') ?? '';
      if (!deps.models.describe().some((m) => m.id === id) && !deps.catalog.get('model', id))
        return problem(c, 404, 'Not found');
      const result = await catalogChange(c, guard.principal, 'platform.catalog.publish', {
        kind: 'price',
        id,
        spec: await body(c),
      });
      if (!result.ok) return problem(c, 400, 'Invalid request', result.errors);
      const prices = result.value.spec;
      return c.json({ id, prices, ...perThousandView(prices), currency: 'NOK' });
    });

    app.put('/operator/models/:id{.+}', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const missing = needReason(c);
      if (missing) return missing;
      const id = c.req.param('id') ?? '';
      const input = await body(c);
      const endpoint = deps.catalog.get('model-endpoint', String(input.endpoint ?? ''));
      if (!endpoint || endpoint.scope !== platformScope)
        return problem(c, 400, 'Invalid request', [
          { path: 'endpoint', message: `no platform endpoint ${String(input.endpoint)}` },
        ]);
      const added =
        !deps.catalog.get('model', id) && !deps.models.describe().some((m) => m.id === id);
      const prefixes = [
        endpoint.id,
        ...(Array.isArray(endpoint.spec.discovery) ? endpoint.spec.discovery : []).flatMap((r) =>
          typeof record(r).idPrefix === 'string' ? [String(record(r).idPrefix)] : [],
        ),
      ];
      if (added && !prefixes.some((p) => id.startsWith(`${p}/`)))
        return problem(c, 400, 'Invalid request', [
          { path: 'id', message: `the id starts with ${endpoint.id}/` },
        ]);
      const apis = record(input.apis ?? deps.catalog.get('model', id)?.spec.apis);
      const result = await catalogChange(c, guard.principal, 'platform.catalog.publish', {
        kind: 'model',
        id,
        spec: {
          endpoint: endpoint.id,
          deployment: input.deployment,
          ...(input.family === undefined ? {} : { family: input.family }),
          residency: input.residency,
          capabilities: input.capabilities ?? [],
          ...(Object.keys(apis).length > 0 ? { apis } : {}),
          ...(input.options === undefined ? {} : { options: input.options }),
          ...(added ? { release: candidateRelease } : {}),
        },
      });
      if (!result.ok) return problem(c, 400, 'Invalid request', result.errors);
      if (typeof input.enabled === 'boolean') {
        const classified = await mounted.admin.classifyModel(
          guard.principal,
          id,
          { enabled: input.enabled },
          reasonOf(c),
        );
        if (!classified.ok) return problem(c, 400, 'Invalid request', classified.errors);
        return c.json({ ...result.value, enabled: classified.value.enabled });
      }
      return c.json(result.value);
    });
  },
});
