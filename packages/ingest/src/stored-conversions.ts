import { createHash } from 'node:crypto';
import type { Conversion, DocumentConverter, DocumentFile } from './converter.js';

/** One converter's output for one file, as stored: the text the chunker reads and the converter's own output. */
export interface StoredConversion {
  sha256: string;
  producer: string;
  version: string;
  settings: unknown;
  markdown: string;
  output: unknown;
}

export interface ConversionStore {
  /** The newest stored conversion of the file with this sha256 by this producer, if any. */
  latest(sha256: string, producer: string): Promise<StoredConversion | undefined>;
  /** Saves a conversion. The same file, producer, version and settings saved again replaces the earlier one. */
  save(conversion: StoredConversion): Promise<void>;
}

export interface StoringConverterOptions {
  store: ConversionStore;
  converter: DocumentConverter;
  /** The converter whose stored results are reused, such as 'marker'. */
  producer: string;
  /** Convert again even when a result is stored, for example after a Marker upgrade. */
  reconvert?: boolean;
}

/**
 * A converter that reuses what is stored: a file whose sha256 has a stored conversion by `producer` is never
 * converted again unless `reconvert` is set. New conversions that carry the producer's raw output are stored.
 */
export const storingConverter = (options: StoringConverterOptions): DocumentConverter => {
  const convert = async (file: DocumentFile): Promise<Conversion> => {
    const sha256 = createHash('sha256').update(file.bytes).digest('hex');
    const stored = options.reconvert
      ? undefined
      : await options.store.latest(sha256, options.producer);
    if (stored) {
      const { markdown, producer, version, settings, output } = stored;
      return { markdown, raw: { producer, version, settings, output } };
    }
    const fresh = options.converter.convert
      ? await options.converter.convert(file)
      : { markdown: await options.converter.toMarkdown(file) };
    if (fresh.raw?.producer === options.producer)
      await options.store.save({ sha256, markdown: fresh.markdown, ...fresh.raw });
    return fresh;
  };
  return {
    ...(options.converter.extensions ? { extensions: options.converter.extensions } : {}),
    convert,
    toMarkdown: async (file) => (await convert(file)).markdown,
  };
};

const settingsKey = (settings: unknown) => JSON.stringify(settings);

/** A conversion store in memory, for tests and runs without a knowledge server. */
export const inMemoryConversionStore = (): ConversionStore & { all(): StoredConversion[] } => {
  const rows = new Map<string, StoredConversion>();
  return {
    latest: async (sha256, producer) =>
      [...rows.values()].filter((r) => r.sha256 === sha256 && r.producer === producer).at(-1),
    save: async (conversion) => {
      const key = [
        conversion.sha256,
        conversion.producer,
        conversion.version,
        settingsKey(conversion.settings),
      ];
      rows.delete(key.join('|'));
      rows.set(key.join('|'), conversion);
    },
    all: () => [...rows.values()],
  };
};
