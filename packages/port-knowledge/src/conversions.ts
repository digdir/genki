import { createHash } from 'node:crypto';
import type { RecordTransaction } from './records.js';

/**
 * Stored conversions on the knowledge server (ADR 0042, "What is stored", "Conversion"): a file's
 * markdown per page, keyed by its sha256, converter, version, settings and derivation, shared by
 * every dataset that holds the file.
 */

/** A converter as part of a stored conversion's key. */
export interface ConverterKey {
  converter: string;
  version: string;
  settings: Readonly<Record<string, unknown>>;
}

/** How the pages were derived from the converter's output, and that derivation's version. */
export interface Derivation {
  name: string;
  version: number;
}

/**
 * A converter a pipeline accepts, with the derivation its documents read, and whether its
 * conversions are kept or replaced by a later run (ADR 0042, "Conversion").
 */
export interface AcceptedConverter {
  converter: string;
  derivation: Derivation;
  kept: boolean;
}

export const textLayerDerivation: Derivation = { name: 'text-layer', version: 1 };
export const doclingPagesDerivation: Derivation = { name: 'docling-pages', version: 1 };
export const doclingPartsDerivation: Derivation = { name: 'docling-parts', version: 1 };

/**
 * The converters every pipeline accepts, in order: Docling, any version and settings, kept (the
 * seeded KUDOS export, issue 474), then the text layer, to be replaced.
 */
export const acceptedConverters: AcceptedConverter[] = [
  { converter: 'docling', derivation: doclingPagesDerivation, kept: true },
  { converter: 'text-layer', derivation: textLayerDerivation, kept: false },
];

export interface StoredConversion extends ConverterKey {
  sha256: string;
  derivation: Derivation;
  pages: string[];
  /** Where the converter's native output lies in the Blob container, when it has one. */
  outputPath?: string;
  /**
   * Why the converter refused the file, only for an error about the file itself: `too_large`,
   * `unsupported_type`, or `conversion_failed` for a PDF that cannot be opened or needs a
   * password (rows stored before issue 517 also hold it for other errors). Stored with no pages,
   * so documents skip the file with that reason and it is not converted again until a converter
   * replaces it. `unreachable` is a file its convert job could not fetch (issue 597): documents skip
   * it too, but it counts as missing, so a record that lists it and is written again fetches it
   * again.
   */
  failure?: string;
}

/** A record waiting on a file's conversion, with what its index job needs. */
export interface ConversionWaiter {
  dataset: string;
  record: string;
  generation: string;
  run: string;
  tenant: string;
}

/** A file to convert, as the convert job's key names it. */
export type ConversionTarget = ConverterKey & { sha256: string };

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
    );
  return value;
};

/** The sha256 of the settings as canonical JSON, as the Blob container names native output. */
export const settingsHash = (settings: Readonly<Record<string, unknown>>) =>
  createHash('sha256')
    .update(JSON.stringify(canonical(settings)))
    .digest('hex');

/** A convert job's key, and the lock its waits and its conversion take: file, converter, version, settings. */
export const conversionKey = (target: ConversionTarget) =>
  `${target.sha256}:${target.converter}:${target.version}:${settingsHash(target.settings)}`;

export interface StoredConversions {
  /**
   * The conversion a document reads: of the first accepted converter the file has one from, the
   * newest with that converter's derivation (ADR 0042, "Which conversion a document reads"). A
   * conversion with pages comes before any refusal, so a Docling refusal never hides a text layer.
   */
  find(
    sha256: string,
    accepted: readonly AcceptedConverter[],
  ): Promise<StoredConversion | undefined>;
  /**
   * The files of a record that a converter reads and that have no stored conversion from an
   * accepted converter, inside the transaction that wrote the record.
   */
  missing(
    transaction: RecordTransaction,
    record: string,
    accepted: readonly AcceptedConverter[],
  ): Promise<{ name: string; sha256: string }[]>;
  /**
   * Makes a record wait on a file's conversion, under the transaction lock its conversion takes
   * when it finishes. False when the conversion is already stored: then nothing waits. When the
   * record waits, `send` sends the convert job in the same transaction. Without a transaction,
   * one is opened.
   */
  wait(
    target: ConversionTarget,
    waiter: ConversionWaiter,
    send: (transaction: RecordTransaction) => Promise<unknown>,
    transaction?: RecordTransaction,
  ): Promise<boolean>;
  /**
   * Stores a conversion under the same lock, ends every wait on its file and converter, and calls
   * `send` in that transaction for each waiting record that waits on nothing else. A record whose
   * index job could not be sent, since one is still queued or running (`send` answered null), keeps
   * its wait and is answered as `busy`: the convert job is tried again.
   */
  store(
    conversion: StoredConversion,
    send: (waiter: ConversionWaiter, transaction: RecordTransaction) => Promise<unknown>,
  ): Promise<{ sent: ConversionWaiter[]; busy: ConversionWaiter[] }>;
  /**
   * Ends a record's waits, inside the transaction that writes it, so a wait on a file the record no
   * longer holds, or on a conversion that ended as a dead letter, does not hold its index job back.
   */
  clear(transaction: RecordTransaction, dataset: string, record: string): Promise<void>;
  /** The records waiting on a file's conversion, with their runs and organisations. */
  waiting(
    target: ConversionTarget,
  ): Promise<{ run: string; tenant: string; dataset: string; record: string }[]>;
  /** The convert keys a run's records wait on. */
  waitKeys(run: string): Promise<string[]>;
  /** The files a run's records wait on, each with when its first record began waiting. */
  waitsSince(run: string): Promise<{ sha256: string; since: Date }[]>;
  /**
   * Ends a cancelled run's waits under each key's lock, and in that transaction calls `act` with
   * the convert keys no record waits on any more and, for each key another run still waits on, one
   * of those runs, so the conversion can be cancelled or handed over before anyone waits again.
   */
  release(
    run: string,
    act: (
      transaction: RecordTransaction,
      freed: string[],
      kept: ({ key: string } & ConversionWaiter)[],
    ) => Promise<unknown>,
  ): Promise<void>;
  /**
   * Which of these files already have a stored conversion with this converter, version, settings
   * hash and derivation.
   */
  storedAmong(
    key: { converter: string; version: string; settingsHash: string; derivation: Derivation },
    sha256s: readonly string[],
  ): Promise<Set<string>>;
  /** Every convert key some record waits on. */
  waitedKeys(): Promise<string[]>;
  /**
   * A pipeline's records in a dataset after record number `after`, at most `limit`, whose files have a
   * conversion with pages only from accepted converters that are replaced, and no conversion from
   * a kept one, refusals included: what a replacement run converts again (ADR 0042, "Conversion").
   * Only stored records and those skipped as `no_text`, in record order.
   */
  replaceable(
    dataset: string,
    pipeline: string,
    accepted: readonly AcceptedConverter[],
    after: string,
    limit: number,
  ): Promise<{ record: string; files: { name: string; sha256: string }[] }[]>;
  /**
   * A pipeline's records in a dataset after record number `after`, at most `limit`, with files whose
   * conversions by kept converters all end in empty pages for more than 5 % of their pages, and that
   * have no conversion by a converter that is replaced: what a replacement run fills from the text
   * layer and converts with Docling again (issue 749). The KUDOS export stopped Docling at 900 s, and
   * the seed stored the pages after that empty. Only stored records and those skipped as `no_text`,
   * in record order.
   */
  short(
    dataset: string,
    pipeline: string,
    accepted: readonly AcceptedConverter[],
    after: string,
    limit: number,
  ): Promise<{ record: string; files: { name: string; sha256: string }[] }[]>;
  /**
   * The records of a pipeline in a dataset, stored or skipped as `no_text`, that hold a file and wait
   * on no conversion: the documents a replacement's new conversion is indexed for, beside those
   * whose wait it ended.
   */
  holding(dataset: string, pipeline: string, sha256: string): Promise<string[]>;
}
