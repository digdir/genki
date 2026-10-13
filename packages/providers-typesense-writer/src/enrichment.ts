import { KnowledgeError, type DatasetConfig } from '@genai/port-knowledge';
import type { TypesenseDatasetOptions } from '@genai/providers-typesense';
import { refuseSharedCluster } from './writer.js';

export interface QuestionRow {
  id: string;
  chunk_id: string;
  doc_num: string;
  question: string;
  model: string;
  generated_at: number;
  prompt_hash?: string;
}

type Dataset = DatasetConfig<TypesenseDatasetOptions>;

interface Http {
  request(
    method: string,
    path: string,
    body?: string,
    contentType?: string,
  ): Promise<{ status: number; ok: boolean; text: string }>;
  json(method: string, path: string, payload?: unknown): Promise<unknown>;
}

export const questionsCollectionKey = 'questions';

const literal = (value: string) => {
  if (value.includes('`'))
    throw new KnowledgeError('bad_request', `refusing an id with a backtick: ${value}`);
  return `\`${value}\``;
};

export const questionsSchema = (dataset: Dataset, name: string) => {
  const document = dataset.options.fields.document;
  const docs = dataset.options.collections.docs as string;
  const embed = dataset.options.writer?.embedPhrases ?? true;
  return {
    name,
    fields: [
      { name: 'chunk_id', type: 'string', facet: true },
      {
        name: document,
        type: 'string',
        facet: true,
        reference: `${docs}.${document}`,
        async_reference: true,
      },
      { name: 'question', type: 'string', locale: 'no' },
      ...(embed
        ? [
            {
              name: 'question_vec',
              type: 'float[]',
              embed: { from: ['question'], model_config: { model_name: 'ts/all-MiniLM-L12-v2' } },
              optional: true,
            },
          ]
        : []),
      { name: 'model', type: 'string' },
      { name: 'prompt_hash', type: 'string', optional: true, facet: true },
      { name: 'generated_at', type: 'int64' },
    ],
  };
};

export const questionsFilter = (chunkIds: string[], promptHash?: string) => {
  const base = `chunk_id:=[${chunkIds.map(literal).join(',')}]`;
  return promptHash ? `${base} && prompt_hash:=[${literal(promptHash)}]` : base;
};

export const typesenseEnrichment = (
  http: Http,
  baseURL: string,
  sharedClusterUrls?: (string | undefined)[],
) => {
  refuseSharedCluster(baseURL, sharedClusterUrls);
  const collectionOf = (dataset: Dataset) => {
    const name = dataset.options.collections[questionsCollectionKey];
    if (!name)
      throw new KnowledgeError(
        'bad_request',
        `dataset ${dataset.id} declares no questions collection for enrichment`,
      );
    return name;
  };
  const path = (name: string) => `/collections/${encodeURIComponent(name)}`;
  const remove = async (name: string, filter: string) => {
    const result = await http.request(
      'DELETE',
      `${path(name)}/documents?filter_by=${encodeURIComponent(filter)}`,
    );
    if (result.status === 404) return 0;
    if (!result.ok) throw new Error(`Typesense DELETE in ${name} answered HTTP ${result.status}`);
    return (JSON.parse(result.text || '{}') as { num_deleted?: number }).num_deleted ?? 0;
  };
  const ensure = async (dataset: Dataset, name: string) => {
    const found = await http.request('GET', path(name));
    if (found.ok) return;
    if (found.status !== 404)
      throw new Error(`Typesense GET /collections/${name} answered HTTP ${found.status}`);
    await http.json('POST', '/collections', questionsSchema(dataset, name));
  };

  return {
    replaceQuestions: async (raw: DatasetConfig, rows: QuestionRow[], chunkIds: string[]) => {
      const dataset = raw as Dataset;
      const name = collectionOf(dataset);
      await ensure(dataset, name);
      if (chunkIds.length > 0) await remove(name, questionsFilter(chunkIds));
      if (rows.length === 0) return 0;
      const document = dataset.options.fields.document;
      const result = await http.request(
        'POST',
        `${path(name)}/documents/import?action=upsert`,
        rows
          .map(({ doc_num, ...row }) => JSON.stringify({ ...row, [document]: doc_num }))
          .join('\n'),
        'text/plain',
      );
      if (!result.ok)
        throw new Error(`Typesense import into ${name} answered HTTP ${result.status}`);
      const lines = result.text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { success: boolean; error?: string });
      const failed = lines.filter((line) => !line.success);
      if (failed.length > 0)
        throw new Error(
          `Typesense refused ${failed.length} of ${rows.length} questions in ${name}: ${failed[0]?.error ?? 'unknown error'}`,
        );
      return lines.length;
    },

    revertQuestions: async (raw: DatasetConfig, chunkId: string, promptHash?: string) =>
      remove(collectionOf(raw as Dataset), questionsFilter([chunkId], promptHash)),
  };
};
