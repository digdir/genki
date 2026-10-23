import type { EmbeddingPort } from '@genai/port-embedding';
import {
  KnowledgeError,
  type DatasetConfig,
  type IndexChunk,
  type IndexDocument,
  type IndexWriter,
} from '@genai/port-knowledge';
import type { PhraseRow } from './phrases.js';
import { ingestDocuments, type DocumentLoopOptions, type IngestResult } from './pipeline.js';

export interface IndexTarget {
  engine?: string;
  needs: { vectors: boolean };
  dataset: DatasetConfig;
  writer: IndexWriter;
  generation: string;
  embedder?: EmbeddingPort;
  embedBatchSize?: number;
}

export interface IndexIngestOptions extends DocumentLoopOptions {
  target: IndexTarget;
  /** Omit siblings when rebuilding all pipelines into a shared generation. */
  pipeline?: { id: string; siblings?: readonly string[] };
}

export interface IndexIngestResult extends IngestResult {
  generation: string;
  promoted: boolean;
  previous?: string;
}

const docKeys = new Set(['id', 'doc_num', 'title', 'url']);
const chunkKeys = new Set([
  'id',
  'chunk_id',
  'doc_num',
  'chunk_index',
  'content_markdown',
  'content_length',
]);

const nonEmpty = (value: unknown) =>
  typeof value === 'string' && value !== '' ? value : undefined;

const without = (record: Record<string, unknown>, keys: Set<string>) =>
  Object.fromEntries(
    Object.entries(record).filter(([k, v]) => !keys.has(k) && v !== undefined && v !== null),
  );

export const toIndexDocument = (
  docNum: string,
  doc: Record<string, unknown>,
  chunks: Record<string, unknown>[],
  phrases: PhraseRow[],
): IndexDocument => {
  const title = nonEmpty(doc.title);
  const url = nonEmpty(doc.url);
  return {
    id: docNum,
    ...(title ? { title } : {}),
    ...(url ? { url } : {}),
    fields: without(doc, docKeys),
    chunks: chunks.map((chunk, index): IndexChunk => {
      const metadata = without(chunk, chunkKeys);
      return {
        id: String(chunk.chunk_id ?? chunk.id),
        position: typeof chunk.chunk_index === 'number' ? chunk.chunk_index : index,
        text: String(chunk.content_markdown ?? ''),
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      };
    }),
    phrases: phrases.map((p) => ({ id: p.id, chunkId: p.chunk_id, text: p.search_phrase })),
  };
};

export const embedIndexDocument = async (
  doc: IndexDocument,
  embedder: EmbeddingPort,
  batchSize = 64,
): Promise<IndexDocument> => {
  const texts = [...new Set([...doc.chunks, ...doc.phrases].map((t) => t.text))];
  const vectors = new Map<string, number[]>();
  for (let at = 0; at < texts.length; at += batchSize) {
    const batch = texts.slice(at, at + batchSize);
    const result = await embedder.embed(batch);
    batch.forEach((text, i) => {
      const vector = result.vectors[i];
      if (!vector) throw new Error(`the embedder returned no vector for text ${at + i}`);
      vectors.set(text, vector);
    });
  }
  const withVector = <T extends { text: string }>(item: T) => ({
    ...item,
    vector: vectors.get(item.text) as number[],
  });
  return { ...doc, chunks: doc.chunks.map(withVector), phrases: doc.phrases.map(withVector) };
};

export const checkIndexTarget = (target: IndexTarget) => {
  if (!target.needs.vectors) return;
  const name = `${target.engine ?? 'the'} index for dataset ${target.dataset.id}`;
  if (!target.embedder)
    throw new KnowledgeError(
      'bad_request',
      `${name} needs vectors, but no embedding model is configured`,
    );
  const expected = target.dataset.embedding?.dimensions;
  const actual = target.embedder.info().dimensions;
  if (expected !== undefined && expected !== actual)
    throw new KnowledgeError(
      'bad_request',
      `${name} expects ${expected} dimensions, but embedder ${target.embedder.info().id} returns ${actual}`,
    );
};

export const runIndexIngest = async (options: IndexIngestOptions): Promise<IndexIngestResult> => {
  const { target } = options;
  checkIndexTarget(target);
  const pipeline = options.pipeline;
  const siblings = new Set(pipeline?.siblings ?? []);
  if (pipeline) siblings.delete(pipeline.id);
  const preserving = siblings.size > 0;
  const read = target.writer.read?.bind(target.writer);
  const conditional =
    pipeline?.siblings !== undefined
      ? target.writer.promoteIfActive?.bind(target.writer)
      : undefined;
  if (preserving && (!read || !conditional))
    throw new KnowledgeError(
      'unsupported',
      'keeping sibling pipelines requires an index writer with read and conditional promotion',
    );
  const active = conditional ? await target.writer.active(target.dataset) : undefined;
  const embedder = target.needs.vectors ? target.embedder : undefined;
  const fresh = new Set<string>();
  await target.writer.prepare(target.dataset, target.generation);
  const result = await ingestDocuments(options, async (document, prepared) => {
    const indexed = toIndexDocument(
      document.docNum,
      prepared.doc,
      prepared.chunks,
      prepared.phrases,
    );
    const linked = indexed.url || !document.url ? indexed : { ...indexed, url: document.url };
    const doc = pipeline ? { ...linked, pipeline: pipeline.id } : linked;
    await target.writer.store(
      target.dataset,
      target.generation,
      embedder ? await embedIndexDocument(doc, embedder, target.embedBatchSize) : doc,
    );
    if (preserving) fresh.add(doc.id);
  });
  if (result.stored + result.skipped === 0 && (!preserving || result.failed.length > 0))
    return { ...result, generation: target.generation, promoted: false };
  if (preserving && active !== undefined && read) {
    for await (const doc of read(target.dataset, active)) {
      options.signal?.throwIfAborted();
      const owner = doc.pipeline;
      if (typeof owner === 'string' && siblings.has(owner) && !fresh.has(doc.id))
        await target.writer.store(target.dataset, target.generation, doc);
    }
  }
  options.signal?.throwIfAborted();
  const previous = conditional
    ? await conditional(target.dataset, target.generation, active)
    : await target.writer.promote(target.dataset, target.generation);
  return {
    ...result,
    generation: target.generation,
    promoted: true,
    ...(previous === undefined ? {} : { previous }),
  };
};
