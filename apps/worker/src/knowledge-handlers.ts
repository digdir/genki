import type { Principal } from '@genai/contracts';
import {
  chunkingOf,
  indexRecord,
  ingestListing,
  pipelineSpec,
  type DocumentRecords,
  type Listing,
  type PipelineSpec,
  type RecordTransaction,
} from '@genai/ingest';
import {
  heavyWorkStart,
  knowledgeFillQueue,
  knowledgeIndexQueue,
  knowledgeIngestQueue,
  knowledgeKeys,
  type JobQueue,
  type QueueWork,
} from '@genai/jobs';
import { GenerationBusy } from '@genai/port-knowledge';
import type { EmbeddingPort } from '@genai/port-embedding';
import type { PortContext } from '@genai/kernel';
import type { DatasetConfig } from '@genai/port-knowledge';
import { executionScope, type IngestionExecution } from '@genai/providers-postgres';
import { admittedWork, type AdmissionDeps } from './knowledge-jobs.js';

export interface KnowledgeHandlerDeps {
  /** The document records on the knowledge server, as the writer role. */
  records: DocumentRecords;
  /** The knowledge server's queue, where index jobs commit with their records. */
  knowledge: Pick<JobQueue, 'send' | 'sendAgain'>;
  /** `knowledge.heavyThreshold` and `knowledge.nightWindow`, read again for every job. */
  heavy: { threshold(): number; window(): string; now?: () => Date };
  /** The run's counts on the platform server. */
  runs: {
    report(id: string, counts: Record<string, number>, mode: 'set' | 'add'): Promise<void>;
  };
  /** The pipeline's spec at the version the run was started with. */
  pipeline(run: IngestionExecution): Promise<unknown>;
  /** The dataset as the catalog names it now, with its active generation. */
  dataset(id: string, signal: AbortSignal): DatasetConfig | undefined;
  listingOf(
    spec: PipelineSpec,
    scope: { tenant: string; dataset: string },
    signal: AbortSignal,
  ): Promise<Listing>;
  embedder(dataset: DatasetConfig, ctx: PortContext): EmbeddingPort | undefined;
  /** Throws while the knowledge server is bound to another platform server (ADR 0042). */
  bound?: () => void;
  admission: AdmissionDeps;
}

const tenantOf = (run: IngestionExecution, platformTenant: string) => {
  const scope = executionScope(run.dataset);
  return scope === 'platform' ? platformTenant : scope;
};

const specOf = async (deps: KnowledgeHandlerDeps, run: IngestionExecution) => {
  const parsed = pipelineSpec.safeParse(await deps.pipeline(run));
  if (!parsed.success) throw new Error(`pipeline ${run.pipeline} v${run.pipelineVersion} is gone`);
  return parsed.data;
};

const datasetOf = (deps: KnowledgeHandlerDeps, run: IngestionExecution, signal: AbortSignal) => {
  const dataset = deps.dataset(run.dataset, signal);
  if (!dataset?.generation)
    throw new Error(`dataset ${run.dataset} names no generation on the knowledge database`);
  return { dataset, generation: dataset.generation };
};

const contextOf = (
  run: IngestionExecution,
  principal: Principal,
  tenant: string,
  signal: AbortSignal,
): PortContext => ({
  tenant,
  principal,
  task: `ingestion:${run.id}`,
  signal,
  meter: async () => undefined,
});

/** A job that gives way to VACUUM is sent again this much later (ADR 0042, "Heavy work"). */
export const givingWayMs = 2 * 60_000;

/**
 * The worker's handlers of `knowledge.ingest` (platform server), `knowledge.index` (knowledge
 * server) and `knowledge.fill` (knowledge server, worked only in the night window), each behind the
 * run's admission (ADR 0042, "Jobs"). Job data names a document only by its record's number.
 */
export const knowledgeWork = (
  deps: KnowledgeHandlerDeps,
): { platform: QueueWork[]; knowledge: QueueWork[]; heavy: QueueWork[] } => {
  const ingest = admittedWork(
    knowledgeIngestQueue,
    async ({ job, run }) => {
      deps.bound?.();
      const signal = job.signal;
      const spec = await specOf(deps, run);
      const { generation } = datasetOf(deps, run, signal);
      const tenant = tenantOf(run, deps.admission.platformTenant);
      const listing = await deps.listingOf(spec, { tenant, dataset: run.dataset }, signal);
      await deps.records.chunking(generation, run.pipeline, chunkingOf(spec.chunking));
      await ingestListing({
        records: deps.records,
        listing,
        dataset: run.dataset,
        pipeline: run.pipeline,
        generation,
        onPlan: (plan) => deps.runs.report(run.id, { ...plan.counts }, 'set'),
        send: (record: string, transaction: RecordTransaction) =>
          deps.knowledge.send(
            knowledgeIndexQueue,
            { run: run.id, tenant: job.data.tenant, generation, record },
            { key: knowledgeKeys.index(generation, record), transaction },
          ),
      });
    },
    deps.admission,
  );

  const documentWork = (queue: typeof knowledgeIndexQueue | typeof knowledgeFillQueue) =>
    admittedWork(
      queue,
      async ({ job, run, principal, cancelled }) => {
        deps.bound?.();
        if (await cancelled()) return;
        const now = deps.heavy.now?.() ?? new Date();
        // A run that has written the heavy threshold sends its remaining documents to the window.
        if (queue === knowledgeIndexQueue && (run.report?.chunks ?? 0) >= deps.heavy.threshold()) {
          await deps.knowledge.send(knowledgeFillQueue, job.data, {
            key: knowledgeKeys.fill(job.data.generation, job.data.record),
            startAfter: heavyWorkStart(deps.heavy.window(), now),
          });
          return;
        }
        const signal = job.signal;
        const spec = await specOf(deps, run);
        const { dataset } = datasetOf(deps, run, signal);
        const tenant = tenantOf(run, deps.admission.platformTenant);
        const listing = await deps.listingOf(spec, { tenant, dataset: run.dataset }, signal);
        const chunking = await deps.records.chunking(
          job.data.generation,
          run.pipeline,
          chunkingOf(spec.chunking),
        );
        // The generation's model, so a catalog edit never mixes vectors of two models in one partition.
        const embedding = await deps.records.embedding(job.data.generation);
        const embedder = embedding
          ? deps.embedder({ ...dataset, embedding }, contextOf(run, principal, tenant, signal))
          : undefined;
        let chunks = 0;
        let outcome: Awaited<ReturnType<typeof indexRecord>>;
        try {
          outcome = await indexRecord({
            records: deps.records,
            listing,
            dataset: run.dataset,
            run: run.id,
            record: job.data.record,
            generation: job.data.generation,
            chunking,
            onStored: (n) => {
              chunks = n;
            },
            ...(embedder ? { embedder } : {}),
          });
        } catch (error) {
          if (!(error instanceof GenerationBusy)) throw error;
          // VACUUM holds the generation: give way, and keep every retry.
          await deps.knowledge.sendAgain(queue, job, {
            key: knowledgeKeys.index(job.data.generation, job.data.record),
            startAfter: new Date(now.getTime() + givingWayMs),
          });
          return;
        }
        if (outcome === 'stored') await deps.runs.report(run.id, { stored: 1, chunks }, 'add');
        if (outcome === 'skipped') await deps.runs.report(run.id, { skipped: 1 }, 'add');
      },
      deps.admission,
    );

  return {
    platform: [ingest as QueueWork],
    knowledge: [documentWork(knowledgeIndexQueue) as QueueWork],
    heavy: [documentWork(knowledgeFillQueue) as QueueWork],
  };
};
