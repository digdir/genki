import type { Principal, Ref } from '@genai/contracts';
import {
  compareRetrieval,
  retrievalCases,
  type RetrievalCase,
  type RetrievalComparison,
  type RetrievalRun,
} from '@genai/eval';
import { embedIndexDocument } from '@genai/ingest';
import type { PortContext } from '@genai/kernel';
import {
  KnowledgeError,
  type DatasetEmbedding,
  type DatasetOverrides,
  type IndexDocument,
  type IndexWriterRoute,
  type IndexWriterRouter,
  type KnowledgePort,
  type Residency,
} from '@genai/port-knowledge';
import type { Context } from 'hono';
import { AdminRefused, refusedBy, routeOnlyActions } from './admin.js';
import type { CatalogItem } from './catalog-registry.js';
import { appendVersion, platformScope, type ConfigEntry } from './config-store.js';
import { indexIngestionBackend } from './index-ingestion.js';
import {
  engineOf,
  problem,
  runsAtOf,
  searchExtras,
  summarizeCapabilities,
  type CapabilitySummary,
  type SearchModuleExtras,
} from './knowledge-endpoints.js';
import { writeKeyEngines } from './knowledge-engines.js';
import type { MountDeps, ModuleDeps, PlatformModule } from './platform-modules.js';
import { enterTenant } from './access.js';
import { t } from './i18n/index.js';
import { changeReasonOf, isReasonLongEnough, minimumReasonLength, reasonTooShort } from './http.js';

export const switchStates = [
  'running',
  'failed',
  'comparing',
  'ready',
  'active',
  'rolled_back',
  'cancelled',
] as const;
export type SwitchState = (typeof switchStates)[number];
export type SwitchMethod = 'copy' | 'reingest';

const openStates: SwitchState[] = ['running', 'failed', 'comparing', 'ready'];
const jobStates: SwitchState[] = ['running', 'comparing'];

export interface Range {
  min: number;
  max: number;
}

export interface MethodEstimate {
  available: boolean;
  reason?: string;
  costNok: Range;
  durationMinutes: Range;
}

export interface SwitchEstimate {
  dataset: string;
  from: string;
  to: string;
  estimate: true;
  basis: { documents: number; counted: boolean };
  method?: SwitchMethod;
  copy: MethodEstimate;
  reingest: MethodEstimate;
}

export interface SwitchProgress {
  percent: number;
  documents: number;
  total?: number;
}

export interface SwitchDecision {
  action: 'activate' | 'rollback' | 'cancel';
  by: string;
  at: string;
  reason: string;
}

export interface GenerationCleanup {
  endpoint: string;
  generation: string;
  dropped?: string;
  failed?: string;
}

export interface EngineSwitchSpec {
  dataset: string;
  from: string;
  to: string;
  method: SwitchMethod;
  state: SwitchState;
  reason?: string;
  embedding?: DatasetEmbedding;
  options?: Record<string, unknown>;
  estimate: { costNok: Range; durationMinutes: Range };
  progress: SwitchProgress;
  attempt: number;
  generation: string;
  startedAt: string;
  startedBy: string;
  updatedAt: string;
  heartbeatAt?: string;
  error?: { message: string; percent: number };
  comparison?: RetrievalComparison;
  comparisonNote?: string;
  datasetVersion: number;
  previous?: {
    endpoint: string;
    keptUntil: string;
    catalogVersion: number;
    spec: Record<string, unknown>;
    expired?: boolean;
  };
  activatedVersion?: number;
  decisions: SwitchDecision[];
  cleanup: GenerationCleanup[];
  modelsAdmitted?: boolean;
}

export interface EngineSwitchView {
  id: string;
  sid: string;
  version: number;
  dataset: string;
  from: string;
  to: string;
  method: SwitchMethod;
  state: SwitchState;
  reason?: string;
  embedding?: DatasetEmbedding;
  estimate: { costNok: Range; durationMinutes: Range };
  progress: SwitchProgress;
  attempt: number;
  startedAt: string;
  startedBy: string;
  updatedAt: string;
  error?: { message: string; percent: number };
  comparison?: RetrievalComparison;
  comparisonNote?: string;
  minimumReasonLength: number;
  previousKeptUntil?: string;
  canRollback: boolean;
  decision?: SwitchDecision;
}

export interface ServiceUse {
  tenant: string;
  id: string;
  name: string;
}

export interface DatasetEngineView {
  dataset: string;
  endpoint: string;
  engine: string;
  title: string;
  tech?: string;
  builtin: boolean;
  runsAt: string;
  dataLocation?: Residency;
  embedding: DatasetEmbedding | null;
  capabilities: CapabilitySummary;
  latencyMs?: number;
  usedBy: ServiceUse[];
  canSwitch: boolean;
  retentionDays: number;
  activeSwitch?: EngineSwitchView;
  previous?: { endpoint: string; title: string; keptUntil: string; switch: string };
}

export interface EngineSwitchesModule extends PlatformModule {
  sweep(): Promise<{ ran: boolean; stalled: number; dropped: number; expired: number }>;
}

export interface EngineSwitchOptions extends SearchModuleExtras {
  sweepIntervalMs?: number;
  heartbeatMs?: number;
  staleAfterMs?: number;
}

const kind = 'engine-switch';
const leaseKind = 'engine-switch-lease';
const stalledMessage = 'Overføringen stoppet. Start den på nytt.';
const systemActor = 'platform:engine-switch';

export const engineSwitchActions = [
  'platform.engine-switch.start',
  'platform.engine-switch.retry',
  'platform.engine-switch.cancel',
] as const;

class Refusal extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
    readonly path = 'to',
    readonly detail?: string,
  ) {
    super(message);
  }
}

class Stopped extends Error {}

type Guard = (
  c: Context,
  right?: 'manage-datasets',
) => Promise<{ response: Response } | { principal: Principal; tenant: string }>;

const actor = (p: Principal) => `${p.kind}:${p.issuer}:${p.subject}`;

const record = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const shortOf = (scope: string, id: string) =>
  id.startsWith(`${scope}/`) ? id.slice(scope.length + 1) : id;

const range = (value: number, unit: number): Range => ({
  min: Math.max(unit, Math.round((value * 0.8) / unit) * unit),
  max: Math.max(unit, Math.ceil((value * 1.3) / unit) * unit),
});

const chunksPerDocument = 8;
const tokensPerChunk = 300;
const defaultEmbeddingNokPerThousand = 0.0013;
const defaultModelPrice = { inputPerThousand: 0.025, outputPerThousand: 0.1 };

const hasVectors = (doc: IndexDocument, dimensions: number) =>
  [...doc.chunks, ...doc.phrases].every((t) => t.vector?.length === dimensions);

const countOf = async (items: AsyncIterable<unknown>, cap: number) => {
  const iterator = items[Symbol.asyncIterator]();
  let count = 0;
  while (count < cap && !(await iterator.next()).done) count++;
  await iterator.return?.();
  return count;
};

const withoutVectors = (doc: IndexDocument): IndexDocument => ({
  ...doc,
  chunks: doc.chunks.map(({ vector: _vector, ...rest }) => rest),
  phrases: doc.phrases.map(({ vector: _vector, ...rest }) => rest),
});

export const createEngineSwitchesModule =
  (options: EngineSwitchOptions = {}) =>
  (deps: ModuleDeps): EngineSwitchesModule => {
    const extras = searchExtras(deps, options);
    const now = () => extras.now?.() ?? new Date();
    const store = deps.configEntries;
    const catalog = deps.catalog;
    const instance = crypto.randomUUID();
    const heartbeatMs = options.heartbeatMs ?? 30_000;
    const staleAfterMs = options.staleAfterMs ?? 2 * 60_000;
    const jobs = new Map<string, AbortController>();
    const probes = new Map<string, { at: number; ms?: number }>();
    let mounted: MountDeps | undefined;

    const systemPrincipal = (tenant: string): Principal => ({
      kind: 'agency-system',
      issuer: 'platform',
      subject: 'engine-switch',
      tenant,
    });
    const tenantOf = (scope: string) => (scope === platformScope ? deps.platformTenant : scope);
    const contextFor = (scope: string, task: string, signal: AbortSignal): PortContext => ({
      tenant: tenantOf(scope),
      principal: systemPrincipal(tenantOf(scope)),
      task,
      signal,
      meter: async () => undefined,
    });

    const retentionDays = (scope: string) => {
      const effective = deps.settings.effective(tenantOf(scope)) as Record<
        string,
        { value?: unknown }
      >;
      const days = effective['knowledge.switchRetentionDays']?.value;
      return typeof days === 'number' && days > 0 ? days : 14;
    };

    const endpointFor = (tenant: string, ref: string) =>
      catalog
        .visibleTo(tenant)
        .find(
          (i) =>
            i.kind === 'knowledge-endpoint' &&
            (i.id === catalog.qualify(tenant, ref) || i.id === ref),
        );

    const ownDataset = (tenant: string, id: string) => {
      const item = catalog.get('dataset', catalog.qualify(tenant, id));
      return item?.scope === tenant ? item : undefined;
    };
    const visibleDataset = (tenant: string, id: string) =>
      catalog
        .visibleTo(tenant)
        .find((i) => i.kind === 'dataset' && (i.id === id || i.id === catalog.qualify(tenant, id)));

    const overridesOf = (
      spec: Pick<EngineSwitchSpec, 'embedding' | 'options'>,
    ): DatasetOverrides => ({
      ...(spec.embedding ? { embedding: spec.embedding } : {}),
      ...(spec.options ? { datasetOptions: spec.options } : {}),
    });

    const sourceEngine = (item: CatalogItem) =>
      catalog.get('knowledge-endpoint', String(item.spec.endpoint))?.spec.engine;

    const exporterOf = (item: CatalogItem, signal: AbortSignal) => {
      try {
        return deps.knowledge.open(
          { kind: 'dataset', id: item.id, tenant: tenantOf(item.scope) },
          contextFor(item.scope, `engine-switch:${item.id}`, signal),
        ).export;
      } catch {
        return undefined;
      }
    };

    const sourceDocuments = (
      item: CatalogItem,
      signal: AbortSignal,
    ): AsyncIterable<IndexDocument> => {
      const exporter = exporterOf(item, signal);
      if (exporter) return exporter.documents();
      const route = deps.writers.open(item.id, { signal });
      if (!route.writer.read)
        throw new KnowledgeError('unsupported', `${route.engine} cannot hand over its documents`);
      return route.writer.read(route.dataset);
    };

    const readable = (item: CatalogItem) => {
      if (exporterOf(item, AbortSignal.timeout(1000))) return true;
      try {
        return Boolean(
          deps.writers.open(item.id, { signal: AbortSignal.timeout(1000) }).writer.read,
        );
      } catch {
        return false;
      }
    };

    const exportedWithoutVectors = (item: CatalogItem) =>
      exporterOf(item, AbortSignal.timeout(1000))?.vectors === false;

    const countDocuments = async (item: CatalogItem, cap = 100_000) => {
      const signal = AbortSignal.timeout(60_000);
      const exporter = exporterOf(item, signal);
      if (exporter) return exporter.count(cap);
      return countOf(sourceDocuments(item, signal), cap);
    };

    interface Plan {
      target: CatalogItem;
      engine: string;
      embedding?: DatasetEmbedding;
      needsVectors: boolean;
      copyProblem?: string;
      reingestProblem?: string;
    }

    const planFor = async (
      tenant: string,
      item: CatalogItem,
      to: string,
      body: { embedding?: DatasetEmbedding },
    ): Promise<Plan> => {
      if (!to) throw new Refusal(400, t('operations.switchChooseEngine'));
      const target = endpointFor(tenant, to);
      if (!target) throw new Refusal(404, t('operations.switchUnknownEngine', { to }));
      if (target.id === item.spec.endpoint)
        throw new Refusal(409, t('operations.switchSameEngine'));
      const engine = String(target.spec.engine);
      if (writeKeyEngines.has(engine))
        throw new Refusal(409, t('operations.switchWriteKeyRequired'));
      if (!deps.writers.engines().includes(engine))
        throw new Refusal(409, t('operations.switchCannotWrite'));
      if (engine === sourceEngine(item) && engineOf(deps, engine)?.builtin)
        throw new Refusal(409, t('operations.switchSharedStorage'));
      const description = engineOf(deps, engine);
      const needsVectors = description?.writer?.needsVectors ?? false;
      const current = item.spec.embedding as DatasetEmbedding | undefined;
      const embedding = body.embedding ?? current;
      const missingModel =
        needsVectors && embedding && !extras.embedders?.has(embedding.model)
          ? t('operations.switchMissingModel', { model: embedding.model })
          : undefined;
      const copyProblem =
        missingModel ??
        (current && embedding && current.model !== embedding.model
          ? t('operations.switchCopyNeedsSameModel', {
              current: current.model,
              wanted: embedding.model,
            })
          : !readable(item)
            ? t('operations.switchCannotRead')
            : undefined);
      const pipelines = (await deps.ingestion.list(tenant, item.id)).filter((p) => p.spec.enabled);
      const reingestProblem =
        missingModel ?? (pipelines.length === 0 ? t('operations.switchNoPipeline') : undefined);
      return {
        target,
        engine,
        ...(embedding ? { embedding } : {}),
        needsVectors,
        ...(copyProblem ? { copyProblem } : {}),
        ...(reingestProblem ? { reingestProblem } : {}),
      };
    };

    const estimateFor = async (
      tenant: string,
      item: CatalogItem,
      plan: Plan,
    ): Promise<Omit<SwitchEstimate, 'method'>> => {
      const { documents, counted } = await countDocuments(item, 20_000).then(
        (found) => ({ documents: found, counted: true }),
        () => ({ documents: 1000, counted: false }),
      );
      const chunks = documents * chunksPerDocument;
      const embeddingPrice = plan.embedding
        ? (deps.prices[plan.embedding.model]?.inputPerThousand ?? defaultEmbeddingNokPerThousand)
        : 0;
      const sourceHasVectors = !exportedWithoutVectors(item) && Boolean(item.spec.embedding);
      const reembeds = plan.needsVectors && Boolean(plan.embedding) && !sourceHasVectors;
      const embedCost =
        plan.needsVectors && plan.embedding ? (chunks * tokensPerChunk * embeddingPrice) / 1000 : 0;
      const copyCost = reembeds ? embedCost : 0;
      const copyMinutes = 2 + documents * (reembeds ? 0.01 : 0.002);
      const pipelines = (await deps.ingestion.list(tenant, item.id)).filter((p) => p.spec.enabled);
      const phraseCost = pipelines.reduce((sum, p) => {
        if (!p.spec.phrases) return sum;
        const price = deps.prices[p.spec.phrases.model] ?? defaultModelPrice;
        return (
          sum + (chunks * (1000 * price.inputPerThousand + 100 * price.outputPerThousand)) / 1000
        );
      }, 0);
      const parallelism = Math.max(1, ...pipelines.map((p) => p.spec.parallelism));
      const reingestMinutes =
        5 + (documents * 4 * Math.max(1, pipelines.length)) / parallelism / 60;
      const method = (
        problemText: string | undefined,
        cost: number,
        minutes: number,
      ): MethodEstimate => ({
        available: problemText === undefined,
        ...(problemText ? { reason: problemText } : {}),
        costNok: range(cost, 1),
        durationMinutes: range(minutes, 1),
      });
      return {
        dataset: item.id,
        from: String(item.spec.endpoint),
        to: plan.target.id,
        estimate: true,
        basis: { documents, counted },
        copy: method(plan.copyProblem, copyCost, copyMinutes),
        reingest: method(plan.reingestProblem, embedCost + phraseCost, reingestMinutes),
      };
    };

    const minimumReason = (spec: EngineSwitchSpec) =>
      spec.comparison?.verdict === 'worse' ? 20 : minimumReasonLength;

    const viewOf = (entry: ConfigEntry<unknown>): EngineSwitchView => {
      const spec = entry.spec as EngineSwitchSpec;
      const keptUntil = spec.previous?.keptUntil;
      const decision = spec.decisions.at(-1);
      return {
        id: entry.id,
        sid: entry.id.slice(entry.id.lastIndexOf(':') + 1),
        version: entry.version,
        dataset: spec.dataset,
        from: spec.from,
        to: spec.to,
        method: spec.method,
        state: spec.state,
        ...(spec.reason ? { reason: spec.reason } : {}),
        ...(spec.embedding ? { embedding: spec.embedding } : {}),
        estimate: spec.estimate,
        progress: spec.progress,
        attempt: spec.attempt,
        startedAt: spec.startedAt,
        startedBy: spec.startedBy,
        updatedAt: spec.updatedAt,
        ...(spec.error ? { error: spec.error } : {}),
        ...(spec.comparison ? { comparison: spec.comparison } : {}),
        ...(spec.comparisonNote ? { comparisonNote: spec.comparisonNote } : {}),
        minimumReasonLength: minimumReason(spec),
        ...(keptUntil ? { previousKeptUntil: keptUntil } : {}),
        canRollback:
          spec.state === 'active' &&
          keptUntil !== undefined &&
          new Date(keptUntil).getTime() > now().getTime(),
        ...(decision ? { decision } : {}),
      };
    };

    const switchesOf = async (tenant: string, dataset: string) =>
      (await store.latest({ kind, scope: tenant }))
        .filter((e) => !e.deleted && (e.spec as EngineSwitchSpec).dataset === dataset)
        .sort((a, b) => Number(a.id.split(':').pop()) - Number(b.id.split(':').pop()));

    const entryOf = async (tenant: string, item: CatalogItem, sid: string) => {
      const id = sid.includes(':') ? sid : `${shortOf(tenant, item.id)}:${sid}`;
      const entry = (await store.history(kind, tenant, id)).at(-1);
      return entry && (entry.spec as EngineSwitchSpec).dataset === item.id ? entry : undefined;
    };

    const update = async (
      scope: string,
      id: string,
      change: (spec: EngineSwitchSpec) => EngineSwitchSpec | undefined,
      by: string,
      reason: string,
    ): Promise<ConfigEntry<unknown> | undefined> => {
      for (let attempt = 0; ; attempt++) {
        const last = (await store.history(kind, scope, id)).at(-1);
        if (!last) return undefined;
        const next = change(structuredClone(last.spec as EngineSwitchSpec));
        if (!next) return undefined;
        try {
          return await appendVersion(store, {
            kind,
            scope,
            id,
            spec: { ...next, updatedAt: now().toISOString() },
            deleted: false,
            by,
            reason,
            at: now().toISOString(),
            ifVersion: last.version,
          });
        } catch (error) {
          if (attempt >= 4) throw error;
        }
      }
    };

    const timedSearch = async (
      port: () => KnowledgePort,
      question: string,
    ): Promise<RetrievalRun> => {
      const started = performance.now();
      try {
        const result = await port().search({ query: question, limit: 10 });
        return {
          hits: result.hits.map((hit) => ({
            chunkId: hit.id,
            ...(hit.document !== undefined ? { document: hit.document } : {}),
            ...(hit.position !== undefined ? { position: hit.position } : {}),
            ...(hit.title !== undefined ? { title: hit.title } : {}),
          })),
          latencyMs: performance.now() - started,
        };
      } catch (error) {
        return {
          hits: [],
          latencyMs: performance.now() - started,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const compare = async (
      scope: string,
      item: CatalogItem,
      spec: EngineSwitchSpec,
      signal: AbortSignal,
    ) => {
      const short = shortOf(scope, item.id);
      const sets = (await deps.evalStores.testSets.list(scope)).filter(
        (s) => s.spec.corpus === short || s.spec.corpus === item.id,
      );
      const cases: RetrievalCase[] = sets.flatMap((s) =>
        retrievalCases(s.spec.cases).map((c) => ({ ...c, id: `${s.metadata.id}/${c.id}` })),
      );
      if (cases.length === 0)
        return { note: 'Datasettet har ikke noe testsett med forventede kilder.' };
      const ctx = contextFor(scope, `engine-switch:${item.id}`, signal);
      const ref: Ref = { kind: 'dataset', id: item.id, tenant: tenantOf(scope) };
      const old: Record<string, RetrievalRun> = {};
      const next: Record<string, RetrievalRun> = {};
      for (const c of cases) {
        if (signal.aborted) throw new Stopped();
        old[c.id] = await timedSearch(() => deps.knowledge.open(ref, ctx), c.question);
        next[c.id] = await timedSearch(
          () => deps.knowledge.openAt(ref, spec.to, ctx, overridesOf(spec)),
          c.question,
        );
      }
      return {
        comparison: compareRetrieval({
          cases,
          old,
          new: next,
          testSets: sets.map((s) => s.metadata.id),
        }),
      };
    };

    const retargeted = (spec: EngineSwitchSpec): IndexWriterRouter =>
      Object.assign(Object.create(deps.writers) as IndexWriterRouter, {
        supports: () => true,
        open: (_id: string, context: { signal: AbortSignal }) =>
          deps.writers.openAt(spec.dataset, spec.to, context, overridesOf(spec)),
      });

    const copyInto = async (
      scope: string,
      item: CatalogItem,
      route: IndexWriterRoute,
      spec: EngineSwitchSpec,
      signal: AbortSignal,
      report: (done: number, total: number) => Promise<void>,
    ) => {
      const total = await countDocuments(item);
      const embedding = route.needs.vectors ? route.dataset.embedding : undefined;
      const embedder =
        embedding && extras.embedders
          ? extras.embedders.open(
              { kind: 'embedder', id: embedding.model },
              contextFor(scope, `engine-switch:${item.id}`, signal),
            )
          : undefined;
      await route.writer.prepare(route.dataset, spec.generation);
      let done = 0;
      for await (const doc of sourceDocuments(item, signal)) {
        if (signal.aborted) throw new Stopped();
        let stored = withoutVectors(doc);
        if (embedding) {
          if (hasVectors(doc, embedding.dimensions) && doc.embeddingModel === embedding.model)
            stored = doc;
          else if (embedder) stored = await embedIndexDocument(stored, embedder);
          else throw new Error(`no embedder for ${embedding.model}`);
        }
        await route.writer.store(route.dataset, spec.generation, stored);
        await report(++done, total);
      }
      return route.writer.promote(route.dataset, spec.generation);
    };

    const reingestInto = async (
      scope: string,
      item: CatalogItem,
      spec: EngineSwitchSpec,
      signal: AbortSignal,
      report: (done: number, total: number) => Promise<void>,
    ) => {
      const pipelines = (await deps.ingestion.list(scope, item.id)).filter((p) => p.spec.enabled);
      const backend = indexIngestionBackend({
        writers: retargeted(spec),
        residencyOf: (dataset) => deps.knowledge.datasets().get(dataset)?.residency,
        ...(extras.embedders ? { embedders: extras.embedders } : {}),
        models: deps.models,
        catalog: deps.catalog,
        platformTenant: deps.platformTenant,
        ...deps.ingestSources,
        ...(extras.ingestFolderRoot ? { folderRoot: extras.ingestFolderRoot } : {}),
      });
      const target = { dataset: item.id, endpoint: spec.to, collections: {} };
      const replaced: string[] = [];
      // Every pipeline writes this shared generation; sibling carry-forward stays omitted.
      for (const [index, pipeline] of pipelines.entries()) {
        const unavailable = backend.unavailableFor?.(target, pipeline);
        if (unavailable) throw new Error(unavailable);
        const result = await backend.run(
          {
            execution: spec.generation,
            pipeline,
            target,
            ...(scope === platformScope ? {} : { tenant: scope }),
            ...(spec.modelsAdmitted ? { admitted: true } : {}),
          },
          signal,
        );
        if (result.stored === 0 && result.failed.length > 0)
          throw new Error(`the pipeline ${pipeline.id} stored nothing`);
        if (result.previous && result.previous !== spec.generation) replaced.push(result.previous);
        await report(index + 1, pipelines.length);
      }
      return replaced[0];
    };

    const run = async (scope: string, id: string, signal: AbortSignal) => {
      const start = (await store.history(kind, scope, id)).at(-1);
      if (!start) return;
      const spec = start.spec as EngineSwitchSpec;
      let percent = 0;
      const report = async (done: number, total: number) => {
        const next = total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
        if (Math.floor(next / 10) === Math.floor(percent / 10) && next < 100) return;
        percent = next;
        const saved = await update(
          scope,
          id,
          (s) =>
            s.state === 'running' && s.generation === spec.generation
              ? { ...s, progress: { percent: next, documents: done, total } }
              : undefined,
          systemActor,
          `${next} prosent overført`,
        );
        if (!saved) throw new Stopped();
      };
      try {
        const item = catalog.get('dataset', spec.dataset);
        if (!item) throw new Error(`the dataset ${spec.dataset} no longer exists`);
        let replaced: string | undefined;
        if (spec.method === 'copy') {
          const route = deps.writers.openAt(spec.dataset, spec.to, { signal }, overridesOf(spec));
          replaced = await copyInto(scope, item, route, spec, signal, report);
        } else replaced = await reingestInto(scope, item, spec, signal, report);
        const comparing = await update(
          scope,
          id,
          (s) =>
            s.state === 'running' && s.generation === spec.generation
              ? {
                  ...s,
                  state: 'comparing',
                  progress: { ...s.progress, percent: 100 },
                  cleanup:
                    replaced && replaced !== spec.generation
                      ? [...s.cleanup, { endpoint: spec.to, generation: replaced }]
                      : s.cleanup,
                }
              : undefined,
          systemActor,
          'Overføringen er ferdig',
        );
        if (!comparing) throw new Stopped();
        const result = await compare(scope, item, spec, signal);
        await update(
          scope,
          id,
          (s) =>
            s.state === 'comparing' && s.generation === spec.generation
              ? {
                  ...s,
                  state: 'ready',
                  ...(result.comparison ? { comparison: result.comparison } : {}),
                  ...(result.note ? { comparisonNote: result.note } : {}),
                }
              : undefined,
          systemActor,
          'Sammenligningen er ferdig',
        );
      } catch (error) {
        if (error instanceof Stopped || signal.aborted) return;
        const message = error instanceof Error ? error.message : String(error);
        await update(
          scope,
          id,
          (s) =>
            (s.state === 'running' || s.state === 'comparing') && s.generation === spec.generation
              ? { ...s, state: 'failed', error: { message, percent: s.progress.percent } }
              : undefined,
          systemActor,
          'Byttet stoppet',
        ).catch(() => undefined);
      }
    };

    const keyOf = (scope: string, id: string) => `${scope}\u0000${id}`;
    const heartbeat = async (scope: string, id: string, generation: string) =>
      Boolean(
        await update(
          scope,
          id,
          (s) =>
            jobStates.includes(s.state) && s.generation === generation
              ? { ...s, heartbeatAt: now().toISOString() }
              : undefined,
          systemActor,
          'Overføringen pågår',
        ),
      );
    const launch = (scope: string, id: string, generation: string) => {
      const controller = new AbortController();
      const key = keyOf(scope, id);
      jobs.set(key, controller);
      const beat = setInterval(() => {
        void heartbeat(scope, id, generation).then(
          (alive) => {
            if (!alive) controller.abort();
          },
          () => undefined,
        );
      }, heartbeatMs);
      beat.unref?.();
      void run(scope, id, controller.signal).finally(() => {
        clearInterval(beat);
        if (jobs.get(key) === controller) jobs.delete(key);
      });
    };

    const stale = (spec: EngineSwitchSpec) =>
      jobStates.includes(spec.state) &&
      now().getTime() - new Date(spec.heartbeatAt ?? spec.updatedAt).getTime() > staleAfterMs;

    const markStalled = async () => {
      let stalled = 0;
      for (const entry of await store.latest({ kind })) {
        if (entry.deleted || jobs.has(keyOf(entry.scope, entry.id))) continue;
        if (!stale(entry.spec as EngineSwitchSpec)) continue;
        const saved = await update(
          entry.scope,
          entry.id,
          (s) =>
            stale(s)
              ? {
                  ...s,
                  state: 'failed',
                  error: { message: stalledMessage, percent: s.progress.percent },
                }
              : undefined,
          systemActor,
          stalledMessage,
        ).catch(() => undefined);
        if (saved) stalled++;
      }
      return stalled;
    };
    const stop = (scope: string, id: string) => jobs.get(keyOf(scope, id))?.abort();

    const takeLease = async () => {
      const last = (await store.history(leaseKind, platformScope, 'sweep')).at(-1);
      const held = last?.spec as { holder?: string; until?: string } | undefined;
      if (held?.holder !== instance && held?.until && new Date(held.until) > now()) return false;
      try {
        await appendVersion(store, {
          kind: leaseKind,
          scope: platformScope,
          id: 'sweep',
          spec: { holder: instance, until: new Date(now().getTime() + 55 * 60_000).toISOString() },
          deleted: false,
          by: systemActor,
          reason: 'Rydder gamle søkemotorkopier',
          at: now().toISOString(),
          ifVersion: last?.version ?? 0,
        });
        return true;
      } catch {
        return false;
      }
    };

    const failure = (error: unknown) => (error instanceof Error ? error.message : String(error));

    const drop = async (spec: EngineSwitchSpec, cleanup: GenerationCleanup) => {
      try {
        const route = deps.writers.openAt(
          spec.dataset,
          cleanup.endpoint,
          { signal: AbortSignal.timeout(60_000) },
          overridesOf(spec),
        );
        await route.writer.drop(route.dataset, cleanup.generation, { force: true });
        return { ...cleanup, dropped: now().toISOString() };
      } catch (error) {
        return { ...cleanup, failed: failure(error) };
      }
    };

    const releasable = (spec: EngineSwitchSpec, endpoint: string) => {
      const engine = String(catalog.get('knowledge-endpoint', endpoint)?.spec.engine ?? '');
      return (
        catalog.get('dataset', spec.dataset)?.spec.endpoint !== endpoint &&
        deps.writers.engines().includes(engine) &&
        !writeKeyEngines.has(engine)
      );
    };

    const dropPrevious = async (spec: EngineSwitchSpec): Promise<GenerationCleanup | undefined> => {
      const previous = spec.previous;
      if (!previous || !releasable(spec, previous.endpoint)) return undefined;
      const options = previous.spec.options;
      const embedding = previous.spec.embedding as DatasetEmbedding | undefined;
      let generation: string | undefined;
      try {
        const route = deps.writers.openAt(
          spec.dataset,
          previous.endpoint,
          { signal: AbortSignal.timeout(60_000) },
          {
            datasetOptions: record(options),
            ...(embedding ? { embedding } : {}),
          },
        );
        generation = await route.writer.active(route.dataset);
        if (generation === undefined) return undefined;
        await route.writer.drop(route.dataset, generation, { force: true });
        return { endpoint: previous.endpoint, generation, dropped: now().toISOString() };
      } catch (error) {
        return {
          endpoint: previous.endpoint,
          generation: generation ?? 'active',
          failed: failure(error),
        };
      }
    };

    const sweep = async () => {
      const stalled = await markStalled();
      if (!(await takeLease())) return { ran: false, stalled, dropped: 0, expired: 0 };
      let dropped = 0;
      let expired = 0;
      for (const entry of await store.latest({ kind })) {
        if (entry.deleted) continue;
        const spec = entry.spec as EngineSwitchSpec;
        const pending = spec.cleanup.filter((c) => !c.dropped && !c.failed);
        const lapsed =
          spec.state === 'active' &&
          spec.previous !== undefined &&
          !spec.previous.expired &&
          new Date(spec.previous.keptUntil).getTime() <= now().getTime();
        if (pending.length === 0 && !lapsed) continue;
        const done = await Promise.all(pending.map((c) => drop(spec, c)));
        const released = lapsed ? await dropPrevious(spec) : undefined;
        dropped += [...done, ...(released ? [released] : [])].filter((c) => c.dropped).length;
        if (lapsed) expired++;
        await update(
          entry.scope,
          entry.id,
          (s) => ({
            ...s,
            cleanup: [
              ...s.cleanup.map(
                (c) =>
                  done.find((d) => d.endpoint === c.endpoint && d.generation === c.generation) ?? c,
              ),
              ...(released ? [released] : []),
            ],
            ...(lapsed && s.previous ? { previous: { ...s.previous, expired: true } } : {}),
          }),
          systemActor,
          'Oppbevaringstiden er ute',
        ).catch(() => undefined);
      }
      return { ran: true, stalled, dropped, expired };
    };

    const publish = async (
      principal: Principal,
      scope: string,
      item: CatalogItem,
      spec: Record<string, unknown>,
      reason: string,
      ifVersion: number,
      then?: (published: CatalogItem) => Promise<void>,
    ) => {
      if (!mounted) throw new Error('the module is not mounted');
      const acting =
        scope === platformScope ? { ...principal, tenant: deps.platformTenant } : principal;
      const input = {
        kind: 'dataset',
        id: shortOf(scope, item.id),
        spec,
        scope,
        tenant: tenantOf(scope),
        reason,
        ifVersion,
      };
      return then
        ? mounted.admin.performThen<CatalogItem>(acting, 'platform.catalog.publish', input, then)
        : mounted.admin.perform<CatalogItem>(acting, 'platform.catalog.publish', input);
    };

    const inTask = async <T>(
      c: Context,
      principal: Principal,
      scope: string,
      action: (typeof engineSwitchActions)[number],
      target: string,
      reason: string,
      work: () => Promise<T>,
    ) => {
      if (!mounted) throw new Error('the module is not mounted');
      const acting =
        scope === platformScope ? { ...principal, tenant: deps.platformTenant } : principal;
      const done = await mounted.admin.within(
        acting,
        action,
        { tenant: tenantOf(scope), reason, scope },
        async () => ({ value: await work(), target }),
      );
      c.header('genai-task', done.task);
      return done.value;
    };

    const usedBy = async (item: CatalogItem): Promise<ServiceUse[]> => {
      const names = new Set([item.id, ...((item.spec.aliases as string[] | undefined) ?? [])]);
      const seen = new Map<string, ServiceUse>();
      for (const compiled of await deps.definitions.capabilities()) {
        const config = record(compiled.capability.config);
        const datasets = (record(config.knowledge).datasets ?? []) as { dataset?: string }[];
        if (!datasets.some((d) => d.dataset && names.has(d.dataset))) continue;
        const key = `${compiled.service.tenant}/${compiled.service.id}`;
        if (!seen.has(key))
          seen.set(key, {
            tenant: compiled.service.tenant,
            id: compiled.service.id,
            name: compiled.capability.descriptor.title || compiled.service.id,
          });
      }
      return [...seen.values()];
    };

    const latencyOf = async (endpoint: string, engine: string) => {
      if (!engineOf(deps, engine)?.probe) return undefined;
      const cached = probes.get(endpoint);
      if (cached && now().getTime() - cached.at < 60_000) return cached.ms;
      const result = await deps.knowledge.probe(endpoint, AbortSignal.timeout(2000));
      const ms = result.ok ? result.ms : undefined;
      probes.set(endpoint, { at: now().getTime(), ...(ms === undefined ? {} : { ms }) });
      return ms;
    };

    const titleOf = (endpoint: string) => {
      const engine = catalog.get('knowledge-endpoint', endpoint)?.spec.engine;
      return engineOf(deps, engine)?.title ?? String(engine ?? endpoint);
    };

    const engineView = async (tenant: string, item: CatalogItem): Promise<DatasetEngineView> => {
      const endpoint = String(item.spec.endpoint);
      const endpointItem = catalog.get('knowledge-endpoint', endpoint);
      const engine = String(endpointItem?.spec.engine ?? 'unknown');
      const description = engineOf(deps, engine);
      const builtin = description?.builtin ?? false;
      let capabilities = description?.capabilities ?? [];
      try {
        capabilities =
          deps.knowledge
            .open(
              { kind: 'dataset', id: item.id, tenant: tenantOf(tenant) },
              contextFor(tenant, 'engine-view', AbortSignal.timeout(1000)),
            )
            .info().capabilities ?? capabilities;
      } catch {
        capabilities = description?.capabilities ?? [];
      }
      const switches = item.scope === tenant ? await switchesOf(tenant, item.id) : [];
      const open = switches.findLast((e) =>
        openStates.includes((e.spec as EngineSwitchSpec).state),
      );
      const last = switches.at(-1);
      const lastSpec = last?.spec as EngineSwitchSpec | undefined;
      const keptUntil = lastSpec?.state === 'active' ? lastSpec.previous?.keptUntil : undefined;
      const latencyMs = await latencyOf(endpoint, engine).catch(() => undefined);
      return {
        dataset: item.id,
        endpoint,
        engine,
        title: description?.title ?? engine,
        ...(description?.tech ? { tech: description.tech } : {}),
        builtin,
        runsAt: runsAtOf(endpointItem?.spec ?? {}, builtin),
        dataLocation: description?.dataLocation ?? (item.spec.residency as Residency),
        embedding: (item.spec.embedding as DatasetEmbedding | undefined) ?? null,
        capabilities: summarizeCapabilities(capabilities),
        ...(latencyMs === undefined ? {} : { latencyMs }),
        usedBy: await usedBy(item),
        canSwitch: item.scope === tenant,
        retentionDays: retentionDays(tenant),
        ...(open ? { activeSwitch: viewOf(open) } : {}),
        ...(last && lastSpec && keptUntil && new Date(keptUntil).getTime() > now().getTime()
          ? {
              previous: {
                endpoint: lastSpec.from,
                title: titleOf(lastSpec.from),
                keptUntil,
                switch: last.id,
              },
            }
          : {}),
      };
    };

    const refusalResponse = (c: Context, error: unknown) => {
      if (error instanceof Refusal)
        return problem(c, error.status, error.message, [
          { path: error.path, message: error.detail ?? error.message },
        ]);
      if (error instanceof AdminRefused) return refusedBy(c, error);
      throw error;
    };

    const reasonFrom = (c: Context) => (changeReasonOf(c) ?? '').trim();

    const embeddingFrom = (raw: unknown): DatasetEmbedding | undefined => {
      const value = record(raw);
      return typeof value.model === 'string' &&
        Number.isInteger(value.dimensions) &&
        (value.dimensions as number) > 0
        ? { model: value.model, dimensions: value.dimensions as number }
        : undefined;
    };

    return {
      id: 'engine-switches',
      handlers: routeOnlyActions(engineSwitchActions),
      sweep,
      mount: (app, mountDeps) => {
        mounted = mountDeps;
        const tenantGuard: Guard = async (c, right) => {
          const principal = await mountDeps.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Unauthorized') };
          const tenant = c.req.param('tenant') ?? '';
          const entered = enterTenant(c, mountDeps.access, principal, tenant, right);
          if ('response' in entered) return entered;
          return { principal: entered.principal, tenant };
        };
        const operatorGuard: Guard = async (c) => {
          const principal = await mountDeps.authenticate(c.req.raw);
          if (!principal) return { response: problem(c, 401, 'Unauthorized') };
          if (principal.kind !== 'operator') return { response: problem(c, 403, 'Forbidden') };
          return { principal, tenant: platformScope };
        };
        const body = async (c: Context) => record(await c.req.json().catch(() => ({})));
        const register = (base: string, guard: Guard) => {
          app.get(`${base}/engine`, async (c) => {
            const g = await guard(c);
            if ('response' in g) return g.response;
            const item = visibleDataset(g.tenant, c.req.param('id') ?? '');
            if (!item) return problem(c, 404, 'Not found');
            return c.json(await engineView(g.tenant, item));
          });

          app.get(`${base}/engine-switches`, async (c) => {
            const g = await guard(c);
            if ('response' in g) return g.response;
            const item = ownDataset(g.tenant, c.req.param('id') ?? '');
            if (!item) return problem(c, 404, 'Not found');
            return c.json({ data: (await switchesOf(g.tenant, item.id)).map(viewOf).reverse() });
          });

          app.get(`${base}/engine-switches/estimate`, async (c) => {
            const g = await guard(c, 'manage-datasets');
            if ('response' in g) return g.response;
            const item = ownDataset(g.tenant, c.req.param('id') ?? '');
            if (!item) return problem(c, 404, 'Not found');
            const method = c.req.query('method');
            if (method !== undefined && method !== 'copy' && method !== 'reingest')
              return problem(c, 400, 'Invalid request', [
                { path: 'method', message: 'method is copy or reingest' },
              ]);
            try {
              const plan = await planFor(g.tenant, item, c.req.query('to') ?? '', {});
              const estimate = await estimateFor(g.tenant, item, plan);
              return c.json({
                ...estimate,
                ...(method ? { method } : {}),
              } satisfies SwitchEstimate);
            } catch (error) {
              return refusalResponse(c, error);
            }
          });

          app.post(`${base}/engine-switches`, async (c) => {
            const g = await guard(c, 'manage-datasets');
            if ('response' in g) return g.response;
            const item = ownDataset(g.tenant, c.req.param('id') ?? '');
            if (!item) return problem(c, 404, 'Not found');
            const input = await body(c);
            const method = input.method;
            if (method !== 'copy' && method !== 'reingest')
              return problem(c, 400, 'Invalid request', [
                { path: 'method', message: 'method is copy or reingest' },
              ]);
            const embedding = embeddingFrom(input.embedding);
            const datasetOptions = input.options === undefined ? undefined : record(input.options);
            try {
              const plan = await planFor(g.tenant, item, String(input.to ?? ''), {
                ...(embedding ? { embedding } : {}),
              });
              const problemText = method === 'copy' ? plan.copyProblem : plan.reingestProblem;
              if (problemText) throw new Refusal(409, problemText, 'method');
              const existing = await switchesOf(g.tenant, item.id);
              const busy = existing.find((e) =>
                openStates.includes((e.spec as EngineSwitchSpec).state),
              );
              if (busy)
                throw new Refusal(409, t('operations.switchBusy', { id: busy.id }), 'dataset');
              try {
                deps.writers.openAt(
                  item.id,
                  plan.target.id,
                  { signal: AbortSignal.timeout(1000) },
                  {
                    ...(plan.embedding ? { embedding: plan.embedding } : {}),
                    ...(datasetOptions ? { datasetOptions } : {}),
                  },
                );
              } catch (error) {
                throw new Refusal(409, error instanceof Error ? error.message : String(error));
              }
              const estimate = await estimateFor(g.tenant, item, plan);
              const n =
                existing.reduce((max, e) => Math.max(max, Number(e.id.split(':').pop()) || 0), 0) +
                1;
              const id = `${shortOf(g.tenant, item.id)}:${n}`;
              const at = now().toISOString();
              const reason = reasonFrom(c);
              const spec: EngineSwitchSpec = {
                dataset: item.id,
                from: String(item.spec.endpoint),
                to: plan.target.id,
                method,
                state: 'running',
                reason,
                ...(plan.embedding ? { embedding: plan.embedding } : {}),
                ...(datasetOptions ? { options: datasetOptions } : {}),
                estimate: {
                  costNok: estimate[method].costNok,
                  durationMinutes: estimate[method].durationMinutes,
                },
                progress: { percent: 0, documents: 0 },
                attempt: 1,
                generation: `switch-${n}-1`,
                startedAt: at,
                startedBy: actor(g.principal.actor ?? g.principal),
                updatedAt: at,
                heartbeatAt: at,
                datasetVersion: item.version,
                decisions: [],
                cleanup: [],
                ...(deps.modelAdmission?.(g.principal) ? { modelsAdmitted: true } : {}),
              };
              const saved = await inTask(
                c,
                g.principal,
                g.tenant,
                'platform.engine-switch.start',
                `engine-switch:${id}`,
                reason,
                () =>
                  appendVersion(store, {
                    kind,
                    scope: g.tenant,
                    id,
                    spec,
                    deleted: false,
                    by: actor(g.principal.actor ?? g.principal),
                    reason,
                    at,
                    ifVersion: 0,
                  }),
              );
              launch(g.tenant, id, spec.generation);
              return c.json(viewOf(saved), 202);
            } catch (error) {
              return refusalResponse(c, error);
            }
          });

          const withSwitch = async (
            c: Context,
            right?: 'manage-datasets',
          ): Promise<
            | { response: Response }
            | {
                principal: Principal;
                tenant: string;
                item: CatalogItem;
                entry: ConfigEntry<unknown>;
              }
          > => {
            const g = await guard(c, right);
            if ('response' in g) return g;
            const item = ownDataset(g.tenant, c.req.param('id') ?? '');
            const entry = item && (await entryOf(g.tenant, item, c.req.param('sid') ?? ''));
            if (!item || !entry) return { response: problem(c, 404, 'Not found') };
            return { ...g, item, entry };
          };

          app.get(`${base}/engine-switches/:sid`, async (c) => {
            const g = await withSwitch(c);
            if ('response' in g) return g.response;
            return c.json(viewOf(g.entry));
          });

          app.post(`${base}/engine-switches/:sid/retry`, async (c) => {
            const g = await withSwitch(c, 'manage-datasets');
            if ('response' in g) return g.response;
            const state = (g.entry.spec as EngineSwitchSpec).state;
            const retried = reasonFrom(c);
            const saved = await inTask(
              c,
              g.principal,
              g.tenant,
              'platform.engine-switch.retry',
              `engine-switch:${g.entry.id}`,
              retried,
              async () => {
                const done = await update(
                  g.tenant,
                  g.entry.id,
                  (s) => {
                    if (s.state !== 'failed') return undefined;
                    const attempt = s.attempt + 1;
                    const rest = { ...s };
                    delete rest.error;
                    delete rest.modelsAdmitted;
                    return {
                      ...rest,
                      ...(deps.modelAdmission?.(g.principal) ? { modelsAdmitted: true } : {}),
                      state: 'running',
                      attempt,
                      generation: `switch-${g.entry.id.split(':').pop()}-${attempt}`,
                      progress: { percent: 0, documents: 0 },
                      heartbeatAt: now().toISOString(),
                      cleanup: [...s.cleanup, { endpoint: s.to, generation: s.generation }],
                    };
                  },
                  actor(g.principal.actor ?? g.principal),
                  retried,
                );
                if (!done)
                  throw new Refusal(
                    409,
                    'Bare et bytte som har stoppet kan prøves på nytt.',
                    'state',
                    state,
                  );
                return done;
              },
            ).catch((error: unknown) => refusalResponse(c, error));
            if (saved instanceof Response) return saved;
            launch(g.tenant, g.entry.id, (saved.spec as EngineSwitchSpec).generation);
            return c.json(viewOf(saved), 202);
          });

          app.post(`${base}/engine-switches/:sid/cancel`, async (c) => {
            const g = await withSwitch(c, 'manage-datasets');
            if ('response' in g) return g.response;
            const reason = reasonFrom(c);
            const by = actor(g.principal.actor ?? g.principal);
            const state = (g.entry.spec as EngineSwitchSpec).state;
            const saved = await inTask(
              c,
              g.principal,
              g.tenant,
              'platform.engine-switch.cancel',
              `engine-switch:${g.entry.id}`,
              reason,
              async () => {
                const done = await update(
                  g.tenant,
                  g.entry.id,
                  (s) =>
                    openStates.includes(s.state)
                      ? {
                          ...s,
                          state: 'cancelled',
                          decisions: [
                            ...s.decisions,
                            { action: 'cancel', by, at: now().toISOString(), reason },
                          ],
                          cleanup: [...s.cleanup, { endpoint: s.to, generation: s.generation }],
                        }
                      : undefined,
                  by,
                  reason,
                );
                if (!done) throw new Refusal(409, 'Byttet er allerede avsluttet.', 'state', state);
                return done;
              },
            ).catch((error: unknown) => refusalResponse(c, error));
            if (saved instanceof Response) return saved;
            stop(g.tenant, g.entry.id);
            return c.json(viewOf(saved));
          });

          app.post(`${base}/engine-switches/:sid/activate`, async (c) => {
            const g = await withSwitch(c, 'manage-datasets');
            if ('response' in g) return g.response;
            const spec = g.entry.spec as EngineSwitchSpec;
            const reason = reasonFrom(c);
            if (spec.state !== 'ready')
              return problem(c, 409, 'Byttet er ikke klart til å tas i bruk.', [
                { path: 'state', message: spec.state },
              ]);
            const minimum = minimumReason(spec);
            if (reason.length < minimum)
              return problem(c, 400, 'Begrunnelsen er for kort', [
                { path: 'change-reason', message: `Begrunnelsen må ha minst ${minimum} tegn.` },
              ]);
            if (g.item.version !== spec.datasetVersion)
              return problem(c, 409, 'Datasettet er endret siden byttet startet.', [
                { path: 'dataset', message: `version ${g.item.version}` },
              ]);
            let route: IndexWriterRoute;
            try {
              route = deps.writers.openAt(
                spec.dataset,
                spec.to,
                { signal: AbortSignal.timeout(1000) },
                overridesOf(spec),
              );
            } catch (error) {
              return problem(c, 409, error instanceof Error ? error.message : String(error));
            }
            const next: Record<string, unknown> = {
              ...g.item.spec,
              endpoint: spec.to,
              options: route.dataset.options,
              ...(route.dataset.embedding ? { embedding: route.dataset.embedding } : {}),
            };
            const by = actor(g.principal.actor ?? g.principal);
            const at = now();
            const keptUntil = new Date(
              at.getTime() + retentionDays(g.tenant) * 86_400_000,
            ).toISOString();
            let saved: ConfigEntry<unknown> | undefined;
            const result = await publish(
              g.principal,
              g.tenant,
              g.item,
              next,
              reason,
              spec.datasetVersion,
              async (published) => {
                saved = await update(
                  g.tenant,
                  g.entry.id,
                  (s) => ({
                    ...s,
                    state: 'active',
                    previous: {
                      endpoint: s.from,
                      keptUntil,
                      catalogVersion: s.datasetVersion,
                      spec: g.item.spec,
                    },
                    activatedVersion: published.version,
                    decisions: [
                      ...s.decisions,
                      { action: 'activate', by, at: at.toISOString(), reason },
                    ],
                  }),
                  by,
                  reason,
                );
              },
            );
            c.header('genai-task', result.task);
            if (!result.ok)
              return problem(
                c,
                result.errors.some((e) => e.path === 'if-match')
                  ? 409
                  : result.errors.some((e) => e.path === 'principal')
                    ? 403
                    : 400,
                'Søkemotoren kunne ikke tas i bruk',
                result.errors.map((e) => ({ path: e.path, message: e.message })),
              );
            return c.json(viewOf(saved ?? g.entry));
          });

          app.post(`${base}/engine-switches/:sid/rollback`, async (c) => {
            const g = await withSwitch(c, 'manage-datasets');
            if ('response' in g) return g.response;
            const spec = g.entry.spec as EngineSwitchSpec;
            const reason = reasonFrom(c);
            if (spec.state !== 'active' || !spec.previous)
              return problem(c, 409, 'Bare en søkemotor som er tatt i bruk kan byttes tilbake.', [
                { path: 'state', message: spec.state },
              ]);
            if (new Date(spec.previous.keptUntil).getTime() <= now().getTime())
              return problem(c, 409, 'Den forrige søkemotoren er ikke lenger beholdt.', [
                { path: 'keptUntil', message: spec.previous.keptUntil },
              ]);
            if (!isReasonLongEnough(reason))
              return problem(c, 400, 'Begrunnelsen er for kort', [
                { path: 'change-reason', message: reasonTooShort },
              ]);
            if (g.item.version !== spec.activatedVersion)
              return problem(c, 409, 'Datasettet er endret siden søkemotoren ble tatt i bruk.', [
                { path: 'dataset', message: `version ${g.item.version}` },
              ]);
            const history = await catalog.history('dataset', g.item.id);
            const before =
              (history.find((v) => v.version === spec.previous?.catalogVersion)?.spec as
                Record<string, unknown> | undefined) ?? spec.previous.spec;
            const by = actor(g.principal.actor ?? g.principal);
            let saved: ConfigEntry<unknown> | undefined;
            const result = await publish(
              g.principal,
              g.tenant,
              g.item,
              before,
              reason,
              spec.activatedVersion ?? g.item.version,
              async () => {
                saved = await update(
                  g.tenant,
                  g.entry.id,
                  (s) => ({
                    ...s,
                    state: 'rolled_back',
                    decisions: [
                      ...s.decisions,
                      { action: 'rollback', by, at: now().toISOString(), reason },
                    ],
                    cleanup: [...s.cleanup, { endpoint: s.to, generation: s.generation }],
                  }),
                  by,
                  reason,
                );
              },
            );
            c.header('genai-task', result.task);
            if (!result.ok)
              return problem(
                c,
                result.errors.some((e) => e.path === 'if-match') ? 409 : 400,
                'Den forrige søkemotoren kunne ikke tas i bruk igjen',
                result.errors.map((e) => ({ path: e.path, message: e.message })),
              );
            return c.json(viewOf(saved ?? g.entry));
          });
        };
        register('/tenants/:tenant/datasets/:id', tenantGuard);
        register('/operator/datasets/:id', operatorGuard);

        const interval = options.sweepIntervalMs ?? 60 * 60_000;
        void sweep().catch(() => undefined);
        if (interval > 0) {
          const timer = setInterval(() => void sweep().catch(() => undefined), interval);
          timer.unref?.();
          const watch = setInterval(
            () => void markStalled().catch(() => undefined),
            Math.max(heartbeatMs, staleAfterMs / 2),
          );
          watch.unref?.();
        }
      },
    };
  };

export const engineSwitchesModule = createEngineSwitchesModule();
