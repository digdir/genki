import type { Principal } from '@genai/contracts';
import type { ValidationError } from '@genai/definitions';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import { enterTenant } from './access.js';
import { actorOf, AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import {
  appendVersion,
  platformScope,
  serialized,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import {
  changeReasonOf,
  isReasonLongEnough,
  reasonTooShort,
  problem as sharedProblem,
} from './http.js';
import type { OperationsOverview } from './operations.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const incidentResolvedType = 'urn:genai:problem:incident-resolved';

export const incidentKind = 'platform-incident';
export const incidentActions = ['platform.incident.save', 'platform.incident.resolve'] as const;

export interface Incident {
  id: string;
  title: string;
  text: string;
  tenants: string[];
  startedAt: string;
  resolvedAt?: string;
}

export const IncidentBody = z.strictObject({
  title: z.string().trim().min(1).max(200),
  text: z.string().trim().min(1).max(4000),
  tenants: z
    .array(z.string().regex(/^\d{9}$/))
    .max(500)
    .optional(),
});

export const incidents = async (store: Pick<ConfigEntryStore, 'latest'>) =>
  (await store.latest({ kind: incidentKind, scope: platformScope }))
    .filter((e) => !e.deleted && e.scope === platformScope)
    .map((e) => e.spec as Incident)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));

export const openIncidentsFor = async (store: Pick<ConfigEntryStore, 'latest'>, tenant?: string) =>
  (await incidents(store))
    .filter((i) => !i.resolvedAt)
    .filter((i) => tenant === undefined || i.tenants.length === 0 || i.tenants.includes(tenant))
    .map((i) => ({ title: i.title, text: i.text }));

const pastDays = 90;

export const pastIncidentsFor = async (
  store: Pick<ConfigEntryStore, 'latest'>,
  tenant: string,
  now: Date,
) => {
  const since = new Date(now.getTime() - pastDays * 86_400_000).toISOString();
  return (await incidents(store))
    .filter((i) => i.resolvedAt && i.resolvedAt >= since)
    .filter((i) => i.tenants.length === 0 || i.tenants.includes(tenant))
    .map((i) => ({ date: i.startedAt, title: i.title, text: i.text }));
};

type Status = 400 | 401 | 403 | 404 | 409;

const problem = (
  c: Context,
  status: Status,
  title: string,
  errors: ValidationError[] = [],
  type?: string,
) => sharedProblem(c, status, title, { errors, ...(type ? { type } : {}) });

export interface PlatformStatusOptions {
  now?: () => Date;
  newId?: () => string;
}

export const createPlatformStatusModule =
  (options: PlatformStatusOptions = {}): PlatformModuleFactory =>
  (deps) => ({
    id: 'platform-status',
    handlers: routeOnlyActions(incidentActions),
    inbox: async () =>
      (await incidents(deps.configEntries))
        .filter((i) => !i.resolvedAt)
        .map((i) => ({
          type: 'incident' as const,
          id: i.id,
          tenant: i.tenants.length === 1 ? (i.tenants[0] ?? null) : null,
          tenants: i.tenants,
          what: i.title,
          from: null,
          waitingSince: i.startedAt,
          blocks: true,
          action: { method: 'POST' as const, path: `/operator/incidents/${i.id}/resolve` },
        })),
    mount: <E extends Env, S extends Schema, B extends string>(
      app: Hono<E, S, B>,
      mounted: MountDeps,
    ) => {
      const now = options.now ?? (() => new Date());
      const newId = options.newId ?? (() => crypto.randomUUID());
      const writes = serialized();

      const operator = async (c: Context) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Not authenticated') };
        if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (c.req.method !== 'GET' && !isReasonLongEnough(reason))
          return {
            response: problem(c, 400, 'Invalid request', [
              { path: 'change-reason', message: reasonTooShort },
            ]),
          };
        return { principal, reason };
      };

      const save = (incident: Incident, principal: Principal, reason: string) =>
        appendVersion<Incident>(deps.configEntries, {
          kind: incidentKind,
          scope: platformScope,
          id: incident.id,
          spec: incident,
          deleted: false,
          by: actorOf(principal),
          reason,
        });

      const audited = async (
        c: Context,
        principal: Principal,
        action: (typeof incidentActions)[number],
        reason: string,
        incident: Incident,
      ) => {
        try {
          const done = await mounted.admin.within(
            { ...principal, tenant: deps.platformTenant },
            action,
            { tenant: deps.platformTenant, reason, id: incident.id },
            async () => {
              await save(incident, principal, reason);
              return { value: incident, target: `incident:${incident.id}` };
            },
          );
          c.header('genai-task', done.task);
          return c.json(done.value, action === 'platform.incident.save' ? 201 : 200);
        } catch (error) {
          if (error instanceof AdminRefused) return refusedBy(c, error);
          throw error;
        }
      };

      app.get('/tenants/:tenant/status', async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Not authenticated');
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mounted.access, principal, tenant);
        if ('response' in entered) return entered.response;
        const overview: OperationsOverview = deps.tenantOperations
          ? await deps.tenantOperations(tenant)
          : {
              incidents: [],
              components: [{ name: 'API', status: 'normal' }],
              queueStats: [],
              queue: [],
              triggers: [],
            };
        return c.json({
          ...overview,
          incidents: await openIncidentsFor(deps.configEntries, tenant),
          pastIncidents: await pastIncidentsFor(deps.configEntries, tenant, now()),
        });
      });

      app.get('/operator/incidents', async (c) => {
        const guard = await operator(c);
        if ('response' in guard) return guard.response;
        return c.json({ data: await incidents(deps.configEntries) });
      });

      app.post('/operator/incidents', async (c) => {
        const guard = await operator(c);
        if ('response' in guard) return guard.response;
        const parsed = IncidentBody.safeParse(await c.req.json().catch(() => undefined));
        if (!parsed.success)
          return problem(
            c,
            400,
            'Invalid request',
            parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
          );
        const incident: Incident = {
          id: newId(),
          title: parsed.data.title,
          text: parsed.data.text,
          tenants: [...new Set(parsed.data.tenants ?? [])],
          startedAt: now().toISOString(),
        };
        return writes(() =>
          audited(c, guard.principal, 'platform.incident.save', guard.reason, incident),
        );
      });

      app.post('/operator/incidents/:id/resolve', async (c) => {
        const guard = await operator(c);
        if ('response' in guard) return guard.response;
        const id = c.req.param('id') ?? '';
        return writes(async () => {
          const found = (await deps.configEntries.history(incidentKind, platformScope, id)).at(
            -1,
          ) as ConfigEntry<Incident> | undefined;
          if (!found || found.deleted) return problem(c, 404, 'Not found');
          if (found.spec.resolvedAt)
            return problem(
              c,
              409,
              'Conflict',
              [{ path: 'state', message: 'the incident is already resolved' }],
              incidentResolvedType,
            );
          return audited(c, guard.principal, 'platform.incident.resolve', guard.reason, {
            ...found.spec,
            resolvedAt: now().toISOString(),
          });
        });
      });
    },
  });

export const platformStatusModule = createPlatformStatusModule();
