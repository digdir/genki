import { z } from 'zod';
import type { Chunk } from './chunk-document.js';
import { documentId } from './ids.js';
import type { IngestSource } from './pipeline.js';

export const sqlIdentifier = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'must be a plain table or column name');

const scalar = z.union([z.string().max(500), z.number().finite(), z.boolean()]);

export const rowOperators = [
  'eq',
  'neq',
  'in',
  'not_in',
  'gt',
  'gte',
  'lt',
  'lte',
  'is_null',
  'not_null',
] as const;

export const rowCondition = z
  .strictObject({
    column: sqlIdentifier,
    op: z.enum(rowOperators),
    value: z
      .union([
        scalar,
        z
          .array(z.union([z.string().max(500), z.number()]))
          .min(1)
          .max(100),
      ])
      .optional(),
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

export const rowMapping = z.strictObject({
  schema: sqlIdentifier.default('public'),
  table: sqlIdentifier,
  fields: z.strictObject({
    id: sqlIdentifier,
    title: sqlIdentifier,
    text: z.array(sqlIdentifier).min(1).max(20),
    url: sqlIdentifier.optional(),
    date: sqlIdentifier.optional(),
    metadata: z.array(sqlIdentifier).max(20).default([]),
  }),
  filter: z.array(rowCondition).max(20).default([]),
  maxRows: z.number().int().min(1).max(100_000).default(10_000),
});

export const databaseConnection = z.strictObject({
  engine: z.literal('postgres'),
  host: z
    .string()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.-]+$|^[0-9a-fA-F:]+$/, 'must be a host name or an IP address'),
  port: z.number().int().min(1).max(65535).default(5432),
  database: z.string().regex(/^[A-Za-z0-9_.-]{1,63}$/),
  user: z.string().regex(/^[A-Za-z0-9_.@-]{1,63}$/),
  password: z.string().regex(/^secret:\/\/[a-z0-9/._-]+$/, 'must be a secret:// reference'),
  tls: z.boolean().default(true),
});

export type RowCondition = z.infer<typeof rowCondition>;
export type RowMapping = z.infer<typeof rowMapping>;
export type DatabaseConnection = z.infer<typeof databaseConnection>;

export type ResolvedConnection = Omit<DatabaseConnection, 'password'> & {
  password: string;
  privateNetworks?: string[];
};

export type SourceCheckProblem = 'auth' | 'table' | 'columns';

export class SourceCheckError extends Error {
  constructor(
    message: string,
    readonly problem: SourceCheckProblem,
    readonly columns: { missing: string[]; known: string[] } = { missing: [], known: [] },
  ) {
    super(message);
    this.name = 'SourceCheckError';
  }
}

export interface TableQuery {
  schema: string;
  table: string;
  columns: string[];
  orderBy: string;
  filter: RowCondition[];
  maxRows: number;
}

export interface TableCheck {
  rows: number;
}

export interface RowReader {
  rows(
    connection: ResolvedConnection,
    query: TableQuery,
    signal?: AbortSignal,
  ): AsyncIterable<Record<string, unknown>>;
  check(
    connection: ResolvedConnection,
    query: TableQuery,
    signal?: AbortSignal,
  ): Promise<TableCheck>;
}

export const mappedColumns = (mapping: RowMapping) => {
  const { id, title, text, url, date, metadata } = mapping.fields;
  return [
    ...new Set([id, title, ...text, ...(url ? [url] : []), ...(date ? [date] : []), ...metadata]),
  ];
};

export const tableQuery = (mapping: RowMapping): TableQuery => ({
  schema: mapping.schema,
  table: mapping.table,
  columns: mappedColumns(mapping),
  orderBy: mapping.fields.id,
  filter: mapping.filter,
  maxRows: mapping.maxRows,
});

const textOf = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
};

export interface DatabaseSourceOptions {
  rows: AsyncIterable<Record<string, unknown>>;
  mapping: RowMapping;
  origin: string;
}

export const databaseSource = (options: DatabaseSourceOptions): IngestSource => ({
  kind: 'database',
  phraseRows: 'pipeline',
  documents: async function* () {
    const { fields, table } = options.mapping;
    for await (const row of options.rows) {
      const sourceId = textOf(row[fields.id]);
      const id = documentId(`${options.origin}#${sourceId}`);
      const title = textOf(row[fields.title]).trim() || sourceId;
      const body = fields.text
        .map((column) => textOf(row[column]).trim())
        .filter((t) => t !== '')
        .join('\n\n');
      const url = fields.url ? textOf(row[fields.url]).trim() : '';
      const date = fields.date ? textOf(row[fields.date]) : '';
      const metadata = Object.fromEntries(
        fields.metadata.map((column) => [column, textOf(row[column])]),
      );
      const name = `${table}/${sourceId}`;
      yield {
        key: id,
        docNum: id,
        name,
        ...(body === '' ? { skip: 'no_text' as const } : {}),
        texts: [`# ${title}\n\n${body}`],
        ...(url ? { location: { key: 'url' as const, value: url } } : {}),
        stored: (chunks: Chunk[]) => ({
          id,
          doc_num: id,
          title,
          path: name,
          url: url || null,
          ...(date ? { lastmod: date } : {}),
          type: 'database',
          source_table: table,
          source_id: sourceId,
          ...metadata,
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
