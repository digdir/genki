import { randomBytes, randomUUID } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import type { DefinitionStore } from '@genai/definitions';
import {
  actingForHeader,
  apiKeyDigest,
  boundService,
  channelOf,
  checkClient,
  oidcAudienceOf,
  originAllowed,
  type ClientDefinition,
  type ClientRegistry,
  type ClientStore,
  type StoredClient,
} from '@genai/identity';
import type { Context, Env, Hono, MiddlewareHandler, Schema } from 'hono';
import { enterTenant, tenantAccess } from './access.js';
import {
  actorOf,
  AdminRefused,
  refusedBy,
  routeOnly,
  type Admin,
  type AdminHandler,
  type AdminOutcome,
} from './admin.js';
import { keyView, overridable, type TenantApiKeys } from './routes/portal-routes.js';
import { rightRefused, type Right } from './rights.js';
import type { Webhooks } from './webhooks.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';

export interface ClientListener {
  saved?(client: ClientDefinition, before?: ClientDefinition): void | Promise<void>;
  removed?(client: ClientDefinition): void | Promise<void>;
}

export const notifyingClients = (inner: ClientStore, listener: ClientListener): ClientStore => ({
  list: (tenant) => inner.list(tenant),
  get: (tenant, id) => inner.get(tenant, id),
  save: async (client) => {
    const { tenant, id } = client.definition.metadata;
    const before = await inner.get(tenant, id);
    await inner.save(client);
    await listener.saved?.(client.definition, before?.definition);
  },
  remove: async (tenant, id) => {
    const before = await inner.get(tenant, id);
    const removed = await inner.remove(tenant, id);
    if (removed && before) await listener.removed?.(before.definition);
    return removed;
  },
});

export const clientRegistry = (clients: ClientStore): ClientRegistry => ({
  byClientId: async (clientId) => {
    const found = (await clients.list()).find((c) => c.definition.spec.oidc?.clientId === clientId);
    if (!found) return undefined;
    const { definition } = found;
    return {
      clientId,
      audience: oidcAudienceOf(definition) ?? clientId,
      tenant: definition.metadata.tenant,
      service: definition.spec.service,
      client: definition.metadata.id,
    };
  },
});

export const admitConfined = async (
  clients: ClientStore,
  request: Request,
  principal: Principal,
): Promise<boolean> => {
  const confined = principal.confinedTo;
  if (!confined) return true;
  const path = new URL(request.url).pathname;
  if (path === '/me' && request.method === 'GET') return true;
  const channel = channelOf(path);
  if (!channel) return false;
  if (!confined.client) return true;
  const client = await clients.get(confined.tenant, confined.client);
  if (!client || client.definition.spec.service !== confined.service) return false;
  if (!client.definition.spec.channels.includes(channel)) return false;
  const origin = request.headers.get('origin');
  return !origin || client.definition.spec.allowedOrigins.includes(origin);
};

const corsHeaders = (origin: string) => ({
  'access-control-allow-origin': origin,
  'access-control-expose-headers':
    'genai-task, genai-conversation, genai-service-version, genai-model, mcp-session-id',
  vary: 'Origin',
});

export const clientCors =
  (clients: ClientStore): MiddlewareHandler =>
  async (c, next) => {
    const origin = c.req.header('origin');
    if (!origin || !channelOf(c.req.path) || !originAllowed(await clients.list(), origin))
      return next();
    if (c.req.method === 'OPTIONS')
      return c.body(null, 204, {
        ...corsHeaders(origin),
        'access-control-allow-methods': 'GET, POST, PUT, DELETE, OPTIONS',
        'access-control-allow-headers': `authorization, content-type, accept, mcp-session-id, mcp-protocol-version, genai-version, ${actingForHeader}`,
        'access-control-max-age': '600',
      });
    await next();
    const res = new Response(c.res.body, c.res);
    for (const [k, v] of Object.entries(corsHeaders(origin))) res.headers.set(k, v);
    c.res = res;
  };

const forTenant = (principal: Principal, tenant: string) =>
  !principal.confinedTo &&
  principal.tenant === tenant &&
  (principal.kind !== 'operator' || principal.actor !== undefined);

const refused = (target: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path: 'principal', message }],
  target,
});

export interface FrontendDeps {
  clients: ClientStore;
  definitions: DefinitionStore;
  reservedClientIds?: string[];
  now?: () => Date;
}

const serviceExists = async (definitions: DefinitionStore, tenant: string, service: string) =>
  Boolean(await definitions.get('Service', tenant, service));

export const saveClient = async (
  deps: FrontendDeps,
  input: unknown,
  by: string,
): Promise<
  { ok: true; client: StoredClient } | { ok: false; errors: { path: string; message: string }[] }
> => {
  const checked = checkClient(input, await deps.clients.list(), deps.reservedClientIds);
  if (!checked.ok) return checked;
  const { tenant, id } = checked.definition.metadata;
  if (!(await serviceExists(deps.definitions, tenant, checked.definition.spec.service)))
    return {
      ok: false,
      errors: [{ path: 'spec.service', message: `no service ${checked.definition.spec.service}` }],
    };
  const before = await deps.clients.get(tenant, id);
  const client: StoredClient = {
    definition: checked.definition,
    version: (before?.version ?? 0) + 1,
    updatedAt: (deps.now?.() ?? new Date()).toISOString(),
    updatedBy: by,
  };
  await deps.clients.save(client);
  return { ok: true, client };
};

export const webhookTestAction = 'platform.clients.webhook-test';

export const frontendAdminHandlers = (deps: FrontendDeps): Record<string, AdminHandler> => ({
  [webhookTestAction]: routeOnly,
  'platform.clients.save': async (input, principal) => {
    const definition = (input.definition ?? {}) as {
      metadata?: { tenant?: unknown; id?: unknown };
    };
    const target = `client:${input.tenant}/${String(definition.metadata?.id ?? '')}`;
    if (!forTenant(principal, input.tenant))
      return refused(target, 'only the tenant or an operator changes its clients');
    if (definition.metadata?.tenant !== input.tenant)
      return {
        ok: false,
        errors: [{ path: 'metadata.tenant', message: 'the client belongs to another tenant' }],
        target,
      };
    const saved = await saveClient(deps, definition, actorOf(principal));
    if (!saved.ok) return { ok: false, errors: saved.errors, target };
    return {
      ok: true,
      value: saved.client,
      target,
      audit: { after: saved.client.definition.spec },
    };
  },
  'platform.clients.remove': async (input, principal) => {
    const id = String(input.id ?? '');
    const target = `client:${input.tenant}/${id}`;
    if (!forTenant(principal, input.tenant))
      return refused(target, 'only the tenant or an operator removes its clients');
    const removed = await deps.clients.remove(input.tenant, id);
    if (!removed) return { ok: false, errors: [{ path: 'id', message: 'no such client' }], target };
    return { ok: true, value: { id }, target, audit: { after: { removed: true } } };
  },
});

export interface PlatformEndpoints {
  issuer?: string;
  audience?: string;
  altinnResource?: string;
}

export interface FrontendRouteDeps extends FrontendDeps {
  admin: Admin;
  authenticate(request: Request): Promise<Principal | undefined>;
  apiKeys: TenantApiKeys;
  webhooks: Webhooks;
  endpoints?: PlatformEndpoints;
  newKey?: () => string;
  newId?: () => string;
}

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404,
  title: string,
  errors: unknown[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const channelPaths = {
  mcp: ['POST /api/mcp'],
  openai: ['GET /v1/models', 'POST /v1/chat/completions'],
  rest: ['GET /api/tools/openapi.json', 'POST /api/tools/call/{tool}'],
  conversations: ['GET /api/conversations', 'POST /api/conversations'],
  feedback: ['POST /api/feedback'],
  facets: ['GET /api/facets', 'GET /api/datasets'],
};

export const registerFrontendRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: FrontendRouteDeps,
) => {
  const now = deps.now ?? (() => new Date());
  const newKey = deps.newKey ?? (() => `gp_${randomBytes(24).toString('base64url')}`);
  const newId = deps.newId ?? (() => randomUUID());
  const reasonOf = (c: Context) => changeReasonOf(c)?.trim() ?? '';

  const access = tenantAccess(deps.admin);
  const guard = async (c: Context, right?: Right) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return problem(c, 401, 'Unauthorized');
    const tenant = c.req.param('tenant') ?? '';
    if (principal.confinedTo) return problem(c, 404, 'Not found');
    const entered = enterTenant(c, access, principal, tenant, right);
    if ('response' in entered) return entered.response;
    return { principal: entered.principal, tenant };
  };

  const perform = async (
    c: Context,
    principal: Principal,
    action: string,
    data: Record<string, unknown> & { tenant: string },
  ) => {
    if (!isReasonLongEnough(reasonOf(c)))
      return {
        ok: false as const,
        response: problem(c, 400, 'Invalid request', [
          { path: 'change-reason', message: reasonTooShort },
        ]),
      };
    const result = await deps.admin.perform(principal, action, {
      ...data,
      reason: reasonOf(c),
    });
    c.header('genai-task', result.task);
    if (result.ok) return { ok: true as const, value: result.value };
    if (result.problem) return { ok: false as const, response: rightRefused(c, result.problem) };
    const forbidden = result.errors.some((e) => e.path === 'principal');
    if (!forbidden && result.errors.some((e) => e.path === 'id'))
      return { ok: false as const, response: problem(c, 404, 'Not found', result.errors) };
    return {
      ok: false as const,
      response: problem(
        c,
        forbidden ? 403 : 400,
        forbidden ? 'Forbidden' : 'Invalid request',
        result.errors,
      ),
    };
  };

  const view = async (client: StoredClient) => ({
    ...client,
    deliveries: await deps.webhooks.deliveries(
      client.definition.metadata.tenant,
      client.definition.metadata.id,
    ),
  });

  app.get('/tenants/:tenant/clients', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const service = c.req.query('service');
    const clients = (await deps.clients.list(g.tenant))
      .filter((x) => !service || x.definition.spec.service === service)
      .sort((a, b) => a.definition.metadata.id.localeCompare(b.definition.metadata.id));
    return c.json({
      clients: await Promise.all(clients.map(view)),
      endpoints: channelPaths,
      oidc: deps.endpoints ?? {},
    });
  });

  app.put('/tenants/:tenant/clients/:id', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const metadata = (body.metadata ?? {}) as Record<string, unknown>;
    const definition = {
      apiVersion: 'genai/v1',
      kind: 'Client',
      ...body,
      metadata: { ...metadata, tenant: g.tenant, id: c.req.param('id') },
    };
    const outcome = await perform(c, g.principal, 'platform.clients.save', {
      tenant: g.tenant,
      definition,
    });
    if (!outcome.ok) return outcome.response;
    return c.json(await view(outcome.value as StoredClient));
  });

  app.delete('/tenants/:tenant/clients/:id', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    const outcome = await perform(c, g.principal, 'platform.clients.remove', {
      tenant: g.tenant,
      id: c.req.param('id') ?? '',
    });
    if (!outcome.ok) return outcome.response;
    return c.json(outcome.value);
  });

  app.post('/tenants/:tenant/clients/:id/webhook/test', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    const client = await deps.clients.get(g.tenant, c.req.param('id') ?? '');
    if (!client) return problem(c, 404, 'Not found');
    const reason = reasonOf(c);
    if (!isReasonLongEnough(reason))
      return problem(c, 400, 'Invalid request', [
        { path: 'change-reason', message: reasonTooShort },
      ]);
    try {
      const done = await deps.admin.within(
        g.principal,
        webhookTestAction,
        { tenant: g.tenant, reason, client: client.definition.metadata.id },
        async () => ({
          value: await deps.webhooks.deliver(client, 'ping', { message: 'test' }),
          target: `client:${g.tenant}/${client.definition.metadata.id}`,
        }),
      );
      c.header('genai-task', done.task);
      return c.json(done.value);
    } catch (error) {
      if (error instanceof AdminRefused) return refusedBy(c, error);
      throw error;
    }
  });

  app.get('/tenants/:tenant/services/:service/api-keys', async (c) => {
    const g = await guard(c);
    if (g instanceof Response) return g;
    const service = c.req.param('service');
    const keys = (await deps.apiKeys.list(g.tenant))
      .filter((k) => boundService(k) === service)
      .map(keyView)
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
    return c.json({ keys });
  });

  app.post('/tenants/:tenant/services/:service/api-keys', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    const service = c.req.param('service') ?? '';
    if (!(await serviceExists(deps.definitions, g.tenant, service)))
      return problem(c, 404, 'Not found');
    const body = (await c.req.json().catch(() => ({}))) as {
      name?: unknown;
      client?: unknown;
      expiresInDays?: unknown;
      allowedOverrides?: unknown;
    };
    const client = typeof body.client === 'string' && body.client ? body.client : undefined;
    if (client) {
      const found = await deps.clients.get(g.tenant, client);
      if (!found || found.definition.spec.service !== service)
        return problem(c, 400, 'Invalid request', [
          { path: 'client', message: `no client ${client} for ${service}` },
        ]);
    }
    const days =
      typeof body.expiresInDays === 'number' && body.expiresInDays > 0
        ? body.expiresInDays
        : undefined;
    const key = newKey();
    const created = now();
    const outcome = await perform(c, g.principal, 'platform.apikeys.create', {
      tenant: g.tenant,
      id: newId(),
      name: typeof body.name === 'string' ? body.name : '',
      service,
      ...(client ? { clientId: client } : {}),
      datasets: [],
      agents: [],
      allowedOverrides: overridable(body.allowedOverrides),
      digest: apiKeyDigest(key),
      prefix: key.slice(0, 7),
      lastFour: key.slice(-4),
      createdAt: created.toISOString(),
      ...(days ? { expiresAt: new Date(created.getTime() + days * 86_400_000).toISOString() } : {}),
    });
    if (!outcome.ok) return outcome.response;
    return c.json({ key, apiKey: outcome.value }, 201);
  });

  app.post('/tenants/:tenant/api-keys/:id/rotate', async (c) => {
    const g = await guard(c, 'manage-services');
    if (g instanceof Response) return g;
    const body = (await c.req.json().catch(() => ({}))) as { allowedOverrides?: unknown };
    const key = newKey();
    const outcome = await perform(c, g.principal, 'platform.apikeys.rotate', {
      tenant: g.tenant,
      id: c.req.param('id') ?? '',
      ...(Array.isArray(body.allowedOverrides)
        ? { allowedOverrides: overridable(body.allowedOverrides) }
        : {}),
      newId: newId(),
      digest: apiKeyDigest(key),
      prefix: key.slice(0, 7),
      lastFour: key.slice(-4),
      createdAt: now().toISOString(),
    });
    if (!outcome.ok) return outcome.response;
    return c.json({ key, apiKey: outcome.value }, 201);
  });
};
