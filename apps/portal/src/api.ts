import { assistantApi } from './api/assistant';
import type { StepBlockSchema } from './data/step-blocks';
import type { StrategyEntry } from './data/strategies';
import { buildingBlocksApi } from './api/building-blocks';
import { datasetsApi } from './api/datasets';
import { keyPoliciesApi } from './api/key-policies';
import { maskinportenApi } from './api/maskinporten';
import { hooksApi } from './api/hooks';
import { triggersApi } from './api/triggers';
import { preferencesApi } from './api/preferences';
import { onboardingApi } from './api/onboarding';
import { ApiError } from './api/error';
import { playgroundApi, type PlaygroundInputField } from './api/playground';
import { qualityApi } from './api/quality';
import { recipesApi } from './api/recipes';
import { batchRunsApi } from './api/batch-runs';
import { searchEnginesApi } from './api/search-engines';
import { skillsApi } from './api/skills';
import type {
  DatasetSummary,
  EffectiveSetting,
  FacetField,
  SettingDefaultVersion,
  SettingInfo,
  SettingPreview,
  ModelOption,
  Residency,
  DefinitionListItem,
  DefinitionWithHistory,
  Problem,
  PublishedDefinition,
  TaskTimeline,
  CapabilityModel,
  EvalRunSummary,
  FeedbackItem,
  TestSet,
  ValidationResult,
  AccessView,
  ApiKeyView,
  ClientSpec,
  ClientView,
  ClientsView,
  ServiceKeyView,
  IntegrationsView,
  Overview,
  ServiceLifecycleView,
  ServiceSummaryView,
  SharedService,
  TaskRow,
  UsageReport,
} from './types';

export interface AuditRow {
  task: string;
  tenant: string;
  action: string;
  actor: string;
  actorName?: string;
  onBehalfOf?: string;
  at: string;
  outcome: 'applied' | 'rejected';
  target: string;
  reason: string;
}

export interface ConfigEntry {
  id: string;
  kind?: string;
  scope?: string;
  version: number;
  spec: Record<string, unknown>;
  mandatory?: boolean;
  builtin?: boolean;
  editable?: boolean;
  origin?: string;
  by?: string;
  at?: string;
}

export interface ConfigVersion {
  version: number;
  spec: unknown;
  deleted?: boolean;
  by: string;
  at: string;
  reason: string;
}

export interface IngestionBackend {
  name: string;
  available: boolean;
  reason?: string;
}

export interface DraftRunResult {
  ok: true;
  task: string;
  answer: string;
  noAnswer?: boolean;
}

export interface TenantBundle {
  format?: string;
  tenant?: string;
  definitions?: { definition: { kind?: string; metadata: { id: string; name?: string } } }[];
  settings?: { values?: Record<string, unknown>; pins?: Record<string, number> };
  [key: string]: unknown;
}

export interface ImportPlan {
  dryRun: boolean;
  task?: string;
  plan: { target: string; action: string; conflict: boolean }[];
}

export { ApiError } from './api/error';
import { createResponseCache, tenantOf } from './api/cache';

export interface ApiClientOptions {
  baseUrl: string;
  fetch: typeof fetch;
  token: () => string | undefined;
  actorName?: () => string | undefined;
  locale?: () => string;
}

export type ApiClient = ReturnType<typeof createApiClient>;

export interface ApiContext {
  get: <T>(path: string, signal?: AbortSignal) => Promise<T>;
  request: <T>(
    method: string,
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<T>;
  tenantPath: (tenant: string) => string;
  send?: (
    method: string,
    path: string,
    body: unknown,
    headers?: Record<string, string>,
  ) => Promise<Response>;
}

// Feature clients live in api/<feature>.ts as `(ctx: ApiContext) => ({...})` and are reached as api.<feature>.*.
const featureClients = (ctx: ApiContext) => ({
  buildingBlocks: buildingBlocksApi(ctx),
  skills: skillsApi(ctx),
  playground: playgroundApi(ctx),
  searchEngines: searchEnginesApi(ctx),
  assistant: assistantApi(ctx),
  datasets: datasetsApi(ctx),
  quality: qualityApi(ctx),
  batchRuns: batchRunsApi(ctx),
  onboarding: onboardingApi(ctx),
  maskinporten: maskinportenApi(ctx),
  keyPolicies: keyPoliciesApi(ctx),
  hooks: hooksApi(ctx),
  triggers: triggersApi(ctx),
  preferences: preferencesApi(ctx),
  recipes: recipesApi(ctx),
});

const kindPaths: Record<PublishedDefinition['kind'], string> = {
  Service: 'services',
  StepFlow: 'step-flows',
  Skill: 'skills',
};
const kindPath = (kind: PublishedDefinition['kind']) => kindPaths[kind];

const retryAfterOf = (response: Response) => {
  const seconds = Number(response.headers.get('retry-after'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
};

const encodeReason = (headers: Record<string, string>) =>
  headers['change-reason'] === undefined
    ? headers
    : { ...headers, 'change-reason': encodeURIComponent(headers['change-reason']) };

export const createApiClient = ({
  baseUrl,
  fetch: send,
  token,
  actorName,
  locale,
}: ApiClientOptions) => {
  const language = (): Record<string, string> => (locale ? { 'accept-language': locale() } : {});
  const cache = createResponseCache();
  const fetchJson = async <T>(path: string, signal?: AbortSignal): Promise<T> => {
    const bearer = token();
    const name = actorName?.();
    const response = await send(`${baseUrl}${path}`, {
      headers: {
        accept: 'application/json',
        ...language(),
        ...(name ? { 'actor-name': encodeURIComponent(name) } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as Problem | undefined;
      throw new ApiError(response.status, problem, retryAfterOf(response));
    }
    return (await response.json()) as T;
  };
  const get = <T>(path: string, signal?: AbortSignal): Promise<T> =>
    cache.load(
      `${token() ?? ''}\u0000${locale?.() ?? ''}\u0000${path}`,
      tenantOf(path),
      (s) => fetchJson<T>(path, s),
      signal,
    );
  const afterWrite = async <T>(path: string, write: () => Promise<T>) => {
    const tenant = path.startsWith('/operator') ? undefined : tenantOf(path);
    cache.invalidate(tenant);
    try {
      return await write();
    } finally {
      cache.invalidate(tenant);
    }
  };
  const tenantPath = (tenant: string) => `/tenants/${encodeURIComponent(tenant)}`;

  const sendJson = async <T>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const bearer = token();
    const name = actorName?.();
    const response = await send(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...language(),
        ...encodeReason(headers),
        ...(name ? { 'actor-name': encodeURIComponent(name) } : {}),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const problem = (await response.json().catch(() => undefined)) as Problem | undefined;
      throw new ApiError(response.status, problem, retryAfterOf(response));
    }
    return (await response.json()) as T;
  };

  const request = <T>(
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => afterWrite(path, () => sendJson<T>(method, path, body, headers));

  const sendRaw = async (
    method: string,
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) => {
    const bearer = token();
    const binary = body instanceof Blob || body instanceof FormData;
    return send(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(body === undefined || binary ? {} : { 'content-type': 'application/json' }),
        ...language(),
        ...encodeReason(headers),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      },
      ...(body === undefined ? {} : { body: binary ? body : JSON.stringify(body) }),
    });
  };

  const raw = (method: string, path: string, body: unknown, headers: Record<string, string> = {}) =>
    afterWrite(path, () => sendRaw(method, path, body, headers));

  return {
    cache,
    getJson: (path: string, signal?: AbortSignal) => get<unknown>(path, signal),
    getHealth: (signal?: AbortSignal) =>
      fetchJson<{ status: 'ok'; version: string; lockdown?: boolean }>('/health', signal),
    ...featureClients({ get, request, tenantPath, send: raw }),
    listStepBlocks: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ blocks: StepBlockSchema[] }>(`${tenantPath(tenant)}/step-flows/blocks`, signal))
        .blocks,
    listStrategies: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data: StrategyEntry[] }>(`${tenantPath(tenant)}/definitions/strategies`, signal))
        .data,
    listDefinitions: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data: DefinitionListItem[] }>(`${tenantPath(tenant)}/definitions`, signal)).data,
    getDefinition: (
      tenant: string,
      kind: PublishedDefinition['kind'],
      id: string,
      signal?: AbortSignal,
    ) =>
      get<DefinitionWithHistory>(
        `${tenantPath(tenant)}/definitions/${kindPath(kind)}/${encodeURIComponent(id)}`,
        signal,
      ),
    getVersion: (
      tenant: string,
      kind: PublishedDefinition['kind'],
      id: string,
      version: number,
      signal?: AbortSignal,
    ) =>
      get<PublishedDefinition>(
        `${tenantPath(tenant)}/definitions/${kindPath(kind)}/${encodeURIComponent(id)}/versions/${version}`,
        signal,
      ),
    definitionTemplate: async (tenant: string, kind: 'Service', signal?: AbortSignal) =>
      (
        await get<{ definition: Record<string, unknown> }>(
          `${tenantPath(tenant)}/definitions/template?kind=${kind}`,
          signal,
        )
      ).definition,
    catalog: async (tenant: string, kind: string, signal?: AbortSignal) =>
      (
        await get<{ data: ConfigEntry[] }>(
          `${tenantPath(tenant)}/catalog?kind=${encodeURIComponent(kind)}`,
          signal,
        )
      ).data,
    listModels: async (
      filter: { residency?: Residency | undefined; strategy?: string | undefined },
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (filter.residency) query.set('residency', filter.residency);
      if (filter.strategy) query.set('strategy', filter.strategy);
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return (await get<{ data: ModelOption[] }>(`/models${suffix}`, signal)).data;
    },
    publish: (definition: Record<string, unknown>, files: Record<string, string>, reason: string) =>
      request<PublishedDefinition>(
        'POST',
        '/definitions',
        { definition, files },
        { 'change-reason': reason },
      ),
    listDatasets: async (signal?: AbortSignal) =>
      (await get<{ datasets: DatasetSummary[] }>('/api/datasets', signal)).datasets,
    getDataset: async (id: string, signal?: AbortSignal) =>
      (await get<{ dataset: DatasetSummary }>(`/api/datasets/${id}`, signal)).dataset,
    facets: async (dataset: string, tenant: string, fields: string[], signal?: AbortSignal) => {
      const slash = dataset.indexOf('/');
      const query = new URLSearchParams({
        tenant: slash > 0 ? dataset.slice(0, slash) : tenant,
        'dataset-config-key': slash > 0 ? dataset.slice(slash + 1) : dataset,
        fields: fields.join(','),
      });
      return (await get<{ fields: FacetField[] }>(`/api/facets?${query.toString()}`, signal))
        .fields;
    },
    settingsCatalog: async (signal?: AbortSignal) =>
      (await get<{ data: SettingInfo[] }>('/settings', signal)).data,
    effectiveSettings: (tenant: string, service: string, signal?: AbortSignal) =>
      get<Record<string, EffectiveSetting>>(
        `${tenantPath(tenant)}/settings/effective?service=${encodeURIComponent(service)}`,
        signal,
      ),
    tenantEffectiveSettings: (tenant: string, signal?: AbortSignal) =>
      get<Record<string, EffectiveSetting>>(`${tenantPath(tenant)}/settings/effective`, signal),
    settingChangelog: async (key: string, signal?: AbortSignal) =>
      (
        await get<{ data: SettingDefaultVersion[] }>(
          `/settings/defaults/${encodeURIComponent(key)}/changelog`,
          signal,
        )
      ).data,
    saveServiceSetting: async (
      tenant: string,
      service: string,
      key: string,
      value: unknown,
      reason: string,
    ) => {
      const found = await get<DefinitionWithHistory>(
        `${tenantPath(tenant)}/definitions/${kindPath('Service')}/${encodeURIComponent(service)}`,
      );
      const definition = structuredClone(found.latest.definition) as {
        spec?: { settings?: Record<string, unknown> };
      };
      const spec = definition.spec ?? {};
      const settings = Object.fromEntries(
        Object.entries(spec.settings ?? {}).filter(([k]) => k !== key),
      );
      if (value !== null && value !== undefined) settings[key] = value;
      definition.spec = { ...spec, settings };
      return request<PublishedDefinition>(
        'POST',
        '/definitions',
        { definition, files: found.latest.files ?? {} },
        { 'change-reason': reason },
      );
    },
    previewTenantSetting: (tenant: string, key: string, value: unknown, reason: string) =>
      request<SettingPreview>(
        'PUT',
        `${tenantPath(tenant)}/settings/${encodeURIComponent(key)}?dryRun=true`,
        { value },
        { 'change-reason': reason },
      ),
    setTenantSetting: (tenant: string, key: string, value: unknown, reason: string) =>
      request<unknown>(
        'PUT',
        `${tenantPath(tenant)}/settings/${encodeURIComponent(key)}`,
        { value },
        { 'change-reason': reason },
      ),
    unsetTenantSetting: (tenant: string, key: string, reason: string) =>
      request<unknown>(
        'DELETE',
        `${tenantPath(tenant)}/settings/${encodeURIComponent(key)}`,
        {},
        { 'change-reason': reason },
      ),
    completeDefinition: async (definition: Record<string, unknown>) => {
      const metadata = definition.metadata as { tenant?: unknown } | undefined;
      if (typeof metadata?.tenant !== 'string') return definition;
      try {
        const completed = await request<{ definition?: Record<string, unknown> }>(
          'POST',
          `${tenantPath(metadata.tenant)}/definitions/complete`,
          { definition },
        );
        return completed.definition ?? definition;
      } catch (error) {
        if (error instanceof ApiError && (error.status === 404 || error.status === 405))
          return definition;
        throw error;
      }
    },
    validate: async (definition: unknown, files: Record<string, string> = {}) => {
      try {
        await request<{ valid: true }>('POST', '/definitions/validate', { definition, files });
        return { valid: true, errors: [] } satisfies ValidationResult;
      } catch (error) {
        if (error instanceof ApiError && error.status === 422)
          return { valid: false, errors: error.problem?.errors ?? [] } satisfies ValidationResult;
        throw error;
      }
    },
    publishDefinition: (
      definition: unknown,
      files: Record<string, string>,
      reason: string,
      draftRevision?: number,
    ) =>
      request<PublishedDefinition>(
        'POST',
        '/definitions',
        { definition, files, ...(draftRevision === undefined ? {} : { draftRevision }) },
        { 'change-reason': reason },
      ),
    listTestSets: async (tenant: string, service: string, signal?: AbortSignal) =>
      (
        await get<{ data: TestSet[] }>(
          `${tenantPath(tenant)}/test-sets?service=${encodeURIComponent(service)}`,
          signal,
        )
      ).data,
    listEvalRuns: async (tenant: string, service: string, signal?: AbortSignal) =>
      (
        await get<{ data: EvalRunSummary[] }>(
          `${tenantPath(tenant)}/eval-runs?service=${encodeURIComponent(service)}`,
          signal,
        )
      ).data,
    listFeedback: async (tenant: string, service: string, signal?: AbortSignal) =>
      (
        await get<{ data: FeedbackItem[] }>(
          `${tenantPath(tenant)}/feedback?service=${encodeURIComponent(service)}`,
          signal,
        )
      ).data,
    listCapabilities: async (signal?: AbortSignal) =>
      (await get<{ data: CapabilityModel[] }>('/v1/models', signal)).data,
    chat: async (
      capability: string,
      messages: { role: 'system' | 'user' | 'assistant'; content: string }[],
      preferredModel?: string,
    ) => {
      const reply = await request<{ choices: { message: { content: string } }[] }>(
        'POST',
        '/v1/chat/completions',
        {
          model: capability,
          messages,
          ...(preferredModel ? { metadata: { model: preferredModel } } : {}),
        },
      );
      return reply.choices[0]?.message.content ?? '';
    },
    overview: (tenant: string, signal?: AbortSignal) =>
      get<Overview>(`${tenantPath(tenant)}/overview`, signal),
    services: (tenant: string, signal?: AbortSignal) =>
      get<{ data: ServiceSummaryView[] }>(`${tenantPath(tenant)}/services`, signal),
    serviceLifecycle: (tenant: string, id: string, signal?: AbortSignal) =>
      get<ServiceLifecycleView>(
        `${tenantPath(tenant)}/services/${encodeURIComponent(id)}/lifecycle`,
        signal,
      ),
    setServiceLifecycle: (
      tenant: string,
      id: string,
      state: ServiceLifecycleView['state'],
      reason: string,
    ) =>
      request<ServiceLifecycleView>(
        'PUT',
        `${tenantPath(tenant)}/services/${encodeURIComponent(id)}/lifecycle`,
        { state },
        { 'change-reason': reason },
      ),
    task: (tenant: string, task: string, signal?: AbortSignal) =>
      get<TaskRow>(`${tenantPath(tenant)}/tasks/${encodeURIComponent(task)}`, signal),
    sharedServices: async (signal?: AbortSignal) =>
      (await get<{ data: SharedService[] }>('/shared-services', signal)).data,
    access: (tenant: string, signal?: AbortSignal) =>
      get<AccessView>(`${tenantPath(tenant)}/access`, signal),
    createApiKey: (
      tenant: string,
      input: {
        name: string;
        datasets: string[];
        agents: string[];
        expiresInDays?: number;
        callsPerMinute?: number;
      },
      reason: string,
    ) =>
      request<{ key: string; apiKey: ApiKeyView }>(
        'POST',
        `${tenantPath(tenant)}/api-keys`,
        input,
        { 'change-reason': reason },
      ),
    revokeApiKey: (tenant: string, id: string, reason: string) =>
      request<ApiKeyView>(
        'POST',
        `${tenantPath(tenant)}/api-keys/${encodeURIComponent(id)}/revoke`,
        {},
        { 'change-reason': reason },
      ),
    listClients: (tenant: string, service?: string, signal?: AbortSignal) =>
      get<ClientsView>(
        `${tenantPath(tenant)}/clients${service ? `?service=${encodeURIComponent(service)}` : ''}`,
        signal,
      ),
    saveClient: (
      tenant: string,
      id: string,
      client: { metadata: { name?: string }; spec: ClientSpec },
      reason: string,
    ) =>
      request<ClientView>(
        'PUT',
        `${tenantPath(tenant)}/clients/${encodeURIComponent(id)}`,
        client,
        { 'change-reason': reason },
      ),
    removeClient: (tenant: string, id: string, reason: string) =>
      request<{ id: string }>(
        'DELETE',
        `${tenantPath(tenant)}/clients/${encodeURIComponent(id)}`,
        {},
        { 'change-reason': reason },
      ),
    testWebhook: (tenant: string, id: string, reason: string) =>
      request<ClientView['deliveries'][number]>(
        'POST',
        `${tenantPath(tenant)}/clients/${encodeURIComponent(id)}/webhook/test`,
        {},
        { 'change-reason': reason },
      ),
    listServiceKeys: async (tenant: string, service: string, signal?: AbortSignal) =>
      (
        await get<{ keys: ServiceKeyView[] }>(
          `${tenantPath(tenant)}/services/${encodeURIComponent(service)}/api-keys`,
          signal,
        )
      ).keys,
    createServiceKey: (
      tenant: string,
      service: string,
      input: {
        name: string;
        client?: string;
        expiresInDays?: number;
        allowedOverrides?: string[];
      },
      reason: string,
    ) =>
      request<{ key: string; apiKey: ServiceKeyView }>(
        'POST',
        `${tenantPath(tenant)}/services/${encodeURIComponent(service)}/api-keys`,
        input,
        { 'change-reason': reason },
      ),
    rotateApiKey: (tenant: string, id: string, reason: string, allowedOverrides?: string[]) =>
      request<{ key: string; apiKey: ServiceKeyView }>(
        'POST',
        `${tenantPath(tenant)}/api-keys/${encodeURIComponent(id)}/rotate`,
        allowedOverrides ? { allowedOverrides } : {},
        { 'change-reason': reason },
      ),
    usage: (tenant: string, days: number, signal?: AbortSignal, project?: string) =>
      get<UsageReport>(
        `${tenantPath(tenant)}/usage?days=${days}${project ? `&project=${encodeURIComponent(project)}` : ''}`,
        signal,
      ),
    tasks: (
      tenant: string,
      filter: { status?: string; service?: string; from?: string; limit?: number },
      signal?: AbortSignal,
    ) => {
      const query = new URLSearchParams();
      if (filter.status) query.set('status', filter.status);
      if (filter.service) query.set('service', filter.service);
      if (filter.from) query.set('from', filter.from);
      if (filter.limit) query.set('limit', String(filter.limit));
      const suffix = query.size > 0 ? `?${query.toString()}` : '';
      return get<{ data: TaskRow[]; total: number }>(
        `${tenantPath(tenant)}/tasks${suffix}`,
        signal,
      );
    },
    integrations: (tenant: string, signal?: AbortSignal) =>
      get<IntegrationsView>(`${tenantPath(tenant)}/integrations`, signal),
    registerConnection: (tenant: string, connection: Record<string, unknown>, reason: string) =>
      request<{ id: string }>('POST', `${tenantPath(tenant)}/tool-connections`, connection, {
        'change-reason': reason,
      }),
    syncConnection: (tenant: string, id: string, reason: string) =>
      request<unknown>(
        'POST',
        `${tenantPath(tenant)}/tool-connections/${encodeURIComponent(id)}/sync`,
        {},
        { 'change-reason': reason },
      ),
    approveTool: (tenant: string, id: string, tool: string, reason: string) =>
      request<unknown>(
        'POST',
        `${tenantPath(tenant)}/tool-connections/${encodeURIComponent(id)}/approve`,
        { tool },
        { 'change-reason': reason },
      ),
    setSecret: (tenant: string, name: string, value: string, reason: string) =>
      request<{ ref: string }>(
        'PUT',
        `${tenantPath(tenant)}/secrets/${encodeURIComponent(name)}`,
        { value },
        { 'change-reason': reason },
      ),
    configList: (path: string, signal?: AbortSignal) =>
      get<{ data: ConfigEntry[]; backend?: IngestionBackend; kinds?: string[] }>(path, signal),
    configHistory: async (path: string, signal?: AbortSignal) =>
      (await get<{ data: ConfigVersion[] }>(path, signal)).data,
    configSave: (
      path: string,
      body: Record<string, unknown>,
      options: { reason: string; ifVersion?: number | undefined; method?: 'PUT' | 'POST' },
    ) =>
      request<ConfigEntry>(options.method ?? 'PUT', path, body, {
        'change-reason': options.reason,
        ...(options.ifVersion === undefined ? {} : { 'if-match': `"${options.ifVersion}"` }),
      }),
    configDelete: (path: string, reason: string) =>
      request<unknown>('DELETE', path, {}, { 'change-reason': reason }),
    configPost: (path: string, reason: string) =>
      request<unknown>('POST', path, {}, { 'change-reason': reason }),
    testRunDraft: (
      tenant: string,
      definition: unknown,
      query: string,
      files: Record<string, string> = {},
      input?: Record<string, string | number | string[]>,
    ) =>
      request<DraftRunResult>('POST', `${tenantPath(tenant)}/definitions/test-run`, {
        definition,
        files,
        query,
        ...(input ? { input } : {}),
      }),
    draftInputFields: async (tenant: string, definition: unknown) =>
      (
        await request<{ fields: PlaygroundInputField[] }>(
          'POST',
          `${tenantPath(tenant)}/definitions/input-fields`,
          { definition },
        )
      ).fields,
    audit: async (tenant: string, signal?: AbortSignal) =>
      (await get<{ data: AuditRow[] }>(`${tenantPath(tenant)}/audit`, signal)).data,
    exportTenant: (tenant: string, signal?: AbortSignal) =>
      get<TenantBundle>(`${tenantPath(tenant)}/export`, signal),
    importTenant: (
      tenant: string,
      bundle: TenantBundle,
      options: { dryRun: boolean; onConflict: 'skip' | 'overwrite'; reason: string },
    ) =>
      request<ImportPlan>(
        'POST',
        `${tenantPath(tenant)}/import?dryRun=${options.dryRun}&onConflict=${options.onConflict}`,
        bundle,
        { 'change-reason': options.reason },
      ),
    getTaskTimeline: (tenant: string, task: string, signal?: AbortSignal) =>
      get<TaskTimeline>(`${tenantPath(tenant)}/tasks/${encodeURIComponent(task)}/timeline`, signal),
  };
};
