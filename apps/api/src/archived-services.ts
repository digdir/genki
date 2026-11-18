import type { Context, MiddlewareHandler } from 'hono';
import type { Principal } from '@genai/contracts';
import type { Access } from './access.js';
import { t } from './i18n/index.js';

export const serviceArchivedType = 'urn:genai:problem:service-archived';

export type LifecycleOf = (tenant: string, service: string) => Promise<{ state: string }>;

export const isArchived = async (lifecycle: LifecycleOf | undefined, tenant: string, id: string) =>
  (await lifecycle?.(tenant, id).catch(() => undefined))?.state === 'archived';

export const serviceArchived = (c: Context) =>
  c.json(
    {
      type: serviceArchivedType,
      title: t('problems.serviceArchivedTitle'),
      status: 409,
      detail: t('services.archivedReadOnly'),
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
