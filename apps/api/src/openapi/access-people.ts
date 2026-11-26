import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { problemContent } from '../http.js';
import { rights } from '../rights.js';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });
const tenant = z.string().openapi({ param: { name: 'tenant', in: 'path' }, example: '991825827' });
const service = z
  .string()
  .openapi({ param: { name: 'service', in: 'path' }, example: 'rapportassistenten' });
const reason = z.object({
  'change-reason': z
    .string()
    .min(10)
    .openapi({
      param: { name: 'change-reason', in: 'header' },
      description: 'Why the change is made, at least 10 characters. Stored in the audit log.',
      example: 'Bare piloten skal bruke tjenesten i november',
    }),
});

const personId = z
  .string()
  .describe('A keyed hash of the person, stable within the platform. Never a national id.');

const Member = z.object({ id: personId, name: z.string() }).openapi('AccessMember');

const ServiceAccess = z
  .object({
    id: z.string(),
    mode: z.enum(['all', 'selected']),
    members: z.array(Member),
    by: z.string().optional(),
    byName: z.string().optional(),
    at: z.string().optional(),
    reason: z.string().optional(),
  })
  .openapi('ServiceAccess');

export const accessPeopleRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/access/people',
    summary:
      "The people in the tenant's organisation who hold a platform right in Altinn, with those rights. Any member",
    description:
      "Read from Altinn access management through the organisation's system user, and kept for two minutes. When Altinn fails, the last list read is served with `stale: true`. When Entra groups give the rights, `people` is empty and `source` is `entra-groups`. Reads are not audited.",
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(
        z.object({
          people: z.array(
            z.object({ id: personId, name: z.string(), rights: z.array(z.enum(rights)) }),
          ),
          at: z.string().describe('When the list was read.'),
          stale: z.boolean(),
          source: z
            .enum(['altinn', 'test-data', 'entra-groups'])
            .describe(
              "`entra-groups`: rights come from the organisation's Entra groups, so `people` is empty.",
            ),
        }),
        'People and rights',
      ),
      401: problem('Not signed in'),
      404: problem('Not a member of this tenant'),
      503: problem(
        '`altinn_not_configured`: no Altinn connection; `altinn_unavailable`: Altinn did not answer and no earlier list is kept',
      ),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/access/services',
    summary: "The tenant's services that are limited to selected people. Any member",
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(
        z.object({
          services: z
            .array(ServiceAccess)
            .describe(
              'Only limited services; any other service is open to everyone with use-services.',
            ),
        }),
        'Limited services',
      ),
      401: problem('Not signed in'),
      404: problem('Not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/access/services/{service}',
    summary:
      'Limit who may use a service to selected people, or open it to everyone with use-services again (manage-services, audited)',
    description:
      'People and machine clients are told apart: the limit applies to people signing in, never to API keys or Maskinporten clients. A chosen person also needs use-services in Altinn.',
    request: {
      params: z.object({ tenant, service }),
      headers: reason,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              mode: z.enum(['all', 'selected']),
              members: z
                .array(personId)
                .optional()
                .describe('With `selected`: at least one person from `/access/people`.'),
            }),
          },
        },
      },
    },
    responses: {
      200: json(ServiceAccess, 'Saved'),
      400: problem(
        'No reason, an unknown mode, nobody chosen, or a person outside the organisation',
      ),
      401: problem('Not signed in'),
      403: problem('Missing the right to manage services'),
      404: problem('No such service, or not a member of this tenant'),
    },
  }),
];
