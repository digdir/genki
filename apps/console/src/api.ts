import type { FlagState } from '@genai/contracts/flags';
import { translator, type Locale, type T } from './i18n';
import { definitionKindSegments } from './definition-kinds';
import { tenantLabel } from './tenant-names';
import type {
  AuditEntry,
  DatasetSearchAnswer,
  DatasetSearchRequest,
  ModelClassification,
  ModelPrice,
  OperatorModel,
  Problem,
  RefreshResult,
  Tenant,
  DefaultVersion,
  Health,
  ImportResult,
  ServiceImpact,
  SettingInfo,
  SharedService,
  BuildingBlocks,
  ContractRun,
  PluginSummary,
  QualityOverview,
  LabelItem,
  SinkLabelBatch,
  SinkLabels,
  MatrixEstimate,
  MatrixRun,
  MatrixRunDetail,
  TracingStatus,
  RunningTask,
  EffectiveSettings,
  DescriptorDetail,
  DescriptorStatus,
  DescriptorUpload,
  EndpointProcessorRecord,
  Maturity,
  OperationDescriptor,
  OperationKind,
  OperationKinds,
  OperationsOverview,
  OperationTryResult,
  ProcessorRecord,
  WireExchange,
  SettingOverrides,
  SettingsGrid,
  TaskTimeline,
  TraceSettings,
  Availability,
  ConfigEntry,
  ConfigVersion,
  DefinitionVersion,
  IngestionBackend,
  TenantDefinition,
  TenantDefinitionHistory,
  EndpointTestResult,
  KnowledgeEndpoint,
  DatasetEngine,
  EngineSwitch,
  SwitchEstimate,
  KnowledgeEndpointItem,
  KnowledgeEngine,
  StoredSecret,
  FlagChange,
  OperatorFlag,
  PlatformSecret,
  AccessRequest,
  AnswerSource,
  BlockApprovalRequest,
  ChatTurn,
  ModelApi,
  ModelEndpointInput,
  ModelSettings,
  PlatformProposal,
  QuarantinedDefinition,
  ServiceAnswer,
  SkillShareRequest,
  TenantKey,
  QuotaRequestRow,
  QuotaRequestState,
} from './types';

/** GET /operator/state-register: the register and how the state accounts differ (ADR 0058). */
export interface StateRegisterView {
  syncedAt: string | null;
  lastGood: string | null;
  failedNights: number;
  units: number;
  accountsPeriod: string | null;
  same: number;
  differences: {
    orgnr: string;
    name: string;
    kind: 'mismatch' | 'budget-booking' | 'not-in-register';
    registerMinistry?: string;
    registerMinistryName?: string;
    accountsMinistry?: string;
    accountsMinistryName?: string;
  }[];
}

export type DemoApp = 'portal' | 'console' | 'workspace';
export type DemoAudience = 'municipality' | 'state-agency' | 'internal';

export type RecordingStatus = 'queued' | 'running' | 'recorded' | 'failed' | 'cancelled';
export type RecorderMode = 'job' | 'scheduled' | 'workflow';

export interface DemoRecording {
  id: string;
  demo: string;
  demoVersion: number;
  genkiVersion: string;
  status: RecordingStatus;
  steps: number;
  narrated: boolean;
  voice?: string;
  startedAt: string;
  finishedAt?: string;
  seconds?: number;
  files: { name: string; size: number; contentType: string }[];
  failure?: { step: number; command?: string; message: string };
  requestedBy?: string;
  upTo?: number;
  cancelledBy?: string;
}

export interface DemoStep {
  say: string;
  do?: string[][];
  hold?: number;
}

export interface DemoSpec {
  title: string;
  description: string;
  audience: DemoAudience[];
  language: string;
  voice: string;
  viewport?: [number, number];
  app: DemoApp;
  path: string;
  signedIn?: boolean;
  ready?: string;
  steps: DemoStep[];
}

export interface Demo extends DemoSpec {
  id: string;
  version: number;
  updatedBy?: string;
  updatedAt: string;
  latest?: DemoRecording;
  recorded?: DemoRecording;
  open?: DemoRecording;
}

export interface DemoLibrary {
  genkiVersion: string | null;
  recorder?: RecorderMode;
  data: Demo[];
}

export interface DemoDetail extends Demo {
  genkiVersion: string | null;
  recorder?: RecorderMode;
  recordings: DemoRecording[];
}

export interface DemoSettings {
  voice: string;
  viewport: [number, number];
  tenant: string | null;
  login: string;
  retentionDays: number;
  writerDailyTokens: number;
}

export interface DemoSettingsView extends DemoSettings {
  version: number;
  updatedBy?: string;
  updatedAt?: string;
  recorder: RecorderMode;
  sample?: { recording: string; file: string };
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | undefined,
  ) {
    super(problem?.title ?? problem?.error ?? `Request failed with status ${status}`);
    this.name = 'ApiError';
  }
}

export interface ApiClientOptions {
  baseUrl: string;
  fetch: typeof fetch;
  token: () => string | undefined;
  actorName?: () => string | undefined;
  locale?: () => Locale;
  settingsGrid?: boolean;
}

interface MonthUsage {
  orgNumber: string;
  usage: { inputTokens: number; outputTokens: number; costMicroNok: number | null };
}

export interface OrganizationLookup {
  orgNumber: string;
  name: string;
  source: 'platform' | 'enhetsregisteret';
}

export type ApiClient = ReturnType<typeof createApiClient>;

const usageFreshMs = 30_000;

const encodeReason = (headers: Record<string, string>) =>
  headers['change-reason'] === undefined
    ? headers
    : { ...headers, 'change-reason': encodeURIComponent(headers['change-reason']) };

const builtinEngines: Record<string, (t: T) => Pick<KnowledgeEngine, 'title' | 'tech'>> = {
  pgvector: (t) => ({
    title: t('searchEngines.enginePgvector'),
    tech: t('searchEngines.enginePgvectorTech'),
  }),
};

export const localizedEngine = (engine: KnowledgeEngine, t: T): KnowledgeEngine => {
  const names = builtinEngines[engine.engine];
  return names ? { ...engine, ...names(t) } : engine;
};

export const lockedEnvironmentType = 'urn:genai:problem:locked-environment';
export const contentReasonRequiredType = 'urn:genai:problem:content-reason-required';

export type ContentReasonHandler = (tenant: string) => Promise<void>;

export interface GivenContentReason {
  tenant: string;
  reason: string;
  day: string;
  expiresAt: string;
}

const contentReasonTenant = (error: ApiError, path: string) => {
  if (error.status !== 403 || error.problem?.type !== contentReasonRequiredType) return undefined;
  const named = (error.problem as { tenant?: unknown }).tenant;
  if (typeof named === 'string' && named) return named;
  const fromPath = /^\/tenants\/([^/?]+)/.exec(path)?.[1];
  return fromPath ? decodeURIComponent(fromPath) : undefined;
};

async function* sseData(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const events = buffer.split(/\r?\n\r?\n/);
    buffer = done ? '' : (events.pop() ?? '');
    for (const event of events) {
      const data = event
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (data) yield data;
    }
    if (done) return;
  }
}

const problemOf = (status: number, body: unknown): Problem | undefined => {
  if (typeof body !== 'object' || body === null) return undefined;
  const { type, error } = body as { type?: unknown; error?: unknown };
  if (typeof type === 'string') return body as Problem;
  const message = (error as { message?: unknown } | undefined)?.message;
  return typeof message === 'string' ? { type: 'about:blank', title: message, status } : undefined;
};

interface ChatFrame {
  retract?: boolean;
  no_answer?: boolean;
  notice?: string;
  sources?: { index?: unknown; title?: unknown; url?: unknown }[];
  error?: { message?: unknown };
  choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
}

const sourcesOf = (frame: ChatFrame): AnswerSource[] =>
  (frame.sources ?? []).map((s) => ({
    title: typeof s.title === 'string' && s.title ? s.title : String(s.url ?? ''),
    ...(typeof s.index === 'number' ? { index: s.index } : {}),
    ...(typeof s.url === 'string' && /^https?:\/\//i.test(s.url) ? { url: s.url } : {}),
  }));

export const createApiClient = ({
  baseUrl,
  fetch: send,
  token,
  actorName,
  locale,
  settingsGrid = true,
}: ApiClientOptions) => {
  const say = () => translator(locale?.() ?? 'nb');
  let askContentReason: ContentReasonHandler | undefined;
  const givingReason = new Map<string, Promise<void>>();
  const request = async <T>(
    method: string,
    path: string,
    {
      body,
      signal,
      headers = {},
    }: { body?: unknown; signal?: AbortSignal | undefined; headers?: Record<string, string> } = {},
  ): Promise<T> => {
    const bearer = token();
    const name = actorName?.();
    const response = await send(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...encodeReason(headers),
        ...(name ? { 'actor-name': encodeURIComponent(name) } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as Problem | undefined;
      throw new ApiError(response.status, problem);
    }
    const text = await response.text();
    return (text ? JSON.parse(text) : undefined) as T;
  };
  const giveReasonFor = (tenant: string, refused: ApiError, ask: ContentReasonHandler) => {
    const pending = givingReason.get(tenant);
    if (pending) return pending;
    const giving = ask(tenant)
      .catch(() => {
        throw refused;
      })
      .finally(() => givingReason.delete(tenant));
    givingReason.set(tenant, giving);
    return giving;
  };
  const call = async <T>(
    method: string,
    path: string,
    options?: Parameters<typeof request>[2],
  ): Promise<T> => {
    try {
      return await request<T>(method, path, options);
    } catch (e) {
      const tenant = e instanceof ApiError ? contentReasonTenant(e, path) : undefined;
      const ask = askContentReason;
      if (!tenant || !ask) throw e;
      await giveReasonFor(tenant, e as ApiError, ask);
      return request<T>(method, path, options);
    }
  };
  let usageCache: { key: string; at: number; data: Map<string, MonthUsage['usage']> } | undefined;
  const fetchUsage = async (orgNumbers: string[], signal?: AbortSignal) => {
    const key = orgNumbers.join(',');
    const data = await call<{ data: MonthUsage[] }>(
      'GET',
      `/operator/usage?tenants=${encodeURIComponent(key)}`,
      { signal },
    ).then(
      (r) => new Map(r.data.map((u) => [u.orgNumber, u.usage] as const)),
      () => new Map<string, MonthUsage['usage']>(),
    );
    if (data.size > 0) usageCache = { key, at: Date.now(), data };
    return data;
  };
  const monthUsage = async (orgNumbers: string[], signal?: AbortSignal) => {
    const key = orgNumbers.join(',');
    if (usageCache?.key !== key) return fetchUsage(orgNumbers, signal);
    if (Date.now() - usageCache.at > usageFreshMs) void fetchUsage(orgNumbers);
    return usageCache.data;
  };
  const decision = (path: string, approve: boolean, reason: string, extra = {}) =>
    call<unknown>('POST', path, {
      body: { approve, reason, ...extra },
      headers: { 'change-reason': reason },
    });
  return {
    getJson: (path: string, signal?: AbortSignal, language?: Locale) =>
      call<unknown>('GET', path, {
        signal,
        ...(language ? { headers: { 'accept-language': language } } : {}),
      }),
    hasSettingsGrid: settingsGrid,
    settingsGrid: (signal?: AbortSignal) =>
      call<SettingsGrid>('GET', '/operator/settings/grid', { signal }),
    actor: () => actorName?.(),
    listTenants: async (signal?: AbortSignal, options: { usage?: boolean } = {}) => {
      const tenants = (
        await call<{ data: (Tenant & { usedTokens?: number; monthlyTokens?: number })[] }>(
          'GET',
          '/operator/tenants',
          { signal },
        )
      ).data;
      const usage =
        options.usage && tenants.length
          ? await monthUsage(
              tenants.map((t) => t.orgNumber),
              signal,
            )
          : new Map<string, MonthUsage['usage']>();
      return tenants.map(({ usedTokens, monthlyTokens, ...t }): Tenant => {
        const used = usage.get(t.orgNumber);
        return {
          ...t,
          name: tenantLabel(t.orgNumber, t.name, say()),
          ...(used
            ? {
                tokensMillions: (used.inputTokens + used.outputTokens) / 1_000_000,
                costNok: used.costMicroNok === null ? null : used.costMicroNok / 1_000_000,
              }
            : {}),
          ...(usedTokens === undefined ? {} : { tokensMillions: usedTokens / 1_000_000 }),
          ...(monthlyTokens === undefined ? {} : { quotaMillions: monthlyTokens / 1_000_000 }),
        };
      });
    },
    listModels: async (signal?: AbortSignal) =>
      (await call<{ data: OperatorModel[] }>('GET', '/operator/models', { signal })).data,
    operationKinds: async (signal?: AbortSignal) =>
      (await call<{ data: OperationKind[] }>('GET', '/operator/operation-kinds', { signal })).data,
    operationKindsOverview: (signal?: AbortSignal) =>
      call<OperationKinds>('GET', '/operator/operation-kinds', { signal }),
    setKindMaturity: (kind: string, maturity: Maturity, reason: string) =>
      call<OperationKind>(
        'POST',
        `/operator/operation-kinds/${encodeURIComponent(kind)}/maturity`,
        {
          body: { maturity },
          headers: { 'change-reason': reason },
        },
      ),
    deleteKind: (kind: string, reason: string) =>
      call<unknown>('DELETE', `/operator/operation-kinds/${encodeURIComponent(kind)}`, {
        headers: { 'change-reason': reason },
      }),
    operationDescriptors: async (signal?: AbortSignal) =>
      (
        await call<{ data: OperationDescriptor[] }>('GET', '/operator/operation-descriptors', {
          signal,
        })
      ).data,
    operationDescriptor: (id: string, signal?: AbortSignal) =>
      call<DescriptorDetail>('GET', `/operator/operation-descriptors/${id}`, { signal }),
    uploadDescriptor: (id: string, upload: DescriptorUpload, reason: string) =>
      call<OperationDescriptor>('PUT', `/operator/operation-descriptors/${id}`, {
        body: upload,
        headers: { 'change-reason': reason },
      }),
    setDescriptorStatus: (id: string, status: Exclude<DescriptorStatus, 'typed'>, reason: string) =>
      call<OperationDescriptor>('POST', `/operator/operation-descriptors/${id}/status`, {
        body: { status },
        headers: { 'change-reason': reason },
      }),
    withdrawDescriptor: (id: string, reason: string) =>
      call<unknown>('DELETE', `/operator/operation-descriptors/${id}`, {
        headers: { 'change-reason': reason },
      }),
    tryOperation: (id: string, model: string, input: unknown, reason: string) =>
      call<OperationTryResult>('POST', `/operator/operations/${id}/try`, {
        body: { model, input, synthetic: true },
        headers: { 'change-reason': reason },
      }),
    recordFixture: (
      id: string,
      fixture: { task: string; name: string; exchange: WireExchange },
      reason: string,
    ) =>
      call<OperationDescriptor>('POST', `/operator/operation-descriptors/${id}/fixtures`, {
        body: fixture,
        headers: { 'change-reason': reason },
      }),
    processorRecords: async (signal?: AbortSignal) =>
      (
        await call<{ data: EndpointProcessorRecord[] }>('GET', '/operator/processor-records', {
          signal,
        })
      ).data,
    saveProcessorRecord: (endpoint: string, record: ProcessorRecord, reason: string) =>
      call<EndpointProcessorRecord>(
        'PUT',
        `/operator/model-endpoints/${encodeURIComponent(endpoint)}/processor-record`,
        { body: record, headers: { 'change-reason': reason } },
      ),
    removeProcessorRecord: (endpoint: string, reason: string) =>
      call<unknown>(
        'DELETE',
        `/operator/model-endpoints/${encodeURIComponent(endpoint)}/processor-record`,
        { headers: { 'change-reason': reason } },
      ),
    refreshModels: (reason: string) =>
      call<RefreshResult>('POST', '/operator/models/refresh', {
        headers: { 'change-reason': reason },
      }),
    classifyModel: (id: string, classification: ModelClassification, reason: string) =>
      call<OperatorModel>('PATCH', `/operator/models/${id}`, {
        body: classification,
        headers: { 'change-reason': reason },
      }),
    health: (signal?: AbortSignal) => call<Health>('GET', '/health', { signal }),
    readOnlyInLockdown: async (signal?: AbortSignal) =>
      (await call<{ lockdownReadOnly?: boolean }>('GET', '/me', { signal })).lockdownReadOnly ===
      true,
    askService: async (
      model: string,
      messages: ChatTurn[],
      onText: (text: string) => void,
      signal?: AbortSignal,
    ): Promise<ServiceAnswer> => {
      const bearer = token();
      const response = await send(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: {
          accept: 'text/event-stream',
          'content-type': 'application/json',
          'accept-language': locale?.() ?? 'nb',
          ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        },
        body: JSON.stringify({ model, messages, stream: true, genai_stream: 'live' }),
        ...(signal ? { signal } : {}),
      });
      if (!response.ok || !response.body) {
        const body: unknown = await response.json().catch(() => undefined);
        throw new ApiError(response.status, problemOf(response.status, body));
      }
      let text = '';
      let notice = '';
      let sources: AnswerSource[] = [];
      for await (const data of sseData(response.body)) {
        if (data === '[DONE]') break;
        let frame: ChatFrame;
        try {
          frame = JSON.parse(data) as ChatFrame;
        } catch {
          continue;
        }
        if (frame.retract) {
          text = '';
          onText(text);
        }
        if (frame.sources) sources = sourcesOf(frame);
        if (frame.no_answer && typeof frame.notice === 'string') notice = frame.notice;
        const choice = frame.choices?.[0];
        if (choice?.finish_reason === 'error')
          throw new ApiError(502, problemOf(502, { error: frame.error }));
        if (choice?.delta?.content) {
          text += choice.delta.content;
          onText(text);
        }
      }
      return { text: text || notice, sources };
    },
    settingsCatalog: async (signal?: AbortSignal) =>
      (await call<{ data: SettingInfo[] }>('GET', '/settings', { signal })).data,
    defaults: async (signal?: AbortSignal) =>
      (await call<{ data: DefaultVersion[] }>('GET', '/settings/defaults', { signal })).data,
    changelog: async (key: string, signal?: AbortSignal) =>
      (
        await call<{ data: DefaultVersion[] }>(
          'GET',
          `/settings/defaults/${encodeURIComponent(key)}/changelog`,
          { signal },
        )
      ).data,
    previewDefault: async (key: string, value: unknown, reason: string) =>
      (
        await call<{ dryRun: true; services: ServiceImpact[] }>(
          'PUT',
          `/settings/defaults/${encodeURIComponent(key)}?dryRun=true`,
          { body: { value }, headers: { 'change-reason': reason } },
        )
      ).services,
    setDefault: (key: string, value: unknown, reason: string) =>
      call<{ task: string; value: unknown }>(
        'PUT',
        `/settings/defaults/${encodeURIComponent(key)}`,
        { body: { value }, headers: { 'change-reason': reason } },
      ),
    exportTenant: (tenant: string, signal?: AbortSignal) =>
      call<Record<string, unknown>>('GET', `/tenants/${encodeURIComponent(tenant)}/export`, {
        signal,
      }),
    importTenant: (
      tenant: string,
      bundle: Record<string, unknown>,
      options: { dryRun: boolean; reason: string },
    ) =>
      call<ImportResult>(
        'POST',
        `/tenants/${encodeURIComponent(tenant)}/import?dryRun=${options.dryRun}`,
        {
          body: bundle,
          headers: { 'change-reason': options.reason },
        },
      ),
    onContentReason: (handler: ContentReasonHandler | undefined) => {
      askContentReason = handler;
    },
    giveContentReason: (tenant: string, reason: string) =>
      call<GivenContentReason>(
        'POST',
        `/operator/tenants/${encodeURIComponent(tenant)}/content-reason`,
        { body: { reason } },
      ),
    demos: (signal?: AbortSignal) => call<DemoLibrary>('GET', '/operator/demos', { signal }),
    demo: (id: string, signal?: AbortSignal) =>
      call<DemoDetail>('GET', `/operator/demos/${encodeURIComponent(id)}`, { signal }),
    saveDemo: (id: string, spec: DemoSpec, reason: string, version?: number) =>
      call<Demo>('PUT', `/operator/demos/${encodeURIComponent(id)}`, {
        body: spec,
        headers: {
          'change-reason': reason,
          ...(version === undefined ? {} : { 'if-match': String(version) }),
        },
      }),
    requestRecording: (id: string, reason: string, upTo?: number) =>
      call<DemoRecording>('POST', `/operator/demos/${encodeURIComponent(id)}/recordings`, {
        body: upTo === undefined ? {} : { upTo },
        headers: { 'change-reason': reason },
      }),
    recording: (id: string, signal?: AbortSignal) =>
      call<DemoRecording>('GET', `/operator/recordings/${encodeURIComponent(id)}`, { signal }),
    cancelRecording: (id: string, reason: string) =>
      call<DemoRecording>('POST', `/operator/recordings/${encodeURIComponent(id)}/cancel`, {
        headers: { 'change-reason': reason },
      }),
    demoSettings: (signal?: AbortSignal) =>
      call<DemoSettingsView>('GET', '/operator/demo-settings', { signal }),
    saveDemoSettings: (settings: DemoSettings, reason: string, version: number) =>
      call<DemoSettingsView>('PUT', '/operator/demo-settings', {
        body: settings,
        headers: { 'change-reason': reason, 'if-match': String(version) },
      }),
    demoFile: async (recording: string, name: string, signal?: AbortSignal) => {
      const bearer = token();
      const response = await send(
        `${baseUrl}/operator/recordings/${encodeURIComponent(recording)}/files/${encodeURIComponent(name)}`,
        {
          headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
          ...(signal ? { signal } : {}),
        },
      );
      if (!response.ok)
        throw new ApiError(
          response.status,
          (await response.json().catch(() => undefined)) as Problem | undefined,
        );
      return response.blob();
    },
    stateRegister: (signal?: AbortSignal) =>
      call<StateRegisterView>('GET', '/operator/state-register', { signal }),
    sharedServices: async (signal?: AbortSignal) =>
      (await call<{ data: SharedService[] }>('GET', '/operator/shared-services', { signal })).data,
    shareService: (
      tenant: string,
      id: string,
      availableTo: SharedService['availableTo'],
      reason: string,
    ) =>
      call<{ version: number; availableTo: SharedService['availableTo'] }>(
        'PUT',
        `/operator/shared-services/${encodeURIComponent(tenant)}/${encodeURIComponent(id)}`,
        { body: { availableTo }, headers: { 'change-reason': reason } },
      ),
    buildingBlocks: async (signal?: AbortSignal): Promise<BuildingBlocks> => {
      const blocks = await call<BuildingBlocks>('GET', '/operator/building-blocks', { signal });
      if (blocks.registry) return blocks;
      const plugins = await call<{ data: PluginSummary[] }>('GET', '/operator/plugins', {
        signal,
      }).then(
        (r) => r.data,
        () => undefined,
      );
      return plugins ? { ...blocks, plugins } : blocks;
    },
    quality: (signal?: AbortSignal) =>
      call<QualityOverview>('GET', '/operator/quality', { signal }),
    labelQueue: async (signal?: AbortSignal) =>
      await call<{ data: LabelItem[]; total: number }>('GET', '/operator/quality/label-queue', {
        signal,
      }),
    addLabel: (item: LabelItem, humanLabel: 'good' | 'bad', reason: string) =>
      call<unknown>('POST', '/operator/quality/labels', {
        body: { item: item.item, judge: item.judge, judgeLabel: item.judgeLabel, humanLabel },
        headers: { 'change-reason': reason },
      }),
    sinkLabels: (signal?: AbortSignal) =>
      call<SinkLabels>('GET', '/operator/quality/sink-labels', { signal }),
    fetchSinkLabels: (tenant: string, connection: string) =>
      call<{ pending: number; shared?: { name: string; rules: string[] }[] }>(
        'POST',
        '/operator/quality/sink-labels/fetch',
        {
          body: { tenant, connection },
        },
      ),
    decideSinkLabels: (batch: SinkLabelBatch, decision: 'accept' | 'reject', reason: string) =>
      call<{ accepted?: number; rejected?: number }>(
        'POST',
        `/operator/quality/sink-labels/${decision}`,
        {
          body: {
            tenant: batch.tenant,
            connection: batch.connection,
            judge: batch.judge,
            labels: batch.labels.map((l) => ({ id: l.id, revision: l.revision })),
          },
          headers: { 'change-reason': reason },
        },
      ),
    tracing: (signal?: AbortSignal) => call<TracingStatus>('GET', '/operator/tracing', { signal }),
    runningTasks: async (filter: { tenant?: string; service?: string }, signal?: AbortSignal) => {
      const query = new URLSearchParams(
        Object.entries(filter).filter((e): e is [string, string] => Boolean(e[1])),
      ).toString();
      return (
        await call<{ data: RunningTask[] }>(
          'GET',
          `/operator/running-tasks${query ? `?${query}` : ''}`,
          {
            signal,
          },
        )
      ).data;
    },
    tasks: async (status: string, signal?: AbortSignal) =>
      (
        await call<{ data: RunningTask[] }>(
          'GET',
          `/operator/tasks?${new URLSearchParams({ status }).toString()}`,
          { signal },
        )
      ).data,
    cancelTask: (task: string, reason: string) =>
      call<{ task: string; cancelled: boolean }>(
        'POST',
        `/operator/tasks/${encodeURIComponent(task)}/cancel`,
        {
          headers: { 'change-reason': reason },
        },
      ),
    operatorAudit: async (signal?: AbortSignal) =>
      (await call<{ data: AuditEntry[] }>('GET', '/operator/audit', { signal })).data,
    logAuditExport: (count: number) =>
      call<unknown>('POST', '/operator/audit/exports', {
        body: { count },
        headers: { 'change-reason': say()('api.exportReason') },
      }),
    remindOnboarding: (orgNumber: string) =>
      call<unknown>('POST', `/operator/onboarding/${encodeURIComponent(orgNumber)}/reminders`, {
        headers: { 'change-reason': say()('api.reminderReason') },
      }),
    lookupOrganization: (orgNumber: string, signal?: AbortSignal) =>
      call<OrganizationLookup>('GET', `/operator/organizations/${encodeURIComponent(orgNumber)}`, {
        signal,
      }),
    registerTenant: (orgNumber: string, name: string, reason: string) =>
      call<unknown>('POST', '/operator/tenants', {
        body: { orgNumber, name },
        headers: { 'change-reason': reason },
      }),
    settingOverrides: (signal?: AbortSignal) =>
      call<SettingOverrides>('GET', '/operator/settings/overrides', { signal }),
    effective: (tenant: string, service: string, signal?: AbortSignal) =>
      call<EffectiveSettings>(
        'GET',
        `/tenants/${encodeURIComponent(tenant)}/settings/effective?service=${encodeURIComponent(service)}`,
        { signal },
      ),
    timeline: (tenant: string, task: string, signal?: AbortSignal) =>
      call<TaskTimeline>(
        'GET',
        `/tenants/${encodeURIComponent(tenant)}/tasks/${encodeURIComponent(task)}/timeline`,
        { signal },
      ),
    operations: (signal?: AbortSignal) =>
      call<OperationsOverview>('GET', '/operator/operations', { signal }),
    setBlockAvailability: (
      id: string,
      availability: Availability,
      agencies: string[],
      reason: string,
    ) =>
      call<unknown>('PUT', `/operator/building-blocks/${encodeURIComponent(id)}/availability`, {
        body: { availability, agencies },
        headers: { 'change-reason': reason },
      }),
    releaseBlockVersion: (id: string, version: string, reason: string) =>
      call<unknown>(
        'POST',
        `/operator/building-blocks/${encodeURIComponent(id)}/versions/${encodeURIComponent(version)}/release`,
        { headers: { 'change-reason': reason } },
      ),
    disableBlock: (id: string, reason: string) =>
      call<unknown>('POST', `/operator/building-blocks/${encodeURIComponent(id)}/disable`, {
        headers: { 'change-reason': reason },
      }),
    rerunContractTests: (id: string, reason: string) =>
      call<Partial<ContractRun>>(
        'POST',
        `/operator/building-blocks/${encodeURIComponent(id)}/contract-tests`,
        { headers: { 'change-reason': reason } },
      ),
    estimateMatrix: (model: string, current: string) =>
      call<MatrixEstimate>('POST', '/operator/quality/matrix/estimate', {
        body: { model, current },
      }),
    startMatrix: (model: string, current: string, confirmedCostNok: number, reason?: string) =>
      call<MatrixRun>('POST', '/operator/quality/matrix/runs', {
        body: { model, current, confirmedCostNok },
        headers: { 'change-reason': reason ?? `Kvalitetsmatrisen for ${model} mot ${current}` },
      }),
    matrixRun: (id: string, signal?: AbortSignal) =>
      call<MatrixRunDetail>('GET', `/operator/quality/matrix/runs/${encodeURIComponent(id)}`, {
        signal,
      }),
    registerPlugin: (manifest: Record<string, unknown>) =>
      call<unknown>('POST', '/operator/plugins', {
        body: { manifest },
        headers: {
          'change-reason':
            `Registrerte ekstern byggekloss ${typeof manifest.id === 'string' ? manifest.id : ''}`.trim(),
        },
      }),
    releaseMatrixColumn: (kind: 'models' | 'blocks', name: string, reason?: string) =>
      call<unknown>('POST', '/operator/quality/matrix/release', {
        body: { kind, name },
        headers: {
          'change-reason': reason ?? `Gjort tilgjengelig fra kvalitetsmatrisen: ${name}`,
        },
      }),
    saveTracing: (tool: string, settings: TraceSettings) =>
      call<unknown>('PUT', `/operator/tracing/${encodeURIComponent(tool)}`, {
        body: settings,
        headers: { 'change-reason': say()('api.tracingReason') },
      }),
    testTracing: (tool: string) =>
      call<{ delivered: boolean; seconds?: number; code?: string }>(
        'POST',
        `/operator/tracing/${encodeURIComponent(tool)}/test`,
      ),
    disconnectTracing: (tool: string) =>
      call<unknown>('DELETE', `/operator/tracing/${encodeURIComponent(tool)}`, {
        headers: { 'change-reason': 'Koblet fra sporing' },
      }),
    tenantDefinitions: async (tenant: string, signal?: AbortSignal) =>
      (
        await call<{ data: TenantDefinition[] }>(
          'GET',
          `/operator/tenants/${encodeURIComponent(tenant)}/definitions`,
          { signal },
        )
      ).data,
    tenantDefinition: (
      tenant: string,
      kind: TenantDefinition['kind'],
      id: string,
      signal?: AbortSignal,
    ) =>
      call<TenantDefinitionHistory>(
        'GET',
        `/operator/tenants/${encodeURIComponent(tenant)}/definitions/${definitionKindSegments[kind]}/${encodeURIComponent(id)}`,
        { signal },
      ),
    tenantDefinitionVersion: (
      tenant: string,
      kind: TenantDefinition['kind'],
      id: string,
      version: number,
      signal?: AbortSignal,
    ) =>
      call<DefinitionVersion>(
        'GET',
        `/operator/tenants/${encodeURIComponent(tenant)}/definitions/${definitionKindSegments[kind]}/${encodeURIComponent(id)}/versions/${version}`,
        { signal },
      ),
    configList: (path: string, signal?: AbortSignal) =>
      call<{
        data: ConfigEntry[];
        kinds?: string[];
        tenantKinds?: string[];
        backend?: IngestionBackend;
      }>('GET', path, {
        signal,
      }),
    configHistory: async (path: string, signal?: AbortSignal) =>
      (await call<{ data: ConfigVersion[] }>('GET', path, { signal })).data,
    configSave: (
      path: string,
      body: Record<string, unknown>,
      options: { reason: string; ifVersion?: number | undefined; method?: 'PUT' | 'POST' },
    ) =>
      call<ConfigEntry>(options.method ?? 'PUT', path, {
        body,
        headers: {
          'change-reason': options.reason,
          ...(options.ifVersion === undefined ? {} : { 'if-match': `"${options.ifVersion}"` }),
        },
      }),
    configDelete: (path: string, reason: string) =>
      call<unknown>('DELETE', path, { headers: { 'change-reason': reason } }),
    configPost: (path: string, reason: string) =>
      call<unknown>('POST', path, { body: {}, headers: { 'change-reason': reason } }),
    knowledgeEngines: async (signal?: AbortSignal) =>
      (
        await call<{ data: KnowledgeEngine[] }>('GET', '/operator/knowledge/engines', { signal })
      ).data.map((engine) => localizedEngine(engine, say())),
    knowledgeEndpoints: async (signal?: AbortSignal) =>
      (
        await call<{ data: KnowledgeEndpoint[] }>('GET', '/operator/knowledge/endpoints', {
          signal,
        })
      ).data,
    /** Searches a dataset directly, as a service's search does; `base` is the dataset's path. */
    datasetSearch: (base: string, body: DatasetSearchRequest, signal?: AbortSignal) =>
      call<DatasetSearchAnswer>('POST', `${base}/search`, { body, signal }),
    /** `base` is a dataset's path: `/operator/datasets/{id}` or `/tenants/{org}/datasets/{id}`. */
    datasetEngine: (base: string, signal?: AbortSignal) =>
      call<DatasetEngine>('GET', `${base}/engine`, { signal }),
    engineSwitchEstimate: (base: string, to: string, signal?: AbortSignal, model?: string) =>
      call<SwitchEstimate>(
        'GET',
        `${base}/engine-switches/estimate?to=${encodeURIComponent(to)}&method=reingest${
          model ? `&model=${encodeURIComponent(model)}` : ''
        }`,
        { signal },
      ),
    engineSwitch: (base: string, sid: string, signal?: AbortSignal) =>
      call<EngineSwitch>('GET', `${base}/engine-switches/${encodeURIComponent(sid)}`, { signal }),
    startEngineSwitch: (
      base: string,
      body: {
        to: string;
        method: 'copy' | 'reingest';
        embedding?: { model: string; dimensions: number };
        /** Source ids for a copy of named documents. */
        documents?: string[];
      },
      reason: string,
    ) =>
      call<EngineSwitch>('POST', `${base}/engine-switches`, {
        body,
        headers: { 'change-reason': reason },
      }),
    engineSwitchAction: (
      base: string,
      sid: string,
      action: 'retry' | 'cancel' | 'activate' | 'rollback' | 'readmit',
      reason: string,
    ) =>
      call<EngineSwitch>('POST', `${base}/engine-switches/${encodeURIComponent(sid)}/${action}`, {
        body: {},
        headers: { 'change-reason': reason },
      }),
    knowledgeSecrets: async (signal?: AbortSignal) =>
      (await call<{ data: StoredSecret[] }>('GET', '/operator/knowledge/secrets', { signal })).data,
    testKnowledgeEndpoint: (spec: Record<string, unknown>) =>
      call<EndpointTestResult>('POST', '/operator/knowledge/endpoints/test', { body: spec }),
    knowledgeEndpoint: (id: string, signal?: AbortSignal) =>
      call<KnowledgeEndpointItem>(
        'GET',
        `/operator/catalog/knowledge-endpoint/${encodeURIComponent(id)}`,
        { signal },
      ),
    saveKnowledgeEndpoint: (id: string, spec: Record<string, unknown>, reason: string) =>
      call<ConfigEntry>('PUT', `/operator/catalog/knowledge-endpoint/${encodeURIComponent(id)}`, {
        body: spec,
        headers: { 'change-reason': reason },
      }),
    deleteKnowledgeEndpoint: (id: string, reason: string) =>
      call<unknown>('DELETE', `/operator/knowledge/endpoints/${encodeURIComponent(id)}`, {
        headers: { 'change-reason': reason },
      }),
    blockApprovalRequests: async (signal?: AbortSignal) =>
      (
        await call<{ data: BlockApprovalRequest[] }>(
          'GET',
          '/operator/building-blocks/approval-requests',
          { signal },
        )
      ).data,
    decideBlockApproval: (id: string, approve: boolean, reason: string) =>
      decision(
        `/operator/building-blocks/approval-requests/${encodeURIComponent(id)}/decision`,
        approve,
        reason,
      ),
    skillShares: async (signal?: AbortSignal) =>
      (await call<{ data: SkillShareRequest[] }>('GET', '/operator/skills/shares', { signal }))
        .data,
    decideSkillShare: (id: string, approve: boolean, reason: string) =>
      decision(`/operator/skills/shares/${encodeURIComponent(id)}/decision`, approve, reason),
    platformProposals: async (signal?: AbortSignal) =>
      (await call<{ data: PlatformProposal[] }>('GET', '/operator/proposals?level=4', { signal }))
        .data,
    decideProposal: (id: string, approve: boolean, reason: string, caseId?: string) =>
      decision(
        `/operator/proposals/${encodeURIComponent(id)}/decision`,
        approve,
        reason,
        caseId ? { caseId } : {},
      ),
    plugins: async (signal?: AbortSignal) =>
      (await call<{ data: PluginSummary[] }>('GET', '/operator/plugins', { signal })).data,
    setProposalStatus: (id: string, status: 'under_review', reason: string) =>
      call<unknown>('POST', `/operator/proposals/${encodeURIComponent(id)}/status`, {
        body: { status, reason },
        headers: { 'change-reason': reason },
      }),
    tenantKeys: async (tenant: string, signal?: AbortSignal) =>
      (
        await call<{ keys: TenantKey[] }>('GET', `/tenants/${encodeURIComponent(tenant)}/access`, {
          signal,
        })
      ).keys,
    revokeTenantKey: (tenant: string, id: string, reason: string) =>
      call<TenantKey>(
        'POST',
        `/tenants/${encodeURIComponent(tenant)}/api-keys/${encodeURIComponent(id)}/revoke`,
        { body: {}, headers: { 'change-reason': reason } },
      ),
    tenantSettings: (tenant: string, signal?: AbortSignal) =>
      call<EffectiveSettings>('GET', `/tenants/${encodeURIComponent(tenant)}/settings/effective`, {
        signal,
      }),
    setTenantSetting: (tenant: string, key: string, value: unknown, reason: string) =>
      call<unknown>(
        'PUT',
        `/tenants/${encodeURIComponent(tenant)}/settings/${encodeURIComponent(key)}`,
        { body: { value }, headers: { 'change-reason': reason } },
      ),
    accessRequests: async (signal?: AbortSignal) =>
      (await call<{ data: AccessRequest[] }>('GET', '/operator/onboarding/requests', { signal }))
        .data,
    decideAccessRequest: (id: string, approve: boolean, reason: string) =>
      decision(`/operator/onboarding/requests/${encodeURIComponent(id)}/decision`, approve, reason),
    quarantinedDefinitions: async (signal?: AbortSignal) =>
      (
        await call<{ data: QuarantinedDefinition[] }>('GET', '/operator/definitions/quarantine', {
          signal,
        })
      ).data,
    modelEndpoints: async (signal?: AbortSignal) =>
      (
        await call<{ data: ConfigEntry[] }>(
          'GET',
          '/operator/catalog/entries?kind=model-endpoint',
          { signal },
        )
      ).data.filter((e) => !e.scope || e.scope === 'platform'),
    addModelEndpoint: (id: string, endpoint: ModelEndpointInput, reason: string) =>
      call<unknown>('POST', '/operator/model-endpoints', {
        body: { id, ...endpoint },
        headers: { 'change-reason': reason },
      }),
    updateModelEndpoint: (id: string, endpoint: ModelEndpointInput, reason: string) =>
      call<unknown>('PUT', `/operator/model-endpoints/${encodeURIComponent(id)}`, {
        body: endpoint,
        headers: { 'change-reason': reason },
      }),
    modelApis: async (signal?: AbortSignal) =>
      (await call<{ data: ModelApi[] }>('GET', '/operator/apis', { signal })).data,
    deleteModelEndpoint: (id: string, reason: string) =>
      call<unknown>('DELETE', `/operator/model-endpoints/${encodeURIComponent(id)}`, {
        headers: { 'change-reason': reason },
      }),
    saveModel: (id: string, model: ModelSettings, reason: string) =>
      call<OperatorModel>('PUT', `/operator/models/${id}`, {
        body: model,
        headers: { 'change-reason': reason },
      }),
    setModelPrice: (id: string, price: ModelPrice, reason: string) =>
      call<unknown>('PUT', `/operator/models/${id}/price`, {
        body: price,
        headers: { 'change-reason': reason },
      }),
    flags: async (signal?: AbortSignal) =>
      (await call<{ data: OperatorFlag[] }>('GET', '/operator/flags', { signal })).data,
    myFlags: async (signal?: AbortSignal) =>
      (await call<{ data: FlagState[] }>('GET', '/me/flags', { signal })).data,
    setFlag: (key: string, change: FlagChange, reason: string) =>
      call<FlagState>('PUT', `/operator/flags/${encodeURIComponent(key)}`, {
        body: change,
        headers: { 'change-reason': reason },
      }),
    platformSecrets: async (signal?: AbortSignal) =>
      (await call<{ data: PlatformSecret[] }>('GET', '/operator/secrets', { signal })).data,
    saveSecret: (name: string, value: string, reason: string) =>
      call<unknown>('PUT', `/operator/secrets/${encodeURIComponent(name)}`, {
        body: { value },
        headers: { 'change-reason': reason },
      }),
    deleteSecret: (name: string, reason: string) =>
      call<unknown>('DELETE', `/operator/secrets/${encodeURIComponent(name)}`, {
        headers: { 'change-reason': reason },
      }),
    quotaRequests: async (signal?: AbortSignal, state?: QuotaRequestState) =>
      (
        await call<{ data: QuotaRequestRow[] }>(
          'GET',
          `/operator/quota-requests${state ? `?state=${state}` : ''}`,
          { signal },
        )
      ).data,
    decideQuotaRequest: (
      tenant: string,
      id: string,
      decision: Exclude<QuotaRequestState, 'pending'>,
      reason: string,
    ) =>
      call<QuotaRequestRow>(
        'POST',
        `/operator/quota-requests/${encodeURIComponent(tenant)}/${encodeURIComponent(id)}/decision`,
        { body: { decision }, headers: { 'change-reason': reason } },
      ),
    audit: (tenant: string, signal?: AbortSignal) =>
      call<AuditEntry[]>('GET', `/tenants/${encodeURIComponent(tenant)}/audit`, { signal }),
  };
};
