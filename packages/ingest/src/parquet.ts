import { z } from 'zod';
import type { Chunk } from './chunk-document.js';
import { documentId } from './ids.js';
import type { IngestSource } from './pipeline.js';

export const parquetColumn = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/, 'must be a plain column name');

const fieldName = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,62}$/, 'must be a lower-case field name with letters, digits and _');

const reservedFields = new Set([
  'id',
  'doc_num',
  'title',
  'url',
  'path',
  'lastmod',
  'type',
  'year',
  'source_origin',
  'source_id',
  'total_chunks',
]);

const metadataField = z.union([
  parquetColumn,
  z.strictObject({ column: parquetColumn, as: fieldName }),
]);

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

export const parquetOperators = ['eq', 'neq', 'in', 'not_in', 'is_null', 'not_null'] as const;

export const parquetCondition = z
  .strictObject({
    column: parquetColumn,
    op: z.enum(parquetOperators),
    value: z.union([scalar, z.array(scalar).min(1).max(100)]).optional(),
  })
  .superRefine((c, ctx) => {
    const list = c.op === 'in' || c.op === 'not_in';
    const none = c.op === 'is_null' || c.op === 'not_null';
    if (none && c.value !== undefined)
      ctx.addIssue({ code: 'custom', path: ['value'], message: `${c.op} takes no value` });
    if (list && !Array.isArray(c.value))
      ctx.addIssue({ code: 'custom', path: ['value'], message: `${c.op} needs a list of values` });
    if (!list && !none && (c.value === undefined || Array.isArray(c.value)))
      ctx.addIssue({ code: 'custom', path: ['value'], message: `${c.op} needs a single value` });
  });

export const parquetMapping = z
  .strictObject({
    fields: z.strictObject({
      id: parquetColumn,
      title: parquetColumn,
      text: z.array(parquetColumn).min(1).max(20),
      url: parquetColumn.optional(),
      date: parquetColumn.optional(),
      year: parquetColumn
        .optional()
        .describe(
          'A date or year column; its first four digits are stored as the number field year',
        ),
      metadata: z.array(metadataField).max(30).default([]),
      constants: z.record(fieldName, z.string().min(1).max(200)).default({}),
    }),
    filter: z.array(parquetCondition).max(20).default([]),
    maxRows: z.number().int().min(1).max(200_000).default(50_000),
  })
  .superRefine((m, ctx) => {
    const names = [
      ...m.fields.metadata.map((f) => (typeof f === 'string' ? f : f.as)),
      ...Object.keys(m.fields.constants),
    ];
    const seen = new Set<string>();
    for (const name of names) {
      if (reservedFields.has(name))
        ctx.addIssue({
          code: 'custom',
          path: ['fields'],
          message: `${name} is set by the source; store it under another name with as`,
        });
      if (seen.has(name))
        ctx.addIssue({ code: 'custom', path: ['fields'], message: `${name} is stored twice` });
      seen.add(name);
    }
  });

export const huggingFaceFile = z.strictObject({
  dataset: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'must be owner/name'),
  file: z
    .string()
    .regex(/^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*\.parquet$/, 'must be a .parquet path'),
  revision: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
    .default('main'),
});

export type ParquetCondition = z.infer<typeof parquetCondition>;
export type ParquetMapping = z.infer<typeof parquetMapping>;
export type HuggingFaceFile = z.infer<typeof huggingFaceFile>;

export const huggingFaceFileUrl = (file: HuggingFaceFile) =>
  `https://huggingface.co/datasets/${file.dataset}/resolve/${encodeURIComponent(file.revision)}/${file.file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

export const huggingFaceOrigin = (file: Pick<HuggingFaceFile, 'dataset' | 'file'>) =>
  `hf://datasets/${file.dataset}/${file.file}`;

export interface ParquetReader {
  columns(bytes: Uint8Array): Promise<string[]>;
  rows(
    bytes: Uint8Array,
    columns: string[],
    maxRows: number,
  ): AsyncIterable<Record<string, unknown>>;
}

const columnOf = (field: ParquetMapping['fields']['metadata'][number]) =>
  typeof field === 'string' ? field : field.column;

export const parquetColumns = (mapping: ParquetMapping) => {
  const { id, title, text, url, date, year, metadata } = mapping.fields;
  return [
    ...new Set([
      id,
      title,
      ...text,
      ...(url ? [url] : []),
      ...(date ? [date] : []),
      ...(year ? [year] : []),
      ...metadata.map(columnOf),
      ...mapping.filter.map((c) => c.column),
    ]),
  ];
};

export const missingColumns = (mapping: ParquetMapping, known: string[]) => {
  const present = new Set(known);
  return parquetColumns(mapping).filter((c) => !present.has(c));
};

const plain = (value: unknown): unknown => {
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isSafeInteger(n) ? n : value.toString();
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(plain).filter((v) => v !== null && v !== undefined);
  return value;
};

const textOf = (value: unknown): string => {
  const v = plain(value);
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
};

const matches = (row: Record<string, unknown>, c: ParquetCondition) => {
  const value = plain(row[c.column]);
  const values = Array.isArray(value) ? value : [value];
  const empty = value === null || value === undefined || values.length === 0;
  const wanted = Array.isArray(c.value) ? c.value : c.value === undefined ? [] : [c.value];
  const hit = values.some((v) => wanted.some((w) => v === w || String(v) === String(w)));
  switch (c.op) {
    case 'is_null':
      return empty;
    case 'not_null':
      return !empty;
    case 'eq':
    case 'in':
      return hit;
    case 'neq':
    case 'not_in':
      return !hit;
  }
};

export const parquetRowMatches = (filter: ParquetCondition[]) => (row: Record<string, unknown>) =>
  filter.every((c) => matches(row, c));

const yearOf = (value: unknown) => {
  const found = /^(\d{4})/.exec(textOf(value).trim());
  return found ? Number(found[1]) : undefined;
};

const label = (name: string) => {
  const words = name.replace(/[_.-]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
};

const metadataOf = (row: Record<string, unknown>, mapping: ParquetMapping) =>
  mapping.fields.metadata.flatMap((field) => {
    const value = plain(row[columnOf(field)]);
    if (value === null || value === undefined || (Array.isArray(value) && value.length === 0))
      return [];
    return [[typeof field === 'string' ? field : field.as, value] as const];
  });

export interface ParquetSourceOptions {
  rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>;
  mapping: ParquetMapping;
  origin: string;
}

export const parquetSource = (options: ParquetSourceOptions): IngestSource => ({
  kind: 'parquet',
  phraseRows: 'pipeline',
  documents: async function* () {
    const { fields, filter } = options.mapping;
    const keep = parquetRowMatches(filter);
    const seen = new Set<string>();
    for await (const row of options.rows) {
      if (!keep(row)) continue;
      const sourceId = textOf(row[fields.id]).trim();
      if (sourceId === '') continue;
      const id = documentId(`${options.origin}#${sourceId}`);
      if (seen.has(id)) continue;
      seen.add(id);
      const title = textOf(row[fields.title]).trim() || sourceId;
      const body = fields.text
        .map((column) => textOf(row[column]).trim())
        .filter((t) => t !== '')
        .join('\n\n');
      const url = fields.url ? textOf(row[fields.url]).trim() : '';
      const date = fields.date ? textOf(row[fields.date]).trim() : '';
      const year = fields.year ? yearOf(row[fields.year]) : undefined;
      const metadata = metadataOf(row, options.mapping);
      const lines = [
        ...metadata.map(([name, value]) => `- ${label(name)}: ${textOf(value)}`),
        ...(url ? [`- Source: ${url}`] : []),
      ];
      const markdown = [`**${title}**`, '', ...(body ? [body, ''] : []), ...lines].join('\n');
      const name = `${options.origin}#${sourceId}`;
      yield {
        key: id,
        docNum: id,
        name,
        ...(body === '' ? { skip: 'no_text' as const } : {}),
        texts: [markdown],
        ...(url ? { url, location: { key: 'url' as const, value: url } } : {}),
        stored: (chunks: Chunk[]) => ({
          ...Object.fromEntries(metadata),
          ...fields.constants,
          id,
          doc_num: id,
          title,
          path: name,
          url: url || null,
          ...(date ? { lastmod: date } : {}),
          ...(year === undefined ? {} : { year }),
          type: 'parquet',
          source_origin: options.origin,
          source_id: sourceId,
          total_chunks: chunks.length,
        }),
        storedChunks: (chunks: Chunk[]) =>
          chunks.map((c) => ({
            id: c.chunk_id,
            chunk_id: c.chunk_id,
            doc_num: c.doc_num,
            chunk_index: c.chunk_index,
            content_markdown: c.content_markdown,
            content_length: c.content_length,
            metadata: c.metadata,
            path: name,
          })),
      };
    }
  },
});
