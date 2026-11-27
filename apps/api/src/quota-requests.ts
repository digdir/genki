import type { Principal } from '@genai/contracts';
import type { ValidationError } from '@genai/definitions';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { appendVersion, serialized, type ConfigEntry } from './config-store.js';
import { osloDay } from './content-reason.js';
import { quotaSettingKey } from './playground.js';
import {
  actorNameOf,
  changeReasonOf,
  isReasonLongEnough,
  reasonTooShort,
  problem as sharedProblem,
} from './http.js';
import { nearQuotaLimit, type InboxItem } from './operator-inbox.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const quotaRequestPendingType = 'urn:genai:problem:quota-request-pending';
export const quotaRequestDecidedType = 'urn:genai:problem:quota-request-decided';

export const quotaRequestKind = 'quota-request';
export const quotaRequestActions = [
  'platform.quota.request',
  'platform.quota.decide',
  'platform.quota.postpone',
] as const;

export interface QuotaRequest {
  id: string;
  monthlyTokens: number;
  reason: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  state: 'pending' | 'approved' | 'rejected';
  decision?: { by: string; byName?: string; at: string; reason: string; monthlyTokens?: number };
  postponed?: { until: string; by: string; byName?: string; at: string; note?: string };
}

export const QuotaRequestBody = z.strictObject({
  monthlyTokens: z.number().int().min(1).max(10_000_000_000),
});

export const QuotaStateFilter = z.enum(['pending', 'approved', 'rejected']).optional();

export const QuotaDecisionBody = z.discriminatedUnion('decision', [
  z.strictObject({
    decision: z.literal('approved'),
    monthlyTokens: z.number().int().min(1).max(10_000_000_000).optional(),
  }),
  z.strictObject({ decision: z.literal('rejected') }),
  z.strictObject({
    decision: z.literal('postponed'),
    until: z.iso.date(),
    note: z.string().trim().min(1).max(1000).optional(),
  }),
]);

const tenantView = ({ postponed: _postponed, ...request }: QuotaRequest) => request;

type Status = 400 | 401 | 403 | 404 | 409;

const problem = (
  c: Context,
  status: Status,
  title: string,
  errors: ValidationError[] = [],
  type?: string,
) => sharedProblem(c, status, title, { errors, ...(type ? { type } : {}) });

const invalid = (c: Context, issues: z.core.$ZodIssue[]) =>
  problem(
    c,
    400,
    'Invalid request',
    issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
  );

export interface QuotaRequestsOptions {
  now?: () => Date;
  newId?: () => string;
}

const postponedUntil = (request: QuotaRequest, now: Date) =>
  request.postponed && request.postponed.until > osloDay(now) ? request.postponed.until : undefined;

export const createQuotaRequestsModule =
  (options: QuotaRequestsOptions = {}): PlatformModuleFactory =>
  (deps) => {
    const now = options.now ?? (() => new Date());
    const newId = options.newId ?? (() => crypto.randomUUID());
    const list = async (scope?: string) =>
      (await deps.configEntries.latest({ kind: quotaRequestKind, ...(scope ? { scope } : {}) }))
        .filter((e) => !e.deleted && (scope === undefined || e.scope === scope))
        .map((e) => ({ tenant: e.scope, request: e.spec as QuotaRequest }))
        .sort((a, b) => b.request.requestedAt.localeCompare(a.request.requestedAt));
    const inbox = async (): Promise<InboxItem[]> => {
      const at = now();
      const waiting = (await list()).filter(
        (r) => r.request.state === 'pending' && !postponedUntil(r.request, at),
      );
      return Promise.all(
        waiting.map(async ({ tenant, request }) => {
          const quota = await deps.quota?.(tenant).catch(() => undefined);
          return {
            type: 'quota' as const,
            id: request.id,
            tenant,
            what: quotaSettingKey,
            from: request.requestedByName ?? request.requestedBy,
            waitingSince: request.requestedAt,
            blocks: quota ? nearQuotaLimit(quota) : false,
            action: {
              method: 'POST' as const,
              path: `/operator/quota-requests/${tenant}/${request.id}/decision`,
            },
            detail: {
              monthlyTokens: request.monthlyTokens,
              ...(quota
                ? { usedTokens: quota.usedTokens, currentMonthlyTokens: quota.monthlyTokens }
                : {}),
            },
          };
        }),
      );
    };
    return {
      id: 'quota-requests',
      handlers: routeOnlyActions(quotaRequestActions),
      inbox,
      mount: <E extends Env, S extends Schema, B extends string>(
        app: Hono<E, S, B>,
        mounted: MountDeps,
      ) => {
        const writes = serialized();

        const save = (tenant: string, request: QuotaRequest, by: string, reason: string) =>
          appendVersion<QuotaRequest>(deps.configEntries, {
            kind: quotaRequestKind,
            scope: tenant,
            id: request.id,
            spec: request,
            deleted: false,
            by,
            reason,
          });

        const reasonOf = (c: Context) => {
          const reason = changeReasonOf(c)?.trim() ?? '';
          return isReasonLongEnough(reason) ? reason : undefined;
        };
        const missingReason = (c: Context) =>
          problem(c, 400, 'Invalid request', [{ path: 'change-reason', message: reasonTooShort }]);

        const audited = async <T>(
          c: Context,
          principal: Principal,
          action: (typeof quotaRequestActions)[number],
          data: { tenant: string; reason: string; [key: string]: unknown },
          work: () => Promise<{ value: T; target: string }>,
        ) => {
          try {
            const done = await mounted.admin.within(principal, action, data, work);
            c.header('genai-task', done.task);
            return { value: done.value };
          } catch (error) {
            if (error instanceof AdminRefused) return { response: refusedBy(c, error) };
            throw error;
          }
        };

        app.get('/tenants/:tenant/quota-requests', async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Not authenticated');
          const tenant = c.req.param('tenant') ?? '';
          const entered = enterTenant(c, mounted.access, principal, tenant, 'view-usage');
          if ('response' in entered) return entered.response;
          return c.json({ data: (await list(tenant)).map((r) => tenantView(r.request)) });
        });

        app.post('/tenants/:tenant/quota-requests', async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Not authenticated');
          const tenant = c.req.param('tenant') ?? '';
          const entered = enterTenant(c, mounted.access, principal, tenant, 'manage-services');
          if ('response' in entered) return entered.response;
          const reason = reasonOf(c);
          if (!reason) return missingReason(c);
          const parsed = QuotaRequestBody.safeParse(await c.req.json().catch(() => undefined));
          if (!parsed.success) return invalid(c, parsed.error.issues);
          const result = await writes(async () => {
            if ((await list(tenant)).some((r) => r.request.state === 'pending'))
              return {
                response: problem(
                  c,
                  409,
                  'Conflict',
                  [{ path: 'state', message: 'a quota request is already waiting for a decision' }],
                  quotaRequestPendingType,
                ),
              };
            const actor = entered.principal.actor ?? entered.principal;
            const name = actorNameOf(c) ?? actor.name;
            const request: QuotaRequest = {
              id: newId(),
              monthlyTokens: parsed.data.monthlyTokens,
              reason,
              requestedBy: actorOf(actor),
              ...(name ? { requestedByName: name } : {}),
              requestedAt: now().toISOString(),
              state: 'pending',
            };
            return audited(
              c,
              entered.principal,
              'platform.quota.request',
              { tenant, reason, monthlyTokens: request.monthlyTokens },
              async () => {
                await save(tenant, request, request.requestedBy, reason);
                return { value: request, target: `quota-request:${tenant}/${request.id}` };
              },
            );
          });
          if ('response' in result) return result.response;
          return c.json(tenantView(result.value), 201);
        });

        app.get('/operator/quota-requests', async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Not authenticated');
          if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
          const filter = QuotaStateFilter.safeParse(c.req.query('state'));
          if (!filter.success) return invalid(c, filter.error.issues);
          const state = filter.data;
          const names = await mounted.admin.tenantNames();
          const requests = (await list()).filter((r) => !state || r.request.state === state);
          const quotas = new Map(
            await Promise.all(
              [...new Set(requests.map((r) => r.tenant))].map(
                async (tenant) =>
                  [tenant, await deps.quota?.(tenant).catch(() => undefined)] as const,
              ),
            ),
          );
          return c.json({
            data: requests.map(({ tenant, request }) => {
              const quota = quotas.get(tenant);
              return {
                ...request,
                tenant,
                tenantName: names.get(tenant) ?? tenant,
                ...(quota
                  ? { quota: { usedTokens: quota.usedTokens, monthlyTokens: quota.monthlyTokens } }
                  : {}),
              };
            }),
          });
        });

        app.post('/operator/quota-requests/:tenant/:id/decision', async (c) => {
          const principal = await mounted.authenticate(c.req.raw);
          if (!principal) return problem(c, 401, 'Not authenticated');
          if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
          const reason = reasonOf(c);
          if (!reason) return missingReason(c);
          const parsed = QuotaDecisionBody.safeParse(await c.req.json().catch(() => undefined));
          if (!parsed.success) return invalid(c, parsed.error.issues);
          const tenant = c.req.param('tenant') ?? '';
          const id = c.req.param('id') ?? '';
          const result = await writes(async () => {
            const history = await deps.configEntries.history(quotaRequestKind, tenant, id);
            const found = history.at(-1) as ConfigEntry<QuotaRequest> | undefined;
            if (!found || found.deleted) return { response: problem(c, 404, 'Not found') };
            if (found.spec.state !== 'pending')
              return {
                response: problem(
                  c,
                  409,
                  'Conflict',
                  [
                    {
                      path: 'state',
                      message:
                        found.spec.state === 'approved'
                          ? 'the quota request is already approved'
                          : 'the quota request is already rejected',
                    },
                  ],
                  quotaRequestDecidedType,
                ),
              };
            const name = actorNameOf(c) ?? principal.name;
            if (parsed.data.decision === 'postponed') {
              if (parsed.data.until <= osloDay(now()))
                return {
                  response: problem(c, 400, 'Invalid request', [
                    { path: 'until', message: 'until is a date after today' },
                  ]),
                };
              const postponed: QuotaRequest = {
                ...found.spec,
                postponed: {
                  until: parsed.data.until,
                  by: actorOf(principal),
                  ...(name ? { byName: name } : {}),
                  at: now().toISOString(),
                  ...(parsed.data.note ? { note: parsed.data.note } : {}),
                },
              };
              return audited(
                c,
                { ...principal, tenant: deps.platformTenant },
                'platform.quota.postpone',
                { tenant, reason, id, until: parsed.data.until },
                async () => {
                  await save(tenant, postponed, actorOf(principal), reason);
                  return { value: postponed, target: `quota-request:${tenant}/${id}` };
                },
              );
            }
            const monthlyTokens =
              parsed.data.decision === 'approved'
                ? (parsed.data.monthlyTokens ?? found.spec.monthlyTokens)
                : found.spec.monthlyTokens;
            const decided: QuotaRequest = {
              ...found.spec,
              state: parsed.data.decision,
              decision: {
                by: actorOf(principal),
                ...(name ? { byName: name } : {}),
                at: now().toISOString(),
                reason,
                ...(parsed.data.decision === 'approved' ? { monthlyTokens } : {}),
              },
            };
            return audited(
              c,
              { ...principal, tenant: deps.platformTenant },
              'platform.quota.decide',
              { tenant, reason, id, decision: decided.state, monthlyTokens },
              async () => {
                if (decided.state === 'approved') {
                  const raised = await mounted.admin.setTenantSetting(
                    { ...principal, tenant, actor: principal },
                    tenant,
                    quotaSettingKey,
                    monthlyTokens,
                    reason,
                  );
                  if (!raised.ok) throw new AdminRefused(raised.errors, raised.task);
                }
                await save(tenant, decided, actorOf(principal), reason);
                return { value: decided, target: `quota-request:${tenant}/${id}` };
              },
            );
          });
          if ('response' in result) return result.response;
          return c.json(result.value, 200);
        });
      },
    };
  };

export const quotaRequestsModule = createQuotaRequestsModule();
