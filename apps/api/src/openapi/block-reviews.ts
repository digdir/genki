import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { blockEvents } from '@genai/contracts';
import { changeReason, problemContent } from '../http.js';

const pathParam = (name: string, example: string) =>
  z.string().openapi({ param: { name, in: 'path' }, example });

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });

const status = z.enum(['pending', 'approved', 'declined']);

const ShareRequest = z
  .object({
    id: z.string(),
    tenant: z.string(),
    block: z.string(),
    version: z.number().int(),
    status,
    requestedBy: z.string(),
    requestedAt: z.string(),
    reason: z.string(),
    decidedBy: z.string().optional(),
    decidedAt: z.string().optional(),
    decision: z.string().optional(),
    sharedVersion: z
      .number()
      .int()
      .optional()
      .openapi({ description: 'The edition shared with everyone on approval' }),
  })
  .openapi('BlockShareRequest');

const ReviewRow = ShareRequest.extend({
  tenantName: z.string(),
  title: z.record(z.string(), z.string()),
  reads: z.array(z.string()),
  events: z.array(z.enum(blockEvents)),
  bytes: z.number().int(),
  sha256: z.string(),
  sourceFiles: z.array(z.object({ path: z.string(), bytes: z.number().int() })),
}).openapi('BlockShareReview');

const rid = pathParam('rid', '6f1c2b0e-8c1a-4a55-9d0c-2f7d3c1e9a10');
const operatorErrors = {
  403: problem('urn:genai:problem:block-share-operator-only: not an operator'),
};

export const blockReviewRoutes: RouteConfig[] = [
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/blocks/{id}/share-requests',
    summary:
      'Ask an operator to share a code edition of the organisation with everyone. Needs manage-services; audited. Behind the blockStudio flag',
    request: {
      params: z.object({ tenant: pathParam('tenant', '991825827'), id: pathParam('id', 'figur') }),
      headers: changeReason,
      body: {
        required: true,
        content: {
          'application/json': { schema: z.object({ version: z.number().int().positive() }) },
        },
      },
    },
    responses: {
      201: json(
        z.object({ id: z.string(), status, version: z.number().int(), at: z.string() }),
        'The request, pending review',
      ),
      400: problem('No version, or no change-reason'),
      403: problem('Missing manage-services'),
      404: problem(
        'The tenant is not reachable for the caller, no such edition, or the caller is not signed in or has blockStudio off',
      ),
      409: problem(
        'urn:genai:problem:block-share-pending: another request on the block is pending',
      ),
      422: problem(
        'The edition is not the newest, has no code, or is already shared with everyone',
      ),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/blocks/{id}/share-requests',
    summary:
      "The organisation's requests to share a block with everyone, newest first. Any member. Behind the blockStudio flag",
    request: {
      params: z.object({ tenant: pathParam('tenant', '991825827'), id: pathParam('id', 'figur') }),
    },
    responses: {
      200: json(z.object({ data: z.array(ShareRequest) }), 'The requests'),
      404: problem(
        'The tenant is not reachable for the caller, or the caller is not signed in or has blockStudio off',
      ),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/block-share-requests',
    summary:
      'Requests to share a code block with everyone, oldest first. Operators only. Behind the blockStudio flag',
    request: { query: z.object({ status: status.optional() }) },
    responses: {
      200: json(z.object({ data: z.array(ReviewRow) }), 'The requests'),
      ...operatorErrors,
      404: problem('The caller is not signed in or has blockStudio off'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/block-share-requests/{rid}',
    summary:
      'One request with its bundle and source files as text, for an operator to read. Operators only. Behind the blockStudio flag',
    request: { params: z.object({ rid }) },
    responses: {
      200: json(
        ReviewRow.extend({
          bundle: z.string(),
          sources: z.record(z.string(), z.string()),
        }),
        'The request and its code',
      ),
      ...operatorErrors,
      404: problem('No such request, or the caller is not signed in or has blockStudio off'),
    },
  }),
  ...(['approve', 'decline'] as const).map((decision) =>
    createRoute({
      method: 'post',
      path: `/operator/block-share-requests/{rid}/${decision}`,
      summary:
        decision === 'approve'
          ? 'Approve: publish the next edition as a copy of the one reviewed, shared with everyone, as the operator. Operators only; audited with the change-reason. Behind the blockStudio flag'
          : 'Decline: the block stays as it was. Operators only; audited with the change-reason. Behind the blockStudio flag',
      request: { params: z.object({ rid }), headers: changeReason },
      responses: {
        200: json(
          z.object({ status, version: z.number().int().optional() }),
          decision === 'approve' ? 'Approved, with the edition shared' : 'Declined',
        ),
        400: problem('No change-reason'),
        ...operatorErrors,
        404: problem('No such request, or the caller is not signed in or has blockStudio off'),
        409: problem(
          decision === 'approve'
            ? "urn:genai:problem:block-share-not-pending: the request is already decided. urn:genai:problem:block-share-stale: a newer edition has been saved since the request, also while it is being approved. urn:genai:problem:block-share-studio-off: blockStudio is not on for the block's whole organisation"
            : 'urn:genai:problem:block-share-not-pending: the request is already decided',
        ),
        ...(decision === 'approve'
          ? { 422: problem('The copy could not be published, for example with code blocks off') }
          : {}),
      },
    }),
  ),
];
