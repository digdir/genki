import { createRoute, z, type RouteConfig } from '@hono/zod-openapi';
import { writtenStandards } from '@genai/guardrails';
import { locales } from '@genai/i18n';
import { clientChannels, clientDefinition } from '@genai/identity';
import { rowMapping } from '@genai/ingest';
import { dataLocations, pluginKinds, pluginManifest } from '@genai/plugins';
import { connectionInput } from '@genai/providers-mcp-client';
import { blockKinds, blockStatuses, registrationTypes } from '../building-blocks.js';
import { changeReason, Problem, problemContent } from '../http.js';
import { rights } from '../rights.js';

const json = <T extends z.ZodType>(schema: T, description: string) => ({
  description,
  content: { 'application/json': { schema } },
});
const problem = (description: string) => ({ description, content: problemContent });
const body = <T extends z.ZodType>(schema: T, required = true) => ({
  required,
  content: { 'application/json': { schema } },
});

const pathParam = (name: string, example: string) =>
  z.string().openapi({ param: { name, in: 'path' }, example });
const queryParam = (name: string, description: string) =>
  z
    .string()
    .optional()
    .openapi({ param: { name, in: 'query' }, description });

const tenant = pathParam('tenant', '991825827');
const reason = z.object({
  'change-reason': z
    .string()
    .min(10)
    .openapi({
      param: { name: 'change-reason', in: 'header' },
      description: 'Why the change is made, at least 10 characters. Stored in the audit log.',
      example: 'Saksbehandlingssystemet skal kalle veilederen',
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
const supportSession = z.object({
  'support-session': z
    .string()
    .optional()
    .openapi({
      param: { name: 'support-session', in: 'header' },
      description: 'Operators act for the tenant only inside an open support session.',
    }),
});

const unauthorized = problem('Not signed in');
const notMember = problem('Not a member of this tenant, or no such resource');
const forbidden = problem('Missing right, or not allowed for this tenant');
const invalid = problem('Invalid body, or the change-reason header is missing or too short');
const operatorOnly = problem('Only operators');

const Right = z.enum(rights).openapi('PlatformRight');

const ApiKey = z
  .object({
    id: z.string(),
    name: z.string(),
    service: z.string().nullable().describe('Set when the key is bound to one service.'),
    client: z.string().nullable(),
    lastUsedAt: z.string().nullable(),
    policy: z.string().nullable().describe('Id of the key policy attached to the key.'),
    rotatedFrom: z.string().nullable(),
    prefix: z.string().nullable().describe('First seven characters of the key.'),
    lastFour: z.string().nullable(),
    scopes: z.array(z.enum(['query', 'ingest', 'admin'])),
    datasets: z.array(z.string()),
    agents: z.array(z.string()),
    callsPerMinute: z.number().int(),
    allowedOverrides: z.array(z.string()),
    createdAt: z.string().nullable(),
    expiresAt: z.string().nullable(),
    revokedAt: z.string().nullable(),
  })
  .openapi('TenantApiKey');

const NewApiKey = z
  .object({
    key: z.string().describe('The key itself. It is shown only in this answer.'),
    apiKey: ApiKey,
  })
  .openapi('NewTenantApiKey');

const overrides = z
  .array(z.string())
  .optional()
  .describe(
    'Setting keys a caller may override per call, for example `search.topK` or `search.*`.',
  );

const ServiceRequirement = z.object({
  resource: z.string(),
  action: z.string(),
  scope: z.string().optional(),
});

const KeyPolicyInput = z
  .object({
    name: z.string().min(1).max(100),
    scopes: z
      .array(z.enum(['query', 'ingest', 'admin']))
      .max(200)
      .optional(),
    datasets: z.array(z.string()).max(200).optional(),
    agents: z.array(z.string()).max(200).optional(),
    modes: z.array(z.string()).max(200).optional(),
    allowedConfigKeys: z
      .array(z.string())
      .max(200)
      .optional()
      .describe('Keys of the form `platform:<key>`, `runtime:<key>` or `dataset:<key>`.'),
  })
  .openapi('KeyPolicyInput');

const KeyPolicy = z
  .object({
    id: z.string(),
    name: z.string(),
    scopes: z.array(z.enum(['query', 'ingest', 'admin'])),
    datasets: z.array(z.string()),
    agents: z.array(z.string()),
    modes: z.array(z.string()),
    allowedConfigKeys: z.array(z.string()),
    keyIds: z.array(z.string()),
    createdAt: z.string(),
  })
  .openapi('KeyPolicy');

const WebhookDelivery = z
  .object({
    id: z.string(),
    tenant: z.string(),
    client: z.string(),
    event: z.enum(['task.completed', 'feedback.received', 'ping']),
    at: z.string(),
    ok: z.boolean(),
    status: z.number().int().optional(),
    error: z.string().optional(),
  })
  .openapi('WebhookDelivery');

const Client = z
  .object({
    definition: clientDefinition,
    version: z.number().int(),
    updatedAt: z.string(),
    updatedBy: z.string(),
    deliveries: z.array(WebhookDelivery).describe('The latest webhook deliveries, newest first.'),
  })
  .openapi('FrontendClient');

const ClientInput = z
  .object({
    apiVersion: z.literal('genai/v1').optional(),
    kind: z.literal('Client').optional(),
    metadata: z.object({ name: z.string().min(1).optional() }).optional(),
    spec: clientDefinition.shape.spec,
  })
  .openapi('FrontendClientInput');

const MaskinportenClient = z
  .object({
    clientId: z.string(),
    name: z.string(),
    services: z.array(z.string()).describe('Service ids, or `["*"]` for every service.'),
    tenant: z.string(),
    createdBy: z.string(),
    createdAt: z.string(),
  })
  .openapi('MaskinportenClient');

const Preferences = z
  .object({
    writtenStandard: z.enum(writtenStandards).nullable(),
    language: z.enum(locales).nullable(),
    version: z.number().int().optional(),
    at: z.string().optional(),
  })
  .openapi('UserPreferences');

const ToolConnectionInput = connectionInput.omit({ tenant: true }).openapi('ToolConnectionInput', {
  description: 'The tenant comes from the path. `auth.secret` is a `secret://` reference.',
});

const PinnedToolSummary = z.object({ name: z.string(), description: z.string() });

const Integration = z
  .object({
    id: z.string(),
    name: z.string(),
    endpoint: z.string(),
    version: z.string(),
    allow: z.array(z.object({ host: z.string(), port: z.number().int().optional() })),
    auth: z
      .object({ kind: z.string(), secret: z.string().describe('The secret name, not its value.') })
      .nullable(),
    tools: z.array(PinnedToolSummary),
    pending: z.array(PinnedToolSummary),
  })
  .openapi('Integration');

const AllowedHosts = z
  .array(z.string().openapi({ example: 'https://api.example.no' }))
  .min(1)
  .max(20)
  .describe(
    'The origins (scheme, host and port) the secret may be sent to. A host without a scheme means https.',
  );
const SecretValue = z
  .object({
    value: z.string().min(1).describe('The secret. It is stored and never shown again.'),
    allowedHosts: AllowedHosts.optional().describe(
      'The origins the secret may be sent to. Required for a new secret; left out, an existing secret keeps its hosts. Other hosts than the stored ones need manage-services.',
    ),
  })
  .openapi('SecretValue');
const SecretHosts = z.object({ allowedHosts: AllowedHosts }).openapi('SecretHosts');
const SecretRef = z.object({
  ref: z.string().openapi({ example: 'secret://tenant/991825827/lovdata' }),
});

const Network = z.enum(['public', 'private', 'blocked', 'unknown']);

const Connector = z
  .object({
    id: z.string(),
    name: z.string(),
    service: z.string(),
    proposal: z.string(),
    approvedBy: z.string(),
    approvedAt: z.string(),
    status: z.enum(['not_connected', 'not_synced', 'syncing', 'connected', 'failed']),
    dataset: z.string().optional(),
    connection: z
      .object({
        engine: z.literal('postgres'),
        host: z.string(),
        port: z.number().int(),
        database: z.string(),
        user: z.string(),
        tls: z.boolean(),
        credentials: z.literal('stored'),
        network: Network.optional(),
        networkAllowed: z.boolean().optional(),
      })
      .optional(),
    source: rowMapping.optional(),
    lastSync: z
      .object({
        status: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
        startedAt: z.string(),
        endedAt: z.string().optional(),
        rows: z.number().int().optional(),
        skipped: z.number().int().optional(),
        error: z.string().optional(),
      })
      .nullable(),
  })
  .openapi('Connector');

const PrivateNetworks = z
  .object({
    tenant: z.string(),
    entries: z.array(z.string()).describe('Host names or CIDR ranges.'),
    changedBy: z.string().optional(),
    changedAt: z.string().optional(),
    reason: z.string().optional(),
  })
  .openapi('PrivateNetworks');

const BlockKind = z.enum(blockKinds);
const DataLocation = z.enum(dataLocations);
const BlockPermission = z.object({
  type: z.enum(['network', 'secret', 'data', 'model']),
  value: z.string(),
  note: z.string(),
});
const BlockUser = z.object({ id: z.string(), name: z.string(), version: z.number().optional() });
const SettingSchema = z.object({
  type: z.enum(['boolean', 'integer', 'number', 'string']),
  title: z.string(),
  description: z.string().optional(),
  default: z.unknown(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  enum: z.array(z.string()).optional(),
  'x-unit': z.string().optional(),
});
const ChangedBy = z.object({ by: z.string(), at: z.string(), reason: z.string() });

const BuildingBlock = z
  .object({
    id: z.string(),
    kind: BlockKind,
    name: z.string(),
    description: z.string(),
    publisher: z.object({ type: z.enum(['digdir', 'own', 'shared']), name: z.string() }),
    version: z.string(),
    latestVersion: z.string().optional(),
    update: z
      .object({
        version: z.string(),
        availableFrom: z.string(),
        notes: z.string(),
        perService: z.array(
          z.object({
            service: z.string(),
            scoreBefore: z.number().nullable(),
            scoreAfter: z.number().nullable(),
          }),
        ),
      })
      .optional(),
    dataLocation: DataLocation.nullable(),
    status: z.enum(blockStatuses),
    policyBlock: z.object({ rule: z.string(), ownedBy: z.string(), text: z.string() }).optional(),
    approver: z.string().optional(),
    capabilities: z.array(z.string()),
    permissions: z.array(BlockPermission),
    usedBy: z.array(BlockUser),
    scores: z.array(
      z.object({
        testSet: z.string(),
        service: z.string(),
        score: z.number(),
        run: z.string(),
        at: z.string(),
      }),
    ),
    settingsSchema: z.object({
      type: z.literal('object'),
      properties: z.record(z.string(), SettingSchema),
      additionalProperties: z.literal(false),
    }),
    tenantOverrides: z.record(z.string(), z.unknown()),
    settingsVersion: z.number().int(),
    right: z.enum(['manage-services', 'manage-datasets']),
    changedBy: ChangedBy.optional(),
    pendingRequest: z
      .object({ id: z.string(), at: z.string(), by: z.string(), reason: z.string() })
      .optional(),
  })
  .openapi('BuildingBlock');

const BuildingBlockList = z
  .object({
    data: z.array(BuildingBlock),
    counts: z.object({
      inUse: z.number().int(),
      catalog: z.number().int(),
      byKind: z.record(z.string(), z.number().int()),
    }),
  })
  .openapi('BuildingBlockList');

const SettingChange = z.object({ key: z.string(), before: z.unknown(), after: z.unknown() });

const BlockVersion = z
  .object({
    source: z.enum(['publisher', 'tenant']),
    version: z.string(),
    at: z.string().optional(),
    by: z.string().optional(),
    reason: z.string().optional(),
    event: z
      .enum(['adopted', 'approval_requested', 'approved', 'rejected', 'withdrawn', 'settings'])
      .optional(),
    changes: z.array(SettingChange).optional(),
  })
  .openapi('BlockVersion');

const BlockChange = z
  .object({
    block: BuildingBlock,
    version: z.number().int(),
    changes: z.array(SettingChange),
    affectedServices: z.array(BlockUser),
  })
  .openapi('BlockChange');

const ApprovalRequest = z
  .object({
    id: z.string(),
    tenant: z.string(),
    kind: BlockKind,
    block: z.string(),
    blockName: z.string(),
    approver: z.string(),
    state: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
    reason: z.string(),
    requestedBy: z.string(),
    requestedByName: z.string().optional(),
    requestedAt: z.string(),
    grants: z.literal('writes').optional(),
    decision: z
      .object({ by: z.string(), byName: z.string().optional(), at: z.string(), reason: z.string() })
      .optional(),
  })
  .openapi('BlockApprovalRequest');

const RegistrationInput = z
  .object({
    type: z.enum(registrationTypes),
    name: z.string(),
    id: z.string().optional(),
    endpoint: z.string().optional(),
    auth: z
      .object({
        kind: z.enum(['none', 'bearer', 'api-key', 'maskinporten', 'oauth-client-credentials']),
        secret: z.string().optional().describe('A secret name or `secret://tenant/...` reference.'),
        header: z.string().optional(),
        tokenUrl: z.string().optional(),
        clientId: z.string().optional(),
        scope: z.string().optional(),
      })
      .optional(),
    extensionPoint: z.string().optional(),
    document: z.string().optional(),
    documentUrl: z.string().optional(),
    operations: z.array(z.string()).optional(),
    writes: z.boolean().optional(),
    reason: z.string().optional().describe('Used when the change-reason header is absent.'),
  })
  .openapi('BlockRegistration');

const ContractTestResult = z.object({
  name: z.string(),
  passed: z.boolean(),
  reason: z.string().optional(),
});

const ContractTestReport = z
  .object({
    type: z.enum(registrationTypes),
    passed: z.boolean(),
    results: z.array(ContractTestResult),
    tools: z.array(
      z.object({
        name: z.string(),
        description: z.string().optional(),
        operation: z.string().optional(),
        method: z.string().optional(),
        path: z.string().optional(),
        readOnly: z.boolean().optional(),
        status: z.enum(['enabled', 'not_selected', 'write_disabled']).optional(),
      }),
    ),
    agent: z
      .object({
        name: z.string(),
        description: z.string(),
        version: z.string().optional(),
        provider: z.string().optional(),
        skills: z.array(z.object({ name: z.string(), description: z.string().optional() })),
      })
      .optional(),
  })
  .openapi('BlockContractTestReport');

const ManifestPreview = z
  .object({ manifest: z.string(), permissions: z.array(BlockPermission) })
  .openapi('BlockManifestPreview');

const RegistrationResult = z
  .object({
    id: z.string(),
    kind: z.literal('tool'),
    version: z.string(),
    contractTests: z.array(ContractTestResult),
    synced: z.boolean(),
    syncError: z.string().optional(),
    changedBy: ChangedBy,
    writesApproval: z
      .object({
        request: z.string(),
        state: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
      })
      .optional(),
  })
  .openapi('BlockRegistrationResult');

const BlockProblem = Problem.extend({
  code: z.string().optional(),
  contractTests: z.array(ContractTestResult).optional(),
}).openapi('BlockProblem');
const blockProblem = (description: string) => ({
  description,
  content: { 'application/problem+json': { schema: BlockProblem } },
});

const OperatorApprovalRequest = z
  .object({
    id: z.string(),
    tenant: z.string(),
    tenantName: z.string(),
    block: z.object({
      kind: BlockKind,
      id: z.string(),
      version: z.string().nullable(),
      name: z.string(),
      publisher: z.string().optional(),
      dataLocation: DataLocation.nullable().optional(),
      rule: z.object({ rule: z.string(), ownedBy: z.string(), text: z.string() }).optional(),
      access: z.array(BlockPermission).optional(),
      scores: BuildingBlock.shape.scores.optional(),
      services: z.array(z.string()).optional(),
    }),
    reason: z.string(),
    requestedBy: z.string(),
    requestedAt: z.string(),
    status: z.enum(['pending', 'approved', 'rejected', 'withdrawn']),
    grants: z.literal('writes').optional(),
    decision: ApprovalRequest.shape.decision,
  })
  .openapi('OperatorBlockApprovalRequest');

const CatalogEntry = z.object({
  ref: z.string(),
  description: z.string().optional(),
  configSchema: z.record(z.string(), z.unknown()).optional(),
  usedBy: z.array(z.string()).describe('Tenants whose services use it.'),
});

const CheckResult = z.object({
  name: z.string(),
  status: z.enum(['passed', 'failed', 'skipped']),
  reason: z.string().optional(),
  ms: z.number(),
});
const ContractTrigger = z.enum(['boot', 'operator', 'registration']);
const ContractRun = z
  .object({
    contract: z.string(),
    passed: z.boolean(),
    startedAt: z.string(),
    endedAt: z.string(),
    results: z.array(CheckResult),
    plugin: z.string(),
    version: z.string(),
    trigger: ContractTrigger,
    by: z.string().optional(),
  })
  .openapi('PluginContractRun');

const PluginManifest = pluginManifest.extend({}).openapi('PluginManifest');

const PluginSummary = pluginManifest
  .safeExtend({
    verifiable: z.boolean(),
    contractTests: z
      .object({
        passed: z.boolean(),
        version: z.string(),
        at: z.string(),
        trigger: ContractTrigger,
        results: z.array(CheckResult),
      })
      .nullable(),
    history: z.array(z.object({ version: z.string(), passed: z.boolean(), at: z.string() })),
  })
  .openapi('PluginSummary');

const ExternalPluginInput = z
  .object({
    manifest: z
      .record(z.string(), z.unknown())
      .describe('A plug-in manifest; origin is set to external.'),
    endpoint: z
      .object({
        baseURL: z.string(),
        protocol: z.string(),
        deployment: z.string().optional(),
        auth: z
          .object({
            kind: z.enum(['bearer', 'api-key']),
            secret: z.string().describe('A `secret://` reference.'),
          })
          .optional(),
        allow: z
          .array(z.object({ host: z.string(), port: z.number().int().optional() }))
          .optional(),
        options: z.record(z.string(), z.unknown()).optional(),
        document: z.string().optional(),
        example: z.object({ tool: z.string(), input: z.unknown() }).optional(),
        query: z.string().optional(),
      })
      .optional(),
  })
  .openapi('ExternalPluginInput');

const RegisteredPlugin = pluginManifest
  .safeExtend({
    revision: z.number().int(),
    contractTests: z.object({ passed: z.boolean(), results: z.array(CheckResult) }).nullable(),
  })
  .openapi('RegisteredPlugin');

const PromotedPlugin = pluginManifest
  .safeExtend({
    revision: z.number().int(),
    shared: z.object({ tenant: z.string(), connection: z.string() }),
  })
  .openapi('PromotedPlugin');

const TenantPlugin = z
  .object({
    kind: z.enum(pluginKinds),
    id: z.string(),
    version: z.string(),
    contract: z.string(),
    title: z.string(),
    description: z.string(),
    publisher: z.string(),
    capabilities: z.array(z.string()),
    dataLocation: DataLocation.nullable(),
    contractTests: z.object({ passed: z.boolean(), at: z.string() }).nullable(),
  })
  .openapi('TenantPlugin');

const OnboardingDecision = z.object({
  by: z.string(),
  byName: z.string().optional(),
  at: z.string(),
  reason: z.string(),
});
const OnboardingTerms = z.object({
  accepted: z.literal(true),
  version: z.string(),
  at: z.string(),
});
const OnboardingStatus = z.enum(['pending', 'approved', 'rejected']);

const OwnOnboardingRequest = z
  .object({
    id: z.string(),
    org: z.string(),
    orgName: z.string(),
    contactName: z.string(),
    contactEmail: z.string(),
    purpose: z.string(),
    terms: OnboardingTerms,
    requestedBy: z.string(),
    requesterName: z.string().optional(),
    requestedAt: z.string(),
    status: OnboardingStatus,
    decision: OnboardingDecision.optional(),
  })
  .openapi('OwnOnboardingRequest');

const OperatorOnboardingRequest = OwnOnboardingRequest.openapi('OperatorOnboardingRequest');

const SupportSession = z
  .object({
    id: z.string(),
    operator: z.string(),
    operatorName: z.string().optional(),
    tenant: z.string(),
    reason: z.string(),
    openedAt: z.string(),
    expiresAt: z.string(),
    endedAt: z.string().optional(),
  })
  .openapi('SupportSessionRecord');

const DefinitionVersionSummary = z.object({
  version: z.number().int(),
  publishedBy: z.string(),
  publishedAt: z.string(),
  reason: z.string(),
  publishedByName: z.string().optional(),
});
const DefinitionVersion = DefinitionVersionSummary.extend({
  definition: z.record(z.string(), z.unknown()),
  files: z.record(z.string(), z.string()),
}).openapi('OperatorDefinitionVersion');

const blockKindParam = z
  .enum(blockKinds)
  .openapi({ param: { name: 'kind', in: 'path' }, example: 'tool' });
const blockIdParam = z.string().openapi({
  param: { name: 'id', in: 'path' },
  example: 'lovdata',
  description: 'URL-encode ids with a slash, such as model ids (`fake%2Fgpt`).',
});

const definitionKind = z
  .enum(['services', 'step-flows', 'skills'])
  .openapi({ param: { name: 'kind', in: 'path' }, example: 'services' });

const TraceConnection = z
  .object({
    id: z.string(),
    host: z
      .string()
      .describe("The Langfuse's base URL; HTTPS, never a private or link-local address"),
    publicKey: z.string(),
    secretKey: z.string().describe('A secret://tenant/<tenant>/<name> reference, set for the host'),
    services: z
      .array(z.string())
      .describe('The services whose eval runs it receives; one connection per service'),
    residency: z
      .enum(['norway', 'eu', 'global'])
      .describe(
        "Where the host stores data and its judges' models run. Set by an operator on Digdir's Langfuse",
      ),
    content: z.boolean().describe('Whether it receives the text its judges map'),
    erasureDeclared: z
      .boolean()
      .describe(
        "The tenant's declaration that its own Langfuse deletes what genki deletes and keeps raw files at most 7 days",
      ),
    instance: z.boolean().describe("Whether the host is Digdir's Langfuse"),
    removing: z
      .boolean()
      .optional()
      .describe(
        'Removal asked for: covers no service, and is gone once every trace sent through it is deleted',
      ),
    residencySetBy: z.enum(['operator', 'tenant']),
  })
  .openapi('TraceConnection');

const connectionId = pathParam('id', 'etaten');

const tracingRoutes: RouteConfig[] = [
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/tracing/connections',
    summary: "The tenant's Langfuse connections, with secret references only. Any member",
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(z.object({ data: z.array(TraceConnection) }), 'Connections'),
      404: problem('Not a member of the tenant'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/tracing/connections/{id}',
    summary: 'Create or change a Langfuse connection. Needs manage-services',
    request: {
      params: z.object({ tenant, id: connectionId }),
      headers: reason,
      body: body(
        TraceConnection.omit({
          id: true,
          instance: true,
          residencySetBy: true,
          removing: true,
        }).partial({
          services: true,
          residency: true,
          content: true,
          erasureDeclared: true,
        }),
      ),
    },
    responses: {
      200: json(TraceConnection.omit({ instance: true, residencySetBy: true }), 'Saved'),
      400: problem(
        'A host that is not HTTPS or is private, a secret of another tenant or not set for the host, a service already covered, or content where erasure is not shown',
      ),
      403: problem('Missing manage-services'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/tracing/connections/{id}',
    summary:
      'Remove a Langfuse connection: every trace sent through it is deleted first, and it is gone once each delete is confirmed. Needs manage-services',
    request: { params: z.object({ tenant, id: connectionId }), headers: reason },
    responses: {
      200: json(
        z.union([z.object({ removed: z.string() }), z.object({ removing: z.string() })]),
        'Removed, or being removed while its traces are deleted',
      ),
      400: problem('No such connection'),
      403: problem('Missing manage-services'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/tracing/connections/{id}/check',
    summary:
      "Check a connection's keys against its Langfuse project, through the egress path. Any member",
    request: { params: z.object({ tenant, id: connectionId }) },
    responses: {
      200: json(
        z.object({ ok: z.literal(true), project: z.object({ id: z.string(), name: z.string() }) }),
        'The project the keys open',
      ),
      404: problem('No such connection'),
      422: problem('Langfuse refused the keys or could not be reached'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/tracing/connections/{tenant}/{id}/residency',
    summary: "Set the residency of a tenant's connection to Digdir's Langfuse. Operators only",
    request: {
      params: z.object({ tenant, id: connectionId }),
      headers: reason,
      body: body(z.object({ residency: z.enum(['norway', 'eu', 'global']) })),
    },
    responses: {
      200: json(TraceConnection.omit({ instance: true, residencySetBy: true }), 'Saved'),
      400: problem("Not a connection to Digdir's Langfuse"),
      403: problem('Not an operator'),
    },
  }),
];

export const accessRoutes: RouteConfig[] = [
  ...tracingRoutes,
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/access',
    summary: "The tenant's services with the Altinn requirement to call them, and its API keys",
    request: { params: z.object({ tenant }), headers: supportSession },
    responses: {
      200: json(
        z.object({
          services: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              publicName: z.string(),
              requirement: ServiceRequirement,
            }),
          ),
          keys: z.array(ApiKey).describe('Newest first.'),
        }),
        'Services and keys',
      ),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/api-keys',
    summary:
      'Create a tenant API key; the key is returned once (manage-services, tenant members only, audited)',
    request: {
      params: z.object({ tenant }),
      headers: reason,
      body: body(
        z.object({
          name: z.string().min(1),
          datasets: z.array(z.string()).optional(),
          agents: z.array(z.string()).optional(),
          allowedOverrides: overrides,
          expiresInDays: z.number().positive().optional(),
          callsPerMinute: z.number().int().min(1).max(6000).optional(),
        }),
      ),
    },
    responses: {
      201: json(NewApiKey, 'Created. No datasets and no agents means the key reaches everything.'),
      400: invalid,
      401: unauthorized,
      403: problem('Missing right, or an operator (keys are made by the tenant itself)'),
      404: notMember,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/api-keys/{id}/revoke',
    summary: 'Revoke an API key (manage-services, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', '3f9a1c2b-7d4e-4b8a-9c11-2a6f0e5d8b77') }),
      headers: reason,
    },
    responses: {
      200: json(ApiKey, 'The revoked key'),
      400: problem('Missing or short change-reason'),
      401: unauthorized,
      403: forbidden,
      404: problem('No such key, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/api-keys/{id}/rotate',
    summary:
      'Replace an API key with a new one carrying the same grants and revoke the old one (manage-services, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', '3f9a1c2b-7d4e-4b8a-9c11-2a6f0e5d8b77') }),
      headers: reason,
      body: body(z.object({ allowedOverrides: overrides }), false),
    },
    responses: {
      201: json(NewApiKey, 'The new key, shown once'),
      400: problem('Missing or short change-reason'),
      401: unauthorized,
      403: forbidden,
      404: problem('No active key with that id, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/api-keys/{id}/policy',
    summary: 'Attach a key policy to an API key (manage-services, tenant members only, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', '3f9a1c2b-7d4e-4b8a-9c11-2a6f0e5d8b77') }),
      headers: reason,
      body: body(z.object({ policyId: z.string() })),
    },
    responses: {
      200: json(z.object({ keyId: z.string(), policy: z.string().nullable() }), 'Attached'),
      400: problem('Missing reason, unknown policy, or a key bound to one service'),
      401: unauthorized,
      403: forbidden,
      404: problem('No such key, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/api-keys/{id}/policy',
    summary: 'Detach the key policy from an API key (manage-services, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', '3f9a1c2b-7d4e-4b8a-9c11-2a6f0e5d8b77') }),
      headers: reason,
    },
    responses: {
      200: json(z.object({ keyId: z.string(), policy: z.null() }), 'Detached'),
      400: problem('Missing reason, or a key bound to one service'),
      401: unauthorized,
      403: forbidden,
      404: problem('No such key, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/api-key-policies',
    summary: "The tenant's key policies with the keys that use each (manage-services)",
    request: { params: z.object({ tenant }), headers: supportSession },
    responses: {
      200: json(z.object({ data: z.array(KeyPolicy) }), 'Policies'),
      401: unauthorized,
      403: forbidden,
      404: notMember,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/api-key-policies',
    summary: 'Create a key policy (manage-services, tenant members only, audited)',
    request: { params: z.object({ tenant }), headers: reason, body: body(KeyPolicyInput) },
    responses: {
      201: json(KeyPolicy, 'Created'),
      400: invalid,
      401: unauthorized,
      403: forbidden,
      404: notMember,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/api-key-policies/{id}',
    summary: 'Change a key policy; keys using it get the new grants (manage-services, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', '7b1e4c8a-2f3d-4e5a-9b6c-0d1e2f3a4b5c') }),
      headers: reason,
      body: body(KeyPolicyInput),
    },
    responses: {
      200: json(KeyPolicy, 'Saved'),
      400: invalid,
      401: unauthorized,
      403: forbidden,
      404: problem('No such policy, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/api-key-policies/{id}',
    summary: 'Remove a key policy that no key uses (manage-services, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', '7b1e4c8a-2f3d-4e5a-9b6c-0d1e2f3a4b5c') }),
      headers: reason,
    },
    responses: {
      204: { description: 'Removed' },
      400: problem('Missing reason'),
      401: unauthorized,
      403: forbidden,
      404: problem('No such policy, or not a member of this tenant'),
      409: problem('Keys still use the policy'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/clients',
    summary: "The tenant's frontend clients with recent webhook deliveries and the channel paths",
    request: {
      params: z.object({ tenant }),
      query: z.object({ service: queryParam('service', 'Only clients of this service.') }),
      headers: supportSession,
    },
    responses: {
      200: json(
        z.object({
          clients: z.array(Client),
          endpoints: z.record(z.enum(clientChannels), z.array(z.string())),
          oidc: z.object({
            issuer: z.string().optional(),
            audience: z.string().optional(),
            altinnResource: z.string().optional(),
          }),
        }),
        'Clients',
      ),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/clients/{id}',
    summary: 'Create or change a frontend client (manage-services, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', 'saksbehandler-web') }),
      headers: reason,
      body: body(ClientInput),
    },
    responses: {
      200: json(Client, 'Saved'),
      400: invalid,
      401: unauthorized,
      403: forbidden,
      404: notMember,
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/clients/{id}',
    summary: 'Remove a frontend client (manage-services, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', 'saksbehandler-web') }),
      headers: reason,
    },
    responses: {
      200: json(z.object({ id: z.string() }), 'Removed'),
      400: problem('Missing or short change-reason'),
      401: unauthorized,
      403: forbidden,
      404: problem('No such client, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/clients/{id}/webhook/test',
    summary:
      "Send a signed ping to the client's webhook and show the delivery (manage-services, audited)",
    request: {
      params: z.object({ tenant, id: pathParam('id', 'saksbehandler-web') }),
      headers: reason,
    },
    responses: {
      200: json(WebhookDelivery, 'The delivery, also when it failed'),
      400: problem('Missing or short change-reason'),
      401: unauthorized,
      403: forbidden,
      404: problem('No such client, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/services/{service}/api-keys',
    summary: 'The API keys bound to one service, newest first',
    request: { params: z.object({ tenant, service: pathParam('service', 'klarsprak') }) },
    responses: {
      200: json(z.object({ keys: z.array(ApiKey) }), 'Keys'),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/services/{service}/api-keys',
    summary:
      'Create an API key bound to one service; the key is returned once (manage-services, audited)',
    request: {
      params: z.object({ tenant, service: pathParam('service', 'klarsprak') }),
      headers: reason,
      body: body(
        z.object({
          name: z.string().min(1),
          client: z.string().optional().describe('A client of the same service.'),
          expiresInDays: z.number().positive().optional(),
          allowedOverrides: overrides,
        }),
      ),
    },
    responses: {
      201: json(NewApiKey, 'Created'),
      400: problem('Missing reason, no name, or a client of another service'),
      401: unauthorized,
      403: forbidden,
      404: problem('No such service, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/maskinporten-clients',
    summary: 'Maskinporten clients the tenant has registered, by name (manage-services)',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(z.object({ data: z.array(MaskinportenClient) }), 'Clients'),
      401: unauthorized,
      403: forbidden,
      404: notMember,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/maskinporten-clients',
    summary:
      'Register a Maskinporten client and the services it may call (manage-services, tenant members only, audited)',
    request: {
      params: z.object({ tenant }),
      headers: reason,
      body: body(
        z.object({
          clientId: z.string().openapi({ example: 'a1b2c3d4-0000-4000-8000-000000000001' }),
          name: z.string().min(1),
          services: z.array(z.string()).min(1).describe('Service ids, or `["*"]` alone.'),
        }),
      ),
    },
    responses: {
      201: json(MaskinportenClient, 'Registered'),
      400: invalid,
      401: unauthorized,
      403: problem('Missing right, or an operator (the tenant registers its own clients)'),
      404: notMember,
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/maskinporten-clients/{clientId}',
    summary: 'Remove a Maskinporten client registration (manage-services, audited)',
    request: {
      params: z.object({
        tenant,
        clientId: pathParam('clientId', 'a1b2c3d4-0000-4000-8000-000000000001'),
      }),
      headers: reason,
    },
    responses: {
      204: { description: 'Removed' },
      400: problem('Missing reason'),
      401: unauthorized,
      403: forbidden,
      404: problem('No such client, or not a member of this tenant'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/me',
    summary: 'The rights the caller has in this tenant',
    request: { params: z.object({ tenant }), headers: supportSession },
    responses: {
      200: json(z.object({ rights: z.array(Right) }), 'Rights'),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/me/preferences',
    summary: "The caller's own preferences in this tenant",
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(Preferences, 'Preferences; null means not chosen'),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/me/preferences',
    summary:
      "Change the caller's own preferences; fields left out are kept, null clears (versioned with the reason)",
    request: {
      params: z.object({ tenant }),
      headers: reason,
      body: body(
        z.object({
          writtenStandard: z.enum(writtenStandards).nullable().optional(),
          language: z.enum(locales).nullable().optional(),
        }),
      ),
    },
    responses: {
      200: json(Preferences, 'Saved'),
      400: problem('Missing reason, or an unknown written standard or language'),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/integrations',
    summary: "The tenant's tool connections with active and pending tools, and the trace settings",
    request: { params: z.object({ tenant }), headers: supportSession },
    responses: {
      200: json(
        z.object({
          connections: z.array(Integration),
          traces: z.object({ enabled: z.boolean(), content: z.boolean() }),
        }),
        'Integrations',
      ),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/tool-connections',
    summary: "The tenant's tool connections and the names of their active tools",
    request: { params: z.object({ tenant }), headers: supportSession },
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              id: z.string(),
              name: z.string(),
              protocol: z.enum(['mcp', 'a2a', 'openapi']),
              endpoint: z.string(),
              version: z.string(),
              tools: z.array(z.string()),
            }),
          ),
        }),
        'Connections',
      ),
      401: unauthorized,
      404: notMember,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/tool-connections',
    summary: 'Register an MCP, A2A or OpenAPI tool connection (manage-services, audited)',
    request: {
      params: z.object({ tenant }),
      headers: reason,
      body: body(ToolConnectionInput),
    },
    responses: {
      200: json(
        z.object({ id: z.string(), endpoint: z.string(), version: z.string() }),
        'Registered; sync it to list its tools',
      ),
      400: invalid,
      401: unauthorized,
      403: problem('Missing right, or not a member of this tenant'),
      404: notMember,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/tool-connections/{id}/sync',
    summary:
      'List the tools of a connection again; new or changed tools wait for approval (manage-services, audited)',
    request: { params: z.object({ tenant, id: pathParam('id', 'lovdata') }), headers: reason },
    responses: {
      200: json(
        z.object({ active: z.number().int(), pending: z.array(z.string()) }),
        'Active tool count and the tools waiting for approval',
      ),
      400: problem('Missing reason, or the sync failed'),
      401: unauthorized,
      403: problem('Missing right, or not a member of this tenant'),
      404: notMember,
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/tool-connections/{id}/approve',
    summary: 'Approve a pending tool so services can call it (manage-services, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', 'lovdata') }),
      headers: reason,
      body: body(z.object({ tool: z.string() })),
    },
    responses: {
      200: json(z.object({ approved: z.string() }), 'Approved'),
      400: problem('Missing reason, or no such pending tool'),
      401: unauthorized,
      403: problem('Missing right, or not a member of this tenant'),
      404: notMember,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/secrets/{name}',
    summary:
      'Store a tenant secret and the hosts it is for; the value is never returned (manage-services or register-building-blocks, audited without the value)',
    request: {
      params: z.object({ tenant, name: pathParam('name', 'lovdata') }),
      headers: reason,
      body: body(SecretValue),
    },
    responses: {
      200: json(SecretRef, 'The reference to use in connections'),
      400: problem('Missing value, hosts or reason, or an invalid name or host'),
      401: unauthorized,
      403: problem('Missing right, or other hosts without manage-services'),
      404: notMember,
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/secrets/{name}/hosts',
    summary: 'Change the hosts a tenant secret may be sent to (manage-services, audited)',
    request: {
      params: z.object({ tenant, name: pathParam('name', 'lovdata') }),
      headers: reason,
      body: body(SecretHosts),
    },
    responses: {
      200: json(SecretRef.extend({ allowedHosts: z.array(z.string()) }), 'The stored hosts'),
      400: problem('Missing or invalid hosts, or missing reason'),
      401: unauthorized,
      403: problem('Missing right'),
      404: problem('No such secret, or the tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/secrets/{name}',
    summary:
      'Store a platform secret; the value is never returned (operators, audited without the value)',
    request: {
      params: z.object({ name: pathParam('name', 'enhetsregisteret') }),
      headers: reason,
      body: body(SecretValue),
    },
    responses: {
      200: json(
        z.object({ ref: z.string().openapi({ example: 'secret://platform/enhetsregisteret' }) }),
        'The reference',
      ),
      400: problem('Missing value or reason, or an invalid name'),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/connectors',
    summary:
      "The tenant's database connectors with status and last sync, newest first (use-services)",
    request: { params: z.object({ tenant }), headers: supportSession },
    responses: {
      200: json(z.object({ data: z.array(Connector) }), 'Connectors'),
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/connectors/network',
    summary: 'Whether the platform may reach a database host for this tenant (use-services)',
    request: {
      params: z.object({ tenant }),
      query: z.object({
        host: z
          .string()
          .openapi({ param: { name: 'host', in: 'query' }, example: 'db.example.no' }),
      }),
    },
    responses: {
      200: json(
        z.object({
          host: z.string(),
          network: Network,
          allowed: z.boolean(),
          message: z.string().optional().describe('Why the host is refused.'),
        }),
        'Reachability',
      ),
      400: problem('No host'),
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/connectors/{id}',
    summary: 'One database connector (use-services)',
    request: { params: z.object({ tenant, id: pathParam('id', 'saksarkiv') }) },
    responses: {
      200: json(Connector, 'Connector'),
      401: unauthorized,
      403: problem('Missing right'),
      404: problem('No such connector, or the tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/connectors/{id}/sync',
    summary: 'Start a sync of a connected database (manage-datasets, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', 'saksarkiv') }),
      headers: changeReason,
    },
    responses: {
      202: json(Connector, 'Started'),
      401: unauthorized,
      403: problem('Missing right'),
      404: problem(
        'No such connector, or it is not connected, or the tenant is not reachable for the caller',
      ),
      409: problem('The sync did not start'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/connectors/{id}/credentials',
    summary:
      'Replace the database password of a connector; it is never returned (manage-datasets, audited)',
    request: {
      params: z.object({ tenant, id: pathParam('id', 'saksarkiv') }),
      headers: changeReason,
      body: body(z.strictObject({ password: z.string().min(1).max(1000) })),
    },
    responses: {
      200: json(Connector, 'Saved'),
      400: problem('No password'),
      401: unauthorized,
      403: problem('Missing right'),
      404: problem(
        'No such connector, or it is not connected, or the tenant is not reachable for the caller',
      ),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/private-networks',
    summary: 'The private networks Digdir has opened for the tenant (use-services)',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(PrivateNetworks, 'Private networks'),
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/tenants/{tenant}/private-networks',
    summary: 'The private networks opened for a tenant (operators)',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(PrivateNetworks, 'Private networks'),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'put',
    path: '/operator/tenants/{tenant}/private-networks',
    summary:
      'Replace the private networks a tenant may reach, at most 50 entries (operators, audited)',
    request: {
      params: z.object({ tenant }),
      headers: reason,
      body: body(z.object({ entries: z.array(z.string()).max(50) })),
    },
    responses: {
      200: json(PrivateNetworks, 'Saved'),
      400: invalid,
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/building-blocks',
    summary: 'Building blocks the tenant uses or may adopt, with counts',
    request: {
      params: z.object({ tenant }),
      query: z.object({
        kind: queryParam('kind', `One of ${blockKinds.join(', ')}.`),
        status: queryParam('status', `One of ${blockStatuses.join(', ')}.`),
        publisher: queryParam('publisher', 'digdir, own or shared.'),
      }),
      headers: supportSession,
    },
    responses: {
      200: json(BuildingBlockList, 'Building blocks'),
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Tenant not registered'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/building-blocks',
    summary:
      'Register an MCP, A2A or OpenAPI building block; contract tests run first (register-building-blocks, audited)',
    request: {
      params: z.object({ tenant }),
      headers: changeReason,
      body: body(RegistrationInput),
    },
    responses: {
      201: json(RegistrationResult, 'Registered and synced'),
      400: invalid,
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
      422: blockProblem('The contract tests failed; `contractTests` has every result'),
      501: blockProblem('This registration type is not supported yet'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/building-blocks/secrets',
    summary:
      'Names and references of the tenant secrets a building block can use (register-building-blocks)',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({ name: z.string(), ref: z.string(), allowedHosts: z.array(z.string()) }),
          ),
        }),
        'Secret names and the hosts each is for; never values',
      ),
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/building-blocks/manifest-preview',
    summary: 'Preview the manifest and permissions of a registration (register-building-blocks)',
    request: {
      params: z.object({ tenant }),
      query: z.object({
        type: queryParam('type', `One of ${registrationTypes.join(', ')}. Default mcp.`),
        name: queryParam('name', 'Name of the building block.'),
        id: queryParam('id', 'Id; derived from the name when left out.'),
        endpoint: queryParam('endpoint', 'Address of the service.'),
        auth: queryParam('auth', 'Auth kind.'),
        secret: queryParam('secret', 'Secret name for the auth.'),
        extensionPoint: queryParam('extensionPoint', 'For extension points.'),
      }),
    },
    responses: {
      200: json(ManifestPreview, 'Preview'),
      400: problem('Unknown type'),
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/building-blocks/manifest-preview',
    summary: 'Preview the manifest and permissions of a registration (register-building-blocks)',
    request: { params: z.object({ tenant }), body: body(RegistrationInput) },
    responses: {
      200: json(ManifestPreview, 'Preview'),
      400: problem('Unknown type'),
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/building-blocks/contract-tests',
    summary:
      'Run the contract tests of a registration without saving it (register-building-blocks)',
    request: { params: z.object({ tenant }), body: body(RegistrationInput) },
    responses: {
      200: json(ContractTestReport, 'The report, passed or not'),
      400: problem('Unknown type'),
      401: unauthorized,
      404: problem('The tenant is not reachable for the caller'),
      403: problem('Missing right'),
      501: blockProblem('This registration type is not supported yet'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/tenants/{tenant}/building-blocks/approval-requests/{request}',
    summary:
      'Withdraw a pending approval request (manage-services, and manage-datasets for data blocks; audited)',
    request: {
      params: z.object({
        tenant,
        request: pathParam('request', '5d2c9e10-8f4b-4a7e-b3d1-6c0a2e9f1b48'),
      }),
      headers: changeReason,
    },
    responses: {
      200: json(ApprovalRequest, 'Withdrawn'),
      400: invalid,
      401: unauthorized,
      403: problem('Missing right'),
      404: problem('No such pending request, or the tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/building-blocks/{kind}/{id}',
    summary: 'One building block as the tenant sees it',
    request: {
      params: z.object({ tenant, kind: blockKindParam, id: blockIdParam }),
    },
    responses: {
      200: json(BuildingBlock, 'Building block'),
      401: unauthorized,
      403: problem('Tenant not registered'),
      404: problem('No such building block, or the tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/building-blocks/{kind}/{id}/versions',
    summary: "Publisher versions and the tenant's own changes to a building block",
    request: {
      params: z.object({ tenant, kind: blockKindParam, id: blockIdParam }),
    },
    responses: {
      200: json(z.object({ data: z.array(BlockVersion) }), 'Versions'),
      401: unauthorized,
      403: problem('Tenant not registered'),
      404: problem('No such building block, or the tenant is not reachable for the caller'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/building-blocks/{kind}/{id}/adopt',
    summary:
      'Take a building block into use (manage-services, or manage-datasets for data blocks; audited)',
    request: {
      params: z.object({ tenant, kind: blockKindParam, id: blockIdParam }),
      headers: changeReason,
      body: body(z.object({}), false),
    },
    responses: {
      200: json(BlockChange, 'In use'),
      400: invalid,
      401: unauthorized,
      403: problem('Missing right'),
      404: problem('No such building block, or the tenant is not reachable for the caller'),
      409: problem('Not allowed, or approval is needed first'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/tenants/{tenant}/building-blocks/{kind}/{id}/approval-requests',
    summary:
      'Ask for approval to use a building block (manage-services, or manage-datasets for data blocks; audited)',
    request: {
      params: z.object({ tenant, kind: blockKindParam, id: blockIdParam }),
      headers: changeReason,
      body: body(z.object({}), false),
    },
    responses: {
      200: json(ApprovalRequest, 'Requested'),
      400: invalid,
      401: unauthorized,
      403: problem('Missing right'),
      404: problem('No such building block, or the tenant is not reachable for the caller'),
      409: problem('The building block does not need approval'),
    },
  }),
  createRoute({
    method: 'put',
    path: '/tenants/{tenant}/building-blocks/{kind}/{id}/settings',
    summary:
      "Change the tenant's settings for a building block; null removes one; If-Match guards against lost updates (audited)",
    request: {
      params: z.object({ tenant, kind: blockKindParam, id: blockIdParam }),
      headers: optionalReason.extend({
        'if-match': z
          .string()
          .optional()
          .openapi({
            param: { name: 'if-match', in: 'header' },
            description: 'The settingsVersion that was read.',
          }),
      }),
      body: body(
        z.object({
          settings: z.record(z.string(), z.unknown()),
          ifVersion: z.number().int().optional().describe('Same as If-Match.'),
          reason: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: json(BlockChange, 'Saved, with the services affected'),
      400: invalid,
      401: unauthorized,
      403: problem('Missing right'),
      404: problem('No such building block, or the tenant is not reachable for the caller'),
      409: problem('Changed by someone else, or the building block is not in use'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/tenants/{tenant}/plugins',
    summary: 'Plug-ins on the platform and their latest contract test (use-services)',
    request: {
      params: z.object({ tenant }),
      query: z.object({ kind: queryParam('kind', `One of ${pluginKinds.join(', ')}.`) }),
    },
    responses: {
      200: json(z.object({ data: z.array(TenantPlugin) }), 'Plug-ins'),
      401: unauthorized,
      403: forbidden,
      404: notMember,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/building-blocks',
    summary:
      'Strategies, step blocks and tools on the platform, with the tenants that use each (operators)',
    responses: {
      200: json(
        z.object({
          strategies: z.array(CatalogEntry),
          blocks: z.array(CatalogEntry),
          tools: z.array(CatalogEntry),
        }),
        'Catalogue',
      ),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/building-blocks/approval-requests',
    summary: 'Approval requests from every tenant, newest first (operators)',
    request: {
      query: z.object({
        status: queryParam('status', 'pending, approved, rejected or withdrawn.'),
        state: queryParam('state', 'Same as status.'),
      }),
    },
    responses: {
      200: json(z.object({ data: z.array(OperatorApprovalRequest) }), 'Requests'),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/building-blocks/approval-requests/{request}/decision',
    summary:
      'Approve or reject an approval request; approving writes turns on write tools (operators, audited)',
    request: {
      params: z.object({ request: pathParam('request', '5d2c9e10-8f4b-4a7e-b3d1-6c0a2e9f1b48') }),
      headers: changeReason,
      body: body(
        z.object({
          approve: z.boolean().optional(),
          decision: z
            .enum(['approved', 'rejected'])
            .optional()
            .describe('Used when approve is absent.'),
        }),
      ),
    },
    responses: {
      200: json(ApprovalRequest, 'Decided'),
      400: invalid,
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such pending request'),
      409: problem('The tenant approves this request, not Digdir'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/building-blocks/{id}/contract-tests',
    summary: 'Run the contract tests of a plug-in again (operators, audited)',
    request: { params: z.object({ id: pathParam('id', 'blob.memory') }), headers: reason },
    responses: {
      200: json(ContractRun, 'The run'),
      400: problem('Missing reason'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such plug-in'),
      409: problem('The plug-in has no contract tests to run'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/plugins',
    summary: 'Every plug-in with its latest contract test and history (operators)',
    request: {
      query: z.object({ kind: queryParam('kind', `One of ${pluginKinds.join(', ')}.`) }),
    },
    responses: {
      200: json(z.object({ data: z.array(PluginSummary) }), 'Plug-ins'),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/plugins',
    summary: 'Register an external plug-in; its contract tests must pass (operators, audited)',
    request: { headers: reason, body: body(ExternalPluginInput) },
    responses: {
      201: json(RegisteredPlugin, 'Registered'),
      400: invalid,
      401: unauthorized,
      403: operatorOnly,
      404: problem('No plug-in registry on this platform'),
      409: problem('The id belongs to a built-in plug-in'),
      422: problem('The kind is not registered here, or the contract tests failed'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/plugins/{id}',
    summary: 'One plug-in with every contract test run (operators)',
    request: { params: z.object({ id: pathParam('id', 'blob.memory') }) },
    responses: {
      200: json(PluginSummary.safeExtend({ runs: z.array(ContractRun) }), 'Plug-in'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such plug-in'),
    },
  }),
  createRoute({
    method: 'delete',
    path: '/operator/plugins/{id}',
    summary: 'Remove an external plug-in (operators, audited)',
    request: { params: z.object({ id: pathParam('id', 'model.example') }), headers: reason },
    responses: {
      200: json(z.object({ removed: z.string() }), 'Removed'),
      400: problem('Missing reason'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such external plug-in'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/plugins/{id}/contract-tests',
    summary: 'Run the contract tests of a plug-in again (operators, audited)',
    request: { params: z.object({ id: pathParam('id', 'blob.memory') }), headers: reason },
    responses: {
      200: json(ContractRun, 'The run'),
      400: problem('Missing reason'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such plug-in'),
      409: problem('The plug-in has no contract tests to run'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/plugins/manifest-check',
    summary: 'Check a plug-in manifest and return it with defaults filled in (operators)',
    request: { body: body(z.record(z.string(), z.unknown())) },
    responses: {
      200: json(PluginManifest, 'Valid manifest'),
      400: problem('Invalid manifest; `errors` names each field'),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/plugins/promotions',
    summary: "Share a tenant's tool connection with every tenant as a plug-in (operators, audited)",
    request: {
      headers: reason,
      body: body(z.object({ tenant: z.string(), connection: z.string() })),
    },
    responses: {
      201: json(PromotedPlugin, 'Shared'),
      400: problem('Missing tenant, connection or reason, or no approved tools'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such tool connection'),
      409: problem('Another shared plug-in offers tools with that name'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/onboarding/requests',
    summary:
      'Ask for access to the platform for an organisation (its leader or AI administrator, audited)',
    request: {
      body: body(
        z.object({
          org: z.string().openapi({ example: '991825827' }),
          orgName: z.string().min(1),
          contactName: z.string().min(1),
          contactEmail: z.string().email(),
          purpose: z.string().min(1),
          acceptedTerms: z.literal(true),
        }),
      ),
    },
    responses: {
      201: json(z.object({ id: z.string(), status: z.literal('pending') }), 'Sent'),
      400: problem('Invalid fields; `errors` names each'),
      401: unauthorized,
      403: problem('The caller may not ask for access for this organisation'),
      409: problem('Already registered, or a request is pending'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/onboarding/requests/mine',
    summary: 'Access requests the caller has sent, newest first',
    responses: {
      200: json(z.object({ data: z.array(OwnOnboardingRequest) }), 'Requests'),
      401: unauthorized,
    },
  }),
  createRoute({
    method: 'get',
    path: '/onboarding/organisations/{org}',
    summary: 'Whether an organisation the caller acts for is registered or may ask for access',
    request: { params: z.object({ org: pathParam('org', '991825827') }) },
    responses: {
      200: json(
        z.object({
          org: z.string(),
          registered: z.boolean(),
          mayRequest: z.boolean(),
          pendingRequest: z.object({ requestedAt: z.string(), mine: z.boolean() }).nullable(),
        }),
        'Status',
      ),
      401: unauthorized,
      403: problem('The caller does not act for this organisation'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/onboarding/requests',
    summary: 'Access requests from every organisation, newest first (operators)',
    request: {
      query: z.object({ status: queryParam('status', 'pending, approved or rejected.') }),
    },
    responses: {
      200: json(z.object({ data: z.array(OperatorOnboardingRequest) }), 'Requests'),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/onboarding/requests/{id}/decision',
    summary:
      'Approve or reject an access request; approving creates the tenant (operators, audited)',
    request: {
      params: z.object({ id: pathParam('id', '0e7c3a91-4b2d-4f6e-8a15-9d3c2b1a0f77') }),
      headers: reason,
      body: body(z.object({ approve: z.boolean() })),
    },
    responses: {
      200: json(OperatorOnboardingRequest, 'Decided'),
      400: invalid,
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such request'),
      409: problem('Already decided'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/tenants',
    summary: 'Add a tenant to the directory with status onboarding (operators, audited)',
    request: {
      headers: reason,
      body: body(
        z.object({
          orgNumber: z.string().openapi({ example: '991825827' }),
          name: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: json(
        z.object({ orgNumber: z.string(), name: z.string(), status: z.literal('onboarding') }),
        'Added',
      ),
      400: problem('Missing reason, or not a valid organisation number'),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/tenants/{tenant}/definitions',
    summary: 'Every definition of a tenant with its latest version and state (operators)',
    request: { params: z.object({ tenant }) },
    responses: {
      200: json(
        z.object({
          data: z.array(
            z.object({
              kind: z.string(),
              id: z.string(),
              state: z.string(),
              name: z.string(),
              latestVersion: z.number().int(),
              publishedAt: z.string().nullable(),
              publishedBy: z.string().nullable(),
              publishedByName: z.string().optional(),
            }),
          ),
        }),
        'Definitions by name',
      ),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/tenants/{tenant}/definitions/{kind}/{id}',
    summary:
      'The latest version of a tenant definition with its files and every version (operators)',
    request: {
      params: z.object({ tenant, kind: definitionKind, id: pathParam('id', 'klarsprak') }),
    },
    responses: {
      200: json(
        z.object({
          kind: z.enum(['Service', 'StepFlow', 'Skill']),
          tenant: z.string(),
          id: z.string(),
          latest: DefinitionVersion,
          versions: z.array(DefinitionVersionSummary),
        }),
        'Definition',
      ),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such definition'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/tenants/{tenant}/definitions/{kind}/{id}/versions/{version}',
    summary: 'One version of a tenant definition with its files (operators)',
    request: {
      params: z.object({
        tenant,
        kind: definitionKind,
        id: pathParam('id', 'klarsprak'),
        version: pathParam('version', '3'),
      }),
    },
    responses: {
      200: json(DefinitionVersion.omit({ publishedByName: true }), 'Version'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No such version'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/organizations/{orgNumber}',
    summary: 'Look up an organisation among the tenants, then in Enhetsregisteret (operators)',
    request: { params: z.object({ orgNumber: pathParam('orgNumber', '991825827') }) },
    responses: {
      200: json(
        z.object({
          orgNumber: z.string(),
          name: z.string(),
          source: z.enum(['platform', 'enhetsregisteret']),
        }),
        'Organisation',
      ),
      400: problem('Not a valid organisation number'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('Not found'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/operator/support-sessions',
    summary: 'Every support session, newest first (operators)',
    responses: {
      200: json(
        z.object({
          data: z.array(SupportSession.extend({ status: z.enum(['active', 'expired', 'ended']) })),
        }),
        'Sessions',
      ),
      401: unauthorized,
      403: operatorOnly,
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/support-sessions/{id}/end',
    summary: 'End a support session (operators, audited)',
    request: {
      params: z.object({ id: pathParam('id', 'id-1') }),
      headers: reason,
    },
    responses: {
      200: json(SupportSession, 'Ended'),
      400: problem('Missing reason'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No active session with that id'),
    },
  }),
  createRoute({
    method: 'post',
    path: '/operator/support-sessions/{id}/extend',
    summary: 'Extend your own active support session by 1 to 60 minutes (operators, audited)',
    request: {
      params: z.object({ id: pathParam('id', 'id-1') }),
      headers: reason,
      body: body(
        z.object({ minutes: z.number().int().min(1).max(60).optional().describe('Default 15.') }),
        false,
      ),
    },
    responses: {
      200: json(SupportSession, 'Extended'),
      400: problem('Missing reason, or minutes out of range'),
      401: unauthorized,
      403: operatorOnly,
      404: problem('No active session of yours with that id'),
    },
  }),
];

const OAuthError = z
  .object({ error: z.string(), error_description: z.string().optional() })
  .openapi('MockOAuthError');
const html = (description: string) => ({
  description,
  content: { 'text/html': { schema: z.string() } },
});
const form = <T extends z.ZodType>(schema: T) => ({
  required: true,
  content: { 'application/x-www-form-urlencoded': { schema } },
});
const devOnly = 'Development only: mounted when no real ID-porten issuer is configured. ';

export const mockRoutes: RouteConfig[] = [
  createRoute({
    method: 'post',
    path: '/mock/dev-login',
    summary: `${devOnly}Sign in as a test person without the browser flow`,
    request: {
      body: body(
        z.object({
          as: z.enum(['operator', 'employee']).optional(),
          pid: z.string().optional().describe('A test person; default from the identity file.'),
        }),
        false,
      ),
    },
    responses: {
      200: json(
        z.object({
          token: z.string(),
          name: z.string(),
          organisations: z.array(
            z.object({ orgNumber: z.string(), name: z.string(), actions: z.array(z.string()) }),
          ),
          roles: z.array(z.string()),
        }),
        'A test token',
      ),
      404: problem('No such test person'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/mock/ansattporten/.well-known/openid-configuration',
    summary: `${devOnly}OpenID discovery for the mock Ansattporten`,
    responses: { 200: json(z.record(z.string(), z.unknown()), 'Discovery document') },
  }),
  createRoute({
    method: 'get',
    path: '/mock/ansattporten/jwks.json',
    summary: `${devOnly}Signing keys of the mock Ansattporten`,
    responses: {
      200: json(z.object({ keys: z.array(z.record(z.string(), z.unknown())) }), 'Key set'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/mock/ansattporten/jwks',
    summary: `${devOnly}Signing keys of the mock Ansattporten`,
    responses: {
      200: json(z.object({ keys: z.array(z.record(z.string(), z.unknown())) }), 'Key set'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/mock/ansattporten/authorize',
    summary: `${devOnly}Start a code flow with PKCE; shows the test person picker`,
    request: {
      query: z.object({
        client_id: z.string(),
        redirect_uri: z.string(),
        response_type: z.literal('code'),
        code_challenge: z.string(),
        code_challenge_method: z.literal('S256'),
        scope: z.string().optional(),
        state: z.string().optional(),
        nonce: z.string().optional(),
        resource: z.string().optional(),
        acr_values: z.string().optional(),
        authorization_details: z.string().optional(),
        ui_locales: z.string().optional(),
      }),
    },
    responses: { 200: html('The login page'), 400: json(OAuthError, 'Invalid request') },
  }),
  createRoute({
    method: 'post',
    path: '/mock/ansattporten/authorize',
    summary: `${devOnly}Submit the chosen test person and organisation`,
    request: {
      body: form(
        z.object({
          login: z.string(),
          pid: z.string(),
          step: z.string().optional(),
          org: z.union([z.string(), z.array(z.string())]).optional(),
        }),
      ),
    },
    responses: {
      200: html('The organisation picker'),
      302: { description: 'Back to the redirect URI with a code, or with an error' },
      400: {
        description: 'Unknown login or person (JSON), or an invalid choice (HTML)',
        content: {
          'application/json': { schema: OAuthError },
          'text/html': { schema: z.string() },
        },
      },
    },
  }),
  createRoute({
    method: 'post',
    path: '/mock/ansattporten/token',
    summary: `${devOnly}Exchange a code or refresh token for tokens`,
    request: {
      body: form(
        z.object({
          grant_type: z.enum(['authorization_code', 'refresh_token']),
          code: z.string().optional(),
          code_verifier: z.string().optional(),
          redirect_uri: z.string().optional(),
          refresh_token: z.string().optional(),
          client_id: z.string().optional(),
        }),
      ),
    },
    responses: {
      200: json(
        z.object({
          access_token: z.string(),
          id_token: z.string(),
          refresh_token: z.string(),
          token_type: z.literal('Bearer'),
          expires_in: z.number().int(),
          scope: z.string(),
        }),
        'Tokens',
      ),
      400: json(OAuthError, 'Invalid grant'),
      401: json(OAuthError, 'Invalid client'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/mock/ansattporten/userinfo',
    summary: `${devOnly}The signed-in test person`,
    responses: {
      200: json(
        z.object({
          sub: z.string(),
          pid: z.string(),
          locale: z.string(),
          name: z.string().optional(),
          given_name: z.string().optional(),
          family_name: z.string().optional(),
        }),
        'User info',
      ),
      401: json(OAuthError, 'Invalid token'),
    },
  }),
  createRoute({
    method: 'get',
    path: '/mock/ansattporten/logout',
    summary: `${devOnly}Sign out and go back to the client`,
    request: {
      query: z.object({
        client_id: z.string().optional(),
        id_token_hint: z.string().optional(),
        post_logout_redirect_uri: z.string().optional(),
        state: z.string().optional(),
        ui_locales: z.string().optional(),
      }),
    },
    responses: {
      200: html('Signed out'),
      302: { description: 'Back to the registered post-logout URI' },
    },
  }),
  createRoute({
    method: 'post',
    path: '/mock/altinn/authorization/api/v1/authorize',
    summary: `${devOnly}Mock Altinn PDP: decide an XACML JSON request from test data`,
    request: { body: body(z.record(z.string(), z.unknown())) },
    responses: {
      200: json(
        z.object({
          Response: z.array(
            z.object({
              Decision: z.enum(['Permit', 'Deny', 'NotApplicable', 'Indeterminate']),
              Status: z.object({ StatusCode: z.object({ Value: z.string() }) }),
            }),
          ),
        }),
        'Decision',
      ),
    },
  }),
  createRoute({
    method: 'post',
    path: '/mock/altinn/authorization/api/v1/decision',
    summary: `${devOnly}Mock Altinn PDP: same as authorize`,
    request: { body: body(z.record(z.string(), z.unknown())) },
    responses: {
      200: json(
        z.object({
          Response: z.array(
            z.object({
              Decision: z.enum(['Permit', 'Deny', 'NotApplicable', 'Indeterminate']),
              Status: z.object({ StatusCode: z.object({ Value: z.string() }) }),
            }),
          ),
        }),
        'Decision',
      ),
    },
  }),
];

type DocumentedApp = { openAPIRegistry?: { registerPath(route: RouteConfig): void } };

const register = (app: unknown, routes: RouteConfig[]) => {
  const registry = (app as DocumentedApp).openAPIRegistry;
  if (!registry) return;
  for (const route of routes) registry.registerPath(route);
};

export const documentAccessRoutes = (app: unknown) => register(app, accessRoutes);
export const documentMockRoutes = (app: unknown) => register(app, mockRoutes);
