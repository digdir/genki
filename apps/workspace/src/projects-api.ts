import { ApiError, type ApiClientOptions } from './api';
import { translator, type T } from './i18n';

export type Filters = Record<string, string[]>;

export interface ProjectSelection {
  id: string;
  name: string;
  dataset: string;
  filters: Filters;
  documents?: string[];
}

export interface ProjectInput {
  name: string;
  purpose: string;
  selections: ProjectSelection[];
  services: string[];
}

export interface Project extends ProjectInput {
  id: string;
  version: number;
  by: string;
  at: string;
  reason: string;
  changedBy?: string;
}

export interface ProjectSummary extends Project {
  subscriptions: number;
  fresh: number;
  paused: number;
  runs: number;
}

export interface SubscriptionPause {
  kind: 'cost-cap' | 'manual' | 'problem';
  reason: string;
  at: string;
  month?: string;
}

export interface Document {
  id: string;
  title: string;
  url?: string;
}

export interface FreshDocument {
  document: Document;
  arrivedAt: string;
  run?: string;
}

export type SubscriptionMode = 'notify' | 'run';

export interface Subscription {
  project: string;
  selection: string;
  mode: SubscriptionMode;
  service?: string;
  cap: { maxCostNok?: number; maxTokens?: number };
  status: 'active' | 'paused';
  paused?: SubscriptionPause;
  fresh: FreshDocument[];
  waiting: number;
  checkedAt?: string;
  error?: string;
  spentThisMonth: { costMicroNok: number; tokens: number };
}

export interface ProjectDetail extends Project {
  subscriptions: Subscription[];
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

export interface RunApproval {
  status: ApprovalStatus;
  by?: string;
  byName?: string;
  at?: string;
}

export interface ProjectRun {
  id: string;
  service: string;
  version: number;
  status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stopped';
  total: number;
  startedAt: string;
  endedAt: string | null;
  costMicroNok: number | null;
  counts: Record<string, number>;
  trigger: 'manual' | 'subscription';
  selection?: string;
  newSince: number;
  approval?: RunApproval;
}

export interface ProjectDocuments {
  selection: string;
  datasetName: string;
  found: number;
  documents: Document[];
}

export interface ProjectSource {
  id: string;
  name: string;
  filters: { field: string; values: { value: string; count: number }[] }[];
}

export interface ProjectPoint {
  id: string;
  text: string;
  by: string;
  byName?: string;
  at: string;
}

export interface ProjectLogEntry {
  kind: string;
  id: string;
  version: number;
  deleted: boolean;
  by: string;
  byName?: string;
  at: string;
  reason: string;
}

export interface Estimate {
  id: string;
  items: number;
  priced: boolean;
  costMicroNok: { low: number; high: number } | null;
  tokens: { low: number; high: number };
}

export interface SubscriptionInput {
  mode: SubscriptionMode;
  service?: string;
  maxCostNok?: number;
}

export interface ProjectsApi {
  list(tenant: string, signal?: AbortSignal): Promise<ProjectSummary[]>;
  get(tenant: string, id: string, signal?: AbortSignal): Promise<ProjectDetail>;
  sources(tenant: string, signal?: AbortSignal): Promise<ProjectSource[]>;
  create(tenant: string, body: ProjectInput, reason: string): Promise<Project>;
  update(
    tenant: string,
    id: string,
    body: ProjectInput & { version: number },
    reason: string,
  ): Promise<Project>;
  remove(tenant: string, id: string, reason: string): Promise<void>;
  documents(
    tenant: string,
    id: string,
    selection: string,
    signal?: AbortSignal,
  ): Promise<ProjectDocuments>;
  points(tenant: string, id: string, signal?: AbortSignal): Promise<ProjectPoint[]>;
  addPoint(tenant: string, id: string, text: string, reason: string): Promise<ProjectPoint>;
  runs(tenant: string, id: string, signal?: AbortSignal): Promise<ProjectRun[]>;
  estimate(
    tenant: string,
    id: string,
    body: { service: string; selection: string },
    reason: string,
  ): Promise<Estimate>;
  start(
    tenant: string,
    id: string,
    body: { estimate: string; selection: string; maxCostNok?: number; maxTokens?: number },
    reason: string,
  ): Promise<{ id: string }>;
  review(
    tenant: string,
    id: string,
    run: string,
    decision: 'approved' | 'rejected',
    reason: string,
  ): Promise<RunApproval>;
  subscribe(
    tenant: string,
    id: string,
    selection: string,
    body: SubscriptionInput,
    reason: string,
  ): Promise<Subscription>;
  unsubscribe(tenant: string, id: string, selection: string, reason: string): Promise<void>;
  log(tenant: string, id: string, signal?: AbortSignal): Promise<ProjectLogEntry[]>;
  exportUrl?(tenant: string, run: ProjectRun): string;
}

const enc = encodeURIComponent;

export const problemTitle = (error: unknown, t: T = translator('nb')) =>
  error instanceof ApiError &&
  typeof error.body === 'object' &&
  error.body !== null &&
  typeof (error.body as { title?: unknown }).title === 'string'
    ? (error.body as { title: string }).title
    : t('projects.somethingWrong');

export const createProjectsApi = ({
  baseUrl,
  fetch: send,
  token,
  actorName,
  locale = () => 'nb',
}: ApiClientOptions & { actorName?: () => string | undefined }): ProjectsApi => {
  const call = async <T>(
    method: string,
    path: string,
    options: { body?: unknown; reason?: string; signal?: AbortSignal | undefined } = {},
  ): Promise<T> => {
    const bearer = token();
    const name = actorName?.();
    const response = await send(`${baseUrl}${path}`, {
      method,
      headers: {
        accept: 'application/json',
        'accept-language': locale(),
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
        ...(options.reason ? { 'change-reason': enc(options.reason) } : {}),
        ...(name ? { 'actor-name': enc(name) } : {}),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const body = (await response.json().catch(() => undefined)) as unknown;
    if (!response.ok) throw new ApiError(response.status, body);
    return body as T;
  };
  const base = (tenant: string) => `/tenants/${enc(tenant)}/projects`;
  const one = (tenant: string, id: string) => `${base(tenant)}/${enc(id)}`;
  return {
    list: async (tenant, signal) =>
      (await call<{ data: ProjectSummary[] }>('GET', base(tenant), { signal })).data,
    get: (tenant, id, signal) => call('GET', one(tenant, id), { signal }),
    sources: async (tenant, signal) =>
      (await call<{ data: ProjectSource[] }>('GET', `${base(tenant)}/sources`, { signal })).data,
    create: (tenant, body, reason) => call('POST', base(tenant), { body, reason }),
    update: (tenant, id, body, reason) => call('PUT', one(tenant, id), { body, reason }),
    remove: async (tenant, id, reason) => {
      await call('DELETE', one(tenant, id), { reason });
    },
    documents: (tenant, id, selection, signal) =>
      call('GET', `${one(tenant, id)}/documents?selection=${enc(selection)}&limit=20`, { signal }),
    points: async (tenant, id, signal) =>
      (await call<{ data: ProjectPoint[] }>('GET', `${one(tenant, id)}/points`, { signal })).data,
    addPoint: (tenant, id, text, reason) =>
      call('POST', `${one(tenant, id)}/points`, { body: { text }, reason }),
    runs: async (tenant, id, signal) =>
      (await call<{ data: ProjectRun[] }>('GET', `${one(tenant, id)}/runs`, { signal })).data,
    estimate: (tenant, id, body, reason) =>
      call('POST', `${one(tenant, id)}/runs/estimate`, { body, reason }),
    start: (tenant, id, body, reason) => call('POST', `${one(tenant, id)}/runs`, { body, reason }),
    review: (tenant, id, run, decision, reason) =>
      call('POST', `${one(tenant, id)}/runs/${enc(run)}/review`, { body: { decision }, reason }),
    subscribe: (tenant, id, selection, body, reason) =>
      call('PUT', `${one(tenant, id)}/subscriptions/${enc(selection)}`, { body, reason }),
    unsubscribe: async (tenant, id, selection, reason) => {
      await call('DELETE', `${one(tenant, id)}/subscriptions/${enc(selection)}`, { reason });
    },
    log: async (tenant, id, signal) =>
      (await call<{ data: ProjectLogEntry[] }>('GET', `${one(tenant, id)}/log`, { signal })).data,
    exportUrl: (tenant, run) =>
      `${baseUrl}/tenants/${enc(tenant)}/services/${enc(run.service)}/batch-runs/${enc(run.id)}/export?format=csv`,
  };
};
