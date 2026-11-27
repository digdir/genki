import type { Principal, Task } from '@genai/contracts';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import type { AuditEntry } from '../admin.js';
import type { DirectoryEntry } from '../extensions.js';
import { osloDayEnd } from '../content-reason.js';
import { problem } from '../http.js';
import { concerns, nearQuotaLimit, type InboxItem } from '../operator-inbox.js';
import { quotaSettingKey } from '../playground.js';

export interface RunFailureView {
  code: string;
  reason: string;
  step?: string;
}

export interface OperatorTenantDeps {
  authenticate(request: Request): Promise<Principal | undefined>;
  now(): Date;
  startOfToday(): Date;
  directory?(): Promise<DirectoryEntry[]>;
  inbox?(viewer: Principal): Promise<InboxItem[]>;
  quota?(tenant: string): Promise<{ usedTokens: number; monthlyTokens: number }>;
  monthCost(
    tenant: string,
    from: Date,
    to: Date,
  ): Promise<{ costMicroNok: number | null; priced: boolean }>;
  services(tenant: string): Promise<{ total: number; inUse: number }>;
  failedSince(tenant: string, since: string): Promise<Task[]>;
  failures(tasks: string[]): Promise<Map<string, RunFailureView>>;
  serviceOf(tenant: string, task: Task): Promise<{ id: string; name: string }>;
  audit(tenant: string): Promise<AuditEntry[]>;
  namesOf(actors: string[]): Promise<Map<string, string>>;
}

const dayMs = 86_400_000;
const latestAuditEntries = 5;
const failedRunsMaxDays = 31;

const FailedRunsFrom = z.union([z.iso.date(), z.iso.datetime({ offset: true })]).optional();

const osloDayStart = (day: string) => osloDayEnd(new Date(Date.parse(`${day}T12:00:00Z`) - dayMs));

export const monthEndForecast = (usedTokens: number, now: Date) => {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const elapsedDays = Math.max((now.getTime() - start) / dayMs, 1);
  return Math.round((usedTokens * ((end - start) / dayMs)) / elapsedDays);
};

const quotaLimitItem = (
  tenant: string,
  quota: { usedTokens: number; monthlyTokens: number },
  at: Date,
): InboxItem => ({
  type: 'quota',
  id: `quota-limit:${tenant}`,
  tenant,
  what: quotaSettingKey,
  from: null,
  waitingSince: at.toISOString(),
  blocks: true,
  action: { method: 'PUT', path: `/tenants/${tenant}/settings/${quotaSettingKey}` },
  detail: { usedTokens: quota.usedTokens, currentMonthlyTokens: quota.monthlyTokens },
});

export const registerOperatorTenantRoutes = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: OperatorTenantDeps,
) => {
  const operator = async (c: Context) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, 'Not authenticated') };
    if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
    return { principal };
  };

  const tenantsOf = async () => (await deps.directory?.()) ?? [];

  app.get('/operator/tenants/:tenant', async (c) => {
    const guard = await operator(c);
    if ('response' in guard) return guard.response;
    const tenant = c.req.param('tenant') ?? '';
    const entry = (await tenantsOf()).find((d) => d.orgNumber === tenant);
    if (!entry) return problem(c, 404, 'Not found');
    const now = deps.now();
    const month = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const weekAgo = new Date(now.getTime() - 7 * dayMs).toISOString();
    const [inbox, quota, cost, services, failed, audit] = await Promise.all([
      deps.inbox?.(guard.principal) ?? Promise.resolve([]),
      deps.quota?.(tenant).catch(() => undefined),
      deps.monthCost(tenant, month, now),
      deps.services(tenant),
      deps.failedSince(tenant, weekAgo),
      deps.audit(tenant),
    ]);
    const latest = [...audit].sort((a, b) => b.at.localeCompare(a.at)).slice(0, latestAuditEntries);
    const names = await deps.namesOf([...new Set(latest.map((e) => e.actor))]);
    const usable = quota && quota.monthlyTokens > 0 ? quota : undefined;
    const waiting = inbox.filter((i) => concerns(i, tenant));
    const needsAction = [
      ...waiting,
      ...(usable && nearQuotaLimit(usable) && !waiting.some((i) => i.type === 'quota')
        ? [quotaLimitItem(tenant, usable, now)]
        : []),
    ];
    return c.json({
      orgNumber: tenant,
      name: entry.name,
      status: entry.status ?? 'active',
      needsAction,
      tokens: usable
        ? {
            usedTokens: usable.usedTokens,
            monthlyTokens: usable.monthlyTokens,
            usedPercent: Math.round((usable.usedTokens / usable.monthlyTokens) * 1000) / 10,
            forecastTokens: monthEndForecast(usable.usedTokens, now),
          }
        : null,
      cost: { from: month.toISOString(), ...cost },
      services,
      failedRunsLast7Days: failed.length,
      latestAudit: latest.map((e) => {
        const actorName = names.get(e.actor);
        return actorName ? { ...e, actorName } : e;
      }),
    });
  });

  app.get('/operator/failed-runs', async (c) => {
    const guard = await operator(c);
    if ('response' in guard) return guard.response;
    const asked = FailedRunsFrom.safeParse(c.req.query('from'));
    if (!asked.success) return problem(c, 400, 'Invalid request');
    const from = asked.data
      ? asked.data.length === 10
        ? osloDayStart(asked.data)
        : new Date(asked.data)
      : deps.startOfToday();
    if (deps.now().getTime() - from.getTime() > failedRunsMaxDays * dayMs)
      return problem(c, 400, 'Invalid request');
    const since = from.toISOString();
    const tenants = await tenantsOf();
    const found = (
      await Promise.all(
        tenants.map(async (t) =>
          (await deps.failedSince(t.orgNumber, since)).map((task) => ({ tenant: t, task })),
        ),
      )
    ).flat();
    const [failures, services] = await Promise.all([
      deps.failures(found.map((f) => f.task.id)),
      Promise.all(found.map((f) => deps.serviceOf(f.tenant.orgNumber, f.task))),
    ]);
    const data = found
      .map((f, i) => {
        const failure = failures.get(f.task.id);
        return {
          task: f.task.id,
          tenant: f.tenant.orgNumber,
          tenantName: f.tenant.name,
          service: services[i]?.id ?? null,
          serviceName: services[i]?.name ?? null,
          at: f.task.endedAt ?? f.task.createdAt,
          failure: failure
            ? {
                code: failure.code,
                reason: failure.reason,
                ...(failure.step ? { step: failure.step } : {}),
              }
            : null,
        };
      })
      .sort((a, b) => b.at.localeCompare(a.at));
    return c.json({ from: since, data });
  });
};
