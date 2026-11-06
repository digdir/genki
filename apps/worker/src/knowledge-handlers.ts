import type { Principal } from '@genai/contracts';
import {
  chunkingOf,
  copyOwner,
  indexRecord,
  ingestListing,
  pipelineSpec,
  throttledEmbedder,
  EmbeddingPauses,
  type ChunkDocumentConfig,
  type CopyListing,
  type DocumentRecords,
  type KnowledgeListingScope,
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
import type { RunProgress } from './run-progress.js';
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
  /**
   * The dataset at its engine switch's endpoint, for a run the switch started: its options and
   * embedding come from the switch, since the catalog still names the previous engine (ADR 0025).
   */
  switchDataset?(run: IngestionExecution, signal: AbortSignal): Promise<DatasetConfig | undefined>;
  /** Makes a generation that does not exist yet, standalone, as the knowledge server's owner. */
  prepare?(dataset: DatasetConfig, generation: string): Promise<void>;
  /** Whether the generation exists, read as the writer, so only a missing one needs the owner. */
  generationExists?(generation: string): Promise<boolean>;
  listingOf(
    spec: PipelineSpec,
    scope: KnowledgeListingScope,
    signal: AbortSignal,
  ): Promise<Listing>;
  embedder(dataset: DatasetConfig, ctx: PortContext): EmbeddingPort | undefined;
  /**
   * The listing of an engine switch's copy run (#366): the dataset as its current engine holds it,
   * named as the switch decided at its start.
   */
  copyListingOf?(run: IngestionExecution, signal: AbortSignal): Promise<CopyListing>;
  /** Throws while the knowledge server is bound to another platform server (ADR 0042). */
  bound?: () => void;
  admission: AdmissionDeps;
  /** How many index and fill jobs this worker works at once; 1 when left out. */
  indexConcurrency?: number;
  /** The once-a-minute `knowledge run progress` line of each run this worker writes. */
  progress?: RunProgress;
}

const tenantOf = (run: IngestionExecution, platformTenant: string) => {
  const scope = executionScope(run.dataset);
  return scope === 'platform' ? platformTenant : scope;
};

/** Whom a run's listing lists for; folder documents are named by the dataset's own scope. */
const listingScope = (run: IngestionExecution, platformTenant: string): KnowledgeListingScope => ({
  tenant: tenantOf(run, platformTenant),
  dataset: run.dataset,
  owner: executionScope(run.dataset),
});

/** What a copy records as its chunking: the chunks are its engine's, cut by no setting here. */
const copiedChunking = { copied: true };

/**
 * A run's listing and the chunking its generation keeps for it: a copy run's from its engine switch
 * (#366), any other run's from its pipeline at the version it was started with.
 */
const listingFor = async (
  deps: KnowledgeHandlerDeps,
  run: IngestionExecution,
  signal: AbortSignal,
) => {
  if (run.pipeline === copyOwner) {
    if (!run.engineSwitch || !deps.copyListingOf)
      throw new Error(`run ${run.id} copies, but names no engine switch`);
    return { listing: await deps.copyListingOf(run, signal), chunking: copiedChunking };
  }
  const spec = await specOf(deps, run);
  return {
    listing: await deps.listingOf(spec, listingScope(run, deps.admission.platformTenant), signal),
    chunking: chunkingOf(spec.chunking),
  };
};

const specOf = async (deps: KnowledgeHandlerDeps, run: IngestionExecution) => {
  const parsed = pipelineSpec.safeParse(await deps.pipeline(run));
  if (!parsed.success) throw new Error(`pipeline ${run.pipeline} v${run.pipelineVersion} is gone`);
  return parsed.data;
};

/** The dataset a run writes, and the generation: the one its record names, else the active one. */
const datasetOf = async (
  deps: KnowledgeHandlerDeps,
  run: IngestionExecution,
  signal: AbortSignal,
) => {
  const dataset = run.engineSwitch
    ? await deps.switchDataset?.(run, signal)
    : deps.dataset(run.dataset, signal);
  if (!dataset)
    throw new Error(
      run.engineSwitch
        ? `the engine switch ${run.engineSwitch} of dataset ${run.dataset} is gone`
        : `dataset ${run.dataset} is not on the knowledge database`,
    );
  const generation = run.generation ?? dataset.generation;
  if (!generation)
    throw new Error(`dataset ${run.dataset} names no generation on the knowledge database`);
  return { dataset: { ...dataset, generation }, generation };
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
 * How many `knowledge.index` and `knowledge.fill` jobs one worker works at once, from
 * `KNOWLEDGE_INDEX_CONCURRENCY` (8 when unset). Documents embed side by side; their writes still
 * take the generation's row lock one at a time.
 */
export const indexConcurrencyOf = (env: NodeJS.ProcessEnv): number => {
  const raw = env.KNOWLEDGE_INDEX_CONCURRENCY;
  if (raw === undefined) return 8;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value) || value < 1 || value > 32)
    throw new Error(
      `KNOWLEDGE_INDEX_CONCURRENCY must be a whole number from 1 to 32, not "${raw}"`,
    );
  return value;
};

/**
 * The worker's handlers of `knowledge.ingest` (platform server), `knowledge.index` (knowledge
 * server) and `knowledge.fill` (knowledge server, worked only in the night window), each behind the
 * run's admission (ADR 0042, "Jobs"). Job data names a document only by its record's number.
 */
/**
 * Connections in each of the worker's knowledge pools: one for every index and fill job it works at
 * once, which holds it while waiting its turn for the generation's lock, and room for the queues'
 * pollers and the other knowledge jobs. Never below pg's 10.
 */
export const knowledgePoolSizeOf = (concurrency: number) => Math.max(10, 2 * concurrency + 6);

export const knowledgeWork = (
  deps: KnowledgeHandlerDeps,
): { platform: QueueWork[]; knowledge: QueueWork[]; heavy: QueueWork[] } => {
  const pauses = new EmbeddingPauses();
  const ingest = admittedWork(
    knowledgeIngestQueue,
    async ({ job, run, cancelled }) => {
      deps.bound?.();
      const signal = job.signal;
      const { dataset, generation } = await datasetOf(deps, run, signal);
      // A switch's generation, or a new dataset's, is made by the first ingest job that writes it.
      // A cancelled run makes nothing: its generation may already be dropped.
      if (await cancelled()) return;
      if (deps.prepare && !(await deps.generationExists?.(generation)))
        await deps.prepare(dataset, generation);
      const { listing, chunking } = await listingFor(deps, run, signal);
      await deps.records.chunking(generation, run.pipeline, chunking);
      // A copy's skips, by reason, as `skipped.<reason>` beside the listing's counts.
      const skips = () =>
        'skipped' in listing && typeof listing.skipped === 'function'
          ? Object.fromEntries(
              Object.entries((listing as CopyListing).skipped()).map(([k, v]) => [
                `skipped.${k}`,
                v,
              ]),
            )
          : {};
      await ingestListing({
        records: deps.records,
        listing,
        dataset: run.dataset,
        pipeline: run.pipeline,
        generation,
        onPlan: (plan) => deps.runs.report(run.id, { ...plan.counts, ...skips() }, 'set'),
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

  const documentOptions = { concurrency: deps.indexConcurrency ?? 1 };

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
        // From here the job counts as active in the run's progress line.
        const ended = deps.progress?.started({ id: run.id, dataset: run.dataset });
        try {
          const signal = job.signal;
          const { dataset } = await datasetOf(deps, run, signal);
          const tenant = tenantOf(run, deps.admission.platformTenant);
          const found = await listingFor(deps, run, signal);
          const listing = found.listing;
          const chunking = await deps.records.chunking(
            job.data.generation,
            run.pipeline,
            found.chunking,
          );
          // The generation's model, so a catalog edit never mixes vectors of two models in one partition.
          const embedding = await deps.records.embedding(job.data.generation);
          const opened = embedding
            ? deps.embedder({ ...dataset, embedding }, contextOf(run, principal, tenant, signal))
            : undefined;
          // A 429 waits and pauses this worker's other jobs on the model, instead of failing (#400).
          const embedder = opened && throttledEmbedder(opened, { pauses, signal });
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
              // A copied document keeps its engine's chunks, so a copy's chunking is never applied.
              chunking: chunking as ChunkDocumentConfig,
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
          if (outcome === 'stored') {
            await deps.runs.report(run.id, { stored: 1, chunks }, 'add');
            deps.progress?.stored(run.id, chunks);
          }
          if (outcome === 'skipped') await deps.runs.report(run.id, { skipped: 1 }, 'add');
        } finally {
          ended?.();
        }
      },
      deps.admission,
    );

  return {
    platform: [ingest as QueueWork],
    knowledge: [{ ...documentWork(knowledgeIndexQueue), options: documentOptions } as QueueWork],
    heavy: [{ ...documentWork(knowledgeFillQueue), options: documentOptions } as QueueWork],
  };
};
