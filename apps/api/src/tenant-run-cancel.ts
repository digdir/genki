import type { Principal, Task } from '@genai/contracts';
import type { Context, Env, Hono, Schema } from 'hono';
import { enterTenant, refusedRight } from './access.js';
import { AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import { changeReasonOf, isReasonLongEnough, reasonTooShort } from './http.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';

export const tenantRunCancelActions = ['platform.run.cancel'] as const;

export const runCanceller: Principal = {
  kind: 'operator',
  issuer: 'platform',
  subject: 'run-cancel',
};

type Status = 400 | 401 | 404 | 409;

const problem = (c: Context, status: Status, title: string, errors: unknown[] = []) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const startedBy = (task: Task, principal: Principal) =>
  task.principal.id === JSON.stringify([principal.issuer, principal.subject]);

const isOver = (status: string) => ['completed', 'failed', 'cancelled'].includes(status);

export interface TenantRunCancelOptions {
  waitMs?: number;
}

export const createTenantRunCancelModule =
  (options: TenantRunCancelOptions = {}): PlatformModuleFactory =>
  (deps) => ({
    id: 'tenant-run-cancel',
    handlers: routeOnlyActions(tenantRunCancelActions),
    mount: <E extends Env, S extends Schema, B extends string>(
      app: Hono<E, S, B>,
      mounted: MountDeps,
    ) => {
      const waitMs = options.waitMs ?? 2000;
      const current = async (id: string) => (await mounted.task(id)) ?? undefined;

      app.post('/tenants/:tenant/tasks/:task/cancel', async (c) => {
        const principal = await mounted.authenticate(c.req.raw);
        if (!principal) return problem(c, 401, 'Not authenticated');
        const tenant = c.req.param('tenant') ?? '';
        const entered = enterTenant(c, mounted.access, principal, tenant, 'use-services');
        if ('response' in entered) return entered.response;
        const found = await current(c.req.param('task') ?? '');
        if (!found || found.tenant !== tenant) return problem(c, 404, 'Not found');
        if (!startedBy(found, entered.principal)) {
          const lacking = refusedRight(c, entered.principal, tenant, 'manage-services');
          if (lacking) return lacking;
        }
        const reason = changeReasonOf(c)?.trim() ?? '';
        if (!isReasonLongEnough(reason))
          return problem(c, 400, 'Invalid request', [
            { path: 'change-reason', message: reasonTooShort },
          ]);
        if (found.parent !== undefined || found.entryPoint === undefined)
          return problem(c, 409, 'Conflict', [
            {
              path: 'task',
              message: 'only a run started through an API entry point is stopped here',
            },
          ]);
        if (found.status === 'completed' || found.status === 'failed')
          return problem(c, 409, 'Conflict', [
            { path: 'status', message: 'the run has already finished' },
          ]);
        if (found.status === 'cancelled')
          return c.json({ task: found.id, status: found.status }, 200);
        let task: Task = found;
        try {
          const done = await mounted.admin.within(
            entered.principal,
            'platform.run.cancel',
            { tenant, reason, task: found.id },
            async () => {
              await deps.kernel.cancel(runCanceller, found.id);
              return { value: undefined, target: `task:${found.id}` };
            },
          );
          c.header('genai-task', done.task);
        } catch (error) {
          if (error instanceof AdminRefused) return refusedBy(c, error);
          throw error;
        }
        task = (await current(found.id)) ?? task;
        for (let waited = 0; !isOver(task.status) && waited < waitMs; waited += 50) {
          if (task.status === 'interrupted') await deps.kernel.cancel(runCanceller, found.id);
          else await new Promise((resolve) => setTimeout(resolve, 50));
          task = (await current(found.id)) ?? task;
        }
        return c.json(
          { task: found.id, status: task.status },
          task.status === 'cancelled' ? 200 : 202,
        );
      });
    },
  });

export const tenantRunCancelModule = createTenantRunCancelModule();
