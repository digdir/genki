import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { blockEvents, blockSharings, blockStates, blockTiers, blockZones } from '@genai/contracts';
import { changeReason, problemContent } from '../http.js';

const pathParam = (name: string, example: string) =>
  z.string().openapi({ param: { name, in: 'path' }, example });

const tenant = pathParam('tenant', '991825827');
const publisher = pathParam('publisher', '991825827');
const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });
const memberErrors = {
  401: problem('Not signed in'),
  404: problem('The tenant is not reachable for the caller, or no edition the caller may use'),
};
const writeErrors = { ...memberErrors, 403: problem('Missing manage-services') };

const languageMap = z.record(z.string(), z.string());
const zone = z.enum(blockZones);
const fieldError = z.object({ path: z.string(), message: z.string() });

const RefBlockPayload = z
  .object({
    ref: z.string().openapi({ example: '991825827/sporsmal-kort@2' }),
    tier: z.enum(['declarative', 'code']),
    publisher: z.string(),
    publisherName: z.string().optional(),
    title: languageMap,
    summary: languageMap.optional(),
    zones: z.array(zone),
    events: z.array(z.enum(blockEvents)),
    states: z.array(z.enum(blockStates)),
    props: z.record(z.string(), z.unknown()).optional(),
    texts: z.record(z.string(), languageMap).optional(),
    reads: z.array(z.string()).openapi({ description: 'Canonical field paths the block reads' }),
    template: z.record(z.string(), z.unknown()).optional(),
    frame: z
      .object({ url: z.string(), sha256: z.string(), height: z.number().int().optional() })
      .optional()
      .openapi({ description: 'A code edition, only when a block origin is set up' }),
  })
  .openapi('RefBlockPayload');

const BlockSummary = z
  .object({
    publisher: z.string(),
    publisherName: z.string(),
    id: z.string(),
    tier: z.enum(blockTiers),
    origin: z.enum(['own', 'built-in', 'shared']),
    title: languageMap,
    summary: languageMap.optional(),
    zones: z.array(zone),
    sharing: z.enum(blockSharings),
    latest: z.object({ version: z.number().int(), publishedAt: z.string() }),
    editions: z.number().int(),
    usedBy: z.number().int().openapi({ description: "The caller's own services that pin it" }),
  })
  .openapi('BlockSummary');

const BlockEdition = z
  .object({
    version: z.number().int(),
    publishedAt: z.string(),
    publishedBy: z.string().optional(),
    publishedByName: z.string().optional(),
    reason: z.string(),
    sharing: z.enum(blockSharings),
  })
  .openapi('BlockEdition');

const BlockDetail = BlockSummary.omit({ editions: true })
  .extend({
    editions: z.array(BlockEdition),
    edition: BlockEdition.extend({
      definition: z.record(z.string(), z.unknown()),
      render: RefBlockPayload.optional(),
    }),
    usedIn: z.array(
      z.object({
        service: z.string(),
        name: z.string(),
        draft: z.number().int().optional(),
        test: z.number().int().optional(),
        inUse: z.number().int().optional(),
      }),
    ),
  })
  .openapi('BlockDetail');

const PinnedDraft = z
  .object({
    revision: z.number().int(),
    definition: z.record(z.string(), z.unknown()),
    files: z.record(z.string(), z.string()),
    baseVersion: z.number().int().nullable(),
    checks: z
      .array(fieldError)
      .openapi({ description: 'What a publish of the draft would refuse' }),
  })
  .openapi('PinnedDraft');

const pinParams = z.object({
  tenant,
  id: pathParam('id', 'klarsprak'),
  publisher,
  blockId: pathParam('blockId', 'sporsmal-kort'),
});

export const blockRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/blocks',
    summary:
      "The interface blocks the organisation may use: its own, genki's built-in ones and those other organisations shared with everyone. Any member",
    request: {
      params: z.object({ tenant }),
      query: z.object({ origin: z.enum(['own', 'built-in', 'shared']).optional() }),
    },
    responses: {
      200: json(
        z.object({ data: z.array(BlockSummary) }),
        'Own, then built-in, then shared, by title',
      ),
      ...memberErrors,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/blocks/{publisher}/{id}',
    summary:
      "One block with the editions the organisation may use, one edition in full and where the organisation's services pin it. Any member",
    request: {
      params: z.object({ tenant, publisher, id: pathParam('id', 'sporsmal-kort') }),
      query: z.object({
        version: z
          .string()
          .optional()
          .openapi({ description: 'The edition; the newest the caller may use without it' }),
      }),
    },
    responses: { 200: json(BlockDetail, 'The block'), ...memberErrors },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/blocks/preview',
    summary:
      "Check an unsaved block of the organisation and return what a host would draw it from, with genki's made-up data for each state. Saves nothing. Needs manage-services",
    request: {
      params: z.object({ tenant }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              definition: z.union([z.record(z.string(), z.unknown()), z.string()]),
              files: z.record(z.string(), z.string()).optional(),
              states: z.array(z.enum(blockStates)).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          valid: z.boolean(),
          errors: z.array(fieldError).optional(),
          render: RefBlockPayload.optional(),
          reads: z.array(z.string()),
          fixtures: z.record(z.string(), z.record(z.string(), z.unknown())),
        }),
        'The checks and the preview',
      ),
      400: problem('The body could not be read'),
      ...writeErrors,
      403: problem(
        "Missing manage-services, or the block's metadata.tenant is another organisation",
      ),
      422: problem('The definition is not a Block'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/blocks/import',
    summary:
      "Turn a design's HTML into a proposed first edition of the organisation's declarative block. A design that needs code is refused for now. Nothing the design points to is fetched, and nothing is saved. Only while blockStudio is on for the caller. Needs manage-services",
    request: {
      params: z.object({ tenant }),
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              html: z.string().openapi({ description: 'The design as HTML text, at most 512 KiB' }),
              id: z
                .string()
                .regex(/^[a-z0-9][a-z0-9-]{0,62}$/)
                .openapi({ example: 'kildekort' }),
              title: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(
        z.object({
          tier: z.enum(['declarative']),
          definition: z.record(z.string(), z.unknown()),
          files: z.record(z.string(), z.string()),
          report: z.array(
            z.object({
              kind: z.enum(['converted', 'dropped', 'text', 'data']),
              code: z.string(),
              where: z.string(),
              message: z.string(),
            }),
          ),
        }),
        'The proposed block, valid as it stands, and what the import did',
      ),
      403: problem('Missing manage-services'),
      404: problem(
        'Not signed in, blockStudio is off for the caller, or the tenant is not reachable for the caller',
      ),
      413: problem('The body is larger than 1 MiB'),
      422: problem(
        'The html, id or title is missing or malformed, or the design is larger than 512 KiB, empty, needs code, or is not valid as a block',
      ),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/services/{id}/draft/blocks/{publisher}/{blockId}',
    summary:
      "Pin an edition of a block in the service's draft, or move a pin of the same block to that edition. The version in use is unchanged until the draft is published. Needs manage-services; audited",
    request: {
      params: pinParams,
      headers: changeReason,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              version: z.number().int().positive(),
              zone: zone.optional().openapi({
                description: "Where it stands; where it stood, or the edition's first zone",
              }),
              settings: z.record(z.string(), z.union([z.boolean(), z.string()])).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(PinnedDraft, 'The draft with the pin'),
      400: problem('Invalid version, zone or settings, or no change-reason'),
      ...writeErrors,
      404: problem(
        'The tenant is not reachable for the caller, no edition the caller may use, or no such service',
      ),
      409: problem('The draft was changed by someone else'),
      422: problem(
        'The service has no layout, the edition cannot stand there, or a setting is not one of its props',
      ),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/services/{id}/draft/blocks/{publisher}/{blockId}',
    summary:
      "Take a block out of the service's draft, starting the draft from the latest version when there is none. Needs manage-services; audited",
    request: {
      params: pinParams,
      headers: changeReason,
      body: { required: false, content: { 'application/json': { schema: z.object({}) } } },
    },
    responses: {
      200: json(PinnedDraft, 'The draft without the pin'),
      400: problem('No change-reason'),
      ...writeErrors,
      404: problem('The tenant is not reachable for the caller, or the block is not in the draft'),
      409: problem('The draft was changed by someone else'),
    },
  }),
];
