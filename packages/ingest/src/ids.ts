import { keyword, shortHash, type Value } from '@genai/valuehash';
import { isBlank } from './text.js';

export type ConfigMap = ReadonlyMap<string, Value>;

export const chunkId = (docNum: string, occurrence: number, content: string) => {
  if (isBlank(docNum)) throw new Error('Cannot derive a chunk id without a document id');
  return shortHash(`${docNum}|${occurrence}|${content}`);
};

export const assignChunkIds = <C extends { content_markdown: string }>(
  docNum: string,
  chunks: C[],
) => {
  const seen = new Map<string, number>();
  return chunks.map((chunk) => {
    const occurrence = seen.get(chunk.content_markdown) ?? 0;
    seen.set(chunk.content_markdown, occurrence + 1);
    return { ...chunk, chunk_id: chunkId(docNum, occurrence, chunk.content_markdown) };
  });
};

export const phraseId = (chunkIdValue: string, phrase: string) =>
  shortHash(`${chunkIdValue}|${phrase}`);

export const documentId = (location: string) => shortHash(location);

const keywordMap = (entries: [string, Value][]) =>
  new Map<Value, Value>(entries.map(([k, v]) => [keyword(k), v]));

const namespaceOf = (key: string) =>
  key.includes('/') ? key.slice(0, key.indexOf('/')) : undefined;

export const extractNamespace = (config: ConfigMap, ns: string) =>
  [...config].filter(([key]) => {
    const n = namespaceOf(key);
    return n !== undefined && (n === ns || n.startsWith(`${ns}.`));
  });

export const configHash = (config: ConfigMap, ns: string) =>
  shortHash(keywordMap(extractNamespace(config, ns)));

export interface CollectionIds {
  docs: string;
  chunks: string;
  phrases: string;
}

export const pipelineCollectionIds = (prefix: string, config: ConfigMap): CollectionIds => ({
  docs: `${prefix}documents_${configHash(config, 'documents')}`,
  chunks: `${prefix}chunks_${configHash(config, 'chunks')}`,
  phrases: `${prefix}phrases_${configHash(config, 'search-phrases')}`,
});

export const legacyKudosCollectionIds = (prefix: string): CollectionIds => {
  const suffix = shortHash(new Map());
  return {
    docs: `${prefix}documents_${suffix}`,
    chunks: `${prefix}chunks_${suffix}`,
    phrases: `${prefix}phrases_${suffix}`,
  };
};

const pipelineHashKeys = [
  'source-type',
  'chunk-strategy',
  'chunk-minimum-length',
  'chunk-maximum-length',
  'search-phrases-model',
  'search-phrases-fallback',
  'search-phrases-prompt',
];

export const pipelineConfigHash = (config: ConfigMap) =>
  shortHash(
    keywordMap(
      pipelineHashKeys.flatMap((k) => (config.has(k) ? [[k, config.get(k) as Value]] : [])),
    ),
  );

export const pipelineCollectionNames = (config: ConfigMap): CollectionIds => {
  const explicit = config.get('collection-prefix');
  const name = config.get('pipeline-name');
  const prefix =
    typeof explicit === 'string'
      ? explicit
      : typeof name === 'string'
        ? `${name.replace(/[^a-zA-Z0-9_]/g, '_')}_`
        : 'pipeline_';
  const hash = pipelineConfigHash(config);
  return {
    docs: `${prefix}documents_${hash}`,
    chunks: `${prefix}chunks_${hash}`,
    phrases: `${prefix}phrases_${hash}`,
  };
};
