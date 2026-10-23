import { KnowledgeError, type DatasetConfig, type IndexDocument } from '@genai/port-knowledge';
import { createHash } from 'node:crypto';
import type { ReadOnlyClient } from './client.js';
import type { TypesenseDatasetOptions } from './index.js';

export interface ReadCollections {
  docs: string;
  chunks: string;
  phrases?: string;
}

/** A separate, platform-owned collection; no source field is interpreted as provenance. */
export const provenanceCollection = (docs: string) =>
  `genai_provenance_${createHash('sha256').update(docs).digest('hex')}`;

const str = (v: unknown) =>
  typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined;

const without = (record: Record<string, unknown>, keys: string[]) =>
  Object.fromEntries(Object.entries(record).filter(([k]) => !keys.includes(k)));

const literal = (value: string) => {
  if (value.includes('`'))
    throw new KnowledgeError('bad_request', `cannot read a document id with a backtick: ${value}`);
  return `\`${value}\``;
};

/** Streams documents through GET export requests only, so it is safe with a search-only key. */
export async function* readTypesenseDocuments(
  client: ReadOnlyClient,
  dataset: DatasetConfig<TypesenseDatasetOptions>,
  collections: ReadCollections,
  signal: AbortSignal,
  batchSize = 100,
): AsyncIterable<IndexDocument> {
  const { fields } = dataset.options;
  const docsCollection = (await client.alias(collections.docs, signal)) ?? collections.docs;
  const byDocument = async (
    collection: string | undefined,
    ids: string[],
    exclude: string[],
    field = fields.document,
  ) => {
    const grouped = new Map<string, Record<string, unknown>[]>();
    if (!collection) return grouped;
    const query = {
      filter_by: `${field}:=[${ids.map(literal).join(',')}]`,
      ...(exclude.length ? { exclude_fields: exclude.join(',') } : {}),
    };
    for await (const record of client.exportDocuments(collection, query, signal)) {
      const doc = str(record[field]) ?? '';
      grouped.set(doc, [...(grouped.get(doc) ?? []), record]);
    }
    return grouped;
  };

  const assemble = async function* (records: Record<string, unknown>[]) {
    const ids = records.map((r) => str(r[fields.document]) ?? str(r.id) ?? '');
    const chunks = await byDocument(collections.chunks, ids, []);
    const phrases = await byDocument(collections.phrases, ids, ['phrase_vec']);
    const provenance = await byDocument(provenanceCollection(docsCollection), ids, [], 'id');
    for (const [i, record] of records.entries()) {
      const id = ids[i] as string;
      const title = str(record[fields.title]);
      const url = str(record[fields.url]);
      const pipeline = str(provenance.get(id)?.[0]?.pipeline);
      yield {
        id,
        ...(pipeline === undefined ? {} : { pipeline }),
        ...(title === undefined ? {} : { title }),
        ...(url === undefined ? {} : { url }),
        fields: without(record, ['id', fields.document, fields.title, fields.url, 'total_chunks']),
        chunks: (chunks.get(id) ?? [])
          .map((c) => ({
            id: str(c[fields.id]) ?? str(c.id) ?? '',
            position: Number(c[fields.position] ?? 0),
            text: str(c[fields.text]) ?? '',
            metadata: without(c, [
              'id',
              fields.id,
              fields.document,
              fields.position,
              fields.text,
              'content_length',
            ]),
          }))
          .sort((a, b) => a.position - b.position),
        phrases: (phrases.get(id) ?? []).map((p) => ({
          id: str(p.id) ?? '',
          chunkId: str(p[fields.id]) ?? '',
          text: str(p.search_phrase) ?? '',
        })),
      } satisfies IndexDocument;
    }
  };

  let batch: Record<string, unknown>[] = [];
  for await (const record of client.exportDocuments(docsCollection, {}, signal)) {
    batch.push(record);
    if (batch.length >= batchSize) {
      yield* assemble(batch);
      batch = [];
    }
  }
  if (batch.length > 0) yield* assemble(batch);
}
