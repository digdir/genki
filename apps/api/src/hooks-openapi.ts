import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { hookFailureModes, hookModes, hookPoints } from '@genai/hooks';
import { problemContent } from './http.js';

const tenantParam = z
  .string()
  .openapi({ param: { name: 'tenant', in: 'path' }, example: '991825827' });
const idParam = z
  .string()
  .openapi({ param: { name: 'id', in: 'path' }, example: 'stopp-fodselsnummer' });
const reasonHeader = z.object({
  'change-reason': z.string().openapi({ param: { name: 'change-reason', in: 'header' } }),
});

const HookSpec = z
  .object({
    name: z.string(),
    point: z.enum(hookPoints),
    mode: z.enum(hookModes).optional(),
    failure: z.enum(hookFailureModes).optional(),
    timeoutMs: z.number().int().min(50).max(10_000).optional(),
    order: z.number().int().optional(),
    enabled: z.boolean().optional(),
    services: z.array(z.string()).optional(),
    handler: z.union([
      z.object({ kind: z.literal('webhook'), url: z.string(), secret: z.string() }),
      z.object({
        kind: z.literal('builtin'),
        id: z.string(),
        config: z.record(z.string(), z.unknown()).optional(),
      }),
    ]),
  })
  .openapi('HookSpec');

const SavedHook = HookSpec.extend({
  id: z.string(),
  scope: z.string(),
  version: z.number().int(),
}).openapi('SavedHook');

const Hook = SavedHook.extend({
  changedBy: z.string(),
  changedAt: z.string(),
}).openapi('Hook');

const HookTrial = z
  .object({
    refused: z.object({ hook: z.string(), name: z.string(), reason: z.string() }).optional(),
    records: z.array(z.record(z.string(), z.unknown())),
    payload: z
      .record(z.string(), z.unknown())
      .describe('The sample the hook was called with, for its point'),
  })
  .openapi('HookTrial');

const BuiltinHook = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string(),
    configSchema: z.record(z.string(), z.unknown()).describe('JSON Schema for handler.config'),
  })
  .openapi('BuiltinHook');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });

export const hookRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/hooks',
    summary: "The tenant's hooks, the platform hooks that apply, hook points and built-ins",
    request: { params: z.object({ tenant: tenantParam }) },
    responses: {
      200: json(
        z.object({
          data: z.array(Hook),
          platform: z.array(Hook),
          points: z.array(z.enum(hookPoints)),
          builtins: z.array(BuiltinHook),
        }),
        'Hooks',
      ),
      401: problem('Not signed in'),
      403: problem('Missing right'),
      404: problem('Not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/hooks/{id}',
    summary: 'Create or change a hook; If-Match with the version guards against lost updates',
    request: {
      params: z.object({ tenant: tenantParam, id: idParam }),
      headers: reasonHeader,
      body: { required: true, content: { 'application/json': { schema: HookSpec } } },
    },
    responses: {
      200: json(SavedHook, 'Saved'),
      400: problem('Invalid hook or missing reason'),
      401: problem('Not signed in'),
      403: problem('Missing right'),
      404: problem('Not a member of this tenant'),
      409: problem('Changed by someone else'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/hooks/{id}',
    summary: 'Remove a hook',
    request: { params: z.object({ tenant: tenantParam, id: idParam }), headers: reasonHeader },
    responses: {
      200: json(z.object({ removed: z.string() }), 'Removed'),
      400: problem('Missing reason'),
      401: problem('Not signed in'),
      403: problem('Missing right'),
      404: problem('No such hook, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/hooks/{id}/test',
    summary: 'Call the hook with a sample for its point and show the verdict',
    request: { params: z.object({ tenant: tenantParam, id: idParam }) },
    responses: {
      200: json(HookTrial, 'Verdict'),
      401: problem('Not signed in'),
      403: problem('Missing right'),
      404: problem('No such hook, or not a member of this tenant'),
      409: problem('Hooks are turned off'),
    },
  }),
];

interface DocumentedApp {
  openAPIRegistry?: { registerPath(route: RouteConfig): void };
}

export const documentHookRoutes = (app: unknown) => {
  const registry = (app as DocumentedApp).openAPIRegistry;
  if (!registry) return;
  for (const route of hookRoutes) registry.registerPath(route);
};
