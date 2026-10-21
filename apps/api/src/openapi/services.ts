import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { definitionKinds } from '@genai/definitions';
import { serviceIntents, skillIntents, unavailableReasons } from '@genai/strategy-builder';
import { turnBody } from '../assistant.js';
import { InputField } from '../frontend-openapi.js';
import { changeReason, problemContent } from '../http.js';
import type { PlatformModuleFactory } from '../platform-modules.js';
import { runSchema } from '../playground.js';

const pathParam = (name: string, example?: string) =>
  z.string().openapi({ param: { name, in: 'path' }, ...(example ? { example } : {}) });
const tenant = pathParam('tenant', '991825827');
const service = pathParam('id', 'klarsprak');
const skill = pathParam('id', 'klart-sprak');
const pid = pathParam('pid');
const runId = pathParam('runId');

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const taskHeader = z.object({
  'genai-task': z.string().openapi({ description: 'The audit task that recorded the change' }),
});
const audited = <T extends z.ZodType>(schema: T, description: string) => ({
  ...json(schema, description),
  headers: taskHeader,
});
const problem = (description: string) => ({ description, content: problemContent });
const sse = (description: string) => ({
  description,
  content: { 'text/event-stream': { schema: z.string() } },
});
const body = <T extends z.ZodType>(schema: T, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});
const optionalReason = (fallback: string) =>
  z.object({
    'change-reason': z
      .string()
      .optional()
      .openapi({
        param: { name: 'change-reason', in: 'header' },
        description: `Why; recorded in the audit log. Defaults to "${fallback}"`,
      }),
  });

const signedIn = { 401: problem('Not signed in') };
const tenantErrors = {
  ...signedIn,
  403: problem('Missing right'),
  404: problem('The tenant is not reachable for the caller'),
};
const operatorErrors = { ...signedIn, 403: problem('Not an operator') };

const record = z.record(z.string(), z.unknown());
const files = z.record(z.string(), z.string());
const fieldError = z.object({ path: z.string(), message: z.string() });
const residency = z.enum(['norway', 'eu', 'global']);
const scalar = z.union([z.string(), z.number()]);
const filterValue = z.union([
  scalar,
  z.boolean(),
  z.array(scalar),
  z.object({ gte: scalar.optional(), lte: scalar.optional() }),
]);
const inputValue = z.union([z.string(), z.number(), z.array(z.string())]);
const part = z
  .object({ mime: z.string(), body: record, meta: record.optional() })
  .openapi({ description: 'A typed part: text, json, blob or file in `body.kind`' });
const tokens = z.object({ input: z.number(), output: z.number() });

const ServiceSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    purpose: z.string(),
    outputKind: z.string(),
    channels: z.array(z.string()),
    latestVersion: z.number().int().nullable(),
    status: z.enum(['active', 'paused']),
    statusReason: z.string().nullable(),
    lifecycle: z.enum(['active', 'paused', 'archived']),
    warnings: z.array(z.object({ model: z.string(), message: z.string() })),
    updatedAt: z.string().nullable(),
    updatedBy: z.string().nullable(),
    updatedByName: z.string().optional(),
    runsThisWeek: z.number().int(),
  })
  .openapi('ServiceSummary');

const ServiceDraft = z
  .object({
    revision: z.number().int(),
    definition: record,
    files,
    baseVersion: z.number().int().nullable(),
    latestVersion: z.number().int().nullable(),
    at: z.string(),
    reason: z.string(),
  })
  .openapi('ServiceDraft');

const DraftConflict = z
  .object({ path: z.string(), published: z.unknown(), draft: z.unknown() })
  .openapi('DraftConflict');

const OpenedDraft = ServiceDraft.extend({
  behind: z.boolean().openapi({
    description:
      'The draft still builds on an older published version; true after open only when the caller may not rebase or the rebase has conflicts',
  }),
  conflicts: z.array(DraftConflict).openapi({
    description:
      'Paths changed both in the draft and in a newer published version; the draft keeps its value until the person picks one',
  }),
  rebasedFrom: z.number().int().optional().openapi({
    description: 'Set when opening rebased the draft cleanly; the version it was built on before',
  }),
}).openapi('OpenedServiceDraft');

const UiText = z
  .object({ nb: z.string(), en: z.string() })
  .openapi('UiText', { description: 'A text in bokmål and English' });

const StrategyCatalogueEntry = z
  .object({
    id: z.string(),
    version: z.number().int(),
    how: z.enum(['single', 'agent', 'flow']).openapi({
      description: 'The way of working the strategy belongs to: one step, an agent, or a step flow',
    }),
    default: z.boolean().openapi({
      description: 'The strategy to pick when a person chooses only the way of working',
    }),
    title: UiText,
    description: UiText,
    pipeline: z.array(
      z.object({ title: UiText, description: UiText, repeats: z.literal(true).optional() }),
    ),
    newConfig: record.openapi({
      description: 'Starting values for spec.strategy.config when a service switches to it',
    }),
    takes: z
      .object({
        instructions: z.enum(['required', 'optional', 'no']),
        examples: z.enum(['required', 'optional', 'no']),
      })
      .openapi({
        description:
          'Whether spec.strategy.config takes the service instructions and examples, read from its schema',
      }),
    defaultInstructions: z
      .object({
        text: UiText.openapi({
          description:
            'The instructions the strategy uses when the service has none, per answer language. A placeholder such as {date} is filled in at run time',
        }),
        note: UiText.optional().openapi({
          description: 'What the platform adds to the instructions at run time',
        }),
      })
      .optional()
      .openapi({
        description:
          'The built-in instructions, only for a strategy that has them. Writing instructions in the service replaces them',
      }),
    schema: z.string().openapi({ description: 'The config schema, with labels, under /schemas' }),
  })
  .openapi('StrategyCatalogueEntry');

const TestSetSummary = z
  .object({
    id: z.string(),
    name: z.string(),
    version: z.number().int(),
    cases: z.number().int(),
    splits: z.object({ locked: z.number().int(), open: z.number().int() }),
    split: z.enum(['locked', 'open']).optional(),
  })
  .openapi('ServiceTestSetSummary');

const EvalRunSummary = z
  .object({
    id: z.string(),
    service: z.string(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed']),
    testSet: z.string(),
    testSetVersion: z.number().int(),
    version: z.union([z.literal('draft'), z.number().int()]),
    split: z.enum(['locked', 'open']).optional(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    score: z.number().nullable(),
    passed: z.number().int(),
    total: z.number().int(),
    cost: z.number().nullable(),
    tokens,
    error: z.string().optional(),
    owner: z.string().optional(),
    heartbeatAt: z.string().optional(),
  })
  .openapi('ServiceEvalRunSummary');

const Improvement = z
  .object({
    id: z.string(),
    status: z.enum(['running', 'ready', 'failed', 'approved', 'rejected']),
    language: z.string().optional(),
    change: z.object({ path: z.string(), before: z.string(), after: z.string() }).nullable(),
    scores: z
      .object({
        testSet: z.string(),
        before: z.number().nullable(),
        after: z.number().nullable(),
        passedBefore: z.number().int(),
        passedAfter: z.number().int(),
        total: z.number().int(),
      })
      .nullable(),
    examples: z.array(z.object({ input: z.string(), before: z.string(), after: z.string() })),
    reasons: z.array(z.string()),
    createdAt: z.string(),
    decision: z.object({ approved: z.boolean(), at: z.string(), reason: z.string() }).optional(),
    error: z.string().optional(),
  })
  .openapi('ServiceImprovement');

const Lifecycle = z
  .object({
    state: z.enum(['active', 'paused', 'archived']),
    reason: z.string().optional(),
    by: z.string().optional(),
    at: z.string().optional(),
  })
  .openapi('ServiceLifecycle');

const RiskConfirmation = z
  .object({ riskClass: z.enum(['limited', 'high']), by: z.string(), at: z.string() })
  .openapi('RiskConfirmation');

const range = z.object({ low: z.number(), high: z.number() });
const perItem = z.object({
  inputTokens: range,
  outputTokens: range,
  costMicroNok: range.nullable(),
});
const BatchDocument = z.object({ id: z.string(), title: z.string(), url: z.string().optional() });
const batchItemStatus = z.enum(['queued', 'running', 'succeeded', 'notFound', 'failed', 'skipped']);

const BatchEstimate = z
  .object({
    id: z.string(),
    service: z.string(),
    version: z.number().int(),
    model: z.string().nullable(),
    priced: z.boolean(),
    dataset: z.string(),
    filters: z.record(z.string(), filterValue),
    prompt: z.string().optional(),
    input: z.record(z.string(), inputValue).optional(),
    found: z.number().int().optional(),
    excluded: z
      .object({
        duplicates: z.array(z.object({ document: BatchDocument, keptId: z.string() })),
        otherYear: z.array(BatchDocument),
      })
      .optional(),
    items: z.number().int(),
    perItem,
    maxOutputTokens: z.number().int(),
    tokens: range,
    costMicroNok: range.nullable(),
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
    preview: z.array(BatchDocument).openapi({ description: 'The first 20 documents' }),
    approval: z.object({ limitNok: z.number(), required: z.boolean() }),
  })
  .openapi('BatchEstimate');

const BatchRun = z
  .object({
    id: z.string(),
    service: z.string(),
    version: z.number().int(),
    model: z.string().nullable(),
    priced: z.boolean(),
    dataset: z.string(),
    filters: z.record(z.string(), filterValue),
    prompt: z.string().optional(),
    input: z.record(z.string(), inputValue).optional(),
    estimate: z.string(),
    startedBy: z.string().optional(),
    startedByName: z.string().optional(),
    costApproval: z
      .object({ by: z.string(), at: z.string(), reason: z.string(), limitNok: z.number() })
      .optional(),
    status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'stopped']),
    total: z.number().int(),
    concurrency: z.number().int(),
    cap: z.object({ costMicroNok: z.number().optional(), tokens: z.number().optional() }),
    perItem,
    maxOutputTokens: z.number().int().optional(),
    pass: z.number().int(),
    startedAt: z.string(),
    endedAt: z.string().nullable(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
    counts: z.record(batchItemStatus, z.number().int()),
    tokens,
    costMicroNok: z.number().nullable(),
  })
  .openapi('BatchRun');

const BatchItem = z
  .object({
    run: z.string(),
    index: z.number().int(),
    document: BatchDocument,
    status: batchItemStatus,
    attempts: z.number().int(),
    pass: z.number().int(),
    task: z.string().optional(),
    version: z.number().int().optional(),
    output: z.string().optional(),
    noAnswer: z.boolean().optional(),
    truncated: z.boolean().optional(),
    error: z.string().optional(),
    errorCode: z.string().optional(),
    sources: z.array(
      z.object({
        title: z.string().optional(),
        url: z.string().optional(),
        document: z.string().optional(),
      }),
    ),
    models: z.array(z.string()),
    tokens,
    costMicroNok: z.number(),
    startedAt: z.string().optional(),
    endedAt: z.string().optional(),
  })
  .openapi('BatchItem');

const BatchExport = z
  .object({
    run: z.object({
      id: z.string(),
      service: z.string(),
      version: z.number().int(),
      model: z.string().nullable(),
      dataset: z.string(),
      filters: z.record(z.string(), filterValue),
      prompt: z.string().nullable(),
      startedAt: z.string(),
      endedAt: z.string().nullable(),
      status: z.string(),
      approval: record.optional(),
    }),
    items: z.array(
      z.object({
        index: z.number().int(),
        document: BatchDocument.extend({ dataset: z.string() }),
        status: batchItemStatus,
        output: z.string().nullable(),
        noAnswer: z.boolean(),
        truncated: z.boolean(),
        error: z.string().nullable(),
        sources: z.array(record),
        service: z.string(),
        version: z.number().int(),
        models: z.array(z.string()),
        tokens,
        costMicroNok: z.number().nullable(),
        task: z.string().nullable(),
        attempts: z.number().int(),
        approved: z.boolean().optional(),
      }),
    ),
  })
  .openapi('BatchExport');

const proposalShape = {
  id: z.string(),
  level: z.number().int().min(1).max(4),
  kind: z.enum(['change', 'connector', 'building_block', 'platform_change']),
  title: z.string(),
  detail: z.string(),
  section: z.string().optional(),
  patch: z.array(record).optional(),
  after: record.optional(),
  validation: z.object({ ok: z.boolean(), errors: z.array(fieldError).optional() }),
  requiresApproval: z.boolean(),
  appliedToDraft: z.literal(false),
  storedProposalId: z.string().optional(),
  mapping: z.array(record).optional(),
  source: record.optional(),
  permissions: z.array(record).optional(),
  tests: z.array(record).optional(),
  quality: z.string().optional(),
  platformChange: record.optional(),
  approval: z.object({ right: z.string() }).optional(),
};

const AssistantTurn = z
  .object({
    turnId: z.string(),
    status: z.enum(['completed', 'refused', 'unavailable', 'budget_exhausted']),
    reason: z.enum(unavailableReasons).optional().openapi({
      description:
        'Why the assistant is unavailable, only with `status: unavailable`: `not_published` (the builder service is not published), `no_model` (no usable model with tool support), `model_failed` (the model run failed; `turnId` is the task id), `empty_result` (the run gave no result; `turnId` is the task id)',
    }),
    message: z.string(),
    questions: z
      .array(
        z.object({
          id: z.string(),
          label: z.string(),
          options: z.array(z.string()),
          allowOther: z.boolean(),
        }),
      )
      .optional(),
    proposals: z.array(z.object(proposalShape)),
    rejected: z
      .array(z.object({ attempted: z.string(), reason: z.string(), code: z.string() }))
      .optional(),
    policy: record.optional(),
    improvedInstructions: z
      .object({ before: z.string(), after: z.string(), changes: z.array(z.string()) })
      .optional(),
    testCases: z
      .array(
        z.object({
          id: z.string(),
          input: z.string(),
          expected: z.string(),
          source: z.string().optional(),
        }),
      )
      .optional(),
    usage: z.object({
      tokens: z.number(),
      budgetLeftToday: z.number(),
      dailyBudget: z.number(),
    }),
  })
  .openapi('AssistantTurn');

const assistantTurnRoute = (path: string, target: string, intents: readonly string[]) =>
  createRoute({
    method: 'post',
    path,
    summary: `Ask the builder assistant about a ${target} draft; proposals are never applied to the draft. Needs manage-services; the turn runs as an audited task`,
    request: {
      params: z.object({ tenant, id: pathParam('id') }),
      body: body(turnBody.extend({ intent: z.enum(intents as [string, ...string[]]).optional() })),
    },
    responses: {
      200: {
        description:
          'The turn. With `stream: true` the body is text/event-stream with delta, paragraph, question, rejected and proposal events, then `done` carrying `{turn}`',
        content: {
          'application/json': { schema: AssistantTurn },
          'text/event-stream': { schema: z.string() },
        },
      },
      400: problem('Invalid body or intent'),
      ...signedIn,
      403: problem(
        'Not allowed for this tenant, missing right, or the draft belongs to another tenant',
      ),
      422: problem('The draft is not valid YAML'),
    },
  });

const CatalogProposal = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    createdBy: z.literal('assistant'),
    forService: z.object({ id: z.string(), name: z.string() }),
    createdAt: z.string(),
    ask: z.string().optional(),
    detail: z.string().optional(),
    item: record.optional(),
    mapping: z.array(record).optional(),
    source: record.optional(),
    permissions: z.array(
      z.object({ type: z.string(), value: z.string(), note: z.string().optional() }),
    ),
    tests: z.array(
      z.object({ name: z.string(), passed: z.boolean(), reason: z.string().optional() }),
    ),
    quality: z.string().optional(),
    state: z.enum(['pending', 'sent_for_approval', 'approved', 'rejected']),
    platformChange: z
      .object({
        summary: z.string(),
        caseId: z.string(),
        status: z.enum(['sent', 'under_review', 'planned', 'rejected']),
        rejectionReason: z.string().optional(),
      })
      .optional(),
    decision: z
      .object({ by: z.string(), byName: z.string().optional(), at: z.string(), reason: z.string() })
      .optional(),
  })
  .openapi('CatalogProposal');

const ProposalDecision = z
  .object({
    proposal: CatalogProposal,
    changedBy: z.object({
      by: z.string(),
      byName: z.string().optional(),
      at: z.string(),
      reason: z.string(),
    }),
  })
  .openapi('ProposalDecision');

const OperatorProposal = CatalogProposal.extend({
  tenant: z.string(),
  tenantName: z.string(),
  title: z.string(),
  summary: z.string(),
  status: z.enum(['pending', 'approved', 'rejected']),
  caseId: z.string().optional(),
}).openapi('OperatorProposal');

const reasonBody = z.object({
  reason: z
    .string()
    .optional()
    .openapi({ description: 'Used instead of the change-reason header' }),
});

const proposalDecisionRoute = (op: string, summary: string) =>
  createRoute({
    method: 'post',
    path: `/tenants/{tenant}/proposals/{pid}/${op}`,
    summary,
    request: {
      params: z.object({ tenant, pid }),
      headers: changeReason,
      body: body(
        op === 'approve'
          ? z.object({
              connection: z
                .object({
                  host: z.string().optional(),
                  port: z.number().int().optional(),
                  database: z.string().optional(),
                  user: z.string(),
                  password: z.string(),
                  tls: z.boolean().optional(),
                })
                .optional()
                .openapi({ description: 'Level 2: how the platform logs in to the database' }),
              source: record.optional().openapi({
                description: 'Level 2: table and fields, when the proposal lacks them',
              }),
            })
          : z.object({}),
        false,
      ),
    },
    responses: {
      200: audited(ProposalDecision, 'Decided'),
      400: problem('Missing or short reason'),
      ...signedIn,
      403: problem('Missing right'),
      404: problem('No such tenant for you, or no such proposal'),
      409: problem('Already decided, a platform change, or database connectors are off'),
      422: problem('Level 2 or 3 approval could not connect or register the building block'),
    },
  });

const SkillPublisher = z.object({ type: z.enum(['own', 'digdir', 'shared']), name: z.string() });
const shareState = z.enum(['none', 'pending_digdir', 'shared', 'rejected']);

const SkillSummary = z
  .object({
    id: z.string(),
    owner: z.string(),
    name: z.string(),
    description: z.string(),
    version: z.number().int().nullable(),
    draftRevision: z.number().int().nullable(),
    hasChanges: z.boolean(),
    status: z.enum(['draft', 'published']),
    share: shareState,
    sharedWith: z.number().int(),
    publisher: SkillPublisher,
    usedBy: z.number().int(),
    services: z.array(
      z.object({ service: z.string(), name: z.string(), version: z.number().int() }),
    ),
    readOnly: z.boolean(),
  })
  .openapi('SkillSummary');

const SkillVersion = z
  .object({
    version: z.number().int(),
    publishedAt: z.string(),
    by: z.string(),
    reason: z.string(),
    score: z.number().nullable(),
    passed: z.number().int().optional(),
    total: z.number().int().optional(),
  })
  .openapi('SkillVersion');

const SkillTestRun = z
  .object({
    id: z.number().int(),
    skill: z.string(),
    draftRevision: z.number().int(),
    startedAt: z.string(),
    endedAt: z.string(),
    by: z.string(),
    model: z.string(),
    judge: z.string().nullable(),
    passed: z.number().int(),
    total: z.number().int(),
    passRate: z.number(),
    threshold: z.number(),
    costNok: z.number(),
    cases: z.array(
      z.object({
        index: z.number().int(),
        input: z.string(),
        expected: z.union([z.string(), record]),
        type: z.enum(['criteria', 'fields', 'must_reject']),
        context: z.string().optional(),
        dataset: z.string().optional(),
        passed: z.boolean(),
        answer: z.string(),
        fields: record.optional(),
        score: z.number().nullable(),
        reason: z.string().optional(),
        task: z.string().optional(),
        costNok: z.number(),
      }),
    ),
  })
  .openapi('SkillTestRun');

const SkillRequirement = z
  .object({
    id: z.enum(['tested-on-draft', 'pass-rate', 'must-reject', 'published-tools']),
    label: z.string(),
    met: z.boolean(),
    detail: z.string().optional(),
    reason: z.enum(['no_cases', 'not_run', 'stale']).optional(),
    passedCases: z.number().int().optional(),
    total: z.number().int().optional(),
    threshold: z.number().optional(),
    unpublishedTools: z.array(z.string()).optional(),
  })
  .openapi('SkillRequirement');

const SkillShare = z
  .object({
    id: z.string().openapi({ description: '<tenant>-<skill>' }),
    tenant: z.string(),
    skill: z.string(),
    version: z.number().int(),
    state: shareState,
    by: z.string(),
    at: z.string(),
    reason: z.string(),
    decision: z
      .object({
        approved: z.boolean(),
        by: z.string(),
        byName: z.string().optional(),
        at: z.string(),
        reason: z.string(),
      })
      .optional(),
  })
  .openapi('SkillShare');

const SkillDetail = SkillSummary.extend({
  draft: z
    .object({
      revision: z.number().int(),
      definition: record,
      by: z.string(),
      at: z.string(),
      reason: z.string(),
      problems: z.array(fieldError),
      copiedFrom: z
        .object({ owner: z.string(), id: z.string(), version: z.number().int() })
        .optional(),
    })
    .nullable(),
  published: record.nullable().openapi({ description: 'The latest published Skill definition' }),
  versions: z.array(SkillVersion),
  lastTestRun: SkillTestRun.nullable(),
  stale: z.boolean(),
  threshold: z.number(),
  requirements: z.array(SkillRequirement),
  shareRequest: SkillShare.nullable(),
  attachmentSizes: z.record(z.string(), z.number()),
}).openapi('SkillDetail');

const SkillFix = z
  .object({
    id: z.string(),
    fixId: z.string(),
    skill: z.string(),
    draftRevision: z.number().int(),
    before: z.string(),
    after: z.string(),
    reasons: z.array(z.string()),
    status: z.enum(['proposed', 'applied']),
  })
  .openapi('SkillFix');

const ownerQuery = z.object({
  owner: z
    .string()
    .optional()
    .openapi({ description: 'The tenant that owns a shared skill; defaults to the caller tenant' }),
});

const ifMatchHeader = z.object({
  'if-match': z
    .string()
    .optional()
    .openapi({ description: 'The draft revision you edited; a newer draft gives 409' }),
});

const fileUpload = {
  required: true,
  content: {
    'multipart/form-data': { schema: z.object({ file: z.string().openapi({ format: 'binary' }) }) },
    'application/json': {
      schema: z.object({
        name: z.string().optional(),
        fileName: z.string().optional(),
        contentBase64: z.string(),
      }),
    },
    'application/octet-stream': {
      schema: z.string().openapi({ format: 'binary', description: 'Name in the `name` query' }),
    },
  },
};

const PlaygroundQuota = z.object({ usedPercent: z.number(), monthlyTokens: z.number() });
const playgroundPolicy = z.object({
  block: z.string(),
  rule: z.string(),
  ownedBy: z.string(),
  link: z.string(),
});
const blockStatus = z.enum(['allowed', 'requires_approval', 'not_allowed']);
const playgroundOutput = z.enum(['text', 'fields']);

const PlaygroundOptions = z
  .object({
    services: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        chat: z.boolean(),
        exampleQuestions: z.array(z.string()),
        versions: z.array(
          z.object({
            version: z.number().int(),
            draft: z.boolean(),
            inUse: z.boolean(),
            setup: z.object({
              model: z.string(),
              datasets: z.array(z.string()),
              skills: z.array(z.string()),
              blocks: z.array(z.string()),
              output: playgroundOutput,
            }),
            inputFields: z.array(InputField).optional(),
          }),
        ),
        latestVersion: z.number().int(),
      }),
    ),
    models: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        dataLocation: residency,
        status: blockStatus,
        policy: playgroundPolicy.optional(),
      }),
    ),
    datasets: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        dataLocation: residency,
        status: blockStatus,
      }),
    ),
    skills: z.array(
      z.object({ id: z.string(), name: z.string(), version: z.number().int(), ref: z.string() }),
    ),
    blocks: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        kind: z.literal('guardrail'),
        status: blockStatus,
      }),
    ),
    testSets: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        cases: z.number().int(),
        service: z.string().optional(),
      }),
    ),
    outputs: z.array(playgroundOutput),
    quota: PlaygroundQuota,
  })
  .openapi('PlaygroundOptions');

const PlaygroundResult = z
  .object({
    text: z.string().optional(),
    fields: record.optional(),
    table: z.unknown().optional(),
    csv: z.string().optional(),
    noAnswer: z.literal(true).optional(),
    sources: z.array(
      z.object({
        chunkId: z.string(),
        title: z.string().optional(),
        url: z.string().optional(),
        text: z.string().optional(),
        headers: z.array(z.string()).optional(),
        document: z.string().optional(),
        position: z.number().optional(),
        version: z.union([z.string(), z.number()]).optional(),
        publishedAt: z.string().optional(),
        score: z.number().optional(),
      }),
    ),
    citations: z.array(z.object({ index: z.number().int(), chunkId: z.string() })).optional(),
    clarification: z.object({ question: z.string(), options: z.array(z.string()) }).optional(),
    byModel: z.array(
      z.object({
        model: z.string(),
        inputTokens: z.number(),
        outputTokens: z.number(),
        costNok: z.number(),
      }),
    ),
    steps: z.array(record).openapi({ description: 'Timeline steps, as in the task timeline' }),
    stats: z.object({
      iterations: z.number(),
      toolCalls: z.number(),
      chunksRead: z.number(),
      documents: z.number(),
      warnings: z.array(z.string()),
      inputTokens: z.number(),
      outputTokens: z.number(),
      cachedInputTokens: z.number().optional(),
      byModel: z.array(
        z.object({
          model: z.string(),
          inputTokens: z.number(),
          outputTokens: z.number(),
          calls: z.number(),
        }),
      ),
    }),
    searchNotes: z.array(z.object({ document: z.string(), reason: z.string() })),
    timeMs: z.number(),
    tokensIn: z.number(),
    tokensOut: z.number(),
    costNok: z.number(),
    dataLocation: residency.nullable(),
    runId: z.string(),
  })
  .openapi('PlaygroundResult');

const PlaygroundUnavailable = z
  .object({
    type: z.literal('urn:genai:problem:playground-unavailable'),
    status: z.literal(502),
    title: z.string(),
    setup: z.enum(['setup', 'compareWith']),
    code: z.string(),
    step: z.string().optional(),
    detail: z.string().optional(),
    runId: z.string().optional(),
  })
  .openapi('PlaygroundUnavailable');

const playgroundErrors = {
  400: problem('Invalid request, or the input does not fit the input fields (code invalid_input)'),
  ...signedIn,
  403: problem(
    'Needs manage-services or manage-datasets, or a block in the setup is refused by policy (with `setup` and `policy`)',
  ),
  404: problem('The tenant is not reachable for the caller'),
  409: problem('The playground is turned off for the tenant'),
  413: problem('The file is too large'),
  422: problem('Invalid setup or file'),
  429: problem('The monthly token quota is used up (with `quota`)'),
};

const DriftItem = z.object({
  kind: z.enum(definitionKinds),
  tenant: z.string(),
  id: z.string(),
  file: z.string().optional(),
  state: z.enum(['in-sync', 'drifted', 'not-published', 'missing-from-git']),
  published: z
    .object({ version: z.number().int(), by: z.string(), at: z.string(), reason: z.string() })
    .optional(),
  differences: z.array(z.string()).optional(),
});

export const serviceRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services',
    summary:
      "The tenant's services with status, channels and runs this week, archived included. Any member",
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(z.object({ data: z.array(ServiceSummary) }), 'Services'),
      ...tenantErrors,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/draft',
    summary:
      "The service's saved draft, or null when it has none. With rebase=clean a draft built on an older published version is rebased on read when that has no conflicts (audited, needs manage-services); otherwise the conflicts are returned for the person to choose. Any member",
    request: {
      params: z.object({ tenant, id: service }),
      query: z.object({
        rebase: z
          .enum(['clean'])
          .optional()
          .openapi({ description: 'Rebase a behind draft onto the latest version on read' }),
      }),
      headers: optionalReason('Utkast oppdatert med publiserte endringer'),
    },
    responses: {
      200: json(
        z.union([OpenedDraft, ServiceDraft]).nullable(),
        'The draft or null; with rebase=clean the opened draft',
      ),
      ...tenantErrors,
      409: problem('The draft was changed by someone else while it was rebased'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/services/{id}/draft',
    summary:
      'Save the service draft; send the revision you edited to guard against lost updates. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service }),
      headers: optionalReason('Utkast lagret'),
      body: body(
        z.object({
          definition: record,
          files: files.optional(),
          baseVersion: z
            .number()
            .int()
            .optional()
            .openapi({ description: 'The published version the draft started from' }),
          revision: z.number().int().optional(),
          reason: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: audited(ServiceDraft, 'Saved'),
      400: problem('Missing definition or invalid baseVersion'),
      ...tenantErrors,
      409: problem('The draft was changed by someone else'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/draft/rebase',
    summary:
      'Merge newer published changes into the draft; conflicts are listed and the draft keeps its value. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service }),
      headers: optionalReason('Utkast oppdatert med publiserte endringer'),
      body: body(
        z.object({
          revision: z.number().int().optional(),
          onlyIfClean: z
            .boolean()
            .optional()
            .openapi({ description: 'Change nothing when there are conflicts' }),
          reason: z.string().optional(),
        }),
        false,
      ),
    },
    responses: {
      200: audited(
        z.object({ draft: ServiceDraft, conflicts: z.array(DraftConflict), applied: z.boolean() }),
        'Rebased',
      ),
      400: problem('Refused'),
      ...tenantErrors,
      404: problem('No draft, or the tenant is not reachable'),
      409: problem('The draft was changed by someone else'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/services/{id}/draft',
    summary: 'Discard the service draft. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service }),
      headers: optionalReason('Utkast slettet'),
      body: body(
        z.object({ revision: z.number().int().optional(), reason: z.string().optional() }),
        false,
      ),
    },
    responses: {
      200: audited(z.object({ revision: z.number().int(), deleted: z.literal(true) }), 'Deleted'),
      400: problem('Refused'),
      ...tenantErrors,
      404: problem('No draft, or the tenant is not reachable'),
      409: problem('The draft was changed by someone else'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/test-sets',
    summary: "The service's test sets with case counts per split. Any member",
    request: { params: z.object({ tenant, id: service }) },
    responses: {
      200: json(z.object({ data: z.array(TestSetSummary) }), 'Test sets'),
      ...tenantErrors,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/eval-runs',
    summary:
      'Start an evaluation of the published service, a version, or the draft against a test set; runs in the background. Needs manage-services',
    request: {
      params: z.object({ tenant, id: service }),
      body: body(
        z.object({
          testSet: z.string(),
          version: z
            .union([z.literal('draft'), z.number().int()])
            .optional()
            .openapi({ description: 'Defaults to the latest published version' }),
          split: z.enum(['locked', 'open']).optional(),
          cases: z
            .array(z.string())
            .min(1)
            .optional()
            .openapi({ description: 'Run only these cases of the test set, by id' }),
          definition: record.optional().openapi({
            description: 'With version draft: run this definition instead of the saved draft',
          }),
          files: files.optional(),
        }),
      ),
    },
    responses: {
      202: json(z.object({ id: z.string() }), 'Started'),
      400: problem('Missing test set, invalid split, or a case the test set does not have'),
      ...tenantErrors,
      404: problem('No such test set or version'),
      409: problem('The test set has no cases'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/eval-runs',
    summary: "The service's evaluation runs without case results. Any member",
    request: { params: z.object({ tenant, id: service }) },
    responses: { 200: json(z.object({ data: z.array(EvalRunSummary) }), 'Runs'), ...tenantErrors },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/improvements',
    summary:
      'Ask the optimiser for better instructions, scored on a test set; runs in the background. Needs manage-services',
    request: {
      params: z.object({ tenant, id: service }),
      body: body(
        z.object({ testSet: z.string().optional(), language: z.string().optional() }),
        false,
      ),
    },
    responses: {
      202: json(z.object({ id: z.string() }), 'Started'),
      400: problem('Invalid request'),
      ...tenantErrors,
      404: problem('No published service or test set'),
      409: problem('Cannot start now'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/improvements',
    summary: 'Improvement proposals for the service. Any member',
    request: { params: z.object({ tenant, id: service }) },
    responses: {
      200: json(z.object({ data: z.array(Improvement) }), 'Proposals'),
      ...tenantErrors,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/improvements/{pid}/decision',
    summary:
      'Approve (writes the new instructions into the draft) or reject an improvement. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service, pid }),
      headers: optionalReason('Forbedringsforslag godkjent / avvist'),
      body: body(z.object({ approve: z.boolean(), reason: z.string().optional() })),
    },
    responses: {
      200: audited(Improvement, 'Decided'),
      400: problem('approve is not true or false'),
      ...tenantErrors,
      404: problem('No such improvement for this service'),
      409: problem('Already decided, or the draft instructions changed since'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/lifecycle',
    summary: 'Whether the service is active, paused or archived. Needs use-services',
    request: { params: z.object({ tenant, id: service }) },
    responses: { 200: json(Lifecycle, 'State'), ...tenantErrors, 404: problem('No such service') },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/services/{id}/lifecycle',
    summary:
      'Pause, archive or reactivate the service; paused and archived services refuse runs. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service }),
      headers: changeReason,
      body: body(z.object({ state: z.enum(['active', 'paused', 'archived']) })),
    },
    responses: {
      200: audited(Lifecycle, 'State'),
      400: problem('Missing reason or invalid state'),
      ...tenantErrors,
      404: problem('No such service'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/risk-confirmations',
    summary: 'Who confirmed the risk class of the service, oldest first. Any member',
    request: { params: z.object({ tenant, id: service }) },
    responses: {
      200: json(z.object({ data: z.array(RiskConfirmation) }), 'Confirmations'),
      ...signedIn,
      404: problem('The tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/risk-confirmations',
    summary:
      'Confirm the risk class; a high-risk service needs two different people before it can be published. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service }),
      headers: changeReason,
      body: body(
        z.object({
          riskClass: z.enum(['limited', 'high']),
          reasons: z.array(z.string()).optional(),
        }),
      ),
    },
    responses: {
      201: audited(RiskConfirmation, 'Confirmed'),
      400: problem('riskClass is not limited or high'),
      ...signedIn,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/batch-runs/sources',
    summary:
      'Datasets the service may run over, with the select filters and their values; the ones the service uses come first. Any member',
    request: { params: z.object({ tenant, id: service }) },
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              usedByService: z.boolean(),
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
      ...tenantErrors,
      404: problem('No published service'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/batch-runs/estimate',
    summary:
      'Estimate tokens and cost of running the service over matching documents; a sample run measures it unless sample is false. Needs manage-services',
    request: {
      params: z.object({ tenant, id: service }),
      headers: optionalReason('Beregnet kostnad for kjøring over dokumenter'),
      body: body(
        z.object({
          dataset: z.string(),
          filters: z.record(z.string(), filterValue).optional(),
          documents: z.array(z.string()).optional(),
          prompt: z.string().optional(),
          input: z.record(z.string(), inputValue).optional(),
          sample: z.boolean().optional(),
          reason: z.string().optional(),
        }),
      ),
    },
    responses: {
      201: json(BatchEstimate, 'Estimate; start a run with its id before it expires'),
      400: problem('Missing dataset or invalid filters, documents or input'),
      ...tenantErrors,
      404: problem('No published service or dataset'),
      409: problem('Cannot estimate now'),
      422: problem('Invalid filters for the dataset'),
      503: problem('The search engine is unavailable'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/batch-runs',
    summary:
      'Start a run over the documents of an estimate; above the approval limit it needs an approval. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service }),
      headers: changeReason,
      body: body(
        z.object({
          estimate: z.string(),
          maxCostNok: z.number().positive().optional(),
          maxTokens: z.number().positive().optional(),
          concurrency: z.number().positive().optional(),
          approval: z.string().optional(),
        }),
      ),
    },
    responses: {
      202: json(BatchRun, 'Started'),
      400: problem('Missing estimate or reason'),
      ...tenantErrors,
      404: problem('No such estimate'),
      409: problem('The estimate expired, the service changed, or approval is needed'),
      422: problem('Invalid limits'),
      503: problem('The search engine is unavailable'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/batch-runs',
    summary: 'Runs over documents for the service, with totals. Any member',
    request: { params: z.object({ tenant, id: service }) },
    responses: { 200: json(z.object({ data: z.array(BatchRun) }), 'Runs'), ...tenantErrors },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/batch-runs/{runId}',
    summary: 'One run with every item. Any member',
    request: { params: z.object({ tenant, id: service, runId }) },
    responses: {
      200: json(BatchRun.extend({ items: z.array(BatchItem) }), 'Run'),
      ...tenantErrors,
      404: problem('No such run'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{id}/batch-runs/{runId}/export',
    summary: 'Download the results as JSON or as semicolon-separated CSV with a BOM. Any member',
    request: {
      params: z.object({ tenant, id: service, runId }),
      query: z.object({ format: z.enum(['json', 'csv']).optional() }),
    },
    responses: {
      200: {
        description: 'The results as an attachment',
        content: {
          'application/json': { schema: BatchExport },
          'text/csv': { schema: z.string() },
        },
      },
      ...tenantErrors,
      404: problem('No such run'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/batch-runs/{runId}/cancel',
    summary: 'Stop a run; items already started finish. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service, runId }),
      headers: changeReason,
      body: body(z.object({}), false),
    },
    responses: {
      202: json(z.object({ id: z.string(), cancelling: z.literal(true) }), 'Cancelling'),
      400: problem('Missing reason'),
      ...tenantErrors,
      404: problem('No such run'),
      409: problem('The run has ended'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{id}/batch-runs/{runId}/retry',
    summary: 'Run failed items again, or the listed item indexes. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: service, runId }),
      headers: changeReason,
      body: body(
        z.object({
          maxCostNok: z.number().positive().optional(),
          maxTokens: z.number().positive().optional(),
          items: z.array(z.number().int()).optional(),
        }),
        false,
      ),
    },
    responses: {
      202: json(BatchRun.extend({ retried: z.number().int() }), 'Retrying'),
      400: problem('Invalid request or missing reason'),
      ...tenantErrors,
      404: problem('No such run'),
      409: problem('The run is still going or nothing to retry'),
    },
  }),
  assistantTurnRoute('/tenants/{tenant}/services/{id}/assistant/turns', 'service', serviceIntents),
  assistantTurnRoute('/tenants/{tenant}/skills/{id}/assistant/turns', 'skill', [
    'chat',
    ...skillIntents,
  ]),
  assistantTurnRoute('/tenants/{tenant}/step-flows/{id}/assistant/turns', 'step flow', ['chat']),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/definitions/template',
    summary:
      'A valid starting Service definition with a model the tenant may use. Needs manage-services',
    request: {
      params: z.object({ tenant }),
      query: z.object({ kind: z.literal('Service').optional() }),
    },
    responses: {
      200: json(z.object({ definition: record }), 'Template'),
      400: problem('No template for this kind'),
      ...signedIn,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
      409: problem('No enabled model the tenant may use'),
      500: problem('The template is not valid'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/definitions/strategies',
    summary:
      'The ways of working a service can use: way, default, texts in bokmål and English, steps, starting config and schema. Any member',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(z.object({ data: z.array(StrategyCatalogueEntry) }), 'Strategies'),
      ...tenantErrors,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/definitions/complete',
    summary:
      'Fill in what the platform derives for a Service definition: residency from the model, form field ids from labels, the starting strategy config, human approval for high risk, no required sources for a fields output, only the output parts of its kind, and a result field description from its name. Nothing is saved. Needs manage-services',
    request: { params: z.object({ tenant }), body: body(z.object({ definition: record })) },
    responses: {
      200: json(
        z.object({
          definition: record,
          applied: z.array(
            z.object({
              path: z.string(),
              rule: z.enum([
                'residency-from-model',
                'field-id-from-label',
                'strategy-starting-config',
                'human-approval-for-high-risk',
                'no-required-sources-for-fields',
                'output-for-kind',
                'field-description-from-name',
              ]),
            }),
          ),
        }),
        'The completed definition and the rules that changed it',
      ),
      400: problem('Missing definition, or not a Service'),
      ...tenantErrors,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/definitions/input-fields',
    summary:
      'The input form a definition would show, with options filled in. Needs manage-services',
    request: { params: z.object({ tenant }), body: body(z.object({ definition: z.unknown() })) },
    responses: {
      200: json(z.object({ fields: z.array(InputField) }), 'Fields'),
      400: problem('Missing definition'),
      ...tenantErrors,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/definitions/test-run',
    summary:
      'Run an unpublished definition once with a question or form input. The definition is completed as by /definitions/complete first; nothing is saved. Needs manage-services; the run is a task',
    request: {
      params: z.object({ tenant }),
      body: body(
        z.object({
          definition: z.unknown(),
          files: files.optional(),
          query: z.string().optional(),
          input: record.optional(),
        }),
      ),
    },
    responses: {
      200: {
        ...json(
          z.object({
            ok: z.literal(true),
            task: z.string(),
            answer: z.string(),
            parts: z.array(part),
          }),
          'Answer',
        ),
        headers: taskHeader,
      },
      400: problem('Missing definition or query, or input that does not fit (code invalid_input)'),
      ...tenantErrors,
      422: problem('Invalid definition'),
      502: problem('The run failed; `code`, `step` and `runId` say where'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/step-flows/blocks',
    summary:
      'Built-in step-flow blocks with their names in bokmål and English and JSON Schemas for input, params (with x-label) and output. Any member',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(
        z.object({
          blocks: z.array(
            z.object({
              ref: z.string(),
              name: z.string(),
              version: z.string(),
              description: z.string(),
              title: UiText,
              summary: UiText,
              input: record,
              params: record,
              output: record,
            }),
          ),
        }),
        'Blocks',
      ),
      ...signedIn,
      404: problem('The tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/step-flows/recipes',
    summary:
      "The tenant's own recipes, then the recipes Digdir shares, with plain settings as JSON Schema with x- metadata. Any member",
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(
        z.object({
          recipes: z.array(
            z.object({
              ref: z.string(),
              id: z.string(),
              version: z.number(),
              name: z.string().optional(),
              title: z.object({ nb: z.string(), en: z.string() }),
              summary: z.object({ nb: z.string(), en: z.string() }),
              origin: z.enum(['own', 'shared']),
              shared: z.boolean().optional(),
              purpose: z.string(),
              settings: record,
              steps: z.array(record),
            }),
          ),
        }),
        'Recipes',
      ),
      ...signedIn,
      404: problem('Not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/playground/options',
    summary:
      'What the playground can combine: services and versions, models, datasets, skills, guardrails, test sets and quota. Needs manage-services or manage-datasets',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(PlaygroundOptions, 'Options'),
      ...signedIn,
      403: problem('Needs manage-services or manage-datasets'),
      404: problem('The tenant is not reachable for the caller'),
      409: problem('The playground is turned off for the tenant'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/playground/runs',
    summary:
      'Run a setup, and optionally a second one to compare, on a text, file or form input; counts towards the monthly quota. Needs manage-services or manage-datasets; each run is a task',
    request: { params: z.object({ tenant }), body: body(runSchema) },
    responses: {
      200: json(
        PlaygroundResult.extend({ compare: PlaygroundResult.optional(), quota: PlaygroundQuota }),
        'Result',
      ),
      ...playgroundErrors,
      502: {
        content: { 'application/problem+json': { schema: PlaygroundUnavailable } },
        description: 'The model or a step failed; not counted',
      },
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/playground/runs/stream',
    summary:
      'As /playground/runs, streamed as server-sent events: started, step, remove, delta, retract, status, stats, result or failed per setup, then done with the quota',
    request: { params: z.object({ tenant }), body: body(runSchema) },
    responses: { 200: sse('Event stream'), ...playgroundErrors },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/proposals',
    summary:
      'Catalogue proposals the builder assistant stored for the tenant, newest first. Needs use-services',
    request: {
      params: z.object({ tenant }),
      query: z.object({
        level: z.enum(['2', '3', '4']).optional(),
        state: z.enum(['pending', 'sent_for_approval', 'approved', 'rejected']).optional(),
      }),
    },
    responses: {
      200: json(z.object({ data: z.array(CatalogProposal) }), 'Proposals'),
      ...signedIn,
      403: problem('Missing right'),
      404: problem('No such tenant for you'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/proposals/{pid}',
    summary: 'One catalogue proposal. Needs use-services',
    request: { params: z.object({ tenant, pid }) },
    responses: {
      200: json(CatalogProposal, 'Proposal'),
      ...signedIn,
      403: problem('Missing right'),
      404: problem('No such tenant for you, or no such proposal'),
    },
  }),
  proposalDecisionRoute(
    'approve',
    'Approve a proposal: level 2 connects the database, level 3 registers the building block. Needs manage-services plus the rights the level asks for; audited',
  ),
  proposalDecisionRoute('reject', 'Reject a proposal. Needs manage-services; audited'),
  proposalDecisionRoute(
    'send-for-approval',
    'Send a pending proposal to someone with the right to approve it. Needs use-services; audited',
  ),
  createRoute({
    method: 'get',
    path: '/operator/proposals',
    summary: 'Proposals from every tenant, with tenant names and queue status. Operators only',
    request: {
      query: z.object({
        level: z.enum(['2', '3', '4']).optional(),
        status: z
          .string()
          .optional()
          .openapi({ description: 'pending, approved or rejected, or a platform change status' }),
      }),
    },
    responses: {
      200: json(z.object({ data: z.array(OperatorProposal) }), 'Proposals'),
      ...operatorErrors,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/proposals/{pid}/decision',
    summary: 'Plan or reject a platform change (level 4). Operators only; audited in the tenant',
    request: {
      params: z.object({ pid }),
      headers: changeReason,
      body: body(
        z.object({
          approve: z.boolean(),
          caseId: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: audited(ProposalDecision, 'Decided'),
      400: problem('approve missing or short reason'),
      ...operatorErrors,
      404: problem('No such platform change'),
      409: problem('Already planned or rejected'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/proposals/{pid}/status',
    summary:
      'Move a platform change to under_review, planned or rejected. Operators only; audited in the tenant',
    request: {
      params: z.object({ pid }),
      headers: changeReason,
      body: body(z.object({ status: z.enum(['under_review', 'planned', 'rejected']) })),
    },
    responses: {
      200: audited(ProposalDecision, 'Moved'),
      400: problem('Invalid status or short reason'),
      ...operatorErrors,
      404: problem('No such platform change'),
      409: problem('Already planned or rejected'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/skills',
    summary: "The tenant's own skills and skills shared by other tenants. Any member",
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(z.object({ data: z.array(SkillSummary) }), 'Skills'),
      ...signedIn,
      404: problem('The tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills',
    summary: 'Create a skill as a draft. Needs manage-services; audited',
    request: {
      params: z.object({ tenant }),
      headers: changeReason,
      body: body(
        z.object({
          id: z.string().optional().openapi({ description: 'Or metadata.id in the definition' }),
          name: z.string().optional(),
          definition: record.optional(),
          reason: z.string().optional(),
        }),
      ),
    },
    responses: {
      201: audited(SkillDetail, 'Created'),
      ...signedIn,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right, or a read-only support session'),
      409: problem('The id is taken'),
      422: problem('Invalid id'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills/import',
    summary: 'Import a skill package (zip) as a new draft. Needs manage-services; audited',
    request: {
      params: z.object({ tenant }),
      headers: changeReason,
      body: fileUpload,
    },
    responses: {
      201: audited(SkillDetail, 'Imported'),
      400: problem('No file'),
      ...signedIn,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right, or a read-only support session'),
      409: problem('The id is taken'),
      422: problem('Invalid package'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/skills/{id}',
    summary:
      'A skill with its draft, versions, last test run, publish requirements and sharing. Any member',
    request: { params: z.object({ tenant, id: skill }), query: ownerQuery },
    responses: {
      200: json(SkillDetail, 'Skill'),
      ...signedIn,
      404: problem('No such skill visible to the tenant'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/skills/{id}',
    summary: 'Save the skill draft. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: skill }),
      headers: changeReason.merge(ifMatchHeader),
      body: body(z.object({ definition: record, reason: z.string().optional() })),
    },
    responses: {
      200: audited(SkillDetail, 'Saved'),
      400: problem('Missing definition'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem('No such own skill, or the tenant is not reachable for the caller'),
      409: problem('The draft was changed by someone else'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/skills/{id}/versions',
    summary: 'Published versions of a skill with their test scores. Any member',
    request: { params: z.object({ tenant, id: skill }), query: ownerQuery },
    responses: {
      200: json(z.object({ data: z.array(SkillVersion) }), 'Versions'),
      ...signedIn,
      404: problem('No such skill visible to the tenant'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/skills/{id}/usage',
    summary:
      'Services that use the skill; for a shared skill only the caller tenant services. Any member',
    request: { params: z.object({ tenant, id: skill }), query: ownerQuery },
    responses: {
      200: json(
        z.object({
          latestVersion: z.number().int().nullable(),
          usedBy: z.array(
            z.object({
              tenant: z.string(),
              service: z.string(),
              name: z.string(),
              version: z.number().int(),
              updateAvailable: z.boolean(),
            }),
          ),
        }),
        'Usage',
      ),
      ...signedIn,
      404: problem('No such skill visible to the tenant'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/skills/{id}/test-runs',
    summary: 'Test runs of the skill draft, newest first. Any member',
    request: { params: z.object({ tenant, id: skill }) },
    responses: {
      200: json(z.object({ data: z.array(SkillTestRun) }), 'Runs'),
      ...signedIn,
      404: problem('No such own skill, or the tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills/{id}/test-runs',
    summary: 'Run the test set of the skill draft and judge the answers. Needs manage-services',
    request: {
      params: z.object({ tenant, id: skill }),
      body: body(z.object({ model: z.string().optional(), judge: z.string().optional() }), false),
    },
    responses: {
      200: json(SkillTestRun, 'Run'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem('No such own skill or draft, or the tenant is not reachable for the caller'),
      422: problem('The test set cannot run'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/skills/{id}/testcases/{index}',
    summary: 'Remove a test case from the skill draft by index. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: skill, index: pathParam('index', '0') }),
      headers: changeReason.merge(ifMatchHeader),
    },
    responses: {
      200: audited(SkillDetail, 'Removed'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem(
        'No such skill, draft or test case, or the tenant is not reachable for the caller',
      ),
      409: problem('The draft was changed by someone else'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills/{id}/fix',
    summary:
      'Ask the optimiser to rewrite the instructions from the failed cases of the last test run. Needs manage-services; audited',
    request: { params: z.object({ tenant, id: skill }) },
    responses: {
      201: audited(SkillFix, 'Proposed fix'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem('No such skill or draft, or the tenant is not reachable for the caller'),
      409: problem('No failed cases, the optimiser is not published, or no model is available'),
      422: problem('The assistant did not answer or proposed no change'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills/{id}/fix/{fixId}/apply',
    summary: 'Write a proposed fix into the skill draft. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: skill, fixId: pathParam('fixId') }),
      headers: changeReason,
    },
    responses: {
      200: audited(SkillDetail, 'Applied'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem('No such skill, draft or fix, or the tenant is not reachable for the caller'),
      409: problem('The draft changed since the fix was proposed'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/skills/{id}/requirements',
    summary: 'What must hold before the skill draft can be published. Any member',
    request: { params: z.object({ tenant, id: skill }) },
    responses: {
      200: json(
        z.object({ threshold: z.number(), requirements: z.array(SkillRequirement) }),
        'Requirements',
      ),
      ...signedIn,
      404: problem('No such own skill, or the tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills/{id}/publish',
    summary:
      'Publish the skill draft as the next version when every requirement is met. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: skill }),
      headers: changeReason,
      body: body(reasonBody, false),
    },
    responses: {
      200: audited(
        z.object({
          ok: z.literal(true),
          version: z.number().int(),
          publishedAt: z.string(),
          task: z.string(),
          requirements: z.array(SkillRequirement),
        }),
        'Published',
      ),
      400: problem('Missing or short reason'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem('No such skill or draft, or the tenant is not reachable for the caller'),
      409: problem('No changes to publish'),
      422: {
        description:
          'A problem: unmet requirements (with `ok: false` and `requirements`), or the definition is refused (with `errors`)',
        content: {
          'application/problem+json': {
            schema: z.object({
              type: z.string(),
              title: z.string(),
              status: z.number().int(),
              ok: z.literal(false).optional(),
              requirements: z.array(SkillRequirement).optional(),
              errors: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
            }),
          },
        },
      },
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills/{id}/share',
    summary:
      'Ask Digdir to share the latest published version with every tenant; confirm it holds no personal data. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: skill }),
      headers: changeReason,
      body: body(reasonBody.extend({ confirm: z.literal(true) })),
    },
    responses: {
      202: audited(SkillShare, 'Requested'),
      400: problem('Missing or short reason'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem('No such own skill, or the tenant is not reachable for the caller'),
      409: problem('Already pending or shared'),
      422: problem('Not confirmed, or no published version'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/skills/{id}/share',
    summary: 'Withdraw a share request or stop sharing. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: skill }),
      headers: changeReason,
    },
    responses: {
      200: audited(SkillShare, 'Withdrawn'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem(
        'No such skill or nothing shared, or the tenant is not reachable for the caller',
      ),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills/{id}/copy',
    summary:
      'Copy a published version of an own or shared skill into a new draft, attachments included. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: skill }),
      headers: changeReason,
      body: body(
        z.object({
          owner: z.string().optional(),
          version: z.number().int().optional(),
          id: z
            .string()
            .optional()
            .openapi({ description: 'The new id; defaults to the source id' }),
          reason: z.string().optional(),
        }),
        false,
      ),
    },
    responses: {
      201: audited(SkillDetail, 'Copied'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem('No such skill or version, or the tenant is not reachable for the caller'),
      409: problem('The id is taken'),
      422: problem('Invalid id'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/skills/{id}/export',
    summary:
      'Download the skill as a zip package: the draft for own skills, otherwise the latest or given version. Any member',
    request: {
      params: z.object({ tenant, id: skill }),
      query: ownerQuery.extend({ version: z.string().optional() }),
    },
    responses: {
      200: {
        description: 'The package; with Accept: application/json as base64',
        content: {
          'application/zip': { schema: z.string().openapi({ format: 'binary' }) },
          'application/json': {
            schema: z.object({ fileName: z.string(), contentBase64: z.string() }),
          },
        },
      },
      ...signedIn,
      404: problem('No such skill visible to the tenant'),
      422: problem('The skill is not complete'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/skills/{id}/attachments',
    summary:
      'Upload an attachment for the skill; add it to the draft yourself. Needs manage-services; audited',
    request: {
      params: z.object({ tenant, id: skill }),
      headers: changeReason,
      body: fileUpload,
    },
    responses: {
      201: audited(
        z.object({ name: z.string(), blob: z.string(), size: z.number().int() }),
        'Stored',
      ),
      400: problem('No file'),
      ...signedIn,
      403: problem('Missing right, or a read-only support session'),
      404: problem('No such own skill, or the tenant is not reachable for the caller'),
      422: problem('No name, too large, or refused by the store'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/skill-tools',
    summary:
      'Tools a skill may name, from the tenant and platform tool connections, with versions. Any member',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({ id: z.string(), name: z.string(), versions: z.array(z.string()) }),
          ),
        }),
        'Tools',
      ),
      ...signedIn,
      404: problem('The tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/skills/shares',
    summary: 'Skill share requests from every tenant, with the content to review. Operators only',
    request: { query: z.object({ state: shareState.optional() }) },
    responses: {
      200: json(
        z.object({
          data: z.array(
            SkillShare.extend({
              byName: z.string().optional(),
              tenantName: z.string(),
              skillName: z.string(),
              detail: z.object({
                description: z.string(),
                instructions: z.string(),
                tools: z.array(z.string()),
                test: z.object({
                  score: z.number().nullable(),
                  passed: z.number().int().optional(),
                  total: z.number().int().optional(),
                  threshold: z.number(),
                }),
                previous: z
                  .object({ version: z.number().int(), instructions: z.string() })
                  .optional(),
              }),
            }),
          ),
        }),
        'Requests',
      ),
      ...operatorErrors,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/skills/shares/{id}/decision',
    summary: 'Approve or reject a skill share request. Operators only; audited',
    request: {
      params: z.object({ id: pathParam('id', '991825827-klart-sprak') }),
      headers: changeReason,
      body: body(reasonBody.extend({ approve: z.boolean() })),
    },
    responses: {
      200: audited(SkillShare, 'Decided'),
      400: problem('approve missing or short reason'),
      ...operatorErrors,
      404: problem('No pending request'),
      409: problem('Refused'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/step-flows/recipes/{id}/versions/{version}',
    summary:
      'One version of a recipe the tenant owns or that is or was shared with it, for a variant pinned to that version. Any member',
    request: {
      params: z.object({ tenant, id: pathParam('id'), version: pathParam('version', '1') }),
    },
    responses: {
      200: json(
        z.object({
          recipe: z.object({
            ref: z.string(),
            id: z.string(),
            version: z.number(),
            origin: z.enum(['own', 'shared']),
            title: record,
            summary: record,
            purpose: z.string(),
            settings: record,
            steps: z.array(record),
          }),
        }),
        'Recipe',
      ),
      ...signedIn,
      404: problem('No such recipe version for this tenant'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/recipes/shares',
    summary: "Digdir's recipes and whether each is shared with every organisation. Operators only",
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({ flow: z.string(), version: z.number(), title: record, shared: z.boolean() }),
          ),
        }),
        'Recipes',
      ),
      ...operatorErrors,
    },
  }),
  ...(['put', 'delete'] as const).map((method) =>
    createRoute({
      method,
      path: '/operator/recipes/shares/{flow}',
      summary:
        method === 'put'
          ? "Share one of Digdir's recipes with every organisation. Operators only; audited"
          : 'Stop sharing a recipe; services already published keep their pinned version. Operators only; audited',
      request: {
        params: z.object({ flow: pathParam('flow', 'ordered-sources-answer') }),
        headers: changeReason,
      },
      responses: {
        200: audited(z.object({ flow: z.string(), shared: z.boolean() }), 'Changed'),
        400: problem('Missing or short change reason'),
        ...operatorErrors,
        404: problem('No published recipe with this id'),
      },
    }),
  ),
  createRoute({
    method: 'get',
    path: '/shared-services',
    summary: 'Services shared with every tenant, with their public names. Any signed-in caller',
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              tenant: z.string(),
              id: z.string(),
              name: z.string(),
              purpose: z.string(),
              version: z.number().int().nullable(),
              riskClass: z.string().nullable(),
              residency: z.string().nullable(),
              model: z.string().nullable(),
              exposure: z.array(z.string()),
              variants: z.array(
                z.object({ id: z.string(), publicName: z.string(), aliases: z.array(z.string()) }),
              ),
            }),
          ),
        }),
        'Shared services',
      ),
      ...signedIn,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/shared-services',
    summary: 'Every non-archived service with who it is shared with. Operators only',
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              tenant: z.string(),
              id: z.string(),
              name: z.string(),
              version: z.number().int(),
              availableTo: z.union([z.literal('*'), z.array(z.string())]).nullable(),
              publicNames: z.array(z.string()),
            }),
          ),
        }),
        'Services',
      ),
      ...operatorErrors,
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/shared-services/{tenant}/{id}',
    summary:
      'Share a service with every tenant ("*"), listed org numbers, or nobody (null); publishes a new version. Operators only; audited',
    request: {
      params: z.object({ tenant, id: service }),
      headers: changeReason,
      body: body(
        z.object({
          availableTo: z
            .union([z.literal('*'), z.array(z.string().regex(/^\d{9}$/)).min(1)])
            .nullable(),
        }),
      ),
    },
    responses: {
      200: audited(
        z.object({
          version: z.number().int(),
          availableTo: z.union([z.literal('*'), z.array(z.string())]).nullable(),
        }),
        'Shared',
      ),
      400: problem('Missing reason or invalid availableTo'),
      ...operatorErrors,
      404: problem('No such service'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/definitions/quarantine',
    summary: 'Stored definitions the runtime refused to load, with the errors. Operators only',
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              kind: z.enum(definitionKinds),
              tenant: z.string(),
              id: z.string(),
              version: z.number().int(),
              errors: z.array(fieldError),
              at: z.string(),
            }),
          ),
        }),
        'Quarantined definitions',
      ),
      ...operatorErrors,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/definitions/drift',
    summary: 'Compare the definitions in git with what is published. Operators only',
    responses: {
      200: json(
        z.object({
          checkedAt: z.string(),
          summary: z.record(
            z.enum(['in-sync', 'drifted', 'not-published', 'missing-from-git']),
            z.number().int(),
          ),
          items: z.array(DriftItem),
          unreadable: z.array(z.object({ file: z.string(), error: z.string() })),
        }),
        'Drift report',
      ),
      ...operatorErrors,
    },
  }),
];

type DocumentedApp = { openAPIRegistry?: { registerPath(route: RouteConfig): void } };

export const documentServiceRoutes = (app: unknown) => {
  const registry = (app as DocumentedApp).openAPIRegistry;
  if (!registry) return;
  for (const route of serviceRoutes) registry.registerPath(route);
};

export const servicesOpenApiModule: PlatformModuleFactory = () => ({
  id: 'services-openapi',
  mount: (app) => documentServiceRoutes(app),
});
