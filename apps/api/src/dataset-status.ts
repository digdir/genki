import type { SkippedDocument } from '@genai/ingest';
import type { IndexWriterRouter } from '@genai/port-knowledge';
import type { CatalogItem } from './catalog-registry.js';
import type { Execution, ExecutionStatus, IngestionService, Pipeline } from './ingestion.js';

export type DatasetSource =
  'website' | 'upload' | 'kudos' | 'folder' | 'database' | 'episerver' | 'none';

export type DatasetState =
  'needs-pipeline' | 'configured' | 'running' | 'ready' | 'degraded' | 'external';

export type PipelineState = 'disabled' | 'failed' | 'running' | 'ready' | 'configured';

export interface LastExecution {
  status: ExecutionStatus;
  startedAt: string;
  endedAt: string | null;
  stored: number | null;
  skipped: number | null;
}

export interface DatasetStatus {
  state: DatasetState;
  source: DatasetSource;
  documents: number | null;
  chunks: number | null;
  lastExecution: LastExecution | null;
  nextRunAt: string | null;
}

export interface DatasetStatusDeps {
  ingestion: IngestionService;
  writers?: IndexWriterRouter;
  countable(engine: string): boolean;
  engineOf?(item: CatalogItem): string | undefined;
  documentCount?(item: CatalogItem): Promise<number | undefined>;
}

const lastOf = (execution: Execution): LastExecution => ({
  status: execution.status,
  startedAt: execution.startedAt,
  endedAt: execution.endedAt ?? null,
  stored: execution.report?.stored ?? null,
  skipped: execution.report?.skipped ?? null,
});

const countsOf = async (deps: DatasetStatusDeps, dataset: string) => {
  if (!deps.writers?.supports(dataset)) return undefined;
  try {
    const route = deps.writers.open(dataset, { signal: AbortSignal.timeout(5000) });
    if (!deps.countable(route.engine)) return undefined;
    const generation = await route.writer.active(route.dataset);
    if (generation === undefined) return { documents: 0, chunks: 0 };
    const stats = await route.writer.stats(route.dataset, generation);
    return { documents: stats.documents, chunks: stats.chunks };
  } catch {
    return undefined;
  }
};

export const pipelineState = (pipeline: Pipeline, latest?: Execution): PipelineState => {
  if (!pipeline.spec.enabled) return 'disabled';
  if (latest?.status === 'failed') return 'failed';
  if (latest?.status === 'running') return 'running';
  if (latest?.status === 'succeeded') return 'ready';
  return 'configured';
};

export const datasetState = (pipelines: PipelineState[]): DatasetState => {
  if (pipelines.length === 0) return 'needs-pipeline';
  if (pipelines.includes('failed')) return 'degraded';
  if (pipelines.includes('running')) return 'running';
  if (pipelines.every((p) => p === 'ready')) return 'ready';
  return 'configured';
};

const latestOf = (executions: Execution[]) =>
  [...executions].sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];

export const publicDatasetState = async (
  ingestion: Pick<IngestionService, 'list' | 'executions'>,
  scope: string,
  dataset: string,
  filledElsewhere = false,
): Promise<DatasetState> => {
  const pipelines = await ingestion.list(scope, dataset);
  if (pipelines.length === 0 && filledElsewhere) return 'external';
  return datasetState(
    await Promise.all(
      pipelines.map(async (p) =>
        pipelineState(p, latestOf(await ingestion.executions(dataset, p.id))),
      ),
    ),
  );
};

export const datasetStatus = async (
  deps: DatasetStatusDeps,
  item: CatalogItem,
): Promise<DatasetStatus & { skipped: SkippedDocument[] }> => {
  const pipelines = await deps.ingestion.list(item.scope, item.id);
  const main = pipelines.find((p) => p.spec.enabled) ?? pipelines[0];
  const perPipeline = await Promise.all(
    pipelines.map((p) => deps.ingestion.executions(item.id, p.id)),
  );
  const last = latestOf(perPipeline.flat());
  const next = (
    await Promise.all(pipelines.map((p) => deps.ingestion.nextRunAt(item.scope, p)))
  ).filter((at): at is string => at !== null);
  const engine = deps.engineOf?.(item);
  const external = pipelines.length === 0 && engine !== undefined && !deps.countable(engine);
  if (external) {
    const documents = await deps.documentCount?.(item).catch(() => undefined);
    return {
      state: 'external',
      source: 'none',
      documents: documents ?? null,
      chunks: null,
      lastExecution: null,
      nextRunAt: null,
      skipped: [],
    };
  }
  const counts = await countsOf(deps, item.id);
  return {
    state: datasetState(pipelines.map((p, i) => pipelineState(p, latestOf(perPipeline[i] ?? [])))),
    source: main?.spec.source.kind ?? 'none',
    documents: counts?.documents ?? null,
    chunks: counts?.chunks ?? null,
    lastExecution: last ? lastOf(last) : null,
    nextRunAt: next.sort()[0] ?? null,
    skipped: last?.report?.skippedDocuments ?? [],
  };
};
