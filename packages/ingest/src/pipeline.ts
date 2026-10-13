import { textPart, type Ref } from '@genai/contracts';
import type { InvocationContext, Strategy } from '@genai/kernel';
import type { ModelPort } from '@genai/port-model';
import { z } from 'zod';
import {
  chunkDocument,
  type Chunk,
  type ChunkDocumentConfig,
  type Location,
} from './chunk-document.js';
import type { CollectionIds } from './ids.js';
import {
  generatePhrases,
  legacyKudosPhraseRows,
  pipelinePhraseRows,
  type ChunkWithPhrases,
  type PhraseGeneration,
  type PhraseRow,
} from './phrases.js';

export type SkipReason =
  'no_text' | 'unsupported_type' | 'outside_access' | 'conversion_failed' | 'unreachable';

export interface SkippedDocument {
  document: string;
  reason: SkipReason;
}

export interface SourceDocument {
  key: string;
  docNum: string;
  name?: string;
  skip?: SkipReason;
  texts: string[];
  location?: Location;
  url?: string;
  prepare?(): Promise<SourceDocument>;
  stored(chunks: Chunk[]): Record<string, unknown>;
  storedChunks(chunks: Chunk[]): Record<string, unknown>[];
}

export interface IngestSource {
  kind: 'kudos' | 'website' | 'folder' | 'upload' | 'database' | 'episerver';
  phraseRows: 'legacy' | 'pipeline';
  documents(): AsyncIterable<SourceDocument>;
  skipped?: SkippedDocument[];
}

export interface IndexSink {
  ensureCollections(names: CollectionIds): Promise<void>;
  storeDocument(
    names: CollectionIds,
    docNum: string,
    doc: Record<string, unknown>,
    chunks: Record<string, unknown>[],
    phrases: PhraseRow[],
  ): Promise<void>;
}

export interface IngestOptions {
  source: IngestSource;
  chunking: ChunkDocumentConfig;
  collections: CollectionIds;
  sink: IndexSink;
  phrases?: { model: ModelPort; generation: PhraseGeneration };
  done?: Set<string>;
  maxDocumentFailures?: number;
  parallelism?: number;
  signal?: AbortSignal;
  onDocument?: (event: {
    key: string;
    status: 'stored' | 'skipped' | 'failed';
    error?: unknown;
  }) => Promise<void> | void;
}

export interface IngestResult {
  stored: number;
  skipped: number;
  failed: string[];
  skippedDocuments?: SkippedDocument[];
}

export const prepareDocument = async (
  document: SourceDocument,
  chunking: ChunkDocumentConfig,
  phraseRows: 'legacy' | 'pipeline',
  phrases?: IngestOptions['phrases'],
) => {
  const chunks: ChunkWithPhrases[] = chunkDocument(
    document.docNum,
    document.texts,
    chunking,
    document.location,
  );
  const withPhrases: ChunkWithPhrases[] = phrases
    ? await Promise.all(
        chunks.map(async (c) => ({
          ...c,
          searchPhrases: await generatePhrases(
            phrases.model,
            c.content_markdown,
            phrases.generation,
          ),
        })),
      )
    : chunks;
  const rows =
    phraseRows === 'legacy'
      ? legacyKudosPhraseRows(withPhrases, document.docNum)
      : pipelinePhraseRows(withPhrases, document.docNum);
  return {
    doc: document.stored(withPhrases),
    chunks: document.storedChunks(withPhrases),
    phrases: rows,
  };
};

export type DocumentLoopOptions = Pick<
  IngestOptions,
  | 'source'
  | 'chunking'
  | 'phrases'
  | 'done'
  | 'maxDocumentFailures'
  | 'parallelism'
  | 'signal'
  | 'onDocument'
>;

export type PreparedDocument = Awaited<ReturnType<typeof prepareDocument>>;

export class FailureBudgetExceeded extends Error {
  override readonly name = 'FailureBudgetExceeded';
  constructor(
    readonly failed: string[],
    cause: unknown,
  ) {
    super(`${failed.length} documents failed to import; stopping the run`, { cause });
  }
}

export const ingestDocuments = async (
  options: DocumentLoopOptions,
  store: (document: SourceDocument, prepared: PreparedDocument) => Promise<void>,
): Promise<IngestResult> => {
  const done = options.done ?? new Set<string>();
  const budget = options.maxDocumentFailures ?? 10;
  const parallelism = Math.max(1, options.parallelism ?? 1);
  const result: IngestResult = { stored: 0, skipped: 0, failed: [] };
  const skip = (skipped: SkippedDocument) => {
    result.skipped += 1;
    result.skippedDocuments = [...(result.skippedDocuments ?? []), skipped];
  };
  for (const skipped of options.source.skipped ?? []) skip(skipped);
  let stop: unknown;
  const handle = async (listed: SourceDocument) => {
    if (done.has(listed.key)) {
      result.skipped += 1;
      await options.onDocument?.({ key: listed.key, status: 'skipped' });
      return;
    }
    try {
      const document = listed.prepare ? await listed.prepare() : listed;
      if (document.skip) {
        skip({ document: document.name ?? document.key, reason: document.skip });
        await options.onDocument?.({ key: document.key, status: 'skipped' });
        return;
      }
      const prepared = await prepareDocument(
        document,
        options.chunking,
        options.source.phraseRows,
        options.phrases,
      );
      await store(document, prepared);
      done.add(document.key);
      result.stored += 1;
      await options.onDocument?.({ key: document.key, status: 'stored' });
    } catch (error) {
      if (options.signal?.aborted || stop !== undefined) return;
      result.failed.push(listed.key);
      await options.onDocument?.({ key: listed.key, status: 'failed', error });
      if (result.failed.length >= budget) stop = new FailureBudgetExceeded(result.failed, error);
    }
  };
  const running = new Set<Promise<void>>();
  try {
    for await (const document of options.source.documents()) {
      options.signal?.throwIfAborted();
      if (stop !== undefined) break;
      const task: Promise<void> = handle(document).finally(() => running.delete(task));
      running.add(task);
      if (running.size >= parallelism) await Promise.race(running);
    }
  } finally {
    await Promise.all(running);
  }
  options.signal?.throwIfAborted();
  if (stop !== undefined) throw stop;
  return result;
};

export const runIngest = async (options: IngestOptions): Promise<IngestResult> => {
  await options.sink.ensureCollections(options.collections);
  return ingestDocuments(options, (document, prepared) =>
    options.sink.storeDocument(
      options.collections,
      document.docNum,
      prepared.doc,
      prepared.chunks,
      prepared.phrases,
    ),
  );
};

export const ingestConfig = z.strictObject({
  runId: z.string().min(1),
  phraseModel: z.string().min(1).optional(),
  maxDocumentFailures: z.number().int().positive().default(10),
  parallelism: z.number().int().positive().default(1),
});

export type IngestConfig = z.infer<typeof ingestConfig>;

export interface IngestStrategyOptions {
  plan(
    ctx: InvocationContext,
    config: IngestConfig,
  ): Promise<
    Omit<IngestOptions, 'done' | 'signal' | 'onDocument' | 'phrases'> & {
      phraseGeneration?: PhraseGeneration;
    }
  >;
}

const stateKey = (runId: string) => `ingest:${runId}:done`;

export const createIngestStrategy = (options: IngestStrategyOptions): Strategy<IngestConfig> => ({
  id: 'ingest',
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },
  run: async function* (ctx, _input, rawConfig) {
    const config = ingestConfig.parse(rawConfig);
    const plan = await options.plan(ctx, config);
    const saved = await ctx.state.get<string[]>('principal', stateKey(config.runId));
    const done = new Set(saved?.value ?? []);
    let version = saved?.v;
    const model =
      config.phraseModel && plan.phraseGeneration
        ? await ctx.use<ModelPort>('model', { kind: 'model', id: config.phraseModel } satisfies Ref)
        : undefined;
    const events: { key: string; status: string }[] = [];
    const result = await runIngest({
      ...plan,
      done,
      signal: ctx.signal,
      maxDocumentFailures: config.maxDocumentFailures,
      parallelism: config.parallelism,
      ...(model && plan.phraseGeneration
        ? { phrases: { model, generation: plan.phraseGeneration } }
        : {}),
      onDocument: async (event) => {
        events.push({ key: event.key, status: event.status });
        if (event.status === 'stored')
          version = await ctx.state.put('principal', stateKey(config.runId), [...done], version);
      },
    });
    for (const event of events)
      yield { type: 'kernel.notice', data: { stage: 'ingest', ...event } };
    yield {
      type: 'kernel.result',
      data: [textPart(JSON.stringify({ runId: config.runId, ...result }))],
    };
  },
});
