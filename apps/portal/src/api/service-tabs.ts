import type { ApiContext } from '../api';
import type { TaskRow } from '../types';

export interface ServiceFailures {
  service: string;
  failed: number;
  causes: { code: string; reason: string; count: number }[];
}

export interface SharedWith {
  service: string;
  frontends: { id: string; name?: string; kind: 'server' | 'browser'; channels: string[] }[];
  apiKeys: { id: string; name: string; prefix?: string; bound: boolean; client?: string }[];
  tenants: '*' | string[];
}

export interface TaskPage {
  data: TaskRow[];
  total: number;
  offset: number;
  limit: number;
  q?: string;
  searched?: number;
}

export interface TaskQuery {
  service: string;
  status?: string | undefined;
  environment?: string | undefined;
  from?: string | undefined;
  to?: string | undefined;
  q?: string | undefined;
  actor?: string | undefined;
  frontend?: string | undefined;
  limit: number;
  offset: number;
}

export interface ServiceLatency {
  p50Ms: number;
  p95Ms: number;
  runs: number;
}

export const caseChanges = ['worse', 'better', 'new', 'missing', 'pending', 'same'] as const;
export type CaseChange = (typeof caseChanges)[number];

export interface ComparedRun {
  id: string;
  status: string;
  version: 'draft' | number;
  testSetVersion: number;
  startedAt: string;
  endedAt: string | null;
  score: number | null;
  passed: number;
  cases: number;
  judges: string[];
}

export interface CaseOutcome {
  pass: boolean;
  score: number | null;
  reason?: string;
}

export interface ComparedCase {
  case: string;
  input: string;
  type: string;
  split: 'locked' | 'open';
  change: CaseChange;
  baseline: CaseOutcome | null;
  candidate: CaseOutcome | null;
}

export interface EvalComparison {
  testSet: string;
  baseline: ComparedRun & { published: boolean };
  candidate: ComparedRun;
  counts: Partial<Record<CaseChange, number>>;
  data: ComparedCase[];
  total: number;
  offset: number;
  limit: number;
}

export type EnvironmentAction =
  'added' | 'removed' | 'promoted' | 'rolled-back' | 'described' | 'changed';

export interface EnvironmentChange {
  environment: string;
  action: EnvironmentAction;
  version: number | null;
  previousVersion: number | null;
  from?: string;
  at: string;
  by: string;
  byName?: string;
  reason: string;
}

export interface EnvironmentHistory {
  data: EnvironmentChange[];
  total: number;
}

export type CancelledRun = { id: string; status: 'cancelled' | 'cancelling' };

export interface DraftChecks {
  service: string;
  revision: number;
  ready: boolean;
  problems: { path: string; message: string }[];
  hooksSkipped?: true;
}

export const serviceTabsApi = ({ get, request, tenantPath }: ApiContext) => {
  const service = (tenant: string, id: string) =>
    `${tenantPath(tenant)}/services/${encodeURIComponent(id)}`;
  return {
    environmentHistory: (
      tenant: string,
      id: string,
      query: { environment?: string; limit?: number } = {},
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams();
      if (query.environment) params.set('environment', query.environment);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      const suffix = params.size ? `?${params}` : '';
      return get<EnvironmentHistory>(`${service(tenant, id)}/environment-history${suffix}`, signal);
    },
    cancelEvalRun: (tenant: string, id: string, runId: string, reason: string) =>
      request<CancelledRun>(
        'POST',
        `${service(tenant, id)}/eval-runs/${encodeURIComponent(runId)}/cancel`,
        {},
        { 'change-reason': reason },
      ),
    failures: async (tenant: string, from: string, signal?: AbortSignal) =>
      (
        await get<{ from: string; data: ServiceFailures[] }>(
          `${tenantPath(tenant)}/service-failures?from=${encodeURIComponent(from)}`,
          signal,
        )
      ).data ?? [],
    sharedWith: async (tenant: string, id: string, signal?: AbortSignal): Promise<SharedWith> => {
      const shared = await get<Partial<SharedWith>>(`${service(tenant, id)}/shared-with`, signal);
      return {
        service: shared.service ?? id,
        frontends: shared.frontends ?? [],
        apiKeys: shared.apiKeys ?? [],
        tenants: shared.tenants ?? [],
      };
    },
    taskPage: (tenant: string, query: TaskQuery, signal?: AbortSignal) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query))
        if (value !== undefined && value !== '') params.set(key, String(value));
      return get<TaskPage>(`${tenantPath(tenant)}/tasks?${params.toString()}`, signal);
    },
    draftChecks: (tenant: string, id: string, signal?: AbortSignal) =>
      get<DraftChecks>(`${service(tenant, id)}/draft/checks`, signal),
    compare: (
      tenant: string,
      id: string,
      query: {
        candidate: string;
        baseline?: string | undefined;
        change?: CaseChange | undefined;
        limit?: number;
        offset?: number;
      },
      signal?: AbortSignal,
    ) => {
      const params = new URLSearchParams({ candidate: query.candidate });
      if (query.baseline) params.set('baseline', query.baseline);
      if (query.change) params.set('change', query.change);
      if (query.limit !== undefined) params.set('limit', String(query.limit));
      if (query.offset !== undefined) params.set('offset', String(query.offset));
      return get<EvalComparison>(`${service(tenant, id)}/eval-runs/compare?${params}`, signal);
    },
  };
};
