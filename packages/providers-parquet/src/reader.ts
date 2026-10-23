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

const metadataOf = async (file: ParquetFile) => {
  try {
    return await parquetMetadataAsync(file);
  } catch (error) {
    throw new ParquetReadError(
      `The file is not a readable Parquet file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const parquetReader = (): ParquetReader => ({
  columns: async (bytes) =>
    parquetSchema(await metadataOf(bufferOf(bytes))).children.map((c) => c.element.name),
  rows: async function* (bytes, columns, maxRows) {
    const file = bufferOf(bytes);
    const metadata = await metadataOf(file);
    let rowStart = 0;
    // Decode a single row group at a time. A fixed row step can decode the same
    // large group repeatedly, and an unbounded read loads every group together.
    for (const group of metadata.row_groups) {
      if (rowStart >= maxRows) break;
      const rowEnd = rowStart + Number(group.num_rows);
      const rows = await parquetReadObjects({
        file,
        metadata,
        columns,
        compressors,
        rowStart,
        rowEnd: Math.min(maxRows, rowEnd),
      });
      for (const row of rows) yield row as Record<string, unknown>;
      rowStart = rowEnd;
    }
  },
});
