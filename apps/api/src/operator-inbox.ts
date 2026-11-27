import type { Principal } from '@genai/contracts';
import type { Context, Env, Hono, Schema } from 'hono';
import { actorNames } from './actor-names.js';
import { problem } from './http.js';
import type { MountDeps, PlatformModule, PlatformModuleFactory } from './platform-modules.js';

export const inboxTypes = [
  'quota',
  'access',
  'catalogue',
  'work-instruction',
  'suggestion',
  'incident',
  'expiring',
] as const;
export type InboxType = (typeof inboxTypes)[number];

export interface InboxItem {
  type: InboxType;
  id: string;
  tenant: string | null;
  tenants?: string[];
  what: string;
  from: string | null;
  waitingSince: string;
  due?: string;
  blocks: boolean;
  action: { method: 'GET' | 'POST' | 'PUT' | 'DELETE'; path: string };
  detail?: Record<string, unknown>;
}

export const quotaBlocksPercent = 90;

export const nearQuotaLimit = (quota: { usedTokens: number; monthlyTokens: number }) =>
  quota.usedTokens * 100 >= quotaBlocksPercent * quota.monthlyTokens;

const order = (a: InboxItem, b: InboxItem) =>
  (a.due === undefined ? 0 : 1) - (b.due === undefined ? 0 : 1) ||
  (a.due ?? a.waitingSince).localeCompare(b.due ?? b.waitingSince) ||
  a.id.localeCompare(b.id);

export const collectInbox = async (modules: readonly PlatformModule[], viewer: Principal) =>
  (await Promise.allSettled(modules.map((m) => m.inbox?.(viewer) ?? Promise.resolve([]))))
    .flatMap((r) => (r.status === 'fulfilled' ? r.value : []))
    .sort(order);

export const concerns = (item: InboxItem, tenant: string) =>
  item.tenant === tenant ||
  (item.tenants !== undefined && (item.tenants.length === 0 || item.tenants.includes(tenant)));

export interface TenantWaiting {
  count: number;
  blocks: boolean;
  types: InboxType[];
}

export const waitingByTenant = (items: readonly InboxItem[], tenants: readonly string[]) => {
  const out = new Map<string, TenantWaiting>();
  for (const tenant of tenants)
    for (const item of items) {
      if (!concerns(item, tenant)) continue;
      const known = out.get(tenant) ?? { count: 0, blocks: false, types: [] };
      out.set(tenant, {
        count: known.count + 1,
        blocks: known.blocks || item.blocks,
        types: known.types.includes(item.type) ? known.types : [...known.types, item.type],
      });
    }
  return out;
};

const looksLikeActor = (value: string) => /^(employee|operator|platform|api-key):/.test(value);

export const operatorInboxModule: PlatformModuleFactory = (deps) => ({
  id: 'operator-inbox',
  mount: <E extends Env, S extends Schema, B extends string>(
    app: Hono<E, S, B>,
    mounted: MountDeps,
  ) => {
    const names = actorNames(deps.configEntries);
    app.get('/operator/inbox', async (c: Context) => {
      const principal = await mounted.authenticate(c.req.raw);
      if (!principal) return problem(c, 401, 'Not authenticated');
      if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
      const type = c.req.query('type');
      if (type !== undefined && !(inboxTypes as readonly string[]).includes(type))
        return problem(c, 400, 'Invalid request', {
          errors: [{ path: 'type', message: `type is one of ${inboxTypes.join(', ')}` }],
        });
      const tenant = c.req.query('tenant');
      const items = (await (deps.inbox?.(principal) ?? Promise.resolve([]))).filter(
        (i) => (!type || i.type === type) && (!tenant || concerns(i, tenant)),
      );
      const [tenantNames, people] = await Promise.all([
        mounted.admin.tenantNames(),
        names.namesOf([
          ...new Set(items.flatMap((i) => (i.from && looksLikeActor(i.from) ? [i.from] : []))),
        ]),
      ]);
      return c.json({
        data: items.map((i) => ({
          ...i,
          ...(i.tenant ? { tenantName: tenantNames.get(i.tenant) ?? i.tenant } : {}),
          from: (i.from && people.get(i.from)) ?? i.from,
        })),
      });
    });
  },
});
