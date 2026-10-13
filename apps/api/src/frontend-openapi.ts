import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import type { PlatformModuleFactory } from './platform-modules.js';

const V1Error = z
  .object({
    error: z.object({
      message: z.string(),
      type: z.string(),
      param: z.string().nullable(),
      code: z.string(),
    }),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('V1Error');

export const v1ErrorContent = { 'application/json': { schema: V1Error } };
const v1Error = (description: string) => ({ description, content: v1ErrorContent });

const FrontendProblem = z
  .object({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    code: z.string().optional(),
    error: z.string().optional().describe('Same text as `title`; kept for headless-rag clients.'),
    errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  })
  .openapi('FrontendProblem');
const frontendProblem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: FrontendProblem } },
});

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});

export const InputField = z
  .object({
    id: z.string(),
    label: z.string(),
    kind: z.enum([
      'text',
      'long-text',
      'choice',
      'multi-choice',
      'number',
      'year',
      'date',
      'organisation',
    ]),
    required: z.boolean().optional(),
    help: z.string().optional(),
    options: z.array(z.string()).optional(),
    optionsFrom: z
      .object({
        dataset: z.string(),
        facet: z.string(),
        min: z.number().optional(),
        max: z.number().optional(),
        pattern: z.string().optional(),
      })
      .optional(),
    default: z.union([z.string(), z.number(), z.array(z.string())]).optional(),
    dependsOn: z.string().optional(),
  })
  .openapi('InputField');

const DatasetFilter = z.object({
  field: z.string(),
  kinds: z.array(z.string()),
  'value-type': z
    .enum(['string', 'integer'])
    .describe('Send as `value-type` in `filters`; integer fields take integer options.'),
});

const ServiceDataset = z
  .object({
    id: z.string().describe('The dataset id, as in `/api/datasets/{id}`.'),
    tenant: z.string().describe('The owner tenant: `tenant` for `/api/facets` and the ask body.'),
    'dataset-config-key': z
      .string()
      .describe('`dataset-config-key` for `/api/facets`, `dataset_config_key` in the ask body.'),
    filters: z.array(DatasetFilter),
  })
  .openapi('ServiceDataset');

const Model = z
  .object({
    id: z.string().describe('Send as `model`. Format `<service>__<variant>`.'),
    object: z.literal('model'),
    created: z.number().int(),
    owned_by: z.string(),
    title: z.string().optional(),
    description: z.string().optional().describe('The purpose of the service, as plain text.'),
    _agent_id: z
      .string()
      .optional()
      .describe('Same as `_service`, kept for headless-rag compatibility.'),
    _mode: z
      .string()
      .optional()
      .describe('Same as `_variant`, kept for headless-rag compatibility.'),
    _service: z.string().optional().describe('The service id. Group rows by this field.'),
    _service_title: z
      .string()
      .optional()
      .describe('The service name, the same on every row of the service.'),
    _variant: z.string().optional().describe('The variant id within the service.'),
    _variant_title: z
      .string()
      .optional()
      .describe('The variant name only, in the language of `Accept-Language`.'),
    _pickable: z
      .boolean()
      .describe(
        'Always present. `true` when an end user may pick this variant in chat. Never show a variant as a separate service.',
      ),
    _alias_of: z
      .string()
      .optional()
      .describe('On an alias row: the `id` it points to. Skip these rows in pickers.'),
    _default: z.literal(true).optional().describe('One entry per service: list these.'),
    _chat: z
      .boolean()
      .describe('Always present. `true` when the service wants a place in chat screens.'),
    _batch: z.literal(true).optional(),
    input_fields: z.array(InputField).optional(),
    _datasets: z
      .array(ServiceDataset)
      .optional()
      .describe('The datasets the service searches. Absent: the service takes no `filters`.'),
    _documents: z
      .object({
        accepts: z.array(z.string()),
        max_bytes: z.number().int(),
        max_count: z.number().int(),
      })
      .optional(),
    status: z.literal('paused').optional(),
    status_reason: z.string().optional(),
  })
  .openapi('Model');

const ModelList = z
  .object({ object: z.literal('list'), data: z.array(Model) })
  .openapi('ModelList');

const Source = z
  .object({
    index: z.number().int().optional().describe('The N in `[N]` in the answer text.'),
    title: z.string(),
    url: z.string().optional().describe('Present only for an http or https link people can open.'),
    document_id: z.string().optional(),
    excerpts: z.array(
      z.object({ chunk_id: z.string(), text: z.string(), position: z.number().int().optional() }),
    ),
  })
  .passthrough()
  .openapi('Source');

const ChatRequest = z
  .object({
    model: z.string(),
    messages: z
      .array(z.object({ role: z.enum(['system', 'user', 'assistant']), content: z.unknown() }))
      .optional()
      .describe('Required unless the service has an input form and `input` is sent.'),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Form values, keyed by `input_fields[].id`.'),
    conversation_id: z.string().optional(),
    genai_conversation: z.boolean().optional(),
    filters: z.object({ fields: z.array(z.record(z.string(), z.unknown())) }).optional(),
    tenant: z.string().optional(),
    dataset_config_key: z.string().optional(),
    stream: z.boolean().optional(),
    genai_stream: z.enum(['live']).optional(),
    genai_steps: z.boolean().optional(),
    genai_documents: z
      .array(z.object({ name: z.string(), media_type: z.string(), data: z.string() }))
      .optional(),
    metadata: z.object({ version: z.string() }).partial().optional(),
  })
  .passthrough()
  .openapi('ChatRequest');

const ChatResponse = z
  .object({
    id: z.string(),
    object: z.literal('chat.completion'),
    created: z.number().int(),
    model: z.string(),
    choices: z.array(
      z.object({
        index: z.number().int(),
        message: z.object({ role: z.literal('assistant'), content: z.string() }),
        finish_reason: z.string(),
      }),
    ),
    usage: z.record(z.string(), z.unknown()).optional(),
    conversation_id: z.string().optional(),
    citations: z.array(z.string()).optional(),
    sources: z.array(Source).optional(),
    no_answer: z.boolean().optional(),
    notice: z.string().optional(),
    table: z
      .object({
        columns: z.array(z.object({ key: z.string(), label: z.string() })),
        rows: z.array(
          z.object({
            document: z.string().optional(),
            cells: z.record(
              z.string(),
              z.object({ value: z.unknown(), sources: z.array(z.unknown()) }),
            ),
          }),
        ),
      })
      .optional(),
    csv: z.string().optional(),
    ai_generated: z.literal(true),
  })
  .openapi('ChatResponse');

const Conversation = z
  .object({
    id: z.string(),
    topic: z.string(),
    agentId: z.string().describe('Same as `serviceId`, kept for headless-rag compatibility.'),
    serviceId: z.string(),
    userId: z.string(),
    tags: z.array(z.string()),
    created: z.number().int(),
  })
  .openapi('Conversation');

const StoredMessage = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant']).nullable(),
    text: z.string(),
    created: z.number().int(),
    tags: z.array(z.string()),
    filterValue: z.unknown().nullable(),
    chunks: z.array(
      z.object({
        chunkId: z.string(),
        docTitle: z.string(),
        docNum: z.string().nullable(),
        contentMarkdown: z.string(),
      }),
    ),
    sources: z
      .array(Source)
      .optional()
      .describe('Assistant messages: the sources as the answer gave them, so `[N]` resolves.'),
    task: z.string().optional().describe('Assistant messages: the task id to send as feedback.'),
    attachments: z.array(z.string()).optional(),
    input: z.record(z.string(), z.unknown()).optional().describe('User messages: the form values.'),
  })
  .openapi('StoredMessage');

const idParam = z.object({
  id: z.string().openapi({ param: { name: 'id', in: 'path' }, example: 'x7Gk2' }),
});
const Facet = z.object({
  field: z.string(),
  options: z.array(z.object({ value: z.string(), count: z.number(), selected: z.boolean() })),
});

export const frontendRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/v1/models',
    summary: 'List the services the credential may use',
    responses: {
      200: json(ModelList, 'OpenAI model list with the platform extension fields'),
      401: v1Error('Invalid or missing credentials'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/v1/chat/completions',
    summary: 'Ask a service, whole or streamed',
    request: { body: { required: true, content: { 'application/json': { schema: ChatRequest } } } },
    responses: {
      200: {
        description:
          'The answer. With `stream: true` the body is `text/event-stream` of `chat.completion.chunk` frames ending with `data: [DONE]`.',
        content: {
          'application/json': { schema: ChatResponse },
          'text/event-stream': { schema: z.string() },
        },
      },
      400: v1Error(
        'invalid_input, invalid_filters, invalid_version, invalid_documents, missing_model, missing_messages, invalid_messages, conversations_unavailable',
      ),
      401: v1Error('Invalid or missing credentials'),
      403: v1Error('The credential may not reach the service or dataset'),
      404: v1Error('model_not_found, agent_not_found, conversation_not_found'),
      409: v1Error('version_not_found'),
      503: v1Error('service_paused'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/api/conversations',
    summary: 'List the conversations of the key and X-User-Id',
    request: {
      query: z.object({
        page_size: z.string().optional().openapi({ example: '50' }),
        page_index: z.string().optional().openapi({ example: '0' }),
        tags: z.string().optional(),
      }),
    },
    responses: {
      200: json(
        z.object({
          conversations: z.array(Conversation),
          total: z.number().int(),
          pageSize: z.number().int(),
          pageIndex: z.number().int(),
        }),
        'Newest first',
      ),
      400: frontendProblem('Invalid page parameter'),
      401: frontendProblem('Invalid or missing credentials'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/api/conversations',
    summary: 'Create an empty conversation',
    request: {
      body: {
        content: {
          'application/json': {
            schema: z.object({
              service: z
                .string()
                .optional()
                .describe('The service id or a model `id`. `agent-id` and `agent` also work.'),
              'agent-id': z.string().optional(),
              title: z.string().optional(),
              tags: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(z.object({ conversation: Conversation }), 'Created'),
      400: frontendProblem('Unknown or ambiguous service, or a malformed body'),
      401: frontendProblem('Invalid or missing credentials'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/api/conversations/{id}',
    summary: 'Read a conversation with its messages',
    request: {
      params: idParam,
      query: z.object({ branches: z.enum(['all']).optional() }),
    },
    responses: {
      200: json(
        z.object({ conversation: Conversation, messages: z.array(StoredMessage) }),
        'The system prompt is never returned',
      ),
      401: frontendProblem('Invalid or missing credentials'),
      404: frontendProblem('conversation_not_found'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/api/conversations/{id}',
    summary: 'Rename a conversation or change its tags',
    request: {
      params: idParam,
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              title: z.string().optional(),
              topic: z.string().optional().describe('Same as `title`.'),
              tags: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      200: json(z.object({ conversation: Conversation }), 'Updated'),
      400: frontendProblem('unknown_field for any other key, or a value of the wrong type'),
      401: frontendProblem('Invalid or missing credentials'),
      404: frontendProblem('conversation_not_found'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/api/conversations/{id}',
    summary: 'Delete a conversation',
    request: { params: idParam },
    responses: {
      200: json(z.object({ success: z.literal(true) }), 'Deleted'),
      401: frontendProblem('Invalid or missing credentials'),
      404: frontendProblem('conversation_not_found'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/api/datasets',
    summary: 'List the datasets the credential may use',
    responses: {
      200: json(
        z.object({
          datasets: z.array(
            z.object({
              id: z.string(),
              tenant: z.string().optional(),
              name: z.string(),
              description: z.string().nullable(),
              'enabled?': z.literal(true),
              status: z.string(),
            }),
          ),
        }),
        'Datasets',
      ),
      401: frontendProblem('Invalid or missing credentials'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/api/datasets/{id}',
    summary: 'One dataset and the filter fields it declares',
    request: { params: idParam },
    responses: {
      200: json(
        z.object({
          dataset: z.object({
            id: z.string(),
            tenant: z.string().optional(),
            name: z.string(),
            description: z.string().nullable(),
            'enabled?': z.literal(true),
            status: z.string(),
            filters: z.array(DatasetFilter),
          }),
        }),
        'The dataset',
      ),
      401: frontendProblem('Invalid or missing credentials'),
      404: frontendProblem('dataset_not_found'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/api/facets',
    summary: 'Facet values to build filters',
    request: {
      query: z.object({
        tenant: z.string(),
        'dataset-config-key': z.string(),
        fields: z.string().openapi({ example: 'type,year' }),
        filter: z.string().optional().describe('JSON, same shape as `filters` in a chat request.'),
      }),
    },
    responses: {
      200: json(z.object({ fields: z.array(Facet) }), 'Values per field'),
      400: frontendProblem('invalid_request'),
      401: frontendProblem('Invalid or missing credentials'),
      403: frontendProblem('dataset_not_authorized'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/api/feedback',
    summary: 'Rate an answer',
    request: {
      body: {
        required: true,
        content: {
          'application/json': {
            schema: z.object({
              task: z.string().describe('The `genai-task` response header.'),
              rating: z.enum(['up', 'down']),
              comment: z.string().optional(),
              reasons: z.array(z.string()).optional(),
            }),
          },
        },
      },
    },
    responses: {
      201: json(z.object({ ok: z.literal(true), task: z.string() }), 'Recorded'),
      400: frontendProblem('A missing task or a rating that is not up or down'),
      401: frontendProblem('Invalid or missing credentials'),
      403: frontendProblem('The run was made with another credential'),
      404: frontendProblem('No such task'),
    },
  }),
];

export const frontendOpenApiModule: PlatformModuleFactory = () => ({
  id: 'frontend-openapi',
  mount: (app) => {
    const registry = (app as { openAPIRegistry?: { registerPath(r: RouteConfig): void } })
      .openAPIRegistry;
    if (registry) for (const route of frontendRoutes) registry.registerPath(route);
  },
});
