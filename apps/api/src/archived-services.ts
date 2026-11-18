import type { Context, MiddlewareHandler } from 'hono';
import type { Principal } from '@genai/contracts';
import type { DefinitionStore, ValidationError } from '@genai/definitions';
import type { Access } from './access.js';
import { t } from './i18n/index.js';

export const serviceArchivedType = 'urn:genai:problem:service-archived';

export type LifecycleOf = (tenant: string, service: string) => Promise<{ state: string }>;

export const isArchived = async (lifecycle: LifecycleOf | undefined, tenant: string, id: string) =>
  (await lifecycle?.(tenant, id).catch(() => undefined))?.state === 'archived';

export const serviceArchived = (c: Context, errors?: ValidationError[]) =>
  c.json(
    {
      type: serviceArchivedType,
      title: t('problems.serviceArchivedTitle'),
      status: 409,
      detail: t('services.archivedReadOnly'),
      ...(errors ? { errors } : {}),
    },
    409,
    { 'content-type': 'application/problem+json' },
  );

const servicePath = /^\/tenants\/([^/]+)\/services\/([^/]+)(\/[^?]*)?$/;
const stillOpen = /^\/(lifecycle|batch-runs)(\/|$)/;
const reads = new Set(['GET', 'HEAD', 'OPTIONS']);

const decoded = (raw: string) => {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
};

/** Refuses every change to an archived service; restoring it through /lifecycle stays open. */
export const refuseWritesToArchived =
  (
    caller: (request: Request) => Promise<Principal | undefined>,
    access: Access,
    lifecycle: LifecycleOf,
  ): MiddlewareHandler =>
  async (c, next) => {
    if (reads.has(c.req.method)) return next();
    const match = servicePath.exec(c.req.path);
    if (!match || stillOpen.test(match[3] ?? '')) return next();
    const tenant = decoded(match[1] as string);
    const service = decoded(match[2] as string);
    const principal = await caller(c.req.raw).catch(() => undefined);
    if (!principal || !access(principal, tenant, c.req.raw)) return next();
    if (await isArchived(lifecycle, tenant, service)) return serviceArchived(c);
    return next();
  };

export const archivedPath = 'lifecycle';

export const refusedAsArchived = (errors: ValidationError[]) =>
  errors.some((e) => e.path === archivedPath || e.path.endsWith(`.${archivedPath}`));

const serviceOf = (input: unknown) => {
  const d = input as { kind?: unknown; metadata?: { tenant?: unknown; id?: unknown } } | null;
  const tenant = d?.metadata?.tenant;
  const id = d?.metadata?.id;
  return d?.kind === 'Service' && typeof tenant === 'string' && typeof id === 'string'
    ? { tenant, id }
    : undefined;
};

export const archivedPublishRefusal = async (input: unknown, lifecycle: LifecycleOf) => {
  const service = serviceOf(input);
  if (!service || !(await isArchived(lifecycle, service.tenant, service.id))) return undefined;
  const errors: ValidationError[] = [
    { path: archivedPath, message: t('services.archivedReadOnly') },
  ];
  return { ok: false as const, errors };
};

/** Every publish through this store, from any route or import, refuses an archived service. */
export const refusingArchivedPublishes = <S extends Pick<DefinitionStore, 'publish'>>(
  store: S,
  lifecycle: LifecycleOf,
): S =>
  new Proxy(store, {
    get: (target, key) => {
      if (key === 'publish')
        return (async (input, ...rest) =>
          (await archivedPublishRefusal(input, lifecycle)) ??
          target.publish(input, ...rest)) satisfies DefinitionStore['publish'];
      const value = Reflect.get(target, key, target) as unknown;
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
