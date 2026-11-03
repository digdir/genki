import type { IndexDocument } from './writer.js';

/**
 * Document records on the knowledge server (ADR 0042, "What is stored"), as the worker's ingest
 * and index jobs reach them. `packages/ingest` compares and indexes; a provider stores.
 */

export interface ListedFile {
  name: string;
  /** The hash the source lists for the file, when it lists one without a download. */
  sha256?: string;
}

/** One document as its source lists it, before anything is fetched. */
export interface ListedDocument {
  id: string;
  /** The source record as received; the index job loads the document from it. */
  record: Record<string, unknown>;
  /** What the metadata hash covers: the record without what changes when nothing does. */
  metadata: Record<string, unknown>;
  files: ListedFile[];
}

/** A record its pipeline owns, with the change its run's generation has applied. */
export interface OwnedRecord {
  number: string;
  id: string;
  metadataHash: string;
  files: ListedFile[];
  state: 'stored' | 'skipped' | 'failed' | 'deleted' | null;
  missing: number;
  change: number;
  /** The change of this record that the generation holds, if any. */
  applied?: number;
  /** When the generation last wrote it, so a crawled page is downloaded again after a while. */
  appliedAt?: string;
}

/** A change to one record. `new`, `changed` and `delete` take the next number in the change sequence. */
export type RecordWrite =
  | { kind: 'new' | 'changed'; listed: ListedDocument; metadataHash: string }
  | { kind: 'seen'; id: string }
  | { kind: 'missing'; id: string }
  | { kind: 'delete'; id: string };

export interface RunCounts {
  new: number;
  changed: number;
  deleted: number;
  unchanged: number;
}

export interface RunPlan {
  writes: RecordWrite[];
  /** Ids of records whose index job the run sends, after the writes. */
  process: string[];
  counts: RunCounts;
}

/** The transaction a run's record changes commit in, so their index jobs commit with them. */
export interface RecordTransaction {
  query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }>;
}

/** A record as an index job reads it. */
export interface IndexRecord {
  number: string;
  dataset: string;
  id: string;
  record: Record<string, unknown>;
  state: OwnedRecord['state'];
  change: number;
  gone: number;
}

/** `checked`: a re-checked page that still answered, left as the generation holds it. */
export type IndexOutcome = 'stored' | 'skipped' | 'deleted' | 'checked';

/** The document records of the knowledge server, as the worker's writer reaches them. */
/**
 * A writer that cannot get its generation's lock, because VACUUM holds it or waits for it: the
 * job writes nothing and is sent again later (ADR 0042, "Heavy work", the pgvector 0.8.2 workaround).
 */
export class GenerationBusy extends Error {
  constructor(readonly generation: string) {
    super(`VACUUM holds generation ${generation}; the job is sent again later`);
    this.name = 'GenerationBusy';
  }
}

export interface DocumentRecords {
  /** The records a pipeline owns in a dataset, with the change each holds in the generation. */
  owned(dataset: string, pipeline: string, generation: string): Promise<OwnedRecord[]>;
  /**
   * Writes a run's record changes in one transaction, each content change with the next number in
   * the dataset's change sequence, and sends an index job for each record to process in it.
   */
  apply(
    input: { dataset: string; pipeline: string; generation: string; plan: RunPlan },
    send: (record: string, transaction: RecordTransaction) => Promise<unknown>,
  ): Promise<void>;
  /** The chunking the generation keeps for a pipeline: recorded by its first run, never changed after. */
  chunking<Chunking>(generation: string, pipeline: string, current: Chunking): Promise<Chunking>;
  /** The embedding a generation was built with: its index jobs embed with it, not the catalog's. */
  embedding(generation: string): Promise<{ model: string; dimensions: number } | undefined>;
  find(number: string): Promise<IndexRecord | undefined>;
  /** Whether a writer would get the generation's lock now, checked before a job embeds anything. */
  writable(generation: string): Promise<boolean>;
  /** Whether the generation already holds the record's current change. */
  held(record: IndexRecord, generation: string): Promise<boolean>;
  /** Marks a held record as checked now, without writing it, so its next re-check waits again. */
  touch(record: IndexRecord, generation: string): Promise<void>;
  /**
   * Replaces one document in the generation in one transaction, or removes it when it was skipped,
   * records the change it applied and moves the generation's data version. Answers false, and
   * writes nothing, when the record has changed since the job read it. Throws GenerationBusy,
   * writing nothing, when VACUUM holds the generation.
   */
  replace(
    record: IndexRecord,
    generation: string,
    result: { document: IndexDocument } | { skip: string },
  ): Promise<boolean>;
  /** Deletes a document from the generation and leaves its tombstone, in one transaction; GenerationBusy as replace. */
  remove(record: IndexRecord, generation: string): Promise<void>;
  /**
   * Counts a 404 or 410, at most once per run; at the second, the record is marked deleted with
   * the next change number.
   */
  gone(record: IndexRecord, run: string): Promise<IndexRecord>;
  /**
   * Marks a record whose index attempt failed, with a short reason code: never over a stored
   * result, and without applying its change, so the data version stays below it until a later
   * run, send-back or catch-up writes it.
   */
  fail(record: IndexRecord, reason: string): Promise<void>;
}
