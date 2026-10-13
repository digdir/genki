import type { Event, Principal, Task } from '@genai/contracts';
import { applySettings } from '@genai/composition';
import type { CompiledCapability, SettingsRegistry } from '@genai/definitions';
import type { PortContext } from '@genai/kernel';
import { combineKnowledge, type KnowledgePort, type KnowledgeRouter } from '@genai/port-knowledge';
import type { ModelPort } from '@genai/port-model';
import type { RerankPort } from '@genai/port-rerank';
import {
  createPlanner,
  retrievalConfig,
  retrieve,
  type Chunk,
  type FilterInput,
} from '@genai/retrieval';
import { defaultSearchDisplayLimit } from '@genai/strategy-agent-loop';
import type { Context, Env, Hono, Schema } from 'hono';
import { z } from 'zod';
import { enterTenant, type Access } from './access.js';
import type { MountDeps, PlatformModuleFactory } from './platform-modules.js';
import { t } from './i18n/index.js';

type Status = 400 | 401 | 403 | 404 | 502;

const problem = (c: Context, status: Status, title: string, errors: unknown[] = []) =>
  c.json({ type: 'about:blank', title, status, errors }, status, {
    'content-type': 'application/problem+json',
  });

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

interface Opener<P> {
  open(ref: { kind: string; id: string; tenant?: string }, ctx: PortContext): P;
}

export interface DiagnosticsDeps {
  definitions: { capabilities(): Promise<CompiledCapability[]> };
  settings: SettingsRegistry;
  knowledge: Pick<KnowledgeRouter, 'open' | 'resolve' | 'datasets'>;
  models: Opener<ModelPort>;
  rerank?: Opener<RerankPort>;
  task(id: string): Promise<Task | undefined>;
  events(task: string): AsyncIterable<Event>;
}

const overrides = z.strictObject({
  limit: z.number().int().positive().optional(),
  retrieveTopK: z.number().int().positive().optional(),
  maxPerDocument: z.number().int().positive().optional(),
  queryAwareBoost: z.boolean().optional(),
  rerank: z.boolean().optional(),
  rerankCandidateK: z.number().int().positive().optional(),
  autoFilter: z.boolean().optional(),
  userIntentUnion: z.boolean().optional(),
});

const retrieveBody = z
  .strictObject({
    service: z.string().min(1).optional(),
    dataset: z.string().min(1).optional(),
    queries: z.array(z.string().trim().min(1)).min(1).max(10),
    userIntent: z.string().min(1).optional(),
    filters: z.record(z.string(), z.unknown()).optional(),
    overrides: overrides.optional(),
  })
  .refine((b) => (b.service === undefined) !== (b.dataset === undefined), {
    error: () => t('problems.diagnosticsServiceOrDataset'),
    path: ['service'],
  });

const planBody = z.strictObject({ service: z.string().min(1), query: z.string().trim().min(1) });

interface KnowledgeSpec {
  datasets?: { dataset: string }[];
  reranker?: string;
  retrieval?: unknown;
  planner?: unknown;
}

interface Resolved {
  compiled: CompiledCapability;
  config: Record<string, unknown>;
  effective: Record<string, { value: unknown; source: string }>;
}

const resolveService = async (
  deps: DiagnosticsDeps,
  tenant: string,
  match: (c: CompiledCapability) => boolean,
): Promise<Resolved | undefined> => {
  const found = (await deps.definitions.capabilities()).filter(
    (c) => c.service.tenant === tenant && match(c),
  );
  const compiled = found.find((c) => c.variant === 'default') ?? found[0];
  if (!compiled) return undefined;
  const runtime = compiled.capability.config as { settings?: Record<string, unknown> };
  const effective = deps.settings.effective(tenant, {
    tenant,
    service: compiled.capability.descriptor.id,
    version: compiled.service.version,
    settings: runtime.settings ?? {},
  });
  return {
    compiled,
    config: applySettings(compiled.capability.config, effective, compiled.capability.strategy.id),
    effective: Object.fromEntries(
      Object.values(effective)
        .filter((r) => r.source !== 'default')
        .map((r) => [r.key, { value: r.value, source: r.source }]),
    ),
  };
};

const knowledgeOf = (config: Record<string, unknown>): KnowledgeSpec =>
  isRecord(config.knowledge) ? (config.knowledge as KnowledgeSpec) : {};

const withOverrides = (base: unknown, o: z.infer<typeof overrides> = {}) => {
  const config = structuredClone(isRecord(base) ? base : {}) as Record<string, unknown>;
  const section = (key: string) => {
    const value = isRecord(config[key]) ? config[key] : {};
    config[key] = value;
    return value as Record<string, unknown>;
  };
  if (o.limit !== undefined) config.limit = o.limit;
  if (o.retrieveTopK !== undefined) config.retrieveTopK = o.retrieveTopK;
  if (o.maxPerDocument !== undefined) config.maxPerDocument = o.maxPerDocument;
  if (o.queryAwareBoost !== undefined) config.queryAwareBoost = o.queryAwareBoost;
  if (o.rerank !== undefined) section('rerank').enabled = o.rerank;
  if (o.rerankCandidateK !== undefined) section('rerank').candidateK = o.rerankCandidateK;
  if (o.autoFilter !== undefined) section('autoFilter').enabled = o.autoFilter;
  if (o.userIntentUnion !== undefined) section('userIntentUnion').enabled = o.userIntentUnion;
  return config;
};

const chunkView = (c: Chunk) => ({
  chunkId: c.id,
  ...(c.document === undefined ? {} : { document: c.document }),
  ...(c.position === undefined ? {} : { position: c.position }),
  ...(c.title === undefined ? {} : { title: c.title }),
  ...(c.url === undefined ? {} : { url: c.url }),
  ...(c.rerankScore === undefined
    ? c.retrievalPrior === undefined
      ? {}
      : { score: c.retrievalPrior }
    : { score: c.rerankScore }),
});

const portContext = (tenant: string, principal: Principal, signal: AbortSignal): PortContext => ({
  tenant,
  principal,
  task: `diagnostics-${crypto.randomUUID()}`,
  signal,
  meter: async () => undefined,
});

const visible = (deps: DiagnosticsDeps, tenant: string, dataset: string) => {
  const id = deps.knowledge.resolve(dataset);
  const entry = id ? deps.knowledge.datasets().get(id) : undefined;
  return id && entry && (!entry.tenants || entry.tenants.includes(tenant)) ? id : undefined;
};

const failure = (c: Context, error: unknown) => {
  const code = isRecord(error) ? error.code : undefined;
  if (code === 'forbidden' || code === 'not_found')
    return problem(c, 404, t('problems.diagnosticsDatasetNotFound'));
  if (code === 'bad_request' || code === 'unsupported')
    return problem(c, 400, t('problems.diagnosticsSearchInvalid'), [
      { path: 'body', message: error instanceof Error ? error.message : String(error) },
    ]);
  return problem(c, 502, t('problems.diagnosticsSearchFailed'), [
    { path: 'knowledge', message: error instanceof Error ? error.message : String(error) },
  ]);
};

const zodErrors = (error: z.ZodError) =>
  error.issues.map((i) => ({ path: i.path.join('.') || 'body', message: i.message }));

interface Hit {
  chunkId: string;
  document?: string;
  position?: number;
}

const hitsOf = (value: unknown): Hit[] =>
  (Array.isArray(value) ? value : []).flatMap((h) => {
    if (!isRecord(h)) return [];
    const id = h.id ?? h.chunkId;
    if (typeof id !== 'string') return [];
    return [
      {
        chunkId: id,
        ...(typeof h.document === 'string' ? { document: h.document } : {}),
        ...(typeof h.position === 'number' ? { position: h.position } : {}),
      },
    ];
  });

const union = (lists: Hit[][]) => {
  const seen = new Map<string, Hit>();
  for (const hit of lists.flat()) if (!seen.has(hit.chunkId)) seen.set(hit.chunkId, hit);
  return [...seen.values()];
};

export const stageAttribution = (events: Event[], displayLimit: number) => {
  const notices = events
    .filter((e) => e.type === 'kernel.notice' && isRecord(e.data))
    .map((e) => e.data as Record<string, unknown>);
  const searches = notices
    .filter((d) => d.kind === 'retrieval')
    .map((d) => {
      const hits = hitsOf(d.hits);
      return {
        queries: Array.isArray(d.queries) ? d.queries.filter((q) => typeof q === 'string') : [],
        hits,
        displayed: hits.slice(0, displayLimit),
      };
    });
  const reads = notices
    .filter((d) => d.kind === 'read')
    .map((d) => ({ chunks: hitsOf(d.chunks), auto: d.auto === true }));
  return {
    displayLimit,
    searches,
    reads,
    pool: union(searches.map((s) => s.hits)),
    displayed: union(searches.map((s) => s.displayed)),
    read: union(reads.map((r) => r.chunks)),
  };
};

const displayLimitOf = (config: Record<string, unknown>) => {
  const strategy = isRecord(config.strategy) ? config.strategy : {};
  const search = isRecord(strategy.search) ? strategy.search : {};
  return typeof search.displayLimit === 'number' ? search.displayLimit : defaultSearchDisplayLimit;
};

export const mountDiagnostics = <E extends Env, S extends Schema, B extends string>(
  app: Hono<E, S, B>,
  deps: DiagnosticsDeps & {
    authenticate(request: Request): Promise<Principal | undefined>;
    access: Access;
  },
) => {
  const enter = async (c: Context) => {
    const principal = await deps.authenticate(c.req.raw);
    if (!principal) return { response: problem(c, 401, t('problems.notSignedIn')) };
    if (principal.kind !== 'operator')
      return { response: problem(c, 404, t('problems.notFound')) as Response };
    const tenant = c.req.param('tenant') ?? '';
    const entered = enterTenant(c, deps.access, principal, tenant);
    return 'response' in entered ? entered : { principal: entered.principal, tenant };
  };

  app.post('/tenants/:tenant/diagnostics/retrieve', async (c) => {
    const entered = await enter(c);
    if ('response' in entered) return entered.response;
    const { principal, tenant } = entered;
    const parsed = retrieveBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return problem(c, 400, t('problems.invalidRequest'), zodErrors(parsed.error));
    const body = parsed.data;
    let datasets: string[];
    let base: unknown = {};
    let reranker: string | undefined;
    if (body.service) {
      const resolved = await resolveService(deps, tenant, (x) => x.service.id === body.service);
      if (!resolved) return problem(c, 404, t('problems.diagnosticsServiceNotFound'));
      const knowledge = knowledgeOf(resolved.config);
      datasets = [...new Set((knowledge.datasets ?? []).map((d) => d.dataset))];
      if (datasets.length === 0)
        return problem(c, 400, t('problems.diagnosticsServiceNoDataset'), [
          { path: 'service', message: t('problems.diagnosticsServiceSearchesNoDataset') },
        ]);
      base = knowledge.retrieval ?? {};
      reranker = knowledge.reranker;
    } else {
      const id = visible(deps, tenant, body.dataset as string);
      if (!id) return problem(c, 404, t('problems.diagnosticsDatasetNotFound'));
      datasets = [id];
    }
    const merged = withOverrides(base, body.overrides);
    const checked = retrievalConfig.safeParse(merged);
    if (!checked.success)
      return problem(c, 400, t('problems.diagnosticsInvalidSettings'), zodErrors(checked.error));
    const ctx = portContext(tenant, principal, AbortSignal.timeout(60_000));
    try {
      const knowledge: KnowledgePort =
        datasets.length === 1
          ? deps.knowledge.open({ kind: 'dataset', id: datasets[0] as string, tenant }, ctx)
          : combineKnowledge(
              Object.fromEntries(
                datasets.map((d) => [
                  d,
                  deps.knowledge.open({ kind: 'dataset', id: d, tenant }, ctx),
                ]),
              ),
            );
      const rerank =
        reranker && deps.rerank
          ? deps.rerank.open({ kind: 'reranker', id: reranker, tenant }, ctx)
          : undefined;
      const result = await retrieve({
        knowledge,
        ...(rerank ? { rerank } : {}),
        queries: body.queries,
        ...(body.userIntent ? { userIntent: body.userIntent } : {}),
        ...(body.filters ? { filters: body.filters as Record<string, FilterInput> } : {}),
        config: checked.data,
      });
      return c.json({
        dataset: datasets.length === 1 ? datasets[0] : datasets,
        ...(body.service ? { service: body.service } : {}),
        config: checked.data,
        chunks: result.chunks.map(chunkView),
        trace: result.trace,
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get('/tenants/:tenant/diagnostics/services/:service/resolution', async (c) => {
    const entered = await enter(c);
    if ('response' in entered) return entered.response;
    const service = c.req.param('service');
    const resolved = await resolveService(deps, entered.tenant, (x) => x.service.id === service);
    if (!resolved) return problem(c, 404, t('problems.diagnosticsServiceNotFound'));
    const { compiled, config, effective } = resolved;
    const knowledge = knowledgeOf(config);
    return c.json({
      service,
      version: compiled.service.version,
      variant: compiled.variant,
      capability: compiled.capability.descriptor.id,
      publicName: compiled.publicName,
      aliases: compiled.aliases,
      strategy: compiled.capability.strategy,
      model: config.model ?? null,
      knowledge: {
        datasets: (knowledge.datasets ?? []).map((d) => d.dataset),
        reranker: knowledge.reranker ?? null,
        retrieval: retrievalConfig.parse(knowledge.retrieval ?? {}),
        planner: knowledge.planner ?? null,
      },
      strategyConfig: config.strategy ?? null,
      settings: effective,
    });
  });

  app.post('/tenants/:tenant/diagnostics/plan', async (c) => {
    const entered = await enter(c);
    if ('response' in entered) return entered.response;
    const { principal, tenant } = entered;
    const parsed = planBody.safeParse(await c.req.json().catch(() => undefined));
    if (!parsed.success)
      return problem(c, 400, t('problems.invalidRequest'), zodErrors(parsed.error));
    const resolved = await resolveService(
      deps,
      tenant,
      (x) => x.service.id === parsed.data.service,
    );
    if (!resolved) return problem(c, 404, t('problems.diagnosticsServiceNotFound'));
    const model = isRecord(resolved.config.model) ? resolved.config.model : {};
    const roles = isRecord(model.roles) ? model.roles : {};
    const modelId =
      typeof roles.planner === 'string'
        ? roles.planner
        : typeof model.primary === 'string'
          ? model.primary
          : undefined;
    if (!modelId) return problem(c, 400, t('problems.diagnosticsServiceNoModel'));
    const knowledge = knowledgeOf(resolved.config);
    const ctx = portContext(tenant, principal, AbortSignal.timeout(60_000));
    try {
      const first = knowledge.datasets?.[0]?.dataset;
      const planner = createPlanner({
        model: deps.models.open({ kind: 'model', id: modelId, tenant }, ctx),
        ...(first
          ? { knowledge: deps.knowledge.open({ kind: 'dataset', id: first, tenant }, ctx) }
          : {}),
        config: knowledge.planner ?? {},
      });
      const plan = await planner(parsed.data.query, [], ctx.signal);
      return c.json({
        queries: plan.queries,
        ...(plan.userIntent ? { userIntent: plan.userIntent } : {}),
        model: modelId,
        trace: plan.trace,
      });
    } catch (error) {
      return failure(c, error);
    }
  });

  app.get('/tenants/:tenant/diagnostics/tasks/:task/attribution', async (c) => {
    const entered = await enter(c);
    if ('response' in entered) return entered.response;
    const task = await deps.task(c.req.param('task') ?? '');
    if (!task || task.tenant !== entered.tenant)
      return problem(c, 404, t('problems.diagnosticsTaskNotFound'));
    const events: Event[] = [];
    for await (const e of deps.events(task.id)) events.push(e);
    const capability = task.service.capability.id;
    const resolved = await resolveService(
      deps,
      entered.tenant,
      (x) => x.capability.descriptor.id === capability,
    );
    return c.json({
      task: task.id,
      service: resolved?.compiled.service.id ?? capability,
      ...stageAttribution(
        events,
        resolved ? displayLimitOf(resolved.config) : defaultSearchDisplayLimit,
      ),
    });
  });
};

export const createDiagnosticsModule =
  (options: { rerank?: Opener<RerankPort> } = {}): PlatformModuleFactory =>
  () => ({
    id: 'diagnostics',
    mount: <E extends Env, S extends Schema, B extends string>(
      app: Hono<E, S, B>,
      deps: MountDeps,
    ) =>
      mountDiagnostics(app, {
        definitions: deps.definitions,
        settings: deps.settings,
        knowledge: deps.knowledge,
        models: deps.models,
        ...(options.rerank ? { rerank: options.rerank } : {}),
        task: deps.task,
        events: deps.events,
        authenticate: deps.authenticate,
        access: deps.access,
      }),
  });

export const diagnosticsModule: PlatformModuleFactory = createDiagnosticsModule();
