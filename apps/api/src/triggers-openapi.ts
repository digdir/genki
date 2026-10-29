import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { problemContent } from './http.js';

const tenantParam = z
  .string()
  .openapi({ param: { name: 'tenant', in: 'path' }, example: '991825827' });
const idParam = z
  .string()
  .openapi({ param: { name: 'id', in: 'path' }, example: 'sorter-post-3f9a1c2b7d' });
const reasonHeader = z.object({
  'change-reason': z.string().openapi({ param: { name: 'change-reason', in: 'header' } }),
});

const TriggerRun = z
  .object({
    id: z.string(),
    at: z.string(),
    outcome: z.enum(['completed', 'failed']),
    task: z.string().optional(),
    error: z.string().optional(),
    usage: z
      .object({ inputTokens: z.number(), outputTokens: z.number() })
      .optional()
      .describe('Only for callers with view-usage'),
    costMicroNok: z.number().optional().describe('Only for callers with view-usage'),
    timeline: z.string().optional(),
  })
  .openapi('TriggerRun');

const Trigger = z
  .object({
    id: z.string(),
    service: z.string(),
    serviceName: z.string(),
    kind: z.enum(['schedule', 'queue-message', 'document-arrives']),
    target: z.string(),
    status: z.enum(['active', 'failing', 'paused']),
    pausedAt: z.string().optional(),
    pausedBy: z.string().optional(),
    nextRunAt: z.string().optional(),
    lastRun: TriggerRun.optional(),
    runs7d: z.number().int(),
    failed7d: z.number().int(),
  })
  .openapi('Trigger');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });

export const triggerRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/triggers',
    summary: "Every trigger on the tenant's published services, with status and runs last 7 days",
    request: { params: z.object({ tenant: tenantParam }) },
    responses: {
      200: json(z.object({ data: z.array(Trigger) }), 'Triggers'),
      401: problem('Not signed in'),
      403: problem('Missing right'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/triggers/{id}/runs',
    summary: 'Recent runs of one trigger, newest first, with a link to each task timeline',
    request: {
      params: z.object({ tenant: tenantParam, id: idParam }),
      query: z.object({ limit: z.string().optional() }),
    },
    responses: {
      200: json(z.object({ trigger: Trigger, data: z.array(TriggerRun) }), 'Runs'),
      404: problem('No such trigger'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/triggers/{id}/pause',
    summary: 'Pause or resume a trigger; while paused it does not start the service',
    request: {
      params: z.object({ tenant: tenantParam, id: idParam }),
      headers: reasonHeader,
      body: {
        required: true,
        content: { 'application/json': { schema: z.object({ paused: z.boolean() }) } },
      },
    },
    responses: {
      200: json(Trigger, 'Saved'),
      400: problem('Invalid body or missing reason'),
      403: problem('Missing right'),
      404: problem('No such trigger'),
    },
  }),
];

type DocumentedApp = { openAPIRegistry?: { registerPath(route: RouteConfig): void } };

export const documentTriggerRoutes = (app: unknown) => {
  const registry = (app as DocumentedApp).openAPIRegistry;
  if (!registry) return;
  for (const route of triggerRoutes) registry.registerPath(route);
};
