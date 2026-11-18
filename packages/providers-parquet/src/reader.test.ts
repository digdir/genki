import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  parquetColumns,
  parquetMapping,
  parquetSource,
  runIngest,
  type IndexSink,
} from '@genai/ingest';
import { parquetReader, ParquetReadError } from './reader.js';

const fixture = new Uint8Array(
  readFileSync(join(import.meta.dirname, 'fixtures', 'definitions.parquet')),
);

const collect = async <T>(items: AsyncIterable<T>) => {
  const out: T[] = [];
  for await (const item of items) out.push(item);
  return out;
};

describe('Parquet reader', () => {
  it('lists the columns of a Parquet file', async () => {
    expect(await parquetReader().columns(fixture)).toEqual(
      expect.arrayContaining(['id', 'record_id', 'term', 'definition', 'locator']),
    );
  });

  it('reads the asked columns of a ZSTD-compressed file, with nulls as null', async () => {
    const rows = await collect(parquetReader().rows(fixture, ['id', 'term', 'english'], 100));

    expect(rows).toHaveLength(26);
    expect(rows[0]).toEqual({
      id: 'D0001',
      term: 'automated decision system',
      english: null,
    });
  });

  it('stops after maxRows', async () => {
    expect(await collect(parquetReader().rows(fixture, ['id'], 5))).toHaveLength(5);
  });

  it('refuses bytes that are not a Parquet file with ParquetReadError', async () => {
    await expect(
      parquetReader().columns(new TextEncoder().encode('id,title\n1,a\n')),
    ).rejects.toBeInstanceOf(ParquetReadError);
  });

  it('ingests every row of a real file end to end, one document per defined term', async () => {
    const mapping = parquetMapping.parse({
      fields: {
        id: 'id',
        title: 'term',
        text: ['definition', 'english'],
        metadata: ['record_id', 'term', 'locator'],
        constants: { doc_kind: 'definition' },
      },
    });
    const stored: Record<string, unknown>[] = [];
    const sink: IndexSink = {
      ensureCollections: async () => undefined,
      storeDocument: async (_names, _docNum, doc) => void stored.push(doc),
    };

    const result = await runIngest({
      source: parquetSource({
        rows: parquetReader().rows(fixture, parquetColumns(mapping), mapping.maxRows),
        mapping,
        origin: 'hf://datasets/kelkalot/every-ai-policy-ever/data/definitions.parquet',
      }),
      chunking: {
        strategy: { kind: 'header-based' },
        minimumLength: 1,
        maximumLength: 4000,
        metadataStyle: 'pr',
      },
      collections: { docs: 'd', chunks: 'c', phrases: 'p' },
      sink,
      done: new Set(),
    });

    expect(result).toMatchObject({ stored: 26, failed: [] });
    expect(stored[0]).toMatchObject({
      title: 'automated decision system',
      record_id: 'CA-01',
      doc_kind: 'definition',
      type: 'parquet',
    });
  });
});

describe('Parquet byte ranges and row groups', () => {
  it('reads file ranges lazily and never decodes the next row group before it is requested', async () => {
    const bytes = readFileSync(join(import.meta.dirname, 'fixtures', 'row-groups.parquet'));
    const ranges: [number, number][] = [];
    const file = {
      byteLength: bytes.byteLength,
      slice: async (start: number, end = bytes.byteLength) => {
        ranges.push([start, end]);
        return Uint8Array.from(bytes.subarray(start, end)).buffer;
      },
    };
    const iterator = parquetReader().rows(file, ['id', 'body'], 2)[Symbol.asyncIterator]();
    expect(ranges).toEqual([]);
    const first = await iterator.next();
    expect(first.value).toEqual({ id: 'a', body: 'a'.repeat(600_000) });
    const before = ranges.length;
    expect(ranges.every(([start, end]) => end - start < bytes.byteLength)).toBe(true);
    const second = await iterator.next();
    expect(second.value).toEqual({ id: 'b', body: 'b'.repeat(600_000) });
    expect(ranges.length).toBeGreaterThan(before);
    expect((await iterator.next()).done).toBe(true);
  });
});

describe('Parquet decompression limits', () => {
  it('refuses a page that declares more uncompressed bytes than the page limit', async () => {
    await expect(
      collect(parquetReader({ maxPageBytes: 16 }).rows(fixture, ['id', 'definition'], 100)),
    ).rejects.toThrow(/page declares .* over the .* limit/);
  });

  it('refuses a row group that declares more bytes than the row-group limit, before decoding it', async () => {
    const bytes = new Uint8Array(
      readFileSync(join(import.meta.dirname, 'fixtures', 'row-groups.parquet')),
    );
    await expect(
      collect(parquetReader({ maxRowGroupBytes: 1024 }).rows(bytes, ['id', 'body'], 10)),
    ).rejects.toBeInstanceOf(ParquetReadError);
  });
});
