import { randomUUID } from 'node:crypto';
import type { Principal } from '@genai/contracts';
import {
  chunkingOf,
  ConversionRefused,
  copyOwner,
  doclingIdentity,
  FileUnreachable,
  indexRecord,
  ingestListing,
  pipelineSpec,
  ResponseTooLarge,
  storedConverter,
  textLayer,
  type DocumentConverter,
  throttledEmbedder,
  EmbeddingPauses,
  type ChunkDocumentConfig,
  type CopyListing,
  type DocumentFile,
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
  inNightWindow,
  knowledgeConvertQueue,
  knowledgeFillQueue,
  knowledgeIndexQueue,
  knowledgeIngestQueue,
  knowledgeKeys,
  knowledgeReplaceQueue,
  nextNightWindowStart,
  type JobQueue,
  type QueueDefinition,
  type QueueWork,
} from '@genai/jobs';
import {
  acceptedConverters,
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
import { seedWork } from './conversion-seed.js';
import type { NativeOutputStore } from '@genai/port-blob';
import type { PortContext } from '@genai/kernel';
import type { DatasetConfig } from '@genai/port-knowledge';
import { executionScope, type IngestionExecution } from '@genai/providers-postgres';
import {
  admissionRefusal,
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
  /** The converter convert jobs run without Docling, and after Docling refuses a file: the text layer. */
  converter?: DocumentConverter;
  /**
   * Docling, when `DOCLING_URL` names a server (issue 477): every convert job asks it first, and a
   * file it refuses, a file that is not a PDF among them, goes to the text layer in the same job.
   */
  docling?: DocumentConverter;
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
  } & Partial<Pick<NativeOutputStore, 'files' | 'read'>>;
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
 * `KNOWLEDGE_CONVERT_CONCURRENCY` (2 when unset): convert jobs this worker works at once. The
 * template sets it to the Docling server's replicas, which convert one file each (issue 477).
 */
export const convertConcurrencyOf = (env: NodeJS.ProcessEnv): number => {
  const raw = env.KNOWLEDGE_CONVERT_CONCURRENCY;
  if (raw === undefined) return 2;
  const value = Number(raw);
  if (raw.trim() === '' || !Number.isInteger(value) || value < 1 || value > 8)
    throw new Error(
      `KNOWLEDGE_CONVERT_CONCURRENCY must be a whole number from 1 to 8, not "${raw}"`,
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

/** A convert job's converter by the name its data gives: Docling, else the text layer (issue 477). */
const identityOf = (converter: string | undefined) =>
  converter === doclingIdentity.name ? doclingIdentity : textLayer;

/** What a convert job converts with, and the key its waits and its conversion are stored under. */
const conversionTarget = (sha256: string, converter?: string): ConversionTarget => {
  const identity = identityOf(converter);
  return {
    sha256,
    converter: identity.name,
    version: identity.version,
    settings: identity.settings,
  };
};

/** The text layer as an accepted converter, to find a file's own text-layer conversion. */
const textLayerOnly = [{ converter: textLayer.name, derivation: textLayerDerivation, kept: false }];

/** How a converter's pages are derived from its output: `text-layer` 1 for the text layer. */
const derivationOf = (converter: string) =>
  converter === textLayer.name ? textLayerDerivation : { name: `${converter}-pages`, version: 1 };

type ConvertData = typeof convertQueue extends QueueDefinition<infer T> ? T : never;

/** The converter a convert job's data names: Docling, or the text layer when it names none. */
const converterOf = (data: ConvertData) => ('converter' in data ? data.converter : undefined);
type ConvertJob = KnowledgeJob<ConvertData> & {
  sender?: IngestionExecution;
  /** The open, admitted runs the conversion is for: its sender and the runs waiting on it. */
  running: IngestionExecution[];
};

/** Converter errors about the file itself, and the failure each is stored as (ADR 0042). */
const fileRefusals: Readonly<
  Record<string, 'too_large' | 'unsupported_type' | 'conversion_failed'>
> = {
  DocumentTooLargeError: 'too_large',
  TooManyPagesError: 'too_large',
  UnsupportedDocumentError: 'unsupported_type',
  InvalidPDFException: 'conversion_failed',
  PasswordException: 'conversion_failed',
};

/**
 * Why a converter refused a file, when its error is known to be about the file. Every other
 * error, from a bug, a host that timed out or answered with a status, or a Word file the
 * converter could not read, is not stored: its job is tried again and then dead-lettered.
 */
const refusalOf = (error: unknown) => {
  if (error instanceof ConversionRefused && error.reason !== 'unreachable') return error.reason;
  return error instanceof Error && Object.hasOwn(fileRefusals, error.name)
    ? fileRefusals[error.name]
    : undefined;
};

/** Why a convert job's fetch cannot have the file (issue 597); other fetch errors are retried. */
const fetchRefusalOf = (error: unknown) =>
  error instanceof FileUnreachable || error instanceof ResponseTooLarge ? 'unreachable' : undefined;

/** A file a convert job could not fetch: tried again unless `fetchRefusalOf` names why. */
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
  /** The converter new convert jobs ask: Docling when the worker has a server, else the text layer. */
  const converterNow = () => (deps.docling ? doclingIdentity.name : textLayer.name);
  /**
   * Makes a record wait on a file's conversion and sends its convert job, or, when the job is
   * already waiting or running, adds the record's organisation to it (ADR 0042, "Jobs"). False
   * when the conversion is already stored. A replacement run sends at its own priority, to start
   * in the night window.
   */
  const waitOn = (
    conversions: StoredConversions,
    sha256: string,
    waiter: ConversionWaiter,
    transaction?: RecordTransaction,
    timing: { priority: number; startAfter?: Date } = { priority: convertPriority.run },
  ) => {
    const converter = converterNow();
    const target = conversionTarget(sha256, converter);
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
            ...(converter === doclingIdentity.name ? { converter: 'docling' as const } : {}),
          },
          {
            key,
            priority: timing.priority,
            ...(timing.startAfter ? { startAfter: timing.startAfter } : {}),
            transaction: tx,
          },
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
          for (const file of await conversions.missing(transaction, record, acceptedConverters))
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
              ? storedConverter(deps.converter ?? {}, conversions, acceptedConverters)
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
    // The code goes on the error too, so the failed-job log can name it (issue 532).
    return Object.assign(
      new Error(`converting a file of record ${record} failed: ${String(code)}`),
      {
        code: String(code),
      },
    );
  };

  /**
   * A conversion only replacement runs wait on, taken outside the night window, is sent again for
   * the window's next start and converts nothing now (ADR 0042, "Conversion").
   */
  const outsideWindow = async ({ job, running }: ConvertJob) => {
    if (running.some((r) => !r.replaces)) return false;
    const now = deps.heavy.now?.() ?? new Date();
    const window = deps.heavy.window();
    if (inNightWindow(window, now)) return false;
    await deps.knowledge.sendAgain(convertQueue, job, {
      key: conversionKey(conversionTarget(job.data.file, converterOf(job.data))),
      startAfter: nextNightWindowStart(window, now),
      priority: convertPriority.replacement,
    });
    return true;
  };

  const convert = admittedConversion(
    convertQueue,
    async (input) => {
      try {
        if (await outsideWindow(input)) return;
        await convertFile(input);
      } catch (error) {
        throw convertError(input.job.data.record, error);
      }
    },
    {
      ...deps.admission,
      waiting: async (data) =>
        (
          (await deps.conversions?.waiting(conversionTarget(data.file, converterOf(data)))) ?? []
        ).map((w) => w.run),
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
        : (
            await deps.conversions?.waiting(conversionTarget(job.data.file, converterOf(job.data)))
          )?.find((w) => w.run === run.id);
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

  /** The index job of a record whose wait a stored conversion ended. */
  const sendIndex = (waiter: ConversionWaiter, transaction?: RecordTransaction) =>
    deps.knowledge.send(
      knowledgeIndexQueue,
      {
        run: waiter.run,
        tenant: waiter.tenant,
        generation: waiter.generation,
        record: waiter.record,
      },
      {
        key: knowledgeKeys.index(waiter.generation, waiter.record),
        ...(transaction ? { transaction } : {}),
      },
    );

  /**
   * After Docling refused a file, the same job reads it with the text layer, unless the file has a
   * text-layer conversion already (issue 477): stored before the refusal, so the refusal's end of
   * the waits sends index jobs that read it.
   */
  async function textLayerAfterRefusal(
    conversions: StoredConversions,
    file: DocumentFile,
    sha256: string,
  ) {
    if (!deps.converter || (await conversions.find(sha256, textLayerOnly))) return;
    let pages: string[];
    try {
      const conversion = await deps.converter.convert(file);
      if (conversion.converter.name !== textLayer.name) return;
      pages = conversion.pages;
    } catch (error) {
      // The text layer refuses it too: the Docling refusal is what documents skip it with.
      if (refusalOf(error)) return;
      throw error;
    }
    await conversions.store(
      { ...conversionTarget(sha256, textLayer.name), derivation: textLayerDerivation, pages },
      sendIndex,
    );
  }

  async function convertFile({ job, run, sender, cancelled }: ConvertJob) {
    deps.bound?.();
    const conversions = deps.conversions;
    // Stored under the key its job and waits name, so the conversion always ends those waits.
    const key = conversionTarget(job.data.file, converterOf(job.data));
    const converter = key.converter === doclingIdentity.name ? deps.docling : deps.converter;
    if (!conversions || !converter)
      throw new Error(`this worker keeps no stored conversions with ${key.converter}`);
    if (await cancelled()) return;
    let stored: { pages: string[]; output?: Uint8Array; outputPath?: string; failure?: string };
    // A conversion stored by an earlier try is not made again: only its waits are ended. A file
    // stored as unreachable is fetched again, by every try. Only this version and settings count:
    // a seeded Docling conversion is another's.
    const found = await conversions.find(job.data.file, [
      { converter: key.converter, derivation: derivationOf(key.converter), kept: false },
    ]);
    const kept = found && conversionKey(found) === conversionKey(key) ? found : undefined;
    if (kept && kept.failure !== 'unreachable')
      stored = {
        pages: kept.pages,
        // Kept with its Blob path, so a later try never stores the conversion without it.
        ...(kept.outputPath ? { outputPath: kept.outputPath } : {}),
        ...(kept.failure ? { failure: kept.failure } : {}),
      };
    else {
      let file: DocumentFile | undefined;
      try {
        file = await fetchFile(job, run, sender);
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
        const failure =
          error instanceof FetchFailed ? fetchRefusalOf(error.cause) : refusalOf(error);
        if (!failure) throw error instanceof FetchFailed ? error.cause : error;
        if (file && key.converter === doclingIdentity.name)
          await textLayerAfterRefusal(conversions, file, job.data.file);
        // A refusal is stored with no pages, which ends the waits: documents skip the file.
        stored = { pages: [], failure };
      }
    }
    // The native output goes to Blob first, so a stored conversion never names a missing path.
    const output =
      stored.output && deps.nativeOutputs
        ? await deps.nativeOutputs.put(key, stored.output, stored.pages.length)
        : undefined;
    const outputPath = output?.path ?? stored.outputPath;
    const { sent, busy } = await conversions.store(
      {
        ...key,
        derivation: derivationOf(key.converter),
        pages: stored.pages,
        ...(outputPath ? { outputPath } : {}),
        ...(stored.failure ? { failure: stored.failure } : {}),
      },
      sendIndex,
    );
    // A replacement's new pages reach every document of its pipeline that holds the file, also
    // one written again meanwhile, which ended its wait (ADR 0042, "Conversion").
    if (run.replaces && stored.pages.length > 0) {
      const { generation } = await datasetOf(deps, run, job.signal);
      const indexed = new Set([...sent, ...busy].map((w) => w.record));
      let stillBusy = 0;
      for (const record of await conversions.holding(run.dataset, run.pipeline, job.data.file))
        if (!indexed.has(record)) {
          const queued = await sendIndex({
            dataset: run.dataset,
            record,
            generation,
            run: run.id,
            tenant: executionScope(run.dataset),
          });
          if (queued === null) stillBusy += 1;
        }
      // As for a waiting record: its index job may have read the old pages, so the job is tried again.
      if (stillBusy > 0)
        throw new IndexJobBusy(
          `${stillBusy} record(s) holding the file had an index job still queued or running; tried again`,
        );
    }
    if (busy.length > 0)
      throw new IndexJobBusy(
        `${busy.length} record(s) had an index job still queued or running; tried again`,
      );
  }

  /**
   * A replacement run's first step (ADR 0042, "Conversion"): every record of its dataset whose
   * files have only a text-layer conversion waits on Docling, with its convert jobs sent for the
   * night window at the lowest priority. Records are read in pages of 500, by record number.
   */
  const replace = admittedWork(
    knowledgeReplaceQueue,
    async ({ job, run, cancelled }) => {
      deps.bound?.();
      const conversions = deps.conversions;
      if (!conversions || !deps.docling) return;
      const { generation } = await datasetOf(deps, run, job.signal);
      const startAfter = heavyWorkStart(deps.heavy.window(), deps.heavy.now?.() ?? new Date());
      let after = '0';
      for (;;) {
        if (await cancelled()) return;
        const page = await conversions.replaceable(
          run.dataset,
          run.pipeline,
          acceptedConverters,
          after,
          500,
        );
        const last = page.at(-1);
        if (!last) return;
        for (const { record, files } of page) {
          const waiter = {
            dataset: run.dataset,
            record,
            generation,
            run: run.id,
            tenant: job.data.tenant,
          };
          for (const file of files)
            await waitOn(conversions, file.sha256, waiter, undefined, {
              priority: convertPriority.replacement,
              startAfter,
            });
        }
        after = last.record;
      }
    },
    deps.admission,
  );

  return {
    platform: [ingest as QueueWork],
    knowledge: [
      { ...documentWork(knowledgeIndexQueue), options: documentOptions } as QueueWork,
      ...(deps.conversions
        ? [
            { ...convert, options: { concurrency: deps.convertConcurrency ?? 2 } } as QueueWork,
            replace as QueueWork,
          ]
        : []),
      ...(deps.conversions && deps.nativeOutputs?.files && deps.nativeOutputs.read
        ? [
            seedWork({
              conversions: deps.conversions,
              outputs: deps.nativeOutputs as Required<
                NonNullable<KnowledgeHandlerDeps['nativeOutputs']>
              >,
              sendIndex,
              ...(deps.log ? { log: deps.log } : {}),
              ...(deps.bound ? { bound: deps.bound } : {}),
            }),
          ]
        : []),
    ],
    heavy: [{ ...documentWork(knowledgeFillQueue), options: documentOptions } as QueueWork],
  };
};

export interface ReplacementDeps {
  conversions: Pick<StoredConversions, 'replaceable'>;
  /** The platform server's run records, as the worker starts a replacement run there. */
  runs: {
    startReplacement(
      sender: IngestionExecution,
      id: string,
      at: string,
    ): Promise<IngestionExecution | undefined>;
  };
  /** The knowledge server's queue, where the replacement run's first job goes. */
  knowledge: Pick<JobQueue, 'send'>;
  /** In lockdown, only a run whose admission still holds as it ends hands it on (ADR 0033). */
  lockdown: boolean;
  now?: () => Date;
}

/**
 * Sends the replacement run of a run that ended with text-layer files (ADR 0042, "Conversion"),
 * when the worker has a Docling server: one at a time per pipeline, with the sender's admission.
 * A cancelled run, a copy, and a replacement run itself send none.
 */
export const replacementRuns =
  (deps: ReplacementDeps) =>
  async (ended: IngestionExecution): Promise<IngestionExecution | undefined> => {
    if (ended.replaces || ended.status === 'cancelled' || ended.pipeline === copyOwner) return;
    const now = deps.now?.() ?? new Date();
    if (deps.lockdown && admissionRefusal(ended, now, true)) return;
    const left = await deps.conversions.replaceable(
      ended.dataset,
      ended.pipeline,
      acceptedConverters,
      '0',
      1,
    );
    if (left.length === 0) return;
    const at = now.toISOString();
    const started = await deps.runs.startReplacement(ended, randomUUID(), at);
    if (!started) return;
    await deps.knowledge.send(
      knowledgeReplaceQueue,
      { run: started.id, tenant: executionScope(started.dataset) },
      { key: started.id },
    );
    return started;
  };
