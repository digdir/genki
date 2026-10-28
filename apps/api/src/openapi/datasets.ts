import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { sourceLinkRules } from '@genai/contracts';
import { filterKinds, filterValueTypes } from '@genai/port-knowledge';
import { capabilities, parameterRules, residencies } from '@genai/port-model';
import { catalogKinds } from '../catalog-registry.js';
import { datasetFields } from '../config-routes.js';
import { applyBody, proposeBody, revertBody, verifyBody } from '../dataset-enrichment.js';
import { switchStates } from '../engine-switches.js';
import { changeReason, Problem, problemContent } from '../http.js';
import { pipelineSpec } from '../ingestion.js';
import { engineCapabilities } from '../knowledge-endpoints.js';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const audited = <T extends z.ZodType>(schema: T, description: string) => ({
  ...json(schema, description),
  headers: z.object({
    'genai-task': z.string().openapi({ description: 'The audited task that recorded the change' }),
  }),
});
const problem = (description: string) => ({ description, content: problemContent });
const either = (description: string) => ({
  description,
  content: problemContent,
});
const empty = (description: string) => ({ description });

const param = (example: string) => z.string().openapi({ example });
const tenant = param('991825827');
const reasonHeader = changeReason;
const ifMatch = z.object({
  'change-reason': changeReason.shape['change-reason'],
  'if-match': z
    .string()
    .optional()
    .openapi({ description: 'The version you read; 409 if it moved' }),
});
const body = <T extends z.ZodType>(schema: T, contentType = 'application/json') => ({
  required: true,
  content: { [contentType]: { schema } },
});

const Residency = z.enum(residencies);
const Embedding = z.object({ model: z.string(), dimensions: z.number().int() });

const CatalogItem = z
  .object({
    kind: z.enum(catalogKinds),
    id: z.string(),
    scope: z.string(),
    origin: z.enum(['seed', 'api']),
    version: z.number().int(),
    spec: z.record(z.string(), z.unknown()),
    by: z.string().optional(),
    at: z.string().optional(),
    reason: z.string().optional(),
  })
  .openapi('CatalogItem');

const CatalogVersion = z
  .object({
    kind: z.string(),
    scope: z.string(),
    id: z.string(),
    version: z.number().int(),
    spec: z.unknown(),
    deleted: z.boolean(),
    by: z.string(),
    at: z.string(),
    reason: z.string(),
  })
  .openapi('CatalogVersion');

const CatalogSpec = z
  .record(z.string(), z.unknown())
  .openapi('CatalogSpec', { description: 'The entry spec; its shape depends on the kind' });

const DatasetIndex = z.object({
  endpoint: z.string(),
  collections: z.record(z.string(), z.string()).optional(),
  options: z.record(z.string(), z.unknown()).optional(),
});

const Dataset = z
  .object({
    id: z.string(),
    fullId: z.string(),
    scope: z.string(),
    origin: z.enum(['seed', 'api']),
    version: z.number().int(),
    name: z.string(),
    description: z.string().optional(),
    aliases: z.array(z.string()),
    residency: Residency,
    index: DatasetIndex,
    collection: DatasetIndex.openapi({ description: 'The same as index, kept for older clients' }),
    embedding: Embedding.optional(),
    facets: z.array(z.string()),
    filters: z.record(z.string(), z.union([z.enum(filterKinds), z.array(z.enum(filterKinds))])),
    valueTypes: z.record(z.string(), z.enum(filterValueTypes)).optional(),
    maxFacetValues: z.number().int().optional(),
    links: z.enum(sourceLinkRules).optional(),
  })
  .openapi('Dataset');

const DatasetInput = datasetFields.extend({}).openapi('DatasetInput', {
  description: 'Give the search engine as index, collection (older name) or endpoint',
});
const DatasetChange = datasetFields
  .partial()
  .openapi('DatasetChange', { description: 'Only the fields to change; the rest are kept' });

const executionStatuses = ['running', 'succeeded', 'failed', 'cancelled'] as const;
const LastExecution = z.object({
  status: z.enum(executionStatuses),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  stored: z.number().int().nullable(),
  skipped: z.number().int().nullable(),
});
const SkippedDocument = z.object({
  document: z.string(),
  reason: z.enum([
    'no_text',
    'unsupported_type',
    'outside_access',
    'conversion_failed',
    'unreachable',
  ]),
});

const DatasetWithStatus = Dataset.extend({
  effectiveResidency: Residency,
  embeddingResidency: Residency.nullable().optional(),
  editable: z.boolean(),
  state: z.enum(['needs-pipeline', 'configured', 'running', 'ready', 'degraded', 'external']),
  source: z.enum([
    'website',
    'upload',
    'kudos',
    'folder',
    'database',
    'parquet',
    'episerver',
    'none',
  ]),
  documents: z.number().int().nullable(),
  chunks: z.number().int().nullable(),
  lastExecution: LastExecution.nullable(),
  nextRunAt: z.string().nullable(),
}).openapi('DatasetWithStatus');

const DatasetDetail = DatasetWithStatus.extend({
  skipped: z.array(SkippedDocument),
}).openapi('DatasetDetail');

const PipelineSpec = pipelineSpec.extend({}).openapi('IngestionPipelineSpec', {
  description:
    'Parquet sources accept url (one file), urls with a stable table name, or huggingface with dataset and file, or dataset, table and files (a glob or list). Shards are sorted and downloaded sequentially. mapping.maxRows caps rows across the table before filtering; maxBytes caps each file on disk (default 1 GiB, maximum 20 GiB), never above the platform ceiling. Pages and row groups have decompression limits. Duplicate row ids in sharded tables or any shard failure fail the run without promotion. Single-file document ids stay unchanged.',
});
const Pipeline = z
  .object({
    dataset: z.string(),
    id: z.string(),
    version: z.number().int(),
    spec: PipelineSpec,
    by: z.string(),
    at: z.string(),
    reason: z.string(),
  })
  .openapi('IngestionPipelineVersion');
const PipelineVersion = Pipeline.extend({
  deleted: z.boolean().describe('True on the version that removed the pipeline'),
}).openapi('IngestionPipelineHistoryEntry');
const PipelineInput = pipelineSpec.extend({ id: z.string() }).openapi('IngestionPipelineInput');
const PipelineChange = pipelineSpec
  .extend({ id: z.string().optional() })
  .openapi('IngestionPipelineChange', { description: 'The whole spec; id is ignored' });
const ScheduledPipeline = Pipeline.extend({ nextRunAt: z.string().nullable() }).openapi(
  'IngestionPipeline',
);
const BackendStatus = z
  .object({ name: z.string(), available: z.boolean(), reason: z.string().optional() })
  .openapi('IngestionBackendStatus');
const Execution = z
  .object({
    id: z.string(),
    dataset: z.string(),
    pipeline: z.string(),
    pipelineVersion: z.number().int(),
    backend: z.string(),
    status: z.enum(executionStatuses),
    startedBy: z.string(),
    startedAt: z.string(),
    endedAt: z.string().optional(),
    report: z
      .object({
        stored: z.number().int(),
        skipped: z.number().int(),
        skippedDocuments: z.array(SkippedDocument).optional(),
        failed: z.array(z.string()),
        generation: z.string().optional(),
        promoted: z.boolean().optional(),
        previous: z.string().optional(),
        usage: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
      })
      .optional(),
    error: z.string().optional(),
    cancelledBy: z.string().optional(),
  })
  .openapi('IngestionExecution');
const PipelineEstimate = z
  .object({
    pipeline: z.string(),
    source: z.string(),
    estimate: z.literal(true),
    documents: z.number().int(),
    exact: z.boolean(),
    basis: z.object({
      listed: z.number().int(),
      sampled: z.number().int(),
      matching: z.number().int(),
    }),
  })
  .openapi('IngestionPipelineEstimate');

const CapabilitySummary = z.object({
  supported: z.array(z.enum(engineCapabilities)),
  missing: z.array(z.enum(engineCapabilities)),
});

const EngineDescription = z
  .object({
    engine: z.string(),
    title: z.string(),
    tech: z.string().optional(),
    builtin: z.boolean(),
    runsAt: z.string().optional(),
    dataLocation: Residency.optional(),
    writeKeyRequired: z.boolean(),
    probe: z.boolean(),
    requiresBaseURL: z.boolean(),
    endpoint: z.record(z.string(), z.unknown()).optional(),
    endpointOptions: z.record(z.string(), z.unknown()).optional(),
    datasetOptions: z.record(z.string(), z.unknown()).optional(),
    capabilities: z.array(z.string()),
    writer: z.object({ needsVectors: z.boolean() }).optional(),
  })
  .openapi('KnowledgeEngine', {
    description: 'endpoint, endpointOptions and datasetOptions are JSON Schemas for the forms',
  });

const KnowledgeEndpoint = z
  .object({
    id: z.string(),
    name: z.string(),
    scope: z.string(),
    engine: z.string(),
    title: z.string(),
    tech: z.string().optional(),
    builtin: z.boolean(),
    runsAt: z.string(),
    dataLocation: Residency.optional(),
    embeddingModel: z.string().optional(),
    writeKeyRequired: z.boolean(),
    capabilities: CapabilitySummary,
    datasetCount: z.number().int(),
    status: z.enum(['ok', 'unused', 'skipped']),
    shared: z.boolean(),
    version: z.number().int(),
  })
  .openapi('KnowledgeEndpoint');

const EndpointTest = z
  .object({
    ok: z.boolean(),
    engine: z.string().optional(),
    code: z
      .enum([
        'rate_limited',
        'unavailable',
        'bad_request',
        'unauthorized',
        'cancelled',
        'residency',
        'forbidden',
        'unsupported',
      ])
      .optional(),
    message: z.string(),
    ms: z.number(),
  })
  .openapi('KnowledgeEndpointTest');

const EndpointInUse = Problem.extend({
  datasets: z.array(
    z.object({ dataset: z.string(), name: z.string(), tenant: z.string(), tenantName: z.string() }),
  ),
}).openapi('KnowledgeEndpointInUse');

const Range = z.object({ min: z.number(), max: z.number() });
const Side = z.object({ first: z.string().optional(), rank: z.number().nullable() });
const Verdict = z.enum(['same', 'better', 'worse']);
const SwitchDecision = z.object({
  action: z.enum(['activate', 'rollback', 'cancel']),
  by: z.string(),
  at: z.string(),
  reason: z.string(),
});
const SwitchMethod = z.enum(['copy', 'reingest']);
const EngineSwitch = z
  .object({
    id: z.string(),
    sid: z.string(),
    version: z.number().int(),
    dataset: z.string(),
    from: z.string(),
    to: z.string(),
    method: SwitchMethod,
    state: z.enum(switchStates),
    reason: z.string().optional(),
    embedding: Embedding.optional(),
    estimate: z.object({ costNok: Range, durationMinutes: Range }),
    progress: z.object({
      percent: z.number(),
      documents: z.number().int(),
      total: z.number().int().optional(),
    }),
    attempt: z.number().int(),
    startedAt: z.string(),
    startedBy: z.string(),
    updatedAt: z.string(),
    error: z.object({ message: z.string(), percent: z.number() }).optional(),
    comparison: z
      .object({
        testSets: z.array(z.string()),
        cases: z.number().int(),
        k: z.number().int(),
        hitAt5: z.tuple([z.number(), z.number()]),
        meanRank: z.tuple([z.number().nullable(), z.number().nullable()]),
        latencyMs: z.tuple([z.number(), z.number()]),
        errors: z.tuple([z.number(), z.number()]),
        verdict: Verdict,
        examples: z.array(
          z.object({
            case: z.string(),
            question: z.string(),
            old: Side,
            new: Side,
            verdict: Verdict,
          }),
        ),
      })
      .optional(),
    comparisonNote: z.string().optional(),
    minimumReasonLength: z.number().int(),
    previousKeptUntil: z.string().optional(),
    canRollback: z.boolean(),
    decision: SwitchDecision.optional(),
  })
  .openapi('EngineSwitch');

const MethodEstimate = z.object({
  available: z.boolean(),
  reason: z.string().optional(),
  costNok: Range,
  durationMinutes: Range,
});
const SwitchEstimate = z
  .object({
    dataset: z.string(),
    from: z.string(),
    to: z.string(),
    estimate: z.literal(true),
    basis: z.object({ documents: z.number().int(), counted: z.boolean() }),
    method: SwitchMethod.optional(),
    copy: MethodEstimate,
    reingest: MethodEstimate,
  })
  .openapi('EngineSwitchEstimate');

const DatasetEngine = z
  .object({
    dataset: z.string(),
    endpoint: z.string(),
    engine: z.string(),
    title: z.string(),
    tech: z.string().optional(),
    builtin: z.boolean(),
    runsAt: z.string(),
    dataLocation: Residency.optional(),
    embedding: Embedding.nullable(),
    capabilities: CapabilitySummary,
    latencyMs: z.number().optional(),
    usedBy: z.array(z.object({ tenant: z.string(), id: z.string(), name: z.string() })),
    canSwitch: z.boolean(),
    retentionDays: z.number().int(),
    activeSwitch: EngineSwitch.optional(),
    previous: z
      .object({
        endpoint: z.string(),
        title: z.string(),
        keptUntil: z.string(),
        switch: z.string(),
      })
      .optional(),
  })
  .openapi('DatasetEngine');

const StartSwitch = z
  .object({
    to: z.string().openapi({ description: 'The knowledge endpoint to move to' }),
    method: SwitchMethod,
    embedding: Embedding.optional(),
    options: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('EngineSwitchStart');

const Upload = z.object({ name: z.string(), size: z.number().int(), type: z.string() });
const UploadResult = z
  .object({
    uploaded: z.array(Upload),
    skipped: z.array(
      z.object({
        name: z.string(),
        reason: z.enum(['unsupported_type', 'too_large', 'empty', 'bad_name']),
      }),
    ),
  })
  .openapi('DatasetUploadResult');
const UploadedFile = Upload.extend({ uploadedAt: z.string() }).openapi('DatasetUpload');

const QuestionProposal = z
  .object({
    chunkId: z.string(),
    docNum: z.string().optional(),
    questions: z.array(z.string()),
    provenance: z
      .object({
        model: z.string().optional(),
        promptHash: z.string().optional(),
        generatedAtMs: z.number().int().optional(),
        questionCount: z.number().int().optional(),
      })
      .optional(),
  })
  .openapi('QuestionProposal');
const EnrichmentRow = z.object({
  id: z.string(),
  chunk_id: z.string(),
  doc_num: z.string(),
  question: z.string(),
  model: z.string(),
  generated_at: z.number(),
  prompt_hash: z.string().optional(),
});
const VerifyResult = z
  .object({
    baselineFound: z.boolean().nullable(),
    baselineRank: z.number().nullable(),
    baselineIndex: z.number().int().nullable(),
    enrichedFound: z.boolean(),
    enrichedRank: z.number().nullable(),
    enrichedIndex: z.number().int().nullable(),
    rankDelta: z.number().nullable(),
    positionDelta: z.number().int().nullable(),
    newlyFindable: z.boolean().nullable(),
    matchedQuestion: z.string().nullable(),
    improved: z.boolean().nullable(),
    evalGatePass: z.boolean().nullable(),
    keep: z.boolean(),
    skipped: z.string().optional(),
  })
  .openapi('EnrichmentVerification');

const ModelEndpointInput = z
  .object({
    id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,62}$/),
    protocol: z.enum(['openai-chat', 'anthropic-messages']),
    baseURL: z.string().openapi({ description: 'HTTPS, without credentials' }),
    auth: z.object({
      kind: z.enum(['api-key', 'bearer']),
      secret: z.string().openapi({ example: 'secret://platform/sigma2-key' }),
    }),
  })
  .openapi('ModelEndpointInput');
const ModelEndpointInUse = Problem.extend({
  services: z.array(z.object({ service: z.string(), tenant: z.string(), tenantName: z.string() })),
  models: z.array(z.object({ id: z.string(), tenant: z.string() })),
}).openapi('ModelEndpointInUse');
const PlatformModelInput = z
  .object({
    endpoint: z.string(),
    deployment: z.string(),
    family: z.string().optional(),
    residency: Residency,
    capabilities: z.array(z.enum(capabilities)).optional(),
    enabled: z.boolean().optional(),
  })
  .openapi('PlatformModelInput');
const Price = z.object({ inputPerThousand: z.number(), outputPerThousand: z.number() });
const PublicModel = z
  .object({
    id: z.string(),
    name: z.string(),
    family: z.string().optional(),
    residency: Residency,
    capabilities: z.array(z.enum(capabilities)),
    parameters: parameterRules,
    price: Price.nullable(),
  })
  .openapi('AvailableModel');

const list = <T extends z.ZodType>(item: T) => z.object({ data: z.array(item) });

const tenantBase = { path: '/tenants/{tenant}', params: { tenant } };
const operatorBase = { path: '/operator', params: {} };
type Base = typeof tenantBase | typeof operatorBase;
const isTenant = (base: Base) => base.path !== '/operator';
const who = (base: Base, right?: string) =>
  isTenant(base) ? (right ? `needs ${right}` : 'any member of the tenant') : 'operators';
type Refusal = (description: string) => {
  description: string;
  content: Record<string, { schema: z.ZodType }>;
};
const guarded = (base: Base, right?: string, as: Refusal = either) =>
  isTenant(base)
    ? {
        401: as('Not signed in'),
        ...(right ? { 403: as(`Missing the right ${right}`) } : {}),
        404: as('No such tenant for you, or not found'),
      }
    : {
        401: as('Not signed in'),
        403: as('Not an operator'),
        404: as('Not found'),
      };

const withoutNotFound = <T extends object>(base: Base, responses: T) =>
  isTenant(base)
    ? responses
    : Object.fromEntries(Object.entries(responses).filter(([status]) => status !== '404'));

const pipelineRoutes = (base: Base): RouteConfig[] => {
  const scope = isTenant(base) ? "the tenant's own dataset" : 'a platform dataset';
  const root = `${base.path}/datasets/{dataset}/pipelines`;
  const dataset = param('sider');
  const params = (extra: Record<string, z.ZodString> = {}) =>
    z.object({ ...base.params, dataset, ...extra });
  const id = param('nettsider');
  return [
    createRoute({
      method: 'get',
      path: root,
      summary: `Ingestion pipelines of ${scope}, with next scheduled run and backend status (${who(base)})`,
      request: { params: params() },
      responses: {
        200: json(
          z.object({ data: z.array(ScheduledPipeline), backend: BackendStatus }),
          'Pipelines',
        ),
        ...guarded(base),
      },
    }),
    createRoute({
      method: 'post',
      path: root,
      summary: `Create an ingestion pipeline on ${scope} (${who(base, 'manage-datasets')}, audited)`,
      request: {
        params: params(),
        headers: ifMatch,
        body: body(PipelineInput),
      },
      responses: {
        201: audited(ScheduledPipeline, 'Created'),
        400: either('Invalid pipeline or missing reason'),
        ...guarded(base, 'manage-datasets'),
        409: either('A pipeline with that id exists, or the version moved'),
        422: either('A Kudos source without document types or start date'),
      },
    }),
    createRoute({
      method: 'get',
      path: `${root}/{id}`,
      summary: `One ingestion pipeline with its next scheduled run (${who(base)})`,
      request: { params: params({ id }) },
      responses: { 200: json(ScheduledPipeline, 'Pipeline'), ...guarded(base) },
    }),
    createRoute({
      method: 'put',
      path: `${root}/{id}`,
      summary: `Change an ingestion pipeline (${who(base, 'manage-datasets')}, audited)`,
      request: {
        params: params({ id }),
        headers: ifMatch,
        body: body(PipelineChange),
      },
      responses: {
        200: audited(ScheduledPipeline, 'Saved'),
        400: either('Invalid pipeline or missing reason'),
        ...guarded(base, 'manage-datasets'),
        409: either('The version moved'),
        422: either('A Kudos source without document types or start date'),
      },
    }),
    createRoute({
      method: 'delete',
      path: `${root}/{id}`,
      summary: `Remove an ingestion pipeline (${who(base, 'manage-datasets')}, audited)`,
      request: { params: params({ id }), headers: reasonHeader },
      responses: {
        200: audited(z.object({ deleted: z.string() }), 'Removed'),
        400: either('Missing reason'),
        ...guarded(base, 'manage-datasets'),
        404: either('No such dataset or pipeline'),
      },
    }),
    createRoute({
      method: 'get',
      path: `${root}/{id}/estimate`,
      summary: `Estimate how many documents the pipeline source holds (${who(base, 'manage-datasets')})`,
      request: { params: params({ id }) },
      responses: {
        200: json(PipelineEstimate, 'Estimate'),
        ...guarded(base, 'manage-datasets'),
        409: either('This source cannot be estimated'),
      },
    }),
    createRoute({
      method: 'get',
      path: `${root}/{id}/versions`,
      summary: `Every saved version of a pipeline, oldest first; a removal is the last version and has deleted: true (${who(base)})`,
      request: { params: params({ id }) },
      responses: { 200: json(list(PipelineVersion), 'Versions'), ...guarded(base) },
    }),
    createRoute({
      method: 'post',
      path: `${root}/{id}/execute`,
      summary: `Start an ingestion run now; it continues in the background (${who(base, 'manage-datasets')}, audited)`,
      request: { params: params({ id }), headers: reasonHeader },
      responses: {
        202: audited(Execution, 'Started'),
        400: either('Missing reason'),
        ...guarded(base, 'manage-datasets'),
        404: either('No such dataset or pipeline'),
        409: either('Ingestion is not available for this dataset, or a run is already going'),
      },
    }),
    createRoute({
      method: 'post',
      path: `${root}/{id}/executions/{execution}/cancel`,
      summary: `Stop a running ingestion run (${who(base, 'manage-datasets')}, audited)`,
      request: {
        params: params({ id, execution: param('a1b2c3') }),
        headers: reasonHeader,
      },
      responses: {
        200: audited(Execution, 'The run as it was when cancelled'),
        400: either('Missing reason'),
        ...guarded(base, 'manage-datasets'),
        409: either('No such running run'),
      },
    }),
    createRoute({
      method: 'get',
      path: `${root}/{id}/executions`,
      summary: `Runs of a pipeline, newest first, with backend status and next scheduled run (${who(base)})`,
      request: { params: params({ id }) },
      responses: {
        200: json(
          z.object({
            data: z.array(Execution),
            backend: BackendStatus,
            nextRunAt: z.string().nullable(),
          }),
          'Runs',
        ),
        ...guarded(base),
      },
    }),
  ];
};

const engineRoutes = (base: Base): RouteConfig[] => {
  const root = `${base.path}/datasets/{id}`;
  const id = param('sider');
  const sid = param('3');
  const params = z.object({ ...base.params, id });
  const switchParams = z.object({ ...base.params, id, sid });
  const failures = guarded(base, 'manage-datasets', problem);
  return [
    createRoute({
      method: 'get',
      path: `${root}/engine`,
      summary: `The search engine behind a dataset, who uses it and any switch in progress (${who(base)})`,
      request: { params },
      responses: { 200: json(DatasetEngine, 'Engine'), ...guarded(base, undefined, problem) },
    }),
    createRoute({
      method: 'get',
      path: `${root}/engine-switches`,
      summary: `Engine switches of an own dataset, newest first (${who(base)})`,
      request: { params },
      responses: {
        200: json(list(EngineSwitch), 'Switches'),
        ...guarded(base, undefined, problem),
      },
    }),
    createRoute({
      method: 'get',
      path: `${root}/engine-switches/estimate`,
      summary: `Estimate cost and time of moving a dataset to another engine (${who(base, 'manage-datasets')})`,
      request: {
        params,
        query: z.object({ to: z.string(), method: SwitchMethod.optional() }),
      },
      responses: {
        200: json(SwitchEstimate, 'Estimate'),
        400: problem('No target engine, or an unknown method'),
        ...failures,
        409: problem('The switch is not possible'),
      },
    }),
    createRoute({
      method: 'post',
      path: `${root}/engine-switches`,
      summary: `Start moving a dataset to another search engine (${who(base, 'manage-datasets')}, audited)`,
      request: { params, headers: reasonHeader, body: body(StartSwitch) },
      responses: {
        202: audited(EngineSwitch, 'Started'),
        400: problem('No target engine, an unknown method, a missing reason, or refused'),
        ...failures,
        409: problem('The switch is not possible, or one is already going'),
      },
    }),
    createRoute({
      method: 'get',
      path: `${root}/engine-switches/{sid}`,
      summary: `One engine switch (${who(base)})`,
      request: { params: switchParams },
      responses: { 200: json(EngineSwitch, 'Switch'), ...guarded(base, undefined, problem) },
    }),
    createRoute({
      method: 'post',
      path: `${root}/engine-switches/{sid}/retry`,
      summary: `Start a failed switch again (${who(base, 'manage-datasets')}, audited)`,
      request: { params: switchParams, headers: reasonHeader },
      responses: {
        202: audited(EngineSwitch, 'Started again'),
        400: problem('A missing reason, or refused'),
        ...failures,
        409: problem('Only a failed switch can be retried'),
      },
    }),
    createRoute({
      method: 'post',
      path: `${root}/engine-switches/{sid}/cancel`,
      summary: `Stop an open switch and drop what it wrote (${who(base, 'manage-datasets')}, audited)`,
      request: { params: switchParams, headers: reasonHeader },
      responses: {
        200: audited(EngineSwitch, 'Cancelled'),
        400: problem('A missing reason, or refused'),
        ...failures,
        409: problem('The switch is already over'),
      },
    }),
    createRoute({
      method: 'post',
      path: `${root}/engine-switches/{sid}/activate`,
      summary: `Point the dataset at the new engine; the old one is kept for rollback (${who(base, 'manage-datasets')}, audited). The reason must be at least minimumReasonLength long.`,
      request: { params: switchParams, headers: reasonHeader },
      responses: {
        200: audited(EngineSwitch, 'Active'),
        400: problem('Reason too short, or the change was refused'),
        ...failures,
        409: problem('Not ready, the dataset changed, or the engine cannot be opened'),
      },
    }),
    createRoute({
      method: 'post',
      path: `${root}/engine-switches/{sid}/rollback`,
      summary: `Point the dataset back at the previous engine while it is kept (${who(base, 'manage-datasets')}, audited)`,
      request: { params: switchParams, headers: reasonHeader },
      responses: {
        200: audited(EngineSwitch, 'Rolled back'),
        400: problem('Reason too short, or the change was refused'),
        ...failures,
        409: problem('Not active, the old engine is gone, or the dataset changed'),
      },
    }),
  ];
};

const catalogRoutes = (base: Base): RouteConfig[] => {
  const kind = z.enum(catalogKinds).openapi({ example: 'knowledge-endpoint' });
  const params = z.object({ ...base.params, kind, id: param('sok') });
  const right = 'manage-datasets for dataset and knowledge-endpoint, otherwise manage-services';
  const writeFailures = {
    400: either('Invalid entry or missing reason'),
    ...guarded(base, isTenant(base) ? right : undefined),
    403: either(isTenant(base) ? `Missing the right ${right}` : 'Not an operator'),
    404: either('Unknown kind, or no such tenant for you'),
    409: either('The version moved, or the entry is in use'),
  };
  const routes: RouteConfig[] = [
    createRoute({
      method: 'get',
      path: `${base.path}/catalog/{kind}/{id}/versions`,
      summary: `Every version of a catalog entry, oldest first (${who(base)})`,
      request: { params },
      responses: { 200: json(list(CatalogVersion), 'Versions'), ...guarded(base) },
    }),
    createRoute({
      method: 'put',
      path: `${base.path}/catalog/{kind}/{id}`,
      summary: `Create or change a catalog entry (${isTenant(base) ? `needs ${right}` : 'operators'}, audited)`,
      request: { params, headers: ifMatch, body: body(CatalogSpec) },
      responses: { 200: audited(CatalogItem, 'Saved'), ...writeFailures },
    }),
    createRoute({
      method: 'delete',
      path: `${base.path}/catalog/{kind}/{id}`,
      summary: `Remove a catalog entry (${isTenant(base) ? `needs ${right}` : 'operators'}, audited)`,
      request: { params, headers: ifMatch },
      responses: {
        200: audited(z.object({ deleted: z.string() }), 'Removed'),
        ...writeFailures,
      },
    }),
  ];
  return isTenant(base)
    ? [
        createRoute({
          method: 'get',
          path: '/tenants/{tenant}/catalog',
          summary:
            'Catalog entries the tenant sees: its own and the shared platform ones (any member of the tenant)',
          request: { params: z.object({ tenant }), query: z.object({ kind: kind.optional() }) },
          responses: {
            200: json(
              z.object({ data: z.array(CatalogItem), tenantKinds: z.array(z.enum(catalogKinds)) }),
              'Entries',
            ),
            ...guarded(base),
          },
        }),
        ...routes,
      ]
    : [
        createRoute({
          method: 'get',
          path: '/operator/catalog/entries',
          summary:
            'Every catalog entry, with the kinds tenants may own and seed entries skipped (operators)',
          request: {
            query: z.object({ kind: kind.optional(), scope: z.string().optional() }),
          },
          responses: {
            200: json(
              z.object({
                data: z.array(CatalogItem),
                kinds: z.array(z.enum(catalogKinds)),
                tenantKinds: z.array(z.enum(catalogKinds)),
                skipped: z.array(z.string()),
              }),
              'Entries',
            ),
            401: either('Not signed in'),
            403: either('Not an operator'),
          },
        }),
        createRoute({
          method: 'get',
          path: '/operator/catalog/{kind}/{id}',
          summary: 'One catalog entry (operators)',
          request: { params },
          responses: { 200: json(CatalogItem, 'Entry'), ...guarded(base) },
        }),
        ...routes,
      ];
};

const datasetRoutes = (base: Base): RouteConfig[] => {
  const id = param('sider');
  const tenantSide = isTenant(base);
  const item = tenantSide ? DatasetDetail : Dataset;
  return [
    createRoute({
      method: 'get',
      path: `${base.path}/datasets`,
      summary: tenantSide
        ? 'Datasets the tenant sees, with ingestion status and where data is stored (any member of the tenant)'
        : 'Every dataset on the platform (operators)',
      request: { params: z.object(base.params) },
      responses: {
        200: json(list(tenantSide ? DatasetWithStatus : Dataset), 'Datasets'),
        ...withoutNotFound(base, guarded(base)),
      },
    }),
    createRoute({
      method: 'post',
      path: `${base.path}/datasets`,
      summary: `Create a dataset; without an id one is made from the name (${who(base, 'manage-datasets')}, audited)`,
      request: { params: z.object(base.params), headers: ifMatch, body: body(DatasetInput) },
      responses: {
        201: audited(Dataset, 'Created'),
        400: either('Invalid dataset or missing reason'),
        ...withoutNotFound(base, guarded(base, 'manage-datasets')),
        409: either('A dataset with that id exists'),
      },
    }),
    createRoute({
      method: 'get',
      path: `${base.path}/datasets/{id}`,
      summary: tenantSide
        ? 'One dataset with ingestion status and the documents the last run skipped (any member of the tenant)'
        : 'One dataset; the id is the full id (operators)',
      request: { params: z.object({ ...base.params, id }) },
      responses: { 200: json(item, 'Dataset'), ...guarded(base) },
    }),
    createRoute({
      method: 'put',
      path: `${base.path}/datasets/{id}`,
      summary: `Change an own dataset; fields left out keep their value (${who(base, 'manage-datasets')}, audited)`,
      request: {
        params: z.object({ ...base.params, id }),
        headers: ifMatch,
        body: body(DatasetChange),
      },
      responses: {
        200: audited(Dataset, 'Saved'),
        400: either('Invalid dataset or missing reason'),
        ...guarded(base, 'manage-datasets'),
        409: either('The version moved'),
      },
    }),
  ];
};

const knowledgeEngineRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/operator/knowledge/engines',
    summary: 'Every search engine kind the platform can talk to, with form schemas (operators)',
    responses: {
      200: json(list(EngineDescription), 'Engines'),
      401: either('Not signed in'),
      403: either('Not an operator'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/knowledge/engines',
    summary:
      'Search engine kinds the tenant can use: all when it may add its own endpoints, else those of shared endpoints (any member of the tenant)',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(list(EngineDescription), 'Engines'),
      401: either('Not signed in'),
      404: either('No such tenant for you'),
    },
  }),
];

const operatorOnly = { 401: problem('Not signed in'), 403: problem('Not an operator') };

const knowledgeEndpointRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/operator/knowledge/endpoints',
    summary: 'Every knowledge endpoint (search engine) with capabilities and use (operators)',
    responses: { 200: json(list(KnowledgeEndpoint), 'Endpoints'), ...operatorOnly },
  }),
  createRoute({
    method: 'get',
    path: '/operator/knowledge/secrets',
    summary: 'Platform secret references endpoints may use; never the values (operators)',
    responses: {
      200: json(
        list(z.object({ ref: z.string(), name: z.string(), updatedAt: z.string().optional() })),
        'Secret references',
      ),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/knowledge/endpoints',
    summary:
      'Knowledge endpoints the tenant sees, and the default embedding model (any member of the tenant)',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(
        z.object({
          data: z.array(KnowledgeEndpoint),
          defaultEmbedding: z
            .object({ model: z.string(), dimensions: z.number().int(), residency: Residency })
            .nullable(),
        }),
        'Endpoints',
      ),
      401: problem('Not signed in'),
      404: problem('No such tenant for you'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/operator/knowledge/endpoints/{id}',
    summary: 'Remove a platform knowledge endpoint no dataset uses (operators, audited)',
    request: { params: z.object({ id: param('search') }), headers: reasonHeader },
    responses: {
      204: empty('Removed'),
      400: problem('Missing reason, or refused'),
      ...operatorOnly,
      404: problem('No such platform endpoint'),
      409: {
        description: 'Datasets still use the endpoint',
        content: { 'application/problem+json': { schema: EndpointInUse } },
      },
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/knowledge/endpoints/test',
    summary: 'Try to reach a knowledge endpoint before saving it; nothing is stored (operators)',
    request: { body: body(CatalogSpec) },
    responses: {
      200: json(EndpointTest, 'Result, also when the endpoint could not be reached'),
      400: problem('The body is not a JSON object'),
      ...operatorOnly,
    },
  }),
];

const uploadRoutes: RouteConfig[] = (() => {
  const params = z.object({ tenant, id: param('opplastet') });
  const failures = {
    401: problem('Not signed in'),
    403: problem('Missing the right manage-datasets'),
    404: problem('No such tenant for you, or no such own dataset'),
  };
  return [
    createRoute({
      method: 'post',
      path: '/tenants/{tenant}/datasets/{id}/uploads',
      summary:
        'Upload files (PDF, Word, text, Markdown, HTML) to a dataset with an upload source (needs manage-datasets, audited when a file is stored)',
      request: {
        params,
        headers: reasonHeader,
        body: body(
          z.object({ files: z.array(z.string().openapi({ format: 'binary' })) }),
          'multipart/form-data',
        ),
      },
      responses: {
        201: json(UploadResult, 'What was stored and what was skipped'),
        400: problem('Not multipart/form-data, no files, or a missing reason'),
        ...failures,
      },
    }),
    createRoute({
      method: 'get',
      path: '/tenants/{tenant}/datasets/{id}/uploads',
      summary: 'Files uploaded to a dataset (any member of the tenant, like reading the dataset)',
      request: { params },
      responses: {
        200: json(list(UploadedFile), 'Files'),
        401: failures[401],
        404: failures[404],
      },
    }),
    createRoute({
      method: 'delete',
      path: '/tenants/{tenant}/datasets/{id}/uploads/{name}',
      summary: 'Remove an uploaded file (needs manage-datasets, audited)',
      request: {
        params: params.extend({ name: param('veileder.pdf') }),
        headers: reasonHeader,
      },
      responses: { 204: empty('Removed'), 400: problem('A missing reason'), ...failures },
    }),
  ];
})();

const enrichmentRoutes: RouteConfig[] = (() => {
  const base = '/tenants/{tenant}/datasets/{id}/enrichment/hypothetical-questions';
  const params = z.object({ tenant, id: param('kudos') });
  const failures = {
    401: problem('Not signed in'),
    403: problem('Missing the right manage-datasets'),
    404: problem('No such tenant for you, or no such own dataset'),
    422: problem('Invalid body'),
  };
  return [
    createRoute({
      method: 'post',
      path: `${base}/proposals`,
      summary:
        'Ask a model for questions each chunk answers; nothing is stored (needs manage-datasets)',
      request: { params, body: body(proposeBody) },
      responses: {
        200: json(z.object({ proposals: z.array(QuestionProposal) }), 'Proposals'),
        ...failures,
        502: problem('The model could not propose questions'),
      },
    }),
    createRoute({
      method: 'post',
      path: `${base}/apply`,
      summary:
        'Store proposed questions on their chunks, replacing earlier ones; dryRun shows the rows (needs manage-datasets, audited unless dryRun)',
      request: { params, headers: reasonHeader, body: body(applyBody) },
      responses: {
        200: json(
          z.object({
            applied: z.number().int(),
            chunkIds: z.array(z.string()),
            rows: z.array(EnrichmentRow).optional(),
          }),
          'Applied; rows only on dryRun',
        ),
        400: problem('Refused'),
        ...failures,
        409: problem('The search engine of the dataset has no store for enrichment'),
        502: problem('The questions could not be stored'),
      },
    }),
    createRoute({
      method: 'post',
      path: `${base}/verify`,
      summary:
        'Search with and without the questions and tell whether the chunk got easier to find (needs manage-datasets)',
      request: { params, body: body(verifyBody) },
      responses: {
        200: json(VerifyResult, 'Verdict'),
        ...failures,
        409: problem('The dataset has no such search profile'),
      },
    }),
    createRoute({
      method: 'post',
      path: `${base}/revert`,
      summary:
        'Remove stored questions from a chunk, optionally only one prompt version (needs manage-datasets, audited)',
      request: { params, headers: reasonHeader, body: body(revertBody) },
      responses: {
        200: json(z.object({ reverted: z.number().int(), chunkId: z.string() }), 'Reverted'),
        400: problem('Refused'),
        ...failures,
        409: problem('The search engine of the dataset has no store for enrichment'),
        502: problem('The questions could not be stored'),
      },
    }),
  ];
})();

const operatorModelRoutes: RouteConfig[] = [
  createRoute({
    method: 'post',
    path: '/operator/model-endpoints',
    summary: 'Add a platform model endpoint using a platform secret (operators, audited)',
    request: { headers: reasonHeader, body: body(ModelEndpointInput) },
    responses: {
      201: audited(CatalogItem, 'Created'),
      400: problem('Invalid endpoint or missing reason'),
      ...operatorOnly,
      409: problem('The endpoint exists'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/operator/model-endpoints/{id}',
    summary:
      'Remove a platform model endpoint and its catalog models when no service or tenant uses them (operators, audited)',
    request: { params: z.object({ id: param('sigma2') }), headers: reasonHeader },
    responses: {
      204: empty('Removed'),
      400: problem('Missing reason, or refused'),
      ...operatorOnly,
      404: problem('No such platform endpoint'),
      409: {
        description: 'Services or tenants use models from the endpoint',
        content: { 'application/problem+json': { schema: ModelEndpointInUse } },
      },
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/models/{id}/price',
    summary:
      'Set the price of a model in NOK per thousand tokens (operators, audited). The id may contain slashes.',
    request: {
      params: z.object({ id: param('fake/gpt') }),
      headers: reasonHeader,
      body: body(Price),
    },
    responses: {
      200: audited(Price.extend({ id: z.string(), currency: z.literal('NOK') }), 'Saved'),
      400: problem('Invalid price or missing reason'),
      ...operatorOnly,
      404: problem('No such model'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/models/{id}',
    summary:
      'Add or change a catalog model on a platform endpoint; a new one starts as a release candidate (operators, audited). The id starts with the endpoint id and a slash.',
    request: {
      params: z.object({ id: param('sigma2/norallm-7b') }),
      headers: reasonHeader,
      body: body(PlatformModelInput),
    },
    responses: {
      200: audited(
        CatalogItem.extend({ enabled: z.boolean().optional() }),
        'Saved; enabled only when it was sent',
      ),
      400: problem('Invalid model, unknown endpoint or missing reason'),
      ...operatorOnly,
    },
  }),
];

const publicModelRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/models',
    summary:
      'Enabled models the caller may use, with price, filtered by residency, capabilities or the needs of a strategy (any signed-in caller or API key)',
    request: {
      query: z.object({
        residency: Residency.optional(),
        strategy: z.string().optional(),
        capability: z
          .array(z.enum(capabilities))
          .optional()
          .openapi({ description: 'Repeat for several' }),
      }),
    },
    responses: {
      200: json(list(PublicModel), 'Models'),
      400: problem('Unknown residency (`errors` names `residency`)'),
      401: problem('Invalid or missing API key'),
    },
  }),
];

const operatorCatalogRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/operator/catalog',
    summary:
      'Seed catalog entries that were skipped at start because they were invalid (operators)',
    responses: {
      200: json(z.object({ skipped: z.array(z.string()) }), 'Skipped'),
      ...operatorOnly,
    },
  }),
];

export const datasetRouteGroups: Record<string, RouteConfig[]> = {
  config: [
    ...catalogRoutes(operatorBase),
    ...catalogRoutes(tenantBase),
    ...knowledgeEngineRoutes,
    ...datasetRoutes(operatorBase),
    ...datasetRoutes(tenantBase),
    ...pipelineRoutes(operatorBase),
    ...pipelineRoutes(tenantBase),
  ],
  'knowledge-endpoints': knowledgeEndpointRoutes,
  'engine-switches': [...engineRoutes(tenantBase), ...engineRoutes(operatorBase)],
  'dataset-uploads': uploadRoutes,
  'dataset-enrichment': enrichmentRoutes,
  'operator-models': operatorModelRoutes,
  'operator-catalog': operatorCatalogRoutes,
  models: publicModelRoutes,
};

export const datasetDocRoutes: RouteConfig[] = Object.values(datasetRouteGroups).flat();

interface DocumentedApp {
  openAPIRegistry?: { registerPath(route: RouteConfig): void };
}

export const documentDatasetRoutes = (app: unknown, mounted: readonly string[]) => {
  const registry = (app as DocumentedApp).openAPIRegistry;
  if (!registry) return;
  for (const group of mounted)
    for (const route of datasetRouteGroups[group] ?? []) registry.registerPath(route);
};
