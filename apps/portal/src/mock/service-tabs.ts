import type { ServiceFailures, SharedWith } from '../api/service-tabs';
import type { MockHandler } from '../mock';
import type { TaskRow } from '../types';

export interface ServiceTabsMockOptions {
  tasks?: () => TaskRow[];
  keys?: (tenant: string, service: string) => Promise<SharedWith['apiKeys']>;
  frontends?: (tenant: string, service: string) => Promise<SharedWith['frontends']>;
  tenants?: (service: string) => SharedWith['tenants'];
}

const startOfToday = () => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
};

export const failuresOf = (rows: TaskRow[], from: string): ServiceFailures[] => {
  const byService = new Map<string, Map<string, { reason: string; count: number }>>();
  for (const row of rows) {
    if (row.status !== 'failed' || row.createdAt < from) continue;
    const causes = byService.get(row.service) ?? new Map();
    const code = row.failure?.code ?? 'unknown';
    const cause = causes.get(code) ?? { reason: row.failure?.reason ?? '', count: 0 };
    cause.count += 1;
    causes.set(code, cause);
    byService.set(row.service, causes);
  }
  return [...byService].map(([service, causes]) => {
    const list = [...causes]
      .map(([code, c]) => ({ code, reason: c.reason, count: c.count }))
      .sort((a, b) => b.count - a.count);
    return { service, failed: list.reduce((n, c) => n + c.count, 0), causes: list };
  });
};

export const serviceTabsMock =
  (options: ServiceTabsMockOptions = {}): MockHandler =>
  async ({ path, url, method, json }) => {
    if (method !== 'GET') return undefined;
    if (/^\/tenants\/[^/]+\/service-failures$/.test(path)) {
      const from = url.searchParams.get('from') ?? startOfToday();
      return json({ from, data: failuresOf(options.tasks?.() ?? [], from) });
    }
    const shared = /^\/tenants\/([^/]+)\/services\/([^/]+)\/shared-with$/.exec(path);
    if (!shared) return undefined;
    const tenant = decodeURIComponent(shared[1] ?? '');
    const service = decodeURIComponent(shared[2] ?? '');
    const body: SharedWith = {
      service,
      frontends: (await options.frontends?.(tenant, service)) ?? [],
      apiKeys: (await options.keys?.(tenant, service)) ?? [],
      tenants: options.tenants?.(service) ?? [],
    };
    return json(body);
  };
