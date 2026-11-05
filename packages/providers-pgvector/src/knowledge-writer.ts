import {
  GenerationBusy,
  KnowledgeError,
  type DatasetConfig,
  type IndexDocument,
  type IndexWriter,
} from '@genai/port-knowledge';
import type { Pool, PoolClient } from 'pg';
import {
  attachGeneration,
  dropGeneration,
  generationOf,
  partitionOf,
  prepareGeneration,
  recipeOf,
} from './partitions.js';
import { tryGenerationWrite } from './heavy-work.js';
import { transaction } from './schema.js';
import { fieldsText } from './sql.js';

type Options = { textSearchConfig?: string | undefined };

interface DocRow {
  id: string;
  title: string | null;
  url: string | null;
  fields: Record<string, unknown>;
}

const readPage = 200;

const failIfAborted = (signal: AbortSignal) => {
  if (signal.aborted) throw new KnowledgeError('cancelled', 'the write was cancelled');
};

const parsedVector = (vec: string | null) =>
  vec === null ? {} : { vector: JSON.parse(vec) as number[] };

/** Where `replaceDocument` writes: a generation's partitions, its text configuration and vector size. */
export interface DocumentTarget {
  dataset: string;
  generation: string;
  config: string;
  dimensions?: number;
  /**
   * `partition` for a generation not attached yet, which only the owner writes; `parent` for an
   * attached one, through the tables the writer role has rights on, pruned to the partition.
   */
  via: 'partition' | 'parent';
}

const tableOf = (target: Pick<DocumentTarget, 'generation' | 'via'>, table: string) =>
  target.via === 'parent' ? table : partitionOf(table, target.generation);

const checkedVector = (target: DocumentTarget, vector: number[] | undefined, id: string) => {
  if (vector === undefined) return null;
  if (vector.length !== target.dimensions || !vector.every(Number.isFinite))
    throw new KnowledgeError(
      'bad_request',
      `${id} needs a vector of ${target.dimensions ?? 0} finite numbers`,
    );
  return JSON.stringify(vector);
};

/** Deletes a document's rows from a generation's partitions, inside the caller's transaction. */
export const deleteDocument = async (
  client: PoolClient,
  target: Pick<DocumentTarget, 'generation' | 'via'>,
  id: string,
) => {
  const values = [target.generation, id];
  await client.query(
    `delete from ${tableOf(target, 'kn_phrases')} where generation = $1 and doc_id = $2`,
    values,
  );
  await client.query(
    `delete from ${tableOf(target, 'kn_chunks')} where generation = $1 and doc_id = $2`,
    values,
  );
  await client.query(
    `delete from ${tableOf(target, 'kn_docs')} where generation = $1 and id = $2`,
    values,
  );
};

/** Replaces one whole document in a generation, inside the caller's transaction, so search never sees half of it. */
/** A chunk's page range from its metadata (`page`, `pageEnd`), for `page_from` and `page_to`. */
const pagesOf = (metadata: Record<string, unknown> | undefined) => {
  const from = metadata?.page;
  if (typeof from !== 'number' || !Number.isInteger(from)) return {};
  const to = metadata?.pageEnd;
  return { page_from: from, page_to: typeof to === 'number' && Number.isInteger(to) ? to : from };
};

export const replaceDocument = async (
  client: PoolClient,
  target: DocumentTarget,
  doc: IndexDocument,
) => {
  const chunks = doc.chunks.map((c) => ({
    id: c.id,
    position: c.position,
    text: c.text,
    metadata: c.metadata ?? {},
    ...pagesOf(c.metadata),
    vec: checkedVector(target, c.vector, c.id),
  }));
  const phrases = doc.phrases.map((p) => ({
    id: p.id,
    chunk_id: p.chunkId,
    text: p.text,
    vec: checkedVector(target, p.vector, p.id),
  }));
  const key = [target.dataset, target.generation, doc.id];
  await deleteDocument(client, target, doc.id);
  await client.query(
    `insert into ${tableOf(target, 'kn_docs')} (dataset, generation, id, title, url, fields, fields_text, config)
     values ($1, $2, $3, $4, $5, $6, $7, $8::regconfig)`,
    [
      ...key,
      doc.title ?? null,
      doc.url ?? null,
      JSON.stringify(doc.fields),
      fieldsText(doc.fields),
      target.config,
    ],
  );
  await client.query(
    `insert into ${tableOf(target, 'kn_chunks')} (dataset, generation, id, doc_id, position, text, metadata, page_from, page_to, config, vec)
     select $1, $2, x.id, $3, x.position, x.text, x.metadata, x.page_from, x.page_to, $4::regconfig, x.vec::halfvec
     from jsonb_to_recordset($5::jsonb) as x(id text, position integer, text text, metadata jsonb, page_from integer, page_to integer, vec text)`,
    [...key, target.config, JSON.stringify(chunks)],
  );
  await client.query(
    `insert into ${tableOf(target, 'kn_phrases')} (dataset, generation, id, doc_id, chunk_id, text, config, vec)
     select $1, $2, x.id, $3, x.chunk_id, x.text, $4::regconfig, x.vec::halfvec
     from jsonb_to_recordset($5::jsonb) as x(id text, chunk_id text, text text, vec text)`,
    [...key, target.config, JSON.stringify(phrases)],
  );
};

/** Writes generations as partitions on the knowledge server, through the owner role only the worker has. */
export const knowledgeWriterOf = <O extends Options>(
  owner: Pool,
  ready: () => Promise<void>,
  signal: AbortSignal,
): IndexWriter<O> => {
  const begin = async () => {
    failIfAborted(signal);
    await ready();
  };
  const prepared = async (dataset: DatasetConfig, generation: string) => {
    const known = await generationOf(owner, generation);
    if (!known || known.dataset !== dataset.id)
      throw new KnowledgeError('bad_request', `generation ${generation} is not prepared`);
  };

  async function* read(dataset: DatasetConfig<O>, generation?: string) {
    await begin();
    const chosen = generation ?? dataset.generation;
    if (chosen === undefined) return;
    await prepared(dataset, chosen);
    const docsTable = partitionOf('kn_docs', chosen);
    const chunksTable = partitionOf('kn_chunks', chosen);
    const phrasesTable = partitionOf('kn_phrases', chosen);
    const dims = dataset.embedding?.dimensions;
    const vec = dims ? `vec::halfvec(${dims})::text` : 'vec::text';
    let after: string | null = null;
    for (;;) {
      await begin();
      const docs: DocRow[] = (
        await owner.query<DocRow>(
          `select id, title, url, fields from ${docsTable}
             where $1::text is null or id > $1 order by id limit $2`,
          [after, readPage],
        )
      ).rows;
      if (docs.length === 0) return;
      const ids: string[] = docs.map((d) => d.id);
      const chunks = (
        await owner.query<{
          doc_id: string;
          id: string;
          position: number;
          text: string;
          metadata: Record<string, unknown>;
          vec: string | null;
        }>(
          `select doc_id, id, position, text, metadata, ${vec} as vec from ${chunksTable}
             where doc_id = any($1::text[]) order by doc_id, position, id`,
          [ids],
        )
      ).rows;
      const phrases = (
        await owner.query<{
          doc_id: string;
          id: string;
          chunk_id: string;
          text: string;
          vec: string | null;
        }>(
          `select doc_id, id, chunk_id, text, ${vec} as vec from ${phrasesTable}
             where doc_id = any($1::text[]) order by doc_id, id`,
          [ids],
        )
      ).rows;
      for (const doc of docs)
        yield {
          id: doc.id,
          ...(doc.title === null ? {} : { title: doc.title }),
          ...(doc.url === null ? {} : { url: doc.url }),
          fields: doc.fields,
          chunks: chunks
            .filter((c) => c.doc_id === doc.id)
            .map((c) => ({
              id: c.id,
              position: c.position,
              text: c.text,
              metadata: c.metadata,
              ...parsedVector(c.vec),
            })),
          phrases: phrases
            .filter((p) => p.doc_id === doc.id)
            .map((p) => ({ id: p.id, chunkId: p.chunk_id, text: p.text, ...parsedVector(p.vec) })),
        } satisfies IndexDocument;
      after = ids.at(-1) ?? null;
    }
  }

  return {
    prepare: async (dataset, generation) => {
      await begin();
      await prepareGeneration(owner, dataset, generation);
    },
    store: async (dataset, generation, doc) => {
      await begin();
      await prepared(dataset, generation);
      const target = {
        dataset: dataset.id,
        generation,
        config: recipeOf(dataset).textSearchConfig,
        via: 'partition' as const,
        ...(dataset.embedding ? { dimensions: dataset.embedding.dimensions } : {}),
      };
      await transaction(owner, async (client) => {
        if (!(await tryGenerationWrite(client, generation))) throw new GenerationBusy(generation);
        await replaceDocument(client, target, doc);
      });
    },
    promote: async (dataset, generation) => {
      await begin();
      await attachGeneration(owner, dataset, generation);
      return undefined;
    },
    drop: async (dataset, generation, options = {}) => {
      await begin();
      const known = await generationOf(owner, generation);
      if (known && known.dataset !== dataset.id)
        throw new KnowledgeError(
          'bad_request',
          `generation ${generation} belongs to another dataset`,
        );
      if (generation === dataset.generation && !options.force)
        throw new KnowledgeError('bad_request', `generation ${generation} is active`);
      await dropGeneration(owner, generation);
    },
    active: async (dataset) => {
      await begin();
      return dataset.generation;
    },
    read,
    stats: async (dataset, generation) => {
      await begin();
      await prepared(dataset, generation);
      const { rows } = await owner.query<{ documents: number; chunks: number; phrases: number }>(
        `select
           (select count(*)::int from ${partitionOf('kn_docs', generation)}) as documents,
           (select count(*)::int from ${partitionOf('kn_chunks', generation)}) as chunks,
           (select count(*)::int from ${partitionOf('kn_phrases', generation)}) as phrases`,
      );
      return rows[0] ?? { documents: 0, chunks: 0, phrases: 0 };
    },
  };
};
