import type { ApiContext } from '../api';
import { ApiError } from './error';
import type { Problem, Residency } from '../types';

export type DatasetSourceKind =
  'website' | 'upload' | 'kudos' | 'folder' | 'database' | 'parquet' | 'none';
export type Schedule = 'none' | 'daily' | 'weekly';
export type SkipReason =
  | 'unsupported_type'
  | 'no_text'
  | 'conversion_failed'
  | 'outside_access'
  | 'too_large'
  | 'not_found'
  | (string & {});

export interface SkippedDocument {
  document: string;
  reason: SkipReason;
}

export interface LastExecution {
  status: string;
  startedAt: string;
  endedAt?: string | null;
  stored: number;
  skipped: number;
}

export interface DatasetView {
  id: string;
  fullId: string;
  name: string;
  description?: string;
  scope?: string;
  editable?: boolean;
  residency?: Residency;
  effectiveResidency?: Residency;
  index?: { endpoint?: string; collections?: Record<string, string> };
  facets?: string[];
  source: DatasetSourceKind;
  state?: 'needs-pipeline' | 'configured' | 'running' | 'ready' | 'degraded' | 'external';
  documents: number | null;
  chunks: number | null;
  lastExecution: LastExecution | null;
  nextRunAt: string | null;
}

export interface DatasetDetailView extends DatasetView {
  skipped?: SkippedDocument[];
}

export type PipelineSource =
  | { kind: 'website'; sitemap: string; include: string[]; exclude: string[] }
  | { kind: 'upload' }
  | { kind: 'kudos'; types: string[]; since?: string; orgs?: string[] };

export interface PipelineInput {
  name: string;
  source: PipelineSource;
  schedule: Schedule;
}

export interface PipelineView {
  id: string;
  version: number;
  spec: PipelineInput & Record<string, unknown>;
}

export interface ExecutionView {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'cancelled' | (string & {});
  startedAt: string;
  endedAt?: string;
  startedBy?: string;
  error?: string;
  report?: {
    stored: number;
    skipped: number | SkippedDocument[];
    skippedDocuments?: SkippedDocument[];
    failed: string[];
    failedDocuments?: { document: string; reason: string }[];
  };
}

export interface ExecutionsView {
  data: ExecutionView[];
  nextRunAt?: string | null;
}

export interface UploadedFile {
  name: string;
  size: number;
  type: string;
}

export interface UploadResult {
  uploaded: UploadedFile[];
  skipped: { name: string; reason: SkipReason }[];
}

export interface NewDatasetSpec {
  name: string;
  description?: string;
  endpoint: string;
  residency: Residency;
  embedding?: { model: string; dimensions: number };
}

export const skippedOf = (execution: ExecutionView): SkippedDocument[] => {
  const report = execution.report;
  if (!report) return [];
  if (Array.isArray(report.skipped)) return report.skipped;
  return report.skippedDocuments ?? [];
};

export const skippedCount = (execution: ExecutionView) => {
  const report = execution.report;
  if (!report) return 0;
  return Array.isArray(report.skipped) ? report.skipped.length : report.skipped;
};

const enc = encodeURIComponent;

const failed = async (response: Response) => {
  const problem = (await response.json().catch(() => undefined)) as Problem | undefined;
  return new ApiError(response.status, problem);
};

export const datasetsApi = (ctx: ApiContext) => {
  const base = (tenant: string) => `${ctx.tenantPath(tenant)}/datasets`;
  const dataset = (tenant: string, id: string) => `${base(tenant)}/${enc(id)}`;
  const pipeline = (tenant: string, id: string, pipelineId: string) =>
    `${dataset(tenant, id)}/pipelines/${enc(pipelineId)}`;
  const reasonHeader = (reason: string) => ({ 'change-reason': reason });
  return {
    list: async (tenant: string, signal?: AbortSignal) =>
      (await ctx.get<{ data: DatasetView[] }>(base(tenant), signal)).data,
    get: (tenant: string, id: string, signal?: AbortSignal) =>
      ctx.get<DatasetDetailView>(dataset(tenant, id), signal),
    create: (tenant: string, id: string, spec: NewDatasetSpec, reason: string) =>
      ctx.request<unknown>(
        'PUT',
        `${ctx.tenantPath(tenant)}/catalog/dataset/${enc(id)}`,
        spec,
        reasonHeader(reason),
      ),
    rename: (
      tenant: string,
      id: string,
      change: { name: string; description?: string },
      reason: string,
    ) => ctx.request<DatasetView>('PUT', dataset(tenant, id), change, reasonHeader(reason)),
    pipelines: async (tenant: string, id: string, signal?: AbortSignal) =>
      (await ctx.get<{ data: PipelineView[] }>(`${dataset(tenant, id)}/pipelines`, signal)).data,
    createPipeline: (
      tenant: string,
      id: string,
      input: PipelineInput & { id: string },
      reason: string,
    ) =>
      ctx.request<PipelineView>(
        'POST',
        `${dataset(tenant, id)}/pipelines`,
        input,
        reasonHeader(reason),
      ),
    savePipeline: (
      tenant: string,
      id: string,
      pipelineId: string,
      spec: PipelineView['spec'],
      reason: string,
    ) =>
      ctx.request<PipelineView>(
        'PUT',
        pipeline(tenant, id, pipelineId),
        spec,
        reasonHeader(reason),
      ),
    execute: (tenant: string, id: string, pipelineId: string, reason: string) =>
      ctx.request<ExecutionView>(
        'POST',
        `${pipeline(tenant, id, pipelineId)}/execute`,
        {},
        reasonHeader(reason),
      ),
    cancelExecution: (
      tenant: string,
      id: string,
      pipelineId: string,
      execution: string,
      reason: string,
    ) =>
      ctx.request<ExecutionView>(
        'POST',
        `${pipeline(tenant, id, pipelineId)}/executions/${enc(execution)}/cancel`,
        {},
        reasonHeader(reason),
      ),
    executions: (tenant: string, id: string, pipelineId: string, signal?: AbortSignal) =>
      ctx.get<ExecutionsView>(`${pipeline(tenant, id, pipelineId)}/executions`, signal),
    uploads: async (tenant: string, id: string, signal?: AbortSignal) =>
      (await ctx.get<{ data: UploadedFile[] }>(`${dataset(tenant, id)}/uploads`, signal)).data,
    upload: async (tenant: string, id: string, files: File[], reason: string) => {
      if (!ctx.send) throw new Error('uploads need a raw sender');
      const form = new FormData();
      for (const file of files) form.append('files', file, file.name);
      const response = await ctx.send(
        'POST',
        `${dataset(tenant, id)}/uploads`,
        form,
        reasonHeader(reason),
      );
      if (!response.ok) throw await failed(response);
      return (await response.json()) as UploadResult;
    },
    removeUpload: (tenant: string, id: string, name: string, reason: string) =>
      ctx.request<unknown>(
        'DELETE',
        `${dataset(tenant, id)}/uploads/${enc(name)}`,
        {},
        reasonHeader(reason),
      ),
  };
};
