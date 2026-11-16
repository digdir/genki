import { AsyncLocalStorage } from 'node:async_hooks';
import type { Principal, Task } from '@genai/contracts';
import { isInternalService, type DefinitionStore, type ValidationError } from '@genai/definitions';
import type { TestSet, TestSetStore } from '@genai/eval';
import { ALL_GRANT, boundService, SERVICE_GRANT, seesInternalServices } from '@genai/identity';
import type { MiddlewareHandler } from 'hono';
import { routeOf } from './change-reason.js';
import { originOf, serviceOrigin } from './draft-runner.js';
import { t } from './i18n/index.js';

interface Viewer {
  hides: boolean;
  signedIn: boolean;
  internal: Map<string, Promise<boolean>>;
}

const viewer = new AsyncLocalStorage<Viewer>();

export const hidesInternalServices = () => viewer.getStore()?.hides ?? false;

export const hidingInternalServicesFrom = <T>(principal: Principal | undefined, work: () => T): T =>
  viewer.run(
    {
      hides: !(principal && seesInternalServices(principal)),
      signedIn: principal !== undefined,
      internal: new Map(),
    },
    work,
  );

export const internalServiceViewer =
  (caller: (request: Request) => Promise<Principal | undefined>): MiddlewareHandler =>
  async (c, next) => {
    const principal = await caller(c.req.raw);
    await hidingInternalServicesFrom(principal, next);
  };

export type DraftDefinition = (tenant: string, id: string) => Promise<unknown>;

const internalChecks = new WeakMap<
  DefinitionStore,
  (tenant: string, id: string) => Promise<boolean>
>();

const remembered = (key: string, check: () => Promise<boolean>) => {
  const seen = viewer.getStore()?.internal;
  if (!seen) return check();
  const known = seen.get(key) ?? check();
  seen.set(key, known);
  return known;
};

export const isHiddenService = async (store: DefinitionStore, tenant: string, id: string) =>
  hidesInternalServices() && ((await internalChecks.get(store)?.(tenant, id)) ?? false);

export const isHiddenTask = async (store: DefinitionStore, task: Task) => {
  if (!hidesInternalServices()) return false;
  const capability = task.service.capability.id;
  if (originOf(capability) !== serviceOrigin) return false;
  const [tenant, id] = capability.split('/');
  return tenant !== undefined && id !== undefined && isHiddenService(store, tenant, id);
};

export const hidingInternalTasks =
  (store: DefinitionStore, lookup: (id: string) => Promise<Task | undefined>) =>
  async (id: string) => {
    const found = await lookup(id);
    return found && (await isHiddenTask(store, found)) ? undefined : found;
  };

const serviceTarget = (target: string, tenant: string) => {
  const published = /^Service:([^@]+)@\d+$/.exec(target);
  if (published?.[1]) return { tenant, id: published[1] };
  const risk = /^service:([^/]+)\/risk$/.exec(target);
  if (risk?.[1]) return { tenant, id: risk[1] };
  const scoped = /^service:([^/]+)\/([^/]+)$/.exec(target);
  if (scoped?.[1] && scoped[2]) return { tenant: scoped[1], id: scoped[2] };
  const draft = /^service-draft:(.+)$/.exec(target);
  if (draft?.[1]) return { tenant, id: draft[1] };
  return undefined;
};

export const isHiddenAuditTarget = async (
  store: DefinitionStore,
  tenant: string,
  target: string,
) => {
  const service = serviceTarget(target, tenant);
  return service !== undefined && isHiddenService(store, service.tenant, service.id);
};

export const shownKeys = async <K extends { agents: string[]; service?: string }>(
  store: DefinitionStore,
  tenant: string,
  keys: K[],
): Promise<K[]> => {
  if (!hidesInternalServices()) return keys;
  const hidden = (id: string) => isHiddenService(store, tenant, id);
  const shown: (K | undefined)[] = await Promise.all(
    keys.map(async (key): Promise<K | undefined> => {
      const bound = boundService(key);
      if (bound !== undefined && (await hidden(bound))) return undefined;
      const refused = await Promise.all(
        key.agents.map((a) => (a === ALL_GRANT || a.startsWith(SERVICE_GRANT) ? false : hidden(a))),
      );
      const agents = key.agents.filter((_, i) => !refused[i]);
      if (key.agents.length > 0 && agents.length === 0) return undefined;
      return agents.length === key.agents.length ? key : { ...key, agents };
    }),
  );
  return shown.flatMap((k) => (k === undefined ? [] : [k]));
};

export const hidingInternalTestSets = (
  sets: TestSetStore,
  hidden: (tenant: string, service: string) => Promise<boolean>,
): TestSetStore => {
  const hides = async (set: TestSet | undefined) =>
    set?.spec.service !== undefined && (await hidden(set.metadata.tenant, set.spec.service));
  return {
    put: (set) => sets.put(set),
    get: async (tenant, id, version) => {
      const found = await sets.get(tenant, id, version);
      return (await hides(found)) ? undefined : found;
    },
    list: async (tenant, service) => {
      const all = await sets.list(tenant, service);
      const refused = await Promise.all(all.map(hides));
      return all.filter((_, i) => !refused[i]);
    },
  };
};

const takenName = / is used by Service:([^/\s]+)\/(\S+)$/;

export const publishRefusals = async (
  store: DefinitionStore,
  input: unknown,
): Promise<ValidationError[]> => {
  if (!hidesInternalServices()) return [];
  if (isInternalService(input))
    return [{ path: 'spec.visibility', message: t('problems.internalOperatorOnly') }];
  const definition = input as { kind?: unknown; metadata?: { tenant?: unknown; id?: unknown } };
  const { tenant, id } = definition?.metadata ?? {};
  if (
    definition?.kind === 'Service' &&
    typeof tenant === 'string' &&
    typeof id === 'string' &&
    (await isHiddenService(store, tenant, id))
  )
    return [{ path: 'metadata.id', message: t('problems.serviceIdTaken') }];
  return [];
};

const wrapped = new WeakSet<DefinitionStore>();

export const hidingInternalServices = (
  store: DefinitionStore,
  options: { draftDefinition?: DraftDefinition } = {},
): DefinitionStore => {
  if (wrapped.has(store)) return store;
  const internal = (tenant: string, id: string) =>
    remembered(`${tenant}/${id}`, async () => {
      const published = await store.get('Service', tenant, id);
      if (published) return isInternalService(published.definition);
      return isInternalService(await options.draftDefinition?.(tenant, id));
    });
  const hidden = async (tenant: string, id: string) =>
    hidesInternalServices() && (await internal(tenant, id));
  const neutralNames = async (errors: ValidationError[]) =>
    Promise.all(
      errors.map(async (e) => {
        const owner = takenName.exec(e.message);
        return owner?.[1] && owner[2] && (await hidden(owner[1], owner[2]))
          ? { ...e, message: e.message.replace(takenName, ' is already taken') }
          : e;
      }),
    );
  const view: DefinitionStore = {
    get: async (kind, tenant, id, version) =>
      kind === 'Service' && (await hidden(tenant, id))
        ? undefined
        : store.get(kind, tenant, id, version),
    versions: async (kind, tenant, id) =>
      kind === 'Service' && (await hidden(tenant, id)) ? [] : store.versions(kind, tenant, id),
    list: async (tenant) => {
      const entries = await store.list(tenant);
      if (!hidesInternalServices()) return entries;
      const shown = await Promise.all(
        entries.map(async (e) => e.kind !== 'Service' || !(await hidden(tenant, e.id))),
      );
      return entries.filter((_, i) => shown[i]);
    },
    resolve: async (name, version) => {
      const found = await store.resolve(name, version);
      return found?.internal && hidesInternalServices() ? undefined : found;
    },
    capabilities: async (onInvalid) => {
      const all = await store.capabilities(onInvalid);
      return hidesInternalServices() ? all.filter((c) => !c.internal) : all;
    },
    publish: async (input, actor, reason, files) => {
      const refused = await publishRefusals(view, input);
      if (refused.length > 0) return { ok: false, errors: refused };
      const result = await store.publish(input, actor, reason, files);
      return result.ok || !hidesInternalServices()
        ? result
        : { ok: false, errors: await neutralNames(result.errors) };
    },
  };
  wrapped.add(view);
  internalChecks.set(view, internal);
  return view;
};

const servicePath = /^\/tenants\/([^/]+)\/services\/([^/]+)(?:\/|$)/;

const serviceInPath = (path: string) => {
  const match = servicePath.exec(path);
  if (!match?.[1] || !match[2]) return undefined;
  try {
    return { tenant: decodeURIComponent(match[1]), id: decodeURIComponent(match[2]) };
  } catch {
    return undefined;
  }
};

export const refuseHiddenServices =
  (store: DefinitionStore): MiddlewareHandler =>
  async (c, next) => {
    const target = serviceInPath(c.req.path);
    if (
      viewer.getStore()?.signedIn &&
      target &&
      (await isHiddenService(store, target.tenant, target.id))
    )
      return c.json(
        {
          type: 'about:blank',
          title: 'Not found',
          status: 404,
          ...(routeOf(c) ? { errors: [] } : {}),
        },
        404,
        { 'content-type': 'application/problem+json' },
      );
    return next();
  };
