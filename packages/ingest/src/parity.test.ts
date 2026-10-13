import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { keyword, type Value } from '@genai/valuehash';
import {
  chunkDocument,
  documentId,
  legacyKudosCollectionIds,
  legacyKudosPhraseRows,
  parsePhrases,
  pipelineCollectionIds,
  pipelineCollectionNames,
  pipelinePhraseRows,
  type ChunkDocumentConfig,
} from './index.js';

const dir = join(import.meta.dirname, 'fixtures');
const read = (file: string) => readFileSync(join(dir, file), 'utf8');

interface ChunkCase {
  id: string;
  file: string;
  docNum: string;
  location?: string;
  printer: 'pr' | 'prn';
  strategy: 'header-based' | 'fixed-width';
  minimumLength: number;
  maximumLength: number;
  splitMaxLength?: number;
  overlap?: number;
  width?: number;
}

interface Corpus {
  chunking: ChunkCase[];
  phrases: { case: string; perChunk: string[][] };
  parser: string[];
  collections: {
    legacyKudosPrefix: string;
    pipeline: { prefix: string; config: Record<string, unknown> };
    pipelineNames: { config: Record<string, unknown> };
  };
}

const corpus = JSON.parse(read('corpus.json')) as Corpus;
const expected = JSON.parse(read('expected.json')) as {
  chunking: { id: string; docNum: string; chunks: Record<string, unknown>[] }[];
  phrases: { legacy: unknown[]; pipeline: unknown[] };
  parser: { content: string; phrases: string[] }[];
  collections: { legacyKudos: string[]; pipeline: string[]; pipelineNames: string[] };
};

const configFor = (c: ChunkCase): ChunkDocumentConfig => ({
  strategy:
    c.strategy === 'fixed-width'
      ? { kind: 'fixed-width', width: c.width ?? 0, overlap: c.overlap ?? 0 }
      : {
          kind: 'header-based',
          ...(c.splitMaxLength === undefined ? {} : { splitMaxLength: c.splitMaxLength }),
          ...(c.overlap === undefined ? {} : { overlap: c.overlap }),
        },
  minimumLength: c.minimumLength,
  maximumLength: c.maximumLength,
  metadataStyle: c.printer,
});

const run = (c: ChunkCase) => {
  const docNum =
    c.docNum === 'LOC' || c.docNum === 'PATH' ? documentId(c.location ?? '') : c.docNum;
  const location = c.location
    ? { key: c.docNum === 'PATH' ? ('path' as const) : ('url' as const), value: c.location }
    : undefined;
  const chunks = chunkDocument(docNum, [read(c.file)], configFor(c), location).map((chunk) => {
    const { url, path, ...rest } = chunk;
    return { ...rest, ...((url ?? path) ? { location: url ?? path } : {}) };
  });
  return { id: c.id, docNum, chunks };
};

const toConfig = (record: Record<string, unknown>) =>
  new Map<string, Value>(
    Object.entries(record).map(([k, v]) => [
      k,
      v && typeof v === 'object' && 'kw' in v
        ? keyword(String((v as { kw: string }).kw))
        : (v as Value),
    ]),
  );

describe('ingest output matches headless-rag byte for byte', () => {
  it.each(corpus.chunking.map((c) => [c.id, c] as const))(
    'chunks %s like headless-rag',
    (_id, c) => {
      expect(run(c)).toEqual(expected.chunking.find((e) => e.id === c.id));
    },
  );

  it('derives phrase ids for the legacy Kudos path and the pipeline path', () => {
    const base = run(corpus.chunking.find((c) => c.id === corpus.phrases.case) as ChunkCase);
    const chunks = chunkDocument(
      base.docNum,
      [read((corpus.chunking.find((c) => c.id === corpus.phrases.case) as ChunkCase).file)],
      configFor(corpus.chunking.find((c) => c.id === corpus.phrases.case) as ChunkCase),
    ).map((chunk, i) => ({ ...chunk, searchPhrases: corpus.phrases.perChunk[i] ?? [] }));

    expect(legacyKudosPhraseRows(chunks, base.docNum)).toEqual(expected.phrases.legacy);
    expect(pipelinePhraseRows(chunks, base.docNum)).toEqual(expected.phrases.pipeline);
  });

  it.each(expected.parser.map((p) => [p.content, p.phrases] as const))(
    'parses the phrase response %j like headless-rag',
    (content, phrases) => {
      expect(parsePhrases(content)).toEqual(phrases);
    },
  );

  it('names collections like headless-rag, including the legacy Kudos suffix KA lives under', () => {
    const legacy = legacyKudosCollectionIds(corpus.collections.legacyKudosPrefix);
    const pipeline = pipelineCollectionIds(
      corpus.collections.pipeline.prefix,
      toConfig(corpus.collections.pipeline.config),
    );
    const names = pipelineCollectionNames(toConfig(corpus.collections.pipelineNames.config));

    expect([legacy.docs, legacy.chunks, legacy.phrases]).toEqual(expected.collections.legacyKudos);
    expect(legacy.chunks).toBe('KUDOS_preprod_v4_chunks_ab897fbdedfa');
    expect([pipeline.docs, pipeline.chunks, pipeline.phrases]).toEqual(
      expected.collections.pipeline,
    );
    expect([names.docs, names.chunks, names.phrases]).toEqual(expected.collections.pipelineNames);
  });
});
