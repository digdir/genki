import {
  type Catalogs,
  createRuntime,
  defaultPlatformTenant,
  InMemoryConfigEntryStore,
  strategyModelNeeds,
  allowOf,
  pinnedFetch,
  tracingEgress,
} from '@genai/composition';
import { inputFieldsSchema, type Principal, type Usage } from '@genai/contracts';
import { createA2aApp } from '@genai/adapter-a2a';
import { createMcpApp } from '@genai/adapter-mcp';
import { createRestAdapter, filterMapErrors } from '@genai/adapter-rest';
import {
  createOpenAiAdapter,
  datasetOf,
  type CapabilityResolver,
  type ModelEntry,
  type ServiceDataset,
} from '@genai/adapter-openai';
import {
  conversationRoutes,
  conversationTurns,
  InMemoryConversationStore,
  nanoId as conversationId,
  type ConversationStore,
} from '@genai/conversations';
import {
  flowInputProblems,
  flowTableProblems,
  flowUsesOf,
  platformSettings,
  SettingsRegistry,
  strategyKey,
  toCapabilities,
  validateDefinition,
  type CompiledCapability,
  type DefinitionStore,
  type PluginSchemas,
  type ServiceDefinition,
  type FlowFinder,
  type SkillFinder,
} from '@genai/definitions';
import {
  contractAssertions,
  evalRunStrategy,
  InMemoryCandidateStore,
  InMemoryEvalRunStore,
  InMemoryFeedbackStore,
  InMemoryLabelStore,
  InMemoryTestSetStore,
  publishGate,
  retrievalRecall,
  type CandidateStore,
  type EvalRunStore,
  type Evaluator,
  type FeedbackStore,
  type Gate,
  type LabelStore,
  type TestSetStore,
} from '@genai/eval';
import {
  InMemoryTraceDeliveries,
  type TraceDeliveryStore,
  type TriggerRunStore,
} from '@genai/jobs';
import { type BlobStore } from '@genai/port-blob';
import {
  createExperimentRouter,
  createTraceExporter,
  observedEventLog,
  traceIdFor,
} from '@genai/providers-langfuse';
import {
  deleteConversationDocuments,
  runtimeDocumentStore,
  runtimeDocumentTypes,
} from './runtime-documents.js';
import {
  EgressGuard,
  TenantSecrets,
  type AllowedHost,
  type ConnectionRegistry,
  type EgressOptions,
} from '@genai/providers-mcp-client';
import type { RegisteredAgent } from '@genai/strategy-remote';
import { checkFlow } from '@genai/strategy-step-flow';
import type { Admin } from './admin.js';
import {
  capabilityModes,
  configKeyAllows,
  confinedPolicy,
  grantsOf,
  InMemoryClients,
  isBoundToServices,
  keyGrantPolicy,
  keyReaches,
  keyReachesMode,
  type Authenticated,
  type ClientStore,
  type WebhookDeliveryStore,
} from '@genai/identity';
import {
  admitConfined,
  clientCors,
  frontendAdminHandlers,
  registerFrontendRoutes,
  type PlatformEndpoints,
} from './frontends.js';
import { createWebhooks, egressSender, type WebhookSender } from './webhooks.js';
import { createConfigurables, type ConfigurablesInput } from './configurables.js';
import { checkOverrides, serviceOverridesOf } from './settings-runtime.js';
import { requestLocale, t } from './i18n/index.js';
import {
  adminExtensions,
  mountExtensions,
  TenantDirectory,
  TenantSecretVault,
  trackTasks,
  type TaskIndex,
  type TenantDirectoryStore,
  type TenantSecretStore,
} from './extensions.js';
import type { DeclaredPhraseArchive, DocumentConverter } from '@genai/ingest';
import { datasetEnrichmentModule, enrichmentOutputTokens } from './dataset-enrichment.js';
import { publicDatasetState } from './dataset-status.js';
import { datasetUploadsModule } from './dataset-uploads.js';
import { type ApiLog } from './failure-log.js';
import {
  indexIngestionBackend,
  type IngestSourceOptions,
  type KudosAccess,
} from './index-ingestion.js';
import type { ExecutionStore } from './ingestion.js';
import { describeEngines } from './knowledge-engines.js';
import {
  InMemoryEventLog,
  InMemoryTaskStore,
  InMemoryThreadErasure,
  type Capability as KernelCapability,
  type EventLog,
  type Kernel,
  type PolicyDecisionPoint,
  type SecretResolver,
  type StateStore,
  type Strategy,
  type TaskStore,
  type ThreadErasure,
  type TokenProviders,
} from '@genai/kernel';
import { type EmbeddingAdapter } from '@genai/port-embedding';
import { kindsOf, KnowledgeRouter, type FieldFilter } from '@genai/port-knowledge';
import {
  residencies,
  residencyAllows,
  type Capability,
  type ModelClassificationStore,
  type Residency,
} from '@genai/port-model';
import { colbert } from '@genai/providers-colbert';
import { type PgvectorEngineOptions } from '@genai/providers-pgvector';
import { parquetReader } from '@genai/providers-parquet';
import { postgresRowReader } from '@genai/providers-postgres-source';
import {
  builderStrategyId,
  createBuilderAssistant,
  createOptimiser,
  optimiserStrategyId,
  platformServiceConfig,
} from '@genai/strategy-builder';
import type { Hono, Env, MiddlewareHandler, Schema } from 'hono';
import {
  consoleAdminExtensions,
  registerConsoleRoutes,
  type ConsoleDeps,
  type TraceStatus,
} from './routes/console-routes.js';
import {
  InMemoryTenantApiKeys,
  portalAdminHandlers,
  registerPortalRoutes,
  type KeyPolicyStore,
  type TenantApiKeys,
} from './routes/portal-routes.js';
import { tenantAccess } from './access.js';
import { actorNames } from './actor-names.js';
import { platformScope } from './config-store.js';
import { operationsOverview, type PipelineRuns } from './operations.js';
import { organizationLookup } from './organizations.js';
import { locationOf } from './residency.js';
import { retiredModelMessage, serviceHealth, type ServiceModels } from './service-health.js';
import { serviceDrafts } from './service-drafts.js';
import { serviceSchemaOf } from './service-schema.js';
import { problem } from './http.js';

import {
  defaultKeyCallsPerMinute,
  defaultTenantCallsPerMinute,
  SlidingWindowLimiter,
  clientAddress,
  keyRateLimited,
  publicCardsPerMinute,
  quotaExhausted,
  quotaExhaustedDetail,
  quotaExhaustedTitle,
  quotaExhaustedType,
  secondsToNextMonth,
  tooManyRequests,
  type RateLimiter,
} from './rate-limit.js';
import { trackedWork } from './tracked-work.js';
import { tenantGate } from './tenant-gate.js';
import { defaultMonthlyTokens, quotaSettingKey } from './playground.js';
import { evalCapabilityId, originOf } from './draft-runner.js';
import type { ChangeFeed } from './change-feed.js';
import {
  createDraftRunner,
  usageSummaryOf,
  type FieldOptionsLookup,
  type ModelPrice,
} from './draft-runner.js';
import { withFieldOptions, type FacetCount } from './input-options.js';
import {
  decorateWith,
  feedbackToModules,
  type ModuleDeps,
  type PlatformModule,
  type PlatformModuleFactory,
} from './platform-modules.js';
import { assistantModule } from './assistant.js';
import { blockUsageModule } from './block-usage.js';
import {
  buildingBlocksModule,
  createBuildingBlocksModule,
  withBlockSettings,
} from './building-blocks.js';
import { engineSwitchesModule } from './engine-switches.js';
import { definitionSubject } from './definition-subject.js';
import { runJudges } from './eval-judges.js';
import { knowledgeEndpointsModule } from './knowledge-endpoints.js';
import { playgroundModule } from './playground.js';
import { proposalsModule } from './proposals.js';
import { connectorsModule, privateNetworkRegistry } from './connectors.js';
import { modelDisplayNames, ownedElsewhere } from './model-access.js';
import { qualityModule } from './quality.js';
import { batchRunsModule } from './batch-run-routes.js';
import { projectsModule } from './project-routes.js';
import { resultReviewsModule } from './result-reviews.js';
import { userPreferencesModule } from './user-preferences.js';
import { projectTasks } from './project-usage.js';
import { governanceModule } from './governance.js';
import { serviceTemplateModule } from './service-template.js';
import {
  traceConnectionsModule,
  type TraceSinks,
  type TracingOptions,
} from './trace-connections.js';
import { recipesModule } from './recipes.js';
import { stepBlocksModule } from './step-blocks.js';
import { strategyCatalogueModule } from './strategy-catalogue.js';
import { definitionCompletionModule } from './definition-completion.js';
import { skillsModule } from './skills.js';
import { createKeyPoliciesModule } from './key-policies.js';
import { maskinportenClientsModule } from './maskinporten-clients.js';
import { triggersModule } from './triggers.js';
import { lifecycleOf, pausedMessage, serviceLifecycleModule } from './service-lifecycle.js';
import { onboardingModule } from './onboarding.js';
import { documentAccessRoutes } from './openapi/access.js';
import { modelChoice } from './model-choice.js';
import { modelMatrixModule, releaseGate } from './model-matrix.js';
import { operatorModelsModule } from './operator-models.js';
import { documentDatasetRoutes } from './openapi/datasets.js';
import { declaredSecrets, PluginRegistry } from '@genai/plugins';
import { anthropicPlugins } from '@genai/providers-anthropic/contract';
import { colbertPlugins } from '@genai/providers-colbert/contract';
import { a2aPlugins } from '@genai/providers-a2a-client/contract';
import { mcpPlugins } from '@genai/providers-mcp-client/contract';
import { openApiPlugins } from '@genai/providers-openapi-tools/contract';
import { typesensePlugins } from '@genai/providers-typesense/plugin';
import { openAiPlugins } from '@genai/providers-openai/contract';
import { hooksModule, type HookSender } from './hooks.js';
import { createDiagnosticsModule, diagnosticsModule } from './diagnostics.js';
import { builtinPlugins, configContractRuns, pluginsModule } from './plugins.js';
import { pluginUsage } from './plugin-usage.js';
import {
  externalProtocols,
  externalTarget,
  judgeSender,
  pluginCatalogEntries,
  pluginEndpointHosts,
} from './external-plugins.js';
import { httpJudge } from './plugin-contracts.js';
import { taskExportModule } from './task-export.js';
import { frontendOpenApiModule } from './frontend-openapi.js';
import { servicesOpenApiModule } from './openapi/services.js';
import { workOpenApiModule } from './openapi/work.js';
import { schemasModule } from './schemas.js';
import {
  mayUseModels,
  readOnlyInLockdown,
  withCredentialOrigin,
  type Lockdown,
} from './lockdown.js';

export const platformModules: PlatformModuleFactory[] = [
  buildingBlocksModule,
  blockUsageModule,
  skillsModule,
  playgroundModule,
  engineSwitchesModule,
  knowledgeEndpointsModule,
  assistantModule,
  proposalsModule,
  connectorsModule,
  governanceModule,
  serviceTemplateModule,
  stepBlocksModule,
  recipesModule,
  traceConnectionsModule,
  strategyCatalogueModule,
  definitionCompletionModule,
  datasetUploadsModule,
  datasetEnrichmentModule,
  qualityModule,
  batchRunsModule,
  projectsModule,
  resultReviewsModule,
  userPreferencesModule,
  onboardingModule,
  maskinportenClientsModule,
  triggersModule,
  serviceLifecycleModule,
  operatorModelsModule,
  modelMatrixModule,
  hooksModule,
  pluginsModule,
  diagnosticsModule,
  taskExportModule,
  schemasModule,
  frontendOpenApiModule,
  servicesOpenApiModule,
  workOpenApiModule,
];

export { defaultServiceLimits, type QuarantinedDefinition } from '@genai/composition';
export type { Catalogs };

export const serviceRequirement = (resource: string) => ({
  resource,
  action: 'use-services',
  scope: 'legacy:query',
});

export interface Caller {
  principal: Principal;
  externalUsers?: boolean;
  key?: { id: string; callsPerMinute?: number };
}

export const callerFrom = (found: Authenticated, operator = false): Caller => ({
  principal: operator ? { ...found.principal, kind: 'operator' } : found.principal,
  ...(found.method === 'api-key' && found.principal.confinedTo ? { externalUsers: true } : {}),
  ...(found.grants
    ? {
        key: {
          id: found.grants.keyId,
          ...(found.grants.callsPerMinute ? { callsPerMinute: found.grants.callsPerMinute } : {}),
        },
      }
    : {}),
});

export const platformCaller =
  (
    authenticator: { authenticate(request: Request): Promise<Authenticated | undefined> },
    options: {
      isOperator: (principal: Principal) => boolean;
      admit?: (principal: Principal) => Promise<Principal>;
    },
  ) =>
  async (request: Request): Promise<Caller | undefined> => {
    const found = await authenticator.authenticate(request);
    if (!found) return undefined;
    const principal = options.admit ? await options.admit(found.principal) : found.principal;
    return callerFrom(
      { ...found, principal },
      found.method === 'token' && options.isOperator(found.principal),
    );
  };

export const tenantCallsPerMinuteSetting = 'usage.tenantCallsPerMinute';
export interface PlatformInput {
  catalogs: Catalogs;
  secrets: SecretResolver;
  tokenProviders?: TokenProviders;
  definitions: (
    plugins: PluginSchemas,
    sharedSkill?: SkillFinder,
    sharedFlow?: FlowFinder,
  ) => DefinitionStore;
  policy: PolicyDecisionPoint;
  authenticate(request: Request): Promise<Caller | undefined>;
  log?: EventLog;
  tasks?: TaskStore;
  state?: StateStore;
  conversations?: ConversationStore;
  threadErasure?: ThreadErasure;
  modelClassifications?: ModelClassificationStore;
  onWarning?: (message: string) => void;
  observe?: (log: EventLog) => EventLog;
  blobStore?: BlobStore;
  egress?: EgressOptions;
  catalogSkips?: string[];
  evaluators?: Map<string, Evaluator>;
  gates?: Map<string, Gate>;
  platformTenant?: string;
  /** The platform's version (APP_VERSION), recorded as the commit of eval runs it starts. */
  appVersion?: string;
  /** Tenants' Langfuse connections: Digdir's instance and whether it may receive content. */
  tracing?: TracingOptions;
  /** Every trace sent to a tenant's sink, until its delete is confirmed. */
  traceDeliveries?: TraceDeliveryStore;
  tenantDirectory?: TenantDirectoryStore;
  taskIndex?: TaskIndex;
  ingestionExecutions?: ExecutionStore;
  apiKeys?: TenantApiKeys;
  keyPolicies?: KeyPolicyStore;
  prices?: Record<string, ModelPrice>;
  traces?: () => TraceStatus | undefined;
  databasePing?: () => Promise<unknown>;
  organizationRegistry?: { url: string; fetch?: typeof fetch };
  serviceRequirement?: (tenant: string, service: string) => ServiceRequirementShape;
  clients?: ClientStore;
  reservedClientIds?: string[];
  webhookDeliveries?: WebhookDeliveryStore;
  triggerRuns?: TriggerRunStore;
  webhookSend?: WebhookSender;
  webhookEgress?: EgressOptions;
  endpoints?: PlatformEndpoints;
  settings?: SettingsRegistry;
  tenantSecrets?: TenantSecretStore;
  connections?: ConnectionRegistry;
  evalStores?: {
    testSets: TestSetStore;
    runs: EvalRunStore;
    feedback: FeedbackStore;
    candidates: CandidateStore;
  };
  labels?: LabelStore;
  configurables?: ConfigurablesInput;
  knowledgePool?: PgvectorEngineOptions['pool'];
  embeddingAdapters?: EmbeddingAdapter[];
  searchOnlyClusters?: (string | undefined)[];
  ingestFolderRoot?: string;
  ingestWorkingDirectory?: string;
  ingestParquetMaxBytes?: number;
  changes?: ChangeFeed;
  modules?: PlatformModuleFactory[];
  hookSender?: HookSender;
  verifyPluginsOnBoot?: boolean;
  rateLimits?: { limiter?: RateLimiter };
  serviceLimits?: { deadlineMs?: number; budget?: Usage };
  logger?: ApiLog;
  logFailureMessages?: boolean;
  documentConverter?: DocumentConverter;
  kudos?: KudosAccess;
  phraseArchive?: DeclaredPhraseArchive;
  lockdown?: Lockdown;
}

interface ServiceRequirementShape {
  resource: string;
  action: string;
  scope?: string;
}

export const defaultGates = new Map<string, Gate>([
  [
    'klarsprak-overall',
    {
      id: 'klarsprak-overall',
      metric: 'klarsprak.overall',
      kind: 'threshold',
      threshold: 0.6,
      maxRegression: 0,
      perTag: false,
      split: 'validation',
    } as Gate,
  ],
  [
    'nynorsk-chrf',
    {
      id: 'nynorsk-chrf',
      metric: 'nynorsk.chrf',
      kind: 'threshold',
      threshold: 0.5,
      maxRegression: 0,
      perTag: false,
      split: 'validation',
    } as Gate,
  ],
  [
    'recall-at-10',
    {
      id: 'recall-at-10',
      metric: 'recall@10',
      kind: 'no-regression',
      maxRegression: 0.05,
      perTag: false,
      split: 'validation',
    } as Gate,
  ],
  [
    'no-tag-regression',
    {
      id: 'no-tag-regression',
      metric: 'answer-pattern',
      kind: 'no-regression',
      maxRegression: 0.05,
      perTag: true,
      split: 'validation',
    } as Gate,
  ],
]);

export { definitionSubject } from './definition-subject.js';

const retrievalInput = {
  type: 'object',
  properties: {
    'user-query': { type: 'string', minLength: 1 },
    claim: { type: 'string' },
    'conversation-history': { type: 'array', items: { type: 'object' } },
    model: { type: 'string' },
    temperature: { type: 'number' },
  },
  required: ['user-query'],
};

export const strategyInputSchemas = new Map<string, Record<string, unknown>>([
  [strategyKey('agent-loop', 1), retrievalInput],
  [strategyKey('rag-single-shot', 1), retrievalInput],
]);

const entryOf = (compiled: CompiledCapability, name: string): ModelEntry => {
  const d = compiled.capability.descriptor;
  const strategy = compiled.capability.strategy;
  const fields = d.inputFields?.length ? { inputFields: d.inputFields } : {};
  const inputSchema = fields.inputFields
    ? d.input
    : (strategyInputSchemas.get(strategyKey(strategy.id, Number(strategy.version))) ?? d.input);
  const base = { id: name, capability: d.id, inputSchema, ...fields };
  const service = compiled.serviceName ?? compiled.service.id;
  const labels = compiled.variantTitle &&
    compiled.variant !== 'default' && {
      nb: `${service} (${compiled.variantTitle.nb})`,
      en: `${service} (${compiled.variantTitle.en})`,
    };
  return {
    ...base,
    title: labels ? labels[requestLocale()] : d.title,
    ...(labels ? { labels } : {}),
    description: d.description,
    agentId: compiled.service.id,
    mode: compiled.variant,
    serviceTitle: service,
    variantTitle: variantDisplayName(compiled),
    ...(name === compiled.publicName ? {} : { aliasOf: compiled.publicName }),
    ...(compiled.chat === false ? { chat: false } : {}),
  };
};

export interface ResolverHooks {
  pin?(compiled: CompiledCapability, version: number): Promise<CompiledCapability | undefined>;
  fieldOptions?: FieldOptionsLookup;
  paused?(compiled: CompiledCapability): boolean | Promise<boolean>;
  pauseReason?(compiled: CompiledCapability): string | undefined | Promise<string | undefined>;
  pausedByTenant?(compiled: CompiledCapability): Promise<string | undefined>;
  archived?(compiled: CompiledCapability): Promise<boolean>;
  datasets?(compiled: CompiledCapability): string[];
  searches?(principal: Principal, compiled: CompiledCapability): ServiceDataset[];
  chat?(compiled: CompiledCapability): Promise<boolean>;
  batch?(compiled: CompiledCapability): Promise<boolean>;
  documents?(compiled: CompiledCapability): Promise<string[]>;
}

const humanized = (id: string) => {
  const words = id.replace(/[-_]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : id;
};

export const variantDisplayName = (c: CompiledCapability) => {
  if (c.variantTitle) return c.variantTitle[requestLocale()];
  if (c.variant === 'retrieve-only') return t('services.variantRetrieveOnly');
  if (c.variant !== 'default') return humanized(c.variant);
  const output = (c.capability.config as { output?: { kind?: string; withSources?: boolean } })
    ?.output;
  return output?.kind === 'answer' && output.withSources
    ? t('services.variantAnswer')
    : t('services.variantDefault');
};

const agentOf = (name: string) =>
  name.includes('__') ? name.slice(0, name.indexOf('__')) : undefined;

export const capabilityResolver = (
  store: DefinitionStore,
  kernel: Kernel,
  hooks: ResolverHooks = {},
): CapabilityResolver => {
  const visible = async (principal: Principal) => {
    const allowed = new Set((await kernel.describe(principal)).map((d) => d.id));
    const caps = (await store.capabilities()).filter((c) =>
      allowed.has(c.capability.descriptor.id),
    );
    const archived = await Promise.all(caps.map((c) => hooks.archived?.(c) ?? false));
    return caps.filter((_, i) => !archived[i]);
  };
  const withOptions = async (
    principal: Principal,
    compiled: CompiledCapability,
    entry: ModelEntry,
  ): Promise<ModelEntry> => {
    const documents = (await hooks.documents?.(compiled)) ?? [];
    if (documents.length) entry = { ...entry, documents };
    const searches = hooks.searches?.(principal, compiled) ?? [];
    if (searches.length) entry = { ...entry, searches };
    const fields = entry.inputFields;
    if (!fields?.some((f) => f.optionsFrom) || !hooks.fieldOptions) return entry;
    const lookup = hooks.fieldOptions;
    const resolved = await withFieldOptions(fields, (from) =>
      lookup(principal, compiled.service.tenant, from),
    );
    return { ...entry, inputFields: resolved, inputSchema: inputFieldsSchema(resolved) };
  };
  return {
    list: async (principal) => {
      const caps = await visible(principal);
      if (isBoundToServices(principal)) {
        const seen = new Set<string>();
        const ordered = caps.map((c) => {
          const key = `${c.service.tenant}/${c.service.id}`;
          const first = !seen.has(key);
          seen.add(key);
          return { c, first };
        });
        const entries = await Promise.all(
          ordered.map(async ({ c, first }) => {
            const reason = (await hooks.paused?.(c))
              ? ((await hooks.pauseReason?.(c)) ?? retiredModelMessage)
              : undefined;
            const status = reason ? { status: 'paused' as const, statusReason: reason } : {};
            const inChat = (await hooks.chat?.(c)) === true;
            const chat = first && inChat;
            const pickable = !reason && inChat && c.chat !== false;
            const own = {
              title: variantDisplayName(c),
              description: c.capability.descriptor.description,
              ...status,
            };
            const primary = await withOptions(principal, c, {
              ...entryOf(c, c.publicName),
              ...own,
              ...(chat ? { title: c.capability.descriptor.title, chat: true } : {}),
              ...(first ? { default: true } : {}),
              ...(pickable ? { pickable } : {}),
            });
            const aliases = await Promise.all(
              c.aliases.map((name) =>
                withOptions(principal, c, {
                  ...entryOf(c, name),
                  ...own,
                  default: false,
                }),
              ),
            );
            return { primary, aliases };
          }),
        );
        return [...entries.map((e) => e.primary), ...entries.flatMap((e) => e.aliases)];
      }
      const firstVariant = new Set(
        caps
          .filter(
            (c, i) =>
              caps.findIndex(
                (o) => o.service.tenant === c.service.tenant && o.service.id === c.service.id,
              ) === i,
          )
          .map((c) => c.capability.descriptor.id),
      );
      return (
        await Promise.all(
          caps.map(async (c) => {
            const reason = (await hooks.paused?.(c))
              ? ((await hooks.pauseReason?.(c)) ?? retiredModelMessage)
              : undefined;
            const status = reason ? { status: 'paused' as const, statusReason: reason } : {};
            const inChat = (await hooks.chat?.(c)) === true;
            const chat = firstVariant.has(c.capability.descriptor.id) && inChat;
            const batch = chat && (await hooks.batch?.(c)) === true;
            const pickable = !reason && inChat && c.chat !== false;
            return Promise.all(
              [c.publicName, ...c.aliases].map((name) =>
                withOptions(principal, c, {
                  ...entryOf(c, name),
                  ...status,
                  ...(firstVariant.has(c.capability.descriptor.id) && name === c.publicName
                    ? { default: true }
                    : {}),
                  ...(chat && name === c.publicName ? { chat: true } : {}),
                  ...(batch && name === c.publicName ? { batch: true } : {}),
                  ...(pickable && name === c.publicName ? { pickable } : {}),
                }),
              ),
            );
          }),
        )
      ).flat();
    },
    resolve: async (principal, name, options = {}) => {
      const found = await store.resolve(name);
      const compiled = found && !(await hooks.archived?.(found)) ? found : undefined;
      if (!compiled) {
        const agent = name.includes('__')
          ? name.slice(0, name.indexOf('__')).replace(/\./g, '/')
          : undefined;
        return agent
          ? { ok: false, code: 'agent_not_found', message: `Agent not found: ${agent}` }
          : { ok: false, code: 'model_not_found', message: `Model not found: ${name}` };
      }
      const reachable = await visible(principal);
      const allowed = reachable.some(
        (c) => c.capability.descriptor.id === compiled.capability.descriptor.id,
      );
      const agent = agentOf(name);
      if (!allowed && isBoundToServices(principal))
        return {
          ok: false,
          code: 'agent_not_authorized',
          message: t('services.boundOutside', {
            service: [...new Set(reachable.map((c) => c.service.id))].join(', '),
            name,
          }),
        };
      if (!allowed)
        return (agent &&
          reachable.some((c) => [c.publicName, ...c.aliases].some((n) => agentOf(n) === agent))) ||
          !keyReachesMode(principal, capabilityModes(compiled.capability.descriptor.id, [name]))
          ? { ok: false, code: 'mode_not_authorized', message: `API key cannot use mode: ${name}` }
          : { ok: false, code: 'agent_not_authorized', message: `not authorized for ${name}` };
      const wanted = options.version;
      const chosen =
        wanted === undefined || wanted === compiled.service.version
          ? compiled
          : await hooks.pin?.(compiled, wanted);
      if (!chosen)
        return {
          ok: false,
          code: 'version_not_found',
          message: `Tjenesten ${compiled.service.id} har ingen publisert versjon ${wanted}.`,
        };
      if (await hooks.paused?.(chosen))
        return {
          ok: false,
          code: 'service_paused',
          message: (await hooks.pausedByTenant?.(chosen)) ?? retiredModelMessage,
        };
      return {
        ok: true,
        entry: await withOptions(principal, chosen, {
          ...entryOf(chosen, name),
          version: chosen.service.version,
          ...(hooks.datasets ? { datasets: hooks.datasets(chosen) } : {}),
        }),
      };
    },
  };
};

type OptionCache = Map<string, { at: number; options: FacetCount[] }>;

const facetOptions = async (
  knowledge: KnowledgeRouter,
  cache: OptionCache,
  principal: Principal,
  tenant: string,
  from: { dataset: string; facet: string },
) => {
  const key = `${tenant}|${from.dataset}|${from.facet}`;
  const cached = cache.get(key);
  if (cached && Date.now() - cached.at < 5 * 60_000) return cached.options;
  const port = knowledge.open(
    { kind: 'dataset', id: from.dataset, tenant },
    {
      tenant,
      principal,
      task: `input-options-${crypto.randomUUID()}`,
      signal: AbortSignal.timeout(5_000),
      meter: async () => undefined,
    },
  );
  const options = ((await port.facets([from.facet]))[from.facet] ?? []).map((v) => ({
    value: String(v.value),
    count: v.count,
  }));
  cache.set(key, { at: Date.now(), options });
  return options;
};

const datasetFilters = (
  knowledge: KnowledgeRouter,
  principal: Principal,
  id: string,
): Record<string, FieldFilter> | undefined => {
  try {
    return knowledge
      .open(
        { kind: 'dataset', id, tenant: principal.tenant ?? '' },
        {
          tenant: principal.tenant ?? '',
          principal,
          task: `ask-filters-${crypto.randomUUID()}`,
          signal: AbortSignal.timeout(5_000),
          meter: async () => undefined,
        },
      )
      .info().filters;
  } catch {
    return undefined;
  }
};

const declaredFilterFields = (
  knowledge: KnowledgeRouter,
  principal: Principal,
  datasets: string[],
): Set<string> | undefined => {
  const ids = [...new Set(datasets.map((d) => knowledge.resolve(d) ?? d))];
  const fields = new Set<string>();
  for (const id of ids) {
    const filters = datasetFilters(knowledge, principal, id);
    if (!filters) return undefined;
    for (const field of Object.keys(filters)) fields.add(field);
  }
  return fields;
};

export const serviceDatasets = (
  knowledge: KnowledgeRouter,
  principal: Principal,
  compiled: CompiledCapability,
): ServiceDataset[] => {
  const known = knowledge.datasets();
  const ids = new Set(
    compiled.capability.grants.flatMap((g) =>
      g.port === 'knowledge' ? [knowledge.resolve(g.ref.id) ?? g.ref.id] : [],
    ),
  );
  return [...ids].flatMap((id) => {
    const filters = known.has(id) ? datasetFilters(knowledge, principal, id) : undefined;
    if (!filters) return [];
    const slash = id.lastIndexOf('/');
    const key = id.slice(slash + 1);
    const valueTypes = known.get(id)?.valueTypes ?? {};
    return [
      {
        id: key,
        tenant: slash > 0 ? id.slice(0, slash) : compiled.service.tenant,
        datasetConfigKey: key,
        filters: Object.entries(filters).map(([field, kind]) => ({
          field,
          kinds: kindsOf(kind),
          valueType: valueTypes[field] ?? 'string',
        })),
      },
    ];
  });
};

export const askFilterIssues = (
  knowledge: KnowledgeRouter,
  principal: Principal,
  entry: ModelEntry,
  filters: unknown,
) => {
  const shape = filterMapErrors(filters);
  if (shape.length > 0) return shape.map((message) => ({ path: 'filters', message }));
  const declared = declaredFilterFields(knowledge, principal, entry.datasets ?? []);
  if (!declared) return [];
  if (declared.size === 0) return [{ path: 'filters', message: t('adapterErrors.noFilterFields') }];
  return (filters as { fields: { field: string }[] }).fields.flatMap((spec, i) =>
    declared.has(spec.field)
      ? []
      : [
          {
            path: `filters.fields[${i}].field`,
            message: t('adapterErrors.unknownFilterField', {
              field: spec.field,
              declared: [...declared].sort().join(', '),
            }),
          },
        ],
  );
};

export const createPlatform = async (input: PlatformInput) => {
  const platformTenant = input.platformTenant ?? defaultPlatformTenant;
  const configEntries = input.configurables?.store ?? new InMemoryConfigEntryStore();
  const vault = new TenantSecretVault(input.tenantSecrets);
  const tenantSecrets = new TenantSecrets(vault.resolver(input.secrets));
  const experiments = createExperimentRouter();
  const sinkEgress = tracingEgress(input.egress ?? {}, input.tracing?.devMode);
  const traceDeliveries = input.traceDeliveries ?? new InMemoryTraceDeliveries();
  const traceSinks: TraceSinks = {
    traceIdOf: (task) => traceIdFor(task),
    open: (run, tenant, connection, beforeSend) =>
      experiments.open(
        run,
        createTraceExporter(
          {
            endpoint: new URL('/api/public/otel', connection.host).toString(),
            auth: {
              kind: 'langfuse',
              publicKey: connection.publicKey,
              secretKey: 'secret://sink/key',
            },
          },
          {
            secrets: {
              resolve: () =>
                tenantSecrets.resolveFor(tenant, connection.secretKey, [connection.host]),
            },
            tasks: async (id) => (await taskStore.get(id))?.task,
            fetch: pinnedFetch(sinkEgress, allowOf(connection.host)),
            serviceName: 'genai-eval',
            ...(beforeSend ? { beforeSend } : {}),
            experiments: true,
          },
        ),
        tenant,
      ),
    close: (run) => experiments.close(run),
  };
  const settings = input.settings ?? new SettingsRegistry(platformSettings);
  const overridePolicy = {
    check: async (
      principal: Principal,
      overrides?: Record<string, unknown>,
      target?: { capability: string; entryPoint: string },
    ) => {
      const compiled = target
        ? (await definitions.capabilities()).find(
            (c) => c.capability.descriptor.id === target.capability,
          )
        : undefined;
      return checkOverrides(
        settings,
        principal,
        overrides,
        serviceOverridesOf(compiled?.capability.config, target?.entryPoint),
      );
    },
  };
  const taskStore = input.tasks ?? new InMemoryTaskStore();
  const clients = input.clients ?? new InMemoryClients();
  const webhooks = createWebhooks({
    clients,
    secrets: vault.resolver(input.secrets),
    send: input.webhookSend ?? egressSender(input.webhookEgress ?? input.egress ?? {}),
    ...(input.webhookDeliveries ? { deliveries: input.webhookDeliveries } : {}),
  });
  const eventLog = input.log ?? new InMemoryEventLog();
  const threadErasure =
    input.threadErasure ??
    (eventLog instanceof InMemoryEventLog && taskStore instanceof InMemoryTaskStore
      ? new InMemoryThreadErasure(eventLog, taskStore)
      : undefined);
  const tracker = trackTasks(webhooks.observe(eventLog, taskStore));
  const taskIndex = input.taskIndex ?? tracker;
  const baseEvalStores = input.evalStores ?? {
    testSets: new InMemoryTestSetStore(),
    runs: new InMemoryEvalRunStore(),
    feedback: new InMemoryFeedbackStore(),
    candidates: new InMemoryCandidateStore(),
  };
  const evalStores = {
    ...baseEvalStores,
    feedback: feedbackToModules(
      webhooks.feedback(baseEvalStores.feedback, taskStore),
      taskStore,
      () => modules,
    ),
  };
  const prices: Record<string, ModelPrice> = { ...(input.prices ?? {}) };
  const evaluators =
    input.evaluators ??
    new Map<string, Evaluator>([
      ['contract', contractAssertions()],
      ['retrieval', retrievalRecall(10)],
    ]);
  const evalCapability: KernelCapability = {
    descriptor: {
      id: evalCapabilityId,
      version: '1',
      tenant: platformTenant,
      availableTo: '*',
      title: 'Evaluering',
      description: 'Kjører et testsett mot en tjeneste',
      input: {},
      interaction: ['unary'],
      accepts: ['application/json'],
      produces: ['application/json'],
      emits: [],
      oversight: { interrupts: false, riskClass: 'minimal', aiDisclosure: '' },
    },
    strategy: { id: 'platform.eval.run', version: '1' },
    config: {},
    grants: [],
  };
  const enrichmentWork = trackedWork({
    id: 'platform/dataset-enrichment',
    title: 'Berikelse av datasett',
    platformTenant,
    outputTokens: enrichmentOutputTokens,
  });
  let modules: PlatformModule[] = [];
  const decorate = decorateWith(() => modules);
  const sharedTools = new Map<string, string>();
  const agentPlugins = new Map<string, RegisteredAgent>();
  const pluginHosts = new Map<string, AllowedHost[]>();
  const pluginEgress = new EgressGuard(input.egress ?? {});

  const runtime = await createRuntime({
    platformTenant,
    catalogs: input.catalogs,
    secrets: input.secrets,
    vault,
    configEntries,
    settings,
    definitions: input.definitions,
    policy: ({ namesOf, catalog }) =>
      releaseGate(keyGrantPolicy(confinedPolicy(input.policy), namesOf), catalog),
    ...(input.lockdown ? { admitsModelUse: mayUseModels } : {}),
    log: tracker.log,
    tasks: taskStore,
    prices,
    decorate: (capability, context) => decorate(capability, context),
    wrapStrategy: (strategy) => withBlockSettings(configEntries, strategy),
    extraStrategies: ({ knowledge, plugins, kernel }) => [
      evalRunStrategy({
        kernel,
        evaluators,
        forRun: runJudges(() => modelChoice(moduleDeps)),
        modelFamily: (model) => modelChoice(moduleDeps).familyOf(model),
        meterAnswers: (events) => usageSummaryOf(events, prices),
        admit: async (tenant) => !(await quota(tenant, { fresh: true })).exhausted,
      }) as Strategy,
      createBuilderAssistant({ plugins, knowledge }) as Strategy,
      createOptimiser() as Strategy,
      enrichmentWork.strategy,
    ],
    extraStrategyConfigs: [builderStrategyId, optimiserStrategyId].map((id) => [
      strategyKey(id, 1),
      platformServiceConfig,
    ]),
    platformCapabilities: [evalCapability, enrichmentWork.capability],
    ...(input.state ? { state: input.state } : {}),
    observe: (log: EventLog) =>
      observedEventLog(input.observe ? input.observe(log) : log, experiments),
    ...(input.tokenProviders ? { tokenProviders: input.tokenProviders } : {}),
    ...(input.egress ? { egress: input.egress } : {}),
    ...(input.blobStore ? { blobStore: input.blobStore } : {}),
    ...(input.connections ? { connections: input.connections } : {}),
    ...(input.modelClassifications ? { modelClassifications: input.modelClassifications } : {}),
    ...(input.knowledgePool ? { knowledgePool: input.knowledgePool } : {}),
    ...(input.embeddingAdapters ? { embeddingAdapters: input.embeddingAdapters } : {}),
    ...(input.searchOnlyClusters ? { searchOnlyClusters: input.searchOnlyClusters } : {}),
    ...(input.configurables?.catalogPolicy
      ? { catalogPolicy: input.configurables.catalogPolicy }
      : {}),
    ...(input.configurables?.ruleSeed ? { ruleSeed: input.configurables.ruleSeed } : {}),
    ...(input.configurables?.now ? { now: input.configurables.now } : {}),
    ...(input.hookSender ? { hookSender: input.hookSender } : {}),
    ...(input.serviceLimits ? { serviceLimits: input.serviceLimits } : {}),
    ...(input.onWarning ? { onWarning: input.onWarning } : {}),
    ...(input.logger ? { logger: input.logger } : {}),
    ...(input.logFailureMessages ? { logFailureMessages: input.logFailureMessages } : {}),
    derivedCatalog: (entries) => {
      pluginHosts.clear();
      for (const [id, allow] of pluginEndpointHosts(entries)) pluginHosts.set(id, allow);
      return pluginCatalogEntries(entries);
    },
    agents: (id) => agentPlugins.get(id),
    endpointFetch: (endpoint) => {
      const allow = pluginHosts.get(endpoint);
      return allow ? pluginEgress.fetch(allow) : undefined;
    },
    sharedTools: (connection) => sharedTools.get(connection),
  });
  const {
    models,
    knowledge,
    rerank,
    embedders,
    writers,
    mcp,
    connections,
    blocks,
    plugins,
    store,
    registry,
    kernel,
    log,
    hookRuntime,
    catalogSecrets,
    modelAdapters,
    knowledgeAdapters,
    writerAdapters,
    embeddingModels,
    defaultEmbedding,
    embeddingResidency,
    residencyOf,
    limited,
    refreshTools,
    sync,
    blobStore,
  } = runtime;
  const configurables = createConfigurables({
    ...input.configurables,
    ...(input.lockdown ? { admitsIngestion: mayUseModels } : {}),
    ...(input.onWarning ? { onWarning: input.onWarning } : {}),
    store: configEntries,
    rules: runtime.rules,
    ...(input.ingestionExecutions ? { executions: input.ingestionExecutions } : {}),
    builtinGates: new Map([...defaultGates, ...(input.gates ?? [])]),
    platformTenant,
  });
  const databaseGuard = new EgressGuard(input.egress ?? {});
  const ingestSources: IngestSourceOptions = {
    uploads: blobStore,
    phrases: {
      ...(blobStore ? { blobs: blobStore } : {}),
      ...(input.phraseArchive ? { archive: input.phraseArchive } : {}),
    },
    ...(input.ingestFolderRoot ? { folderRoot: input.ingestFolderRoot } : {}),
    ...(input.documentConverter ? { converter: input.documentConverter } : {}),
    ...(input.kudos ? { kudos: input.kudos } : {}),
    parquet: {
      reader: parquetReader(),
      ...(input.ingestWorkingDirectory ? { workingDirectory: input.ingestWorkingDirectory } : {}),
      ...(input.ingestParquetMaxBytes ? { maxBytes: input.ingestParquetMaxBytes } : {}),
    },
    database: {
      reader: postgresRowReader({
        resolveHost: (host, allowed) => databaseGuard.address(host, allowed),
      }),
      secrets: vault.resolver(input.secrets),
      privateNetworks: async (tenant) =>
        (await privateNetworkRegistry(configurables.store).get(tenant)).entries,
      network: (host, allowed) => databaseGuard.network(host, allowed),
    },
  };

  const config = await configurables.attach({
    catalog: runtime.catalog,
    routers: { knowledge, writers },
    engines: () => describeEngines(knowledgeAdapters, writerAdapters),
    ingestion: indexIngestionBackend({
      writers,
      residencyOf,
      embedders: {
        has: (model) => embeddingModels.has(model),
        open: (...args) => embedders.open(...args),
      },
      models,
      catalog: runtime.catalog,
      platformTenant,
      ...ingestSources,
    }),
    adapters: { knowledge: knowledgeAdapters },
    embeddingResidency,
    testSets: evalStores.testSets,
  });
  const locationDeps = {
    catalog: config.catalog,
    engines: () => describeEngines(knowledgeAdapters, writerAdapters),
    embeddingResidency,
  };
  plugins.datasetLocation = (dataset) => {
    const item = config.catalog.get('dataset', knowledge.resolve(dataset) ?? dataset);
    return item ? locationOf(locationDeps, item) : undefined;
  };
  plugins.traceSink = () => {
    const traces = input.traces?.();
    return traces
      ? { residency: traces.residency ?? 'global', content: traces.content }
      : undefined;
  };

  const checkBeforePublish = async (definition: unknown, publisher: string) => {
    const validated = validateDefinition(definition, plugins);
    if (!validated.ok) return undefined;
    const d = validated.definition;
    for (const module of modules) {
      const problems = (await module.checkPublish?.(d, publisher)) ?? [];
      if (problems.length > 0) return problems;
    }
    if (d.kind === 'StepFlow') {
      const problems = checkFlow(d, blocks);
      return problems.length > 0 ? problems : undefined;
    }
    if (d.kind === 'Service')
      for (const flowRef of new Set(flowUsesOf(d.spec).map((u) => u.flow))) {
        const at = flowRef.lastIndexOf('@');
        const id = flowRef.slice(0, at);
        const version = Number(flowRef.slice(at + 1));
        const flow =
          (await store.get('StepFlow', d.metadata.tenant, id, version))?.definition ??
          (await runtime.sharedRecipe(d.metadata.tenant, id, version));
        const problems =
          flow?.kind === 'StepFlow'
            ? [...flowInputProblems(d, flow, flowRef), ...flowTableProblems(d, flow, flowRef)]
            : [];
        if (problems.length > 0) return problems;
      }
    const configProblems = await config.publishProblems(d);
    if (configProblems.length > 0) return configProblems;
    const evaluation = (d.spec as { evaluation?: { testSets?: string[]; gates?: string[] } })
      .evaluation;
    const { registry: gates, gates: listed } = await configurables.gatesFor(
      d.metadata.tenant,
      evaluation?.gates ?? [],
      evaluation?.testSets ?? [],
    );
    if (listed.length === 0) return undefined;
    const unknown = listed.filter((g) => !gates.has(g));
    if (unknown.length > 0)
      return unknown.map((g) => ({ path: 'spec.evaluation.gates', message: `unknown gate ${g}` }));
    const current = await store.get('Service', d.metadata.tenant, d.metadata.id);
    if (!current) return undefined;
    const candidate = definitionSubject(d.spec);
    const decision = await publishGate({
      tenant: d.metadata.tenant,
      service: d.metadata.id,
      candidate,
      ...(current
        ? { baseline: definitionSubject((current.definition as { spec: unknown }).spec) }
        : {}),
      evaluation: { testSets: evaluation?.testSets ?? [], gates: listed },
      runs: evalStores.runs,
      registry: gates,
    });
    if (decision.allow) return undefined;
    return [
      {
        path: 'spec.evaluation',
        message: `refused by evaluation gates (${decision.refused.join(', ')}); run the test sets with subject ${candidate} first`,
      },
    ];
  };

  const definitions: DefinitionStore = {
    get: (...args) => store.get(...args),
    versions: (...args) => store.versions(...args),
    list: (...args) => store.list(...args),
    resolve: (...args) => store.resolve(...args),
    capabilities: () => store.capabilities(),
    publish: async (...args) => {
      const problems = await checkBeforePublish(args[0], args[1]);
      if (problems) return { ok: false, errors: problems };
      const result = await store.publish(...args);
      if (result.ok) await sync();
      return result;
    },
  };

  const pin = async (compiled: CompiledCapability, version: number) => {
    const found = await store.get('Service', compiled.service.tenant, compiled.service.id, version);
    if (!found || found.version !== version || found.definition.kind !== 'Service')
      return undefined;
    const variant = toCapabilities(found.definition, found.version, found.files).find(
      (c) => c.variant === compiled.variant,
    );
    if (!variant) return undefined;
    const id = `${variant.capability.descriptor.id}@${version}`;
    const pinned: CompiledCapability = {
      ...variant,
      capability: {
        ...variant.capability,
        descriptor: { ...variant.capability.descriptor, id },
      },
    };
    if (!registry.all().some((c) => c.descriptor.id === id)) {
      const decorated = limited(
        await decorate(pinned.capability, {
          compiled: pinned,
          definition: found.definition,
          origin: 'service',
        }),
      );
      registry.replace((c) => c.descriptor.id === id, [decorated]);
    }
    return pinned;
  };
  const healthOf = (compiled: CompiledCapability) =>
    serviceHealth(
      (compiled.capability.config as { model?: ServiceModels } | undefined)?.model,
      models.describe(),
    );
  const lifecycleFor = (compiled: CompiledCapability) =>
    lifecycleOf(configEntries, compiled.service.tenant, compiled.service.id);
  const optionCache: OptionCache = new Map();
  const datasetsOf = (compiled: CompiledCapability) => {
    const known = knowledge.datasets();
    return compiled.capability.grants.flatMap((g) => {
      if (g.port !== 'knowledge') return [];
      const id = knowledge.resolve(g.ref.id) ?? g.ref.id;
      return [id, ...(known.get(id)?.aliases ?? [])];
    });
  };
  const boundServiceReads = async (principal: Principal, names: string[]) => {
    const bound = principal.confinedTo;
    if (!bound) return true;
    const used = new Set(
      (await definitions.capabilities())
        .filter((c) => c.service.tenant === bound.tenant && c.service.id === bound.service)
        .flatMap(datasetsOf),
    );
    return names.some((name) => used.has(name));
  };
  const resolver = capabilityResolver(definitions, kernel, {
    pin,
    fieldOptions: (principal, tenant, from) =>
      facetOptions(knowledge, optionCache, principal, tenant, from),
    paused: async (compiled) =>
      healthOf(compiled).status === 'paused' || (await lifecycleFor(compiled)).state === 'paused',
    pauseReason: async (compiled) => {
      const lifecycle = await lifecycleFor(compiled);
      return lifecycle.state === 'paused' ? pausedMessage(lifecycle) : healthOf(compiled).reason;
    },
    pausedByTenant: async (compiled) => {
      const lifecycle = await lifecycleFor(compiled);
      return lifecycle.state === 'paused' ? pausedMessage(lifecycle) : undefined;
    },
    archived: async (compiled) => (await lifecycleFor(compiled)).state === 'archived',
    chat: async (compiled) => {
      const found = await definitions.get('Service', compiled.service.tenant, compiled.service.id);
      return (
        (found?.definition as { spec?: { exposure?: { chat?: boolean } } } | undefined)?.spec
          ?.exposure?.chat === true
      );
    },
    documents: async (compiled) =>
      runtimeDocumentTypes(
        (await definitions.get('Service', compiled.service.tenant, compiled.service.id))?.definition
          .spec,
      ),
    batch: async (compiled) => {
      const found = await definitions.get('Service', compiled.service.tenant, compiled.service.id);
      return (
        (found?.definition as { spec?: { batch?: { enabled?: boolean } } } | undefined)?.spec?.batch
          ?.enabled === true
      );
    },
    searches: (principal, compiled) => serviceDatasets(knowledge, principal, compiled),
    datasets: datasetsOf,
  });
  const ingestionUsage = async (tenant: string) => {
    const scopes = tenant === platformTenant ? [tenant, platformScope] : [tenant];
    const runs: { at: string; dataset: string; model: string; usage: Usage }[] = [];
    for (const item of config.catalog.list({ kind: 'dataset' })) {
      if (!scopes.includes(item.scope)) continue;
      for (const pipeline of await config.ingestion.list(item.scope, item.id))
        for (const execution of await config.ingestion.executions(item.id, pipeline.id))
          for (const [key, usage] of Object.entries(execution.report?.usage ?? {}))
            runs.push({
              at: execution.startedAt,
              dataset: item.id,
              model: key.slice(key.indexOf(':') + 1),
              usage,
            });
    }
    return runs;
  };
  const modelsOf = async (task: string) => {
    const used = new Set<string>();
    for await (const event of log.read(task, 0, () => false)) {
      if (event.type !== 'kernel.usage') continue;
      const data = event.data as { port?: string; model?: { kind?: string; id?: string } };
      if (data.model?.id && (data.model.kind === 'model' || data.port === 'model'))
        used.add(data.model.id);
    }
    return [...used];
  };
  const callers = new WeakMap<Request, Promise<Caller | undefined>>();
  const callerOf = (request: Request) => {
    const known = callers.get(request);
    if (known) return known;
    const found = (async () => {
      const authenticated = await input.authenticate(request);
      if (!authenticated) return undefined;
      const caller = input.lockdown
        ? {
            ...authenticated,
            principal: withCredentialOrigin(input.lockdown, request, authenticated.principal),
          }
        : authenticated;
      return (await admitConfined(clients, request, caller.principal)) ? caller : undefined;
    })();
    callers.set(request, found);
    return found;
  };
  const principalAuth = {
    authenticate: async (request: Request) => (await callerOf(request))?.principal,
  };
  const conversations = input.conversations ?? new InMemoryConversationStore();

  const drafts = createDraftRunner({
    kernel,
    registry,
    plugins,
    blobs: blobStore,
    prices,
    residencyOf: (model) => models.models().get(model)?.residency,
    events: (task, isLive) => log.read(task, 0, isLive ?? (() => false)),
    wake: (task) => log.wake(task),
    decorate,
    fieldOptions: (principal, tenant, from) =>
      facetOptions(knowledge, optionCache, principal, tenant, from),
  });

  const directory = new TenantDirectory(input.tenantDirectory, async () => [
    ...new Set((await store.capabilities()).map((c) => c.service.tenant)),
  ]);
  const toolConnections = {
    reload: async () => {
      const tenants = new Set([
        platformTenant,
        ...(await directory.list()).map((t) => t.orgNumber),
      ]);
      for (const tenant of tenants) {
        await mcp.load(tenant);
        await refreshTools(tenant);
      }
    },
  };
  const registered = async (tenant: string) =>
    tenant === platformTenant || (await directory.list()).some((e) => e.orgNumber === tenant);

  const usageCache = new Map<string, { at: number; month: string; tokens: number }>();
  const monthlyTokensUsed = async (tenant: string, fresh = false, at = new Date()) => {
    const month = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1)).toISOString();
    const cached = usageCache.get(tenant);
    if (!fresh && cached && cached.month === month && at.getTime() - cached.at < 15_000)
      return cached.tokens;
    let tokens = 0;
    if (taskIndex.tokensUsed) tokens = await taskIndex.tokensUsed(tenant, month);
    else
      for (const tracked of await taskIndex.all(tenant)) {
        const task = (await taskStore.get(tracked.task))?.task;
        if (!task || task.tenant !== tenant || task.createdAt < month) continue;
        if (originOf(task.service.capability.id) === 'assistant') continue;
        tokens += (task.usage.inputTokens ?? 0) + (task.usage.outputTokens ?? 0);
      }
    usageCache.set(tenant, { at: at.getTime(), month, tokens });
    return tokens;
  };
  const numberSetting = (tenant: string, key: string, fallback: number) => {
    const value = settings.effective(tenant)[key]?.value;
    return typeof value === 'number' && value > 0 ? value : fallback;
  };
  const quota = async (tenant: string, options: { fresh?: boolean } = {}) => {
    const monthlyTokens = numberSetting(tenant, quotaSettingKey, defaultMonthlyTokens);
    const usedTokens = await monthlyTokensUsed(tenant, options.fresh);
    return {
      usedTokens,
      monthlyTokens,
      usedPercent: Math.round((usedTokens / monthlyTokens) * 1000) / 10,
      exhausted: usedTokens >= monthlyTokens,
    };
  };

  const limiter = input.rateLimits?.limiter ?? new SlidingWindowLimiter();
  const invokes = (c: {
    req: { method: string; path: string; header(name: string): string | undefined };
  }) =>
    c.req.method === 'POST' &&
    (c.req.path.startsWith('/v1/') ||
      c.req.path.startsWith('/api/tools/call/') ||
      (c.req.path === '/api/mcp' && c.req.header('mcp-method') === 'tools/call') ||
      c.req.path.startsWith('/a2a/'));
  const headlessRagLimited = (c: { req: { method: string; path: string } }) =>
    c.req.method === 'POST' &&
    (c.req.path === '/api/mcp' ||
      c.req.path.startsWith('/api/tools/call/') ||
      c.req.path === '/v1/chat/completions');
  const serviceLimitsGate: MiddlewareHandler = async (c, next) => {
    if (c.req.path === '/v1/models' || /^\/v1\/models\/[^/]+\/schema$/.test(c.req.path))
      return next();
    const caller = await callerOf(c.req.raw);
    const tenant = caller?.principal.tenant;
    if (!caller || !tenant) return next();
    const headlessRag = headlessRagLimited(c);
    if (caller.key && (headlessRag || c.req.path.startsWith('/a2a'))) {
      const perMinute = caller.key.callsPerMinute ?? defaultKeyCallsPerMinute;
      const decision = await limiter.take(`key:${caller.key.id}`, perMinute);
      if (!decision.ok)
        return headlessRag
          ? keyRateLimited(c, decision.retryAfterSeconds, perMinute)
          : tooManyRequests(
              c,
              decision.retryAfterSeconds,
              'urn:genai:problem:rate-limited',
              'Too many requests',
              `The API key allows ${perMinute} calls per minute.`,
            );
    }
    const perMinute = numberSetting(
      tenant,
      tenantCallsPerMinuteSetting,
      defaultTenantCallsPerMinute,
    );
    const decision = await limiter.take(`tenant:${tenant}`, perMinute);
    if (!decision.ok)
      return headlessRag
        ? keyRateLimited(c, decision.retryAfterSeconds, perMinute)
        : tooManyRequests(
            c,
            decision.retryAfterSeconds,
            'urn:genai:problem:rate-limited',
            'Too many requests',
            `The organisation allows ${perMinute} calls per minute.`,
          );
    if (invokes(c)) {
      const used = await quota(tenant);
      if (used.exhausted) return quotaExhausted(c, used.monthlyTokens);
    }
    return next();
  };
  const gate = tenantGate({
    caller: async (request) => (await callerOf(request))?.principal,
    registered,
  });
  const labels = input.labels ?? new InMemoryLabelStore();
  const apiKeys = input.apiKeys ?? new InMemoryTenantApiKeys();
  let adminRef: Admin | undefined;
  const consoleOperator: Principal = { kind: 'operator', issuer: 'platform', subject: 'console' };
  const consoleDeps: ConsoleDeps = {
    names: actorNames(configEntries),
    store: definitions,
    lifecycle: (tenant, service) => lifecycleOf(configEntries, tenant, service),
    pluginUsage: async () =>
      pluginUsage({
        store: definitions,
        tenants: async () => (await directory.list()).map((t) => t.orgNumber),
        modelEndpoint: (model) => models.describe().find((m) => m.id === model)?.endpoint,
        datasetEndpoint: (dataset) =>
          config.catalog.get('dataset', knowledge.resolve(dataset) ?? dataset)?.spec.endpoint as
            string | undefined,
        endpoint: (kind, id) => config.catalog.get(kind, id),
      }),
    plugins,
    blocks: { describe: () => blocks.refs().map((ref) => ({ ref })) },
    tenants: async () => (await directory.list()).map((t) => t.orgNumber),
    runs: evalStores.runs,
    labels,
    traces: () => input.traces?.(),
    support: {
      list: () => adminRef?.supportSessions() ?? [],
      end: (id, at) => adminRef?.endSupport(id, at),
      extend: async (id, minutes, at) => adminRef?.extendSupport(id, minutes, at),
    },
    tasks: () => taskIndex.running(),
    quality: async () =>
      Object.assign({}, ...(await Promise.all(modules.map((m) => m.qualityOverview?.() ?? {})))),
    taskDetails: async (task) => {
      const stored = await taskStore.get(task);
      return stored
        ? {
            service:
              stored.task.service.capability.id.split('/')[1] ?? stored.task.service.capability.id,
            capability: stored.task.service.capability.id,
          }
        : undefined;
    },
    cancel: (task) => kernel.cancel(consoleOperator, task),
    operations: () =>
      operationsOverview({
        now: () => new Date(),
        models: () => models.describe(),
        ingestion: () => config.ingestion.backend,
        pipelines: async () => {
          const runs: PipelineRuns[] = [];
          for (const item of config.catalog.list({ kind: 'dataset' }))
            for (const pipeline of await config.ingestion.list(item.scope, item.id))
              runs.push({
                tenant: item.scope === platformScope ? platformTenant : item.scope,
                dataset: item.id,
                pipeline: pipeline.spec.name,
                scheduled: pipeline.spec.enabled && pipeline.spec.schedule !== 'none',
                executions: await config.ingestion.executions(item.id, pipeline.id),
              });
          return runs;
        },
        tasks: () => taskIndex.all(),
        tenantNames: async () =>
          new Map((await directory.list()).map((t) => [t.orgNumber, t.name])),
        ...(input.databasePing ? { database: input.databasePing } : {}),
      }),
    organization: organizationLookup({
      tenants: () => directory.list(),
      ...(input.organizationRegistry
        ? {
            registryUrl: input.organizationRegistry.url,
            ...(input.organizationRegistry.fetch
              ? { fetch: input.organizationRegistry.fetch }
              : {}),
          }
        : {}),
    }),
  };
  const pluginRegistry = new PluginRegistry({ runs: configContractRuns(configurables.store) });
  const externalTargets = {
    models: modelAdapters,
    rerank: [colbert],
    knowledge: knowledgeAdapters,
    secrets: catalogSecrets,
    tenant: platformTenant,
    ...(input.egress ? { egress: input.egress } : {}),
  };
  for (const plugin of [
    ...openAiPlugins,
    ...anthropicPlugins,
    ...colbertPlugins,
    ...mcpPlugins,
    ...a2aPlugins,
    ...openApiPlugins,
    ...typesensePlugins,
    ...builtinPlugins(blocks, describeEngines(knowledgeAdapters, writerAdapters)),
  ])
    if (!pluginRegistry.get(plugin.manifest.id)) pluginRegistry.register(plugin);
  const moduleDeps: ModuleDeps = {
    platformTenant,
    ...(input.logger ? { logger: input.logger } : {}),
    catalog: config.catalog,
    definitions,
    plugins,
    settings,
    configEntries: configurables.store,
    models,
    knowledge,
    writers,
    engines: () => describeEngines(knowledgeAdapters, writerAdapters),
    ingestion: config.ingestion,
    ...(input.lockdown ? { modelAdmission: mayUseModels, readOnly: readOnlyInLockdown } : {}),
    evalStores,
    evalCapability: evalCapability.descriptor.id,
    ...(input.appVersion ? { appVersion: input.appVersion } : {}),
    tenantSecrets,
    traceSinks,
    traceDeliveries,
    egressOptions: input.egress ?? {},
    ...(input.tracing ? { tracing: input.tracing } : {}),
    connections,
    blobs: blobStore,
    prices,
    quota,
    drafts,
    pinService: async (tenant, service, version) => {
      const compiled = (await definitions.capabilities()).find(
        (c) => c.service.tenant === tenant && c.service.id === service,
      );
      if (!compiled) return undefined;
      if (compiled.service.version === version) return compiled.capability.descriptor.id;
      return (await pin(compiled, version))?.capability.descriptor.id;
    },
    kernel,
    enrichmentTask: enrichmentWork.run(() => kernel),
    tasks: taskIndex,
    task: async (id) => (await taskStore.get(id))?.task,
    events: (task) => log.read(task, 0, () => false),
    webhooks,
    sync,
    onChange: (topic, listener) => input.changes?.on(topic, listener) ?? (() => undefined),
    knowledgeAdapters,
    secrets: catalogSecrets,
    ...(input.tokenProviders ? { tokenProviders: input.tokenProviders } : {}),
    embedders: {
      has: (model) => embeddingModels.has(model),
      open: (...args) => embedders.open(...args),
    },
    ...(input.ingestFolderRoot ? { ingestFolderRoot: input.ingestFolderRoot } : {}),
    ingestSources,
    vault,
    ...(defaultEmbedding ? { defaultEmbedding } : {}),
    hookRuntime,
    ...(input.triggerRuns ? { triggerRuns: input.triggerRuns } : {}),
    pluginRegistry,
    externalPlugins: {
      protocols: externalProtocols(externalTargets),
      target: externalTarget(externalTargets),
      runtime: {
        sharedTools,
        agents: agentPlugins,
        evaluators,
        judge: (plugin) =>
          plugin.endpoint
            ? httpJudge(
                plugin.manifest,
                judgeSender(
                  new EgressGuard(input.egress ?? {}),
                  plugin.manifest,
                  plugin.endpoint,
                  declaredSecrets(plugin.manifest, catalogSecrets),
                ),
              )
            : undefined,
      },
      tools: { source: mcp, changed: refreshTools },
    },
  };
  const configuredBlocks = createBuildingBlocksModule({
    guard: new EgressGuard(input.egress ?? {}),
    secrets: catalogSecrets,
    secretNames: (tenant) => vault.names(tenant),
  });
  const configuredDiagnostics = createDiagnosticsModule({ rerank });
  modules = (input.modules ?? platformModules).map((create) =>
    (create === buildingBlocksModule
      ? configuredBlocks
      : create === diagnosticsModule
        ? configuredDiagnostics
        : create)(moduleDeps),
  );
  modules.push(
    createKeyPoliciesModule({
      policies:
        input.keyPolicies ??
        (apiKeys instanceof InMemoryTenantApiKeys ? apiKeys : new InMemoryTenantApiKeys()),
      keys: apiKeys,
    })(moduleDeps),
  );
  if (input.verifyPluginsOnBoot)
    void pluginRegistry.verifyUnverified('boot').catch(() => undefined);
  if (modules.some((m) => m.decorateCapability)) await sync();

  const extensions = {
    ...adminExtensions({
      tools: {
        connections,
        source: mcp,
        secrets: new TenantSecrets(vault.resolver(input.secrets)),
        onToolsChanged: refreshTools,
      },
      directory,
    }),
    ...portalAdminHandlers({ apiKeys }),
    ...frontendAdminHandlers({
      clients,
      definitions,
      ...(input.reservedClientIds ? { reservedClientIds: input.reservedClientIds } : {}),
    }),
    ...consoleAdminExtensions(consoleDeps),
    ...config.extensions,
    ...Object.fromEntries(modules.flatMap((m) => Object.entries(m.handlers ?? {}))),
  };

  const mount = <E extends Env, S extends Schema, B extends string>(
    app: Hono<E, S, B>,
    admin?: Admin,
  ) => {
    app.use('*', clientCors(clients));
    for (const path of [
      '/v1/*',
      '/api/tools/*',
      '/api/mcp',
      '/a2a',
      '/a2a/*',
      '/api/datasets',
      '/api/datasets/*',
      '/api/facets',
      '/api/conversations',
      '/api/conversations/*',
      '/tenants/:tenant/datasets/:id/enrichment/hypothetical-questions/proposals',
    ])
      app.use(path, serviceLimitsGate);
    if (admin)
      mountExtensions(app, {
        platformTenant,
        admin,
        authenticate: async (request) => (await callerOf(request))?.principal,
        vault,
        connections,
        directory,
        tasks: () => taskIndex.running(),
        allTasks: () => taskIndex.all(),
        catalogSkips: input.catalogSkips ?? [],
        eval: {
          kernel,
          evalCapability: evalCapability.descriptor.id,
          ...evalStores,
          quotaExhausted: async (tenant) => (await quota(tenant, { fresh: true })).exhausted,
        },
      });
    if (admin) {
      adminRef = admin;
      const authenticate = async (request: Request) => (await callerOf(request))?.principal;
      registerPortalRoutes(app, {
        admin,
        authenticate,
        definitions,
        tasks: (tenant) => taskIndex.all(tenant),
        task: async (id) => (await taskStore.get(id))?.task,
        events: (id) => log.read(id, 0, () => false),
        apiKeys,
        connections,
        requirementFor:
          input.serviceRequirement ??
          (() => ({
            resource: 'urn:altinn:resource:digdir-genai-platform',
            action: 'use-services',
          })),
        prices,
        ingestionUsage,
        projectTasks: (tenant) => projectTasks(configurables.store, tenant),
        serviceHealth: async (tenant, service) => {
          const found = await definitions.get('Service', tenant, service);
          const spec = (found?.definition as { spec?: { model?: ServiceModels } } | undefined)
            ?.spec;
          return spec ? serviceHealth(spec.model, models.describe()) : undefined;
        },
        traces: { enabled: Boolean(input.traces?.()), content: Boolean(input.traces?.()?.content) },
        drafts,
        names: actorNames(configEntries),
        lifecycle: (tenant, service) => lifecycleOf(configEntries, tenant, service),
      });
      registerConsoleRoutes(app, { ...consoleDeps, admin, authenticate });
      config.mount(app, admin, authenticate);
      registerFrontendRoutes(app, {
        admin,
        authenticate,
        clients,
        definitions,
        apiKeys,
        webhooks,
        ...(input.endpoints ? { endpoints: input.endpoints } : {}),
      });
      const mountDeps = { ...moduleDeps, admin, authenticate, access: tenantAccess(admin) };
      for (const m of modules) m.mount(app, mountDeps);
      documentAccessRoutes(app);
      documentDatasetRoutes(app, ['config', 'operator-catalog', ...modules.map((m) => m.id)]);
    }
    app.get('/operator/definitions/quarantine', async (c) => {
      const principal = (await callerOf(c.req.raw))?.principal;
      if (!principal) return problem(c, 401, 'Du er ikke logget inn');
      if (principal.kind !== 'operator') return problem(c, 403, 'Ikke tillatt');
      return c.json({ data: runtime.quarantined() });
    });
    const caller = async (request: Request) => principalAuth.authenticate(request);
    documentDatasetRoutes(app, ['models']);
    app.get('/models', async (c) => {
      const principal = await caller(c.req.raw);
      if (!principal) return problem(c, 401, 'Invalid or missing API key');
      const residency = c.req.query('residency') as Residency | undefined;
      const strategy = c.req.query('strategy');
      const wanted = [
        ...((c.req.queries('capability') ?? []) as Capability[]),
        ...(strategy ? (strategyModelNeeds.get(strategy) ?? []) : []),
      ];
      if (residency && !residencies.includes(residency))
        return problem(c, 400, 'Invalid request', {
          errors: [{ path: 'residency', message: `unknown residency ${residency}` }],
        });
      const visible = models
        .describe()
        .filter((m) => m.enabled)
        .filter(
          (m) => !principal.tenant || !ownedElsewhere(config.catalog, m.id, principal.tenant),
        );
      const displayNames = modelDisplayNames(visible);
      const data = models
        .describe()
        .filter((m) => m.enabled)
        .filter((m) => !principal.tenant || !ownedElsewhere(config.catalog, m.id, principal.tenant))
        .filter((m) => !residency || residencyAllows(residency, m.residency))
        .filter((m) => wanted.every((w) => m.capabilities.includes(w)))
        .map(({ id, family, residency: r, capabilities, parameters }) => ({
          id,
          name: displayNames.get(id) ?? id,
          ...(family ? { family } : {}),
          residency: r,
          capabilities,
          parameters,
          price: prices[id] ?? null,
        }));
      return c.json({ data });
    });
    app.route(
      '/',
      createMcpApp({
        kernel,
        resolver,
        auth: principalAuth,
        overridePolicy,
        modelsOf,
        conversations: conversationTurns(conversations, callerOf, conversationId),
        quotaExhausted: async (principal) => {
          if (!principal.tenant) return undefined;
          const used = await quota(principal.tenant);
          return used.exhausted
            ? {
                type: quotaExhaustedType,
                title: quotaExhaustedTitle,
                detail: quotaExhaustedDetail(used.monthlyTokens),
                retryAfterSeconds: secondsToNextMonth(),
              }
            : undefined;
        },
      }),
    );
    app.route(
      '/',
      createOpenAiAdapter({
        kernel,
        resolver,
        auth: principalAuth,
        overridePolicy,
        modelsOf,
        conversations: conversationTurns(conversations, callerOf, conversationId),
        ...(blobStore ? { documents: runtimeDocumentStore(blobStore) } : {}),
        filterIssues: async (principal, entry, filters) =>
          askFilterIssues(knowledge, principal, entry, filters),
        serviceSchema: async (entry) => {
          const [tenant, service] = entry.capability.split('/');
          const found =
            tenant && service ? await definitions.get('Service', tenant, service) : undefined;
          const spec = (found?.definition as Pick<ServiceDefinition, 'spec'> | undefined)?.spec;
          return serviceSchemaOf({
            id: entry.id,
            title: entry.title,
            labels: entry.labels,
            datasets: entry.searches?.map(datasetOf),
            description: entry.description,
            inputFields: entry.inputFields,
            output: spec?.output,
          });
        },
      }),
    );
    const a2aExposure = async (capability: string) => {
      const [tenant, service] = capability.split('/');
      const found =
        tenant && service ? await definitions.get('Service', tenant, service) : undefined;
      return (
        found?.definition as
          { spec?: { exposure?: { a2a?: boolean; a2aPublicCard?: boolean } } } | undefined
      )?.spec?.exposure;
    };
    const publicAgent = async (compiled: CompiledCapability, name: string) => {
      const exposure = await a2aExposure(compiled.capability.descriptor.id);
      if (exposure?.a2a !== true || exposure.a2aPublicCard !== true) return undefined;
      if (healthOf(compiled).status === 'paused') return undefined;
      const lifecycle = await lifecycleFor(compiled);
      if (lifecycle.state !== 'active') return undefined;
      const agency = (await directory.list()).find((t) => t.orgNumber === compiled.service.tenant);
      return {
        entry: { ...entryOf(compiled, name), version: compiled.service.version },
        provider: { organization: agency?.name ?? compiled.service.tenant },
      };
    };
    app.route(
      '/',
      createA2aApp({
        kernel,
        resolver,
        auth: principalAuth,
        modelsOf,
        taskIds: async (principal) => (await taskIndex.all(principal.tenant)).map((t) => t.task),
        exposed: async (entry) => (await a2aExposure(entry.capability))?.a2a === true,
        publicDiscovery: {
          list: async () => {
            const seen = new Set<string>();
            const out = [];
            for (const compiled of await definitions.capabilities()) {
              const id = compiled.capability.descriptor.id;
              if (seen.has(id)) continue;
              seen.add(id);
              const agent = await publicAgent(compiled, compiled.publicName);
              if (agent) out.push(agent);
            }
            return out;
          },
          resolve: async (name) => {
            const compiled = await definitions.resolve(name);
            return compiled ? publicAgent(compiled, name) : undefined;
          },
          limit: (c) => limiter.take(`a2a-public:${clientAddress(c)}`, publicCardsPerMinute),
        },
        baseUrl: (request) => {
          const proto = request.headers.get('x-forwarded-proto')?.split(',')[0]?.trim();
          const host = request.headers.get('x-forwarded-host')?.split(',')[0]?.trim();
          return proto && host ? `${proto}://${host}` : new URL(request.url).origin;
        },
        provider: { organization: 'Digitaliseringsdirektoratet', url: 'https://www.digdir.no' },
      }),
    );
    app.route(
      '/',
      createRestAdapter({
        knowledge,
        auth: principalAuth,
        mayRead: async (principal, dataset) => {
          const names = [dataset, dataset.slice(dataset.lastIndexOf('/') + 1)];
          return (
            keyReaches(principal, 'query', { datasets: names }) &&
            configKeyAllows(principal, 'dataset', names) &&
            (await boundServiceReads(principal, names))
          );
        },
        status: async (dataset) => {
          const item = config.catalog.get('dataset', dataset);
          if (!item) return 'configured';
          const endpoint = String(item.spec.endpoint ?? '');
          const engine = (
            config.catalog.get(
              'knowledge-endpoint',
              config.catalog.qualify(item.scope, endpoint),
            ) ?? config.catalog.get('knowledge-endpoint', endpoint)
          )?.spec.engine;
          const builtin = describeEngines(knowledgeAdapters, writerAdapters).some(
            (e) => e.engine === engine && e.builtin,
          );
          return publicDatasetState(
            config.ingestion,
            item.scope,
            item.id,
            typeof engine === 'string' && !builtin,
          );
        },
      }),
    );
    app.route(
      '/',
      conversationRoutes({
        store: conversations,
        auth: { authenticate: (request) => callerOf(request) },
        onDeleted: async (owner, id) => {
          await threadErasure?.erase(owner.tenant, id);
          if (blobStore) await deleteConversationDocuments(blobStore, owner.tenant, id);
        },
        selectAgent: async (caller, requested) => {
          const entries = await resolver.list(caller.principal);
          if (requested) {
            const chosen = entries.find((e) => e.id === requested || e.agentId === requested);
            if (chosen?.status === 'paused')
              return { ok: false, status: 403, error: `Agent is disabled: ${requested}` };
            if (chosen) return { ok: true, agentId: requested };
            const owners = (await definitions.capabilities()).filter((c) =>
              [c.publicName, ...c.aliases].some((name) => {
                const entry = entryOf(c, name);
                return entry.id === requested || entry.agentId === requested;
              }),
            );
            const own = owners.find((c) =>
              entries.some(
                (e) => e.capability === c.capability.descriptor.id && e.status !== 'paused',
              ),
            );
            if (own) return { ok: true, agentId: requested };
            return owners.length > 0
              ? {
                  ok: false,
                  status: 403,
                  error: 'API key is not allowed to access the selected agent',
                }
              : { ok: false, status: 404, error: `Agent not found: ${requested}` };
          }
          const candidates = new Map<string, ModelEntry>();
          for (const entry of entries) {
            if (entry.status === 'paused') continue;
            const service = entry.capability.split('/').slice(0, 2).join('/');
            const seen = candidates.get(service);
            if (!seen || (entry.default && !seen.default)) candidates.set(service, entry);
          }
          const [only, ...more] = [...candidates.values()];
          if (only && more.length === 0) return { ok: true, agentId: only.agentId ?? only.id };
          if (only)
            return {
              ok: false,
              status: 400,
              error: 'Multiple agents are available; specify agent-id',
              available: entries.map((e) => e.id),
            };
          return {
            ok: false,
            status: 503,
            error: grantsOf(caller.principal)
              ? "None of this API key's granted agents are available"
              : 'No agents are available',
          };
        },
      }),
    );
  };

  return {
    kernel,
    settings,
    registry,
    tenantGate: gate,
    caller: principalAuth.authenticate,
    registered,
    quota,
    plugins,
    extensions,
    directory,
    labels,
    apiKeys,
    clients,
    webhooks,
    evalStores,
    evaluators,
    connections,
    mcp,
    vault,
    definitions,
    quarantined: () => runtime.quarantined(),
    toolConnections,
    serviceDrafts: serviceDrafts(configurables.store, definitions),
    lifecycle: (tenant: string, service: string) => lifecycleOf(configEntries, tenant, service),
    resolver,
    models,
    knowledge,
    rerank,
    embedders,
    writers,
    catalog: config.catalog,
    ingestion: config.ingestion,
    gates: configurables.gates,
    guardrailRules: configurables.rules,
    configEntries: configurables.store,
    prices,
    drafts,
    modules,
    sync,
    mount,
  };
};
