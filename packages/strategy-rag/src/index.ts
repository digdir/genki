import { textPart, type Input, type Part } from '@genai/contracts';
import type { InvocationContext, Strategy } from '@genai/kernel';
import {
  baseInstructions,
  defaultMaxOutputTokens,
  instructionsConfig,
  languageInstructionsConfig,
} from '@genai/port-model';
import {
  attachedChunks,
  defaultGenerationPrompt,
  generationPromptFor,
  modelRoles,
  sessionFor,
  numberByDocument,
  runtimeSkills,
  skillsSection,
  parseCitations,
  readInput,
  readRetrievalRequest,
  retrievalHits,
  sourceRecord,
  sourceListFilter,
  sourcesPart,
  stripSourceLists,
  systemPromptWithDate,
  withDeltas,
  type Chunk,
  type ConversationTurn,
  type RetrievalRequest,
  type SearchAttribution,
} from '@genai/strategy-agent-loop';
import { z } from 'zod';

export const RETRIEVAL_MIME = 'application/vnd.genai.retrieval+json';

export interface RagRetrieval {
  plan(
    query: string,
    history: ConversationTurn[],
    signal: AbortSignal,
  ): Promise<{ queries: string[]; userIntent?: string }>;
  retrieve(
    queries: string[],
    options: { userIntent?: string },
    signal: AbortSignal,
  ): Promise<{ chunks: Chunk[]; attribution?: SearchAttribution }>;
  rerank(query: string, chunks: Chunk[], signal: AbortSignal): Promise<Chunk[]>;
}

export const ragConfig = z.strictObject({
  generate: z.boolean().optional(),
  topK: z.number().int().min(1).max(100).optional(),
  instructions: instructionsConfig.optional(),
  languageInstructions: languageInstructionsConfig.optional(),
  generationPrompt: z.string().min(1).optional(),
  synthesisTemperature: z.number().min(0).max(2).optional(),
  synthesisMaxTokens: z.number().int().positive().optional(),
  contextTopK: z.number().int().min(1).max(100).optional(),
  maxDocs: z.number().int().min(1).max(100).optional(),
  budget: z
    .strictObject({
      searches: z.number().int().positive().optional(),
      reads: z.number().int().positive().optional(),
      readChars: z.number().int().positive().optional(),
    })
    .optional(),
});

export type RagConfig = z.infer<typeof ragConfig>;

export const ragRuntimeConfig = z.looseObject({
  strategy: ragConfig,
  model: z
    .looseObject({
      primary: z.string().min(1),
      fallback: z.string().min(1).optional(),
      tenant: z.string().min(1).optional(),
      roles: modelRoles.optional(),
    })
    .optional(),
  skills: runtimeSkills,
});

export type RagRuntimeConfig = z.infer<typeof ragRuntimeConfig>;

export interface RagOptions {
  retrieval: (
    ctx: InvocationContext,
    config: RagRuntimeConfig,
    request: RetrievalRequest,
  ) => RagRetrieval | Promise<RagRetrieval>;
  now?: () => Date;
}

const withinDocuments = (chunks: Chunk[], maxDocs: number) => {
  const kept = new Set<string>();
  return chunks.filter((c) => {
    const document = c.document ?? c.chunkId;
    if (kept.has(document)) return true;
    if (kept.size >= maxDocs) return false;
    kept.add(document);
    return true;
  });
};

const planned = async (
  retrieval: RagRetrieval,
  query: string,
  history: ConversationTurn[],
  signal: AbortSignal,
) => {
  try {
    const plan = await retrieval.plan(query, history, signal);
    const queries = plan.queries.filter((q) => q.trim().length > 0);
    return {
      queries: queries.length ? queries : [query],
      ...(plan.userIntent ? { userIntent: plan.userIntent } : {}),
    };
  } catch (error) {
    if (signal.aborted) throw error;
    return { queries: [query] };
  }
};

export const createRagSingleShot = (options: RagOptions): Strategy<RagRuntimeConfig> => ({
  id: 'rag-single-shot',
  version: '1',
  requires: { kernel: 1, ports: ['model'], features: [] },

  run: async function* (ctx: InvocationContext, input: Input, raw: RagRuntimeConfig) {
    const config = ragRuntimeConfig.parse(raw);
    const settings = config.strategy;
    if (settings.generate && !config.model)
      throw new Error('rag-single-shot needs a model to generate');
    const generating = settings.generate !== false && Boolean(config.model);
    const { query, history } = readInput(input);
    const retrieval = await options.retrieval(ctx, config, readRetrievalRequest(input));

    const planStarted = Date.now();
    const plan = await planned(retrieval, query, history, ctx.signal);
    yield {
      type: 'kernel.notice',
      data: { kind: 'plan', ...plan, ms: Date.now() - planStarted },
    };
    const found = await retrieval.retrieve(
      plan.queries,
      plan.userIntent ? { userIntent: plan.userIntent } : {},
      ctx.signal,
    );
    yield {
      type: 'kernel.notice',
      data: { kind: 'retrieval', hits: retrievalHits(found.chunks), queries: plan.queries },
    };

    let ranked = found.chunks;
    const rerankStarted = Date.now();
    let fallback = false;
    try {
      ranked = await retrieval.rerank(query, found.chunks, ctx.signal);
    } catch (error) {
      if (ctx.signal.aborted) throw error;
      fallback = true;
    }
    yield {
      type: 'kernel.notice',
      data: {
        kind: 'rerank',
        ms: Date.now() - rerankStarted,
        fallback,
        count: ranked.length,
        hits: retrievalHits(ranked.slice(0, 5)),
      },
    };
    const window = ranked.slice(
      0,
      (generating ? settings.contextTopK : undefined) ?? settings.topK ?? 10,
    );
    const context = [
      ...attachedChunks(input),
      ...(settings.maxDocs ? withinDocuments(window, settings.maxDocs) : window),
    ];
    yield { type: 'kernel.notice', data: { kind: 'read', chunks: retrievalHits(context) } };
    const retrievalPart: Part = {
      mime: RETRIEVAL_MIME,
      body: {
        kind: 'json',
        json: {
          queries: plan.queries,
          ...(plan.userIntent ? { userIntent: plan.userIntent } : {}),
          ...(found.attribution ? { attribution: found.attribution } : {}),
        },
      },
    };

    if (!generating || !config.model) {
      yield {
        type: 'kernel.result',
        data: [sourcesPart(context.map(sourceRecord)), retrievalPart],
      };
      return;
    }

    const session = sessionFor(ctx, config.model, 'synthesis');
    const numbered = numberByDocument(context);
    const prompt = generationPromptFor(
      settings.generationPrompt ?? defaultGenerationPrompt,
      numbered.context,
      query,
    );
    const generated = yield* withDeltas(async (push) => {
      const filter = sourceListFilter(push);
      const full = await session.text(
        {
          purpose: 'answer',
          messages: [
            {
              role: 'system',
              content:
                (settings.instructions
                  ? baseInstructions(settings.instructions)
                  : systemPromptWithDate((options.now ?? (() => new Date()))())) +
                skillsSection(config.skills),
            },
            { role: 'user', content: prompt },
          ],
          temperature: settings.synthesisTemperature ?? 0.1,
          maxTokens: settings.synthesisMaxTokens ?? defaultMaxOutputTokens,
        },
        filter.push,
      );
      filter.end();
      return full;
    });
    const text = stripSourceLists(generated);
    const citations = parseCitations(text, numbered.index);
    yield {
      type: 'kernel.result',
      data: [
        {
          ...textPart(text),
          meta: {
            citations: citations.map((c) => ({ index: c.index, chunkId: c.chunkId })),
          },
        },
        sourcesPart(numbered.chunks.map(sourceRecord)),
        retrievalPart,
      ],
    };
  },
});
export * from './schema-labels.js';
