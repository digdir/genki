import type { Principal } from '@genai/contracts';
import {
  chunkingOf,
  copyOwner,
  indexRecord,
  ingestListing,
  pipelineSpec,
  storedConverter,
  textLayer,
  type DocumentConverter,
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
  convertPriority,
  defaultMarkerTimeoutMs,
  heavyWorkStart,
  knowledgeConvertQueue,
  knowledgeFillQueue,
  knowledgeIndexQueue,
  knowledgeIngestQueue,
  knowledgeKeys,
  type JobQueue,
  type QueueDefinition,
  type QueueWork,
} from '@genai/jobs';
import {
  acceptedTextLayer,
  conversionKey,
  GenerationBusy,
  textLayerDerivation,
  type ConversionTarget,
  type ConversionWaiter,
  type ConverterKey,
  type StoredConversions,
} from '@genai/port-knowledge';
import type { EmbeddingOpenOptions, EmbeddingPort } from '@genai/port-embedding';
import type { RunProgress } from './run-progress.js';
import type { PortContext } from '@genai/kernel';
import type { DatasetConfig } from '@genai/port-knowledge';
import { executionScope, type IngestionExecution } from '@genai/providers-postgres';
import {
  admittedConversion,
  admittedWork,
  type AdmissionDeps,
  type KnowledgeJob,
} from './knowledge-jobs.js';

export interface KnowledgeHandlerDeps {
  /** The document records on the knowledge server, as the writer role. */
  records: DocumentRecords;
  /** The worker's log: an embedder that gives up is logged as `model call failed`. */
  log?: (msg: string, fields: Record<string, unknown>) => void;
  /** The knowledge server's queue, where index and convert jobs commit with their records. */
  knowledge: Pick<JobQueue, 'send' | 'sendAgain' | 'serveAlso'>;
  /**
   * Stored conversions (ADR 0042): with them, the ingest job sends a convert job for each file a
   * converter reads that has none, index jobs read stored pages, and convert jobs store them.
   * Without them, index jobs convert as they load.
   */
  conversions?: StoredConversions;
  /** The converter convert jobs run: the text layer while no Docling host is configured. */
  converter?: DocumentConverter;
  /**
   * The Blob container for converters' native output (#473), keyed by file sha256; the text layer
   * has none, so nothing is written there until Docling.
   */
  nativeOutputs?: {
    put(
      key: ConverterKey & { sha256: string },
      output: Uint8Array,
      pages: number,
    ): Promise<{ path: string }>;
  };
  /** How many convert jobs this worker works at once; 2 when left out. */
  convertConcurrency?: number;
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
  /** A run's listing; index jobs pass the stored-conversion reader as its converter. */
  listingOf(
    spec: PipelineSpec,
    scope: KnowledgeListingScope,
    signal: AbortSignal,
    converter?: DocumentConverter,
  ): Promise<Listing>;
  embedder(
    dataset: DatasetConfig,
    ctx: PortContext,
    request?: EmbeddingOpenOptions,
  ): EmbeddingPort | undefined;
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
  converter?: DocumentConverter,
) => {
  if (run.pipeline === copyOwner) {
    if (!run.engineSwitch || !deps.copyListingOf)
      throw new Error(`run ${run.id} copies, but names no engine switch`);
    return { listing: await deps.copyListingOf(run, signal), chunking: copiedChunking };
  }
  const spec = await specOf(deps, run);
  return {
    listing: await deps.listingOf(
      spec,
      listingScope(run, deps.admission.platformTenant),
      signal,
      ...(converter ? [converter] : []),
    ),
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

/** The convert queue as the handlers send to it; its expiry is set where the queues are installed. */
const convertQueue = knowledgeConvertQueue(defaultMarkerTimeoutMs);

/** What a convert job converts with: the text layer while no Docling host is configured (#477). */
const conversionTarget = (sha256: string): ConversionTarget => ({
  sha256,
  converter: textLayer.name,
  version: textLayer.version,
  settings: textLayer.settings,
});

/** How a converter's pages are derived from its output: `text-layer` 1 for the text layer. */
const derivationOf = (converter: string) =>
  converter === textLayer.name ? textLayerDerivation : { name: `${converter}-pages`, version: 1 };

type ConvertData = typeof convertQueue extends QueueDefinition<infer T> ? T : never;
type ConvertJob = KnowledgeJob<ConvertData> & { sender?: IngestionExecution };

/**
 * Why a converter refused a file, when it did: its own errors about the file are refusals, kept
 * as such; an unavailable converter host (an HTTP status) is not, so its job is tried again.
 */
const refusalOf = (error: unknown) => {
  if (!(error instanceof Error) || typeof (error as { status?: unknown }).status === 'number')
    return undefined;
  if (error.message.startsWith('the converter made ')) return undefined;
  if (error.name === 'DocumentTooLargeError' || error.name === 'TooManyPagesError')
    return 'too_large';
  if (error.name === 'UnsupportedDocumentError') return 'unsupported_type';
  return 'conversion_failed';
};

/** A file a convert job could not fetch: tried again, never stored as the converter's refusal. */
class FetchFailed extends Error {
  override readonly name = 'FetchFailed';
  constructor(override readonly cause: unknown) {
    super('the file could not be fetched');
  }
}

/** A conversion stored while an index job it must send still ran: the convert job is tried again. */
export class IndexJobBusy extends Error {
  override readonly name = 'IndexJobBusy';
}

/** Thrown when a conversion was stored while an index job read it: the job's retry reads it. */
export class ConversionStoredMeanwhile extends Error {
  override readonly name = 'ConversionStoredMeanwhile';
}

export const knowledgeWork = (
  deps: KnowledgeHandlerDeps,
): { platform: QueueWork[]; knowledge: QueueWork[]; heavy: QueueWork[] } => {
  const pauses = new EmbeddingPauses();
  /**
   * Makes a record wait on a file's conversion and sends its convert job, or, when the job is
   * already waiting or running, adds the record's organisation to it (ADR 0042, "Jobs"). False
   * when the conversion is already stored.
   */
  const waitOn = (
    conversions: StoredConversions,
    sha256: string,
    waiter: ConversionWaiter,
    transaction?: RecordTransaction,
  ) => {
    const target = conversionTarget(sha256);
    const key = conversionKey(target);
    return conversions.wait(
      target,
      waiter,
      async (tx) => {
        const sent = await deps.knowledge.send(
          convertQueue,
          {
            run: waiter.run,
            tenant: waiter.tenant,
            file: sha256,
            dataset: waiter.dataset,
            record: waiter.record,
            tenants: waiter.tenant,
          },
          { key, priority: convertPriority.run, transaction: tx },
        );
        if (sent === null)
          await deps.knowledge.serveAlso?.(convertQueue, key, waiter.tenant, { transaction: tx });
      },
      transaction,
    );
  };
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
        send: async (record: string, transaction: RecordTransaction) => {
          const index = () =>
            deps.knowledge.send(
              knowledgeIndexQueue,
              { run: run.id, tenant: job.data.tenant, generation, record },
              { key: knowledgeKeys.index(generation, record), transaction },
            );
          const conversions = deps.conversions;
          if (!conversions) return index();
          // A file a converter reads with no stored conversion is converted first; its record
          // waits and the finished conversion sends the index job (ADR 0042, "Ingestion runs").
          const waiter = {
            dataset: run.dataset,
            record,
            generation,
            run: run.id,
            tenant: job.data.tenant,
          };
          // A wait left from an earlier run, on a file the record no longer holds or on a
          // conversion that ended as a dead letter, is ended before the record waits again.
          await conversions.clear(transaction, run.dataset, record);
          let waiting = false;
          for (const file of await conversions.missing(transaction, record, acceptedTextLayer))
            waiting = (await waitOn(conversions, file.sha256, waiter, transaction)) || waiting;
          return waiting ? undefined : index();
        },
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
          const conversions = deps.conversions;
          // With stored conversions, the listing reads them instead of converting (ADR 0042).
          const found = await listingFor(
            deps,
            run,
            signal,
            conversions
              ? storedConverter(deps.converter ?? {}, conversions, acceptedTextLayer)
              : undefined,
          );
          const listing = found.listing;
          const chunking = await deps.records.chunking(
            job.data.generation,
            run.pipeline,
            found.chunking,
          );
          // The generation's model, so a catalog edit never mixes vectors of two models in one partition.
          const embedding = await deps.records.embedding(job.data.generation);
          // Without the SDK's retries: a 429 waits here and pauses this worker's other jobs on the
          // model, instead of failing the document (#400).
          const ctx = contextOf(run, principal, tenant, signal);
          const opened = embedding
            ? deps.embedder({ ...dataset, embedding }, ctx, { retries: 0 })
            : undefined;
          const embedder =
            opened &&
            throttledEmbedder(opened, {
              pauses,
              signal,
              cancelled,
              // The runtime leaves these to the job, which logs only the try it gives up.
              onGaveUp: (error) =>
                deps.log?.('model call failed', {
                  task: ctx.task,
                  tenant: ctx.tenant,
                  model: embedding?.model,
                  error: error.name,
                  code: error.code,
                }),
            });
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
              ...(conversions
                ? {
                    pending: async (files: { sha256: string }[]) => {
                      const waiter = {
                        dataset: run.dataset,
                        record: job.data.record,
                        generation: job.data.generation,
                        run: run.id,
                        tenant: job.data.tenant,
                      };
                      let waiting = false;
                      for (const file of files)
                        waiting = (await waitOn(conversions, file.sha256, waiter)) || waiting;
                      if (!waiting)
                        throw new ConversionStoredMeanwhile(
                          'the conversion was stored while the job read it; its retry reads it',
                        );
                    },
                  }
                : {}),
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

  /**
   * A convert job's error names its record by number and the error by its code, never a file name,
   * a path or a dataset: its dead letter is shown to every organisation waiting on it (ADR 0042).
   */
  const convertError = (record: string, error: unknown) => {
    const code =
      (error as { code?: unknown }).code ?? (error instanceof Error ? error.name : 'Error');
    return new Error(`converting a file of record ${record} failed: ${String(code)}`);
  };

  const convert = admittedConversion(
    convertQueue,
    async (input) => {
      try {
        await convertFile(input);
      } catch (error) {
        throw convertError(input.job.data.record, error);
      }
    },
    {
      ...deps.admission,
      waiting: async (data) =>
        ((await deps.conversions?.waiting(conversionTarget(data.file))) ?? []).map((w) => w.run),
    },
  );

  /**
   * The job's file, fetched as its record's own run fetches it, through the same guard and
   * policies: the sender's record, or, when the sender is gone, the record of the waiting run that
   * admitted the job.
   */
  async function fetchFile(
    job: ConvertJob['job'],
    run: IngestionExecution,
    sender: IngestionExecution | undefined,
  ) {
    try {
      const waiter = sender
        ? { dataset: job.data.dataset, record: job.data.record }
        : (await deps.conversions?.waiting(conversionTarget(job.data.file)))?.find(
            (w) => w.run === run.id,
          );
      if (!waiter) throw new Error(`no waiting record of run ${run.id} names the file`);
      const record = await deps.records.find(waiter.record);
      if (!record || record.dataset !== waiter.dataset)
        throw new Error(`record ${waiter.record} is not a record of its dataset`);
      const { listing } = await listingFor(deps, sender ?? run, job.signal, deps.converter);
      if (!listing.file) throw new Error(`the source of record ${waiter.record} fetches no file`);
      return await listing.file(record.record, job.data.file);
    } catch (error) {
      throw new FetchFailed(error);
    }
  }

  async function convertFile({ job, run, sender, cancelled }: ConvertJob) {
    deps.bound?.();
    const { conversions, converter } = deps;
    if (!conversions || !converter) throw new Error('this worker keeps no stored conversions');
    if (await cancelled()) return;
    // Stored under the key its job and waits name, so the conversion always ends those waits.
    const key = conversionTarget(job.data.file);
    let stored: { pages: string[]; output?: Uint8Array; failure?: string };
    // A conversion stored by an earlier try is not made again: only its waits are ended.
    const kept = await conversions.find(job.data.file, acceptedTextLayer);
    if (kept) stored = { pages: kept.pages, ...(kept.failure ? { failure: kept.failure } : {}) };
    else
      try {
        const file = await fetchFile(job, run, sender);
        const conversion = await converter.convert(file);
        const made = conversion.converter;
        if (made.name !== key.converter || made.version !== key.version)
          throw new Error(
            `the converter made ${made.name} ${made.version}, not the job's converter`,
          );
        stored = {
          pages: conversion.pages,
          ...(conversion.output ? { output: conversion.output } : {}),
        };
      } catch (error) {
        const failure = error instanceof FetchFailed ? undefined : refusalOf(error);
        if (!failure) throw error instanceof FetchFailed ? error.cause : error;
        // A refusal is stored with no pages: documents skip the file, and it is not converted again.
        stored = { pages: [], failure };
      }
    // The native output goes to Blob first, so a stored conversion never names a missing path.
    const output =
      stored.output && deps.nativeOutputs
        ? await deps.nativeOutputs.put(key, stored.output, stored.pages.length)
        : undefined;
    const { busy } = await conversions.store(
      {
        ...key,
        derivation: derivationOf(key.converter),
        pages: stored.pages,
        ...(output ? { outputPath: output.path } : {}),
        ...(stored.failure ? { failure: stored.failure } : {}),
      },
      (waiter, transaction) =>
        deps.knowledge.send(
          knowledgeIndexQueue,
          {
            run: waiter.run,
            tenant: waiter.tenant,
            generation: waiter.generation,
            record: waiter.record,
          },
          { key: knowledgeKeys.index(waiter.generation, waiter.record), transaction },
        ),
    );
    if (busy.length > 0)
      throw new IndexJobBusy(
        `${busy.length} record(s) had an index job still queued or running; tried again`,
      );
  }

  return {
    platform: [ingest as QueueWork],
    knowledge: [
      { ...documentWork(knowledgeIndexQueue), options: documentOptions } as QueueWork,
      ...(deps.conversions
        ? [{ ...convert, options: { concurrency: deps.convertConcurrency ?? 2 } } as QueueWork]
        : []),
    ],
    heavy: [{ ...documentWork(knowledgeFillQueue), options: documentOptions } as QueueWork],
  };
};
