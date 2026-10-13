import { translator, type Locale, type T } from './i18n';
import { tenantLabel } from './tenant-names';
import type {
  AuditEntry,
  ModelClassification,
  ModelPrice,
  OperatorModel,
  Problem,
  RefreshResult,
  SupportSession,
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
  MatrixEstimate,
  MatrixRun,
  MatrixRunDetail,
  TracingStatus,
  SupportSessionRow,
  RunningTask,
  EffectiveSettings,
  OperationsOverview,
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
  KnowledgeEndpointItem,
  KnowledgeEngine,
  StoredSecret,
  AccessRequest,
  BlockApprovalRequest,
  ModelEndpointInput,
  ModelSettings,
  PlatformProposal,
  QuarantinedDefinition,
  SkillShareRequest,
  TenantKey,
} from './types';

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

export const createApiClient = ({
  baseUrl,
  fetch: send,
  token,
  actorName,
  locale,
  settingsGrid = true,
}: ApiClientOptions) => {
  const say = () => translator(locale?.() ?? 'nb');
  const held = new Map<string, string>();
  const supportHeader = (path: string, headers: Record<string, string>) => {
    if ('support-session' in headers) return headers;
    const tenant = /^\/tenants\/([^/?]+)/.exec(path)?.[1];
    const session = tenant ? held.get(decodeURIComponent(tenant)) : undefined;
    return session ? { ...headers, 'support-session': session } : headers;
  };
  const call = async <T>(
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
        ...encodeReason(supportHeader(path, headers)),
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
    holdSupport: (tenant: string, session: string | undefined) => {
      if (session) held.set(tenant, session);
      else held.delete(tenant);
    },
    supportHeld: (tenant: string) => held.has(tenant),
    actor: () => actorName?.(),
    listTenants: async (signal?: AbortSignal, options: { usage?: boolean } = {}) => {
      const tenants = (await call<{ data: Tenant[] }>('GET', '/operator/tenants', { signal })).data;
      const usage =
        options.usage && tenants.length
          ? await monthUsage(
              tenants.map((t) => t.orgNumber),
              signal,
            )
          : new Map<string, MonthUsage['usage']>();
      return tenants.map((t) => {
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
        };
      });
    },
    listModels: async (signal?: AbortSignal) =>
      (await call<{ data: OperatorModel[] }>('GET', '/operator/models', { signal })).data,
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
    exportTenant: (tenant: string, session: string, signal?: AbortSignal) =>
      call<Record<string, unknown>>('GET', `/tenants/${encodeURIComponent(tenant)}/export`, {
        signal,
        headers: { 'support-session': session },
      }),
    importTenant: (
      tenant: string,
      bundle: Record<string, unknown>,
      options: { dryRun: boolean; reason: string; session: string },
    ) =>
      call<ImportResult>(
        'POST',
        `/tenants/${encodeURIComponent(tenant)}/import?dryRun=${options.dryRun}`,
        {
          body: bundle,
          headers: { 'change-reason': options.reason, 'support-session': options.session },
        },
      ),
    openSupportSession: (tenant: string, reason: string, minutes = 30) =>
      call<SupportSession>('POST', '/support-sessions', { body: { tenant, reason, minutes } }),
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
    tracing: (signal?: AbortSignal) => call<TracingStatus>('GET', '/operator/tracing', { signal }),
    supportSessions: async (signal?: AbortSignal) =>
      (await call<{ data: SupportSessionRow[] }>('GET', '/operator/support-sessions', { signal }))
        .data,
    endSupportSession: (id: string, reason: string) =>
      call<SupportSessionRow>('POST', `/operator/support-sessions/${encodeURIComponent(id)}/end`, {
        headers: { 'change-reason': reason },
      }),
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
    effective: (tenant: string, service: string, session: string, signal?: AbortSignal) =>
      call<EffectiveSettings>(
        'GET',
        `/tenants/${encodeURIComponent(tenant)}/settings/effective?service=${encodeURIComponent(service)}`,
        { signal, headers: { 'support-session': session } },
      ),
    timeline: (tenant: string, task: string, session: string, signal?: AbortSignal) =>
      call<TaskTimeline>(
        'GET',
        `/tenants/${encodeURIComponent(tenant)}/tasks/${encodeURIComponent(task)}/timeline`,
        { signal, headers: { 'support-session': session } },
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
        `/operator/tenants/${encodeURIComponent(tenant)}/definitions/${kind === 'Service' ? 'services' : 'step-flows'}/${encodeURIComponent(id)}`,
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
        `/operator/tenants/${encodeURIComponent(tenant)}/definitions/${kind === 'Service' ? 'services' : 'step-flows'}/${encodeURIComponent(id)}/versions/${version}`,
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
    extendSupportSession: (id: string, minutes: number, reason: string) =>
      call<SupportSession>('POST', `/operator/support-sessions/${encodeURIComponent(id)}/extend`, {
        body: { minutes },
        headers: { 'change-reason': reason },
      }),
    tenantKeys: async (tenant: string, session: string, signal?: AbortSignal) =>
      (
        await call<{ keys: TenantKey[] }>('GET', `/tenants/${encodeURIComponent(tenant)}/access`, {
          signal,
          headers: { 'support-session': session },
        })
      ).keys,
    revokeTenantKey: (tenant: string, id: string, reason: string, session: string) =>
      call<TenantKey>(
        'POST',
        `/tenants/${encodeURIComponent(tenant)}/api-keys/${encodeURIComponent(id)}/revoke`,
        { body: {}, headers: { 'change-reason': reason, 'support-session': session } },
      ),
    tenantSettings: (tenant: string, session: string, signal?: AbortSignal) =>
      call<EffectiveSettings>('GET', `/tenants/${encodeURIComponent(tenant)}/settings/effective`, {
        signal,
        headers: { 'support-session': session },
      }),
    setTenantSetting: (
      tenant: string,
      key: string,
      value: unknown,
      reason: string,
      session: string,
    ) =>
      call<unknown>(
        'PUT',
        `/tenants/${encodeURIComponent(tenant)}/settings/${encodeURIComponent(key)}`,
        { body: { value }, headers: { 'change-reason': reason, 'support-session': session } },
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
    addModelEndpoint: (endpoint: ModelEndpointInput, reason: string) =>
      call<unknown>('POST', '/operator/model-endpoints', {
        body: endpoint,
        headers: { 'change-reason': reason },
      }),
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
    saveSecret: (name: string, value: string, reason: string) =>
      call<unknown>('PUT', `/operator/secrets/${encodeURIComponent(name)}`, {
        body: { value },
        headers: { 'change-reason': reason },
      }),
    audit: (tenant: string, session: string, signal?: AbortSignal) =>
      call<AuditEntry[]>('GET', `/tenants/${encodeURIComponent(tenant)}/audit`, {
        signal,
        headers: { 'support-session': session },
      }),
  };
};
