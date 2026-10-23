import { textPart, type Input, type Ref } from '@genai/contracts';
import type { Emitted, InvocationContext, Strategy } from '@genai/kernel';
import {
  baseInstructions,
  defaultMaxOutputTokens,
  instructionsConfig,
  languageInstructionsConfig,
  ModelError,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type ModelPort,
  type ToolSpec,
} from '@genai/port-model';
import { textOf, toolRef, type ToolPort } from '@genai/port-tools';
import { z } from 'zod';
import { runtimeSkills } from '@genai/strategy-single-call';
import { inferQueryIntent } from './intent.js';
import {
  activeFiltersInstruction,
  agentTools,
  defaultSystemPrompt,
  type ActiveFilter,
  exhaustionDefault,
  exhaustionNudge,
  noToolCallHonestMiss,
  noToolCallNudge,
  searchScaffold,
  systemPromptWithDate,
} from './prompts.js';
import { executionMetadata, judgedInsufficient } from './execution.js';
import { evaluateRead } from './read-signals.js';
import {
  backfillCitations,
  citationsFor,
  settleCitations,
  soundsLikeRefusal,
} from './citation-backfill.js';
import { attachedChunks, attachedNote } from './attached.js';
import { chunkIdsToMarkers, parseCitations, sourcesFirst, stripPageMarkers } from './citations.js';
import { skillCatalog, useSkill, useSkillTool } from './skills.js';
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
  shadowGateDecision,
  shouldRunResponseValidation,
  type ClarificationRequest,
  type SufficiencyDecision,
} from './sufficiency.js';
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
export * from './read-signals.js';
export * from './skills.js';
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
  languageInstructions: languageInstructionsConfig.optional(),
  generationPrompt: z.string().min(1).optional(),
  budget: z
    .strictObject({
      searches: z.number().int().positive().optional(),
      reads: z.number().int().positive().optional(),
      readChars: z.number().int().positive().optional(),
    })
    .optional(),
  maxIterations: z.number().int().min(1).max(30).optional(),
  temperature: z.number().min(0).max(2).optional(),
  synthesisTemperature: z.number().min(0).max(2).optional(),
  synthesisMaxTokens: z.number().int().positive().optional(),
  evaluatorTemperature: z.number().min(0).max(2).optional(),
  noToolCallRetry: z.boolean().optional(),
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
) => AgentRetrieval | Promise<AgentRetrieval>;

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
  ...(c.document === undefined ? {} : { document: c.document }),
  ...(c.position === undefined ? {} : { position: c.position }),
  ...(c.version === undefined ? {} : { version: c.version }),
  ...(c.publishedAt === undefined ? {} : { publishedAt: c.publishedAt }),
});

const blank = (text: string | undefined) => !text || text.trim().length === 0;

interface ExtraTool {
  spec: ToolSpec;
  port: ToolPort;
}

const openExtraTools = async (
  ctx: InvocationContext,
  config: AgentLoopRuntimeConfig,
): Promise<ExtraTool[]> => {
  const refs = (config.tools ?? []).filter((r) => !r.startsWith('rag@'));
  const tools: ExtraTool[] = [];
  for (const ref of refs) {
    const at = ref.lastIndexOf('@');
    const port = await ctx.use<ToolPort>(
      'tools',
      toolRef(ref.slice(0, at), ref.slice(at + 1), config.model.tenant ?? ctx.tenant),
    );
    const definition = port.definition();
    if (isBuiltinTool(definition.name) || definition.name === useSkillTool.name)
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

const replaceGenerateResult = (results: ToolCallResult[], text: string) =>
  results.map((r) => (r.name === 'generate_response' ? { ...r, content: text } : r));

export const createAgentLoop = (options: AgentLoopOptions): Strategy<AgentLoopRuntimeConfig> => ({
  id: 'agent-loop',
  version: '1',
  requires: { kernel: 1, ports: ['model', 'tools'], features: [] },

  run: async function* (ctx: InvocationContext, input: Input, raw: AgentLoopRuntimeConfig) {
    const runStarted = Date.now();
    const config = agentLoopRuntimeConfig.parse(raw);
    const settings = config.strategy;
    const ablated = new Set(settings.ablate ?? []);
    const { query, history } = readInput(input);
    const workspace = new Workspace({
      searches: settings.budget?.searches ?? 4,
      reads: settings.budget?.reads ?? 6,
      readChars: settings.budget?.readChars ?? 12000,
    });
    workspace.queryIntent = inferQueryIntent(query, history);
    workspace.attached = attachedChunks(input);
    const retrievalRequest = readRetrievalRequest(input);
    const activeFilters = activeFiltersOf(retrievalRequest);
    const retrieval = await options.retrieval(ctx, config, retrievalRequest);
    const extra = await openExtraTools(ctx, config);
    const session = new ModelSession(ctx, config.model);
    const synthesisSession = sessionFor(ctx, config.model, 'synthesis', session);
    const judgeSession = sessionFor(ctx, config.model, 'judge', session);
    const maxIterations = settings.maxIterations ?? 10;
    const temperature = settings.temperature ?? 0.1;
    const skills = config.skills ?? [];
    const toolSpecs = [
      ...agentTools,
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
    const initialMessages: ChatMessage[] = [
      {
        role: 'system',
        content:
          (settings.instructions ? baseInstructions(settings.instructions) : defaultSystemPrompt) +
          skillCatalog(skills) +
          (activeFilters.length ? `\n\n${activeFiltersInstruction(activeFilters)}` : '') +
          attachedNote(workspace.attached),
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

    const environment = (push: (text: string) => void, onStream: () => void): ToolEnvironment => ({
      workspace,
      retrieval,
      query,
      history,
      signal: ctx.signal,
      systemPrompt: systemPromptWithDate((options.now ?? (() => new Date()))()),
      search: searchSettings,
      synthesize: (system, user) =>
        synthesisSession.text(
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
            push(text);
          },
        ),
      ...(settings.generationPrompt ? { generationPrompt: settings.generationPrompt } : {}),
    });

    let answer: string | undefined;
    let clarification: ClarificationRequest | undefined;
    let fallbackMessages: ChatMessage[] = initialMessages;
    let phase: 'default' | 'finalize' = 'default';
    let finalized = false;
    let iteration = 0;
    let lastIteration = 0;
    const reactStarted = Date.now();

    for (; iteration < maxIterations && !finalized; iteration += 1) {
      if (ctx.signal.aborted) throw new Error('cancelled');
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

      if (
        turn.toolCalls.length === 0 ||
        !(turn.finishReason === 'tool_calls' || turn.finishReason === 'stop')
      ) {
        const searched = workspace.searches.length > 0;
        const guard = Boolean(settings.noToolCallRetry);
        if (guard && !searched && workspace.noToolCallRetries < 2) {
          workspace.noToolCallRetries += 1;
          messages = [...messages, assistant, { role: 'system', content: noToolCallNudge }];
          continue;
        }
        answer =
          guard && !searched && searchScaffold.test(turn.content)
            ? noToolCallHonestMiss
            : turn.content;
        if (!blank(answer)) yield { type: 'kernel.part.delta', data: { text: answer } };
        fallbackMessages = workspace.loadedSkills.size ? messages : initialMessages;
        finalized = true;
        break;
      }

      if (!blank(turn.content))
        yield {
          type: 'kernel.notice',
          data: { event: 'agent/thinking', iteration, reasoning: turn.content },
        };
      let results: ToolCallResult[] = [];
      const toolCalls: Record<string, unknown>[] = [];
      let generated = false;
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
        else if (isBuiltinTool(call.name)) {
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
          if (outcome.read)
            yield { type: 'kernel.notice', data: { kind: 'read', ...outcome.read } };
          if (call.name === 'generate_response') generated = true;
        } else if (skills.length && call.name === useSkillTool.name) {
          content = useSkill(skills, args.value, workspace.loadedSkills);
        } else {
          const tool = extra.find((t) => t.spec.name === call.name);
          if (!tool)
            content = `Unknown tool: ${call.name}. Available tools: ${toolSpecs.map((t) => t.name).join(', ')}`;
          else {
            const result = await tool.port.call(args.value);
            content = textOf(result);
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

      if (!ablated.has('read-signal-eval')) {
        const pending = workspace.drainPendingEval();
        if (pending.length) {
          const signal = await evaluateRead({
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
          recordReadEvaluation(workspace, { ...signal, chunkIds: pending.map((c) => c.chunkId) });
          workspace.shadowDecisions.push(aggregateReadSignals(workspace));
          yield {
            type: 'kernel.notice',
            data: { stage: 'read-signal', status: signal.status, degraded: signal.degraded },
          };
        }
      }

      const relevant = gateRelevant(results);
      const shadowRaw = relevant ? shadowGateDecision(workspace) : undefined;
      const shadow =
        shadowRaw &&
        (generated ||
          shadowRaw.status === 'sufficient' ||
          shadowRaw.suggestedStrategy === 're-search' ||
          shadowRaw.suggestedStrategy === 'ask-clarification')
          ? shadowRaw
          : undefined;
      const lastStatus = workspace.lastReadSignal?.status;
      if (
        results.some((r) => r.name === 'read_chunks') &&
        (lastStatus === 'gap-remaining' || lastStatus === 'unclear' || lastStatus === 'conflicting')
      ) {
        const suggestion = rangeReadSuggestion(workspace);
        if (suggestion) {
          const index = results.findIndex((r) => r.name === 'read_chunks');
          results = results.map((r, i) =>
            i === index ? { ...r, content: r.content + rangeReadHintText(suggestion) } : r,
          );
        }
      }

      const summary = relevant && !shadow ? buildEvidenceSummary(workspace, query) : undefined;
      const hasUnread = Boolean(
        summary && (summary['unread-chunk-ids'].length || summary['unread-range']),
      );
      const keepable =
        Boolean(summary) && !ablated.has('sufficiency-gate') && (generated || !hasUnread);
      let sufficiency: SufficiencyDecision | undefined = shadow;
      if (!sufficiency && keepable && summary) {
        const decision = enforceSufficiencyLimit(workspace, {
          ...(await evaluateSufficiency(query, summary, evaluator, ctx.signal)),
          source: 'llm-sufficiency-gate',
        });
        if (generated || (decision.status === 'sufficient' && !hasUnread)) sufficiency = decision;
      }
      const grounding =
        generated && !ablated.has('grounding-gate') ? groundingDecision(workspace) : undefined;
      const effective = grounding ?? sufficiency;
      const hint = effective
        ? gateSystemHint(query, effective, summary ?? buildEvidenceSummary(workspace, query))
        : undefined;
      if (effective && effective.status !== 'sufficient' && generated && hint !== undefined)
        results = replaceGenerateResult(results, hint);
      if (effective)
        workspace.sufficiencyDecisions.push({
          ...effective,
          ...(hint === undefined ? {} : { message: hint }),
        });

      let validation: SufficiencyDecision | undefined;
      let validationHint: string | undefined;
      if (
        !ablated.has('response-validation') &&
        generated &&
        (!effective || effective.status === 'sufficient') &&
        shouldRunResponseValidation(workspace)
      ) {
        const s2 = buildEvidenceSummary(workspace, query);
        validation = enforceSufficiencyLimit(workspace, {
          ...(await evaluateSufficiency(query, s2, evaluator, ctx.signal)),
          source: 'response-validation',
        });
        validationHint = responseValidationHint(query, validation, s2);
        if (validation.status !== 'sufficient')
          results = replaceGenerateResult(results, validationHint);
        workspace.responseValidations.push({ ...validation, message: validationHint });
      }

      const active = validation ?? grounding ?? sufficiency;
      const activeHint = validationHint ?? hint;
      if (active)
        yield {
          type: 'kernel.notice',
          data: {
            stage: 'gate',
            source: active.source,
            status: active.status,
            strategy: active.suggestedStrategy,
          },
        };

      messages = [
        ...messages,
        assistant,
        ...results.map((r): ChatMessage => ({
          role: 'tool',
          toolCallId: r.callId,
          content: r.content,
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
        const outcome: ToolOutcome = yield* withDeltas((push) =>
          runBuiltinTool(
            'generate_response',
            environment(push, () => undefined),
            { query },
          ),
        );
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

    const finalizeStarted = Date.now();
    if (!clarification && blank(answer)) {
      const stored = workspace.lastGeneratedResponse?.trim()
        ? workspace.lastGeneratedResponse
        : undefined;
      const usable = stored && !workspace.lastGenerateInsufficient ? stored : undefined;
      if (usable) answer = usable;
      else {
        yield {
          type: 'kernel.notice',
          data: { stage: finalized ? 'recovered-empty' : 'exhausted', iterations: iteration },
        };
        try {
          const fallback = yield* withDeltas((push) =>
            session.text(
              {
                purpose: 'answer',
                messages: [...fallbackMessages, { role: 'user', content: exhaustionNudge }],
                temperature,
              },
              push,
            ),
          );
          answer = blank(fallback) ? exhaustionDefault : fallback;
        } catch (error) {
          if (!stored || ctx.signal.aborted) throw error;
          answer = stored;
        }
      }
    }

    if (
      !clarification &&
      answer !== undefined &&
      parseCitations(answer, workspace.citationIndex).length === 0
    ) {
      const marked = chunkIdsToMarkers(answer, [...workspace.chunks.values()]);
      if (marked) {
        workspace.citationIndex = marked.index;
        workspace.sourceOrder = marked.chunks;
        yield { type: 'kernel.notice', data: { stage: 'answer-discarded', reason: 'chunk-ids' } };
        yield { type: 'kernel.part.delta', data: { text: marked.text } };
        answer = marked.text;
      }
    }

    if (!clarification && answer !== undefined) {
      const settlement = settleCitations(answer, workspace);
      let settled: string | undefined;
      if (settlement.action === 'carry-through') settled = workspace.lastGeneratedResponse;
      else if (settlement.action === 'backfill') {
        try {
          settled = await backfillCitations(
            environment(
              () => undefined,
              () => undefined,
            ),
            settlement.readFirst,
            settlement.refusal,
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
      if (settled !== undefined && settled !== answer) {
        yield { type: 'kernel.notice', data: { stage: 'answer-discarded', reason: 'uncited' } };
        yield { type: 'kernel.part.delta', data: { text: settled } };
        answer = settled;
      }
      workspace.citations = citationsFor(answer, workspace);
    }

    const outputChunks = () =>
      sourcesFirst(
        workspace.sourceOrder.map((c) => workspace.chunks.get(c.chunkId) ?? c),
        workspace.chunksForOutput(),
      );
    const incomplete = outputChunks()
      .filter((c) => c.title === undefined && c.url === undefined)
      .map((c) => c.chunkId);
    if (incomplete.length) {
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
    const published = outputChunks().map(sourceRecord);
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
              : workspace.citations.map((c) => ({ index: c.index, chunkId: c.chunkId })),
            ...(!clarification &&
            workspace.citations.length === 0 &&
            soundsLikeRefusal(answer ?? '')
              ? { noAnswer: true }
              : {}),
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
