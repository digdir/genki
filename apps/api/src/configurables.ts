import type { Principal } from '@genai/contracts';
import {
  referencesOf,
  type CatalogPolicy,
  type CatalogRegistry,
  type GuardrailRuleRegistry,
} from '@genai/composition';
import type { Definition } from '@genai/definitions';
import type { Gate, TestSetStore } from '@genai/eval';
import type { IndexWriterRouter, KnowledgeAdapter, KnowledgeRouter } from '@genai/port-knowledge';
import type { Residency } from '@genai/port-model';
import type { Env, Hono, Schema } from 'hono';
import type { Admin } from './admin.js';
import { configAdminHandlers, ingestionTarget, registerConfigRoutes } from './config-routes.js';
import { platformScope, type ConfigEntryStore } from './config-store.js';
import {
  InMemoryExecutionStore,
  IngestionService,
  pendingIngestionBackend,
  type ExecutionStore,
  type IngestionBackend,
} from './ingestion.js';
import type { EngineDescription } from './knowledge-engines.js';
import { createGateRegistry } from './scoped-registry.js';

type Seed = { id: string; spec: unknown; mandatory?: boolean }[];

export interface ConfigurablesInput {
  store?: ConfigEntryStore;
  executions?: ExecutionStore;
  ingestion?: IngestionBackend;
  catalogPolicy?: CatalogPolicy;
  gateSeed?: Seed;
  ruleSeed?: Seed;
  now?: () => Date;
  scheduleIntervalMs?: number;
  admitsIngestion?: (principal: Principal | undefined) => boolean;
  onWarning?: (message: string) => void;
}

const countTtlMs = 5 * 60_000;

export const cachedDocumentCount = (knowledge: KnowledgeRouter) => {
  const cache = new Map<string, { at: number; count: number | undefined }>();
  return async (input: { dataset: string; tenant: string; principal: Principal }) => {
    const cached = cache.get(input.dataset);
    if (cached && Date.now() - cached.at < countTtlMs) return cached.count;
    const port = knowledge.open(
      { kind: 'dataset', id: input.dataset, tenant: input.tenant },
      {
        tenant: input.tenant,
        principal: input.principal,
        task: `dataset-count-${crypto.randomUUID()}`,
        signal: AbortSignal.timeout(5_000),
        meter: async () => undefined,
      },
    );
    const count = (await port.documents?.({ limit: 1 }))?.found;
    cache.set(input.dataset, { at: Date.now(), count });
    return count;
  };
};

export const createConfigurables = (
  input: ConfigurablesInput & {
    store: ConfigEntryStore;
    rules: GuardrailRuleRegistry;
    builtinGates: Map<string, Gate>;
    platformTenant: string;
  },
) => {
  const { store, rules } = input;
  const gates = createGateRegistry({
    store,
    builtins: input.builtinGates,
    ...(input.gateSeed ? { seed: input.gateSeed } : {}),
    ...(input.now ? { now: input.now } : {}),
  });

  const gatesFor = async (tenant: string, listed: string[], testSets: string[]) => {
    const registry = await gates.forTenant(tenant);
    const mandatory = testSets.length > 0 ? (await gates.mandatory()).map((g) => g.id) : [];
    return { registry, gates: [...new Set([...listed, ...mandatory])] };
  };

  const attach = async (deps: {
    catalog: CatalogRegistry;
    routers: {
      knowledge: KnowledgeRouter;
      writers?: IndexWriterRouter;
    };
    engines?: () => EngineDescription[];
    ingestion?: IngestionBackend;
    adapters: { knowledge: KnowledgeAdapter[] };
    embeddingResidency?: (model: string) => Residency | undefined;
    testSets: TestSetStore;
  }) => {
    const { catalog } = deps;
    const ingestion = new IngestionService({
      store,
      executions: input.executions ?? new InMemoryExecutionStore(),
      backend: input.ingestion ?? deps.ingestion ?? pendingIngestionBackend(),
      ...(input.now ? { now: input.now } : {}),
      ...(input.admitsIngestion ? { admits: input.admitsIngestion } : {}),
      ...(input.onWarning ? { onRefused: input.onWarning, onError: input.onWarning } : {}),
    });
    const closeStaleRuns = () =>
      ingestion
        .failStaleRuns()
        .catch((error: unknown) =>
          input.onWarning?.(`could not close stale ingestion runs: ${String(error)}`),
        );
    await closeStaleRuns();
    const configDeps = {
      catalog,
      gates,
      rules,
      ingestion,
      testSets: deps.testSets,
      engines: deps.engines ?? (() => []),
      adapters: deps.adapters.knowledge,
      ...(deps.routers.writers ? { writers: deps.routers.writers } : {}),
      ...(deps.embeddingResidency ? { embeddingResidency: deps.embeddingResidency } : {}),
      documentCount: cachedDocumentCount(deps.routers.knowledge),
    };

    const publishProblems = async (definition: Definition) => {
      if (definition.kind !== 'Service') return [];
      const tenant = definition.metadata.tenant;
      const spec = definition.spec as {
        model?: Record<string, unknown>;
        knowledge?: { datasets?: { dataset: string }[] };
        guardrails?: Record<string, unknown>;
      };
      const problems: { path: string; message: string }[] = [];
      const privateTo = (scope: string | undefined) =>
        scope !== undefined && scope !== platformScope && scope !== tenant;
      const used = referencesOf([{ model: spec.model, knowledge: spec.knowledge }]);
      for (const model of used.models)
        if (privateTo(catalog.get('model', model)?.scope))
          problems.push({
            path: 'spec.model',
            message: `model ${model} belongs to another tenant`,
          });
      for (const dataset of used.datasets) {
        const id = deps.routers.knowledge.resolve(dataset) ?? dataset;
        if (privateTo(catalog.get('dataset', id)?.scope))
          problems.push({
            path: 'spec.knowledge.datasets',
            message: `dataset ${dataset} belongs to another tenant`,
          });
      }
      const custom = spec.guardrails?.['custom-rules'];
      if (Array.isArray(custom)) {
        const known = await rules.forTenant(tenant);
        custom.forEach((entry, i) => {
          if (typeof entry !== 'string') return;
          const id = entry.startsWith(`${tenant}/`) ? entry.slice(tenant.length + 1) : entry;
          if (!known.has(id))
            problems.push({
              path: `spec.guardrails.custom-rules[${i}]`,
              message: `unknown guardrail rule ${entry}`,
            });
        });
      }
      return problems;
    };

    const runSchedules = () =>
      ingestion.runDue((pipeline) => {
        const item = catalog.get('dataset', pipeline.dataset);
        return item ? ingestionTarget(item) : undefined;
      }, platformScope);
    let ticking = false;

    return {
      catalog,
      ingestion,
      publishProblems,
      runSchedules,
      extensions: configAdminHandlers(configDeps),
      mount: <E extends Env, S extends Schema, B extends string>(
        app: Hono<E, S, B>,
        admin: Admin,
        authenticate: (request: Request) => Promise<Principal | undefined>,
      ) => {
        registerConfigRoutes(app, {
          ...configDeps,
          admin,
          authenticate,
          platformTenant: input.platformTenant,
        });
        const interval = input.scheduleIntervalMs ?? 60_000;
        if (interval > 0 && !ticking) {
          ticking = true;
          setInterval(() => void runSchedules().catch(() => undefined), interval).unref();
          setInterval(() => void closeStaleRuns(), interval).unref();
        }
      },
    };
  };

  return { store, gates, rules, gatesFor, attach };
};

export type Configurables = ReturnType<typeof createConfigurables>;
export type AttachedConfigurables = Awaited<ReturnType<Configurables['attach']>>;
