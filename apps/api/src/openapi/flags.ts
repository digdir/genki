import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { flagKeys, flagSources } from '@genai/contracts/flags';
import { problemContent } from '../http.js';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });
const body = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/json': { schema } },
});
const tenant = z.string().openapi({ param: { name: 'tenant', in: 'path' }, example: '991825827' });
const key = z.string().openapi({ param: { name: 'key', in: 'path' }, example: flagKeys[0] });
const reason = z.object({
  'change-reason': z
    .string()
    .min(10)
    .openapi({
      param: { name: 'change-reason', in: 'header' },
      description: 'Why the change is made, at least 10 characters. Stored in the audit log.',
      example: 'Laben prøver ny utforming før resten av virksomheten',
    }),
});
const optionalReason = z.object({
  'change-reason': z
    .string()
    .optional()
    .openapi({
      param: { name: 'change-reason', in: 'header' },
      description: 'Why the change is made. A default text is stored when it is left out.',
    }),
});

const FlagState = z
  .object({
    key: z.enum(flagKeys as [string, ...string[]]),
    on: z.boolean(),
    source: z
      .enum(flagSources)
      .describe(
        'What decides: the person, the tenant, GENAI_FLAGS (local development only) or the default, off',
      ),
    selfService: z
      .boolean()
      .describe('Whether a person may switch it for themselves and a tenant admin for the tenant'),
    person: z.boolean().nullable().describe("The caller's own choice, or null"),
    tenant: z.boolean().nullable().describe("The tenant's choice, or null"),
  })
  .openapi('FeatureFlagState');

const Change = z.object({
  on: z.boolean().nullable().describe('true or false to choose, null to clear the choice'),
});

const unauthorized = problem('Not signed in');
const notMember = problem('Not a member of this tenant, or no such flag');
const operatorOnlyFlag = problem(
  'The flag is not self-service (`urn:genai:problem:flag-operator-only`), or a missing right',
);

export const flagRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/me/flags',
    summary:
      "The feature flags as they apply to the signed-in person in their own organisation (the platform's for an operator)",
    responses: {
      200: json(z.object({ data: z.array(FlagState) }), 'Flags'),
      401: unauthorized,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/me/flags',
    summary: 'The feature flags as they apply to the caller in this tenant',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(z.object({ data: z.array(FlagState) }), 'Flags'),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/me/flags/{key}',
    summary:
      'Switch a self-service flag for the caller only; it wins over the tenant (any member, audited)',
    request: { params: z.object({ tenant, key }), headers: optionalReason, body: body(Change) },
    responses: {
      200: json(FlagState, 'The flag as it now applies to the caller'),
      400: problem('`on` is not true, false or null'),
      401: unauthorized,
      403: operatorOnlyFlag,
      404: notMember,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/flags/{key}',
    summary: 'Switch a self-service flag for the whole tenant (manage-services, audited)',
    request: { params: z.object({ tenant, key }), headers: reason, body: body(Change) },
    responses: {
      200: json(FlagState, 'The flag as it now applies to the tenant, without any person choice'),
      400: problem('Missing reason, or `on` is not true, false or null'),
      401: unauthorized,
      403: operatorOnlyFlag,
      404: notMember,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/flags',
    summary:
      'Every registered flag with its description, owner and removeBy date, and every tenant and person it is switched for (operators)',
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              key: z.string(),
              description: z.string(),
              owner: z.string(),
              removeBy: z.string().openapi({ example: '2027-02-28' }),
              selfService: z.boolean(),
              rows: z.array(
                z.object({
                  tenant: z.string(),
                  tenantName: z.string().optional(),
                  person: z.object({ issuer: z.string(), subject: z.string() }).optional(),
                  personName: z.string().optional(),
                  on: z.boolean(),
                  by: z.string(),
                  byName: z.string().optional(),
                  at: z.string(),
                  reason: z.string(),
                }),
              ),
            }),
          ),
        }),
        'Flags',
      ),
      401: unauthorized,
      403: problem('Only operators'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/flags/{key}',
    summary:
      'Switch any flag for a tenant, or for one person in it with `person` (operators, audited in the tenant)',
    request: {
      params: z.object({ key }),
      headers: reason,
      body: body(
        Change.extend({
          tenant: z.string().regex(/^\d{9}$/),
          person: z.object({ issuer: z.string(), subject: z.string() }).optional(),
        }),
      ),
    },
    responses: {
      200: json(FlagState, 'The flag as it now applies at that level'),
      400: problem('Missing reason, or an invalid body'),
      401: unauthorized,
      403: problem('Only operators'),
      404: problem('No such flag'),
    },
  }),
];
