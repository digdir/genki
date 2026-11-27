import { textPart, type Input, type Ref } from '@genai/contracts';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import {
  baseInstructions,
  defaultMaxOutputTokens,
  instructionsConfig,
  languageInstructionsConfig,
  maxInstructionChars,
  ModelError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
  type ToolSpec,
  normaliseCitationMarkers,
  untrustedData,
  untrustedDataNote,
} from '@genai/port-model';
import { textOf, toolRef, type ToolPort } from '@genai/port-tools';
import { z } from 'zod';
import { runtimeSkills } from '@genai/strategy-single-call';
import { inferQueryIntent } from './intent.js';
import {
  activeFiltersInstruction,
  agentTools,
  cutOffToolCallNudge,
  answerInstructionsLead,
  composeSystemPrompt,
  promptSectionIds,
  searchPromptSections,
  type ActiveFilter,
  answerTurnGaps,
  exhaustionDefaults,
  exhaustionNudge,
  honestMisses,
  modelRefusals,
  questionLanguage,
  remainingBudgetNote,
  noToolCallNudge,
  readBeforeAnswerNudge,
  searchScaffold,
  smallTalkCheck,
  systemPromptWithDate,
  toolsOnlyPromptSections,
} from './prompts.js';
import { cardFactsCache, collectCardFacts, serviceCardText } from './service-card.js';
import { executionMetadata, judgedInsufficient } from './execution.js';
import { evaluateRead, type ReadSignal } from './read-signals.js';
import {
  backfillCitations,
  citationsFor,
  settleCitations,
  soundsLikeRefusal,
} from './citation-backfill.js';
import { attachedChunks, attachedNote } from './attached.js';
import {
  chunkIdsToMarkers,
  documentKey,
  dropUnknownMarkers,
  numberByPublished,
  parseCitations,
  sentenceIdFilter,
  sourcesFirst,
  stripPageMarkers,
} from './citations.js';
import { skillCatalog, useSkill, useSkillTool, withLoadedSkills } from './skills.js';
import { sourcesPart, type SourceRecord } from './sources.js';
import type { Evaluator } from './structured.js';
import {
  buildEvidenceSummary,
  clarificationRequest,
  enforceSufficiencyLimit,
  evaluateSufficiency,
  gateSystemHint,
  groundingDecision,
  responseValidationHint,
  confidentReadSignalFinalize,
  shadowGateDecision,
  shouldRunResponseValidation,
  standsWhenUnsure,
  type ClarificationRequest,
  type SufficiencyDecision,
} from './sufficiency.js';
import {
  isServiceFactsRef,
  runServiceFacts,
  serviceFactsTool,
  type ServiceFactsLookup,
} from './service-facts.js';
import { isSourceFactsRef, runSourceFacts, sourceFactsTool } from './source-facts.js';
import {
  defaultSearchSettings,
  insufficientContextResponse,
  isBuiltinTool,
  parseArguments,
  runBuiltinTool,
  type BuiltinToolName,
  type ToolEnvironment,
  type ToolOutcome,
} from './tools.js';
import {
  aggregateReadSignals,
  filtersApplied,
  rangeReadHintText,
  rangeReadSuggestion,
  recordReadEvaluation,
  Workspace,
  type AgentRetrieval,
  type Chunk,
  type ConversationTurn,
} from './workspace.js';

export * from './attached.js';
export * from './citation-backfill.js';
export * from './citations.js';
export * from './execution.js';
export * from './intent.js';
export * from './prompts.js';
export * from './service-card.js';
export * from './read-signals.js';
export * from './skills.js';
export * from './service-facts.js';
export * from './source-facts.js';
export * from './sources.js';
export * from './structured.js';
export * from './sufficiency.js';
export * from './tools.js';
export * from './workspace.js';

export const ablatableStages = [
  'read-signal-eval',
  'sufficiency-gate',
  'grounding-gate',
  'response-validation',
] as const;

export const modelRoles = z.looseObject({
  synthesis: z.string().min(1).optional(),
  planner: z.string().min(1).optional(),
  judge: z.string().min(1).optional(),
});

interface Refusal {
  category?: string;
}

/** A blank answer the provider filtered: the model refused, and asking again gets the same. */
const refusalOf = (result: ChatResult): Refusal | undefined =>
  result.finishReason === 'content_filter' && result.toolCalls.length === 0 && blank(result.content)
    ? result.stopDetail?.category
      ? { category: result.stopDetail.category }
      : {}
    : undefined;

const refusedNotice = (refusal: Refusal, iteration: number): Emitted => ({
  type: 'kernel.notice',
  data: { stage: 'model-refused', iteration, ...refusal },
});

export const sessionFor = (
  ctx: InvocationContext,
  model: AgentLoopRuntimeConfig['model'],
  role: 'synthesis' | 'planner' | 'judge',
  shared?: ModelSession,
) => {
  const id = model.roles?.[role];
  if (id && id !== model.primary) return new ModelSession(ctx, { ...model, primary: id });
  return shared ?? new ModelSession(ctx, model);
};

export const agentLoopConfig = z.strictObject({
  instructions: instructionsConfig.optional(),
  promptSections: z
    .partialRecord(z.enum(promptSectionIds), z.string().max(maxInstructionChars))
    .optional(),
  languageInstructions: languageInstructionsConfig.optional(),
  generationPrompt: z.string().min(1).optional(),
  budget: z
    .strictObject({
      searches: z.number().int().positive().optional(),
      reads: z.number().int().positive().optional(),
      readChars: z.number().int().positive().optional(),
      chunksPerRead: z.number().int().min(1).max(50).optional(),
      seconds: z.number().int().min(10).max(600).optional(),
    })
    .optional(),
  maxIterations: z.number().int().min(1).max(30).optional(),
  temperature: z.number().min(0).max(2).optional(),
  synthesisTemperature: z.number().min(0).max(2).optional(),
  synthesisMaxTokens: z.number().int().positive().optional(),
  evaluatorTemperature: z.number().min(0).max(2).optional(),
  noToolCallRetry: z.boolean().optional(),
  noAnswerText: z.string().min(1).max(500).optional(),
  instructionsInAnswer: z.boolean().optional(),
  citeBy: z.enum(['document', 'excerpt']).optional(),
  sources: z.enum(['cited', 'read']).optional(),
  search: z
    .strictObject({
      titleOverlapWeight: z.number().min(0).max(20).optional(),
      strategyQuota: z.number().int().min(0).max(10).optional(),
      autoReadTopK: z.number().int().min(0).max(10).optional(),
      displayLimit: z.number().int().min(1).max(100).optional(),
      snippets: z.boolean().optional(),
    })
    .optional(),
  ablate: z.array(z.enum(ablatableStages)).optional(),
});

export type AgentLoopConfig = z.infer<typeof agentLoopConfig>;

export const agentLoopRuntimeConfig = z.looseObject({
  strategy: agentLoopConfig,
  model: z.looseObject({
    primary: z.string().min(1),
    fallback: z.string().min(1).optional(),
    tenant: z.string().min(1).optional(),
    roles: modelRoles.optional(),
  }),
  tools: z.array(z.string().min(1)).optional(),
  skills: runtimeSkills,
});

export type AgentLoopRuntimeConfig = z.infer<typeof agentLoopRuntimeConfig>;

export interface RetrievalRequest {
  overrides?: Record<string, unknown>;
}

export type RetrievalFactory = (
  ctx: InvocationContext,
  config: AgentLoopRuntimeConfig,
  request: RetrievalRequest,
) => AgentRetrieval | undefined | Promise<AgentRetrieval | undefined>;

const noDataset = () => Promise.reject(new Error('the service has no dataset to search'));

const withoutDataset: AgentRetrieval = {
  search: noDataset,
  read: noDataset,
  readRange: noDataset,
  plan: noDataset,
  rerank: noDataset,
  reranks: false,
  filterFields: noDataset,
  facets: noDataset,
};

export const readRetrievalRequest = (input: Input): RetrievalRequest => {
  const data = input.data as Record<string, unknown> | undefined;
  const overrides = data && typeof data === 'object' ? data.overrides : undefined;
  return overrides && typeof overrides === 'object' && !Array.isArray(overrides)
    ? { overrides: overrides as Record<string, unknown> }
    : {};
};

export const activeFiltersOf = (request: RetrievalRequest): ActiveFilter[] => {
  const map = request.overrides?.['retrieve-filter-by'] as { fields?: unknown } | undefined;
  return (Array.isArray(map?.fields) ? map.fields : []).flatMap((raw): ActiveFilter[] => {
    const f = (raw ?? {}) as Record<string, unknown>;
    const listed = f['selected-options'] ?? f.selected_options ?? f.options;
    const options = (Array.isArray(listed) ? listed : [])
      .filter((o) => typeof o === 'string' || typeof o === 'number')
      .map(String);
    return typeof f.field === 'string' && options.length
      ? [{ field: f.field, ...(typeof f.type === 'string' ? { type: f.type } : {}), options }]
      : [];
  });
};

export interface AgentLoopOptions {
  retrieval: RetrievalFactory;
  now?: () => Date;
  /** Looks up what service-facts@1 tells that the run itself does not know. */
  serviceFacts?: ServiceFactsLookup;
}

const inputSchema = z.looseObject({
  query: z.string().optional(),
  history: z.array(z.looseObject({ role: z.string(), text: z.string() })).optional(),
});

export const readInput = (input: Input): { query: string; history: ConversationTurn[] } => {
  const data = inputSchema.safeParse(input.data ?? {});
  const fromParts = (input.parts ?? [])
    .flatMap((p) => (p.body.kind === 'text' ? [p.body.text] : []))
    .join('\n')
    .trim();
  const query = (data.success ? data.data.query?.trim() : undefined) || fromParts;
  if (!query) throw new Error('the agent needs a question');
  const history = (data.success ? (data.data.history ?? []) : []).flatMap(
    (m): ConversationTurn[] => {
      const role = m.role === 'user' || m.role === 'assistant' ? m.role : undefined;
      const text = m.text.trim();
      return role && text ? [{ role, text }] : [];
    },
  );
  const last = history.at(-1);
  return {
    query,
    history: last?.role === 'user' && last.text === query ? history.slice(0, -1) : history,
  };
};

const retryable = (error: unknown) =>
  error instanceof ModelError && (error.code === 'rate_limited' || error.code === 'unavailable');

export class ModelSession {
  #port: ModelPort | undefined;
  #onFallback = false;

  constructor(
    private readonly ctx: InvocationContext,
    private readonly model: AgentLoopRuntimeConfig['model'],
  ) {}

  #ref(id: string): Ref {
    return { kind: 'model', id, tenant: this.model.tenant ?? this.ctx.tenant };
  }

  async #current(): Promise<ModelPort> {
    this.#port ??= await this.ctx.use<ModelPort>('model', this.#ref(this.model.primary));
    return this.#port;
  }

  async #withFallback<T>(
    run: (port: ModelPort) => Promise<T>,
    allowFallback: () => boolean,
  ): Promise<T> {
    try {
      return await run(await this.#current());
    } catch (error) {
      if (
        this.#onFallback ||
        !this.model.fallback ||
        !retryable(error) ||
        this.ctx.signal.aborted ||
        !allowFallback()
      )
        throw error;
      this.#onFallback = true;
      this.#port = await this.ctx.use<ModelPort>('model', this.#ref(this.model.fallback));
      return run(this.#port);
    }
  }

  chat(request: ChatRequest, onDelta?: (text: string) => void): Promise<ChatResult> {
    let delivered = false;
    return this.#withFallback(
      async (port) => {
        if (!onDelta || !port.info().capabilities.includes('stream')) return port.chat(request);
        for await (const chunk of port.chatStream(request)) {
          if (chunk.kind === 'done') return chunk.result;
          if (chunk.text === '') continue;
          delivered = true;
          onDelta(chunk.text);
        }
        throw new ModelError('unavailable', 'the stream ended without a result');
      },
      () => !delivered,
    );
  }

  async text(request: ChatRequest, onDelta?: (text: string) => void): Promise<string> {
    return (await this.chat(request, onDelta)).content;
  }
}

export async function* withDeltas<T>(
  work: (push: (text: string) => void) => Promise<T>,
): AsyncGenerator<Emitted, T> {
  const queue: string[] = [];
  let wake: (() => void) | undefined;
  let done = false;
  let failure: { error: unknown } | undefined;
  let value: T | undefined;
  const running = work((text) => {
    queue.push(text);
    wake?.();
  }).then(
    (v) => {
      value = v;
    },
    (error: unknown) => {
      failure = { error };
    },
  );
  void running.finally(() => {
    done = true;
    wake?.();
  });
  for (;;) {
    while (queue.length > 0)
      yield { type: 'kernel.part.delta', data: { text: queue.shift() as string } };
    if (done) break;
    await new Promise<void>((resolve) => {
      wake = resolve;
    });
    wake = undefined;
  }
  await running;
  if (failure) throw failure.error;
  return value as T;
}

export const sourceRecord = (c: Chunk): SourceRecord => ({
  chunkId: c.chunkId,
  ...(c.title === undefined ? {} : { title: c.title }),
  ...(c.url === undefined ? {} : { url: c.url }),
  text: stripPageMarkers(c.content).trim(),
  ...(c.headers?.length ? { headers: c.headers } : {}),
  ...(c.page === undefined ? {} : { page: c.page }),
  ...(c.pageEnd === undefined ? {} : { pageEnd: c.pageEnd }),
  ...(c.fileUrl === undefined ? {} : { fileUrl: c.fileUrl }),
  ...(c.document === undefined ? {} : { document: c.document }),
  ...(c.position === undefined ? {} : { position: c.position }),
  ...(c.version === undefined ? {} : { version: c.version }),
  ...(c.publishedAt === undefined ? {} : { publishedAt: c.publishedAt }),
  ...(c.publisher === undefined ? {} : { publisher: c.publisher }),
});

const blank = (text: string | undefined) => !text || text.trim().length === 0;

// A second sentence explains more than that nothing was found.
const onlySaysNothingFound = (text: string) =>
  text.trim().length <= 200 &&
  text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .filter((s) => s.length > 0).length <= 1;

export const answersFromSnippets = (workspace: Workspace, text: string) => {
  if (blank(text) || soundsLikeRefusal(text)) return false;
  if (workspace.attached.length || workspace.sourceFactsRead) return false;
  if (workspace.searches.length === 0 || workspace.readChunkIds().size > 0) return false;
  const budget = workspace.budget();
  return (
    !budget.readsExhausted &&
    !budget.readCharsExhausted &&
    workspace.searches.some((s) => s.chunkIds.length > 0)
  );
};

export const citedOnly = (chunks: Chunk[], workspace: Workspace): Chunk[] => {
  if (workspace.citations.length === 0) return chunks;
  const cited = new Set(
    workspace.citations.map((c) => documentKey(workspace.chunks.get(c.chunkId) ?? c)),
  );
  return chunks.filter((c) => cited.has(documentKey(c)));
};

interface ExtraTool {
  spec: ToolSpec;
  port: ToolPort;
}

const openExtraTools = async (
  ctx: InvocationContext,
  config: AgentLoopRuntimeConfig,
): Promise<ExtraTool[]> => {
  const refs = (config.tools ?? []).filter(
    (r) => !r.startsWith('rag@') && !isSourceFactsRef(r) && !isServiceFactsRef(r),
  );
  const tools: ExtraTool[] = [];
  for (const ref of refs) {
    const at = ref.lastIndexOf('@');
    const port = await ctx.use<ToolPort>(
      'tools',
      toolRef(ref.slice(0, at), ref.slice(at + 1), config.model.tenant ?? ctx.tenant),
    );
    const definition = port.definition();
    if (
      isBuiltinTool(definition.name) ||
      definition.name === useSkillTool.name ||
      definition.name === sourceFactsTool.name ||
      definition.name === serviceFactsTool.name
    )
      throw new Error(`tool ${ref} collides with the built-in tool ${definition.name}`);
    tools.push({
      port,
      spec: {
        name: definition.name,
        description: definition.description,
        parameters: definition.input,
      },
    });
  }
  return tools;
};

interface ToolCallResult {
  name: string;
  callId: string;
  content: string;
}

const gateRelevant = (results: ToolCallResult[]) =>
  results.some(
    (r) =>
      r.name === 'read_chunks' || r.name === 'rerank_results' || r.name === 'generate_response',
  );

const cardCaches = new WeakMap<AgentLoopOptions, ReturnType<typeof cardFactsCache>>();

const cardCacheFor = (options: AgentLoopOptions) => {
  const found = cardCaches.get(options) ?? cardFactsCache(options.now ?? (() => new Date()));
  cardCaches.set(options, found);
  return found;
};

const withGateHint = (results: ToolCallResult[], hint: string) =>
  results.map((r) =>
    r.name === 'generate_response' ? { ...r, content: `${r.content}\n\n${hint}` } : r,
  );

const latestGaps = (workspace: Workspace) =>
  [
    ...new Set(
      [...workspace.sufficiencyDecisions, ...workspace.responseValidations]
        .filter((d) => d.status !== 'sufficient')
        .flatMap((d) => d.missingInfo),
    ),
  ].slice(-5);

export const createAgentLoop = (options: AgentLoopOptions): Strategy<AgentLoopRuntimeConfig> => ({
  id: 'agent-loop',
  version: '1',
  requires: { kernel: 1, ports: ['model', 'tools'], features: [] },

  run: async function* (ctx: InvocationContext, input: Input, raw: AgentLoopRuntimeConfig) {
    const runStarted = Date.now();
    const config = agentLoopRuntimeConfig.parse(raw);
    const settings = config.strategy;
    const citeBy = settings.citeBy ?? 'document';
    const ablated = new Set(settings.ablate ?? []);
    const { query, history } = readInput(input);
    const workspace = new Workspace({
      searches: settings.budget?.searches ?? 4,
      reads: settings.budget?.reads ?? 6,
      readChars: settings.budget?.readChars ?? 12000,
      ...(settings.budget?.chunksPerRead === undefined
        ? {}
        : { chunksPerRead: settings.budget.chunksPerRead }),
    });
    workspace.queryIntent = inferQueryIntent(query, history);
    workspace.attached = attachedChunks(input);
    const retrievalRequest = readRetrievalRequest(input);
    const activeFilters = activeFiltersOf(retrievalRequest);
    const searchable = await options.retrieval(ctx, config, retrievalRequest);
    const retrieval = searchable ?? withoutDataset;
    const extra = await openExtraTools(ctx, config);
    const session = new ModelSession(ctx, config.model);
    const synthesisSession = sessionFor(ctx, config.model, 'synthesis', session);
    const judgeSession = sessionFor(ctx, config.model, 'judge', session);
    const maxIterations = settings.maxIterations ?? 10;
    const toolRounds = Math.max(1, maxIterations - 1);
    const clock = options.now ?? (() => new Date());
    const startedAt = clock().getTime();
    const seconds = settings.budget?.seconds;
    const secondsLeft = () =>
      seconds === undefined
        ? undefined
        : Math.max(0, seconds - Math.floor((clock().getTime() - startedAt) / 1000));
    const language = questionLanguage(
      query,
      Array.isArray(config.languages) ? config.languages[0] : undefined,
    );
    const temperature = settings.temperature ?? 0.1;
    const skills = config.skills ?? [];
    const sourceFactsOn = Boolean(
      searchable?.sourceFacts && (config.tools ?? []).some(isSourceFactsRef),
    );
    const serviceFactsLookup = options.serviceFacts;
    const serviceFactsOn = Boolean(
      serviceFactsLookup && (config.tools ?? []).some(isServiceFactsRef),
    );
    const toolSpecs = [
      ...(searchable ? agentTools : []),
      ...(sourceFactsOn ? [sourceFactsTool] : []),
      ...(serviceFactsOn ? [serviceFactsTool] : []),
      ...(skills.length ? [useSkillTool] : []),
      ...extra.map((t) => t.spec),
    ];
    const searchSettings = {
      titleOverlapWeight:
        settings.search?.titleOverlapWeight ?? defaultSearchSettings.titleOverlapWeight,
      strategyQuota: settings.search?.strategyQuota ?? defaultSearchSettings.strategyQuota,
      autoReadTopK: settings.search?.autoReadTopK ?? defaultSearchSettings.autoReadTopK,
      displayLimit: settings.search?.displayLimit ?? defaultSearchSettings.displayLimit,
      showSnippets: settings.search?.snippets ?? defaultSearchSettings.showSnippets,
    };
    const cardFacts = searchable
      ? await cardCacheFor(options)(
          JSON.stringify([
            ctx.tenant,
            ctx.principal,
            ctx.capability.id,
            ctx.capability.version,
            config['knowledge'] ?? null,
            retrievalRequest.overrides?.['retrieve-filter-by'] ?? null,
          ]),
          () => collectCardFacts(searchable, ctx.signal),
        )
      : { sources: [], filterFields: [], complete: true };
    const card = {
      ...cardFacts,
      name: ctx.capability.title,
      ...(ctx.capability.description ? { purpose: ctx.capability.description } : {}),
      searchable: Boolean(searchable),
      languages: Array.isArray(config.languages) ? (config.languages as string[]) : [],
      filtered: activeFilters.length > 0,
      today: clock(),
    };
    const serviceCard = serviceCardText(card);
    const initialMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          `${serviceCard}\n\n` +
          composeSystemPrompt(
            searchable ? searchPromptSections : toolsOnlyPromptSections,
            settings.promptSections,
            settings.instructions ? baseInstructions(settings.instructions) : undefined,
          ) +
          skillCatalog(skills) +
          (activeFilters.length ? `\n\n${activeFiltersInstruction(activeFilters)}` : '') +
          attachedNote(workspace.attached, Boolean(searchable)) +
          `\n\n${untrustedDataNote(config.languages)}`,
      },
      ...history.map((h) => ({ role: h.role, content: h.text })),
      { role: 'user', content: query },
    ];
    let messages = [...initialMessages];
    const extraSources: SourceRecord[] = [];
    const evaluator: Evaluator = async (system, user) =>
      (
        await judgeSession.chat({
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: settings.evaluatorTemperature ?? 0,
        })
      ).content;

    let smallTalk: Promise<boolean> | undefined;
    const isSmallTalk = (text: string) =>
      // The question is data, so it cannot answer the check.
      (smallTalk ??= evaluator(smallTalkCheck, untrustedData('user-message', text)).then(
        (verdict) => /^\s*SMALL_TALK\b/i.test(verdict),
        () => false,
      ));

    const environment = (push: (text: string) => void, onStream: () => void): ToolEnvironment => ({
      workspace,
      retrieval,
      query,
      history,
      signal: ctx.signal,
      // The untrusted-data note comes last, as in the agent's prompt.
      systemPrompt:
        systemPromptWithDate(clock()) +
        `\n\n${serviceCardText(card, true)}` +
        (settings.instructionsInAnswer && settings.instructions
          ? `\n\n${answerInstructionsLead}\n\n${baseInstructions(settings.instructions)}`
          : '') +
        `\n\n${untrustedDataNote(config.languages)}`,
      search: searchSettings,
      synthesize: async (system, user) => {
        const shown =
          citeBy === 'excerpt' ? sentenceIdFilter(push) : { push, end: () => undefined };
        const written = await synthesisSession.chat(
          {
            purpose: 'answer',
            messages: [
              { role: 'system', content: system },
              { role: 'user', content: user },
            ],
            temperature: settings.synthesisTemperature ?? 0.1,
            maxTokens: settings.synthesisMaxTokens ?? defaultMaxOutputTokens,
          },
          (text) => {
            onStream();
            shown.push(text);
          },
        );
        shown.end();
        const refused = refusalOf(written);
        refusal ??= refused;
        return refused ? undefined : written.content;
      },
      ...(settings.generationPrompt ? { generationPrompt: settings.generationPrompt } : {}),
      ...(settings.citeBy ? { citeBy: settings.citeBy } : {}),
    });

    let answer: string | undefined;
    let clarification: ClarificationRequest | undefined;
    let fallbackMessages: ChatMessage[] = initialMessages;
    let phase: 'default' | 'finalize' = 'default';
    let finalized = false;
    let refusal: Refusal | undefined;
    let iteration = 0;
    let lastIteration = 0;
    let readNudges = 0;
    let draftRepairs = 0;
    const reactStarted = Date.now();
    const budgetNote = () => {
      const b = workspace.budget();
      return remainingBudgetNote([
        ['rounds', Math.max(0, toolRounds - iteration - 1), toolRounds],
        ...(searchable
          ? ([
              ['searches', b.searchesRemaining, b.maxSearches],
              ['reads', b.readsRemaining, b.maxReads],
              ['characters', b.readCharsRemaining, b.maxReadChars],
            ] as const)
          : []),
        ...(seconds === undefined ? [] : ([['seconds', secondsLeft() ?? 0, seconds]] as const)),
      ]);
    };
    const judgesOff = () => {
      const b = workspace.budget();
      return (
        iteration >= toolRounds - 1 ||
        secondsLeft() === 0 ||
        (b.searchExhausted && (b.readsExhausted || b.readCharsExhausted))
      );
    };

    // The read check of the chunks read in one turn runs alongside the model's next turn (#984).
    let readCheck: { chunkIds: string[]; signal: Promise<ReadSignal> } | undefined;
    const startReadCheck = () => {
      const pending = workspace.drainPendingEval();
      if (!pending.length) return;
      const signal = evaluateRead({
        query,
        intent: workspace.queryIntent ?? inferQueryIntent(query, history),
        plan: workspace.evidencePlan,
        openClaims: workspace.readEvaluations.length
          ? workspace.openGaps
          : (workspace.evidencePlan?.requiredClaims ?? []),
        chunks: pending,
        llm: evaluator,
        signal: ctx.signal,
      });
      // A run that ends while the check runs (cancelled, failed) leaves no unhandled rejection.
      signal.catch(() => undefined);
      readCheck = { chunkIds: pending.map((c) => c.chunkId), signal };
    };
    const applyReadCheck = async (): Promise<Emitted | undefined> => {
      const check = readCheck;
      if (!check) return undefined;
      readCheck = undefined;
      const signal = await check.signal;
      recordReadEvaluation(workspace, { ...signal, chunkIds: check.chunkIds });
      workspace.shadowDecisions.push(
        aggregateReadSignals(workspace, { roundsLeft: toolRounds - iteration - 1 }),
      );
      return {
        type: 'kernel.notice',
        data: { stage: 'read-signal', status: signal.status, degraded: signal.degraded },
      };
    };

    for (; iteration < toolRounds && !finalized; iteration += 1) {
      if (ctx.signal.aborted) throw new Error('cancelled');
      if (secondsLeft() === 0) {
        yield { type: 'kernel.notice', data: { stage: 'time-budget', seconds, iteration } };
        break;
      }
      const tools =
        phase === 'finalize' ? agentTools.filter((t) => t.name === 'generate_response') : toolSpecs;
      lastIteration = iteration;
      yield {
        type: 'kernel.notice',
        data: { event: 'agent/iteration-started', iteration, 'max-iterations': maxIterations },
      };
      const turn = await session.chat({
        purpose: 'answer',
        messages: [...messages],
        tools,
        temperature,
        maxTokens: settings.synthesisMaxTokens ?? defaultMaxOutputTokens,
      });
      const assistant: ChatMessage = {
        role: 'assistant',
        content: turn.content,
        ...(turn.toolCalls.length ? { toolCalls: turn.toolCalls } : {}),
        ...(turn.continuation === undefined ? {} : { continuation: turn.continuation }),
      };

      // A refusal is not asked again: the same messages get the same refusal.
      refusal ??= refusalOf(turn);
      if (refusal) {
        yield refusedNotice(refusal, iteration);
        break;
      }

      if (
        turn.toolCalls.length === 0 ||
        !(turn.finishReason === 'tool_calls' || turn.finishReason === 'stop')
      ) {
        // An answer before any search comes from the model's own knowledge.
        const cutOff = turn.toolCalls.length > 0;
        const guard =
          Boolean(settings.noToolCallRetry) &&
          Boolean(searchable) &&
          workspace.searches.length === 0 &&
          !workspace.sourceFactsRead &&
          !workspace.serviceFactsRead &&
          (cutOff || !(await isSmallTalk(query)));
        if (guard && workspace.noToolCallRetries < 2) {
          workspace.noToolCallRetries += 1;
          messages = cutOff
            ? [...messages, { role: 'system', content: cutOffToolCallNudge }]
            : [...messages, assistant, { role: 'system', content: noToolCallNudge }];
          continue;
        }
        if (
          !cutOff &&
          readNudges < 2 &&
          iteration < toolRounds - 1 &&
          answersFromSnippets(workspace, turn.content)
        ) {
          readNudges += 1;
          messages = [...messages, assistant, { role: 'system', content: readBeforeAnswerNudge }];
          continue;
        }
        answer =
          guard && (history.length === 0 || searchScaffold.test(turn.content))
            ? (settings.noAnswerText ?? honestMisses[language])
            : turn.content;
        if (!blank(answer)) yield { type: 'kernel.part.delta', data: { text: answer } };
        fallbackMessages = initialMessages;
        finalized = true;
        break;
      }

      if (!blank(turn.content))
        yield {
          type: 'kernel.notice',
          data: { event: 'agent/thinking', iteration, reasoning: turn.content },
        };
      // The read check of the turn before ran alongside this model call; its result is applied
      // before this turn's tools, so they and this turn's gates see it.
      const checkedFirst = await applyReadCheck();
      if (checkedFirst) yield checkedFirst;
      let results: ToolCallResult[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      let generated = false;
      let drafted: string | undefined;
      let streamed = false;
      for (const call of turn.toolCalls) {
        const args = parseArguments(call.arguments);
        yield {
          type: 'kernel.notice',
          data: {
            stage: 'tool',
            tool: call.name,
            iteration,
            event: 'tool/call',
            'tool-call': {
              tool: call.name,
              args: args.ok ? args.value : call.arguments,
              iteration,
            },
          },
        };
        const started = Date.now();
        let content: string;
        if (!args.ok) content = `Error: ${args.error}`;
        else if (searchable && isBuiltinTool(call.name)) {
          const outcome: ToolOutcome = yield* withDeltas((push) =>
            runBuiltinTool(
              call.name as BuiltinToolName,
              environment(push, () => {
                streamed = true;
              }),
              args.value,
            ),
          );
          content = outcome.content;
          if (outcome.planned)
            yield { type: 'kernel.notice', data: { kind: 'plan', ...outcome.planned } };
          if (outcome.retrieved)
            yield {
              type: 'kernel.notice',
              data: { kind: 'retrieval', hits: outcome.retrieved, ...outcome.search },
            };
          if (outcome.searchError)
            yield {
              type: 'x.search.error',
              audience: 'audit',
              data: { error: outcome.searchError },
            };
          if (outcome.read)
            yield { type: 'kernel.notice', data: { kind: 'read', ...outcome.read } };
          if (call.name === 'generate_response') {
            generated = true;
            drafted = outcome.generated;
          }
        } else if (sourceFactsOn && call.name === sourceFactsTool.name) {
          const facts = await runSourceFacts(retrieval, args.value, ctx.signal);
          content = facts.content;
          if (facts.ok) workspace.sourceFactsRead = true;
        } else if (serviceFactsLookup && serviceFactsOn && call.name === serviceFactsTool.name) {
          const facts = await runServiceFacts(ctx, serviceFactsLookup, {
            model: config.model.primary,
            languages: Array.isArray(config.languages) ? (config.languages as string[]) : [],
          });
          content = facts.content;
          if (facts.ok) workspace.serviceFactsRead = true;
        } else if (skills.length && call.name === useSkillTool.name) {
          content = useSkill(skills, args.value, workspace.loadedSkills);
        } else {
          const tool = extra.find((t) => t.spec.name === call.name);
          if (!tool)
            content = `Unknown tool: ${call.name}. Available tools: ${toolSpecs.map((t) => t.name).join(', ')}`;
          else {
            const result = await tool.port.call(args.value);
            content = result.parts.some((part) => part.meta?.untrusted === true)
              ? untrustedData(`tool:${call.name}`, textOf(result))
              : textOf(result);
            for (const s of result.sources ?? [])
              extraSources.push({
                chunkId: s.id,
                ...(s.title === undefined ? {} : { title: s.title }),
                ...(s.url === undefined ? {} : { url: s.url }),
                ...(s.text === undefined ? {} : { text: s.text }),
                ...(s.document === undefined ? {} : { document: s.document }),
                ...(s.position === undefined ? {} : { position: s.position }),
              });
          }
        }
        results.push({ name: call.name, callId: call.id, content });
        toolCalls.push({
          tool: call.name,
          args: args.ok ? args.value : call.arguments,
          'ok?': args.ok,
          'duration-ms': Date.now() - started,
          'result-summary': content.slice(0, 400),
        });
      }
      yield {
        type: 'kernel.notice',
        data: { event: 'agent/turn-completed', iteration, 'tool-calls': toolCalls },
      };
      if (refusal) {
        yield refusedNotice(refusal, iteration);
        break;
      }

      const spent = judgesOff();
      if (!ablated.has('read-signal-eval') && !spent) startReadCheck();
      // A turn that wrote an answer is judged on every read, and the turn before the last has no
      // turn after with the judges on, so both wait for their own check.
      const checkedNow =
        generated || iteration + 1 >= toolRounds - 1 ? await applyReadCheck() : undefined;
      if (checkedNow) yield checkedNow;
      const checked = Boolean(checkedFirst ?? checkedNow);
      // A turn whose reads are the first unchecked ones has no check to gate on yet: its gates
      // wait for the turn after. A turn that applied a check gates on it.
      const gatesWait = readCheck !== undefined && !checked;

      const relevant = !gatesWait && (gateRelevant(results) || checked);
      const draft = blank(drafted) ? undefined : drafted;
      const citedDraft = draft !== undefined && Boolean(workspace.citationValidation?.grounded);
      const draftJudged =
        generated &&
        !spent &&
        (citedDraft ? draftRepairs === 0 : draft === undefined || ablated.has('grounding-gate'));
      const shadowRaw = relevant && !spent ? shadowGateDecision(workspace) : undefined;
      const shadowCounted =
        shadowRaw &&
        (generated ||
          shadowRaw.status === 'sufficient' ||
          shadowRaw.suggestedStrategy === 're-search' ||
          shadowRaw.suggestedStrategy === 'ask-clarification')
          ? enforceSufficiencyLimit(workspace, shadowRaw)
          : undefined;
      const weakSufficient =
        shadowCounted?.status === 'sufficient' && !confidentReadSignalFinalize(workspace);
      const shadow =
        shadowCounted && !weakSufficient && !(citedDraft && shadowCounted.status !== 'sufficient')
          ? shadowCounted
          : undefined;
      const lastStatus = workspace.lastReadSignal?.status;
      if (
        checked &&
        (!generated || results.some((r) => r.name === 'read_chunks')) &&
        (lastStatus === 'gap-remaining' || lastStatus === 'unclear' || lastStatus === 'conflicting')
      ) {
        const suggestion = rangeReadSuggestion(workspace);
        if (suggestion) {
          const readAt = results.findIndex((r) => r.name === 'read_chunks');
          const index = readAt === -1 ? results.length - 1 : readAt;
          results = results.map((r, i) =>
            i === index ? { ...r, content: r.content + rangeReadHintText(suggestion) } : r,
          );
        }
      }

      const summary =
        relevant && !shadow && !spent ? buildEvidenceSummary(workspace, query) : undefined;
      const hasUnread = Boolean(
        summary && (summary['unread-chunk-ids'].length || summary['unread-range']),
      );
      const keepable =
        Boolean(summary) &&
        !ablated.has('sufficiency-gate') &&
        (generated ? draftJudged : !hasUnread);
      let sufficiency: SufficiencyDecision | undefined = shadow;
      if (!sufficiency && keepable && summary) {
        const judged = await evaluateSufficiency(query, summary, evaluator, ctx.signal, draft);
        workspace.gateVerdicts.push(judged);
        const decision = enforceSufficiencyLimit(workspace, {
          ...(generated ? standsWhenUnsure(judged) : judged),
          source: 'llm-sufficiency-gate',
        });
        if (generated || (decision.status === 'sufficient' && !hasUnread)) sufficiency = decision;
      }
      const draftRead = generated && sufficiency !== undefined && sufficiency !== shadow;
      const grounding =
        generated && !ablated.has('grounding-gate') ? groundingDecision(workspace) : undefined;
      const effective = grounding ?? sufficiency;
      const hint = effective
        ? gateSystemHint(query, effective, summary ?? buildEvidenceSummary(workspace, query))
        : undefined;
      if (effective && effective.status !== 'sufficient' && generated && hint !== undefined)
        results = withGateHint(results, hint);
      if (effective)
        workspace.sufficiencyDecisions.push({
          ...effective,
          ...(hint === undefined ? {} : { message: hint }),
        });

      let validation: SufficiencyDecision | undefined;
      let validationHint: string | undefined;
      if (
        !ablated.has('response-validation') &&
        draftJudged &&
        !draftRead &&
        (!effective || effective.status === 'sufficient') &&
        shouldRunResponseValidation(workspace)
      ) {
        const s2 = buildEvidenceSummary(workspace, query);
        validation = enforceSufficiencyLimit(workspace, {
          ...standsWhenUnsure(await evaluateSufficiency(query, s2, evaluator, ctx.signal, draft)),
          source: 'response-validation',
        });
        validationHint = responseValidationHint(query, validation, s2);
        if (validation.status !== 'sufficient') results = withGateHint(results, validationHint);
        workspace.responseValidations.push({ ...validation, message: validationHint });
      }

      const active = validation ?? grounding ?? sufficiency;
      const activeHint = validationHint ?? hint;
      const overriddenReadStatus =
        active?.status === 'sufficient' &&
        lastStatus !== undefined &&
        lastStatus !== 'support-found'
          ? lastStatus
          : undefined;
      if (active)
        yield {
          type: 'kernel.notice',
          data: {
            stage: 'gate',
            source: active.source,
            status: active.status,
            strategy: active.suggestedStrategy,
            ...(overriddenReadStatus ? { overriddenReadStatus } : {}),
          },
        };

      const remaining = budgetNote();
      messages = [
        ...messages,
        assistant,
        ...results.map((r): ChatMessage => ({
          role: 'tool',
          toolCallId: r.callId,
          content: `${r.content}\n\n${remaining}`,
        })),
      ];
      fallbackMessages = messages;
      const generatedResponse = workspace.lastGeneratedResponse?.trim()
        ? workspace.lastGeneratedResponse
        : undefined;
      const generateContent = results.find((r) => r.name === 'generate_response')?.content;
      const retryText = workspace.lastGeneratedResponse ?? generateContent ?? '';
      const needsRetry = blank(retryText) || insufficientContextResponse(retryText);
      if (generated)
        workspace.lastGenerateInsufficient =
          needsRetry || Boolean(active && active.status !== 'sufficient');
      const rejected = generated && Boolean(active && active.status !== 'sufficient');
      if (rejected && citedDraft) draftRepairs += 1;
      if (rejected && streamed)
        yield { type: 'kernel.notice', data: { stage: 'answer-discarded', iteration } };

      if (active?.suggestedStrategy === 'ask-clarification') {
        clarification = clarificationRequest(active);
        answer = clarification.question;
        finalized = true;
      } else if (generated && !active && !needsRetry && !blank(generatedResponse)) {
        answer = generatedResponse;
        finalized = true;
      } else if (active?.suggestedStrategy === 'finalize' && !generated) {
        const last = await applyReadCheck();
        if (last) yield last;
        const outcome: ToolOutcome = yield* withDeltas((push) =>
          runBuiltinTool(
            'generate_response',
            environment(push, () => undefined),
            { query },
          ),
        );
        if (refusal) {
          yield refusedNotice(refusal, iteration);
          break;
        }
        const usable =
          workspace.lastGeneratedResponse?.trim() && !workspace.lastGenerateInsufficient
            ? workspace.lastGeneratedResponse
            : undefined;
        answer = usable ?? outcome.content;
        finalized = true;
      } else if (active?.status === 'sufficient' && generated && !needsRetry) {
        answer = generatedResponse ?? '';
        finalized = true;
      } else if (
        active &&
        active.status !== 'sufficient' &&
        active.suggestedStrategy === 'finalize' &&
        generated &&
        !blank(generatedResponse)
      ) {
        answer = generatedResponse;
        finalized = true;
      } else if (active) {
        phase =
          active.suggestedStrategy === 'finalize' && (active.status === 'sufficient' || !generated)
            ? 'finalize'
            : 'default';
        messages = [...messages, { role: 'system', content: activeHint ?? '' }];
      } else phase = 'default';
    }

    // A check still running when the loop ends is applied, so the answer turn sees its gaps.
    const lastCheck = await applyReadCheck();
    if (lastCheck) yield lastCheck;
    const finalizeStarted = Date.now();
    if (!clarification && blank(answer)) {
      const stored = workspace.lastGeneratedResponse?.trim()
        ? workspace.lastGeneratedResponse
        : undefined;
      const cited = Boolean(stored && workspace.citationValidation?.grounded);
      const usable = stored && (cited || !workspace.lastGenerateInsufficient) ? stored : undefined;
      if (usable) answer = usable;
      else if (refusal) {
        answer = modelRefusals[language];
        yield { type: 'kernel.part.delta', data: { text: answer } };
      } else {
        yield {
          type: 'kernel.notice',
          data: { stage: finalized ? 'recovered-empty' : 'exhausted', iterations: iteration },
        };
        const gaps = answerTurnGaps(latestGaps(workspace));
        try {
          const fallback = yield* withDeltas((push) =>
            session.chat(
              {
                purpose: 'answer',
                messages: [
                  ...withLoadedSkills(fallbackMessages, workspace.loadedSkills),
                  ...(gaps ? [{ role: 'system' as const, content: gaps }] : []),
                  { role: 'system', content: exhaustionNudge },
                ],
                temperature,
              },
              push,
            ),
          );
          refusal = refusalOf(fallback);
          if (refusal) {
            yield refusedNotice(refusal, iteration);
            answer = modelRefusals[language];
            yield { type: 'kernel.part.delta', data: { text: answer } };
          } else answer = blank(fallback.content) ? exhaustionDefaults[language] : fallback.content;
        } catch (error) {
          if (!stored || ctx.signal.aborted) throw error;
          answer = stored;
        }
      }
    }

    if (!clarification && answer !== undefined)
      answer = normaliseCitationMarkers(answer, (n) => workspace.citationIndex.has(n));

    if (
      !clarification &&
      answer !== undefined &&
      parseCitations(answer, workspace.citationIndex).length === 0
    ) {
      const marked = chunkIdsToMarkers(answer, [...workspace.chunks.values()], citeBy);
      if (marked) {
        workspace.citationIndex = marked.index;
        workspace.citationQuotes = new Map();
        workspace.sentenceIds = { located: 0, missed: 0 };
        workspace.sourceOrder = marked.chunks;
        yield { type: 'kernel.notice', data: { stage: 'answer-discarded', reason: 'chunk-ids' } };
        yield { type: 'kernel.part.delta', data: { text: marked.text } };
        answer = marked.text;
      }
    }

    if (
      !clarification &&
      answer !== undefined &&
      !(refusal && answer === modelRefusals[language])
    ) {
      const settlement = settleCitations(answer, workspace);
      let settled: string | undefined;
      if (settlement.action === 'carry-through') settled = workspace.lastGeneratedResponse;
      else if (settlement.action === 'decline') settled = settlement.text;
      else if (settlement.action === 'backfill') {
        try {
          settled = await backfillCitations(
            environment(
              () => undefined,
              () => undefined,
            ),
            settlement.readFirst,
            settlement.refusal,
            answer,
          );
        } catch (error) {
          if (ctx.signal.aborted) throw error;
        }
      }
      yield {
        type: 'kernel.notice',
        data: {
          stage: 'citations',
          action: settlement.action,
          ...(settlement.action === 'keep' ? { reason: settlement.reason } : {}),
          ...(settlement.action === 'backfill' ? { adopted: settled !== undefined } : {}),
        },
      };
      let resent = false;
      if (settled !== undefined && settled !== answer) {
        const reason = settlement.action === 'decline' ? 'beyond-decline' : 'uncited';
        yield { type: 'kernel.notice', data: { stage: 'answer-discarded', reason } };
        yield { type: 'kernel.part.delta', data: { text: settled } };
        answer = settled;
        resent = true;
      }
      // Quotes belong to the answer they were read from, never to one the loop wrote itself.
      if (answer !== workspace.quotedText) {
        workspace.citationQuotes = new Map();
        workspace.sentenceIds = { located: 0, missed: 0 };
      } else if (workspace.restream && !resent) {
        yield { type: 'kernel.notice', data: { stage: 'answer-discarded', reason: 'renumbered' } };
        yield { type: 'kernel.part.delta', data: { text: answer } };
      }
      if (citeBy === 'excerpt') {
        const shown = dropUnknownMarkers(answer, workspace.citationIndex);
        if (shown !== answer) {
          yield {
            type: 'kernel.notice',
            data: { stage: 'answer-discarded', reason: 'unknown-markers' },
          };
          yield { type: 'kernel.part.delta', data: { text: shown } };
          answer = shown;
        }
      }
      workspace.citations = citationsFor(answer, workspace);
      if (citeBy === 'excerpt' && workspace.citations.length)
        yield {
          type: 'kernel.notice',
          data: {
            stage: 'sentence-citations',
            located: workspace.citations.filter((c) => workspace.citationQuotes.has(c.index))
              .length,
            missed: workspace.sentenceIds.missed,
            cited: workspace.citations.length,
          },
        };
    }

    const foundNothing =
      !clarification &&
      workspace.citations.length === 0 &&
      (soundsLikeRefusal(answer ?? '') ||
        (settings.noAnswerText !== undefined && answer === settings.noAnswerText));
    // Only a plain miss in the sources gets the service's own words.
    if (
      foundNothing &&
      settings.noAnswerText &&
      answer !== settings.noAnswerText &&
      answer !== exhaustionDefaults[language] &&
      onlySaysNothingFound(answer ?? '') &&
      workspace.searches.length > 0
    ) {
      yield { type: 'kernel.notice', data: { stage: 'answer-discarded', reason: 'no-answer' } };
      yield { type: 'kernel.part.delta', data: { text: settings.noAnswerText } };
      answer = settings.noAnswerText;
    }

    const outputChunks = () =>
      sourcesFirst(
        workspace.sourceOrder.map((c) => workspace.chunks.get(c.chunkId) ?? c),
        workspace.chunksForOutput(),
      );
    const incomplete = outputChunks()
      .filter((c) => c.title === undefined && c.url === undefined)
      .map((c) => c.chunkId);
    if (incomplete.length && searchable) {
      try {
        for (const full of await retrieval.read(incomplete, ctx.signal)) {
          const known = workspace.chunks.get(full.chunkId);
          if (known)
            workspace.chunks.set(full.chunkId, {
              ...full,
              ...known,
              ...(full.title === undefined ? {} : { title: full.title }),
              ...(full.url === undefined ? {} : { url: full.url }),
            });
        }
      } catch (error) {
        if (ctx.signal.aborted) throw error;
      }
    }
    const publishedChunks =
      settings.sources === 'read' ? outputChunks() : citedOnly(outputChunks(), workspace);
    if (!clarification && citeBy !== 'excerpt' && answer && workspace.citations.length) {
      const numbered = numberByPublished(answer, workspace.citations, publishedChunks, (id) =>
        workspace.chunks.get(id),
      );
      workspace.citations = numbered.citations;
      workspace.citationIndex = numbered.index;
      workspace.citationQuotes = new Map();
      if (numbered.text !== answer) {
        yield { type: 'kernel.notice', data: { stage: 'answer-discarded', reason: 'renumbered' } };
        yield { type: 'kernel.part.delta', data: { text: numbered.text } };
        answer = numbered.text;
      }
    }
    const published = publishedChunks.map(sourceRecord);
    yield {
      type: 'kernel.notice',
      data: {
        event: 'agent/finalized',
        iteration: lastIteration,
        'response-length': (answer ?? '').length,
      },
    };

    yield {
      type: 'kernel.result',
      data: [
        {
          ...textPart(answer ?? ''),
          meta: {
            citations: clarification
              ? []
              : workspace.citations.map((c) => {
                  const chunk = workspace.chunks.get(c.chunkId);
                  const quote = workspace.citationQuotes.get(c.index);
                  return {
                    index: c.index,
                    chunkId: c.chunkId,
                    ...(citeBy === 'excerpt' && chunk ? { document: documentKey(chunk) } : {}),
                    ...(citeBy === 'excerpt' && quote ? { quote } : {}),
                  };
                }),
            ...(citeBy === 'excerpt' ? { citeBy } : {}),
            ...(foundNothing ? { noAnswer: true } : {}),
          },
        },
        sourcesPart([...published, ...extraSources], clarification, {
          filtersApplied: filtersApplied(workspace.searches),
          insufficient: judgedInsufficient(workspace),
          executionMetadata: executionMetadata({
            setup: reactStarted - runStarted,
            react: finalizeStarted - reactStarted,
            finalize: Date.now() - finalizeStarted,
          }),
        }),
      ],
    };
  },
});
export * from './schema-labels.js';
