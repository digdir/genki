import { createHash } from 'node:crypto';
import type { EmbeddingPort } from '@genai/port-embedding';
import type {
  DocumentRecords,
  IndexOutcome,
  IndexRecord,
  ListedDocument,
  ListedFile,
  OwnedRecord,
  RecordTransaction,
  RecordWrite,
  RunCounts,
  RunPlan,
} from '@genai/port-knowledge';
import type { ChunkDocumentConfig } from './chunk-document.js';
import { embedIndexDocument, toIndexDocument } from './index-writer.js';
import { prepareDocument, type SourceDocument } from './pipeline.js';

export type {
  DocumentRecords,
  IndexOutcome,
  ListedDocument,
  ListedFile,
  OwnedRecord,
  RecordTransaction,
  RecordWrite,
  RunCounts,
  RunPlan,
};

/**
 * How a source's documents are deleted (ADR 0042, "Ingestion runs"): a listed source after two
 * complete listings in a row without the document, a crawled one after a 404 or 410 seen twice or
 * three complete crawls without it, an explicit one at once.
 */
export type DeleteRule = 'listed' | 'crawled' | 'explicit';

/** A source as a run lists it, and as an index job loads one of its documents. */
export interface Listing {
  deletes: DeleteRule;
  documents(): AsyncIterable<ListedDocument>;
  /** After `documents()` is read: every page came back without error and any total matched. */
  complete(): boolean;
  load(record: Record<string, unknown>): Promise<SourceDocument>;
}

/** A record that changed while its index job ran: the job fails, and its retry writes the newer change. */
export class StaleRecord extends Error {
  override readonly name = 'StaleRecord';
}

/** A page that answered 404 or 410 when an index job fetched it. */
export class PageGone extends Error {
  override readonly name = 'PageGone';
}

const stableJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object')
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`)
      .join(',')}}`;
  return JSON.stringify(value ?? null);
};

export const metadataHash = (metadata: Record<string, unknown>) =>
  createHash('sha256').update(stableJson(metadata)).digest('hex');

const sameFiles = (a: ListedFile[], b: ListedFile[]) =>
  stableJson([...a].sort((x, y) => (x.name < y.name ? -1 : 1))) ===
  stableJson([...b].sort((x, y) => (x.name < y.name ? -1 : 1)));

/**
 * Days after which a crawled page is downloaded again though its sitemap date has not moved, so a
 * page the site removed but still lists is found by its 404.
 */
export const recheckCrawledAfterDays = 7;

const recheck = (record: OwnedRecord, options: { deletes: DeleteRule; now?: Date }) =>
  options.deletes === 'crawled' &&
  record.appliedAt !== undefined &&
  Date.parse(record.appliedAt) <
    (options.now ?? new Date()).getTime() - recheckCrawledAfterDays * 86_400_000;

/** Listings in a row a document may miss before it is deleted. */
const missesBeforeDelete: Record<DeleteRule, number> = { listed: 2, crawled: 3, explicit: 1 };

/**
 * Compares a listing with the records its pipeline owns (ADR 0042, "Ingestion runs"). A new id, a
 * changed file hash or metadata hash, or a record its generation does not hold at its current
 * change is processed; any other listed record is only seen. An incomplete listing deletes nothing.
 */
export const planRun = (
  listed: ListedDocument[],
  owned: OwnedRecord[],
  options: { complete: boolean; deletes: DeleteRule; now?: Date },
): RunPlan => {
  const byId = new Map(owned.map((r) => [r.id, r]));
  const writes: RecordWrite[] = [];
  const process: string[] = [];
  const counts: RunCounts = { new: 0, changed: 0, deleted: 0, unchanged: 0 };
  const listedIds = new Set<string>();
  for (const doc of listed) {
    if (listedIds.has(doc.id)) continue;
    listedIds.add(doc.id);
    const hash = metadataHash(doc.metadata);
    const record = byId.get(doc.id);
    if (!record || record.state === 'deleted') {
      writes.push({ kind: 'new', listed: doc, metadataHash: hash });
      process.push(doc.id);
      counts.new++;
    } else if (record.metadataHash !== hash || !sameFiles(record.files, doc.files)) {
      writes.push({ kind: 'changed', listed: doc, metadataHash: hash });
      process.push(doc.id);
      counts.changed++;
    } else {
      writes.push({ kind: 'seen', id: doc.id });
      if (record.applied !== record.change || recheck(record, options)) process.push(doc.id);
      counts.unchanged++;
    }
  }
  // An empty listing of a listed or crawled source deletes nothing: an unmounted folder looks the
  // same. An explicit source lists what it holds, so its last file is deleted like any other.
  const empty = listedIds.size === 0 && options.deletes !== 'explicit';
  if (!options.complete || empty) return { writes, process, counts };
  for (const record of owned) {
    if (listedIds.has(record.id) || record.state === 'deleted') continue;
    if (record.missing + 1 >= missesBeforeDelete[options.deletes]) {
      writes.push({ kind: 'delete', id: record.id });
      process.push(record.id);
      counts.deleted++;
    } else writes.push({ kind: 'missing', id: record.id });
  }
  return { writes, process, counts };
};

export interface IndexRecordOptions {
  records: DocumentRecords;
  /** The dataset of the run that sent the job; a record of another dataset is refused. */
  dataset: string;
  /** The run that sent the job: a 404 or 410 counts once per run. */
  run: string;
  listing: Pick<Listing, 'deletes' | 'load'>;
  record: string;
  generation: string;
  chunking: ChunkDocumentConfig;
  embedder?: EmbeddingPort;
}

/**
 * `knowledge.index`: replaces one document from its record, or deletes it and keeps its tombstone
 * (ADR 0042). Running it twice leaves the same result: the document is written whole each time.
 */
export const indexRecord = async (
  options: IndexRecordOptions,
): Promise<IndexOutcome | undefined> => {
  const found = await options.records.find(options.record);
  if (!found) return undefined;
  if (found.dataset !== options.dataset)
    throw new Error(`record ${options.record} is not a record of ${options.dataset}`);
  const record = found;
  if (record.state === 'deleted') {
    await options.records.remove(record, options.generation);
    return 'deleted';
  }
  try {
    return await writeRecord(options, record);
  } catch (error) {
    // Not applied: the generation keeps what it held, and the data version stays below this change
    // until a later run, send-back or catch-up writes it. The reason is a code, never the source id.
    await options.records.fail(record, error instanceof Error ? error.name : 'Error');
    throw error;
  }
};

const applied = (done: boolean) => {
  if (!done)
    throw new StaleRecord(
      'the record changed while its job ran; the retry writes the newer change',
    );
};

const writeRecord = async (
  options: IndexRecordOptions,
  found: IndexRecord,
): Promise<IndexOutcome> => {
  let record = found;
  let document: SourceDocument;
  try {
    const listed = await options.listing.load(record.record);
    document = listed.prepare ? await listed.prepare() : listed;
  } catch (error) {
    if (!(error instanceof PageGone) || options.listing.deletes !== 'crawled') throw error;
    record = await options.records.gone(record, options.run);
    if (record.state === 'deleted') {
      await options.records.remove(record, options.generation);
      return 'deleted';
    }
    // One 404 or 410 is not enough: the page keeps its last version until the second.
    return 'skipped';
  }
  if (document.skip || document.texts.every((t) => t.trim() === '')) {
    applied(
      await options.records.replace(record, options.generation, {
        skip: document.skip ?? 'no_text',
      }),
    );
    return 'skipped';
  }
  const prepared = await prepareDocument(document, options.chunking, 'pipeline');
  const doc = toIndexDocument(record.id, prepared.doc, prepared.chunks, prepared.phrases);
  const written = options.embedder ? await embedIndexDocument(doc, options.embedder) : doc;
  applied(await options.records.replace(record, options.generation, { document: written }));
  return 'stored';
};

export interface IngestListingOptions {
  records: DocumentRecords;
  listing: Pick<Listing, 'deletes' | 'documents' | 'complete'>;
  dataset: string;
  pipeline: string;
  generation: string;
  /** Called with the run's plan before it is written, so its counts are reported. */
  onPlan?: (plan: RunPlan) => Promise<unknown>;
  send: (record: string, transaction: RecordTransaction) => Promise<unknown>;
}

/**
 * `knowledge.ingest`: lists the source, compares it with the pipeline's records and writes the
 * changes with their index jobs in one transaction (ADR 0042). Running it twice leaves the same
 * result: the second listing finds the records written and sends only what the generation lacks,
 * under the index queue's key per generation and record.
 */
export const ingestListing = async (options: IngestListingOptions): Promise<RunCounts> => {
  const listed: ListedDocument[] = [];
  for await (const doc of options.listing.documents()) listed.push(doc);
  const owned = await options.records.owned(options.dataset, options.pipeline, options.generation);
  const plan = planRun(listed, owned, {
    complete: options.listing.complete(),
    deletes: options.listing.deletes,
  });
  await options.onPlan?.(plan);
  await options.records.apply(
    {
      dataset: options.dataset,
      pipeline: options.pipeline,
      generation: options.generation,
      plan,
    },
    options.send,
  );
  return plan.counts;
};
