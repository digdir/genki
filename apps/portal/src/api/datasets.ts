import type { ApiContext } from '../api';
import { ApiError } from './error';
import type { Problem, Residency } from '../types';

export type DatasetSourceKind =
  'website' | 'upload' | 'kudos' | 'folder' | 'database' | 'parquet' | 'endpoint' | 'none';
export type SearchScope = 'tenant' | 'all';
export type Schedule = 'none' | 'daily' | 'weekly';
export type SkipReason =
  | 'unsupported_type'
  | 'no_text'
  | 'conversion_failed'
  | 'outside_access'
  | 'too_large'
  | 'unreachable'
  | (string & {});

export interface SkippedDocument {
  document: string;
  reason: SkipReason;
}

export type ExecutionStatus =
  'queued' | 'running' | 'waiting' | 'succeeded' | 'failed' | 'cancelled';

export const openStatuses: readonly ExecutionStatus[] = ['queued', 'running', 'waiting'];

export const isOpen = (run: { status: ExecutionStatus } | null | undefined) =>
  !!run && openStatuses.includes(run.status);

export interface LastExecution {
  status: ExecutionStatus;
  startedAt: string;
  endedAt: string | null;
  stored: number | null;
  skipped: number | null;
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
  updatedAt?: string | null;
  owner?: { tenant: string; name: string | null };
  usedByCount?: number;
  searchScope?: SearchScope;
  valueTypes?: Record<string, 'string' | 'integer'>;
}

export interface DatasetReader {
  kind: 'service' | 'adoption';
  tenant: string;
  id: string;
  name: string;
  addedAt?: string;
  addedBy?: string;
  addedByName?: string;
}

export interface DatasetDetailView extends DatasetView {
  skipped?: SkippedDocument[];
  usedBy?: DatasetReader[];
}

export interface DatasetDeleteResult {
  deleted: string;
  removed: {
    catalogEntry: true;
    pipelines: string[];
    uploads: string[];
    generations: string[];
    endpoint?: string;
    secret?: string;
  };
  kept: { knowledgeRecords: boolean; generations: string[] };
}

export type PipelineSource =
  | {
      kind: 'website';
      sitemap: string;
      include: string[];
      exclude: string[];
    }
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
  status: ExecutionStatus;
  startedAt: string;
  endedAt?: string;
  startedBy?: string;
  startedByName?: string;
  error?: string;
  /** In lockdown, on a queued or running run not being cancelled: when its admission runs out. */
  admissionRunsOutAt?: string;
  /** Set once someone asked to cancel the run; it ends with its jobs. */
  cancelRequestedAt?: string;
  report?: {
    stored: number;
    skipped: number | SkippedDocument[];
    skippedDocuments?: SkippedDocument[];
    failed: string[];
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

export type EndpointAuth = { kind: 'api-key'; apiKey: string; header?: string } | { kind: 'none' };

export interface EndpointSource {
  url: string;
  auth: EndpointAuth;
}

export interface NewDatasetSpec {
  name: string;
  description?: string;
  endpoint: string;
  residency: Residency;
  embedding?: { model: string; dimensions: number };
  searchScope?: SearchScope;
}

export interface NewEndpointDataset {
  name: string;
  description?: string;
  residency: Residency;
  searchScope: SearchScope;
  endpointSource: EndpointSource;
}

export interface DatasetChange {
  name?: string;
  description?: string;
  searchScope?: SearchScope;
}

export interface OriginalFile {
  name: string;
  size: number;
  type: string;
}

export type DocumentStatus = 'indexed' | 'failed' | 'pending';
export type DocumentListStatus = DocumentStatus | 'all';
export type DocumentSortKey = 'title' | 'year' | 'updated';
export type SortOrder = 'asc' | 'desc';

export interface DatasetDocument {
  id: string;
  title?: string;
  url?: string;
  fields: Record<string, unknown>;
  original?: OriginalFile;
  status: DocumentStatus;
  chunkCount?: number;
  reason?: SkipReason;
}

export interface DocumentListing {
  query: boolean;
  sort: DocumentSortKey[];
}

export interface DatasetDocumentsPage {
  dataset: string;
  limit: number;
  offset: number;
  found?: number;
  total: number;
  totalExact: boolean;
  status: DocumentListStatus;
  statusCounts: { indexed: number | null; failed: number; pending: number };
  listing: DocumentListing;
  query?: string;
  sort?: { key: DocumentSortKey; order: SortOrder };
  filters?: Record<string, unknown>;
  documents: DatasetDocument[];
}

export interface DocumentChunk {
  id: string;
  position?: number;
  page?: number;
  pageEnd?: number;
  text: string;
}

export interface DatasetDocumentDetail extends DatasetDocument {
  excerpt?: string;
  chunks?: DocumentChunk[];
}

export interface DocumentsRequest {
  limit: number;
  offset: number;
  filters?: Record<string, unknown>;
  query?: string;
  sort?: { key: DocumentSortKey; order: SortOrder };
  status?: DocumentListStatus;
}

const documentsQuery = (page: DocumentsRequest) => {
  const params: [string, string][] = [
    ['limit', String(page.limit)],
    ['offset', String(page.offset)],
  ];
  if (page.filters) params.push(['filters', JSON.stringify(page.filters)]);
  if (page.query) params.push(['query', page.query]);
  if (page.sort) params.push(['sort', page.sort.key], ['order', page.sort.order]);
  if (page.status && page.status !== 'indexed') params.push(['status', page.status]);
  return params.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
};

export interface DatasetSearchHit {
  id: string;
  document?: string;
  title?: string;
  url?: string;
  page?: number;
  score: number;
  text: string;
  fields: Record<string, unknown>;
}

export interface DatasetSearchAnswer {
  dataset: string;
  limit: number;
  found?: number;
  hits: DatasetSearchHit[];
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
    rename: (tenant: string, id: string, change: DatasetChange, reason: string) =>
      ctx.request<DatasetView>('PUT', dataset(tenant, id), change, reasonHeader(reason)),
    remove: (tenant: string, id: string, reason: string) =>
      ctx.request<DatasetDeleteResult>('DELETE', dataset(tenant, id), {}, reasonHeader(reason)),
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
    readmitExecution: (
      tenant: string,
      id: string,
      pipelineId: string,
      execution: string,
      reason: string,
    ) =>
      ctx.request<ExecutionView>(
        'POST',
        `${pipeline(tenant, id, pipelineId)}/executions/${enc(execution)}/readmit`,
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
    documents: (tenant: string, id: string, page: DocumentsRequest, signal?: AbortSignal) =>
      ctx.get<DatasetDocumentsPage>(
        `${dataset(tenant, id)}/documents?${documentsQuery(page)}`,
        signal,
      ),
    document: (
      tenant: string,
      id: string,
      doc: string,
      signal?: AbortSignal,
      chunks?: { from: number; to: number },
    ) =>
      ctx.get<DatasetDocumentDetail>(
        `${dataset(tenant, id)}/documents/${enc(doc)}${
          chunks ? `?chunks=${chunks.from}-${chunks.to}` : ''
        }`,
        signal,
      ),
    createEndpoint: (tenant: string, input: NewEndpointDataset, reason: string) =>
      ctx.request<DatasetView>('POST', base(tenant), input, reasonHeader(reason)),
    original: async (tenant: string, id: string, name: string) => {
      if (!ctx.send) throw new Error('downloads need a raw sender');
      const response = await ctx.send(
        'GET',
        `${dataset(tenant, id)}/uploads/${enc(name)}`,
        undefined,
      );
      if (!response.ok) throw await failed(response);
      return response.blob();
    },
    search: (
      tenant: string,
      id: string,
      body: { query: string; filters?: Record<string, unknown>; limit?: number },
    ) =>
      ctx.query
        ? ctx.query<DatasetSearchAnswer>('POST', `${dataset(tenant, id)}/search`, body)
        : ctx.request<DatasetSearchAnswer>('POST', `${dataset(tenant, id)}/search`, body),
    removeUpload: (tenant: string, id: string, name: string, reason: string) =>
      ctx.request<unknown>(
        'DELETE',
        `${dataset(tenant, id)}/uploads/${enc(name)}`,
        {},
        reasonHeader(reason),
      ),
  };
};
