export interface TableSource {
  chunkId?: string;
  document?: string;
  title?: string;
  url?: string;
  excerpt?: string;
  page?: number;
  headers?: string[];
  version?: string;
  publishedAt?: string;
}

export interface TableColumn {
  key: string;
  label: string;
  kind?: 'document' | 'assessment';
  values?: string[];
}

export interface ResultTable {
  title?: string;
  columns: TableColumn[];
  rows: { document?: string; cells: Record<string, { value: unknown; sources: TableSource[] }> }[];
  skipped: { index: number; document?: TableSource; error?: string; code?: string }[];
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

const sourceFrom = (v: unknown): TableSource =>
  isRecord(v)
    ? {
        ...(str(v.chunkId) ? { chunkId: str(v.chunkId) as string } : {}),
        ...(str(v.document) ? { document: str(v.document) as string } : {}),
        ...(str(v.title) ? { title: str(v.title) as string } : {}),
        ...(str(v.url) && /^https?:\/\//.test(str(v.url) as string)
          ? { url: str(v.url) as string }
          : {}),
        ...(str(v.excerpt) ? { excerpt: str(v.excerpt) as string } : {}),
        ...(typeof v.page === 'number' ? { page: v.page } : {}),
        ...(Array.isArray(v.headers) && v.headers.some((h) => typeof h === 'string')
          ? { headers: v.headers.filter((h): h is string => typeof h === 'string') }
          : {}),
        ...(typeof v.version === 'string' || typeof v.version === 'number'
          ? { version: String(v.version) }
          : {}),
        ...(str(v.published_at ?? v.publishedAt)
          ? { publishedAt: str(v.published_at ?? v.publishedAt) as string }
          : {}),
      }
    : {};

export const tableFrom = (value: unknown): ResultTable | undefined => {
  if (!isRecord(value) || !Array.isArray(value.columns) || !Array.isArray(value.rows))
    return undefined;
  return {
    ...(str(value.title) ? { title: str(value.title) as string } : {}),
    columns: value.columns.filter(isRecord).map((c) => ({
      key: String(c.key ?? ''),
      label: String(c.label ?? c.name ?? c.key ?? ''),
      ...(c.kind === 'document' || c.kind === 'assessment' ? { kind: c.kind } : {}),
      ...(Array.isArray(c.values) ? { values: c.values.map(String) } : {}),
    })),
    rows: value.rows.filter(isRecord).map((row) => ({
      ...(str(row.document) ? { document: str(row.document) as string } : {}),
      cells: Object.fromEntries(
        Object.entries(isRecord(row.cells) ? row.cells : {}).map(([key, cell]) => [
          key,
          {
            value: isRecord(cell) ? cell.value : cell,
            sources:
              isRecord(cell) && Array.isArray(cell.sources) ? cell.sources.map(sourceFrom) : [],
          },
        ]),
      ),
    })),
    skipped: (Array.isArray(value.skipped) ? value.skipped : []).filter(isRecord).map((s) => ({
      index: typeof s.index === 'number' ? s.index : 0,
      ...(isRecord(s.document) ? { document: sourceFrom(s.document) } : {}),
      ...(str(s.error) ? { error: str(s.error) as string } : {}),
      ...(str(s.code) ? { code: str(s.code) as string } : {}),
    })),
  };
};

export const cellText = (value: unknown) =>
  value === null || value === undefined
    ? ''
    : typeof value === 'string'
      ? value
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : JSON.stringify(value);

export const sourceKey = (s: TableSource) => s.chunkId ?? s.document ?? s.url ?? s.title ?? '';
export const sourceName = (s: TableSource, fallback: string) =>
  s.title ?? s.document ?? s.chunkId ?? fallback;
