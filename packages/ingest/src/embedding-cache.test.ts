import { describe, expect, it } from 'vitest';
import type { EmbedOptions } from '@genai/port-embedding';
import { fakeEmbedder, fakeVector } from '@genai/port-embedding/testing';
import { cachingEmbedder, inMemoryEmbeddingCache } from './embedding-cache.js';

describe('embedding cache', () => {
  it('embeds only the texts it has not seen, and returns every vector in input order', async () => {
    const model = fakeEmbedder({ dimensions: 4 });
    const embedder = cachingEmbedder({ cache: inMemoryEmbeddingCache(), embedder: model });

    await embedder.embed(['tilskudd', 'tildeling']);
    const second = await embedder.embed(['tildeling', 'rapport', 'tildeling']);

    expect(model.calls).toEqual([['tilskudd', 'tildeling'], ['rapport']]);
    expect(second.vectors).toEqual([
      fakeVector('tildeling', 4),
      fakeVector('rapport', 4),
      fakeVector('tildeling', 4),
    ]);
    expect(second.usage).toEqual({ inputTokens: 1 });
  });

  it('sends questions to the model every time, with their purpose, and stores only passages', async () => {
    const model = fakeEmbedder({ dimensions: 4 });
    const purposes: (string | undefined)[] = [];
    const spy = {
      ...model,
      embed: (texts: string[], options?: EmbedOptions) => {
        purposes.push(options?.purpose);
        return model.embed(texts, options);
      },
    };
    const embedder = cachingEmbedder({ cache: inMemoryEmbeddingCache(), embedder: spy });

    await embedder.embed(['tilskudd'], { purpose: 'query' });
    await embedder.embed(['tilskudd'], { purpose: 'query' });
    await embedder.embed(['tilskudd']);
    await embedder.embed(['tilskudd'], { purpose: 'document' });

    expect(model.calls).toEqual([['tilskudd'], ['tilskudd'], ['tilskudd']]);
    expect(purposes).toEqual(['query', 'query', undefined]);
  });

  it('keeps the vectors of each model and size apart', async () => {
    const cache = inMemoryEmbeddingCache();
    const small = fakeEmbedder({ id: 'foundry/text-embedding-3-large', dimensions: 4 });
    const large = fakeEmbedder({ id: 'foundry/text-embedding-3-large', dimensions: 8 });
    const other = fakeEmbedder({ id: 'foundry/text-embedding-3-small', dimensions: 4 });

    for (const model of [small, large, other, small])
      await cachingEmbedder({ cache, embedder: model }).embed(['tilskudd']);

    expect([small.calls, large.calls, other.calls]).toEqual([
      [['tilskudd']],
      [['tilskudd']],
      [['tilskudd']],
    ]);
  });
});
