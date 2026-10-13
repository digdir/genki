import { z } from 'zod';
import type { Block } from '../blocks.js';
import type { FlowChunk, FlowDocument } from '../services.js';

export const TABLE_MIME = 'application/vnd.genai.table+json';

export interface CellSource {
  chunkId?: string;
  document?: string;
  title?: string;
  url?: string;
  position?: number;
  excerpt?: string;
  headers?: string[];
  version?: string;
  publishedAt?: string;
}

export interface TableCell {
  value: unknown;
  sources: CellSource[];
}

export interface FlowTable {
  kind: 'table';
  title?: string;
  columns: { key: string; label: string }[];
  rows: { document?: string; cells: Record<string, TableCell> }[];
  skipped: { index: number; document?: CellSource; error?: string; code?: string }[];
}

const optional = <K extends string, V>(key: K, value: V | undefined) =>
  (value === undefined ? {} : { [key]: value }) as Partial<Record<K, V>>;

const excerptLength = 800;

const excerptOf = (content: string | undefined) => {
  const text = content?.replace(/\s+/g, ' ').trim();
  if (!text) return undefined;
  return text.length > excerptLength ? `${text.slice(0, excerptLength).trimEnd()} …` : text;
};

export const chunkSource = (chunk: FlowChunk): CellSource => ({
  chunkId: chunk.chunkId,
  ...optional('document', chunk.document),
  ...optional('title', chunk.title),
  ...optional('url', chunk.url),
  ...optional('position', chunk.position),
  ...optional('excerpt', excerptOf(chunk.content)),
  ...(chunk.headers?.length ? { headers: chunk.headers } : {}),
  ...optional('version', chunk.version),
  ...optional('publishedAt', chunk.publishedAt),
});

const documentSource = (doc: FlowDocument): CellSource => ({
  document: doc.id,
  ...optional('title', doc.title),
  ...optional('url', doc.url),
  ...optional('publishedAt', doc.publishedAt),
});

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const walk = (value: unknown, path: string): unknown =>
  path
    .split('.')
    .filter(Boolean)
    .reduce<unknown>(
      (current, key) =>
        Array.isArray(current) && /^\d+$/.test(key)
          ? current[Number(key)]
          : isRecord(current)
            ? current[key]
            : undefined,
      value,
    );

const citedAt = (citations: unknown, path: string): CellSource[] => {
  if (!isRecord(citations)) return [];
  const found = Object.entries(citations)
    .filter(([key]) => key === path || key.startsWith(`${path}.`))
    .flatMap(([, list]) => (Array.isArray(list) ? (list as CellSource[]) : []));
  const seen = new Set<string>();
  return found.filter((s) => {
    const id = s.chunkId ?? s.document ?? '';
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
};

const words = (text: unknown) =>
  new Set(
    String(text ?? '')
      .toLowerCase()
      .replace(/\bmål\s*\d+[.:]?/g, ' ')
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3),
  );

const similarity = (a: unknown, b: unknown) => {
  const left = words(a);
  const right = words(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const w of left) if (right.has(w)) shared += 1;
  return (2 * shared) / (left.size + right.size);
};

const present = (cell: TableCell | undefined) =>
  cell !== undefined && cell.value !== null && cell.value !== undefined && cell.value !== '';

const fieldOf = (doc: FlowDocument | undefined, field: string) =>
  String(isRecord(doc?.fields) ? (doc.fields[field] ?? '') : '');

const matchesField = (doc: FlowDocument | undefined, f: { field: string; value: string }) =>
  fieldOf(doc, f.field).toLowerCase() === f.value.toLowerCase();

export const pairReportedRows = (
  table: FlowTable,
  documents: FlowDocument[],
  pair: PairParams,
): FlowTable => {
  const byId = new Map(documents.map((d) => [d.id, d]));
  const docOf = (row: FlowTable['rows'][number]) =>
    row.document ? byId.get(row.document) : undefined;
  const groupOf = (row: FlowTable['rows'][number]) =>
    pair.group.map((field) => fieldOf(docOf(row), field)).join('\u0000');
  const fill =
    pair.fill ?? table.columns.map((c) => c.key).filter((k) => k !== pair.key && k !== 'document');
  const candidates: { primary: number; reported: number; score: number }[] = [];
  table.rows.forEach((primary, i) => {
    if (!matchesField(docOf(primary), pair.primary)) return;
    table.rows.forEach((reported, j) => {
      if (!matchesField(docOf(reported), pair.reported) || groupOf(reported) !== groupOf(primary))
        return;
      const score = similarity(primary.cells[pair.key]?.value, reported.cells[pair.key]?.value);
      if (score >= pair.threshold) candidates.push({ primary: i, reported: j, score });
    });
  });
  candidates.sort((a, b) => b.score - a.score || a.primary - b.primary || a.reported - b.reported);
  const usedPrimary = new Set<number>();
  const merged = new Set<number>();
  const rows = table.rows.map((row) => ({ ...row, cells: { ...row.cells } }));
  for (const c of candidates) {
    if (usedPrimary.has(c.primary) || merged.has(c.reported)) continue;
    usedPrimary.add(c.primary);
    merged.add(c.reported);
    const target = rows[c.primary] as (typeof rows)[number];
    const source = table.rows[c.reported] as (typeof rows)[number];
    for (const key of fill) {
      const cell = source.cells[key];
      if (cell && present(cell) && !present(target.cells[key])) target.cells[key] = cell;
    }
  }
  return { ...table, rows: rows.filter((_, i) => !merged.has(i)) };
};

const skippedItem = (item: unknown) =>
  item === null || item === undefined || (isRecord(item) && item.skipped === true);

const tableInput = z.looseObject({
  items: z.array(z.unknown()),
  documents: z.array(z.looseObject({ id: z.string() })).optional(),
});
const fieldIs = z.strictObject({ field: z.string().min(1), value: z.string().min(1) });

const pairParams = z.strictObject({
  primary: fieldIs,
  reported: fieldIs,
  key: z.string().min(1),
  fill: z.array(z.string().min(1)).min(1).optional(),
  group: z.array(z.string().min(1)).default([]),
  threshold: z.number().min(0).max(1).default(0.35),
});

export type PairParams = z.infer<typeof pairParams>;

const tableParams = z.strictObject({
  title: z.string().min(1).optional(),
  rows: z.string().min(1).optional(),
  pair: pairParams.optional(),
  columns: z
    .array(
      z.strictObject({
        key: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
        label: z.string().min(1),
        from: z.string().min(1),
      }),
    )
    .min(1),
});

const cellSchema = z.strictObject({ value: z.unknown(), sources: z.array(z.looseObject({})) });

export const tableBlock: Block<z.infer<typeof tableInput>, z.infer<typeof tableParams>> = {
  name: 'table',
  version: '1',
  description: 'Assemble loop results into a table where every cell carries its sources',
  input: tableInput,
  params: tableParams,
  output: z.strictObject({
    kind: z.literal('table'),
    title: z.string().optional(),
    columns: z.array(z.strictObject({ key: z.string(), label: z.string() })),
    rows: z.array(
      z.strictObject({ document: z.string().optional(), cells: z.record(z.string(), cellSchema) }),
    ),
    skipped: z.array(z.looseObject({ index: z.number() })),
  }),
  run: async function* (_ctx, input, params) {
    yield* [];
    const documents = (input.documents ?? []) as FlowDocument[];
    const table: FlowTable = {
      kind: 'table',
      ...optional('title', params.title),
      columns: params.columns.map(({ key, label }) => ({ key, label })),
      rows: [],
      skipped: [],
    };
    input.items.forEach((item, index) => {
      const doc = documents[index];
      if (skippedItem(item)) {
        const error = isRecord(item) && typeof item.error === 'string' ? item.error : undefined;
        table.skipped.push({
          index,
          ...optional('document', doc ? documentSource(doc) : undefined),
          ...optional('error', error),
          ...optional(
            'code',
            isRecord(item) && typeof item.code === 'string' ? item.code : undefined,
          ),
        });
        return;
      }
      const citations = isRecord(item) ? item.citations : undefined;
      const list = params.rows ? walk(item, params.rows) : [item];
      (Array.isArray(list) ? list : []).forEach((row, j) => {
        const cells: Record<string, TableCell> = {};
        for (const column of params.columns) {
          const [head = '', ...rest] = column.from.split('.');
          const tail = rest.join('.');
          if (head === 'document') {
            cells[column.key] = {
              value: doc ? (walk(doc, tail) ?? null) : null,
              sources: doc ? [documentSource(doc)] : [],
            };
          } else if (head === 'item') {
            cells[column.key] = {
              value: walk(item, tail) ?? null,
              sources: citedAt(citations, tail),
            };
          } else {
            const path = params.rows ? `${params.rows}.${j}.${column.from}` : column.from;
            cells[column.key] = {
              value: walk(row, column.from) ?? null,
              sources: citedAt(citations, path),
            };
          }
        }
        table.rows.push({ ...optional('document', doc?.id), cells });
      });
    });
    return params.pair ? pairReportedRows(table, documents, params.pair) : table;
  },
};

export const isTable = (value: unknown): value is FlowTable =>
  isRecord(value) &&
  value.kind === 'table' &&
  Array.isArray(value.columns) &&
  Array.isArray(value.rows);

const csvField = (value: unknown) => {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : JSON.stringify(value);
  return /[",\n\r;]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const sourceText = (s: CellSource) =>
  [s.title ?? s.document ?? '', s.url ?? '', s.chunkId ? `utdrag ${s.chunkId}` : '']
    .filter(Boolean)
    .join(' ');

export const tableCsv = (table: FlowTable): string => {
  const header = table.columns.flatMap((c) => [c.label, `${c.label} (kilde)`]);
  const lines = table.rows.map((row) =>
    table.columns.flatMap((c) => {
      const cell = row.cells[c.key];
      return [cell?.value, (cell?.sources ?? []).map(sourceText).join('; ')];
    }),
  );
  return [header, ...lines].map((line) => line.map(csvField).join(',')).join('\r\n');
};
