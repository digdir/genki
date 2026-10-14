import type { Part } from '@genai/contracts';
import { defaultMaxOutputTokens } from '@genai/port-model';
import { z } from 'zod';
import type { Block, BlockContext } from '../blocks.js';
import {
  buildGenerationPrompt,
  detectInsufficientContext,
  insufficientSentinel,
  systemPromptWithDate,
} from '../prompts.js';
import type { FlowChunk, FlowRetrieval } from '../services.js';
import { contextFromChunks } from './context.js';
import { callModel } from './model.js';

export { contextFromChunks, formatHeaders } from './context.js';

export const SOURCES_MIME = 'application/vnd.genai.sources+json';

const overrides = z.record(z.string(), z.unknown()).optional();

export const chunkSchema = z.looseObject({
  chunkId: z.string(),
}) as unknown as z.ZodType<FlowChunk>;

export const retrievalFor = async (
  ctx: BlockContext,
  extra: Record<string, unknown> | undefined,
): Promise<FlowRetrieval> => {
  if (!ctx.services.retrieval)
    throw new Error(`step ${ctx.step} needs retrieval, and none is configured`);
  const base = ctx.config.knowledge ?? {};
  const config = extra
    ? { ...ctx.config, knowledge: { ...base, retrieval: { ...(base.retrieval ?? {}), ...extra } } }
    : ctx.config;
  return ctx.services.retrieval(ctx.invocation, config);
};

const hits = (chunks: FlowChunk[]) =>
  chunks.map((c) => ({
    id: c.chunkId,
    ...(c.document === undefined ? {} : { document: c.document }),
    ...(c.position === undefined ? {} : { position: c.position }),
    ...(c.score === undefined ? {} : { score: c.score }),
    ...(c.title === undefined ? {} : { title: c.title }),
  }));

const retrieveInput = z.looseObject({
  query: z.string().min(1),
  queries: z.array(z.string()).optional(),
  history: z.array(z.looseObject({ role: z.string(), text: z.string() })).optional(),
});
const retrieveParams = z.strictObject({
  plan: z.boolean().default(true),
  retrieval: overrides,
  inOrder: z
    .strictObject({
      field: z.string().min(1),
      values: z.array(z.union([z.string().min(1), z.number()])),
    })
    .optional(),
});

const searchInOrder = async (
  retrieval: FlowRetrieval,
  queries: string[],
  userIntent: string | undefined,
  order: { field: string; values: (string | number)[] },
  signal: AbortSignal,
) => {
  const seen = new Set<string>();
  const chunks: FlowChunk[] = [];
  for (const value of order.values) {
    const found = await retrieval.retrieve(
      queries,
      { ...(userIntent ? { userIntent } : {}), filters: { [order.field]: [value] } },
      signal,
    );
    for (const chunk of found.chunks)
      if (!seen.has(chunk.chunkId)) {
        seen.add(chunk.chunkId);
        chunks.push(chunk);
      }
  }
  return { chunks };
};

export const retrieveBlock: Block<z.infer<typeof retrieveInput>, z.infer<typeof retrieveParams>> = {
  name: 'retrieve',
  version: '1',
  description: 'Plan queries and retrieve chunks from the service dataset',
  input: retrieveInput,
  params: retrieveParams,
  output: z.looseObject({ queries: z.array(z.string()), chunks: z.array(chunkSchema) }),
  run: async function* (ctx, input, params) {
    const retrieval = await retrievalFor(ctx, params.retrieval);
    const signal = ctx.invocation.signal;
    let queries = input.queries?.filter((q) => q.trim()) ?? [];
    let userIntent: string | undefined;
    if (queries.length === 0 && params.plan) {
      const started = Date.now();
      try {
        const plan = await retrieval.plan(input.query, input.history ?? [], signal);
        queries = plan.queries.filter((q) => q.trim());
        userIntent = plan.userIntent;
      } catch (error) {
        if (signal.aborted) throw error;
      }
      yield {
        type: 'kernel.notice',
        data: {
          kind: 'plan',
          queries,
          ...(userIntent ? { userIntent } : {}),
          ms: Date.now() - started,
        },
      };
    }
    if (queries.length === 0) queries = [input.query];
    const found: { chunks: FlowChunk[]; attribution?: unknown } = params.inOrder?.values.length
      ? await searchInOrder(retrieval, queries, userIntent, params.inOrder, signal)
      : await retrieval.retrieve(queries, userIntent ? { userIntent } : {}, signal);
    yield { type: 'kernel.notice', data: { kind: 'retrieval', hits: hits(found.chunks), queries } };
    return {
      queries,
      ...(userIntent ? { userIntent } : {}),
      chunks: found.chunks,
      ...(found.attribution === undefined ? {} : { attribution: found.attribution }),
    };
  },
};

const rerankInput = z.looseObject({ query: z.string().min(1), chunks: z.array(chunkSchema) });
const rerankParams = z.strictObject({
  contextTopK: z.number().int().positive().default(10),
  maxContextLength: z.number().int().positive().default(8000),
  keepOrder: z.boolean().default(false),
  retrieval: overrides,
});

export const rerankBlock: Block<z.infer<typeof rerankInput>, z.infer<typeof rerankParams>> = {
  name: 'rerank',
  version: '1',
  description: 'Rerank chunks and assemble the context the model reads',
  input: rerankInput,
  params: rerankParams,
  output: z.looseObject({ chunks: z.array(chunkSchema), contextDocs: z.array(z.unknown()) }),
  run: async function* (ctx, input, params) {
    const retrieval = await retrievalFor(ctx, params.retrieval);
    let ranked = input.chunks;
    try {
      if (!params.keepOrder)
        ranked = await retrieval.rerank(input.query, input.chunks, ctx.invocation.signal);
    } catch (error) {
      if (ctx.invocation.signal.aborted) throw error;
      yield {
        type: 'kernel.notice',
        data: { kind: 'step', step: ctx.step, stage: 'rerank-failed' },
      };
    }
    const context = contextFromChunks(ranked, params.contextTopK, params.maxContextLength);
    return {
      chunks: ranked,
      contextChunks: context.used,
      contextDocs: context.docs,
      contextLength: context.length,
    };
  },
};

const citationPattern = /\[(\d+)\]/g;

export const parseCitations = (text: string, index: Record<number, string>) => {
  const found = new Map<number, string>();
  for (const m of text.matchAll(citationPattern)) {
    const n = Number(m[1]);
    const chunkId = index[n];
    if (chunkId !== undefined) found.set(n, chunkId);
  }
  return [...found.entries()]
    .sort(([a], [b]) => a - b)
    .map(([n, chunkId]) => ({ index: n, chunkId }));
};

export const renumberCitations = (
  text: string,
  citations: { index: number; chunkId: string }[],
  index: Record<number, string>,
) => {
  if (citations.length === 0) return { text, citations, index };
  const old = [...new Set(citations.map((c) => c.index))].sort((a, b) => a - b);
  const map = new Map(old.map((o, i) => [o, i + 1]));
  if (old.every((o, i) => o === i + 1)) return { text, citations, index };
  return {
    text: text.replace(citationPattern, (full, n: string) => {
      const next = map.get(Number(n));
      return next === undefined ? full : `[${next}]`;
    }),
    citations: citations.map((c) => ({ ...c, index: map.get(c.index) ?? c.index })),
    index: Object.fromEntries(old.map((o) => [map.get(o), index[o]])) as Record<number, string>,
  };
};

export const validateCitations = (text: string, index: Record<number, string>) => {
  const referenced = new Set([...text.matchAll(citationPattern)].map((m) => Number(m[1])));
  const valid = [...referenced].filter((n) => index[n] !== undefined).sort((a, b) => a - b);
  const invalid = [...referenced].filter((n) => index[n] === undefined).sort((a, b) => a - b);
  return {
    validIndices: valid,
    invalidIndices: invalid,
    allValid: invalid.length === 0,
    totalReferences: referenced.size,
    grounded: valid.length > 0,
  };
};

const contextDoc = z.looseObject({ content: z.string(), source: z.string() });
const synthesizeInput = z.looseObject({
  query: z.string().min(1),
  contextDocs: z.array(contextDoc),
});
const synthesizeParams = z.strictObject({
  generationPrompt: z.string().min(1).optional(),
  systemPrompt: z.string().min(1).optional(),
  temperature: z.number().min(0).max(2).default(0.1),
  maxTokens: z.number().int().positive().optional(),
  maxDocs: z.number().int().positive().optional(),
  answerLength: z.enum(['short', 'medium', 'long']).optional(),
});

const lengthRules = {
  short: 'Answer briefly: at most three sentences.',
  medium: 'Answer in one or two short paragraphs.',
  long: 'Answer thoroughly, and cover every relevant point in the sources.',
};

export const synthesizeBlock: Block<
  z.infer<typeof synthesizeInput>,
  z.infer<typeof synthesizeParams>
> = {
  name: 'synthesize',
  version: '1',
  description: 'Answer from numbered context with [N] citations, as headless-rag synthesis does',
  input: synthesizeInput,
  params: synthesizeParams,
  output: z.looseObject({ response: z.string(), citations: z.array(z.unknown()) }),
  run: async function* (ctx, input, params) {
    const docs = params.maxDocs ? input.contextDocs.slice(0, params.maxDocs) : input.contextDocs;
    const index: Record<number, string> = Object.fromEntries(docs.map((d, i) => [i + 1, d.source]));
    const context = docs.map((d, i) => `[${i + 1}] ${d.content}`).join('\n\n');
    const result = yield* callModel(ctx, {
      purpose: 'answer',
      messages: [
        {
          role: 'system',
          content: params.systemPrompt ?? systemPromptWithDate(ctx.services.now()),
        },
        {
          role: 'user',
          content:
            buildGenerationPrompt(params.generationPrompt, context, input.query) +
            (params.answerLength ? `\n\n${lengthRules[params.answerLength]}` : ''),
        },
      ],
      temperature: params.temperature,
      maxTokens: params.maxTokens ?? defaultMaxOutputTokens,
    });
    const renumbered = renumberCitations(
      result.content,
      parseCitations(result.content, index),
      index,
    );
    const insufficiency = detectInsufficientContext(renumbered.text);
    return {
      response: renumbered.text,
      citations: renumbered.citations,
      citationIndex: renumbered.index,
      citationValidation: validateCitations(renumbered.text, renumbered.index),
      insufficientContext: insufficiency.insufficient,
      insufficientContextSignal: insufficiency.signal,
    };
  },
};

const gateDefaults = {
  minContextDocs: 2,
  minSupportingChunks: 2,
  supportScoreRatio: 0.6,
  minDistinctDocuments: 1,
};

const gateInput = z.looseObject({ chunks: z.array(chunkSchema), contextDocs: z.array(contextDoc) });
const gateParams = z.strictObject({
  minContextDocs: z.number().int().min(0).default(gateDefaults.minContextDocs),
  minSupportingChunks: z.number().int().min(0).default(gateDefaults.minSupportingChunks),
  supportScoreRatio: z.number().min(0).max(1).default(gateDefaults.supportScoreRatio),
  minDistinctDocuments: z.number().int().min(0).default(gateDefaults.minDistinctDocuments),
  minTopScore: z.number().optional(),
});

export const evaluateEvidence = (
  chunks: FlowChunk[],
  contextDocs: unknown[],
  params: z.infer<typeof gateParams>,
) => {
  const docCount = contextDocs.length;
  const scores = chunks.map((c) => c.rerankScore).filter((s): s is number => typeof s === 'number');
  const scored = scores.length > 0;
  const top = scored ? Math.max(...scores) : undefined;
  const supporting =
    top === undefined
      ? undefined
      : scores.filter((s) => s >= params.supportScoreRatio * top).length;
  const documents = new Set(chunks.map((c) => c.document).filter((d) => d !== undefined)).size;
  const reason =
    docCount === 0
      ? 'no-evidence'
      : docCount < params.minContextDocs
        ? 'too-few-sources'
        : scored && params.minTopScore !== undefined && (top as number) < params.minTopScore
          ? 'below-score-floor'
          : scored && (supporting as number) < params.minSupportingChunks
            ? 'uncorroborated'
            : documents > 0 && documents < params.minDistinctDocuments
              ? 'single-document'
              : null;
  return {
    sufficient: reason === null,
    reason,
    summary: {
      contextDocCount: docCount,
      scored,
      topScore: top ?? null,
      supportingChunkCount: supporting ?? null,
      distinctDocumentCount: documents,
      thresholds: params,
    },
  };
};

export const evidenceGateBlock: Block<z.infer<typeof gateInput>, z.infer<typeof gateParams>> = {
  name: 'evidence-gate',
  version: '1',
  description: 'Decide before any model call whether the evidence is thick enough for an overview',
  input: gateInput,
  params: gateParams,
  output: z.looseObject({ sufficient: z.boolean(), gatedContextDocs: z.array(z.unknown()) }),
  run: async function* (_ctx, input, params) {
    yield* [];
    const decision = evaluateEvidence(input.chunks, input.contextDocs, params);
    return { ...decision, gatedContextDocs: decision.sufficient ? input.contextDocs : [] };
  },
};

const finalizeInput = z.looseObject({
  sufficient: z.boolean(),
  declineReason: z.string().nullish(),
  response: z.string().nullish(),
  citations: z.array(z.unknown()).nullish(),
  citationIndex: z.record(z.string(), z.unknown()).nullish(),
  citationValidation: z.looseObject({ allValid: z.boolean() }).nullish(),
  insufficientContext: z.boolean().nullish(),
});

const punctuationOrSpace = /^[\p{P}\s]$/u;

const trimPunctuation = (text: string) => {
  const chars = Array.from(text);
  let start = 0;
  let end = chars.length;
  while (start < end && punctuationOrSpace.test(chars[start] ?? '')) start += 1;
  while (end > start && punctuationOrSpace.test(chars[end - 1] ?? '')) end -= 1;
  return chars.slice(start, end).join('');
};

const sentinelOnly = (text: string) => trimPunctuation(text).toUpperCase() === insufficientSentinel;

export const overviewFinalizeBlock: Block<z.infer<typeof finalizeInput>, Record<string, never>> = {
  name: 'overview-finalize',
  version: '1',
  description: 'Suppress an overview that is declined, uncited or cites sources that do not exist',
  input: finalizeInput,
  params: z.strictObject({}),
  output: z.looseObject({ response: z.string(), declined: z.boolean() }),
  run: async function* (_ctx, input) {
    yield* [];
    const text = input.response ?? '';
    const reason = !input.sufficient
      ? (input.declineReason ?? 'no-evidence')
      : !text.trim() || sentinelOnly(text) || input.insufficientContext === true
        ? 'model-declined'
        : (input.citations ?? []).length === 0
          ? 'uncited'
          : input.citationValidation?.allValid === false
            ? 'invalid-citations'
            : null;
    return reason
      ? {
          response: '',
          overview: null,
          declined: true,
          declineReason: reason,
          citations: [],
          citationIndex: {},
        }
      : {
          response: text,
          overview: text,
          declined: false,
          declineReason: null,
          citations: input.citations ?? [],
          citationIndex: input.citationIndex ?? {},
        };
  },
};

const answerInput = z.looseObject({
  text: z.string().nullish(),
  chunks: z.array(chunkSchema).nullish(),
  citations: z.array(z.looseObject({ index: z.number(), chunkId: z.string() })).nullish(),
  meta: z.record(z.string(), z.unknown()).nullish(),
});

export const sourceRecord = (c: FlowChunk) => ({
  chunkId: c.chunkId,
  ...(c.title === undefined ? {} : { title: c.title }),
  ...(c.url === undefined ? {} : { url: c.url }),
  ...(c.content === undefined ? {} : { text: c.content }),
  ...(c.headers === undefined ? {} : { headers: c.headers }),
  ...(c.document === undefined ? {} : { document: c.document }),
  ...(c.position === undefined ? {} : { position: c.position }),
});

export const answerBlock: Block<z.infer<typeof answerInput>, Record<string, never>> = {
  name: 'answer',
  version: '1',
  description: 'Shape the final answer: text with citations, plus the sources it drew on',
  input: answerInput,
  params: z.strictObject({}),
  output: z.looseObject({ parts: z.array(z.unknown()) }),
  run: async function* (_ctx, input) {
    yield* [];
    const meta = {
      ...(input.meta ?? {}),
      ...(input.citations?.length ? { citations: input.citations } : {}),
    };
    const parts: Part[] = [
      {
        mime: 'text/plain',
        body: { kind: 'text', text: input.text ?? '' },
        ...(Object.keys(meta).length ? { meta } : {}),
      },
      {
        mime: SOURCES_MIME,
        body: { kind: 'json', json: { sources: (input.chunks ?? []).map(sourceRecord) } },
      },
    ];
    return { parts };
  },
};
