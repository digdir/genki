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

const parquetFilePath = z
  .string()
  .regex(/^(?!.*\.\.)[A-Za-z0-9_][A-Za-z0-9_./-]*\.parquet$/, 'must be a .parquet path');

const fieldNameOf = (field: z.infer<typeof metadataField>) =>
  typeof field === 'string' ? field : field.as;

export const parquetLookupsMaxMemoryBytes = 256 * 1024 * 1024;

export const parquetLookup = z
  .strictObject({
    file: parquetFilePath
      .optional()
      .describe('A .parquet path in the same Hugging Face dataset, read at the same revision'),
    url: z
      .url({ protocol: /^https$/ })
      .optional()
      .describe('An https URL of the lookup file, for a source that is not on Hugging Face'),
    key: parquetColumn.describe('The column in the lookup file that holds the key'),
    on: parquetColumn.describe('The column in the source whose value is looked up'),
    fields: z
      .array(metadataField)
      .min(1)
      .max(30)
      .describe('Lookup columns stored on each matching document, optionally renamed with as'),
    maxRows: z
      .number()
      .int()
      .min(1)
      .max(1_000_000)
      .default(200_000)
      .describe('The run fails if the lookup file has more rows'),
    maxMemoryBytes: z
      .number()
      .int()
      .min(1024)
      .max(parquetLookupsMaxMemoryBytes)
      .default(64 * 1024 * 1024)
      .describe('Estimated memory cap for the key map; the run fails above it'),
    maxBytes: z
      .number()
      .int()
      .min(1024)
      .max(20 * 1024 * 1024 * 1024)
      .default(1024 * 1024 * 1024)
      .describe('Disk byte cap for the downloaded lookup file'),
  })
  .refine((l) => (l.file === undefined) !== (l.url === undefined), {
    message: 'a lookup needs exactly one of file and url',
    path: ['file'],
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
    lookups: z
      .array(parquetLookup)
      .max(3)
      .default([])
      .describe('Fields joined from other Parquet files on a key column, read once per run'),
  })
  .superRefine((m, ctx) => {
    const names = [
      ...m.fields.metadata.map(fieldNameOf),
      ...Object.keys(m.fields.constants),
      ...m.lookups.flatMap((l) => l.fields.map(fieldNameOf)),
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
    const lookupBytes = m.lookups.reduce((sum, l) => sum + l.maxMemoryBytes, 0);
    if (lookupBytes > parquetLookupsMaxMemoryBytes)
      ctx.addIssue({
        code: 'custom',
        path: ['lookups'],
        message: `the lookups' maxMemoryBytes add up to more than ${parquetLookupsMaxMemoryBytes} bytes`,
      });
  });

export const huggingFaceFile = z.strictObject({
  dataset: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/, 'must be owner/name'),
  file: parquetFilePath,
  revision: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
    .default('main'),
});

const parquetPath = huggingFaceFile.shape.file;
const tableName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const parquetTableName = tableName;
export const huggingFaceShards = z.strictObject({
  dataset: huggingFaceFile.shape.dataset,
  revision: huggingFaceFile.shape.revision,
  table: tableName.describe('Stable logical table name, shared by all shards and revisions'),
  files: z.union([
    z
      .string()
      .max(500)
      .regex(/^(?!.*\.\.)[A-Za-z0-9_*?][A-Za-z0-9_./*?-]*\.parquet$/, 'must be a .parquet glob'),
    z.array(parquetPath).min(1).max(1000),
  ]),
});
export const huggingFaceSource = z.union([huggingFaceFile, huggingFaceShards]);
export type HuggingFaceSource = z.infer<typeof huggingFaceSource>;

export type ParquetCondition = z.infer<typeof parquetCondition>;
export type ParquetLookup = z.infer<typeof parquetLookup>;
export type ParquetMapping = z.infer<typeof parquetMapping>;
export type HuggingFaceFile = z.infer<typeof huggingFaceFile>;

export const huggingFaceFileUrl = (file: HuggingFaceFile) =>
  `https://huggingface.co/datasets/${file.dataset}/resolve/${encodeURIComponent(file.revision)}/${file.file
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`;

export const huggingFaceOrigin = (file: Pick<HuggingFaceFile, 'dataset' | 'file'>) =>
  `hf://datasets/${file.dataset}/${file.file}`;

/** Structural AsyncBuffer: the parser can request just a footer or column range. */
export interface ParquetFile {
  byteLength: number;
  slice(start: number, end?: number): ArrayBuffer | Promise<ArrayBuffer>;
}
export interface ParquetReader {
  columns(bytes: Uint8Array | ParquetFile): Promise<string[]>;
  rows(
    bytes: Uint8Array | ParquetFile,
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
      ...(mapping.lookups ?? []).map((l) => l.on),
    ]),
  ];
};

/** The columns read from a lookup file: the key and the joined fields. */
export const lookupColumns = (lookup: ParquetLookup) => [
  ...new Set([lookup.key, ...lookup.fields.map(columnOf)]),
];

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

type Entries = (readonly [string, unknown])[];

/** A key as text, or undefined for an empty or list value, which never matches. */
export const lookupKey = (value: unknown) => {
  const v = plain(value);
  if (v === null || v === undefined || Array.isArray(v) || typeof v === 'object') return undefined;
  const key = String(v).trim();
  return key === '' ? undefined : key;
};

export interface ParquetLookupTable {
  /** Where the lookup file came from, for errors and the run report. */
  file: string;
  on: string;
  rows: number;
  values: Map<string, Entries>;
}

/** Builds the in-memory key map for one lookup, within its row and memory caps. */
export const parquetLookupTable = async (
  rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>,
  lookup: ParquetLookup,
  file: string,
): Promise<ParquetLookupTable> => {
  const values = new Map<string, Entries>();
  let count = 0;
  let bytes = 0;
  for await (const row of rows) {
    count += 1;
    if (count > lookup.maxRows)
      throw new Error(`the Parquet lookup ${file} has more than ${lookup.maxRows} rows`);
    const key = lookupKey(row[lookup.key]);
    if (key === undefined) continue;
    const entries: Entries = lookup.fields.flatMap((field) => {
      const value = plain(row[columnOf(field)]);
      if (value === null || value === undefined || (Array.isArray(value) && value.length === 0))
        return [];
      return [[fieldNameOf(field), value] as const];
    });
    const known = values.get(key);
    if (known !== undefined) {
      if (JSON.stringify(known) !== JSON.stringify(entries))
        throw new Error(`the Parquet lookup ${file} has key ${key} twice with different values`);
      continue;
    }
    // UTF-16 strings: two bytes per code unit, plus a rough per-entry overhead.
    bytes += 2 * (key.length + JSON.stringify(entries).length) + 64;
    if (bytes > lookup.maxMemoryBytes)
      throw new Error(`the Parquet lookup ${file} needs more than ${lookup.maxMemoryBytes} bytes`);
    values.set(key, entries);
  }
  return { file, on: lookup.on, rows: count, values };
};

export interface ParquetSourceOptions {
  rows: AsyncIterable<Record<string, unknown>> | Iterable<Record<string, unknown>>;
  mapping: ParquetMapping;
  origin: string;
  rejectDuplicates?: boolean;
  /** Builds the lookup tables before the first row is read. */
  lookups?: () => Promise<ParquetLookupTable[]>;
}

export interface ParquetLookupReport {
  file: string;
  rows: number;
  keys: number;
  matched: number;
  missing: number;
}

export const parquetSource = (options: ParquetSourceOptions): IngestSource => {
  const reports: ParquetLookupReport[] = [];
  return {
    kind: 'parquet',
    phraseRows: 'pipeline',
    ...(options.mapping.lookups?.length ? { summary: () => ({ lookups: reports }) } : {}),
    documents: async function* () {
      const { fields, filter } = options.mapping;
      const keep = parquetRowMatches(filter);
      const seen = new Set<string>();
      const tables = (await options.lookups?.()) ?? [];
      reports.splice(
        0,
        reports.length,
        ...tables.map((t) => ({
          file: t.file,
          rows: t.rows,
          keys: t.values.size,
          matched: 0,
          missing: 0,
        })),
      );
      for await (const row of options.rows) {
        if (!keep(row)) continue;
        const sourceId = textOf(row[fields.id]).trim();
        if (sourceId === '') continue;
        const id = documentId(`${options.origin}#${sourceId}`);
        if (seen.has(id)) {
          if (options.rejectDuplicates)
            throw new Error(`duplicate Parquet row id ${sourceId} in table ${options.origin}`);
          continue;
        }
        seen.add(id);
        const title = textOf(row[fields.title]).trim() || sourceId;
        const body = fields.text
          .map((column) => textOf(row[column]).trim())
          .filter((t) => t !== '')
          .join('\n\n');
        const url = fields.url ? textOf(row[fields.url]).trim() : '';
        const date = fields.date ? textOf(row[fields.date]).trim() : '';
        const year = fields.year ? yearOf(row[fields.year]) : undefined;
        const joined = tables.flatMap((table, i) => {
          const key = lookupKey(row[table.on]);
          const entries = key === undefined ? undefined : table.values.get(key);
          const report = reports[i] as ParquetLookupReport;
          if (entries) report.matched += 1;
          else report.missing += 1;
          return entries ?? [];
        });
        const metadata = [...metadataOf(row, options.mapping), ...joined];
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
  };
};
