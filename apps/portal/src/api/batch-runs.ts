import type { ApiContext } from '../api';
import { ApiError } from './error';

export interface Range {
  low: number;
  high: number;
}

export interface BatchFilterField {
  field: string;
  values: { value: string; count: number }[];
}

export interface BatchSourceDataset {
  id: string;
  name: string;
  usedByService: boolean;
  filters: BatchFilterField[];
}

export type BatchFilters = Record<string, string[]>;

export type BatchInputValue = string | number | string[];

export interface BatchApproval {
  by: string;
  at: string;
  reason: string;
  limitNok: number;
}

export interface BatchDocument {
  id: string;
  title: string;
  url?: string;
}

export interface BatchEstimate {
  id: string;
  service: string;
  version: number;
  model: string | null;
  priced: boolean;
  dataset: string;
  filters: BatchFilters;
  prompt?: string;
  input?: Record<string, BatchInputValue>;
  items: number;
  preview: BatchDocument[];
  perItem: { inputTokens: Range; outputTokens: Range; costMicroNok: Range | null };
  maxOutputTokens: number;
  tokens: Range;
  costMicroNok: Range | null;
  basis: 'measured' | 'assumed';
  samples: {
    document: string;
    inputTokens: number;
    outputTokens: number;
    costMicroNok: number | null;
    output: string;
    error?: string;
  }[];
  found?: number;
  excluded?: {
    duplicates: { document: BatchDocument; keptId: string }[];
    otherYear: BatchDocument[];
  };
  expiresAt: string;
  approval?: { limitNok: number; required: boolean };
}

export type BatchRunStatus =
  'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'stopped' | (string & {});

export type BatchItemStatus =
  'queued' | 'running' | 'succeeded' | 'notFound' | 'failed' | 'skipped';

export interface BatchRun {
  id: string;
  service: string;
  version: number;
  model: string | null;
  priced: boolean;
  dataset: string;
  filters: BatchFilters;
  prompt?: string;
  input?: Record<string, BatchInputValue>;
  startedBy?: string;
  startedByName?: string;
  costApproval?: BatchApproval;
  status: BatchRunStatus;
  total: number;
  concurrency: number;
  pass: number;
  cap: { costMicroNok?: number; tokens?: number };
  perItem: BatchEstimate['perItem'];
  startedAt: string;
  endedAt: string | null;
  error?: string;
  errorCode?: string;
  counts: Record<BatchItemStatus, number>;
  tokens: { input: number; output: number };
  costMicroNok: number | null;
}

export interface BatchItem {
  index: number;
  document: BatchDocument;
  status: BatchItemStatus;
  attempts: number;
  task?: string;
  output?: string;
  truncated?: boolean;
  error?: string;
  errorCode?: string;
  sources: { title?: string; url?: string }[];
  tokens: { input: number; output: number };
  costMicroNok: number;
  startedAt?: string;
  endedAt?: string;
}

export interface BatchRunDetail extends BatchRun {
  items: BatchItem[];
}

export interface BatchCap {
  maxCostNok?: number;
  maxTokens?: number;
}

export const isActiveBatch = (run: Pick<BatchRun, 'status'>) =>
  run.status === 'queued' || run.status === 'running';

export const batchRunsApi = ({ get, request, tenantPath, send }: ApiContext) => {
  const runs = (tenant: string, id: string) =>
    `${tenantPath(tenant)}/services/${encodeURIComponent(id)}/batch-runs`;
  const why = (reason: string) => ({ 'change-reason': reason });

  return {
    sources: async (tenant: string, id: string, signal?: AbortSignal) =>
      (await get<{ data: BatchSourceDataset[] }>(`${runs(tenant, id)}/sources`, signal)).data,
    estimate: (
      tenant: string,
      id: string,
      body: {
        dataset: string;
        filters: BatchFilters;
        documents?: string[];
        prompt?: string;
        input?: Record<string, BatchInputValue>;
        sample?: boolean;
      },
      reason: string,
    ) => request<BatchEstimate>('POST', `${runs(tenant, id)}/estimate`, body, why(reason)),
    start: (
      tenant: string,
      id: string,
      body: { estimate: string; approval?: string } & BatchCap,
      reason: string,
    ) => request<BatchRun>('POST', runs(tenant, id), body, why(reason)),
    list: async (tenant: string, id: string, signal?: AbortSignal) =>
      (await get<{ data: BatchRun[] }>(runs(tenant, id), signal)).data,
    run: (tenant: string, id: string, runId: string, signal?: AbortSignal) =>
      get<BatchRunDetail>(`${runs(tenant, id)}/${encodeURIComponent(runId)}`, signal),
    cancel: (tenant: string, id: string, runId: string, reason: string) =>
      request<unknown>(
        'POST',
        `${runs(tenant, id)}/${encodeURIComponent(runId)}/cancel`,
        {},
        why(reason),
      ),
    retry: (
      tenant: string,
      id: string,
      runId: string,
      body: BatchCap & { items?: number[] },
      reason: string,
    ) =>
      request<BatchRun & { retried: number }>(
        'POST',
        `${runs(tenant, id)}/${encodeURIComponent(runId)}/retry`,
        body,
        why(reason),
      ),
    download: async (tenant: string, id: string, runId: string, format: 'csv' | 'json') => {
      const path = `${runs(tenant, id)}/${encodeURIComponent(runId)}/export?format=${format}`;
      const response = send ? await send('GET', path, undefined) : undefined;
      if (!response?.ok) throw new ApiError(response?.status ?? 500, undefined);
      return response.blob();
    },
  };
};
