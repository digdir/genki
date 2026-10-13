import type { Principal } from '@genai/contracts';
import { serviceLifecycleKind } from '@genai/jobs';
import type { Context } from 'hono';
import { enterTenant } from './access.js';
import { actorOf, type AdminHandler, type AdminOutcome } from './admin.js';
import { appendVersion, serialized, type ConfigEntryStore } from './config-store.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import { t } from './i18n/index.js';
import type { PlatformModuleFactory } from './platform-modules.js';
import { rightRefused, type Right } from './rights.js';

export { serviceLifecycleKind };

export type Lifecycle = 'active' | 'paused' | 'archived';

export interface LifecycleView {
  state: Lifecycle;
  reason?: string;
  by?: string;
  at?: string;
}

const states: readonly Lifecycle[] = ['active', 'paused', 'archived'];

export const lifecycleOf = async (
  store: ConfigEntryStore,
  tenant: string,
  service: string,
): Promise<LifecycleView> => {
  const latest = (await store.history(serviceLifecycleKind, tenant, service)).at(-1);
  const state = (latest?.spec as { state?: Lifecycle } | undefined)?.state;
  if (!latest || latest.deleted || (state !== 'paused' && state !== 'archived'))
    return { state: 'active' };
  return { state, reason: latest.reason, by: latest.by, at: latest.at };
};

export const pausedMessage = (view: LifecycleView) =>
  t('services.pausedByTenant', { reason: view.reason ?? '' });

export const runRefusal = (view: LifecycleView) =>
  view.state === 'paused'
    ? { code: 'service_paused', message: pausedMessage(view) }
    : view.state === 'archived'
      ? { code: 'service_archived', message: t('services.archivedByTenant') }
      : undefined;

const failed = (target: string, path: string, message: string): AdminOutcome => ({
  ok: false,
  errors: [{ path, message }],
  target,
});

const forTenant = (principal: Principal, tenant: string) =>
  principal.tenant === tenant && (principal.kind !== 'operator' || principal.actor !== undefined);

const problem = (
  c: Context,
  status: 400 | 401 | 403 | 404,
  title: string,
  errors: { path: string; message: string }[] = [],
) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

export const serviceLifecycleModule: PlatformModuleFactory = (deps) => {
  const entries = deps.configEntries;
  const writes = serialized();

  const handlers: Record<string, AdminHandler> = {
    'platform.service.lifecycle': (input, principal) =>
      writes(async () => {
        const { tenant, reason } = input;
        const id = String(input.id ?? '');
        const target = `service:${tenant}/${id}`;
        if (!forTenant(principal, tenant))
          return failed(target, 'principal', 'only the tenant changes the state of its services');
        const state = input.state as Lifecycle;
        if (!states.includes(state))
          return failed(target, 'state', 'state must be active, paused or archived');
        if (!(await deps.definitions.get('Service', tenant, id)))
          return failed(target, 'id', `no service ${id}`);
        const before = await lifecycleOf(entries, tenant, id);
        if (before.state !== state)
          await appendVersion(entries, {
            kind: serviceLifecycleKind,
            scope: tenant,
            id,
            spec: { state },
            deleted: state === 'active',
            by: actorOf(principal.actor ?? principal),
            reason,
          });
        return {
          ok: true,
          value: { id, state },
          target,
          audit: { before: { state: before.state }, after: { state } },
        } as AdminOutcome;
      }),
  };

  return {
    id: 'service-lifecycle',
    handlers,
    mount: (app, mounted) => {
      const entered = async (c: Context, right: Right) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return { response: problem(c, 401, 'Unauthorized') };
        const tenant = c.req.param('tenant') ?? '';
        const result = enterTenant(c, mounted.access, principal, tenant, right);
        return 'response' in result ? result : { principal: result.principal, tenant };
      };

      app.get('/tenants/:tenant/services/:id/lifecycle', async (c) => {
        const guard = await entered(c, 'use-services');
        if ('response' in guard) return guard.response;
        const id = c.req.param('id') ?? '';
        if (!(await deps.definitions.get('Service', guard.tenant, id)))
          return problem(c, 404, 'Not found');
        return c.json(await lifecycleOf(entries, guard.tenant, id));
      });

      app.put('/tenants/:tenant/services/:id/lifecycle', async (c) => {
        const guard = await entered(c, 'manage-services');
        if ('response' in guard) return guard.response;
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        const body = (await c.req.json().catch(() => ({}))) as { state?: unknown };
        const id = c.req.param('id') ?? '';
        const result = await mounted.admin.perform(guard.principal, 'platform.service.lifecycle', {
          tenant: guard.tenant,
          id,
          state: body.state,
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
        return c.json(await lifecycleOf(entries, guard.tenant, id));
      });
    },
  };
};
