import type { ApiContext } from '../api';
import type { Residency } from '../types';

export type EngineCapability =
  | 'text_search'
  | 'vector_search'
  | 'hybrid'
  | 'filters'
  | 'facets'
  | 'full_document'
  | 'ordered_passages';

export type SwitchMethod = 'copy' | 'reingest';

export type SwitchState =
  'running' | 'failed' | 'comparing' | 'ready' | 'active' | 'rolled_back' | 'cancelled';

export type Verdict = 'same' | 'better' | 'worse';

interface Range {
  min: number;
  max: number;
}

interface CapabilitySummary {
  supported: EngineCapability[];
  missing: EngineCapability[];
}

export interface KnowledgeEndpointView {
  id: string;
  name: string;
  scope: string;
  engine: string;
  title: string;
  tech?: string;
  builtin: boolean;
  runsAt: string;
  dataLocation?: Residency;
  embeddingModel?: string;
  writeKeyRequired: boolean;
  capabilities: CapabilitySummary;
  datasetCount: number;
  status: 'ok' | 'unused' | 'skipped';
  shared: boolean;
  version: number;
}

export interface RetrievalComparison {
  testSets: string[];
  cases: number;
  k: number;
  hitAt5: [number, number];
  meanRank: [number | null, number | null];
  latencyMs: [number, number];
  errors: [number, number];
  verdict: Verdict;
  examples: {
    case: string;
    question: string;
    old: { first?: string; rank: number | null };
    new: { first?: string; rank: number | null };
    verdict: Verdict;
  }[];
}

export interface SwitchDecision {
  action: 'activate' | 'rollback' | 'cancel';
  by: string;
  at: string;
  reason: string;
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
  embedding?: { model: string; dimensions: number };
  estimate: { costNok: Range; durationMinutes: Range };
  progress: { percent: number; documents: number; total?: number };
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

export interface DatasetEngineView {
  dataset: string;
  endpoint: string;
  engine: string;
  title: string;
  tech?: string;
  builtin: boolean;
  runsAt: string;
  dataLocation?: Residency;
  embedding: { model: string; dimensions: number; residency?: Residency } | null;
  capabilities: CapabilitySummary;
  latencyMs?: number;
  usedBy: { tenant: string; id: string; name: string }[];
  canSwitch: boolean;
  retentionDays: number;
  activeSwitch?: EngineSwitchView;
  previous?: { endpoint: string; title: string; keptUntil: string; switch: string };
}

export interface MethodEstimateView {
  available: boolean;
  reason?: string;
  costNok: Range;
  durationMinutes: Range;
}

export interface SwitchEstimateView {
  dataset: string;
  from: string;
  to: string;
  estimate: true;
  basis: { documents: number; counted: boolean };
  method?: SwitchMethod;
  copy: MethodEstimateView;
  reingest: MethodEstimateView;
}

export interface DefaultEmbedding {
  model: string;
  dimensions: number;
  residency?: Residency;
}

export interface SearchEngineInfo {
  id: string;
  engine: string;
  title: string;
  tech?: string;
  builtin: boolean;
  dataLocation?: Residency;
  runsAt?: string;
  embeddingModel?: { name: string; dataLocation?: Residency };
  capabilities: EngineCapability[];
  writeKeyRequired?: boolean;
}

export interface SwitchComparison {
  testSet: string;
  verdict: Verdict;
  hitAt5: [number, number];
  meanRank: [number | null, number | null];
  latencyMs: [number, number];
  examples: { question: string; before: string | null; after: string | null; verdict: Verdict }[];
}

export interface EngineSwitch {
  id: string;
  dataset: string;
  from: string;
  to: string;
  method: SwitchMethod;
  progress: number;
  state: SwitchState;
  failure?: { message: string };
  comparison?: SwitchComparison;
  comparisonNote?: string;
  minimumReasonLength: number;
  previousKeptUntil?: string;
  decision?: SwitchDecision;
}

export interface DatasetEngine {
  dataset: string;
  engine: SearchEngineInfo;
  searchTimeMs?: number;
  usedBy: { id: string; name: string }[];
  retentionDays: number;
  canSwitch: boolean;
  previous?: { endpoint: string; title: string; keptUntil: string; switchId: string };
  switch?: EngineSwitch;
}

export interface MethodEstimate extends MethodEstimateView {
  method: SwitchMethod;
}

export interface SwitchEstimate {
  to: string;
  methods: MethodEstimate[];
}

const enc = encodeURIComponent;

const runsAtText = (runsAt: string) =>
  runsAt === 'platform' ? 'Plattformens egen database' : runsAt === 'unknown' ? undefined : runsAt;

const sidOf = (id: string) => id.slice(id.lastIndexOf(':') + 1);

const percent = (share: number) => Math.round(share * 100);

export const toEngineInfo = (view: KnowledgeEndpointView): SearchEngineInfo => {
  const runsAt = runsAtText(view.runsAt);
  return {
    id: view.id,
    engine: view.engine,
    title: view.title,
    ...(view.tech ? { tech: view.tech } : {}),
    builtin: view.builtin,
    ...(view.dataLocation ? { dataLocation: view.dataLocation } : {}),
    ...(runsAt ? { runsAt } : {}),
    ...(view.embeddingModel ? { embeddingModel: { name: view.embeddingModel } } : {}),
    capabilities: view.capabilities.supported,
    ...(view.writeKeyRequired ? { writeKeyRequired: true } : {}),
  };
};

export const toComparison = (c: RetrievalComparison): SwitchComparison => ({
  testSet: `${c.testSets.join(', ')} (${c.cases} spørsmål)`,
  verdict: c.verdict,
  hitAt5: [percent(c.hitAt5[0]), percent(c.hitAt5[1])],
  meanRank: c.meanRank,
  latencyMs: c.latencyMs,
  examples: c.examples.map((x) => ({
    question: x.question,
    before: x.old.first ?? null,
    after: x.new.first ?? null,
    verdict: x.verdict,
  })),
});

export const toSwitch = (view: EngineSwitchView): EngineSwitch => ({
  id: view.sid,
  dataset: view.dataset,
  from: view.from,
  to: view.to,
  method: view.method,
  progress: view.progress.percent,
  state: view.state,
  ...(view.error ? { failure: { message: view.error.message } } : {}),
  ...(view.comparison ? { comparison: toComparison(view.comparison) } : {}),
  ...(view.comparisonNote ? { comparisonNote: view.comparisonNote } : {}),
  minimumReasonLength: view.minimumReasonLength,
  ...(view.previousKeptUntil ? { previousKeptUntil: view.previousKeptUntil } : {}),
  ...(view.decision ? { decision: view.decision } : {}),
});

export const toDatasetEngine = (view: DatasetEngineView): DatasetEngine => {
  const runsAt = runsAtText(view.runsAt);
  return {
    dataset: view.dataset,
    engine: {
      id: view.endpoint,
      engine: view.engine,
      title: view.title,
      ...(view.tech ? { tech: view.tech } : {}),
      builtin: view.builtin,
      ...(view.dataLocation ? { dataLocation: view.dataLocation } : {}),
      ...(runsAt ? { runsAt } : {}),
      ...(view.embedding
        ? {
            embeddingModel: {
              name: view.embedding.model,
              ...(view.embedding.residency ? { dataLocation: view.embedding.residency } : {}),
            },
          }
        : {}),
      capabilities: view.capabilities.supported,
    },
    ...(view.latencyMs !== undefined ? { searchTimeMs: view.latencyMs } : {}),
    usedBy: view.usedBy.map((u) => ({ id: u.id, name: u.name })),
    retentionDays: view.retentionDays,
    canSwitch: view.canSwitch,
    ...(view.previous
      ? {
          previous: {
            endpoint: view.previous.endpoint,
            title: view.previous.title,
            keptUntil: view.previous.keptUntil,
            switchId: sidOf(view.previous.switch),
          },
        }
      : {}),
    ...(view.activeSwitch ? { switch: toSwitch(view.activeSwitch) } : {}),
  };
};

export const toEstimate = (view: SwitchEstimateView): SwitchEstimate => ({
  to: view.to,
  methods: [
    { method: 'copy', ...view.copy },
    { method: 'reingest', ...view.reingest },
  ],
});

export const searchEnginesApi = (ctx: ApiContext) => {
  const dataset = (tenant: string, id: string) => `${ctx.tenantPath(tenant)}/datasets/${enc(id)}`;
  const switchPath = (tenant: string, id: string, switchId: string) =>
    `${dataset(tenant, id)}/engine-switches/${enc(switchId)}`;
  const decide = async (
    tenant: string,
    id: string,
    switchId: string,
    action: 'activate' | 'rollback',
    reason: string,
  ) =>
    toSwitch(
      await ctx.request<EngineSwitchView>(
        'POST',
        `${switchPath(tenant, id, switchId)}/${action}`,
        {},
        { 'change-reason': reason },
      ),
    );
  return {
    engines: async (tenant: string, signal?: AbortSignal) =>
      (
        await ctx.get<{ data: KnowledgeEndpointView[] }>(
          `${ctx.tenantPath(tenant)}/knowledge/endpoints`,
          signal,
        )
      ).data.map(toEngineInfo),
    endpoints: async (tenant: string, signal?: AbortSignal) => {
      const view = await ctx.get<{
        data: KnowledgeEndpointView[];
        defaultEmbedding?: DefaultEmbedding | null;
      }>(`${ctx.tenantPath(tenant)}/knowledge/endpoints`, signal);
      return {
        engines: view.data.map(toEngineInfo),
        defaultEmbedding: view.defaultEmbedding ?? null,
      };
    },
    datasetEngine: async (tenant: string, id: string, signal?: AbortSignal) =>
      toDatasetEngine(await ctx.get<DatasetEngineView>(`${dataset(tenant, id)}/engine`, signal)),
    estimate: async (tenant: string, id: string, to: string, signal?: AbortSignal) =>
      toEstimate(
        await ctx.get<SwitchEstimateView>(
          `${dataset(tenant, id)}/engine-switches/estimate?to=${enc(to)}`,
          signal,
        ),
      ),
    startSwitch: async (
      tenant: string,
      id: string,
      to: string,
      method: SwitchMethod,
      reason: string,
    ) =>
      toSwitch(
        await ctx.request<EngineSwitchView>(
          'POST',
          `${dataset(tenant, id)}/engine-switches`,
          { to, method },
          { 'change-reason': reason },
        ),
      ),
    getSwitch: async (tenant: string, id: string, switchId: string, signal?: AbortSignal) =>
      toSwitch(await ctx.get<EngineSwitchView>(switchPath(tenant, id, switchId), signal)),
    retrySwitch: async (tenant: string, id: string, switchId: string, reason: string) =>
      toSwitch(
        await ctx.request<EngineSwitchView>(
          'POST',
          `${switchPath(tenant, id, switchId)}/retry`,
          {},
          { 'change-reason': reason },
        ),
      ),
    cancelSwitch: async (tenant: string, id: string, switchId: string, reason: string) =>
      toSwitch(
        await ctx.request<EngineSwitchView>(
          'POST',
          `${switchPath(tenant, id, switchId)}/cancel`,
          {},
          { 'change-reason': reason },
        ),
      ),
    activateSwitch: (tenant: string, id: string, switchId: string, reason: string) =>
      decide(tenant, id, switchId, 'activate', reason),
    rollbackSwitch: (tenant: string, id: string, switchId: string, reason: string) =>
      decide(tenant, id, switchId, 'rollback', reason),
  };
};
