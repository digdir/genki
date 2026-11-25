import type { Principal } from '@genai/contracts';
import { KernelError, type Kernel } from '@genai/kernel';
import type { Context, MiddlewareHandler } from 'hono';
import type { Admin } from './admin.js';
import { routeOf } from './change-reason.js';
import { t } from './i18n/index.js';

export const contentReasonRequiredType = 'urn:genai:problem:content-reason-required';

export const contentRoutes: ReadonlySet<string> = new Set([
  'POST /tenants/:tenant/api-keys',
  'POST /tenants/:tenant/api-keys/:id/rotate',
  'POST /tenants/:tenant/services/:service/api-keys',
  'POST /tenants/:tenant/maskinporten-clients',
  'PUT /tenants/:tenant/clients/:id',
  'PUT /tenants/:tenant/hooks/:id',
  'PUT /tenants/:tenant/tracing/connections/:id',
  'GET /tenants/:tenant/export',
  'POST /tenants/:tenant/definitions/input-fields',
  'POST /tenants/:tenant/projects/:project/runs/estimate',
  'POST /tenants/:tenant/services/:id/batch-runs/estimate',
  'POST /tenants/:tenant/skills/:id/copy',
  'POST /tenants/:tenant/skills/:id/fix/:fixId/apply',
  'POST /tenants/:tenant/skills/import',
  'PUT /tenants/:tenant/skills/:id',
  'GET /tenants/:tenant/skills/:id',
  'GET /tenants/:tenant/skills/:id/versions',
  'GET /tenants/:tenant/skills/:id/export',
  'DELETE /tenants/:tenant/skills/:id/testcases/:index',
  'POST /tenants/:tenant/tool-connections',
  'POST /tenants/:tenant/tool-connections/:id/approve',
  'GET /tenants/:tenant/audit/:task',
  'GET /tenants/:tenant/access/people',
  'GET /tenants/:tenant/access/services',
  'PUT /tenants/:tenant/access/services/:service',
  'GET /tenants/:tenant/datasets/:id/documents',
  'GET /tenants/:tenant/datasets/:id/documents/:doc',
  'GET /tenants/:tenant/datasets/:id/uploads',
  'GET /tenants/:tenant/datasets/:id/uploads/:name',
  'POST /tenants/:tenant/datasets/:id/uploads',
  'DELETE /tenants/:tenant/datasets/:id/uploads/:name',
  'POST /tenants/:tenant/datasets/:id/search',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/proposals',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/verify',
  'POST /tenants/:tenant/definitions/test-run',
  'GET /tenants/:tenant/diagnostics/tasks/:task/attribution',
  'POST /tenants/:tenant/diagnostics/plan',
  'POST /tenants/:tenant/diagnostics/retrieve',
  'GET /tenants/:tenant/eval-runs',
  'GET /tenants/:tenant/eval-runs/:runId',
  'POST /tenants/:tenant/eval-runs',
  'GET /tenants/:tenant/feedback',
  'POST /tenants/:tenant/playground/runs',
  'POST /tenants/:tenant/playground/runs/stream',
  'GET /tenants/:tenant/projects/:project/documents',
  'GET /tenants/:tenant/projects/:project/history',
  'GET /tenants/:tenant/projects/:project/log',
  'GET /tenants/:tenant/projects/:project/points',
  'POST /tenants/:tenant/projects/:project/points',
  'GET /tenants/:tenant/projects/:project/runs',
  'POST /tenants/:tenant/projects/:project/runs',
  'POST /tenants/:tenant/projects/:project/runs/:run/retry',
  'POST /tenants/:tenant/projects/:project/runs/:run/review',
  'POST /tenants/:tenant/services/:id/assistant/turns',
  'POST /tenants/:tenant/skills/:id/assistant/turns',
  'POST /tenants/:tenant/step-flows/:id/assistant/turns',
  'GET /tenants/:tenant/services/:id/batch-runs',
  'POST /tenants/:tenant/services/:id/batch-runs',
  'GET /tenants/:tenant/services/:id/batch-runs/sources',
  'GET /tenants/:tenant/services/:id/batch-runs/:runId',
  'GET /tenants/:tenant/services/:id/batch-runs/:runId/export',
  'POST /tenants/:tenant/services/:id/batch-runs/:runId/retry',
  'GET /tenants/:tenant/services/:id/eval-runs',
  'POST /tenants/:tenant/services/:id/eval-runs',
  'GET /tenants/:tenant/services/:id/eval-runs/compare',
  'GET /tenants/:tenant/services/:id/eval-runs/sending',
  'GET /tenants/:tenant/services/:id/improvements',
  'POST /tenants/:tenant/services/:id/improvements',
  'GET /tenants/:tenant/services/:id/test-sets',
  'GET /tenants/:tenant/skills/:id/test-runs',
  'POST /tenants/:tenant/skills/:id/test-runs',
  'GET /tenants/:tenant/tasks',
  'GET /tenants/:tenant/tasks/mine',
  'GET /tenants/:tenant/tasks/:task',
  'GET /tenants/:tenant/tasks/:task/review',
  'POST /tenants/:tenant/tasks/:task/review/approve',
  'PUT /tenants/:tenant/tasks/:task/review/edits',
  'GET /tenants/:tenant/tasks/:task/timeline',
  'POST /tenants/:tenant/tasks/:task/export',
  'GET /tenants/:tenant/test-sets',
  'POST /tenants/:tenant/test-sets',
  'GET /tenants/:tenant/test-sets/:id',
  'PUT /tenants/:tenant/test-sets/:id',
  'GET /tenants/:tenant/test-sets/:setId/cases',
  'POST /tenants/:tenant/test-sets/:setId/cases',
  'PUT /tenants/:tenant/test-sets/:id/cases/:case',
  'DELETE /tenants/:tenant/test-sets/:id/cases/:case',
  'GET /tenants/:tenant/testcase-candidates',
  'POST /tenants/:tenant/testcase-candidates',
  'POST /tenants/:tenant/testcase-candidates/:id/review',
  'GET /tenants/:tenant/triggers/:id/runs',
]);

const osloDate = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Oslo',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

export const osloDay = (at: Date) => osloDate.format(at);

export const osloDayEnd = (at: Date) => {
  const [year, month, day] = osloDay(at).split('-').map(Number) as [number, number, number];
  const midnightUtc = Date.UTC(year, month - 1, day + 1);
  const end = [2, 1]
    .map((hours) => new Date(midnightUtc - hours * 3_600_000))
    .find((candidate) => osloDay(candidate) !== osloDay(at));
  return end ?? new Date(midnightUtc);
};

export const skillDefinitionRoutes: ReadonlySet<string> = new Set([
  'GET /tenants/:tenant/definitions/:kind/:id',
  'GET /tenants/:tenant/definitions/:kind/:id/versions/:version',
  'GET /operator/tenants/:tenant/definitions/:kind/:id',
  'GET /operator/tenants/:tenant/definitions/:kind/:id/versions/:version',
]);

const segments = (c: Context) => c.req.path.split('/').map((s) => decodeURIComponent(s));

const isContent = (c: Context, route: string) => {
  if (contentRoutes.has(route)) return true;
  if (!skillDefinitionRoutes.has(route)) return false;
  const kind = route.split(' ')[1]?.split('/').indexOf(':kind') ?? -1;
  return kind > 0 && segments(c)[kind] === 'skills';
};

export const actsAsOperator = (principal: Principal, tenant: string) =>
  principal.kind === 'operator' && !principal.authorizedFor?.some((a) => a.org === tenant);

const tenantOf = (c: Context, route: string) => {
  const path = route.split(' ')[1] ?? '';
  if (path.startsWith('/tenants/:tenant/')) return segments(c)[2];
  if (path.startsWith('/operator/tenants/:tenant/')) return segments(c)[3];
  return undefined;
};

type ContentReasons = Pick<Admin, 'contentReason' | 'recordContentRead'>;

export const contentGate = async (
  c: Context,
  admin: ContentReasons,
  principal: Principal,
  tenant: string,
  route: string,
): Promise<Response | undefined> => {
  if (!actsAsOperator(principal, tenant)) return undefined;
  const given = admin.contentReason(principal, tenant);
  if (!given)
    return c.json(
      {
        type: contentReasonRequiredType,
        title: t('problems.contentReasonRequired'),
        status: 403,
        tenant,
      },
      403,
      { 'content-type': 'application/problem+json' },
    );
  await admin.recordContentRead(principal, tenant, given.reason, route);
  return undefined;
};

export const requireContentReason =
  (
    caller: (request: Request) => Promise<Principal | undefined>,
    admin: ContentReasons,
  ): MiddlewareHandler =>
  async (c, next) => {
    const route = routeOf(c);
    if (!route || !isContent(c, route)) return next();
    const tenant = tenantOf(c, route);
    const principal = await caller(c.req.raw);
    const refused = tenant && principal && (await contentGate(c, admin, principal, tenant, route));
    return refused || next();
  };

export const contentGatedKernel = (
  kernel: Kernel,
  admin: ContentReasons | undefined,
  reader: Principal,
): Kernel => {
  const check = async (principal: Principal, id: string, use: string) => {
    if (principal.kind !== 'operator') return;
    const task = await kernel.task(reader, id);
    const own =
      task.principal.kind === 'operator' &&
      task.principal.id === JSON.stringify([principal.issuer, principal.subject]);
    if (own || !actsAsOperator(principal, task.tenant)) return;
    const given = admin?.contentReason(principal, task.tenant);
    if (!given) throw new KernelError('not_found', `task ${id} not found`);
    await admin?.recordContentRead(principal, task.tenant, given.reason, use);
  };
  return {
    describe: (principal) => kernel.describe(principal),
    invoke: (principal, capability, input, options) =>
      kernel.invoke(principal, capability, input, options),
    resume: async (principal, task, interrupt, response) => {
      await check(principal, task, 'kernel resume');
      return kernel.resume(principal, task, interrupt, response);
    },
    cancel: async (principal, task) => {
      await check(principal, task, 'kernel cancel');
      return kernel.cancel(principal, task);
    },
    task: async (principal, task) => {
      await check(principal, task, 'kernel task');
      return kernel.task(principal, task);
    },
    events: async (principal, task, options) => {
      await check(principal, task, 'kernel events');
      return kernel.events(principal, task, options);
    },
    annotate: async (principal, task, annotation) => {
      await check(principal, task, 'kernel annotate');
      return kernel.annotate(principal, task, annotation);
    },
    pending: (principal) => kernel.pending(principal),
  };
};
