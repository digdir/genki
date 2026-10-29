import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import {
  candidateOrigins,
  candidateStatuses,
  caseSplits,
  caseTypes,
  evalRun,
  evalRunStates,
  gate,
  judgeLabel,
  metricSummary,
  splits,
  testCase,
} from '@genai/eval';
import { customRuleSpec, ruleKinds } from '@genai/guardrails';
import { hookPoints, hookSpec } from '@genai/hooks';
import { Problem, problemContent } from '../http.js';
import type { PlatformModuleFactory } from '../platform-modules.js';

const pathParam = (name: string, example: string) =>
  z.string().openapi({ param: { name, in: 'path' }, example });

const tenant = pathParam('tenant', '991825827');
const project = pathParam('project', 'arsrapporter-2026');
const task = pathParam('task', '0b6f6c3e-3c55-4f0e-9a51-6c2f1f0f7a10');

const supportSession = z
  .string()
  .optional()
  .describe('An operator working in a tenant sends the id of an open support session');
const reason = z
  .string()
  .describe('Why the change is made, at least 10 characters; URI-encode text outside ASCII');
const actorName = z.string().optional().describe('Display name of the person, URI-encoded');
const ifMatch = z
  .string()
  .optional()
  .describe('The version the change is based on; a newer stored version gives 409');

const readHeaders = z.object({ 'support-session': supportSession });
const writeHeaders = z.object({ 'change-reason': reason, 'support-session': supportSession });
const namedWriteHeaders = writeHeaders.extend({ 'actor-name': actorName });
const optionalReasonHeaders = z.object({
  'change-reason': reason.optional(),
  'support-session': supportSession,
});
const operatorWriteHeaders = z.object({ 'change-reason': reason });

const json = (schema: z.ZodType, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const body = (schema: z.ZodType, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });
const anyProblem = (description: string) => ({
  description,
  content: { ...problemContent, 'application/json': { schema: Problem } },
});

const memberRead = {
  401: problem('Not signed in'),
  404: problem('No access to the tenant, or not found'),
};
const memberWrite = {
  ...memberRead,
  400: problem('Invalid request or missing change reason'),
  403: problem('Missing right'),
};
const operatorOnly = {
  401: problem('Not signed in'),
  403: problem('Not an operator'),
};

const member = 'Any member of the tenant; an operator needs a support session';
const operator = 'Operators only';
const audited = 'Audited.';
const notAudited = 'Not in the audit log.';
const described = (right: string, audit: string, more = '') =>
  [`Right: ${right}.`, audit, more].filter(Boolean).join(' ');

const Usage = z
  .object({
    inputTokens: z.number().int(),
    outputTokens: z.number().int(),
    requests: z.number().int(),
    costMicroNok: z.number().nullable().describe('Null when no token in the period has a price'),
    priced: z.boolean(),
    unpricedTokens: z.number().int(),
  })
  .openapi('UsageTotals');
const UsageWithRuns = Usage.extend({ runs: z.number().int() });

const taskStatus = z.enum(['queued', 'running', 'interrupted', 'completed', 'failed', 'cancelled']);

const TaskBase = z.object({
  id: z.string(),
  status: taskStatus,
  service: z.string(),
  capability: z.string(),
  version: z.number().int().nullable(),
  createdAt: z.string(),
  endedAt: z.string().nullable(),
});

const TaskRow = TaskBase.extend({
  usage: Usage.optional().describe('Only for callers with view-usage'),
  serviceName: z.string(),
  excerpt: z
    .string()
    .optional()
    .describe('The start of the input; only for callers with manage-services'),
  actor: z.object({
    kind: z.enum(['api-key', 'person', 'system']),
    name: z.string().optional(),
  }),
}).openapi('TaskRow');

const MyTask = TaskBase.extend({
  serviceName: z.string().optional(),
  failure: z
    .object({ code: z.string(), reason: z.string(), step: z.string().optional() })
    .optional(),
}).openapi('MyTask');

const TrackedTask = z
  .object({ task: z.string(), tenant: z.string(), status: z.string(), at: z.string() })
  .openapi('TrackedTask');

const filters = z
  .record(z.string(), z.unknown())
  .describe('Field values per filter field, as in a search filter');

const Selection = z.object({
  id: z.string(),
  name: z.string(),
  dataset: z.string(),
  filters,
  documents: z.array(z.string()).optional(),
});

const ProjectInput = z
  .object({
    id: z.string().optional().describe('Only on create; made from the name when left out'),
    name: z.string().max(120),
    purpose: z.string().max(4000).optional(),
    selections: z
      .array(
        z.object({
          id: z.string().optional(),
          name: z.string().optional(),
          dataset: z.string(),
          filters: filters.optional(),
          documents: z.array(z.string()).max(1000).optional(),
        }),
      )
      .optional(),
    services: z.array(z.string()).optional(),
    version: z.number().int().optional().describe('Only on update; guards against lost updates'),
    reason: z.string().optional().describe('Used when the change-reason header is missing'),
  })
  .openapi('ProjectInput');

const Stamp = {
  version: z.number().int(),
  by: z.string(),
  at: z.string(),
  reason: z.string(),
};

const Project = z
  .object({
    id: z.string(),
    name: z.string(),
    purpose: z.string(),
    selections: z.array(Selection),
    services: z.array(z.string()),
    changedBy: z.string().optional(),
    ...Stamp,
  })
  .openapi('Project');

const BatchDocument = z.object({ id: z.string(), title: z.string(), url: z.string().optional() });

const SubscriptionPause = z.object({
  kind: z.enum(['cost-cap', 'manual', 'problem']),
  reason: z.string(),
  at: z.string(),
  month: z.string().optional(),
});

const ProjectSubscription = z
  .object({
    project: z.string(),
    selection: z.string(),
    mode: z.enum(['notify', 'run']),
    service: z.string().optional(),
    prompt: z.string().optional(),
    cap: z.object({ maxCostNok: z.number().optional(), maxTokens: z.number().optional() }),
    basis: z.object({ dataset: z.string(), filters }),
    paused: SubscriptionPause.optional(),
    changedBy: z.string().optional(),
    status: z.enum(['active', 'paused']),
    detection: z.enum(['ingestion', 'poll']),
    fresh: z.array(
      z.object({ document: BatchDocument, arrivedAt: z.string(), run: z.string().optional() }),
    ),
    waiting: z.number().int(),
    known: z.number().int(),
    checkedAt: z.string().optional(),
    error: z.string().optional(),
    month: z.string(),
    spentThisMonth: z.object({ costMicroNok: z.number(), tokens: z.number() }).optional(),
    ...Stamp,
  })
  .openapi('ProjectSubscription');

const Range = z.object({ low: z.number(), high: z.number() });
const PerItem = z.object({
  inputTokens: Range,
  outputTokens: Range,
  costMicroNok: Range.nullable(),
});
const inputValues = z.record(z.string(), z.union([z.string(), z.number(), z.array(z.string())]));

const ProjectEstimate = z
  .object({
    id: z.string(),
    service: z.string(),
    version: z.number().int(),
    model: z.string().nullable(),
    priced: z.boolean(),
    dataset: z.string(),
    filters,
    prompt: z.string().optional(),
    input: inputValues.optional(),
    found: z.number().int().optional(),
    excluded: z
      .object({
        duplicates: z.array(z.object({ document: BatchDocument, keptId: z.string() })),
        otherYear: z.array(BatchDocument),
      })
      .optional(),
    items: z.number().int(),
    perItem: PerItem,
    maxOutputTokens: z.number().int(),
    tokens: Range,
    costMicroNok: Range.nullable(),
    basis: z.enum(['measured', 'assumed']),
    samples: z.array(
      z.object({
        document: z.string(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        costMicroNok: z.number().nullable(),
        output: z.string(),
        error: z.string().optional(),
      }),
    ),
    createdAt: z.string(),
    expiresAt: z.string(),
    preview: z.array(BatchDocument).describe('The first 20 documents'),
    selection: z.string(),
  })
  .openapi('ProjectEstimate');

const Approval = z.object({
  status: z.enum(['pending', 'approved', 'rejected']),
  by: z.string().optional(),
  byName: z.string().optional(),
  at: z.string().optional(),
  reason: z.string().optional(),
});

const itemStatuses = ['queued', 'running', 'succeeded', 'notFound', 'failed', 'skipped'] as const;

const ProjectRun = z
  .object({
    id: z.string(),
    service: z.string(),
    version: z.number().int(),
    model: z.string().nullable(),
    priced: z.boolean(),
    dataset: z.string(),
    filters,
    prompt: z.string().optional(),
    input: inputValues.optional(),
    estimate: z.string(),
    startedBy: z.string().optional(),
    startedByName: z.string().optional(),
    costApproval: z
      .object({ by: z.string(), at: z.string(), reason: z.string(), limitNok: z.number() })
      .optional(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stopped']),
    total: z.number().int(),
    concurrency: z.number().int(),
    cap: z
      .object({ costMicroNok: z.number().optional(), tokens: z.number().optional() })
      .optional(),
    perItem: PerItem.optional(),
    maxOutputTokens: z.number().int().optional(),
    pass: z.number().int(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
    counts: z.record(z.enum(itemStatuses), z.number().int()),
    tokens: z.object({ input: z.number(), output: z.number() }).optional(),
    costMicroNok: z.number().nullable().optional(),
  })
  .openapi('ProjectRun');

const ProjectRunListed = ProjectRun.extend({
  trigger: z.enum(['manual', 'subscription']),
  selection: z.string().optional(),
  newSince: z.number().int().describe('Documents that arrived in the selection after the run'),
  approval: Approval.optional().describe('Only for runs a subscription started'),
});

const LogEntry = z.object({
  kind: z.string(),
  id: z.string(),
  version: z.number().int(),
  deleted: z.boolean(),
  by: z.string(),
  byName: z.string().optional(),
  at: z.string(),
  reason: z.string(),
});

const Point = z.object({
  id: z.string(),
  text: z.string(),
  by: z.string(),
  byName: z.string().optional(),
  at: z.string(),
});

const subscriptionPath = '/tenants/{tenant}/projects/{project}/subscriptions/{selection}';
const subscriptionParams = z.object({
  tenant,
  project,
  selection: pathParam('selection', 'tilsyn'),
});
const runParams = z.object({ tenant, project, run: pathParam('run', 'b2c1d9e4') });
const projectParams = z.object({ tenant, project });

const projectWriteProblems = {
  ...memberWrite,
  409: problem('Conflict with the stored state'),
  422: problem('The dataset or service cannot be used this way'),
};

const projectRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects/sources',
    summary: 'Datasets a project can select from, with the filter values people can pick',
    description: described(member, notAudited),
    request: { params: z.object({ tenant }), headers: readHeaders },
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              filters: z.array(
                z.object({
                  field: z.string(),
                  values: z.array(z.object({ value: z.string(), count: z.number().int() })),
                }),
              ),
            }),
          ),
        }),
        'Sources',
      ),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects',
    summary: "The tenant's projects with counts of subscriptions, new documents and runs",
    description: described(member, notAudited),
    request: { params: z.object({ tenant }), headers: readHeaders },
    responses: {
      200: json(
        z.object({
          data: z.array(
            Project.extend({
              subscriptions: z.number().int(),
              fresh: z.number().int(),
              paused: z.number().int(),
              runs: z.number().int(),
            }),
          ),
        }),
        'Projects',
      ),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/projects',
    summary: 'Create a project',
    description: described('use-services', audited),
    request: {
      params: z.object({ tenant }),
      headers: namedWriteHeaders,
      body: body(ProjectInput),
    },
    responses: { 201: json(Project, 'Created'), ...projectWriteProblems },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects/{project}',
    summary: 'One project with its subscriptions',
    description: described(member, notAudited),
    request: { params: projectParams, headers: readHeaders },
    responses: {
      200: json(Project.extend({ subscriptions: z.array(ProjectSubscription) }), 'Project'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/projects/{project}',
    summary: 'Change a project; send the version you read to guard against lost updates',
    description: described('use-services', audited),
    request: { params: projectParams, headers: namedWriteHeaders, body: body(ProjectInput) },
    responses: { 200: json(Project, 'Saved'), ...projectWriteProblems },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/projects/{project}',
    summary: 'Delete a project',
    description: described('use-services', audited),
    request: { params: projectParams, headers: writeHeaders },
    responses: {
      200: json(z.object({ id: z.string(), deleted: z.literal(true) }), 'Deleted'),
      ...memberWrite,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects/{project}/history',
    summary: 'Every saved version of the project, newest first',
    description: described(member, notAudited),
    request: { params: projectParams, headers: readHeaders },
    responses: { 200: json(z.object({ data: z.array(Project) }), 'Versions'), ...memberRead },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects/{project}/log',
    summary:
      'Change log of the project: versions, subscriptions, runs, reviews and points, newest first',
    description: described(member, notAudited),
    request: { params: projectParams, headers: readHeaders },
    responses: { 200: json(z.object({ data: z.array(LogEntry) }), 'Log'), ...memberRead },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects/{project}/points',
    summary: 'Assessment points written on the project, oldest first',
    description: described(member, notAudited),
    request: { params: projectParams, headers: readHeaders },
    responses: { 200: json(z.object({ data: z.array(Point) }), 'Points'), ...memberRead },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/projects/{project}/points',
    summary: 'Add an assessment point to the project',
    description: described('use-services', audited),
    request: {
      params: projectParams,
      headers: namedWriteHeaders,
      body: body(z.object({ text: z.string().min(1).max(2000) })),
    },
    responses: { 201: json(Point, 'Added'), ...memberWrite },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects/{project}/documents',
    summary: 'Documents in one selection of the project',
    description: described(member, notAudited),
    request: {
      params: projectParams,
      headers: readHeaders,
      query: z.object({
        selection: z.string().describe('The selection id'),
        limit: z.string().optional().describe('1 to 100, default 20'),
      }),
    },
    responses: {
      200: json(
        z.object({
          selection: z.string(),
          dataset: z.string(),
          datasetName: z.string(),
          found: z.number().int(),
          documents: z.array(BatchDocument),
        }),
        'Documents',
      ),
      400: problem('No selection given'),
      403: problem('No access to the dataset'),
      422: problem('The dataset cannot list documents or the filters are invalid'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/projects/{project}/runs/estimate',
    summary: 'Estimate cost and tokens of running a service over a selection, with sample answers',
    description: described('use-services', audited, 'Samples call the model.'),
    request: {
      params: projectParams,
      headers: writeHeaders,
      body: body(
        z.object({
          service: z.string(),
          selection: z.string(),
          prompt: z.string().optional(),
          sample: z.boolean().optional().describe('Default true; false skips the sample answers'),
        }),
      ),
    },
    responses: {
      201: json(ProjectEstimate, 'Estimate; start the run with its id'),
      ...projectWriteProblems,
      503: problem('No model is available'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/projects/{project}/runs',
    summary: 'Start a run from an estimate',
    description: described('use-services', audited),
    request: {
      params: projectParams,
      headers: writeHeaders,
      body: body(
        z.object({
          estimate: z.string(),
          selection: z.string().optional(),
          maxCostNok: z.number().positive().optional(),
          maxTokens: z.number().positive().optional(),
          concurrency: z.number().positive().optional(),
        }),
      ),
    },
    responses: {
      202: json(ProjectRun, 'Started'),
      ...projectWriteProblems,
      503: problem('No model is available'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/projects/{project}/runs/{run}/cancel',
    summary: 'Cancel a run of the project',
    description: described('use-services', audited),
    request: { params: runParams, headers: writeHeaders },
    responses: {
      202: json(z.object({ id: z.string(), cancelling: z.literal(true) }), 'Cancelling'),
      ...projectWriteProblems,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/projects/{project}/runs/{run}/retry',
    summary: 'Run the failed items of a run again',
    description: described('use-services', audited),
    request: {
      params: runParams,
      headers: writeHeaders,
      body: body(
        z.object({
          maxCostNok: z.number().positive().optional(),
          maxTokens: z.number().positive().optional(),
          items: z.array(z.number().int()).optional().describe('Item indexes; default all failed'),
        }),
        false,
      ),
    },
    responses: {
      202: json(ProjectRun.extend({ retried: z.number().int() }), 'Retrying'),
      ...projectWriteProblems,
      503: problem('No model is available'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects/{project}/runs',
    summary: 'Runs of the project, those waiting for approval first',
    description: described(member, notAudited),
    request: { params: projectParams, headers: readHeaders },
    responses: { 200: json(z.object({ data: z.array(ProjectRunListed) }), 'Runs'), ...memberRead },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/projects/{project}/runs/{run}/review',
    summary: 'Approve or reject a run a subscription started',
    description: described('use-services', audited),
    request: {
      params: runParams,
      headers: namedWriteHeaders,
      body: body(z.object({ decision: z.enum(['approved', 'rejected']) })),
    },
    responses: {
      200: json(Approval.extend({ run: z.string(), project: z.string() }), 'Recorded'),
      409: problem('The run was started by a person, or is not finished'),
      ...memberWrite,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/projects/{project}/subscriptions',
    summary: 'Subscriptions of the project, one per followed selection',
    description: described(member, notAudited),
    request: { params: projectParams, headers: readHeaders },
    responses: {
      200: json(z.object({ data: z.array(ProjectSubscription) }), 'Subscriptions'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'put',
    path: subscriptionPath,
    summary: 'Follow a selection: notify about new documents, or run a service on them',
    description: described(
      'use-services for notify, manage-services for run',
      audited,
      'A run subscription needs a service and a monthly cap.',
    ),
    request: {
      params: subscriptionParams,
      headers: namedWriteHeaders,
      body: body(
        z.object({
          mode: z.enum(['notify', 'run']),
          service: z.string().optional(),
          prompt: z.string().optional(),
          maxCostNok: z.number().positive().optional(),
          maxTokens: z.number().positive().optional(),
        }),
      ),
    },
    responses: { 200: json(ProjectSubscription, 'Saved'), ...projectWriteProblems },
  }),
  createRoute({
    method: 'delete',
    path: subscriptionPath,
    summary: 'Stop following a selection',
    description: described('use-services, or manage-services for a run subscription', audited),
    request: { params: subscriptionParams, headers: writeHeaders },
    responses: {
      200: json(z.object({ selection: z.string(), deleted: z.literal(true) }), 'Deleted'),
      ...memberWrite,
    },
  }),
  ...(['pause', 'resume'] as const).map((action) =>
    createRoute({
      method: 'post',
      path: `${subscriptionPath}/${action}`,
      summary:
        action === 'pause'
          ? 'Pause a subscription'
          : 'Resume a subscription and check for new documents',
      description: described('use-services, or manage-services for a run subscription', audited),
      request: { params: subscriptionParams, headers: writeHeaders },
      responses: { 200: json(ProjectSubscription, 'Saved'), ...memberWrite },
    }),
  ),
  createRoute({
    method: 'post',
    path: `${subscriptionPath}/check`,
    summary: 'Check the selection for new documents now',
    description: described(
      'use-services, or manage-services for a run subscription',
      audited,
      'No change reason needed.',
    ),
    request: { params: subscriptionParams, headers: readHeaders },
    responses: {
      200: json(
        z.object({
          status: z.enum(['paused', 'busy', 'checked', 'started']),
          arrived: z.number().int(),
          waiting: z.number().int(),
          run: z.string().optional(),
          paused: SubscriptionPause.optional(),
          error: z.string().optional(),
        }),
        'Checked',
      ),
      403: problem('Missing right'),
      ...memberRead,
    },
  }),
];

const ReviewView = z
  .object({
    task: z.string(),
    service: z.string(),
    status: taskStatus,
    createdAt: z.string(),
    input: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('Form values the run was started with; only on GET'),
    table: z
      .object({
        columns: z.array(z.object({ key: z.string() }).loose()),
        rows: z.array(z.unknown()),
      })
      .loose()
      .nullable(),
    csv: z.string().optional(),
    edits: z.array(
      z.object({
        row: z.number().int(),
        column: z.string(),
        value: z.string(),
        original: z.unknown(),
        by: z.string().optional(),
        at: z.string().optional(),
        byName: z.string().optional(),
      }),
    ),
    approval: z.union([
      z.object({
        status: z.literal('approved'),
        by: z.string(),
        byName: z.string().optional(),
        at: z.string(),
        reason: z.string(),
      }),
      z.object({ status: z.literal('draft') }),
    ]),
    version: z.number().int(),
  })
  .openapi('TaskReview');

const reviewProblems = {
  ...memberRead,
  400: problem('Invalid edits or missing change reason'),
  403: problem('Only the person who started the run may change and approve it'),
  409: problem('No table, already approved, the run is not finished, or another edit came first'),
};

const taskRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/tasks',
    summary: "The tenant's service runs, newest first",
    description: described(member, notAudited),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      query: z.object({
        status: taskStatus.optional(),
        service: z.string().optional(),
        from: z.string().optional().describe('ISO time, inclusive'),
        to: z.string().optional().describe('ISO time, inclusive'),
        limit: z.string().optional().describe('1 to 500, default 100'),
      }),
    },
    responses: {
      200: json(z.object({ data: z.array(TaskRow), total: z.number().int() }), 'Runs'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/tasks/mine',
    summary: 'Runs the caller started, newest first, with the failure reason of failed runs',
    description: described(member, notAudited),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      query: z.object({
        status: taskStatus.optional(),
        limit: z.string().optional().describe('1 to 200, default 50'),
      }),
    },
    responses: { 200: json(z.object({ data: z.array(MyTask) }), 'Runs'), ...memberRead },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/tasks/{task}',
    summary: 'One service run',
    description: described(member, notAudited),
    request: { params: z.object({ tenant, task }), headers: readHeaders },
    responses: { 200: json(TaskRow, 'Run'), ...memberRead },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/tasks/{task}/export',
    summary: 'Download a run as a zip: task, events, result, artifacts, provenance and retention',
    description: described(
      'manage-services',
      audited,
      'The genai-task header names the audit entry.',
    ),
    request: { params: z.object({ tenant, task }), headers: writeHeaders },
    responses: {
      200: {
        description: 'Zip archive',
        content: { 'application/zip': { schema: z.string().openapi({ format: 'binary' }) } },
      },
      409: problem('The export could not be recorded'),
      ...memberWrite,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/tasks/{task}/review',
    summary: 'The table a run produced, with edits and approval',
    description: described('Who started the run, or manage-services', notAudited),
    request: { params: z.object({ tenant, task }), headers: readHeaders },
    responses: {
      200: json(ReviewView, 'Review'),
      403: problem('Missing right'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/tasks/{task}/review/edits',
    summary: 'Replace the cell edits on the table of a run',
    description: described(
      'use-services, and only who started the run',
      'Audited, and kept in the review history.',
    ),
    request: {
      params: z.object({ tenant, task }),
      headers: namedWriteHeaders,
      body: body(
        z.object({
          edits: z.array(
            z.object({ row: z.number().int(), column: z.string(), value: z.string().max(4000) }),
          ),
        }),
      ),
    },
    responses: { 200: json(ReviewView, 'Saved'), ...reviewProblems },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/tasks/{task}/review/approve',
    summary: 'Approve the table of a finished run; it cannot be edited after',
    description: described(
      'use-services, and only who started the run',
      'Audited, and kept in the review history.',
    ),
    request: { params: z.object({ tenant, task }), headers: namedWriteHeaders },
    responses: { 200: json(ReviewView, 'Approved'), ...reviewProblems },
  }),
  createRoute({
    method: 'get',
    path: '/operator/tasks',
    summary: 'Tasks on the platform; running (queued or running) by default',
    description: described(
      operator,
      notAudited,
      'status filters on queued, running, interrupted, completed, failed or cancelled; running also lists queued tasks. Another status answers 400.',
    ),
    request: {
      query: z.object({
        status: z
          .enum(['queued', 'running', 'interrupted', 'completed', 'failed', 'cancelled'])
          .optional(),
      }),
    },
    responses: {
      200: json(z.object({ data: z.array(TrackedTask) }), 'Tasks'),
      400: problem('Unknown status'),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/running-tasks',
    summary: 'Running tasks with their service, newest first',
    description: described(operator, notAudited),
    request: {
      query: z.object({ tenant: z.string().optional(), service: z.string().optional() }),
    },
    responses: {
      200: json(
        z.object({
          data: z.array(
            TrackedTask.extend({
              service: z.string().optional(),
              capability: z.string().optional(),
            }),
          ),
        }),
        'Tasks',
      ),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/tasks/{task}/cancel',
    summary: 'Cancel a running task',
    description: described(operator, audited),
    request: { params: z.object({ task }), headers: operatorWriteHeaders },
    responses: {
      200: json(z.object({ task: z.string(), cancelled: z.literal(true) }), 'Cancelled'),
      400: problem('Missing change reason'),
      404: problem('No running task with that id'),
      ...operatorOnly,
    },
  }),
];

const TestSetShape = {
  apiVersion: z.literal('genai/v1'),
  kind: z.literal('TestSet'),
  metadata: z.strictObject({
    tenant: z.string(),
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
  }),
  spec: z.strictObject({
    service: z.string().optional(),
    corpus: z.string().optional(),
    provenance: z.record(z.string(), z.unknown()).optional(),
    cases: z.array(testCase),
  }),
};
const TestSet = z.strictObject(TestSetShape).openapi('TestSetDefinition');

const TestSetInput = z
  .object({
    id: z.string().optional().describe('Required on create'),
    name: z.string(),
    service: z.string().optional(),
    corpus: z.string().optional(),
    provenance: z.record(z.string(), z.unknown()).optional(),
    cases: z
      .array(z.record(z.string(), z.unknown()))
      .optional()
      .describe('Test cases, see TestSet'),
  })
  .openapi('TestSetInput');

const CaseView = z
  .object({
    id: z.string(),
    input: z.string(),
    expected: z.string(),
    type: z.enum(caseTypes),
    split: z.enum(caseSplits),
  })
  .openapi('TestCaseView');

const CandidateView = z
  .object({
    id: z.string(),
    input: z.string(),
    expected: z.string().optional(),
    origin: z.enum(candidateOrigins),
    status: z.enum(['new', 'accepted', 'rejected']),
    createdAt: z.string(),
    service: z.string().optional(),
    testSet: z.string().optional(),
  })
  .openapi('TestCaseCandidateView');

const sourceRef = z.object({
  chunkId: z.string().optional(),
  document: z.string().optional(),
  position: z.number().int().optional(),
});

const Candidate = z
  .object({
    id: z.string(),
    tenant: z.string(),
    task: z.string().optional(),
    question: z.string(),
    answer: z.string().optional(),
    sources: z.array(sourceRef),
    findings: z.array(z.object({ category: z.string(), count: z.number().int() })),
    status: z.enum(candidateStatuses),
    proposedAt: z.string(),
    expiresAt: z.string(),
    service: z.string().optional(),
    reviewedAt: z.string().optional(),
    reason: z.string().optional(),
    testSet: z.object({ id: z.string(), version: z.number().int(), case: z.string() }).optional(),
    targetTestSet: z.string().optional(),
    origin: z.enum(candidateOrigins).optional(),
  })
  .openapi('TestCaseCandidate');

const RunStatus = z
  .union([
    z.object({ state: z.literal('running'), task: z.string() }),
    z.object({
      state: z.literal('waiting-for-scores'),
      task: z.string(),
      pending: z.number().int(),
      until: z.string(),
    }),
    z.object({ state: z.literal('completed'), task: z.string(), run: z.string() }),
    z.object({ state: z.literal('failed'), task: z.string(), error: z.string() }),
  ])
  .openapi('EvalTaskStatus');

const ServiceEvalRun = z
  .object({
    id: z.string(),
    status: z.enum(evalRunStates),
    testSet: z.string(),
    testSetVersion: z.number().int(),
    version: z.union([z.literal('draft'), z.number().int()]),
    variant: z.string().optional(),
    split: z.enum(['locked', 'open']).optional(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    score: z
      .number()
      .nullable()
      .describe(
        'Share of cases that pass on their type: the criteria judge, the exact text or the refusal',
      ),
    passed: z.number().int(),
    total: z.number().int(),
    progress: z.object({ done: z.number().int(), total: z.number().int() }).optional(),
    metrics: z.record(z.string(), metricSummary),
    incomplete: z.array(
      z.object({
        evaluator: z.string(),
        missing: z.number().int(),
        failed: z.number().int(),
        of: z.number().int(),
        reason: z.string(),
      }),
    ),
    judges: z.array(z.string()).describe('Each judge as <id>@<version>+<model>'),
    cost: z
      .number()
      .nullable()
      .optional()
      .describe('Micro-NOK for the answers and the judges; only with view-usage'),
    tokens: z.object({ input: z.number(), output: z.number() }).optional(),
    error: z.string().optional(),
    byTag: z.record(z.string(), z.record(z.string(), metricSummary)),
    cases: z.array(
      z.object({
        caseId: z.string(),
        input: z.string(),
        expected: z.string(),
        type: z.enum(caseTypes),
        split: z.enum(caseSplits),
        output: z.string(),
        pass: z.boolean(),
        reason: z.string().optional(),
      }),
    ),
  })
  .openapi('ServiceEvalRun');

const FeedbackView = z.object({
  rating: z.enum(['up', 'down']),
  at: z.string().describe('Only the date while fewer than five share the rating'),
  task: z.string().optional(),
  comment: z.string().optional(),
  reasons: z.array(z.string()).optional(),
});

const evalProblems = {
  400: problem('Invalid request'),
  401: problem('Not signed in'),
  404: problem('Not found, or no access'),
};

const configRead = {
  401: anyProblem('Not signed in'),
  404: anyProblem('No access to the tenant, or not found'),
};
const testSetWrite = {
  ...configRead,
  400: anyProblem('Invalid test set or missing change reason'),
  403: anyProblem('Missing right'),
};

const evalRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/test-sets',
    summary: "The latest version of each of the tenant's test sets",
    description: described(member, notAudited),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      query: z.object({ service: z.string().optional() }),
    },
    responses: { 200: json(z.object({ data: z.array(TestSet) }), 'Test sets'), ...memberRead },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/test-sets',
    summary: 'Create a test set',
    description: described('manage-services', audited),
    request: { params: z.object({ tenant }), headers: writeHeaders, body: body(TestSetInput) },
    responses: {
      201: json(z.strictObject({ id: z.string(), ...TestSetShape }), 'Created'),
      ...testSetWrite,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/test-sets/{id}',
    summary: 'A test set, the latest version or the one asked for',
    description: described(member, notAudited),
    request: {
      params: z.object({ tenant, id: pathParam('id', 'kudos-spm') }),
      headers: readHeaders,
      query: z.object({ version: z.string().optional() }),
    },
    responses: { 200: json(TestSet, 'Test set'), ...configRead },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/test-sets/{id}',
    summary: 'Save a new version of a test set; cases are replaced only when sent',
    description: described('manage-services', audited),
    request: {
      params: z.object({ tenant, id: pathParam('id', 'kudos-spm') }),
      headers: writeHeaders,
      body: body(TestSetInput),
    },
    responses: { 200: json(TestSet, 'Saved'), ...testSetWrite },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/test-sets/{id}/cases/{case}',
    summary: 'Add or replace one case; saves a new version of the set',
    description: described('manage-services', audited),
    request: {
      params: z.object({
        tenant,
        id: pathParam('id', 'kudos-spm'),
        case: pathParam('case', 'frist'),
      }),
      headers: writeHeaders,
      body: body(
        z
          .record(z.string(), z.unknown())
          .describe('A test case without id, as in TestSet.spec.cases'),
      ),
    },
    responses: { 200: json(TestSet, 'Saved'), ...testSetWrite },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/test-sets/{id}/cases/{case}',
    summary: 'Remove one case; saves a new version of the set',
    description: described('manage-services', audited),
    request: {
      params: z.object({
        tenant,
        id: pathParam('id', 'kudos-spm'),
        case: pathParam('case', 'frist'),
      }),
      headers: writeHeaders,
    },
    responses: { 200: json(TestSet, 'Saved'), ...testSetWrite },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/test-sets/{setId}/cases',
    summary: 'The cases of a test set in the simple form the builder shows',
    description: described(member, notAudited),
    request: {
      params: z.object({ tenant, setId: pathParam('setId', 'kudos-spm') }),
      headers: readHeaders,
    },
    responses: { 200: json(z.object({ data: z.array(CaseView) }), 'Cases'), ...memberRead },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/test-sets/{setId}/cases',
    summary: 'Add a case in the simple form; saves a new version of the set',
    description: described(
      'manage-services',
      audited,
      'The change reason defaults to a fixed text.',
    ),
    request: {
      params: z.object({ tenant, setId: pathParam('setId', 'kudos-spm') }),
      headers: optionalReasonHeaders,
      body: body(
        z.object({
          id: z.string().optional().describe('Lowercase letters, digits and dashes'),
          input: z.string(),
          expected: z.string().optional().describe('Required unless type is must_reject'),
          type: z.enum(caseTypes).optional(),
          split: z.enum(caseSplits).optional(),
          reason: z.string().optional(),
        }),
      ),
    },
    responses: {
      201: json(CaseView, 'Added'),
      400: problem('Invalid case'),
      403: problem('Missing right'),
      409: problem('A case with that id exists'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/eval-runs',
    summary: 'Evaluation runs made through the eval capability, newest first',
    description: described(member, notAudited),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      query: z.object({ service: z.string().optional() }),
    },
    responses: { 200: json(z.object({ data: z.array(evalRun) }), 'Runs'), ...memberRead },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/eval-runs',
    summary: 'Start an evaluation run through the eval capability; follow it at /eval-tasks/{task}',
    description: described('manage-services', notAudited, 'The run is a task of its own.'),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      body: body(
        z.object({
          capability: z.string(),
          testSet: z.object({ id: z.string(), version: z.number().int().optional() }),
          evaluators: z.array(z.string()),
          provenance: z.object({ commit: z.string(), data: z.string() }),
          service: z.string().optional(),
          subject: z.string().optional(),
          repeats: z.number().int().positive().optional(),
          splits: z.array(z.enum(splits)).optional(),
        }),
      ),
    },
    responses: {
      202: json(RunStatus, 'Started'),
      400: problem('Invalid request or no such test set'),
      403: problem('Missing right'),
      409: problem('The monthly quota is used up'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/eval-runs/{runId}',
    summary: 'An evaluation run of either kind: a service evaluation run or an eval capability run',
    description: described(
      member,
      notAudited,
      'kind tells the two apart. A service evaluation run (from POST /tenants/{tenant}/services/{id}/eval-runs) answers with its case results; a run listed by GET /tenants/{tenant}/eval-runs answers the same body as GET /eval-runs/{id}.',
    ),
    request: {
      params: z.object({ tenant, runId: pathParam('runId', '6c1d0b9e') }),
      headers: readHeaders,
    },
    responses: {
      200: json(
        z.union([
          ServiceEvalRun.extend({ kind: z.literal('service') }),
          z.object({
            kind: z.literal('kernel'),
            run: evalRun,
            provenance: evalRun.shape.provenance,
            metrics: z.record(z.string(), metricSummary),
            byTag: z.record(z.string(), z.record(z.string(), metricSummary)),
          }),
        ]),
        'Run',
      ),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'get',
    path: '/eval-tasks/{task}',
    summary: 'Status of an evaluation started with POST /tenants/{tenant}/eval-runs',
    description: described(
      'The tenant that started it; an operator needs a support session',
      notAudited,
      'Read from the task and the stored run, so every instance answers the same, except waiting-for-scores: only the instance running the eval knows its judges have not delivered, and the others answer running.',
    ),
    request: { params: z.object({ task }), headers: readHeaders },
    responses: { 200: json(RunStatus, 'Status'), ...evalProblems },
  }),
  createRoute({
    method: 'get',
    path: '/eval-runs/compare',
    summary: 'Paired bootstrap comparison of two evaluation runs on one metric',
    description: described(
      'Access to the tenant of both runs; an operator needs a support session',
      notAudited,
    ),
    request: {
      headers: readHeaders,
      query: z.object({ baseline: z.string(), candidate: z.string(), metric: z.string() }),
    },
    responses: {
      200: json(
        z.object({
          n: z.number().int(),
          meanBaseline: z.number(),
          meanCandidate: z.number(),
          difference: z.number(),
          ci: z.tuple([z.number(), z.number()]),
        }),
        'Comparison',
      ),
      ...evalProblems,
      400: problem('The runs cannot be compared'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/eval-runs/{id}',
    summary: 'One evaluation run with provenance and metrics',
    description: described(
      'Access to the tenant of the run; an operator needs a support session',
      notAudited,
    ),
    request: { params: z.object({ id: pathParam('id', 'run-2026-10-12') }), headers: readHeaders },
    responses: {
      200: json(
        z.object({
          run: evalRun,
          provenance: evalRun.shape.provenance,
          metrics: z.record(z.string(), metricSummary),
          byTag: z.record(z.string(), z.record(z.string(), metricSummary)),
        }),
        'Run',
      ),
      ...evalProblems,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/feedback',
    summary: 'Feedback on runs; a rating given fewer than five times shows only rating and date',
    description: described(member, notAudited),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      query: z.object({ service: z.string().optional() }),
    },
    responses: { 200: json(z.object({ data: z.array(FeedbackView) }), 'Feedback'), ...memberRead },
  }),
  createRoute({
    method: 'post',
    path: '/tasks/{task}/feedback',
    summary: 'Rate a run up or down, with an optional comment and reasons; text is anonymised',
    description: described(
      'Who can read the run; a run made with an API key takes feedback only from that key',
      notAudited,
      'Recorded on the task timeline.',
    ),
    request: {
      params: z.object({ task }),
      body: body(
        z.object({
          rating: z.enum(['up', 'down']),
          comment: z.string().max(4000).optional(),
          reasons: z.array(z.string()).max(10).optional(),
        }),
      ),
    },
    responses: {
      201: json(z.object({ ok: z.literal(true), task: z.string() }), 'Recorded'),
      400: problem('The rating is not up or down'),
      401: problem('Not signed in'),
      403: problem('The run was made with another API key'),
      404: problem('No such run'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/testcase-candidates',
    summary: 'Proposed test cases that have not expired, newest first',
    description: described(member, notAudited),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      query: z.object({ service: z.string().optional() }),
    },
    responses: {
      200: json(z.object({ data: z.array(CandidateView) }), 'Candidates'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/testcase-candidates',
    summary: 'Propose a test case; personal data is removed, and refused if any is left',
    description: described(
      'manage-services',
      audited,
      'The change reason defaults to a fixed text.',
    ),
    request: {
      params: z.object({ tenant }),
      headers: optionalReasonHeaders,
      body: body(
        z.object({
          question: z.string().optional().describe('Or input'),
          input: z.string().optional(),
          answer: z.string().optional().describe('Or expected'),
          expected: z.string().optional(),
          task: z.string().optional(),
          service: z.string().optional(),
          sources: z.array(sourceRef).optional(),
          ttlDays: z.number().int().positive().optional().describe('Default 180'),
          testSet: z.string().optional().describe('Or targetTestSet; the set must exist'),
          targetTestSet: z.string().optional(),
          origin: z.enum(candidateOrigins).optional(),
        }),
      ),
    },
    responses: {
      201: json(Candidate, 'Proposed'),
      400: problem('No question, no such test set, or personal data left'),
      403: problem('Missing right'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/testcase-candidates/{id}/review',
    summary: 'Accept a candidate into a test set, or reject it',
    description: described(
      'manage-services',
      audited,
      'The change reason defaults to a fixed text.',
    ),
    request: {
      params: z.object({ tenant, id: pathParam('id', 'fb-3f9a1c2b') }),
      headers: optionalReasonHeaders,
      body: body(
        z.object({
          decision: z.enum(['accept', 'reject']),
          testSet: z.string().optional().describe('Defaults to the set it was proposed for'),
          expected: z.string().optional(),
          type: z.enum(caseTypes).optional(),
          reason: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: json(CandidateView.extend({ case: CaseView.optional() }), 'Reviewed'),
      400: problem('Invalid decision, expired, already reviewed or no test set'),
      403: problem('Missing right'),
      ...memberRead,
    },
  }),
  createRoute({
    method: 'post',
    path: '/testcase-candidates/{id}/review',
    summary: 'Accept or reject a candidate by id alone; the full candidate comes back',
    description: described('manage-services in the tenant of the candidate', audited),
    request: {
      params: z.object({ id: pathParam('id', 'fb-3f9a1c2b') }),
      headers: optionalReasonHeaders,
      body: body(
        z.object({
          decision: z.enum(['accept', 'reject']),
          testSet: z.string().optional(),
          referenceAnswer: z.string().optional(),
          type: z.enum(caseTypes).optional(),
          reason: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: json(Candidate, 'Reviewed'),
      400: problem('Expired, already reviewed or no test set'),
      403: problem('Missing right'),
      ...memberRead,
    },
  }),
];

const definitionStamp = {
  id: z.string(),
  scope: z.string().describe('"platform" or the tenant'),
  version: z.number().int(),
  mandatory: z.boolean(),
  builtin: z.boolean(),
  by: z.string().optional(),
  at: z.string().optional(),
  reason: z.string().optional(),
};

const ConfigVersion = (spec: z.ZodType) =>
  z.object({
    kind: z.string(),
    scope: z.string(),
    id: z.string(),
    version: z.number().int(),
    spec: z.object({ spec, mandatory: z.boolean().optional() }),
    deleted: z.boolean(),
    by: z.string(),
    at: z.string(),
    reason: z.string(),
  });

const GateDefinition = z.object({ ...definitionStamp, spec: gate }).openapi('Gate');
const GateInput = z
  .object({
    metric: z.string(),
    kind: z.enum(['threshold', 'no-regression']),
    threshold: z.number().min(0).max(1).optional().describe('Required for a threshold gate'),
    maxRegression: z.number().min(0).max(1).optional(),
    perTag: z.boolean().optional(),
    languages: z.array(z.enum(['nb', 'nn', 'en'])).optional(),
    split: z.enum(splits).optional(),
    mandatory: z.boolean().optional().describe('Only the platform makes a gate mandatory'),
  })
  .openapi('GateInput');

const RuleDefinition = z
  .object({ ...definitionStamp, spec: customRuleSpec })
  .openapi('GuardrailRule');
const RuleInput = z
  .object({ kind: z.enum(ruleKinds), mandatory: z.boolean().optional() })
  .catchall(z.unknown())
  .describe(
    'One rule spec as in GuardrailRule.spec, plus mandatory, which only the platform may set',
  )
  .openapi('GuardrailRuleInput');

const scopedProblems = {
  400: anyProblem('Invalid definition or missing change reason'),
  401: anyProblem('Not signed in'),
  403: anyProblem('Not allowed or missing right'),
  409: anyProblem('Changed since the version in If-Match'),
};

const scopedRoutes = (
  segment: 'gates' | 'guardrail-rules',
  noun: string,
  definition: z.ZodType,
  input: z.ZodType,
  spec: z.ZodType,
  extras: z.ZodRawShape,
): RouteConfig[] => {
  const id = pathParam('id', segment === 'gates' ? 'recall-at-10' : 'stopp-fodselsnummer');
  const list = (editable: boolean) =>
    z.object({
      data: z.array(
        editable
          ? (definition as z.ZodObject).extend({
              editable: z.boolean().describe('True for the tenant’s own'),
            })
          : definition,
      ),
      ...extras,
    });
  const versions = json(z.object({ data: z.array(ConfigVersion(spec)) }), 'Versions');
  return [
    createRoute({
      method: 'get',
      path: `/operator/${segment}`,
      summary: `Platform ${noun}s, built-in ones included`,
      description: described(operator, notAudited),
      responses: { 200: json(list(false), `${noun}s`), ...scopedProblems },
    }),
    createRoute({
      method: 'put',
      path: `/operator/${segment}/{id}`,
      summary: `Create or change a platform ${noun}; it can be made mandatory`,
      description: described(operator, audited),
      request: {
        params: z.object({ id }),
        headers: operatorWriteHeaders.extend({ 'if-match': ifMatch }),
        body: body(input),
      },
      responses: { 200: json(definition, 'Saved'), ...scopedProblems },
    }),
    createRoute({
      method: 'delete',
      path: `/operator/${segment}/{id}`,
      summary: `Remove a platform ${noun}`,
      description: described(operator, audited),
      request: { params: z.object({ id }), headers: operatorWriteHeaders },
      responses: { 200: json(definition, 'The removed definition'), ...scopedProblems },
    }),
    createRoute({
      method: 'get',
      path: `/operator/${segment}/{id}/versions`,
      summary: `Every stored version of a platform ${noun}`,
      description: described(operator, notAudited),
      request: { params: z.object({ id }) },
      responses: { 200: versions, ...scopedProblems },
    }),
    createRoute({
      method: 'get',
      path: `/tenants/{tenant}/${segment}`,
      summary: `Platform ${noun}s and the tenant's own`,
      description: described(member, notAudited),
      request: { params: z.object({ tenant }), headers: readHeaders },
      responses: { 200: json(list(true), `${noun}s`), ...configRead },
    }),
    createRoute({
      method: 'put',
      path: `/tenants/{tenant}/${segment}/{id}`,
      summary: `Create or change one of the tenant's ${noun}s`,
      description: described('manage-services', audited),
      request: {
        params: z.object({ tenant, id }),
        headers: writeHeaders.extend({ 'if-match': ifMatch }),
        body: body(input),
      },
      responses: { 200: json(definition, 'Saved'), ...configRead, ...scopedProblems },
    }),
    createRoute({
      method: 'delete',
      path: `/tenants/{tenant}/${segment}/{id}`,
      summary: `Remove one of the tenant's ${noun}s`,
      description: described('manage-services', audited),
      request: { params: z.object({ tenant, id }), headers: writeHeaders },
      responses: {
        200: json(definition, 'The removed definition'),
        ...configRead,
        ...scopedProblems,
      },
    }),
    createRoute({
      method: 'get',
      path: `/tenants/{tenant}/${segment}/{id}/versions`,
      summary: `Every stored version of one of the tenant's ${noun}s`,
      description: described(member, notAudited),
      request: { params: z.object({ tenant, id }), headers: readHeaders },
      responses: { 200: versions, ...configRead },
    }),
  ];
};

const configRoutes: RouteConfig[] = [
  ...scopedRoutes('gates', 'gate', GateDefinition, GateInput, gate, {
    kinds: z.array(z.enum(['threshold', 'no-regression'])),
  }),
  ...scopedRoutes('guardrail-rules', 'guardrail rule', RuleDefinition, RuleInput, customRuleSpec, {
    kinds: z.array(z.enum(ruleKinds)),
    builtins: z.array(z.string()).describe('Built-in guardrails a service can name'),
  }),
];

const Hit = z.object({
  chunkId: z.string(),
  document: z.string().optional(),
  position: z.number().int().optional(),
});

const diagnosticsProblems = {
  400: problem('Invalid request or settings'),
  401: problem('Not signed in'),
  404: problem('Not an operator, no support session, or not found'),
};

const diagnosticsRoutes: RouteConfig[] = [
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/diagnostics/retrieve',
    summary:
      'Run retrieval for a service or a dataset with optional overrides and show chunks and trace',
    description: described('Operators in a support session', notAudited),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      body: body(
        z.object({
          service: z.string().optional().describe('Exactly one of service and dataset'),
          dataset: z.string().optional(),
          queries: z.array(z.string()).min(1).max(10),
          userIntent: z.string().optional(),
          filters: z.record(z.string(), z.unknown()).optional(),
          overrides: z
            .object({
              limit: z.number().int().positive().optional(),
              retrieveTopK: z.number().int().positive().optional(),
              maxPerDocument: z.number().int().positive().optional(),
              queryAwareBoost: z.boolean().optional(),
              rerank: z.boolean().optional(),
              rerankCandidateK: z.number().int().positive().optional(),
              autoFilter: z.boolean().optional(),
              userIntentUnion: z.boolean().optional(),
            })
            .optional(),
        }),
      ),
    },
    responses: {
      200: json(
        z.object({
          dataset: z.union([z.string(), z.array(z.string())]),
          service: z.string().optional(),
          config: z.record(z.string(), z.unknown()).describe('The retrieval settings used'),
          chunks: z.array(
            z.object({
              chunkId: z.string(),
              document: z.string().optional(),
              position: z.number().int().optional(),
              title: z.string().optional(),
              url: z.string().optional(),
              score: z.number().optional(),
            }),
          ),
          trace: z.unknown(),
        }),
        'Retrieved',
      ),
      ...diagnosticsProblems,
      502: problem('The search engine failed'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/diagnostics/services/{service}/resolution',
    summary: 'How a service resolves: version, strategy, model, knowledge and changed settings',
    description: described('Operators in a support session', notAudited),
    request: {
      params: z.object({ tenant, service: pathParam('service', 'kudos') }),
      headers: readHeaders,
    },
    responses: {
      200: json(
        z.object({
          service: z.string(),
          version: z.number().int(),
          variant: z.string(),
          capability: z.string(),
          publicName: z.string(),
          aliases: z.array(z.string()),
          strategy: z.object({ id: z.string(), version: z.string() }).loose(),
          model: z.unknown(),
          knowledge: z.object({
            datasets: z.array(z.string()),
            reranker: z.string().nullable(),
            retrieval: z.record(z.string(), z.unknown()),
            planner: z.unknown(),
          }),
          strategyConfig: z.unknown(),
          settings: z
            .record(z.string(), z.object({ value: z.unknown(), source: z.string() }))
            .describe('Settings that differ from the default, with where they come from'),
        }),
        'Resolution',
      ),
      ...diagnosticsProblems,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/diagnostics/plan',
    summary: "Show the search queries the service's planner makes for a question",
    description: described('Operators in a support session', notAudited, 'Calls the model.'),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      body: body(z.object({ service: z.string(), query: z.string() })),
    },
    responses: {
      200: json(
        z.object({
          queries: z.array(z.string()),
          userIntent: z.string().optional(),
          model: z.string(),
          trace: z.unknown(),
        }),
        'Plan',
      ),
      ...diagnosticsProblems,
      502: problem('The search engine failed'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/diagnostics/tasks/{task}/attribution',
    summary: 'Which chunks a run found, showed and read, per search',
    description: described('Operators in a support session', notAudited),
    request: { params: z.object({ tenant, task }), headers: readHeaders },
    responses: {
      200: json(
        z.object({
          task: z.string(),
          service: z.string(),
          displayLimit: z.number().int(),
          searches: z.array(
            z.object({ queries: z.array(z.string()), hits: z.array(Hit), displayed: z.array(Hit) }),
          ),
          reads: z.array(z.object({ chunks: z.array(Hit), auto: z.boolean() })),
          pool: z.array(Hit),
          displayed: z.array(Hit),
          read: z.array(Hit),
        }),
        'Attribution',
      ),
      ...diagnosticsProblems,
    },
  }),
];

const MatrixRunView = z.object({
  id: z.string(),
  model: z.string(),
  current: z.string(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  by: z.string(),
  startedAt: z.string(),
  endedAt: z.string().nullable(),
  estimatedCostNok: z.number(),
  costNok: z.number().nullable(),
  testSets: z.number().int(),
  done: z.number().int(),
  error: z.string().optional(),
});

const MatrixScore = z.object({
  score: z.number().nullable(),
  passed: z.number().int(),
  total: z.number().int(),
});

const MatrixEstimate = z.object({
  model: z.string(),
  current: z.string(),
  testSets: z.array(
    z.object({
      tenant: z.string(),
      service: z.string(),
      name: z.string(),
      testSet: z.string(),
      cases: z.number().int(),
    }),
  ),
  cases: z.number().int(),
  estimatedCostNok: z.number(),
  unpriced: z.array(z.string()).describe('Models without a price'),
});

const matrixTable = z.object({
  columns: z.array(z.object({ name: z.string(), status: z.enum(['in_use', 'new', 'allowed']) })),
  baseline: z.array(z.number().int()),
  rows: z.array(
    z.object({
      testSet: z.string(),
      kind: z.string(),
      scores: z.array(z.number().int().nullable()),
    }),
  ),
});

const MatrixPair = z.object({
  model: z.string().describe('The model to test'),
  current: z.string().describe('The model in use to compare against'),
});

const qualityRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/operator/quality',
    summary:
      'Latest evaluation per service and test set with regressions, judge agreement and the model matrix',
    description: described(operator, notAudited),
    responses: {
      200: json(
        z.object({
          services: z.array(
            z.object({
              tenant: z.string(),
              service: z.string(),
              testSet: z.string(),
              run: z.string(),
              subject: z.string().optional(),
              endedAt: z.string(),
              servedModels: z.array(z.string()),
              metrics: z.record(z.string(), metricSummary),
              regressions: z.array(z.string()),
            }),
          ),
          judges: z.array(
            z.object({
              judge: z.string(),
              kappa: z.number(),
              observed: z.number(),
              n: z.number().int(),
              blocking: z.boolean(),
              advisory: z.boolean(),
            }),
          ),
          matrix: z.object({ models: matrixTable, blocks: matrixTable }).optional(),
          matrixRuns: z.array(MatrixRunView).optional(),
          candidates: z
            .array(
              z.object({
                id: z.string(),
                residency: z.string().nullable(),
                testSets: z.number().int(),
              }),
            )
            .optional(),
          modelsInUse: z.array(z.object({ id: z.string(), services: z.number().int() })).optional(),
        }),
        'Quality',
      ),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/quality/label-queue',
    summary: 'Judge verdicts not yet labelled by a person, at most 200',
    description: described(operator, notAudited),
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              item: z.string(),
              judge: z.string(),
              judgeLabel: z.enum(['good', 'bad']),
              tenant: z.string(),
              service: z.string(),
              case: z.string(),
              reason: z.string().optional(),
            }),
          ),
          total: z.number().int(),
        }),
        'Queue',
      ),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/quality/labels',
    summary: 'Label a judge verdict good or bad, for judge agreement',
    description: described(operator, audited),
    request: {
      headers: operatorWriteHeaders,
      body: body(
        z.object({
          item: z.string(),
          judge: z.string(),
          judgeLabel: z.string(),
          humanLabel: z.enum(['good', 'bad']),
        }),
      ),
    },
    responses: {
      200: json(judgeLabel, 'Labelled'),
      400: problem('Invalid label or missing change reason'),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/quality/matrix/estimate',
    summary: 'Estimate the cost of running every affected test set on a new model',
    description: described(operator, notAudited),
    request: { body: body(MatrixPair) },
    responses: {
      200: json(MatrixEstimate, 'Estimate'),
      400: problem('Invalid request'),
      404: problem('No such model'),
      409: problem('The model is turned off'),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/quality/matrix/runs',
    summary: 'Run the quality matrix for a new model against the model in use',
    description: described(
      operator,
      'Audited, and kept in the matrix run history.',
      'Calls models; confirm the estimated cost.',
    ),
    request: {
      headers: operatorWriteHeaders,
      body: body(MatrixPair.extend({ confirmedCostNok: z.number() })),
    },
    responses: {
      202: json(MatrixRunView, 'Started'),
      400: problem('Invalid request or missing change reason'),
      404: problem('No such model'),
      409: {
        description: 'Already running, nothing to run, model off, or cost not confirmed',
        content: {
          'application/problem+json': {
            schema: Problem.extend({ estimate: MatrixEstimate.optional() }),
          },
        },
      },
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/quality/matrix/runs/{id}',
    summary: 'One quality matrix run with scores per test set',
    description: described(operator, notAudited),
    request: { params: z.object({ id: pathParam('id', '5f0c2a8e-1d7b-4c3e-9a10-2b6d8e4f1a3c') }) },
    responses: {
      200: json(
        MatrixRunView.extend({
          rows: z.array(
            z.object({
              tenant: z.string(),
              service: z.string(),
              name: z.string(),
              testSet: z.string(),
              testSetVersion: z.number().int(),
              cases: z.number().int(),
              current: MatrixScore.nullable(),
              candidate: MatrixScore.nullable(),
            }),
          ),
        }),
        'Run',
      ),
      404: problem('Not found'),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/quality/matrix/release',
    summary: 'Release a candidate model; refused when a test set is more than 3 points worse',
    description: described(
      operator,
      audited,
      'Without a matrix run the reason must have at least 20 characters.',
    ),
    request: {
      headers: operatorWriteHeaders,
      body: body(
        z.object({
          name: z.string().optional().describe('The model id; or model'),
          model: z.string().optional(),
          kind: z.literal('models').optional(),
        }),
      ),
    },
    responses: {
      200: json(
        z.object({ model: z.string(), released: z.literal(true), run: z.string().nullable() }),
        'Released',
      ),
      400: problem('Invalid request or too short reason'),
      404: problem('No such candidate model'),
      409: {
        description: 'Already released, matrix not run, or a test set got worse',
        content: {
          'application/problem+json': { schema: Problem.extend({ run: z.string().optional() }) },
        },
      },
      ...operatorOnly,
    },
  }),
];

const Day = z.object({
  date: z.string(),
  usage: Usage,
  byService: z.record(z.string(), UsageWithRuns),
  byModel: z.record(z.string(), Usage),
});

const TenantUsage = z
  .object({
    from: z.string(),
    to: z.string(),
    priced: z.boolean(),
    totals: UsageWithRuns,
    daily: z.array(Day),
    byService: z.array(
      z.object({ service: z.string(), usage: UsageWithRuns, title: z.string().optional() }),
    ),
    byModel: z.array(z.object({ model: z.string(), usage: Usage })),
    byProject: z.array(z.object({ project: z.string(), usage: UsageWithRuns, name: z.string() })),
    project: z.string().optional(),
    ingestion: z.object({
      usage: Usage,
      byDataset: z.array(z.object({ dataset: z.string(), usage: Usage })),
    }),
  })
  .openapi('TenantUsage');

const AuditRecord = z
  .object({
    task: z.string(),
    tenant: z.string(),
    action: z.string(),
    actor: z.string(),
    actorName: z.string().optional(),
    onBehalfOf: z.string().optional(),
    at: z.string(),
    outcome: z.enum(['applied', 'rejected']),
    target: z.string(),
    reason: z.string(),
  })
  .openapi('AuditRecord');

const operationsRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/usage',
    summary: 'Tokens, requests and cost per day, service, model and project',
    description: described('view-usage', notAudited),
    request: {
      params: z.object({ tenant }),
      headers: readHeaders,
      query: z.object({
        days: z.string().optional().describe('1 to 366, default 30'),
        project: z.string().optional().describe('Only runs in this project; leaves out ingestion'),
      }),
    },
    responses: { 200: json(TenantUsage, 'Usage'), 403: problem('Missing right'), ...memberRead },
  }),
  createRoute({
    method: 'get',
    path: '/operator/usage',
    summary: 'Usage this month for each tenant asked for',
    description: described(operator, notAudited),
    request: {
      query: z.object({
        tenants: z
          .string()
          .optional()
          .describe('Comma-separated organisation numbers, at most 200'),
      }),
    },
    responses: {
      200: json(
        z.object({
          from: z.string(),
          to: z.string(),
          data: z.array(z.object({ orgNumber: z.string(), usage: UsageWithRuns })),
        }),
        'Usage',
      ),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/audit',
    summary: 'The whole audit log, newest first',
    description: described(operator, notAudited),
    responses: {
      200: json(z.object({ data: z.array(AuditRecord) }), 'Audit log'),
      404: problem('No audit log is kept'),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/audit/exports',
    summary: 'Record that the audit log was exported, with how many entries',
    description: described(operator, audited),
    request: {
      headers: operatorWriteHeaders,
      body: body(z.object({ count: z.number().int().optional() }), false),
    },
    responses: {
      200: json(z.object({ count: z.number().int() }), 'Recorded'),
      400: problem('Missing change reason'),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/operations',
    summary: 'Incidents, component health, queue and failing triggers',
    description: described(operator, notAudited),
    responses: {
      200: json(
        z.object({
          incidents: z.array(z.object({ title: z.string(), text: z.string() })),
          components: z.array(
            z.object({
              name: z.string(),
              status: z.enum(['normal', 'degraded', 'down']),
              errorRate: z.string().optional(),
              p95: z.string().optional(),
              note: z.string().optional(),
            }),
          ),
          queueStats: z.array(z.object({ label: z.string(), value: z.string() })),
          queue: z.array(
            z.object({
              type: z.string(),
              what: z.string(),
              status: z.enum(['running', 'waiting', 'failed']),
              age: z.string(),
              at: z.string(),
            }),
          ),
          triggers: z.array(
            z.object({
              tenant: z.string(),
              what: z.string(),
              error: z.string(),
              failedAt: z.string(),
              lastSuccess: z.string().optional(),
            }),
          ),
        }),
        'Operations',
      ),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/tracing',
    summary: 'Where traces are exported and how many were sent, dropped or failed',
    description: described(operator, notAudited),
    responses: {
      200: json(
        z.object({
          enabled: z.boolean(),
          source: z.literal('environment'),
          endpoint: z.string().optional().describe('Without query string or credentials'),
          content: z.boolean().optional(),
          sampleRate: z.number().optional(),
          stats: z
            .object({
              exported: z.number().int(),
              dropped: z.number().int(),
              failed: z.number().int(),
              sampledOut: z.number().int(),
            })
            .optional(),
        }),
        'Tracing',
      ),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/overview',
    summary: 'Start page: services, recent runs, usage this month and what needs attention',
    description: described(member, notAudited),
    request: { params: z.object({ tenant }), headers: readHeaders },
    responses: {
      200: json(
        z.object({
          services: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              latestVersion: z.number().int().nullable(),
              status: z.enum(['active', 'paused']),
              statusReason: z.string().nullable(),
              warnings: z.array(z.object({ model: z.string(), message: z.string() })),
              runsThisWeek: z.number().int(),
            }),
          ),
          recentTasks: z.array(TaskBase.extend({ usage: Usage.optional() })),
          usageThisMonth: UsageWithRuns.optional(),
          qualityWarnings: z.array(z.object({ service: z.string(), message: z.string() })),
          review: z.object({
            pendingToolChanges: z.number().int(),
            failedTasksLastDay: z.number().int(),
          }),
        }),
        'Overview',
      ),
      ...memberRead,
    },
  }),
];

const HookView = z
  .object({
    id: z.string(),
    scope: z.string(),
    version: z.number().int(),
    changedBy: z.string(),
    changedAt: z.string(),
    name: z.string(),
    point: z.enum(hookPoints),
    mode: z.string(),
    failure: z.string(),
    timeoutMs: z.number().int(),
    order: z.number().int(),
    enabled: z.boolean(),
    services: z.array(z.string()).optional(),
    handler: z.record(z.string(), z.unknown()),
  })
  .openapi('PlatformHook');

const hookId = pathParam('id', 'stopp-fodselsnummer');

const hookRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/operator/hooks',
    summary: 'Platform hooks, hook points and built-in hook handlers',
    description: described(operator, notAudited),
    responses: {
      200: json(
        z.object({
          data: z.array(HookView),
          points: z.array(z.enum(hookPoints)),
          builtins: z.array(
            z.object({
              id: z.string(),
              title: z.string(),
              description: z.string(),
              configSchema: z.record(z.string(), z.unknown()),
            }),
          ),
        }),
        'Hooks',
      ),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/hooks/{id}',
    summary:
      'Create or change a platform hook; If-Match with the version guards against lost updates',
    description: described(operator, audited),
    request: {
      params: z.object({ id: hookId }),
      headers: operatorWriteHeaders.extend({ 'if-match': ifMatch }),
      body: body(hookSpec),
    },
    responses: {
      200: json(
        HookView.omit({ changedBy: true, changedAt: true }),
        'Saved; the spec with defaults filled in',
      ),
      400: problem('Invalid hook or missing change reason'),
      409: problem('Changed by someone else'),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'delete',
    path: '/operator/hooks/{id}',
    summary: 'Remove a platform hook',
    description: described(operator, audited),
    request: { params: z.object({ id: hookId }), headers: operatorWriteHeaders },
    responses: {
      200: json(z.object({ removed: z.string() }), 'Removed'),
      400: problem('Missing change reason'),
      404: problem('No such hook'),
      ...operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/hooks/{id}/test',
    summary: 'Call a platform hook with a sample for its point and show the verdict',
    description: described(operator, notAudited),
    request: { params: z.object({ id: hookId }) },
    responses: {
      200: json(
        z.object({
          refused: z.object({ hook: z.string(), name: z.string(), reason: z.string() }).optional(),
          records: z.array(
            z.object({
              hook: z.string(),
              name: z.string(),
              scope: z.string(),
              point: z.enum(hookPoints),
              mode: z.string(),
              outcome: z.enum(['allowed', 'annotated', 'refused', 'ignored', 'failed']),
              reason: z.string().optional(),
              annotations: z.record(z.string(), z.unknown()).optional(),
              ms: z.number(),
            }),
          ),
          payload: z
            .record(z.string(), z.unknown())
            .describe('The sample the hook was called with'),
        }),
        'Verdict',
      ),
      404: problem('No such hook'),
      409: problem('Hooks are off'),
      ...operatorOnly,
    },
  }),
];

const keyError = json(z.object({ error: z.string() }), 'Invalid or missing API key');

const RateLimited = {
  description: 'Too many calls',
  content: {
    'application/json': {
      schema: z.object({
        error: z.object({
          code: z.literal('rate_limited'),
          message: z.string(),
          limit: z.number(),
          window_ms: z.number(),
        }),
      }),
    },
    'application/problem+json': { schema: Problem },
  },
};

const JsonRpcId = z.union([z.string(), z.number(), z.null()]);
const JsonRpcRequest = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: JsonRpcId.optional().describe('Left out for a notification'),
    method: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  })
  .openapi('JsonRpcRequest');
const JsonRpcResponse = z
  .union([
    z.object({ jsonrpc: z.literal('2.0'), id: JsonRpcId, result: z.unknown() }),
    z.object({
      jsonrpc: z.literal('2.0'),
      id: JsonRpcId,
      error: z.object({
        code: z.number().int(),
        message: z.string(),
        data: z.unknown().optional(),
      }),
    }),
  ])
  .openapi('JsonRpcResponse');
const rpc = (description: string) => json(JsonRpcResponse, description);
const rpcOrStream = (description: string) => ({
  description,
  content: {
    'application/json': { schema: JsonRpcResponse },
    'text/event-stream': {
      schema: z.string().describe('JSON-RPC responses, one per data line'),
    },
  },
});

const AgentCard = z
  .object({
    name: z.string(),
    description: z.string(),
    version: z.string(),
    provider: z.object({ organization: z.string(), url: z.string() }).optional(),
    documentationUrl: z.string().optional(),
    supportedInterfaces: z.array(
      z.object({ url: z.string(), protocolBinding: z.string(), protocolVersion: z.string() }),
    ),
    capabilities: z.object({
      streaming: z.boolean(),
      pushNotifications: z.boolean().optional(),
      extendedAgentCard: z.boolean().optional(),
      extensions: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
    securitySchemes: z.record(z.string(), z.unknown()),
    securityRequirements: z.array(z.record(z.string(), z.unknown())),
    defaultInputModes: z.array(z.string()),
    defaultOutputModes: z.array(z.string()),
    skills: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        description: z.string(),
        tags: z.array(z.string()),
        inputModes: z.array(z.string()).optional(),
        outputModes: z.array(z.string()).optional(),
      }),
    ),
  })
  .openapi('AgentCard');

const agent = pathParam('agent', '991825827--kudos');
const apiKeyHeaders = z.object({
  authorization: z.string().optional().describe('Bearer API key or token'),
  'x-api-key': z.string().optional(),
});
const versionHeader = z
  .string()
  .optional()
  .describe('Pin a published version of the service; a positive whole number');

const ToolResult = z
  .object({
    answer: z.string(),
    status: z.enum(['ok', 'error']),
    ai_generated: z.literal(true).optional(),
    no_answer: z.literal(true).optional(),
    notice: z.string().optional(),
    fields: z.record(z.string(), z.unknown()).optional(),
    conversation_id: z.string().optional(),
    sources: z
      .array(
        z.object({
          uri: z.string(),
          name: z.string(),
          excerpt: z.string().optional(),
          version: z.string().optional(),
          published_at: z.string().optional(),
        }),
      )
      .optional(),
    chunks: z
      .array(
        z.object({
          chunk_id: z.string(),
          doc_num: z.string().optional(),
          chunk_index: z.number().optional(),
          title: z.string().optional(),
          url: z.string().optional(),
        }),
      )
      .optional(),
    error: z.object({ code: z.string(), message: z.string() }).optional(),
  })
  .openapi('ToolResult');
const ToolError = Problem.extend({
  code: z.string().optional(),
  error: z.object({ code: z.string(), message: z.string() }),
});

const toolKeyError = {
  description: 'Invalid or missing API key',
  content: {
    'application/problem+json': {
      schema: Problem.extend({ code: z.string().optional(), error: z.string() }),
    },
  },
};

const toolError = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: ToolError } },
});

const protocolRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/a2a',
    summary: 'Agent cards for the services the caller may use over A2A',
    description: described(
      'An API key or token; without one, the public cards when public discovery is on',
      notAudited,
    ),
    request: { headers: apiKeyHeaders },
    responses: {
      200: json(z.object({ agents: z.array(AgentCard) }), 'Agent cards'),
      401: keyError,
      429: problem('Public discovery is rate limited per address'),
    },
  }),
  ...['/a2a/{agent}', '/a2a/{agent}/.well-known/agent-card.json'].map((path) =>
    createRoute({
      method: 'get',
      path,
      summary: 'The agent card of one service',
      description: described(
        'An API key or token; without one, the public card when public discovery is on',
        notAudited,
      ),
      request: { params: z.object({ agent }), headers: apiKeyHeaders },
      responses: {
        200: json(AgentCard, 'Agent card'),
        401: keyError,
        404: json(z.object({ error: z.string(), code: z.string() }), 'No such agent'),
        429: problem('Public discovery is rate limited per address'),
      },
    }),
  ),
  createRoute({
    method: 'post',
    path: '/a2a/{agent}',
    summary:
      'A2A JSON-RPC: SendMessage, SendStreamingMessage, GetTask, CancelTask, SubscribeToTask, ListTasks',
    description: described(
      'An API key or token allowed to use the service',
      notAudited,
      'Errors come as JSON-RPC errors; the streaming methods answer with server-sent events.',
    ),
    request: {
      params: z.object({ agent }),
      headers: apiKeyHeaders.extend({
        'a2a-version': z.string().optional().describe('1.0, or 0.3 for the legacy method names'),
      }),
      body: body(JsonRpcRequest),
    },
    responses: {
      200: rpcOrStream('Result or JSON-RPC error'),
      400: rpc('Not JSON, or not a JSON-RPC 2.0 request'),
      401: keyError,
      404: rpc('No such agent'),
      413: rpc('Body too large'),
      429: RateLimited,
      503: rpc('The service is paused'),
    },
  }),
  ...(['get', 'delete'] as const).map((method) =>
    createRoute({
      method,
      path: '/api/mcp',
      summary: 'Not allowed; the MCP endpoint accepts POST only',
      description: described('An API key or token', notAudited),
      request: { headers: apiKeyHeaders },
      responses: { 401: keyError, 405: rpc('Method not allowed') },
    }),
  ),
  createRoute({
    method: 'post',
    path: '/api/mcp',
    summary:
      'MCP over streamable HTTP: initialize, server/discover, tools/list and tools/call, one service per tool',
    description: described(
      'An API key or token',
      notAudited,
      'A tools/call with a progress token answers with server-sent events.',
    ),
    request: {
      headers: apiKeyHeaders.extend({
        'mcp-protocol-version': z.string().optional(),
        'genai-version': versionHeader,
      }),
      body: body(JsonRpcRequest),
    },
    responses: {
      200: rpcOrStream('Result or JSON-RPC error'),
      202: { description: 'A notification was accepted' },
      400: rpc('Not JSON, a batch, or invalid parameters'),
      401: keyError,
      404: rpc('Unknown method'),
      409: rpc('The pinned version does not exist'),
      413: rpc('Body too large'),
      429: RateLimited,
      503: rpc('The service is paused'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/api/tools/openapi.json',
    summary: 'OpenAPI document with one call operation per service the caller may use',
    description: described('An API key or token', notAudited),
    request: { headers: apiKeyHeaders.extend({ 'accept-language': z.string().optional() }) },
    responses: {
      200: json(
        z
          .object({
            openapi: z.literal('3.1.0'),
            info: z.object({ title: z.string(), version: z.string() }).loose(),
            servers: z.array(z.object({ url: z.string() })),
            paths: z.record(z.string(), z.unknown()),
          })
          .loose(),
        'OpenAPI document',
      ),
      401: toolKeyError,
      500: toolError('The document could not be made'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/api/tools/call/{tool}',
    summary: 'Call one service as a tool with a query or its form fields',
    description: described('An API key or token allowed to use the service', notAudited),
    request: {
      params: z.object({ tool: pathParam('tool', '991825827__kudos') }),
      headers: apiKeyHeaders.extend({ 'genai-version': versionHeader }),
      body: body(
        z
          .object({
            query: z.string().optional(),
            conversation_id: z.string().optional(),
          })
          .catchall(z.unknown())
          .describe('The query, or the form fields of the service'),
      ),
    },
    responses: {
      200: json(ToolResult, 'Answer; status is error for a failure the caller can act on'),
      400: {
        description: 'Invalid version header, overrides or form input',
        content: {
          'application/problem+json': {
            schema: Problem.extend({
              code: z.string().optional(),
              error: z.object({ code: z.string(), message: z.string() }).optional(),
            }),
          },
        },
      },
      401: toolKeyError,
      403: toolError('The key may not reach this service or mode'),
      404: toolError('No such tool'),
      409: toolError('No such published version'),
      413: toolError('The request body is too large'),
      429: RateLimited,
      500: toolError('Internal error'),
      503: toolError('The service is paused'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/up',
    summary: 'Liveness probe for load balancers; plain text ok',
    description: described('None', notAudited),
    responses: {
      200: { description: 'Up', content: { 'text/plain': { schema: z.literal('ok') } } },
    },
  }),
];

export const workRoutes: RouteConfig[] = [
  ...projectRoutes,
  ...taskRoutes,
  ...evalRoutes,
  ...configRoutes,
  ...diagnosticsRoutes,
  ...qualityRoutes,
  ...operationsRoutes,
  ...hookRoutes,
  ...protocolRoutes,
];

export const registerWorkRoutes = (app: unknown) => {
  const registry = (app as { openAPIRegistry?: { registerPath(route: RouteConfig): void } })
    .openAPIRegistry;
  if (registry) for (const route of workRoutes) registry.registerPath(route);
};

export const workOpenApiModule: PlatformModuleFactory = () => ({
  id: 'work-openapi',
  mount: (app) => registerWorkRoutes(app),
});
