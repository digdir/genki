import type { Principal } from '@genai/contracts';
import type { Context } from 'hono';
import type { CatalogItem } from './catalog-registry.js';
import { platformScope } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { candidateRelease } from './model-access.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import type { ServiceModels } from './service-health.js';

export const platformSecretPattern = /^secret:\/\/platform\/([a-z0-9][a-z0-9._-]*)$/;

const endpointId = /^[a-z0-9][a-z0-9._-]{0,62}$/;
const protocols = ['openai-chat', 'anthropic-messages'];

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

export const endpointProblems = (body: Record<string, unknown>): Problem[] => {
  const errors: Problem[] = [];
  if (!endpointId.test(String(body.id ?? '')))
    errors.push({ path: 'id', message: 'lowercase letters, digits, dots, dashes' });
  if (!protocols.includes(String(body.protocol)))
    errors.push({ path: 'protocol', message: `one of ${protocols.join(', ')}` });
  let url: URL | undefined;
  try {
    url = new URL(String(body.baseURL));
  } catch {
    url = undefined;
  }
  if (!url || url.protocol !== 'https:' || url.username || url.password)
    errors.push({ path: 'baseURL', message: 'an HTTPS address without credentials' });
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
  return [model?.primary, model?.fallback, ...Object.values(model?.roles ?? {})].filter(
    (m): m is string => typeof m === 'string',
  );
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

    app.post('/operator/model-endpoints', async (c) => {
      const guard = await operator(c);
      if ('response' in guard) return guard.response;
      const missing = needReason(c);
      if (missing) return missing;
      const input = await body(c);
      const errors = endpointProblems(input);
      if (errors.length > 0) return problem(c, 400, 'Invalid request', errors);
      const id = String(input.id);
      if (deps.catalog.get('model-endpoint', id))
        return problem(c, 409, 'Endepunktet finnes allerede', [
          { path: 'id', message: `${id} exists` },
        ]);
      const auth = record(input.auth);
      const result = await catalogChange(c, guard.principal, 'platform.catalog.publish', {
        kind: 'model-endpoint',
        id,
        spec: {
          protocol: input.protocol,
          baseURL: input.baseURL,
          auth: { kind: auth.kind, secret: auth.secret },
        },
      });
      if (!result.ok) return problem(c, 400, 'Invalid request', result.errors);
      return c.json(result.value, 201);
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
      const input = await body(c);
      const result = await catalogChange(c, guard.principal, 'platform.catalog.publish', {
        kind: 'price',
        id,
        spec: {
          inputPerThousand: input.inputPerThousand,
          outputPerThousand: input.outputPerThousand,
        },
      });
      if (!result.ok) return problem(c, 400, 'Invalid request', result.errors);
      return c.json({ id, ...result.value.spec, currency: 'NOK' });
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
      if (!id.startsWith(`${endpoint.id}/`))
        return problem(c, 400, 'Invalid request', [
          { path: 'id', message: `the id starts with ${endpoint.id}/` },
        ]);
      const added =
        !deps.catalog.get('model', id) && !deps.models.describe().some((m) => m.id === id);
      const result = await catalogChange(c, guard.principal, 'platform.catalog.publish', {
        kind: 'model',
        id,
        spec: {
          endpoint: endpoint.id,
          deployment: input.deployment,
          ...(input.family === undefined ? {} : { family: input.family }),
          residency: input.residency,
          capabilities: input.capabilities ?? [],
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
