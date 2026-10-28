import { describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { EmbeddingRouter } from '@genai/port-embedding';
import {
  fakeEmbedder,
  fakeEmbeddingAdapter,
  fakeVector,
  testContext,
} from '@genai/port-embedding/testing';
import type { DatasetConfig, IndexDocument } from '@genai/port-knowledge';
import { memoryEngine, openTarget, type MemoryDatasetOptions } from '@genai/port-knowledge/testing';
import type { ChatResult, ModelPort } from '@genai/port-model';
import {
  folderSource,
  kudosSource,
  memoryPhraseCache,
  runIndexIngest,
  toIndexDocument,
  type IndexTarget,
} from './index.js';

const signal = new AbortController().signal;
const embedding = { model: 'fake/embedder', dimensions: 8 };

const phraseModel: ModelPort = {
  info: () => ({ id: 'stub', residency: 'norway', capabilities: [] }),
  chat: async (): Promise<ChatResult> => ({
    content: '{"phrases":["søknad om tilskudd","frist for tilskudd"]}',
    toolCalls: [],
    finishReason: 'stop',
    usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
    servedModel: 'stub',
  }),
  chatStream: async function* () {
    yield* [];
  },
};

const phrases = {
  model: phraseModel,
  generation: { prompt: 'REPLACE_ME', identity: 'stub', cache: memoryPhraseCache() },
};

const chunking = {
  strategy: { kind: 'header-based' as const },
  minimumLength: 1,
  maximumLength: 4000,
  metadataStyle: 'pr' as const,
};

const source = (files: Record<string, string>) =>
  folderSource({
    entries: Object.keys(files).map((path) => ({ path, lastmod: '1' })),
    basePath: '/docs/',
    read: async (path) => files[path] ?? '',
  });

const corpus = {
  '/docs/tilskudd.md': '# Tilskudd\n\nKommunen gir tilskudd til lag og foreninger hvert år.',
  '/docs/skyplattform.md': '# Skyplattform\n\nEtaten flytter tjenester til en skyplattform.',
};

const setup = (options: { vectors?: boolean; withEmbedding?: boolean } = {}) => {
  const engine = memoryEngine({ vectors: options.vectors ?? false, embed: fakeVector });
  const dataset: DatasetConfig<MemoryDatasetOptions> = {
    id: 'veiledning',
    filters: {},
    options: {},
    ...(options.withEmbedding ? { embedding } : {}),
  };
  const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
  const search = () =>
    openTarget(
      { adapter: engine.adapter, ...(options.withEmbedding ? { embedding } : {}) },
      { id: dataset.id, filters: {} },
    );
  const target = (generation: string, extra: Partial<IndexTarget> = {}): IndexTarget => ({
    engine: 'memory',
    needs: engine.writer.needs,
    dataset,
    writer,
    generation,
    ...extra,
  });
  return { engine, dataset, writer, search, target };
};

describe('ingest through an index writer', () => {
  it('a Kudos document gets its public Kudos page as url, outside the stored fields', async () => {
    const { writer, target } = setup();
    const stored: IndexDocument[] = [];
    const watched = {
      ...writer,
      store: async (...args: Parameters<typeof writer.store>) => {
        stored.push(args[2]);
        return writer.store(...args);
      },
    };

    await runIndexIngest({
      source: kudosSource({
        documents: [
          { id: 330296, title: 'Tildelingsbrev 2025', files: [{ url: 'https://k.example/a.pdf' }] },
        ],
        fetchFile: async () => new TextEncoder().encode('Tildelingsbrev med mål.'),
        converter: {
          extensions: ['.pdf'],
          toMarkdown: async () => '# Brev\n\nTildelingsbrev med mål.',
        },
      }),
      chunking,
      target: target('g1', { writer: watched }),
    });

    expect(stored[0]?.url).toBe('https://kudos.dfo.no/dokument/330296');
    expect(stored[0]?.fields).not.toHaveProperty('url');
  });

  it('chunks and phrases are embedded on the platform when the writer needs vectors', async () => {
    const { search, writer, target } = setup({ vectors: true, withEmbedding: true });
    const embedder = fakeEmbedder({ dimensions: 8 });
    const stored: IndexDocument[] = [];
    const watched = {
      ...writer,
      store: async (...args: Parameters<typeof writer.store>) => {
        stored.push(args[2]);
        return writer.store(...args);
      },
    };

    const result = await runIndexIngest({
      source: source(corpus),
      chunking,
      phrases,
      target: target('g1', { writer: watched, embedder, embedBatchSize: 2 }),
    });

    expect(result).toMatchObject({ stored: 2, skipped: 0, failed: [], promoted: true });
    expect(embedder.calls.every((batch) => batch.length <= 2)).toBe(true);
    const items = stored.flatMap((d) => [...d.chunks, ...d.phrases]);
    expect(stored.flatMap((d) => d.phrases.map((p) => p.text))).toContain('søknad om tilskudd');
    expect(items.length).toBeGreaterThan(stored.length);
    for (const item of items) expect(item.vector).toEqual(fakeVector(item.text, 8));
    expect(new Set(embedder.calls.flat())).toEqual(new Set(items.map((i) => i.text)));
    const chunk = stored[1]?.chunks[0]?.text ?? '';
    const hits = await search().search({ query: chunk, profile: 'vector', limit: 1 });
    expect(hits.hits.map((h) => h.text)).toEqual([chunk]);
  });

  it('embedding usage is metered to the caller', async () => {
    const { target } = setup({ vectors: true, withEmbedding: true });
    const router = new EmbeddingRouter({
      catalog: {
        endpoints: {
          foundry: {
            protocol: 'fake',
            baseURL: 'https://foundry.example/openai/v1',
            auth: { kind: 'api-key', secret: 'secret://env/k' },
          },
        },
        models: [
          {
            id: 'foundry/embed-small',
            endpoint: 'foundry',
            deployment: 'text-embedding-3-small',
            residency: 'eu',
            dimensions: 8,
          },
        ],
      },
      adapters: [fakeEmbeddingAdapter()],
      secrets: envSecrets({}),
    });
    const { ctx, metered } = testContext();
    const embedder = router.open({ kind: 'embedder', id: 'foundry/embed-small' }, ctx);

    await runIndexIngest({ source: source(corpus), chunking, target: target('g1', { embedder }) });

    expect(metered.length).toBeGreaterThan(0);
    expect(
      metered.every((m) => m.model?.kind === 'embedder' && m.model.id === 'foundry/embed-small'),
    ).toBe(true);
    expect(metered.reduce((n, m) => n + (m.usage.inputTokens ?? 0), 0)).toBeGreaterThan(0);
  });

  it('a writer that needs vectors without an embedder fails before writing', async () => {
    const { engine, target } = setup({ vectors: true, withEmbedding: true });
    const writes: string[] = [];
    const writer = engine.writer.connect({ options: {}, timeoutMs: 1000 }, { signal });
    const watched = {
      ...writer,
      prepare: async (...args: Parameters<typeof writer.prepare>) => {
        writes.push('prepare');
        return writer.prepare(...args);
      },
    };

    await expect(
      runIndexIngest({
        source: source(corpus),
        chunking,
        target: target('g1', { writer: watched }),
      }),
    ).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/needs vectors/),
    });
    await expect(
      runIndexIngest({
        source: source(corpus),
        chunking,
        target: target('g1', { writer: watched, embedder: fakeEmbedder({ dimensions: 4 }) }),
      }),
    ).rejects.toThrow(/expects 8 dimensions/);
    expect(writes).toEqual([]);
  });

  it('documents written through the writer are searchable only after promote', async () => {
    const { search, writer, dataset, target } = setup();
    const stores: string[] = [];
    let searchedBeforePromote: number | undefined;
    const watched = {
      ...writer,
      store: async (...args: Parameters<typeof writer.store>) => {
        await writer.store(...args);
        stores.push(args[2].id);
      },
      promote: async (...args: Parameters<typeof writer.promote>) => {
        searchedBeforePromote = (await search().search({ query: 'tilskudd', profile: 'content' }))
          .hits.length;
        return writer.promote(...args);
      },
    };

    const result = await runIndexIngest({
      source: source(corpus),
      chunking,
      target: target('g1', { writer: watched }),
    });

    expect(stores).toHaveLength(2);
    expect(searchedBeforePromote).toBe(0);
    expect(result).toEqual({
      stored: 2,
      skipped: 0,
      failed: [],
      generation: 'g1',
      promoted: true,
    });
    const hits = await search().search({ query: 'tilskudd', profile: 'content' });
    expect(hits.hits.map((h) => h.title)).toEqual(['Tilskudd']);
    expect(await writer.stats(dataset, 'g1')).toMatchObject({ documents: 2 });
  });

  it('re-ingesting a document replaces its chunks', async () => {
    const { search, writer, dataset, target } = setup();
    const path = '/docs/tilskudd.md';

    await runIndexIngest({
      source: source({ [path]: corpus[path] }),
      chunking,
      target: target('g1'),
    });
    const second = await runIndexIngest({
      source: source({ [path]: '# Tilskudd\n\nSøknadsfristen for driftsstøtte er 1. mars.' }),
      chunking,
      target: target('g2'),
    });

    expect(second.previous).toBe('g1');
    const port = search();
    expect((await port.search({ query: 'foreninger', profile: 'content' })).hits).toEqual([]);
    const fresh = await port.search({ query: 'driftsstøtte', profile: 'content' });
    expect(fresh.hits).toHaveLength(1);
    const document = fresh.hits[0]?.document ?? '';
    expect((await port.range(document, 0, 49)).map((h) => h.text)).toEqual([
      expect.stringContaining('driftsstøtte'),
    ]);
    expect(await writer.stats(dataset, 'g2')).toEqual({ documents: 1, chunks: 1, phrases: 0 });
  });

  it('does not promote a generation in which every document failed', async () => {
    const { search, target } = setup();
    const broken = {
      kind: 'folder' as const,
      phraseRows: 'pipeline' as const,
      documents: async function* () {
        yield {
          key: 'a',
          docNum: 'a',
          texts: ['# A\n\nTekst om tilskudd.'],
          stored: () => {
            throw new Error('broken');
          },
          storedChunks: () => [],
        };
      },
    };

    const result = await runIndexIngest({ source: broken, chunking, target: target('g1') });

    expect(result).toEqual({
      stored: 0,
      skipped: 0,
      failed: ['a'],
      failedDocuments: [{ document: 'a', reason: 'broken' }],
      generation: 'g1',
      promoted: false,
    });
    expect((await search().search({ query: 'tilskudd', profile: 'content' })).hits).toEqual([]);
  });
});

describe('index documents', () => {
  it('maps headless field names to neutral ones', () => {
    expect(
      toIndexDocument(
        'd1',
        {
          id: 'd1',
          doc_num: 'd1',
          title: 'Tilskudd',
          url: null,
          path: 'tilskudd.md',
          type: 'folder',
        },
        [
          {
            id: 'c1',
            chunk_id: 'c1',
            doc_num: 'd1',
            chunk_index: 0,
            content_markdown: 'Tekst',
            content_length: 5,
            metadata: '{"h1":"Tilskudd"}',
            path: 'tilskudd.md',
          },
        ],
        [{ id: 'p1', search_phrase: 'søknad om tilskudd', chunk_id: 'c1', doc_num: 'd1' }],
      ),
    ).toEqual({
      id: 'd1',
      title: 'Tilskudd',
      fields: { path: 'tilskudd.md', type: 'folder' },
      chunks: [
        {
          id: 'c1',
          position: 0,
          text: 'Tekst',
          metadata: { metadata: '{"h1":"Tilskudd"}', path: 'tilskudd.md' },
        },
      ],
      phrases: [{ id: 'p1', chunkId: 'c1', text: 'søknad om tilskudd' }],
    });
  });
});
