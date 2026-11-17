import type { Principal } from '@genai/contracts';
import type { ValidationError } from '@genai/definitions';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { appendVersion, serialized, type ConfigEntry } from './config-store.js';
import {
  actorNameOf,
  changeReasonOf,
  isReasonLongEnough,
  reasonTooShort,
  problem as sharedProblem,
} from './http.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const quotaRequestPendingType = 'urn:genai:problem:quota-request-pending';
export const quotaRequestDecidedType = 'urn:genai:problem:quota-request-decided';

export const quotaRequestKind = 'quota-request';
export const quotaRequestActions = ['platform.quota.request', 'platform.quota.decide'] as const;

export interface QuotaRequest {
  id: string;
  monthlyTokens: number;
  reason: string;
  requestedBy: string;
  requestedByName?: string;
  requestedAt: string;
  state: 'pending' | 'approved' | 'rejected';
  decision?: { by: string; byName?: string; at: string; reason: string };
}

export const QuotaRequestBody = z.strictObject({
  monthlyTokens: z.number().int().min(1).max(10_000_000_000),
});

export const QuotaStateFilter = z.enum(['pending', 'approved', 'rejected']).optional();

export const QuotaDecisionBody = z.strictObject({ decision: z.enum(['approved', 'rejected']) });

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

export const createQuotaRequestsModule =
  (options: QuotaRequestsOptions = {}): PlatformModuleFactory =>
  (deps) => ({
    id: 'quota-requests',
    handlers: routeOnlyActions(quotaRequestActions),
    mount: <E extends Env, S extends Schema, B extends string>(
      app: Hono<E, S, B>,
      mounted: MountDeps,
    ) => {
      const now = options.now ?? (() => new Date());
      const newId = options.newId ?? (() => crypto.randomUUID());
      const writes = serialized();

      const list = async (scope?: string) =>
        (await deps.configEntries.latest({ kind: quotaRequestKind, ...(scope ? { scope } : {}) }))
          .filter((e) => !e.deleted && (scope === undefined || e.scope === scope))
          .map((e) => ({ tenant: e.scope, request: e.spec as QuotaRequest }))
          .sort((a, b) => b.request.requestedAt.localeCompare(a.request.requestedAt));

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
        return c.json({ data: (await list(tenant)).map((r) => r.request) });
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
        return c.json(result.value, 201);
      });

      app.get('/operator/quota-requests', async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Not authenticated');
        if (principal.kind !== 'operator') return problem(c, 403, 'Forbidden');
        const filter = QuotaStateFilter.safeParse(c.req.query('state'));
        if (!filter.success) return invalid(c, filter.error.issues);
        const state = filter.data;
        const names = await mounted.admin.tenantNames();
        return c.json({
          data: (await list())
            .filter((r) => !state || r.request.state === state)
            .map(({ tenant, request }) => ({
              ...request,
              tenant,
              tenantName: names.get(tenant) ?? tenant,
            })),
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
          const decided: QuotaRequest = {
            ...found.spec,
            state: parsed.data.decision,
            decision: {
              by: actorOf(principal),
              ...(name ? { byName: name } : {}),
              at: now().toISOString(),
              reason,
            },
          };
          return audited(
            c,
            { ...principal, tenant: deps.platformTenant },
            'platform.quota.decide',
            { tenant, reason, id, decision: decided.state },
            async () => {
              await save(tenant, decided, actorOf(principal), reason);
              return { value: decided, target: `quota-request:${tenant}/${id}` };
            },
          );
        });
        if ('response' in result) return result.response;
        return c.json(result.value, 200);
      });
    },
  });

export const quotaRequestsModule = createQuotaRequestsModule();
