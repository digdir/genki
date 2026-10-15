import { isTrustedEntraLogin } from '@genai/composition';
import type { Principal } from '@genai/contracts';
import { clientGrants, isUnregisteredClient } from '@genai/identity';
import type { Context, MiddlewareHandler } from 'hono';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { enterTenant } from './access.js';
import { appendVersion, serialized, type ConfigEntryStore } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { PlatformModuleFactory } from './platform-modules.js';

export const maskinportenClientKind = 'maskinporten-client';

export interface MaskinportenClient {
  clientId: string;
  name: string;
  services: string[];
}

interface StoredMaskinportenClient extends MaskinportenClient {
  admittedInLockdown?: boolean;
}

export interface MaskinportenClientView extends MaskinportenClient {
  tenant: string;
  createdBy: string;
  createdAt: string;
}

export const clientNotRegistered = {
  type: 'urn:genai:problem:client-not-registered',
  title: 'Maskinporten-klienten er ikke registrert hos virksomheten',
  status: 403,
} as const;

const clientIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const servicePattern = /^[a-z0-9][a-z0-9._-]{0,99}$/;

const publicSpec = ({
  clientId,
  name,
  services,
}: StoredMaskinportenClient): MaskinportenClient => ({
  clientId,
  name,
  services,
});

export const maskinportenClientRegistry = (store: ConfigEntryStore) => ({
  list: async (tenant: string): Promise<MaskinportenClientView[]> =>
    (await store.latest({ kind: maskinportenClientKind, scope: tenant }))
      .filter((e) => !e.deleted)
      .map((e) => ({
        ...publicSpec(e.spec as StoredMaskinportenClient),
        tenant: e.scope,
        createdBy: e.by,
        createdAt: e.at,
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'nb')),
  find: async (tenant: string, clientId: string): Promise<StoredMaskinportenClient | undefined> => {
    const latest = (await store.history(maskinportenClientKind, tenant, clientId)).at(-1);
    return latest && !latest.deleted ? (latest.spec as StoredMaskinportenClient) : undefined;
  },
});

export type MaskinportenClientRegistry = ReturnType<typeof maskinportenClientRegistry>;

export const admitMaskinportenClients =
  (registry: MaskinportenClientRegistry, maskinportenIssuers: readonly string[]) =>
  async (principal: Principal): Promise<Principal> => {
    if (
      principal.kind !== 'agency-system' ||
      !maskinportenIssuers.includes(principal.issuer) ||
      !principal.tenant ||
      !principal.client
    )
      return principal;
    const registered = await registry.find(principal.tenant, principal.client);
    return clientGrants(principal, registered?.services, registered?.admittedInLockdown === true);
  };

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const failed = (target: string, path: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const clientPaths = [
  '/v1/*',
  '/models',
  '/api/tools/*',
  '/api/mcp',
  '/a2a',
  '/a2a/*',
  '/api/datasets',
  '/api/datasets/*',
  '/api/facets',
  '/api/conversations',
  '/api/conversations/*',
];

export const maskinportenClientsModule: PlatformModuleFactory = (deps) => {
  const registry = maskinportenClientRegistry(deps.configEntries);
  const writes = serialized();

  const handlers: Record<string, AdminHandler> = {
    'platform.maskinporten-client.save': (input, principal) =>
      writes(async () => {
        const { tenant, reason } = input;
        const clientId = String(input.clientId ?? '');
        const target = `maskinporten-client:${tenant}/${clientId}`;
        if (principal.kind === 'operator' || principal.actor)
          return failed(
            target,
            'principal',
            'Maskinporten-klienter registreres av virksomheten selv',
          );
        if (principal.tenant !== tenant)
          return failed(target, 'principal', 'only the tenant registers its clients');
        if (!clientIdPattern.test(clientId))
          return failed(target, 'clientId', 'not a valid Maskinporten client id');
        const name = typeof input.name === 'string' ? input.name.trim() : '';
        if (!name) return failed(target, 'name', 'a name is required');
        const services = Array.isArray(input.services) ? input.services : [];
        if (services.length === 0 || services.some((s) => typeof s !== 'string'))
          return failed(target, 'services', 'list the services, or ["*"] for all');
        const wanted = services as string[];
        if (wanted.includes('*') && wanted.length > 1)
          return failed(target, 'services', '"*" stands alone');
        if (!wanted.includes('*'))
          for (const service of wanted) {
            const found =
              servicePattern.test(service) &&
              (await deps.definitions.get('Service', tenant, service));
            if (!found) return failed(target, 'services', `no service ${service}`);
          }
        const before = await registry.find(tenant, clientId);
        const spec: MaskinportenClient = { clientId, name, services: [...new Set(wanted)] };
        await appendVersion(deps.configEntries, {
          kind: maskinportenClientKind,
          scope: tenant,
          id: clientId,
          spec: isTrustedEntraLogin(principal) ? { ...spec, admittedInLockdown: true } : spec,
          deleted: false,
          by: actorOf(principal),
          reason,
        });
        return {
          ok: true,
          value: spec,
          target,
          audit: { before: before ? publicSpec(before) : null, after: spec },
        };
      }),
    'platform.maskinporten-client.remove': (input, principal) =>
      writes(async () => {
        const { tenant, reason } = input;
        const clientId = String(input.clientId ?? '');
        const target = `maskinporten-client:${tenant}/${clientId}`;
        const isMember = principal.tenant === tenant;
        if (!isMember) return failed(target, 'principal', 'only the tenant removes its clients');
        const before = await registry.find(tenant, clientId);
        if (!before) return failed(target, 'clientId', `no client ${clientId}`);
        await appendVersion(deps.configEntries, {
          kind: maskinportenClientKind,
          scope: tenant,
          id: clientId,
          spec: before,
          deleted: true,
          by: actorOf(principal.actor ?? principal),
          reason,
        });
        return {
          ok: true,
          value: { removed: clientId },
          target,
          audit: { before: publicSpec(before) },
        };
      }),
  };

  const refuseUnregistered =
    (authenticate: (request: Request) => Promise<Principal | undefined>): MiddlewareHandler =>
    async (c, next) => {
      const principal = await authenticate(c.req.raw);
      if (principal && isUnregisteredClient(principal))
        return c.json(
          {
            ...clientNotRegistered,
            detail: `Klienten ${principal.client ?? ''} er ikke registrert hos ${principal.tenant ?? ''}. Virksomheten registrerer den under Integrasjoner.`,
          },
          403,
          { 'content-type': 'application/problem+json' },
        );
      return next();
    };

  return {
    id: 'maskinporten-clients',
    handlers,
    mount: (app, mounted) => {
      for (const path of clientPaths) app.use(path, refuseUnregistered(mounted.authenticate));

      const base = '/tenants/:tenant/maskinporten-clients';
      const entered = async (c: Context, right: 'manage-services') => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        const tenant = c.req.param('tenant') ?? '';
        const result = enterTenant(c, mounted.access, principal, tenant, right);
        return 'response' in result ? result : { principal: result.principal, tenant };
      };
      const perform = async (
        c: Context,
        principal: Principal,
        action: string,
        data: Record<string, unknown> & { tenant: string },
      ) => {
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const result = await mounted.admin.perform(principal, action, { ...data, reason });
        c.header('genai-task', result.task);
        if (result.ok) return undefined;
        const paths = new Set(result.errors.map((e) => e.path));
        if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
        if (action.endsWith('.remove') && paths.has('clientId'))
          return problem(c, 404, 'Not found', result.errors);
        return problem(c, 400, 'Invalid request', result.errors);
      };

      app.get(base, async (c) => {
        const guard = await entered(c, 'manage-services');
        if ('response' in guard) return guard.response;
        return c.json({ data: await registry.list(guard.tenant) });
      });

      app.post(base, async (c) => {
        const guard = await entered(c, 'manage-services');
        if ('response' in guard) return guard.response;
        const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
        const refused = await perform(c, guard.principal, 'platform.maskinporten-client.save', {
          tenant: guard.tenant,
          clientId: body.clientId,
          name: body.name,
          services: body.services,
        });
        if (refused) return refused;
        const saved = (await registry.list(guard.tenant)).find(
          (client) => client.clientId === body.clientId,
        );
        return c.json(saved, 201);
      });

      app.delete(`${base}/:clientId`, async (c) => {
        const guard = await entered(c, 'manage-services');
        if ('response' in guard) return guard.response;
        const refused = await perform(c, guard.principal, 'platform.maskinporten-client.remove', {
          tenant: guard.tenant,
          clientId: c.req.param('clientId') ?? '',
        });
        return refused ?? c.body(null, 204);
      });
    },
  };
};
