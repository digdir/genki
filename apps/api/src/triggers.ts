import type { Principal } from '@genai/contracts';
import type { DefinitionStore } from '@genai/definitions';
import {
  InMemoryTriggerRuns,
  nextRun,
  parseCron,
  triggerId,
  triggerPauseKind,
  triggerTarget,
  type Trigger,
  type TriggerRunRecord,
  type TriggerRunStore,
  type TriggerRunTally,
} from '@genai/jobs';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { appendVersion, serialized, type ConfigEntryStore } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { rightRefused, seesUsage, type Right } from './rights.js';
import { documentTriggerRoutes } from './triggers-openapi.js';

export type TriggerStatus = 'active' | 'failing' | 'paused';

export interface TriggerRunView {
  id: string;
  at: string;
  outcome: TriggerRunRecord['outcome'];
  task?: string;
  error?: string;
  code?: string;
  usage?: { inputTokens: number; outputTokens: number };
  costMicroNok?: number;
  timeline?: string;
}

export interface TriggerView {
  id: string;
  service: string;
  serviceName: string;
  kind: Trigger['kind'];
  target: string;
  status: TriggerStatus;
  pausedAt?: string;
  pausedBy?: string;
  nextRunAt?: string;
  lastRun?: TriggerRunView;
  runs7d: number;
  failed7d: number;
}

const week = 7 * 24 * 60 * 60_000;
const maxRuns = 50;

const runView = (tenant: string, run: TriggerRunRecord): TriggerRunView => ({
  id: run.id,
  at: run.at,
  outcome: run.outcome,
  ...(run.task
    ? {
        task: run.task,
        timeline: `/tenants/${encodeURIComponent(tenant)}/tasks/${encodeURIComponent(run.task)}/timeline`,
      }
    : {}),
  ...(run.error ? { error: run.error } : {}),
  ...(run.code ? { code: run.code } : {}),
  ...(run.usage ? { usage: run.usage } : {}),
  ...(run.costMicroNok === undefined ? {} : { costMicroNok: run.costMicroNok }),
});

const withoutCost = (run: TriggerRunView): TriggerRunView => {
  const shown = { ...run };
  delete shown.usage;
  delete shown.costMicroNok;
  return shown;
};

const triggerShown = (view: TriggerView, cost: boolean): TriggerView =>
  cost || !view.lastRun ? view : { ...view, lastRun: withoutCost(view.lastRun) };

const statusOf = (paused: boolean, last?: TriggerRunRecord): TriggerStatus =>
  paused ? 'paused' : last?.outcome === 'failed' && !last.task ? 'failing' : 'active';

const nextScheduled = (trigger: Trigger, now: Date) => {
  if (trigger.kind !== 'schedule') return undefined;
  try {
    return nextRun(parseCron(trigger.cron), now).toISOString();
  } catch {
    return undefined;
  }
};

export const listTriggers = async (
  deps: { definitions: DefinitionStore; runs: TriggerRunStore; pauses: ConfigEntryStore },
  tenant: string,
  now: Date,
): Promise<TriggerView[]> => {
  const services = (await deps.definitions.list(tenant)).filter((d) => d.kind === 'Service');
  const tallies = new Map<string, TriggerRunTally>(
    (await deps.runs.tally(tenant, new Date(now.getTime() - week).toISOString())).map((t) => [
      t.trigger,
      t,
    ]),
  );
  const pauses = new Map(
    (await deps.pauses.latest({ kind: triggerPauseKind, scope: tenant }))
      .filter((e) => !e.deleted)
      .map((e) => [e.id, e]),
  );
  const views: TriggerView[] = [];
  for (const { id: service } of services) {
    const published = await deps.definitions.get('Service', tenant, service);
    if (published?.definition.kind !== 'Service') continue;
    const { metadata, spec } = published.definition;
    for (const trigger of spec.triggers) {
      const id = triggerId(service, trigger);
      const tally = tallies.get(id);
      const pause = pauses.get(id);
      const next = pause ? undefined : nextScheduled(trigger, now);
      views.push({
        id,
        service,
        serviceName: metadata.name ?? service,
        kind: trigger.kind,
        target: triggerTarget(trigger),
        status: statusOf(Boolean(pause), tally?.last),
        ...(pause ? { pausedAt: pause.at, pausedBy: pause.by } : {}),
        ...(next ? { nextRunAt: next } : {}),
        ...(tally?.last ? { lastRun: runView(tenant, tally.last) } : {}),
        runs7d: tally?.runs ?? 0,
        failed7d: tally?.failed ?? 0,
      });
    }
  }
  return views.sort(
    (a, b) => a.serviceName.localeCompare(b.serviceName, 'nb') || a.id.localeCompare(b.id),
  );
};

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const failed = (target: string, path: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const forTenant = (principal: Principal, tenant: string) =>
  principal.tenant === tenant && (principal.kind !== 'operator' || principal.actor !== undefined);

export const triggersModule: PlatformModuleFactory = (deps) => {
  const runs = deps.triggerRuns ?? new InMemoryTriggerRuns();
  const pauses = deps.configEntries;
  const writes = serialized();
  const list = (tenant: string) =>
    listTriggers({ definitions: deps.definitions, runs, pauses }, tenant, new Date());

  const handlers: Record<string, AdminHandler> = {
    'platform.trigger.pause': (input, principal) =>
      writes(async () => {
        const { tenant, reason } = input;
        const id = String(input.id ?? '');
        const target = `trigger:${tenant}/${id}`;
        if (!forTenant(principal, tenant))
          return failed(target, 'principal', 'only the tenant pauses its triggers');
        if (typeof input.paused !== 'boolean')
          return failed(target, 'paused', 'paused must be true or false');
        const found = (await list(tenant)).find((t) => t.id === id);
        if (!found) return failed(target, 'id', `no trigger ${id}`);
        const before = found.status === 'paused';
        if (before !== input.paused)
          await appendVersion(pauses, {
            kind: triggerPauseKind,
            scope: tenant,
            id,
            spec: { service: found.service, kind: found.kind, target: found.target },
            deleted: !input.paused,
            by: actorOf(principal.actor ?? principal),
            reason,
          });
        return {
          ok: true,
          value: { id, paused: input.paused },
          target,
          audit: { before: { paused: before }, after: { paused: input.paused } },
        };
      }),
  };

  return {
    id: 'triggers',
    handlers,
    mount: (app, mounted) => {
      documentTriggerRoutes(app);
      const entered = async (c: Context, right: Right) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        const tenant = c.req.param('tenant') ?? '';
        const result = enterTenant(c, mounted.access, principal, tenant, right);
        return 'response' in result ? result : { principal: result.principal, tenant };
      };

      app.get('/tenants/:tenant/triggers', async (c) => {
        const guard = await entered(c, 'use-services');
        if ('response' in guard) return guard.response;
        const cost = seesUsage(guard.principal, guard.tenant);
        return c.json({ data: (await list(guard.tenant)).map((t) => triggerShown(t, cost)) });
      });

      app.get('/tenants/:tenant/triggers/:id/runs', async (c) => {
        const guard = await entered(c, 'use-services');
        if ('response' in guard) return guard.response;
        const id = c.req.param('id') ?? '';
        const trigger = (await list(guard.tenant)).find((t) => t.id === id);
        if (!trigger) return problem(c, 404, 'Not found');
        const wanted = Number(c.req.query('limit') ?? 20);
        const limit = Number.isInteger(wanted) && wanted > 0 ? Math.min(wanted, maxRuns) : 20;
        const recent = await runs.recent(guard.tenant, id, limit);
        const cost = seesUsage(guard.principal, guard.tenant);
        return c.json({
          trigger: triggerShown(trigger, cost),
          data: recent.map((r) => {
            const view = runView(guard.tenant, r);
            return cost ? view : withoutCost(view);
          }),
        });
      });

      app.put('/tenants/:tenant/triggers/:id/pause', async (c) => {
        const guard = await entered(c, 'manage-services');
        if ('response' in guard) return guard.response;
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const body = (await c.req.json().catch(() => ({}))) as { paused?: unknown };
        const id = c.req.param('id') ?? '';
        const result = await mounted.admin.perform(guard.principal, 'platform.trigger.pause', {
          tenant: guard.tenant,
          id,
          paused: body.paused,
          reason,
        });
        c.header('genai-task', result.task);
        if (!result.ok) {
          if (result.problem) return rightRefused(c, result.problem);
          const paths = new Set(result.errors.map((e) => e.path));
          if (paths.has('principal')) return problem(c, 403, 'Forbidden', result.errors);
          if (paths.has('id')) return problem(c, 404, 'Not found', result.errors);
          return problem(c, 400, 'Invalid request', result.errors);
        }
        const trigger = (await list(guard.tenant)).find((t) => t.id === id);
        return c.json(trigger && triggerShown(trigger, seesUsage(guard.principal, guard.tenant)));
      });
    },
  };
};
