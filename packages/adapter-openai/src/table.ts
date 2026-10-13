import type { Part } from '@genai/contracts';
import { openable } from './sources.js';

export const TABLE_MIME = 'application/vnd.genai.table+json';

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

export const tableMarker = (parts: Part[]): { table?: unknown; csv?: string } => {
  const table = parts.find((p) => p.mime === TABLE_MIME && p.body.kind === 'json');
  const csv = parts.find((p) => p.mime === 'text/csv' && p.body.kind === 'text');
  if (table?.body.kind !== 'json' || !isRecord(table.body.json)) return {};
  return {
    table: withSourceAliases(table.body.json),
    ...(csv?.body.kind === 'text' ? { csv: csv.body.text } : {}),
  };
};

const cellSource = (source: unknown) => {
  if (!isRecord(source)) return source;
  const { url, ...rest } = source;
  const link = typeof url === 'string' ? openable(url) : undefined;
  return {
    ...rest,
    ...(link === undefined ? {} : { url: link }),
    ...(typeof source.chunkId === 'string' ? { chunk_id: source.chunkId } : {}),
    ...(typeof source.document === 'string' ? { document_id: source.document } : {}),
    ...(typeof source.publishedAt === 'string' ? { published_at: source.publishedAt } : {}),
  };
};

const withSourceAliases = (table: Record<string, unknown>) => ({
  ...table,
  ...(Array.isArray(table.rows)
    ? {
        rows: table.rows.map((row) =>
          isRecord(row) && isRecord(row.cells)
            ? {
                ...row,
                cells: Object.fromEntries(
                  Object.entries(row.cells).map(([key, cell]) => [
                    key,
                    isRecord(cell) && Array.isArray(cell.sources)
                      ? { ...cell, sources: cell.sources.map(cellSource) }
                      : cell,
                  ]),
                ),
              }
            : row,
        ),
      }
    : {}),
});
