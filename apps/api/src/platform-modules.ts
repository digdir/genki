import type { Event, Principal, Task } from '@genai/contracts';
import type {
  DefinitionStore,
  PluginSchemas,
  SettingsRegistry,
  ValidationError,
} from '@genai/definitions';
import type { CandidateStore, EvalRunStore, FeedbackStore, TestSetStore } from '@genai/eval';
import type { Capability as KernelCapability, Kernel, TaskStore } from '@genai/kernel';
import type { TriggerRunStore } from '@genai/jobs';
import type { BlobStore } from '@genai/port-blob';
import type { IndexWriterRouter, KnowledgeRouter } from '@genai/port-knowledge';
import type { ModelRouter, Residency } from '@genai/port-model';
import type { ConnectionRegistry } from '@genai/providers-mcp-client';
import type { Env, Hono, Schema } from 'hono';
import type { Access } from './access.js';
import type { Admin, AdminHandler } from './admin.js';
import type { CatalogRegistry } from './catalog-registry.js';
import type { ChangeTopic } from './change-feed.js';
import type { ConfigEntryStore } from './config-store.js';
import type { ApiLog } from './failure-log.js';
import type { DraftDecoration, DraftRunner, ModelPrice } from './draft-runner.js';
import type { TaskIndex } from './extensions.js';
import type { IngestSourceOptions } from './index-ingestion.js';
import type { IngestionService } from './ingestion.js';
import type { EngineDescription } from './knowledge-engines.js';
import type { SearchModuleExtras } from './knowledge-endpoints.js';
import type { createWebhooks } from './webhooks.js';
import type { HookRuntime } from './hooks.js';
import type { ContractSetup, PluginRegistry } from '@genai/plugins';
import type { ExternalPlugin, PluginRuntime } from './external-plugins.js';
import type { ConnectionToolSource } from '@genai/providers-mcp-client';

export interface ModuleDeps extends Omit<SearchModuleExtras, 'now'> {
  platformTenant: string;
  catalog: CatalogRegistry;
  definitions: DefinitionStore;
  plugins: PluginSchemas;
  settings: SettingsRegistry;
  configEntries: ConfigEntryStore;
  models: ModelRouter;
  knowledge: KnowledgeRouter;
  writers: IndexWriterRouter;
  engines(): EngineDescription[];
  ingestion: IngestionService;
  modelAdmission?: (principal: Principal) => boolean;
  readOnly?: (principal: Principal) => boolean;
  evalStores: {
    testSets: TestSetStore;
    runs: EvalRunStore;
    feedback: FeedbackStore;
    candidates: CandidateStore;
  };
  connections: ConnectionRegistry;
  blobs: BlobStore;
  prices: Record<string, ModelPrice>;
  quota?(
    tenant: string,
    options?: { fresh?: boolean },
  ): Promise<{ usedTokens: number; monthlyTokens: number; exhausted: boolean }>;
  drafts: DraftRunner;
  pinService?(tenant: string, service: string, version: number): Promise<string | undefined>;
  kernel: Kernel;
  tasks: TaskIndex;
  task(id: string): Promise<Task | undefined>;
  events(task: string): AsyncIterable<Event>;
  webhooks: ReturnType<typeof createWebhooks>;
  sync(): Promise<void>;
  onChange(topic: ChangeTopic, listener: () => void | Promise<void>): () => void;
  ingestSources?: IngestSourceOptions;
  vault?: {
    set(tenant: string, name: string, value: string): Promise<string>;
    delete(tenant: string, name: string): Promise<void>;
  };
  defaultEmbedding?: { model: string; dimensions: number; residency: Residency };
  hookRuntime?: HookRuntime;
  logger?: ApiLog;
  triggerRuns?: TriggerRunStore;
  pluginRegistry?: PluginRegistry;
  externalPlugins?: {
    protocols: Record<string, string[]>;
    target(plugin: ExternalPlugin): ContractSetup<unknown> | undefined;
    runtime?: PluginRuntime;
    tools?: { source: ConnectionToolSource; changed(tenant: string): Promise<void> };
  };
}

export interface MountDeps extends ModuleDeps {
  admin: Admin;
  authenticate(request: Request): Promise<Principal | undefined>;
  access: Access;
}

export type CapabilityContext = DraftDecoration;

export interface FeedbackGiven {
  tenant: string;
  service: string;
  task: string;
  rating: 'up' | 'down';
  reasons?: string[];
  comment?: string;
}

export interface PlatformModule {
  id: string;
  handlers?: Record<string, AdminHandler>;
  mount<E extends Env, S extends Schema, B extends string>(
    app: Hono<E, S, B>,
    deps: MountDeps,
  ): void;
  decorateCapability?(
    capability: KernelCapability,
    context: CapabilityContext,
  ): KernelCapability | Promise<KernelCapability>;
  checkPublish?(definition: unknown): Promise<ValidationError[]>;
  onFeedback?(feedback: FeedbackGiven): Promise<void>;
  qualityOverview?(): Promise<Record<string, unknown>>;
}

export type PlatformModuleFactory = (deps: ModuleDeps) => PlatformModule;

export const decorateWith =
  (modules: () => PlatformModule[]) =>
  async (capability: KernelCapability, context: CapabilityContext) => {
    let current = capability;
    for (const platformModule of modules())
      if (platformModule.decorateCapability)
        current = await platformModule.decorateCapability(current, context);
    return current;
  };

export const feedbackToModules = (
  store: FeedbackStore,
  tasks: TaskStore,
  modules: () => PlatformModule[],
): FeedbackStore => ({
  save: async (record) => {
    await store.save(record);
    const listeners = modules().filter((m) => m.onFeedback);
    if (listeners.length === 0) return;
    void tasks
      .get(record.task)
      .then(async (found) => {
        if (!found) return;
        const given: FeedbackGiven = {
          tenant: found.task.owner,
          service: found.task.service.capability.id,
          task: record.task,
          rating: record.rating,
          ...(record.reasons ? { reasons: record.reasons } : {}),
          ...(record.comment ? { comment: record.comment } : {}),
        };
        for (const m of listeners) await m.onFeedback?.(given).catch(() => undefined);
      })
      .catch(() => undefined);
  },
  list: (tenant, filter) => store.list(tenant, filter),
});
