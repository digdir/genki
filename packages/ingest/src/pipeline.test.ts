import { describe, expect, it } from 'vitest';
import { runIngest, type IndexSink, type IngestSource, type SourceDocument } from './index.js';

const chunking = {
  strategy: { kind: 'header-based' as const },
  minimumLength: 5,
  maximumLength: 4000,
  metadataStyle: 'pr' as const,
};

const sink = (): IndexSink => ({
  ensureCollections: async () => undefined,
  storeDocument: async () => undefined,
});

const lazySource = (keys: string[], load: (key: string) => Promise<void>): IngestSource => ({
  kind: 'kudos',
  phraseRows: 'legacy',
  documents: async function* () {
    for (const key of keys) {
      const listed: SourceDocument = {
        key,
        docNum: key,
        texts: [],
        stored: () => ({ id: key }),
        storedChunks: () => [],
      };
      yield {
        ...listed,
        prepare: async () => {
          await load(key);
          return { ...listed, texts: [`# ${key}\n\nInnhold for ${key}.`] };
        },
      };
    }
  },
});

const run = (
  source: IngestSource,
  extra: { parallelism?: number; maxDocumentFailures?: number; signal?: AbortSignal } = {},
) =>
  runIngest({
    source,
    chunking,
    collections: { docs: 'd', chunks: 'c', phrases: 'p' },
    sink: sink(),
    done: new Set(),
    ...extra,
  });

describe('document loop', () => {
  it('prepares up to the configured number of documents at the same time', async () => {
    let active = 0;
    let peak = 0;
    const result = await run(
      lazySource(['a', 'b', 'c', 'd', 'e'], async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
      }),
      { parallelism: 3 },
    );

    expect(result).toMatchObject({ stored: 5, failed: [] });
    expect(peak).toBe(3);
  });

  it('stops the run when the configured failure budget is spent, counting documents whose source fails to load', async () => {
    const loaded: string[] = [];
    await expect(
      run(
        lazySource(['a', 'b', 'c', 'd', 'e'], async (key) => {
          loaded.push(key);
          if (key !== 'a') throw new Error('Kudos svarte ikke');
        }),
        { maxDocumentFailures: 2 },
      ),
    ).rejects.toThrow(/2 documents failed/);
    expect(loaded).toEqual(['a', 'b', 'c']);
  });

  it('keeps going below the failure budget and reports the failed documents', async () => {
    const result = await run(
      lazySource(['a', 'b', 'c'], async (key) => {
        if (key === 'b') throw new Error('tidsavbrudd');
      }),
      { maxDocumentFailures: 2, parallelism: 2 },
    );

    expect(result).toMatchObject({ stored: 2, failed: ['b'] });
  });

  it('skips a document whose text yields no chunk as no_chunks and stores nothing for it', async () => {
    const stored: string[] = [];
    const source: IngestSource = {
      kind: 'folder',
      phraseRows: 'pipeline',
      documents: async function* () {
        for (const [key, text] of [
          ['kort', 'Ja.'],
          ['lang', '# Lang\n\nEn tekst som er lang nok til å bli en del.'],
        ] as const)
          yield {
            key,
            docNum: key,
            name: `${key}.md`,
            texts: [text],
            stored: () => ({ id: key }),
            storedChunks: (chunks) => chunks.map((c) => ({ id: c.chunk_id })),
          } satisfies SourceDocument;
      },
    };

    const result = await runIngest({
      source,
      chunking: { ...chunking, minimumLength: 20 },
      collections: { docs: 'd', chunks: 'c', phrases: 'p' },
      sink: { ...sink(), storeDocument: async (_n, docNum) => void stored.push(docNum) },
      done: new Set(),
    });

    expect(result).toMatchObject({
      stored: 1,
      skipped: 1,
      skippedDocuments: [{ document: 'kort.md', reason: 'no_chunks' }],
    });
    expect(stored).toEqual(['lang']);
  });

  it('stops at the next document once the run is cancelled', async () => {
    const controller = new AbortController();
    const loaded: string[] = [];
    await expect(
      run(
        lazySource(['a', 'b', 'c'], async (key) => {
          loaded.push(key);
          if (key === 'a') controller.abort(new Error('avbrutt'));
        }),
        { signal: controller.signal },
      ),
    ).rejects.toThrow(/avbrutt/);
    expect(loaded).toEqual(['a']);
  });
});
