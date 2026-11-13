import type { Principal } from '@genai/contracts';
import type { DefinitionStore } from '@genai/definitions';
import { environmentNamePattern, type ClientStore } from '@genai/identity';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { appendVersion, serialized, type ConfigEntryStore } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { rightRefused, type Right } from './rights.js';

export const serviceEnvironmentsKind = 'service-environments';
export const productionEnvironment = 'prod';
export const environmentHeader = 'genai-environment';
export const maxEnvironments = 5;

export interface EnvironmentPointer {
  version?: number;
  previousVersion?: number;
}

export type EnvironmentPointers = Record<string, EnvironmentPointer>;

export interface EnvironmentView {
  name: string;
  version: number | null;
  followsPublishes: boolean;
  previousVersion: number | null;
}

export type EnvironmentChoice =
  | { ok: true; name?: string; version?: number }
  | {
      ok: false;
      code: 'invalid_environment' | 'environment_not_authorized' | 'environment_not_found';
      message: string;
    };

export const isEnvironmentName = (value: unknown): value is string =>
  typeof value === 'string' && environmentNamePattern.test(value);

const unconfigured = (): EnvironmentPointers => ({ [productionEnvironment]: {} });

export const pointerOf = (pointers: EnvironmentPointers, name: unknown) =>
  isEnvironmentName(name) && Object.hasOwn(pointers, name) ? pointers[name] : undefined;

export const environmentsOf = async (
  store: ConfigEntryStore,
  tenant: string,
  service: string,
): Promise<EnvironmentPointers> => {
  const latest = (await store.history(serviceEnvironmentsKind, tenant, service)).at(-1);
  const saved = (latest?.spec as { environments?: unknown } | undefined)?.environments;
  if (!latest || latest.deleted || typeof saved !== 'object' || saved === null)
    return unconfigured();
  return {
    ...unconfigured(),
    ...Object.fromEntries(
      Object.entries(structuredClone(saved) as EnvironmentPointers).filter(([name]) =>
        isEnvironmentName(name),
      ),
    ),
  };
};

export const productionVersion = async (store: ConfigEntryStore, tenant: string, service: string) =>
  pointerOf(await environmentsOf(store, tenant, service), productionEnvironment)?.version;

export const allowedEnvironments = async (
  principal: Principal,
  clients: ClientStore,
): Promise<string[] | undefined> => {
  const confined = principal.confinedTo;
  if (!confined) return undefined;
  const own = confined.environments?.length ? confined.environments : undefined;
  const client = confined.client ? await clients.get(confined.tenant, confined.client) : undefined;
  const named = client?.definition.spec.environments?.length
    ? client.definition.spec.environments
    : undefined;
  if (own && named) return own.filter((e) => named.includes(e));
  return own ?? named;
};

export const chooseEnvironment = async (
  store: ConfigEntryStore,
  service: { tenant: string; id: string },
  requested: string | undefined,
  allowed?: string[],
  pin?: { version: number; latest: number },
): Promise<EnvironmentChoice> => {
  const asked = requested?.trim() || undefined;
  if (asked !== undefined && !isEnvironmentName(asked))
    return { ok: false, code: 'invalid_environment', message: t('services.environmentInvalid') };
  const name =
    asked ??
    (!allowed || allowed.includes(productionEnvironment)
      ? productionEnvironment
      : (allowed[0] ?? productionEnvironment));
  if (allowed && !allowed.includes(name))
    return {
      ok: false,
      code: 'environment_not_authorized',
      message: t('services.environmentNotAllowed', { environment: name }),
    };
  const pointers = await environmentsOf(store, service.tenant, service.id);
  const pointer = pointerOf(pointers, name);
  if (!pointer)
    return {
      ok: false,
      code: 'environment_not_found',
      message: t('services.environmentMissing', { service: service.id, environment: name }),
    };
  if (!pin)
    return {
      ok: true,
      name,
      ...(pointer.version === undefined ? {} : { version: pointer.version }),
    };
  const runs = (environment: string) =>
    (pointerOf(pointers, environment)?.version ?? pin.latest) === pin.version;
  const candidates = [name, productionEnvironment, ...Object.keys(pointers)].filter(
    (e) => pointerOf(pointers, e) && (!allowed || allowed.includes(e)),
  );
  const ran = candidates.find(runs);
  if (allowed && !ran)
    return {
      ok: false,
      code: 'environment_not_authorized',
      message: t('services.environmentPinNotAllowed', { version: pin.version }),
    };
  return { ok: true, ...(ran ? { name: ran } : {}) };
};

export const environmentViews = (
  pointers: EnvironmentPointers,
  latestVersion: number | undefined,
): EnvironmentView[] =>
  Object.entries(pointers)
    .sort(([a], [b]) =>
      a === productionEnvironment ? -1 : b === productionEnvironment ? 1 : a.localeCompare(b),
    )
    .map(([name, pointer]) => ({
      name,
      version: pointer.version ?? latestVersion ?? null,
      followsPublishes: pointer.version === undefined,
      previousVersion: pointer.previousVersion ?? null,
    }));

const failed = (
  target: string,
  path: string,
  message: string,
  conflict?: boolean,
): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
  ...(conflict ? { conflict: true as const } : {}),
});

const forTenant = (principal: Principal, tenant: string) =>
  principal.tenant === tenant && (principal.kind !== 'operator' || principal.actor !== undefined);

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404 | 409,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const latestVersionOf = async (definitions: DefinitionStore, tenant: string, service: string) =>
  (await definitions.get('Service', tenant, service))?.version;

const publishedVersion = async (
  definitions: DefinitionStore,
  tenant: string,
  service: string,
  version: number,
) => (await definitions.get('Service', tenant, service, version))?.version === version;

export const serviceEnvironmentsModule: PlatformModuleFactory = (deps) => {
  const entries = deps.configEntries;
  const writes = serialized();

  const change = (
    action: (input: {
      tenant: string;
      id: string;
      target: string;
      latest: number;
      before: EnvironmentPointers;
      input: Record<string, unknown>;
    }) => Promise<EnvironmentPointers | AdminOutcome>,
  ): AdminHandler => {
    return (input, principal) =>
      writes(async () => {
        const { tenant, reason } = input;
        const id = String(input.id ?? '');
        const target = `service:${tenant}/${id}`;
        if (!forTenant(principal, tenant))
          return failed(target, 'principal', t('catalogErrors.onlyTenantChangesEnvironments'));
        const latest = await latestVersionOf(deps.definitions, tenant, id);
        if (latest === undefined)
          return failed(target, 'id', t('services.environmentNotPublished'));
        const before = await environmentsOf(entries, tenant, id);
        const after = await action({ tenant, id, target, latest, before, input });
        if ('ok' in after) return after as AdminOutcome;
        const onlyProd =
          Object.keys(after).length === 1 &&
          pointerOf(after, productionEnvironment)?.version === undefined;
        await appendVersion(entries, {
          kind: serviceEnvironmentsKind,
          scope: tenant,
          id,
          spec: { environments: after },
          deleted: onlyProd,
          by: actorOf(principal.actor ?? principal),
          reason,
        });
        return {
          ok: true,
          value: { environments: environmentViews(after, latest), latestVersion: latest },
          target,
          audit: { before: { environments: before }, after: { environments: after } },
        } as AdminOutcome;
      });
  };

  const handlers: Record<string, AdminHandler> = {
    'platform.service.environments.add': change(async ({ target, latest, before, input }) => {
      const name = input.environment;
      if (name === productionEnvironment)
        return failed(target, 'name', t('services.environmentProdFixed'));
      if (!isEnvironmentName(name)) return failed(target, 'name', t('services.environmentName'));
      if (pointerOf(before, name))
        return failed(
          target,
          'state',
          t('services.environmentExists', { environment: name }),
          true,
        );
      if (Object.keys(before).length >= maxEnvironments)
        return failed(target, 'name', t('services.environmentTooMany', { max: maxEnvironments }));
      const prod = pointerOf(before, productionEnvironment) ?? {};
      return {
        ...before,
        [productionEnvironment]: prod.version === undefined ? { version: latest } : prod,
        [name]: {},
      };
    }),
    'platform.service.environments.remove': change(async ({ target, latest, before, input }) => {
      const name = String(input.environment ?? '');
      if (name === productionEnvironment)
        return failed(target, 'name', t('services.environmentProdFixed'));
      if (!isEnvironmentName(name)) return failed(target, 'name', t('services.environmentName'));
      if (!pointerOf(before, name))
        return failed(
          target,
          'environment',
          t('services.environmentMissing', { service: String(input.id), environment: name }),
        );
      const after = Object.fromEntries(Object.entries(before).filter(([key]) => key !== name));
      const prodVersion = pointerOf(after, productionEnvironment)?.version;
      if (Object.keys(after).length > 1) return after;
      if (prodVersion !== undefined && prodVersion !== latest)
        return failed(
          target,
          'state',
          t('services.environmentProdBehind', { version: prodVersion }),
          true,
        );
      return { [productionEnvironment]: {} };
    }),
    'platform.service.environments.promote': change(async ({ target, latest, before, input }) => {
      const name = String(input.environment ?? '');
      const from = input.from === undefined ? 'test' : String(input.from);
      if (!isEnvironmentName(name)) return failed(target, 'name', t('services.environmentName'));
      if (!isEnvironmentName(from)) return failed(target, 'name', t('services.environmentName'));
      if (Object.keys(before).length === 1)
        return failed(target, 'state', t('services.environmentOnlyProd'), true);
      if (!pointerOf(before, name))
        return failed(
          target,
          'environment',
          t('services.environmentMissing', { service: String(input.id), environment: name }),
        );
      if (from === name) return failed(target, 'from', t('services.environmentSame'));
      const source = pointerOf(before, from);
      if (!source)
        return failed(
          target,
          'from',
          t('services.environmentMissing', { service: String(input.id), environment: from }),
        );
      const current = pointerOf(before, name)?.version ?? latest;
      const version = source.version ?? latest;
      return { ...before, [name]: { version, previousVersion: current } };
    }),
    'platform.service.environments.rollback': change(
      async ({ tenant, id, target, latest, before, input }) => {
        const name = String(input.environment ?? '');
        if (!isEnvironmentName(name)) return failed(target, 'name', t('services.environmentName'));
        if (Object.keys(before).length === 1)
          return failed(target, 'state', t('services.environmentOnlyProd'), true);
        const pointer = pointerOf(before, name);
        if (!pointer)
          return failed(
            target,
            'environment',
            t('services.environmentMissing', { service: id, environment: name }),
          );
        const asked = input.version;
        if (asked !== undefined && !(typeof asked === 'number' && Number.isInteger(asked)))
          return failed(target, 'version', t('services.environmentNoVersion', { version: '?' }));
        const version = asked ?? pointer.previousVersion;
        if (version === undefined)
          return failed(
            target,
            'version',
            t('services.environmentNoEarlier', { environment: name }),
          );
        if (!(await publishedVersion(deps.definitions, tenant, id, version)))
          return failed(target, 'version', t('services.environmentNoVersion', { version }));
        return {
          ...before,
          [name]: { version, previousVersion: pointer.version ?? latest },
        };
      },
    ),
  };

  return {
    id: 'service-environments',
    handlers,
    mount: (app, mounted) => {
      const entered = async (c: Context, right: Right) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        const tenant = c.req.param('tenant') ?? '';
        const result = enterTenant(c, mounted.access, principal, tenant, right);
        return 'response' in result ? result : { principal: result.principal, tenant };
      };

      const perform = async (
        c: Context,
        action: string,
        data: Record<string, unknown>,
        created = false,
      ) => {
        const guard = await entered(c, 'manage-services');
        if ('response' in guard) return guard.response;
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const result = await mounted.admin.perform(guard.principal, action, {
          tenant: guard.tenant,
          id: c.req.param('id') ?? '',
          ...data,
          reason,
        });
        c.header('genai-task', result.task);
        if (!result.ok) {
          if (result.problem) return rightRefused(c, result.problem);
          const paths = new Set(result.errors.map((e) => e.path));
          if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
          if (paths.has('id') || paths.has('environment') || paths.has('from'))
            return problem(c, 404, 'Not found', result.errors);
          if (paths.has('state')) return problem(c, 409, 'Conflict', result.errors);
          return problem(c, 400, 'Invalid request', result.errors);
        }
        return c.json(result.value as Record<string, unknown>, created ? 201 : 200);
      };

      const body = async (c: Context) =>
        (await c.req.json().catch(() => ({}))) as Record<string, unknown>;

      app.get('/tenants/:tenant/services/:id/environments', async (c) => {
        const guard = await entered(c, 'use-services');
        if ('response' in guard) return guard.response;
        const id = c.req.param('id') ?? '';
        const latest = await latestVersionOf(deps.definitions, guard.tenant, id);
        if (latest === undefined) return problem(c, 404, 'Not found');
        return c.json({
          environments: environmentViews(await environmentsOf(entries, guard.tenant, id), latest),
          latestVersion: latest,
        });
      });

      app.post('/tenants/:tenant/services/:id/environments', async (c) =>
        perform(
          c,
          'platform.service.environments.add',
          { environment: (await body(c)).name },
          true,
        ),
      );

      app.delete('/tenants/:tenant/services/:id/environments/:environment', async (c) =>
        perform(c, 'platform.service.environments.remove', {
          environment: c.req.param('environment') ?? '',
        }),
      );

      app.post('/tenants/:tenant/services/:id/environments/:environment/promote', async (c) => {
        const from = (await body(c)).from;
        return perform(c, 'platform.service.environments.promote', {
          environment: c.req.param('environment') ?? '',
          ...(from === undefined ? {} : { from }),
        });
      });

      app.post('/tenants/:tenant/services/:id/environments/:environment/rollback', async (c) => {
        const version = (await body(c)).version;
        return perform(c, 'platform.service.environments.rollback', {
          environment: c.req.param('environment') ?? '',
          ...(version === undefined ? {} : { version }),
        });
      });
    },
  };
};
