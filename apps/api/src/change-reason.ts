import type { Principal } from '@genai/contracts';
import type { Context, MiddlewareHandler } from 'hono';
import { matchedRoutes } from 'hono/route';
import { changeReasonOf, isReasonLongEnough, problem, reasonTooShort } from './http.js';

export type ReasonFreeWrite = 'run' | 'check' | 'personal' | 'feedback' | 'application';

export const reasonFreeWrites: Record<string, ReasonFreeWrite> = {
  'PUT /tenants/:tenant/me/preferences': 'personal',
  'PUT /tenants/:tenant/me/flags/:key': 'personal',
  'DELETE /tenants/:tenant/design-connector/grants': 'personal',
  'POST /api/conversations': 'personal',
  'PUT /api/conversations/:id': 'personal',
  'DELETE /api/conversations/:id': 'personal',
  'POST /api/mcp': 'run',
  'DELETE /api/mcp': 'run',
  'POST /a2a/:agent': 'run',
  'POST /v1/chat/completions': 'run',
  'POST /v1/tasks/:task/cancel': 'run',
  'POST /api/tools/call/:tool': 'run',
  'POST /api/feedback': 'feedback',
  'POST /onboarding/requests': 'application',
  'POST /tasks/:task/feedback': 'feedback',
  'POST /tenants/:tenant/building-blocks/contract-tests': 'check',
  'POST /tenants/:tenant/building-blocks/manifest-preview': 'check',
  'POST /tenants/:tenant/definitions/test-run': 'run',
  'POST /tenants/:tenant/definitions/input-fields': 'check',
  'POST /tenants/:tenant/definitions/complete': 'check',
  'POST /definitions/validate': 'check',
  'POST /tenants/:tenant/blocks/preview': 'check',
  'POST /tenants/:tenant/blocks/import': 'check',
  'POST /tenants/:tenant/tracing/connections/:id/check': 'check',
  'POST /tenants/:tenant/services/:id/batch-runs/estimate': 'check',
  'POST /tenants/:tenant/services/:id/assistant/turns': 'run',
  'POST /tenants/:tenant/skills/:id/assistant/turns': 'run',
  'POST /tenants/:tenant/step-flows/:id/assistant/turns': 'run',
  'POST /tenants/:tenant/playground/runs': 'run',
  'POST /tenants/:tenant/playground/runs/stream': 'run',
  'POST /tenants/:tenant/services/:id/eval-runs': 'run',
  'POST /tenants/:tenant/eval-runs': 'run',
  'POST /tenants/:tenant/services/:id/improvements': 'run',
  'POST /tenants/:tenant/skills/:id/test-runs': 'run',
  'POST /tenants/:tenant/diagnostics/plan': 'run',
  'POST /tenants/:tenant/diagnostics/retrieve': 'run',
  // A direct search embeds the query, so it is a model use and is closed in lockdown like a run.
  'POST /tenants/:tenant/datasets/:id/search': 'run',
  'POST /operator/datasets/:id/search': 'run',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/proposals': 'run',
  'POST /tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/verify': 'check',
  'POST /tenants/:tenant/hooks/:id/test': 'check',
  'POST /operator/hooks/:id/test': 'check',
  'POST /operator/knowledge/endpoints/test': 'check',
  'POST /operator/plugins/manifest-check': 'check',
  'POST /operator/quality/matrix/estimate': 'check',
  // Reads what people labelled; nothing counts until a batch is accepted with a reason.
  'POST /operator/quality/sink-labels/fetch': 'check',
};

export const bodyReasonWrites = new Set([
  'POST /operator/tenants/:tenant/content-reason',
  'POST /tenants/:tenant/clients/:client/hostnames',
]);

export const writeMethods = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export const selfAuthenticatedWrites = new Set([
  'POST /internal/hostnames/:id/result',
  'POST /recorder/demos/:id/recordings',
  'PUT /recorder/recordings/:id/files/:name',
  'POST /recorder/recordings/:id/finish',
]);

export const routeOf = (c: Context) => {
  const method = c.req.method === 'HEAD' ? 'GET' : c.req.method;
  const route = matchedRoutes(c).find((r) => r.method === method);
  return route && `${route.method} ${route.path}`;
};

const bodyReason = async (c: Context) => {
  const body = (await c.req.json().catch(() => undefined)) as { reason?: unknown } | undefined;
  return typeof body?.reason === 'string' ? body.reason : undefined;
};

export const requireChangeReason =
  (caller: (request: Request) => Promise<Principal | undefined>): MiddlewareHandler =>
  async (c, next) => {
    if (!writeMethods.has(c.req.method)) return next();
    const route = routeOf(c);
    if (!route || route in reasonFreeWrites || selfAuthenticatedWrites.has(route)) return next();
    if (!(await caller(c.req.raw))) return next();
    const reason =
      changeReasonOf(c) ?? (bodyReasonWrites.has(route) ? await bodyReason(c) : undefined);
    if (reason !== undefined && isReasonLongEnough(reason)) return next();
    return problem(c, 400, 'Invalid request', {
      errors: [{ path: 'change-reason', message: reasonTooShort }],
    });
  };
