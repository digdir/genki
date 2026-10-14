import type { Principal, Ref, Usage } from '@genai/contracts';
import {
  platformSettings,
  SettingsRegistry,
  strategyKey,
  type CompiledCapability,
  type DefinitionStore,
  type InvalidStoredDefinition,
  type PluginSchemas,
  type Residency,
  type FlowFinder,
  type SkillFinder,
  type StepFlowDefinition,
} from '@genai/definitions';
import {
  guardrailSchemas,
  guardStrategy,
  piiSafeEventLog,
  type CustomRuleHooks,
  type PiiCategory,
} from '@genai/guardrails';
import { withHooks } from '@genai/hooks';
import { batchCapabilityFor, batchStrategy } from '@genai/jobs';
import {
  CapabilityRegistry,
  checkCapability,
  createKernel,
  type Capability as KernelCapability,
  type EventLog,
  type Kernel,
  type PolicyDecisionPoint,
  type PortContext,
  type SecretResolver,
  type StateStore,
  type Strategy,
  type TaskStore,
  type TokenProviders,
} from '@genai/kernel';
import { BlobPortProvider, InMemoryBlobStore, type BlobStore } from '@genai/port-blob';
import { EmbeddingRouter, type EmbeddingAdapter } from '@genai/port-embedding';
import {
  IndexWriterRouter,
  parseKnowledgeCatalog,
  type DatasetConfig,
  type IndexWriterAdapter,
  type KnowledgeAdapter,
} from '@genai/port-knowledge';
import {
  ModelRouter,
  parseCatalog,
  type Capability,
  type ModelClassificationStore,
  type ModelClassification,
} from '@genai/port-model';
import { parseRerankCatalog, RerankRouter } from '@genai/port-rerank';
import { parseToolRef, textOf, ToolRegistry } from '@genai/port-tools';
import { A2aToolSource } from '@genai/providers-a2a-client';
import { anthropicMessages } from '@genai/providers-anthropic';
import { colbert } from '@genai/providers-colbert';
import {
  ConnectionToolSources,
  EgressGuard,
  InMemoryConnections,
  McpToolSource,
  type ConnectionRegistry,
  type EgressOptions,
} from '@genai/providers-mcp-client';
import { azureDeployments, openAiChat, openAiEmbeddings } from '@genai/providers-openai';
import { OpenApiToolSource } from '@genai/providers-openapi-tools';
import {
  pgvectorEngine,
  pgvectorEngineName,
  type PgvectorEngineOptions,
} from '@genai/providers-pgvector';
import { typesense } from '@genai/providers-typesense';
import { typesenseIndexWriter } from '@genai/providers-typesense-writer';
import { createAgentRetrieval, createRagRetrieval, retrievalConfig } from '@genai/retrieval';
import { agentLoopConfig, createAgentLoop } from '@genai/strategy-agent-loop';
import { createRagSingleShot, ragConfig } from '@genai/strategy-rag';
import {
  createRemoteAgent,
  type RegisteredAgent,
  createRemoteTransport,
  remoteAgentConfig,
} from '@genai/strategy-remote';
import { singleCall, singleCallConfig } from '@genai/strategy-single-call';
import { builtinBlocks, createStepFlow, stepFlowConfig } from '@genai/strategy-step-flow';
import { z as zod, type z } from 'zod';
import {
  CatalogRegistry,
  type CatalogPolicy,
  type CatalogReferences,
  type EffectiveCatalogs,
} from './catalog-registry.js';
import {
  InMemoryConfigEntryStore,
  type ConfigEntry,
  type ConfigEntryStore,
} from './config-store.js';
import { withDocumentScope } from './document-scope.js';
import { failureLoggingEventLog, loggedModels, type ApiLog } from './failure-log.js';
import {
  guardedSend,
  httpSearchAdapter,
  mcpClientCall,
  mcpSearchAdapter,
} from './external-search.js';
import { skillDecorator, skillResolver } from './skills.js';
import { createHookRuntime, type HookSender } from './hook-runtime.js';
import {
  ContextualKnowledgeRouter,
  portContexts,
  routerCatalog,
  withoutEngines,
} from './knowledge-context.js';
import { sharedRecipeFinder } from './recipe-shares.js';
import { openRetrievalPorts, usingRetrievalPorts, type RuntimeConfig } from './retrieval-ports.js';
import { createGuardrailRuleRegistry, resolveRules } from './scoped-registry.js';
import { answerLanguageFor, houseStyleFor, withSettings } from './settings-runtime.js';
import type { TenantSecretVault } from './tenant-secrets.js';
import { userPreferenceReader } from './user-preferences.js';

export const defaultServiceLimits = { deadlineMs: 300_000, budget: { inputTokens: 2_000_000 } };

export const strategyModelNeeds = new Map<string, Capability[]>([
  [strategyKey('agent-loop', 1), ['tools', 'json-schema']],
  [strategyKey('rag-single-shot', 1), ['json-schema']],
  [strategyKey('single-call', 1), []],
  [strategyKey('remote-agent', 1), []],
  [strategyKey('step-flow', 1), ['json-schema']],
]);

export const inMemoryClassifications = (): ModelClassificationStore => {
  const saved: Record<string, ModelClassification> = {};
  return {
    load: async () => structuredClone(saved),
    save: async (id, c) => {
      saved[id] = structuredClone(c);
    },
  };
};

export interface Catalogs {
  models: unknown;
  knowledge: unknown;
  rerank: unknown;
  embeddings?: unknown;
}

export interface QuarantinedDefinition extends InvalidStoredDefinition {
  at: string;
}

export interface CapabilityContext {
  compiled: CompiledCapability;
  definition: unknown;
  origin: 'service';
}

export type CapabilityDecorator = (
  capability: KernelCapability,
  context: CapabilityContext,
) => Promise<KernelCapability>;

export interface PolicyParts {
  namesOf(ref: Ref): string[];
  catalog(): CatalogRegistry | undefined;
}

export interface RuntimeInput {
  platformTenant: string;
  catalogs: Catalogs;
  secrets: SecretResolver;
  vault: TenantSecretVault;
  configEntries?: ConfigEntryStore;
  settings?: SettingsRegistry;
  definitions: (
    plugins: PluginSchemas,
    sharedSkill?: SkillFinder,
    sharedFlow?: FlowFinder,
  ) => DefinitionStore;
  policy: PolicyDecisionPoint | ((parts: PolicyParts) => PolicyDecisionPoint);
  admitsModelUse?: (principal: Principal) => boolean;
  log: EventLog;
  tasks: TaskStore;
  state?: StateStore;
  observe?: (log: EventLog) => EventLog;
  tokenProviders?: TokenProviders;
  egress?: EgressOptions;
  blobStore?: BlobStore;
  connections?: ConnectionRegistry;
  modelClassifications?: ModelClassificationStore;
  knowledgePool?: PgvectorEngineOptions['pool'];
  embeddingAdapters?: EmbeddingAdapter[];
  searchOnlyClusters?: (string | undefined)[];
  catalogPolicy?: CatalogPolicy;
  prices?: Record<string, unknown>;
  ruleSeed?: { id: string; spec: unknown; mandatory?: boolean }[];
  hookSender?: HookSender;
  serviceLimits?: { deadlineMs?: number; budget?: Usage };
  decorate?: CapabilityDecorator;
  decorateAfter?: (store: DefinitionStore) => CapabilityDecorator;
  wrapStrategy?: (strategy: Strategy) => Strategy;
  extraStrategies?: (parts: ExtraStrategyParts) => Strategy[];
  platformCapabilities?: KernelCapability[];
  now?: () => Date;
  onWarning?: (message: string) => void;
  logger?: ApiLog;
  logFailureMessages?: boolean;
  derivedCatalog?: (entries: ConfigEntry<unknown>[]) => ConfigEntry<unknown>[];
  sharedTools?: (connection: string) => string | undefined;
  endpointFetch?: (endpoint: string) => typeof fetch | undefined;
  agents?: (id: string) => RegisteredAgent | undefined;
}

export interface ExtraStrategyParts {
  models: ModelRouter;
  knowledge: ContextualKnowledgeRouter;
  plugins: () => PluginSchemas;
  kernel: () => Kernel;
}

const pinnedSuffix = /@\d+$/;

export const referencesOf = (configs: unknown[]): CatalogReferences => {
  const found: CatalogReferences = {
    models: new Set(),
    datasets: new Set(),
    rerankers: new Set(),
  };
  for (const raw of configs) {
    const config = (raw ?? {}) as {
      model?: Record<string, unknown>;
      knowledge?: { datasets?: { dataset?: string }[]; reranker?: string };
    };
    for (const [key, value] of Object.entries(config.model ?? {})) {
      if (key === 'tenant') continue;
      if (typeof value === 'string') found.models.add(value);
      else if (value && typeof value === 'object')
        for (const v of Object.values(value)) if (typeof v === 'string') found.models.add(v);
    }
    for (const d of config.knowledge?.datasets ?? []) if (d.dataset) found.datasets.add(d.dataset);
    if (config.knowledge?.reranker) found.rerankers.add(config.knowledge.reranker);
  }
  return found;
};

export const createRuntime = async (input: RuntimeInput) => {
  const { platformTenant, vault } = input;
  const configEntries = input.configEntries ?? new InMemoryConfigEntryStore();
  const settings = input.settings ?? new SettingsRegistry(platformSettings);
  const catalogSecrets = vault.resolver(input.secrets);

  const rules = createGuardrailRuleRegistry({
    store: configEntries,
    ...(input.ruleSeed ? { seed: input.ruleSeed } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  const searchGuard = new EgressGuard(input.egress ?? {});
  const searchAdapters: KnowledgeAdapter[] = [
    httpSearchAdapter(guardedSend(searchGuard)) as KnowledgeAdapter,
    mcpSearchAdapter(mcpClientCall(searchGuard)) as KnowledgeAdapter,
  ];
  const late: {
    kernel?: Kernel;
    store?: DefinitionStore;
    mcp?: ConnectionToolSources;
  } = {};
  const ruleHooks: CustomRuleHooks = {
    resolve: async (ctx, entries) =>
      (await resolveRules(rules, ctx.capability.tenant, entries)).map((r) => ({
        ...r,
        owner: r.owner ?? ctx.capability.tenant,
      })),
    external: async (ctx, rule, text) => {
      const { name, version } = parseToolRef(rule.tool);
      const owner = rule.owner ?? ctx.capability.tenant;
      const portContext: PortContext = {
        tenant: owner,
        principal: ctx.principal,
        task: ctx.task,
        signal: ctx.signal,
        meter: async () => undefined,
      };
      const tool = late.mcp?.resolve(name, version, portContext, owner);
      if (!tool) throw new Error(`no tool ${rule.tool} for ${owner}`);
      const result = await tool.call({ text });
      if (result.isError) throw new Error('the check failed');
      const verdict = JSON.parse(textOf(result)) as { allow?: unknown; message?: unknown };
      if (typeof verdict.allow !== 'boolean') throw new Error('the check gave no verdict');
      return {
        allow: verdict.allow,
        ...(typeof verdict.message === 'string' ? { message: verdict.message } : {}),
      };
    },
  };
  const hookRuntime = createHookRuntime({
    store: configEntries,
    secrets: catalogSecrets,
    ...(input.hookSender ? { send: input.hookSender } : {}),
  });

  const modelAdapters = [openAiChat, anthropicMessages];
  const embedders = new EmbeddingRouter({
    catalog: input.catalogs.embeddings ?? { endpoints: {} },
    adapters: [openAiEmbeddings, ...(input.embeddingAdapters ?? [])],
    secrets: catalogSecrets,
    ...(input.tokenProviders ? { tokenProviders: input.tokenProviders } : {}),
  });
  const embeddingModels = new Set(embedders.describe().map((e) => e.id));
  const smallestEmbedder = embedders
    .describe()
    .sort((a, b) => a.dimensions - b.dimensions || a.id.localeCompare(b.id))[0];
  const defaultEmbedding = smallestEmbedder
    ? {
        model: smallestEmbedder.id,
        dimensions: smallestEmbedder.dimensions,
        residency: smallestEmbedder.residency,
      }
    : undefined;
  const embeddingResidency = (model: string) =>
    embedders.describe().find((e) => e.id === model)?.residency;
  const residencyOf = (dataset: string) => knowledge.datasets().get(dataset)?.residency;
  const queryEmbedder = (dataset: DatasetConfig) => ({
    embed: async (texts: string[]) => {
      const model = dataset.embedding?.model;
      if (!model) throw new Error(`dataset ${dataset.id} has no embedding model`);
      const residency = residencyOf(dataset.id);
      const ctx = portContexts.getStore() ?? {
        tenant: platformTenant,
        principal: { kind: 'agency-system' as const, issuer: 'platform', subject: 'search' },
        task: 'search',
        signal: new AbortController().signal,
        meter: async () => undefined,
      };
      const port = embedders.open({ kind: 'embedder', id: model }, ctx, {
        ...(residency ? { maxResidency: residency } : {}),
      });
      return (await port.embed(texts)).vectors;
    },
  });
  const pgvector = input.knowledgePool
    ? pgvectorEngine({
        pool: input.knowledgePool,
        ...(embeddingModels.size > 0 ? { embedder: queryEmbedder } : {}),
      })
    : undefined;
  const knowledgeAdapters: KnowledgeAdapter[] = [
    typesense as KnowledgeAdapter,
    ...(pgvector ? [pgvector.adapter as KnowledgeAdapter] : []),
    ...searchAdapters,
  ];
  const writerAdapters: IndexWriterAdapter[] = [
    typesenseIndexWriter({
      sharedClusterUrls: [process.env.TYPESENSE_URL, ...(input.searchOnlyClusters ?? [])],
    }) as IndexWriterAdapter,
    ...(pgvector ? [pgvector.writer as IndexWriterAdapter] : []),
  ];
  const knowledgeSeed = withoutEngines(
    input.catalogs.knowledge,
    pgvector ? [] : [pgvectorEngineName],
    input.onWarning,
  );
  const models = new ModelRouter({
    catalog: input.catalogs.models,
    ...(input.admitsModelUse ? { admits: input.admitsModelUse } : {}),
    adapters: modelAdapters,
    ...(input.endpointFetch ? { fetchFor: input.endpointFetch } : {}),
    sources: [azureDeployments],
    classifications: input.modelClassifications ?? inMemoryClassifications(),
    priceOf: (id) =>
      prices[id] as { inputPerThousand: number; outputPerThousand: number } | undefined,
    secrets: catalogSecrets,
    ...(input.tokenProviders ? { tokenProviders: input.tokenProviders } : {}),
    onParameterDropped: (model, parameter) =>
      input.logger?.('model rejected a request parameter', { model, parameter }),
  });
  const knowledge = new ContextualKnowledgeRouter({
    catalog: routerCatalog(knowledgeSeed),
    adapters: knowledgeAdapters,
    secrets: catalogSecrets,
    ...(input.tokenProviders ? { tokenProviders: input.tokenProviders } : {}),
  });
  const writers = new IndexWriterRouter({
    catalog: routerCatalog(knowledgeSeed),
    adapters: writerAdapters,
    knowledgeAdapters,
    secrets: catalogSecrets,
    ...(input.tokenProviders ? { tokenProviders: input.tokenProviders } : {}),
  });
  const rerank = new RerankRouter({
    catalog: input.catalogs.rerank,
    adapters: [colbert],
    ...(input.endpointFetch ? { fetchFor: input.endpointFetch } : {}),
    secrets: catalogSecrets,
    ...(input.tokenProviders ? { tokenProviders: input.tokenProviders } : {}),
    ...(input.onWarning ? { onWarning: input.onWarning } : {}),
  });
  const discovery = await models.refresh();
  for (const f of discovery.failed)
    input.onWarning?.(`model discovery failed for ${f.endpoint}: ${f.error}`);
  const tools = new ToolRegistry();
  const connections = input.connections ?? new InMemoryConnections();
  const toolSourceOptions = {
    registry: connections,
    secrets: catalogSecrets,
    guard: new EgressGuard(input.egress ?? {}),
  };
  const mcp = new ConnectionToolSources(connections, [
    new McpToolSource(toolSourceOptions),
    new A2aToolSource(toolSourceOptions),
    new OpenApiToolSource(toolSourceOptions),
  ]);
  late.mcp = mcp;
  tools.addSource(mcp);
  const sharedTools = input.sharedTools;
  if (sharedTools)
    tools.addSource({
      resolve: (name, version, ctx, owner) => {
        const owning = sharedTools(name.slice(0, Math.max(name.indexOf('.'), 0)));
        return owning && owning !== owner ? mcp.resolve(name, version, ctx, owning) : undefined;
      },
    });
  const blobStore = input.blobStore ?? new InMemoryBlobStore();
  const blob = new BlobPortProvider(blobStore);

  const agentLoop = usingRetrievalPorts(
    createAgentLoop({
      retrieval: async (ctx, config, request) =>
        createAgentRetrieval(await openRetrievalPorts(ctx, config as RuntimeConfig, request)),
    }),
  );
  const blocks = builtinBlocks();
  const keptRecipe = sharedRecipeFinder(
    configEntries,
    () => late.store,
    platformTenant,
    'shared-once',
  );
  const stepFlow = usingRetrievalPorts(
    createStepFlow({
      blocks,
      flows: async (ref, owner) => {
        const at = ref.lastIndexOf('@');
        const id = at < 0 ? ref : ref.slice(0, at);
        const major = at < 0 ? undefined : Number(ref.slice(at + 1).split('.')[0]);
        const found = await late.store?.get('StepFlow', owner, id, major);
        return (
          (found?.definition as StepFlowDefinition | undefined) ??
          (major === undefined ? undefined : await keptRecipe(owner, id, major))
        );
      },
      retrieval: async (ctx, config) =>
        createRagRetrieval(await openRetrievalPorts(ctx, config as RuntimeConfig)),
      agent: agentLoop as Strategy<unknown>,
    }),
  );
  const wrap = input.wrapStrategy ?? ((strategy: Strategy) => strategy);
  const preferences = userPreferenceReader(configEntries);
  const serviceStrategies: Strategy[] = [
    singleCall as Strategy,
    agentLoop as Strategy,
    usingRetrievalPorts(
      createRagSingleShot({
        retrieval: async (ctx, config, request) =>
          createRagRetrieval(await openRetrievalPorts(ctx, config as RuntimeConfig, request)),
      }),
    ) as Strategy,
    stepFlow,
    createRemoteAgent({
      transport: createRemoteTransport({ guard: toolSourceOptions.guard, secrets: catalogSecrets }),
      ...(input.agents ? { agents: input.agents } : {}),
    }),
  ].map((strategy) =>
    withDocumentScope(
      (dataset) => knowledge.resolve(dataset),
      wrap(
        withHooks(
          guardStrategy(withSettings(settings, strategy), {
            rules: ruleHooks,
            answerLanguage: async (ctx, request, config, question) =>
              answerLanguageFor(
                settings,
                ctx,
                request,
                config,
                question,
                await preferences.of(ctx.tenant, ctx.principal),
              ),
            houseStyle: (ctx, _request, config, language) =>
              houseStyleFor(settings, ctx, config, language),
          }),
          { hooks: hookRuntime.forContext, invoke: hookRuntime.invoke },
        ),
      ),
    ),
  );
  const taskStore = input.tasks;
  const capabilityOf = async (task: string) =>
    (await taskStore.get(task))?.task.service.capability.id;
  const plugins: PluginSchemas = {
    strategies: new Map<string, z.ZodType>([
      [strategyKey('single-call', 1), singleCallConfig],
      [strategyKey('agent-loop', 1), agentLoopConfig],
      [strategyKey('rag-single-shot', 1), ragConfig],
      [strategyKey('step-flow', 1), stepFlowConfig],
      [
        strategyKey('remote-agent', 1),
        input.egress?.testOverride?.allowHttp
          ? remoteAgentConfig
          : remoteAgentConfig.refine((c) => !c.endpoint || c.endpoint.url.startsWith('https://'), {
              message: 'the endpoint must use HTTPS',
              path: ['endpoint', 'url'],
            }),
      ],
    ]),
    tools: new Map(),
    guardrails: guardrailSchemas,
    blocks: new Set(blocks.refs()),
    models: models.models(),
    retrieval: retrievalConfig,
    rerankers: new Set(
      ((input.catalogs.rerank as { rerankers?: { id: string }[] }).rerankers ?? []).map(
        (r) => r.id,
      ),
    ),
    rerankerResidency: (id) => rerank.residency(id),
    datasets: new Set(knowledge.datasets().keys()),
    modelNeeds: strategyModelNeeds,
    strategyResidency: (id, config) =>
      id === strategyKey('remote-agent', 1)
        ? ((config as { endpoint?: { residency?: Residency } }).endpoint?.residency ??
          input.agents?.(String((config as { agent?: unknown }).agent ?? ''))?.endpoint.residency)
        : undefined,
  };
  const strategies: Strategy[] = [
    ...serviceStrategies,
    batchStrategy as Strategy,
    ...(input.extraStrategies?.({
      models,
      knowledge,
      plugins: () => plugins,
      kernel: () => {
        if (!late.kernel) throw new Error('the kernel is not ready');
        return late.kernel;
      },
    }) ?? []),
  ];
  const ports = {
    model: input.logger ? loggedModels(models, input.logger, capabilityOf) : models,
    knowledge,
    rerank,
    tools,
    blob,
  };
  const registry = new CapabilityRegistry({ strategies, ports });
  registry.replace(() => false, input.platformCapabilities ?? []);

  const refreshTools = async (tenant: string) => {
    for (const state of await connections.list(tenant))
      for (const tool of state.tools)
        plugins.tools.set(
          `${tool.name}@${state.connection.version}`,
          zod.record(zod.string(), zod.unknown()),
        );
  };

  const outOfLog = (config: unknown): PiiCategory[] =>
    ((config as { guardrails?: Record<string, { categories?: PiiCategory[] }> } | undefined)
      ?.guardrails?.['pii-out-of-log']?.categories ?? []) as PiiCategory[];
  const safeLog = piiSafeEventLog(input.log, {
    categoriesFor: async (task) => {
      const stored = await taskStore.get(task);
      if (!stored) return [...new Set(registry.all().flatMap((c) => outOfLog(c.config)))];
      const capability = registry
        .all()
        .find((c) => c.descriptor.id === stored.task.service.capability.id);
      return outOfLog(capability?.config);
    },
  });
  const observed = input.observe ? input.observe(safeLog) : safeLog;
  const log = input.logger
    ? failureLoggingEventLog(observed, input.logger, capabilityOf, {
        messages: input.logFailureMessages === true,
      })
    : observed;

  const released: { catalog?: CatalogRegistry } = {};
  const grantNames = new Map<string, string[]>();
  const namesOf = (ref: Ref) =>
    grantNames.get(ref.id.replace(/\.batch$/, '').replace(pinnedSuffix, '')) ?? [ref.id];
  const policy =
    typeof input.policy === 'function'
      ? input.policy({ namesOf, catalog: () => released.catalog })
      : input.policy;
  const kernel = createKernel({
    strategies,
    capabilities: registry,
    ports,
    policy,
    log,
    tasks: taskStore,
    ...(input.state ? { state: input.state } : {}),
  });
  late.kernel = kernel;

  const sharedSkill: SkillFinder = async (tenant, id, version) => {
    const owners = (await configEntries.latest({ kind: 'skill-share' }))
      .filter((e) => {
        const spec = e.spec as { skill?: string; state?: string };
        return spec.skill === id && spec.state === 'shared' && e.scope !== tenant;
      })
      .map((e) => e.scope);
    for (const owner of owners) {
      const found = await store.get('Skill', owner, id, version);
      if (found?.definition.kind === 'Skill') return found.definition;
    }
    return undefined;
  };
  const sharedRecipe = sharedRecipeFinder(
    configEntries,
    () => late.store,
    platformTenant,
    'shared-now',
  );
  const store = input.definitions(plugins, sharedSkill, sharedRecipe);
  late.store = store;

  const prices: Record<string, unknown> = input.prices ?? {};
  const apply = (catalogs: EffectiveCatalogs) => {
    models.reload(catalogs.models);
    knowledge.reload(catalogs.knowledge);
    writers.reload(catalogs.knowledge);
    rerank.reload(catalogs.rerank);
    replaceSet(plugins.datasets, knowledge.datasets().keys());
    replaceSet(plugins.rerankers, rerank.rerankers());
    replaceRecord(prices, catalogs.prices);
  };
  const catalog = new CatalogRegistry({
    seed: {
      models: input.catalogs.models,
      knowledge: knowledgeSeed,
      rerank: input.catalogs.rerank,
      prices: { ...prices },
    },
    store: configEntries,
    checks: {
      models: (c) => problemsOf(parseCatalog(c, modelAdapters, [azureDeployments.kind])),
      knowledge: (c) => problemsOf(parseKnowledgeCatalog(c, knowledgeAdapters)),
      rerank: (c) => problemsOf(parseRerankCatalog(c, [colbert])),
    },
    apply,
    ...(input.catalogPolicy ? { policy: input.catalogPolicy } : {}),
    references: async () =>
      referencesOf((await store.capabilities()).map((c) => c.capability.config)),
    localEngines: () =>
      new Set(knowledgeAdapters.filter((a) => a.requiresBaseURL === false).map((a) => a.engine)),
    ...(input.derivedCatalog ? { derive: input.derivedCatalog } : {}),
    ...(input.now ? { now: input.now } : {}),
  });
  await catalog.initialize();
  released.catalog = catalog;

  const serviceLimits = { ...defaultServiceLimits, ...input.serviceLimits };
  const limited = (capability: KernelCapability): KernelCapability => ({
    ...capability,
    deadlineMs: capability.deadlineMs ?? serviceLimits.deadlineMs,
    budget: capability.budget ?? serviceLimits.budget,
  });
  const baseDecorate: CapabilityDecorator =
    input.decorate ?? skillDecorator(skillResolver({ definitions: store, configEntries }));
  const afterDecorate = input.decorateAfter?.(store);
  const decorate: CapabilityDecorator = afterDecorate
    ? async (capability, context) => afterDecorate(await baseDecorate(capability, context), context)
    : baseDecorate;
  const quarantine = new Map<string, QuarantinedDefinition>();
  const quarantineKey = (q: { tenant: string; kind: string; id: string; version: number }) =>
    `${q.kind}:${q.tenant}/${q.id}@${q.version}`;
  const sync = async () => {
    const found: QuarantinedDefinition[] = [];
    const at = new Date().toISOString();
    const reject = (invalid: InvalidStoredDefinition) => {
      const key = quarantineKey(invalid);
      found.push(quarantine.get(key) ?? { ...invalid, at });
    };
    const compiled = (await store.capabilities(reject)).filter(
      (c) => !found.some((q) => q.tenant === c.service.tenant && q.id === c.service.id),
    );
    const capabilities: KernelCapability[] = [];
    const companions: KernelCapability[] = [];
    grantNames.clear();
    for (const c of compiled)
      grantNames.set(c.capability.descriptor.id, [
        c.capability.descriptor.id,
        c.service.id,
        c.publicName,
        ...c.aliases,
        ...c.aliases.flatMap((a) => (a.includes('__') ? [a.slice(0, a.indexOf('__'))] : [])),
      ]);
    const failed = new Set<string>();
    for (const c of compiled) {
      const key = `${c.service.tenant}/${c.service.id}`;
      if (failed.has(key)) continue;
      try {
        const stored = await store.get('Service', c.service.tenant, c.service.id);
        const spec = (
          stored?.definition as { spec?: { batch?: { enabled?: boolean } } } | undefined
        )?.spec;
        const decorated = limited(
          await decorate(c.capability, {
            compiled: c,
            definition: stored?.definition,
            origin: 'service',
          }),
        );
        const companion = spec?.batch?.enabled ? [batchCapabilityFor(c)] : [];
        for (const capability of [decorated, ...companion])
          checkCapability({ strategies, ports }, capability);
        capabilities.push(decorated);
        companions.push(...companion);
      } catch (error) {
        failed.add(key);
        reject({
          kind: 'Service',
          tenant: c.service.tenant,
          id: c.service.id,
          version: c.service.version,
          errors: [{ path: '', message: error instanceof Error ? error.message : String(error) }],
        });
      }
    }
    const kept = (c: KernelCapability) =>
      !failed.has(`${c.descriptor.tenant}/${c.descriptor.id.split('/')[1] ?? ''}`);
    registry.replace(
      (c) => !c.descriptor.id.startsWith('platform/'),
      [...capabilities.filter(kept), ...companions.filter(kept)],
    );
    for (const q of found)
      if (!quarantine.has(quarantineKey(q)))
        input.logger?.('definition quarantined', {
          tenant: q.tenant,
          kind: q.kind,
          id: q.id,
          version: q.version,
          errors: q.errors,
        });
    quarantine.clear();
    for (const q of found) quarantine.set(quarantineKey(q), q);
  };
  await sync();

  return {
    kernel,
    registry,
    ports,
    strategies,
    plugins,
    store,
    sharedRecipe,
    catalog,
    models,
    knowledge,
    rerank,
    embedders,
    writers,
    tools,
    mcp,
    connections,
    vault,
    blobStore,
    settings,
    configEntries,
    hookRuntime,
    rules,
    ruleHooks,
    prices,
    blocks,
    log,
    catalogSecrets,
    modelAdapters,
    knowledgeAdapters,
    writerAdapters,
    knowledgeSeed,
    embeddingModels,
    defaultEmbedding,
    embeddingResidency,
    residencyOf,
    limited,
    decorate,
    refreshTools,
    sync,
    quarantined: () => [...quarantine.values()],
  };
};

export type Runtime = Awaited<ReturnType<typeof createRuntime>>;

const replaceSet = (target: Set<string> | undefined, values: Iterable<string>) => {
  if (!target) return;
  target.clear();
  for (const v of values) target.add(v);
};

const replaceRecord = (target: Record<string, unknown>, values: Record<string, unknown>) => {
  for (const key of Object.keys(target)) Reflect.deleteProperty(target, key);
  Object.assign(target, values);
};

const problemsOf = (result: { ok: boolean; errors?: { path: string; message: string }[] }) =>
  result.ok ? [] : (result.errors ?? []);
