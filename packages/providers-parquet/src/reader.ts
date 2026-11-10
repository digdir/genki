import type { ParquetFile, ParquetReader } from '@genai/ingest';
import { parquetMetadataAsync, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const bufferOf = (bytes: Uint8Array | ParquetFile): ParquetFile => {
  if (!(bytes instanceof Uint8Array)) return bytes;
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
};

export class ParquetReadError extends Error {
  override readonly name = 'ParquetReadError';
}

export interface ParquetReaderLimits {
  maxPageBytes?: number;
  maxRowGroupBytes?: number;
}

export const defaultParquetReaderLimits = {
  maxPageBytes: 64 * 1024 * 1024,
  maxRowGroupBytes: 128 * 1024 * 1024,
} as const;

const metadataOf = async (file: ParquetFile) => {
  try {
    return await parquetMetadataAsync(file);
  } catch (error) {
    throw new ParquetReadError(
      `The file is not a readable Parquet file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

const megabytes = (bytes: number) => `${Math.round(bytes / (1024 * 1024))} MB`;

const boundedCompressors = (
  limits: Required<ParquetReaderLimits>,
  budget: { used: number },
): typeof compressors =>
  Object.fromEntries(
    Object.entries(compressors).map(([codec, decompress]) => [
      codec,
      (input: Uint8Array, outputLength: number) => {
        if (outputLength > limits.maxPageBytes)
          throw new ParquetReadError(
            `A Parquet page declares ${megabytes(outputLength)} uncompressed, over the ${megabytes(limits.maxPageBytes)} limit`,
          );
        budget.used += outputLength;
        if (budget.used > limits.maxRowGroupBytes)
          throw new ParquetReadError(
            `A Parquet row group decompresses to more than the ${megabytes(limits.maxRowGroupBytes)} limit`,
          );
        return decompress(input, outputLength);
      },
    ]),
  );

export const parquetReader = (options: ParquetReaderLimits = {}): ParquetReader => {
  const limits = { ...defaultParquetReaderLimits, ...options };
  return {
    columns: async (bytes) =>
      parquetSchema(await metadataOf(bufferOf(bytes))).children.map((c) => c.element.name),
    rows: async function* (bytes, columns, maxRows) {
      const file = bufferOf(bytes);
      const metadata = await metadataOf(file);
      const budget = { used: 0 };
      const bounded = boundedCompressors(limits, budget);
      let rowStart = 0;
      // Decode a single row group at a time. A fixed row step can decode the same
      // large group repeatedly, and an unbounded read loads every group together.
      for (const group of metadata.row_groups) {
        if (rowStart >= maxRows) break;
        if (Number(group.total_byte_size) > limits.maxRowGroupBytes)
          throw new ParquetReadError(
            `A Parquet row group declares ${megabytes(Number(group.total_byte_size))}, over the ${megabytes(limits.maxRowGroupBytes)} limit`,
          );
        budget.used = 0;
        const rowEnd = rowStart + Number(group.num_rows);
        const rows = await parquetReadObjects({
          file,
          metadata,
          columns,
          compressors: bounded,
          rowStart,
          rowEnd: Math.min(maxRows, rowEnd),
        });
        for (const row of rows) yield row as Record<string, unknown>;
        rowStart = rowEnd;
      }
    },
  };
};
