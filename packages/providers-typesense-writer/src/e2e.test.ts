import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  folderSource,
  kudosSource,
  legacyKudosCollectionIds,
  memoryPhraseCache,
  pipelineCollectionIds,
  runIngest,
  type ChunkDocumentConfig,
  type IngestResult,
} from '@genai/ingest';
import type { ModelPort } from '@genai/port-model';
import { keyword, type Value } from '@genai/valuehash';
import { contractSchemas } from './contract.test-utils.js';
import {
  createTypesenseWriter,
  folderSchemas,
  generationNames,
  type TypesenseWriter,
} from './index.js';

const fixtures = join(import.meta.dirname, '..', '..', 'ingest', 'src', 'fixtures');
const read = (file: string) => readFileSync(join(fixtures, file), 'utf8');
const expected = JSON.parse(read('expected.json')) as {
  chunking: { id: string; docNum: string; chunks: Record<string, unknown>[] }[];
  phrases: { pipeline: { id: string; search_phrase: string; chunk_id: string; doc_num: string }[] };
};
const corpus = JSON.parse(read('corpus.json')) as { phrases: { perChunk: string[][] } };
const expectedCase = (id: string) =>
  expected.chunking.find((c) => c.id === id) as (typeof expected.chunking)[number];

const apiKey = 'local-test-key';
let container: StartedTestContainer;
let writer: TypesenseWriter;
let folderWriter: TypesenseWriter;
let baseURL: string;

const search = async (collection: string, filter: string) => {
  const url = new URL(`${baseURL}/collections/${collection}/documents/search`);
  url.searchParams.set('q', '*');
  url.searchParams.set('filter_by', filter);
  url.searchParams.set('per_page', '250');
  const response = await fetch(url, { headers: { 'x-typesense-api-key': apiKey } });
  const body = (await response.json()) as {
    found: number;
    hits: { document: Record<string, unknown> }[];
  };
  return body.hits.map((h) => h.document);
};

const phraseModel = (): ModelPort => {
  const byContent = new Map(
    expectedCase('kudos-legacy').chunks.map((c, i) => [
      c.content_markdown as string,
      corpus.phrases.perChunk[i] ?? [],
    ]),
  );
  return {
    info: () => ({ id: 'stub', residency: 'norway', capabilities: [] }),
    chat: async (request) => {
      const prompt = request.messages[0]?.content ?? '';
      const content = [...byContent.keys()].find((c) => prompt.includes(c)) ?? '';
      return {
        content: JSON.stringify({ phrases: byContent.get(content) ?? [] }),
        toolCalls: [],
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 1, requests: 1 },
        servedModel: 'stub',
      };
    },
    chatStream: async function* () {
      yield* [];
    },
  };
};

const kudosDoc = {
  id: 12345,
  title: 'Tildelingsbrev 2025',
  type: 'Tildelingsbrev',
  publish_date: '2025-01-10',
  concerned_year_from: 2024,
  concerned_year_to: 2025,
  owners: [
    {
      alternative_names: [
        { name: 'Digitaliseringsdirektoratet', type: 'display' },
        { name: 'Digdir', type: 'short' },
      ],
    },
  ],
  recipients: [{ alternative_names: [{ name: 'Digitaliseringsdirektoratet', type: 'display' }] }],
  files: [
    {
      url: 'https://kudos.dfo.no/files/12345.pdf',
      sha256: 'f1e2d3',
      size: 10,
      path: '/tmp/pdf-123.pdf',
    },
  ],
};

const kudosChunking: ChunkDocumentConfig = {
  strategy: { kind: 'header-based' },
  minimumLength: 333,
  maximumLength: 256000,
  metadataStyle: 'prn',
};

const ingestKudos = (markdown: string, done?: Set<string>): Promise<IngestResult> =>
  runIngest({
    source: kudosSource({
      documents: [kudosDoc],
      fetchFile: async () => new Uint8Array([37, 80, 68, 70]),
      converter: { toMarkdown: async () => markdown },
    }),
    chunking: kudosChunking,
    collections: legacyKudosCollectionIds('KUDOS_preprod_v4_'),
    sink: writer,
    phrases: {
      model: phraseModel(),
      generation: {
        prompt: 'Phrases for:\nREPLACE_ME',
        identity: 'stub',
        cache: memoryPhraseCache(),
      },
    },
    ...(done ? { done } : {}),
  });

beforeAll(async () => {
  container = await new GenericContainer('typesense/typesense:30.2')
    .withCommand(['--data-dir', '/tmp', `--api-key=${apiKey}`, '--enable-cors'])
    .withExposedPorts(8108)
    .withWaitStrategy(Wait.forHttp('/health', 8108).forStatusCode(200))
    .start();
  baseURL = `http://${container.getHost()}:${container.getMappedPort(8108)}`;
  writer = createTypesenseWriter({
    baseURL,
    credential: { kind: 'api-key', key: async () => apiKey },
    schemas: contractSchemas(),
    embeddings: false,
    sharedClusterUrls: [process.env.TYPESENSE_URL],
  });
  folderWriter = createTypesenseWriter({
    baseURL,
    credential: { kind: 'api-key', key: async () => apiKey },
    schemas: folderSchemas,
    embeddings: false,
    sharedClusterUrls: [process.env.TYPESENSE_URL],
  });
}, 180_000);

afterAll(async () => {
  await container?.stop();
});

describe('ingest into a local Typesense', () => {
  it('stores KA-shaped Kudos chunks and phrases with headless-rag ids under the KA collection names', async () => {
    const result = await ingestKudos(read('kudos-12345.txt'));
    const names = legacyKudosCollectionIds('KUDOS_preprod_v4_');

    expect(result).toEqual({ stored: 1, skipped: 0, failed: [] });
    const chunks = await search(names.chunks, 'doc_num:=12345');
    const want = expectedCase('kudos-legacy').chunks;
    expect(chunks.map((c) => c.id).sort()).toEqual(want.map((c) => c.chunk_id).sort());
    for (const w of want) {
      const got = chunks.find((c) => c.chunk_id === w.chunk_id);
      expect(got).toMatchObject({
        content_markdown: w.content_markdown,
        metadata: w.metadata,
        doc_num: '12345',
        chunk_index: w.chunk_index,
        content_length: w.content_length,
      });
    }

    const phrases = await search(names.phrases, 'doc_num:=12345');
    expect(phrases.map((p) => p.id).sort()).toEqual(
      expected.phrases.pipeline.map((p) => p.id).sort(),
    );

    expect(await writer.retrieve(names.docs, '12345')).toMatchObject({
      doc_num: '12345',
      title: 'Tildelingsbrev 2025',
      orgs_long: ['Digitaliseringsdirektoratet'],
      concerned_years: [2024, 2025],
      file_sha256: ['f1e2d3'],
      total_chunks: 2,
      files: [{ url: 'https://kudos.dfo.no/files/12345.pdf', sha256: 'f1e2d3', size: 10 }],
    });
  });

  it('skips documents already done in a resumed run and removes orphans when content changes', async () => {
    const names = legacyKudosCollectionIds('KUDOS_preprod_v4_');

    expect(await ingestKudos(read('kudos-12345.txt'), new Set(['12345']))).toMatchObject({
      stored: 0,
      skipped: 1,
    });

    const shorter = read('kudos-12345.txt').split('### Delmål 1')[0] as string;
    await ingestKudos(shorter);
    const chunks = await search(names.chunks, 'doc_num:=12345');
    expect(chunks.map((c) => c.id)).toEqual([expectedCase('kudos-legacy').chunks[0]?.chunk_id]);
    const phrases = await search(names.phrases, 'doc_num:=12345');
    expect(
      phrases.every((p) => p.chunk_id === expectedCase('kudos-legacy').chunks[0]?.chunk_id),
    ).toBe(true);

    await ingestKudos(read('kudos-12345.txt'));
  });

  it('stores folder documents with pipeline ids, relative paths and versioned collection names', async () => {
    const config = new Map<string, Value>([
      ['chunks/strategy', keyword('header-based')],
      ['chunks/minimum-length', 100],
      ['chunks/split-max-length', 500],
    ]);
    const names = pipelineCollectionIds('folder_', config);
    const location = '/srv/corpus/nb/stor-seksjon.md';

    const result = await runIngest({
      source: folderSource({
        entries: [{ path: location, lastmod: '1' }],
        basePath: '/srv/corpus/',
        baseUrl: 'https://docs.example.no/',
        read: async () => read('folder-big.txt'),
      }),
      chunking: {
        strategy: { kind: 'header-based', splitMaxLength: 500, overlap: 80 },
        minimumLength: 100,
        maximumLength: 256000,
        metadataStyle: 'pr',
      },
      collections: names,
      sink: folderWriter,
    });

    expect(result.stored).toBe(1);
    const want = expectedCase('folder-split');
    const chunks = await search(names.chunks, `doc_num:=${want.docNum}`);
    expect(chunks.map((c) => c.id).sort()).toEqual(want.chunks.map((c) => c.chunk_id).sort());
    expect(chunks.every((c) => c.path === 'nb/stor-seksjon.md')).toBe(true);
    expect(await folderWriter.retrieve(names.docs, want.docNum)).toMatchObject({
      path: 'nb/stor-seksjon.md',
      url: 'https://docs.example.no/nb/stor-seksjon',
      total_chunks: want.chunks.length,
    });
  });

  it('builds a new generation and switches the aliases to it, keeping the old one until dropped', async () => {
    const aliases = { docs: 'gen_documents', chunks: 'gen_chunks', phrases: 'gen_phrases' };
    const first = generationNames(aliases, 'g1');
    const second = generationNames(aliases, 'g2');
    for (const target of [first, second]) {
      await folderWriter.ensureCollections(target);
      await folderWriter.upsert(target.docs, [
        {
          id: 'd1',
          doc_num: 'd1',
          title: target.docs,
          path: 'a.md',
          type: 'folder',
          total_chunks: 0,
        },
      ]);
    }

    await folderWriter.promote(aliases, first);
    const previous = await folderWriter.promote(aliases, second);

    expect(previous).toEqual(first);
    expect(await folderWriter.retrieve(aliases.docs, 'd1')).toMatchObject({ title: second.docs });
    await folderWriter.dropCollections(previous);
    const gone = await fetch(`${baseURL}/collections/${first.docs}`, {
      headers: { 'x-typesense-api-key': apiKey },
    });
    expect(gone.status).toBe(404);
  });
});
