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

/** A converter a pipeline accepts, with the derivation its documents read. */
export interface AcceptedConverter {
  converter: string;
  derivation: Derivation;
}

/** The text layer: the only accepted converter until Docling (issues 474 and 477). */
export const textLayerDerivation: Derivation = { name: 'text-layer', version: 1 };
export const acceptedTextLayer: AcceptedConverter[] = [
  { converter: 'text-layer', derivation: textLayerDerivation },
];

export interface StoredConversion extends ConverterKey {
  sha256: string;
  derivation: Derivation;
  pages: string[];
  /** Where the converter's native output lies in the Blob container, when it has one. */
  outputPath?: string;
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
   * newest with that converter's derivation (ADR 0042, "Which conversion a document reads").
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
   * `send` in that transaction for each waiting record that waits on nothing else.
   */
  store(
    conversion: StoredConversion,
    send: (waiter: ConversionWaiter, transaction: RecordTransaction) => Promise<unknown>,
  ): Promise<ConversionWaiter[]>;
  /** The runs and organisations with a record waiting on a file's conversion. */
  waiting(target: ConversionTarget): Promise<{ run: string; tenant: string }[]>;
  /** The convert keys a run's records wait on. */
  waitKeys(run: string): Promise<string[]>;
  /** Ends a cancelled run's waits; answers the convert keys no record waits on any more. */
  release(run: string): Promise<string[]>;
  /** Every convert key some record waits on. */
  waitedKeys(): Promise<string[]>;
}
