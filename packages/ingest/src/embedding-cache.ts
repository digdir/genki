import { createHash } from 'node:crypto';
import { EmbeddingError, type EmbeddingPort } from '@genai/port-embedding';

export interface CachedEmbedding {
  hash: string;
  vector: number[];
}

/** Vectors by the sha256 of their text, kept apart per embedding model and number of dimensions. */
export interface EmbeddingCache {
  /** The cached vectors among these hashes; hashes with no vector are left out. */
  find(model: string, dimensions: number, hashes: string[]): Promise<Map<string, number[]>>;
  save(model: string, dimensions: number, entries: CachedEmbedding[]): Promise<void>;
}

export const textHash = (text: string) => createHash('sha256').update(text).digest('hex');

/**
 * An embedder that sends the model only passages it has not embedded before with this model and size, each once.
 * Usage counts only those texts, since they are all the model was paid for. Questions go straight to the model:
 * a model with prompts embeds a question and a passage of the same text differently.
 */
export const cachingEmbedder = (options: {
  cache: EmbeddingCache;
  embedder: EmbeddingPort;
}): EmbeddingPort => ({
  info: () => options.embedder.info(),
  embed: async (texts, embedOptions) => {
    if (embedOptions?.purpose === 'query') return options.embedder.embed(texts, embedOptions);
    const { id, dimensions } = options.embedder.info();
    const hashes = texts.map(textHash);
    const known = await options.cache.find(id, dimensions, [...new Set(hashes)]);
    const missing = new Map<string, string>();
    hashes.forEach((hash, i) => {
      if (!known.has(hash) && !missing.has(hash)) missing.set(hash, texts[i] ?? '');
    });
    if (missing.size === 0)
      return { vectors: hashes.map((h) => known.get(h) ?? []), usage: { inputTokens: 0 } };
    const fresh = await options.embedder.embed([...missing.values()]);
    if (fresh.vectors.length !== missing.size)
      throw new EmbeddingError(
        'invalid_response',
        `the embedder returned ${fresh.vectors.length} vectors for ${missing.size} texts`,
      );
    const entries = [...missing.keys()].map((hash, i) => ({
      hash,
      vector: fresh.vectors[i] ?? [],
    }));
    await options.cache.save(id, dimensions, entries);
    for (const { hash, vector } of entries) known.set(hash, vector);
    return { vectors: hashes.map((h) => known.get(h) ?? []), usage: fresh.usage };
  },
});

/** An embedding cache in memory, for tests and runs without a knowledge server. */
export const inMemoryEmbeddingCache = (): EmbeddingCache => {
  const vectors = new Map<string, number[]>();
  const key = (model: string, dimensions: number, hash: string) => `${model}|${dimensions}|${hash}`;
  return {
    find: async (model, dimensions, hashes) =>
      new Map(
        hashes.flatMap((h) => {
          const vector = vectors.get(key(model, dimensions, h));
          return vector ? [[h, vector] as const] : [];
        }),
      ),
    save: async (model, dimensions, entries) => {
      for (const { hash, vector } of entries) vectors.set(key(model, dimensions, hash), vector);
    },
  };
};
