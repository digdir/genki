import { z } from 'zod';
import chunks from './chunks.schema.json' with { type: 'json' };
import docs from './docs.schema.json' with { type: 'json' };
import phrases from './phrases.schema.json' with { type: 'json' };

export interface CollectionNames {
  docs: string;
  chunks: string;
  phrases: string;
}

export interface SchemaField {
  name: string;
  type: string;
  optional?: boolean;
  reference?: string;
  [key: string]: unknown;
}

export interface CollectionSchema {
  name: string;
  fields: SchemaField[];
  [key: string]: unknown;
}

const named = (
  schema: { fields: SchemaField[] },
  name: string,
  docsName: string,
): CollectionSchema => ({
  ...structuredClone(schema),
  name,
  fields: schema.fields.map((f) =>
    f.reference ? { ...f, reference: f.reference.replace('{docs}', docsName) } : { ...f },
  ),
});

export const collectionSchemas = (names: CollectionNames) => ({
  docs: named(docs, names.docs, names.docs),
  chunks: named(chunks, names.chunks, names.docs),
  phrases: named(phrases, names.phrases, names.docs),
});

export const shortHashPattern = /^[0-9a-f]{12}$/;

const int = z.number().int();

export const docDocument = z.looseObject({
  doc_num: z.string().min(1),
  url: z.string().optional(),
  title: z.string().optional(),
  concerned_years: z.array(int).optional(),
  orgs_short: z.array(z.string()).optional(),
  orgs_long: z.array(z.string()).optional(),
  type: z.string().optional(),
  total_chunks: int.nonnegative().optional(),
  file_sha256: z.string().optional(),
  files: z.unknown().optional(),
});

export const chunkDocument = z.looseObject({
  chunk_id: z.string().min(1),
  doc_num: z.string().min(1).optional(),
  chunk_index: int.nonnegative().optional(),
  content_markdown: z.string().optional(),
  metadata: z.string().optional(),
  content_length: int.nonnegative().optional(),
});

export const phraseDocument = z.looseObject({
  chunk_id: z.string().min(1),
  search_phrase: z.string().optional(),
  doc_num: z.string().min(1).optional(),
});

export const searchHit = z.looseObject({
  document: z.record(z.string(), z.unknown()),
  text_match_info: z
    .looseObject({ score: z.union([z.string().regex(/^\d+$/), z.number()]).optional() })
    .optional(),
  hybrid_search_info: z.looseObject({ rank_fusion_score: z.number().optional() }).optional(),
});

export const searchResult = z.union([
  z.looseObject({
    found: int.nonnegative().optional(),
    hits: z.array(searchHit).optional(),
    facet_counts: z
      .array(
        z.looseObject({
          field_name: z.string(),
          counts: z.array(z.looseObject({ value: z.string(), count: int.nonnegative() })),
        }),
      )
      .optional(),
  }),
  z.looseObject({ code: int, error: z.string() }),
]);

export const multiSearchResponse = z.looseObject({ results: z.array(searchResult) });

export type DocumentKind = 'docs' | 'chunks' | 'phrases';

const byKind = { docs: docDocument, chunks: chunkDocument, phrases: phraseDocument };

export const validateDocument = (
  kind: DocumentKind,
  document: unknown,
  docsCollection?: string,
) => {
  const parsed = byKind[kind].safeParse(document);
  if (!parsed.success) return parsed;
  const joined = docsCollection ? (document as Record<string, unknown>)[docsCollection] : undefined;
  if (kind === 'docs' || joined === undefined) return parsed;
  const doc = docDocument.partial({ doc_num: true }).safeParse(joined);
  return doc.success ? parsed : doc;
};
