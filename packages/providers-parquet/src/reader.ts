import type { ParquetReader } from '@genai/ingest';
import { parquetMetadata, parquetReadObjects, parquetSchema } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';

const bufferOf = (bytes: Uint8Array): ArrayBuffer =>
  bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);

export class ParquetReadError extends Error {
  override readonly name = 'ParquetReadError';
}

const metadataOf = (file: ArrayBuffer) => {
  try {
    return parquetMetadata(file);
  } catch (error) {
    throw new ParquetReadError(
      `The file is not a readable Parquet file: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
};

export const parquetReader = (): ParquetReader => ({
  columns: async (bytes) =>
    parquetSchema(metadataOf(bufferOf(bytes))).children.map((c) => c.element.name),
  rows: async function* (bytes, columns, maxRows) {
    const file = bufferOf(bytes);
    const total = Number(metadataOf(file).num_rows);
    const rowEnd = Math.min(total, maxRows);
    const step = 5000;
    for (let rowStart = 0; rowStart < rowEnd; rowStart += step) {
      const rows = await parquetReadObjects({
        file,
        columns,
        compressors,
        rowStart,
        rowEnd: Math.min(rowEnd, rowStart + step),
      });
      for (const row of rows) yield row as Record<string, unknown>;
    }
  },
});
