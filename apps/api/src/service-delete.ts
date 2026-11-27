import type { Principal } from '@genai/contracts';
import {
  flowUsesOf,
  isInternalService,
  publicNamesOf,
  type FlowStep,
  type ServiceDefinition,
  type StepFlowDefinition,
} from '@genai/definitions';
import { recipeShareKind } from '@genai/composition';
import { boundService, type ClientStore } from '@genai/identity';
import type { HostnameClaimStore } from '@genai/kernel';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { appendVersion, serialized, type ConfigEntryStore } from './config-store.js';
import { isAddressClientOf, liveHostnamesOf } from './hostname-claims.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import {
  deletedInternalServiceKind,
  hidesInternalServices,
  seeingInternalServices,
} from './internal-services.js';
import type { ModuleDeps, PlatformModuleFactory } from './platform-modules.js';
import { serviceAccessKind } from './access-people.js';
import { serviceDraftKind } from './service-drafts.js';
import { serviceEnvironmentsKind } from './service-environments.js';
import { lifecycleOf, serviceLifecycleKind } from './service-lifecycle.js';
import { rightRefused } from './rights.js';
import { stepFlowArchiveKind } from './step-flow-archive.js';
import type { TenantApiKeys } from './routes/portal-routes.js';

export const serviceDeleteAction = 'platform.service.delete';
export const serviceNotArchivedType = 'urn:genai:problem:service-not-archived';
export const serviceInUseType = 'urn:genai:problem:service-in-use';

export interface ServiceDeleteDeps {
  clients: ClientStore;
  apiKeys: TenantApiKeys;
  claims: HostnameClaimStore;
  removeClient(principal: Principal, tenant: string, id: string, reason: string): Promise<boolean>;
  now?: () => number;
}

type Deps = Pick<ModuleDeps, 'definitions' | 'configEntries' | 'platformTenant'>;

const subflowsOf = (steps: readonly FlowStep[]): string[] =>
  steps.flatMap((s) => [
    ...(s.subflow ? [s.subflow] : []),
    ...subflowsOf(s.repeat?.steps ?? []),
    ...subflowsOf(s.forEach?.steps ?? []),
    ...(s.cases ?? []).flatMap((c) => subflowsOf(c.steps)),
    ...subflowsOf(s.else ?? []),
  ]);

const idOf = (ref: string) => ref.slice(0, ref.lastIndexOf('@'));

/** The organisation's own step flows the service runs that are not shared and nothing else stored runs. */
export const flowsOnlyUsedBy = (deps: Deps, tenant: string, service: string): Promise<string[]> =>
  seeingInternalServices(async () => {
    const { definitions } = deps;
    const ownFlows = async (owner: string) =>
      new Set(
        (await definitions.list(owner)).filter((e) => e.kind === 'StepFlow').map((e) => e.id),
      );
    const own = await ownFlows(tenant);
    const flowVersions = new Map<string, StepFlowDefinition[]>();
    const versionsOf = async (id: string) => {
      const known = flowVersions.get(id);
      if (known) return known;
      const found = (await definitions.versions('StepFlow', tenant, id)).map(
        (v) => v.definition as StepFlowDefinition,
      );
      flowVersions.set(id, found);
      return found;
    };
    const subflowIds = async (id: string) =>
      (await versionsOf(id)).flatMap((f) => subflowsOf(f.spec.steps).map(idOf));
    const closure = async (start: string[]) => {
      const reached = new Set<string>();
      const queue = start.filter((id) => own.has(id));
      while (queue.length > 0) {
        const id = queue.shift() as string;
        if (reached.has(id)) continue;
        reached.add(id);
        queue.push(...(await subflowIds(id)).filter((s) => own.has(s)));
      }
      return reached;
    };
    const serviceFlows = async (owner: string, id: string) =>
      (await definitions.versions('Service', owner, id)).flatMap((v) =>
        flowUsesOf((v.definition as ServiceDefinition).spec).map((u) => idOf(u.flow)),
      );

    const candidates = await closure(await serviceFlows(tenant, service));
    if (candidates.size === 0) return [];

    const everShared = async (id: string) =>
      tenant === deps.platformTenant &&
      (await deps.configEntries.history(recipeShareKind, deps.platformTenant, id)).length > 0;
    const roots: string[] = [];
    for (const id of own) {
      if (!candidates.has(id)) roots.push(...(await subflowIds(id)));
      else if (
        (await everShared(id)) ||
        (await versionsOf(id)).some((f) => f.spec.recipe !== undefined)
      )
        roots.push(id);
    }
    const tenants = new Set([
      tenant,
      ...(await definitions.capabilities()).map((c) => c.service.tenant),
    ]);
    for (const other of tenants) {
      const theirs = other === tenant ? own : await ownFlows(other);
      const refs: string[] = [];
      for (const entry of await definitions.list(other)) {
        if (entry.kind === 'Service' && !(other === tenant && entry.id === service))
          refs.push(...(await serviceFlows(other, entry.id)));
        if (entry.kind === 'StepFlow' && other !== tenant)
          for (const v of await definitions.versions('StepFlow', other, entry.id))
            refs.push(...subflowsOf((v.definition as StepFlowDefinition).spec.steps).map(idOf));
      }
      roots.push(...(other === tenant ? refs : refs.filter((id) => !theirs.has(id))));
    }
    const kept = await closure(roots);
    return [...candidates].filter((id) => !kept.has(id)).sort();
  });

export interface ServiceDependents {
  address?: { client: string; hostnames: string[] };
  frontends: { id: string; name: string }[];
  apiKeys: { id: string; name: string }[];
  services: string[];
  otherOrganisations: number;
  internalServices: number;
}

const mentions = (value: unknown, matches: (text: string) => boolean): boolean => {
  if (typeof value === 'string') return matches(value);
  if (Array.isArray(value)) return value.some((v) => mentions(v, matches));
  if (value && typeof value === 'object')
    return Object.values(value).some((v) => mentions(v, matches));
  return false;
};

const pathSegments = (text: string) =>
  /^https?:\/\//.test(text) && URL.canParse(text)
    ? new URL(text).pathname.split('/').map(decodeURIComponentSafe)
    : [];

const decodeURIComponentSafe = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

/** What still uses the service, and the address genki made for it. */
export const dependentsOf = async (
  deps: Deps & ServiceDeleteDeps,
  tenant: string,
  service: string,
): Promise<ServiceDependents> => {
  const now = (deps.now ?? Date.now)();
  const claims = await deps.claims.list(tenant);
  const using = (await deps.clients.list(tenant)).filter(
    (c) => c.definition.spec.service === service,
  );
  const own = using.find((c) => isAddressClientOf(c, service, claims));
  const address = own && {
    client: own.definition.metadata.id,
    hostnames: liveHostnamesOf(claims, own.definition.metadata.id),
  };
  const frontends = using
    .filter((c) => c !== own)
    .map(({ definition: { metadata, spec } }) => ({
      id: metadata.id,
      name: spec.hosted ? metadata.id : (metadata.name ?? metadata.id),
    }));
  const apiKeys = (await deps.apiKeys.list(tenant))
    .filter(
      (k) =>
        !k.revokedAt &&
        !(k.expiresAt && Date.parse(k.expiresAt) <= now) &&
        (boundService(k) === service || k.agents.includes(service)),
    )
    .map((k) => ({ id: k.id, name: k.name }));
  const hides = hidesInternalServices();
  return seeingInternalServices(async () => {
    const { definitions } = deps;
    const latest = await definitions.get('Service', tenant, service);
    const definition = latest?.definition as ServiceDefinition | undefined;
    const names = new Set(
      (definition?.spec.variants ?? []).flatMap((v) => {
        const { primary, aliases } = publicNamesOf(definition as ServiceDefinition, v);
        return [primary, ...aliases];
      }),
    );
    const capability = `${tenant}/${service}/`;
    const matches = (text: string) =>
      names.has(text) ||
      text.startsWith(capability) ||
      pathSegments(text).some((s) => names.has(s));
    const tenants = new Set([
      tenant,
      ...(await definitions.capabilities()).map((c) => c.service.tenant),
    ]);
    const services: string[] = [];
    let otherOrganisations = 0;
    let internalServices = 0;
    for (const other of tenants)
      for (const entry of await definitions.list(other)) {
        if (entry.kind !== 'Service' || (other === tenant && entry.id === service)) continue;
        const found = await definitions.get('Service', other, entry.id);
        const spec = (found?.definition as ServiceDefinition | undefined)?.spec;
        if (!spec || !mentions(spec, matches)) continue;
        if ((await lifecycleOf(deps.configEntries, other, entry.id)).state === 'archived') continue;
        if (hides && isInternalService(found?.definition)) internalServices++;
        else if (other !== tenant) otherOrganisations++;
        else services.push(entry.id);
      }
    return {
      ...(address ? { address } : {}),
      frontends,
      apiKeys,
      services,
      otherOrganisations,
      internalServices,
    };
  });
};

const inUseErrors = (d: ServiceDependents) => [
  ...d.frontends.map(({ id, name }) => ({
    path: 'frontends',
    id,
    message: t('problems.serviceUsedByFrontend', { name }),
  })),
  ...d.apiKeys.map(({ id, name }) => ({
    path: 'apiKeys',
    id,
    message: t('problems.serviceUsedByKey', { name }),
  })),
  ...d.services.map((service) => ({
    path: 'services',
    id: service,
    message: t('problems.serviceUsedByService', { service }),
  })),
  ...(d.otherOrganisations > 0
    ? [
        {
          path: 'services',
          message: t('problems.serviceUsedByOthers', { count: d.otherOrganisations }),
        },
      ]
    : []),
  ...(d.internalServices > 0
    ? [
        {
          path: 'services',
          message: t('problems.serviceUsedByInternal', { count: d.internalServices }),
        },
      ]
    : []),
];

const perServiceKinds = [
  serviceLifecycleKind,
  serviceDraftKind,
  serviceEnvironmentsKind,
  serviceAccessKind,
];

const forget = async (
  entries: ConfigEntryStore,
  kind: string,
  scope: string,
  id: string,
  by: string,
  reason: string,
) => {
  const latest = (await entries.history(kind, scope, id)).at(-1);
  if (!latest || latest.deleted) return;
  await appendVersion(entries, { kind, scope, id, spec: latest.spec, deleted: true, by, reason });
};

type Refusal = { path: string; message: string; id?: string };

const failed = (
  target: string,
  path: string,
  message: string,
  type?: string,
  errors?: Refusal[],
): AdminOutcome => ({
  ok: false,
  errors: errors ?? [{ path, message }],
  target,
  ...(type ? { type } : {}),
});

const forTenant = (principal: Principal, tenant: string) =>
  principal.tenant === tenant && (principal.kind !== 'operator' || principal.actor !== undefined);

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: Refusal[] = [],
  type = 'about:blank',
) =>
  c.json({ type, title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const createServiceDeleteModule =
  (input: ServiceDeleteDeps): PlatformModuleFactory =>
  (deps) => {
    const entries = deps.configEntries;
    const writes = serialized();
    const now = input.now ?? Date.now;

    const handlers: Record<string, AdminHandler> = {
      [serviceDeleteAction]: (data, principal) =>
        writes(async () => {
          const { tenant, reason } = data;
          const id = String(data.id ?? '');
          const target = `service:${tenant}/${id}`;
          if (!forTenant(principal, tenant))
            return failed(target, 'principal', 'only the tenant deletes its services');
          const versions = await deps.definitions.versions('Service', tenant, id);
          if (versions.length === 0) return failed(target, 'id', `no service ${id}`);
          if ((await lifecycleOf(entries, tenant, id)).state !== 'archived')
            return failed(
              target,
              'lifecycle',
              t('services.archiveBeforeDelete'),
              serviceNotArchivedType,
            );
          const dependents = await dependentsOf({ ...deps, ...input }, tenant, id);
          const refusals = inUseErrors(dependents);
          if (refusals.length > 0) return failed(target, 'usedBy', '', serviceInUseType, refusals);
          const flows = await flowsOnlyUsedBy(deps, tenant, id);
          const by = actorOf(principal.actor ?? principal);
          const { address } = dependents;
          if (address && !(await input.removeClient(principal, tenant, address.client, reason)))
            return failed(target, 'address', t('problems.serviceAddressNotRemoved'));
          if (isInternalService(versions.at(-1)?.definition))
            await appendVersion(entries, {
              kind: deletedInternalServiceKind,
              scope: tenant,
              id,
              spec: {},
              deleted: false,
              by,
              reason,
              at: new Date(now()).toISOString(),
            });
          await deps.definitions.remove(tenant, [
            { kind: 'Service', id },
            ...flows.map((flow) => ({ kind: 'StepFlow' as const, id: flow })),
          ]);
          for (const kind of perServiceKinds) await forget(entries, kind, tenant, id, by, reason);
          for (const flow of flows)
            await forget(entries, stepFlowArchiveKind, tenant, flow, by, reason);
          return {
            ok: true,
            value: {
              id,
              deleted: true,
              versions: versions.length,
              stepFlows: flows,
              ...(address ? { address } : {}),
            },
            target,
            audit: { versions: versions.length, stepFlows: flows, ...(address ? { address } : {}) },
          } as AdminOutcome;
        }),
    };

    return {
      id: 'service-delete',
      handlers,
      mount: (app, mounted) => {
        app.delete('/tenants/:tenant/services/:id', async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Unauthorized');
          const tenant = c.req.param('tenant') ?? '';
          const entered = enterTenant(c, mounted.access, principal, tenant, 'manage-services');
          if ('response' in entered) return entered.response;
          const reason = changeReasonOf(c)?.trim() ?? '';
          if (!isReasonLongEnough(reason))
            return problem(c, 400, 'Invalid request', [
              { path: 'change-reason', message: reasonTooShort },
            ]);
          const id = c.req.param('id') ?? '';
          const result = await mounted.admin.perform(entered.principal, serviceDeleteAction, {
            tenant,
            id,
            reason,
          });
          c.header('genai-task', result.task);
          if (!result.ok) {
            if (result.problem) return rightRefused(c, result.problem);
            if (result.type === serviceNotArchivedType)
              return problem(
                c,
                409,
                t('problems.serviceNotArchivedTitle'),
                result.errors,
                serviceNotArchivedType,
              );
            if (result.type === serviceInUseType)
              return problem(
                c,
                409,
                t('problems.serviceInUseTitle'),
                result.errors,
                serviceInUseType,
              );
            const paths = new Set(result.errors.map((e) => e.path));
            if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
            if (paths.has('id')) return problem(c, 404, 'Not found', result.errors);
            return problem(c, 400, 'Invalid request', result.errors);
          }
          return c.json(result.value);
        });
      },
    };
  };
