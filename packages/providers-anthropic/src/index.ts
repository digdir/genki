import Anthropic, { APIError, APIUserAbortError } from '@anthropic-ai/sdk';
import type {
  ContentBlock,
  ContentBlockParam,
  MessageCreateParamsBase,
  MessageParam,
  StopReason,
  ToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/messages/messages';
import {
  authenticatedFetch,
  errorFromStatus,
  ModelError,
  rejectedParameter,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type DeploymentConfig,
  type EndpointConfig,
  type FinishReason,
  type ModelAdapter,
  type ToolCall,
  type TunableParameter,
} from '@genai/port-model';
import { z } from 'zod';

const endpointOptions = z.strictObject({});
const modelOptions = z.strictObject({
  defaultMaxTokens: z.number().int().positive().default(4096),
});
type ModelOptions = z.infer<typeof modelOptions>;

const finishReasons: Partial<Record<StopReason, FinishReason>> = {
  end_turn: 'stop',
  stop_sequence: 'stop',
  max_tokens: 'length',
  model_context_window_exceeded: 'length',
  tool_use: 'tool_calls',
  refusal: 'content_filter',
};

const parseArguments = (raw: string): unknown => {
  try {
    return JSON.parse(raw || '{}');
  } catch {
    return {};
  }
};

const assistantContent = (m: Extract<ChatMessage, { role: 'assistant' }>): ContentBlockParam[] => {
  if (Array.isArray(m.continuation)) return m.continuation as ContentBlockParam[];
  return [
    ...(m.content ? [{ type: 'text' as const, text: m.content }] : []),
    ...(m.toolCalls ?? []).map((c) => ({
      type: 'tool_use' as const,
      id: c.id,
      name: c.name,
      input: parseArguments(c.arguments),
    })),
  ];
};

const toAnthropic = (messages: ChatMessage[]) => {
  const system = messages.flatMap((m) => (m.role === 'system' ? [m.content] : [])).join('\n\n');
  const out: MessageParam[] = [];
  for (const m of messages) {
    if (m.role === 'system') continue;
    if (m.role === 'assistant') out.push({ role: 'assistant', content: assistantContent(m) });
    else if (m.role !== 'tool') out.push({ role: 'user', content: m.content });
    else {
      const result: ToolResultBlockParam = {
        type: 'tool_result',
        tool_use_id: m.toolCallId,
        content: m.content,
      };
      const last = out.at(-1);
      const mergeable =
        last?.role === 'user' &&
        Array.isArray(last.content) &&
        last.content.every((b) => b.type === 'tool_result');
      if (mergeable) (last.content as ContentBlockParam[]).push(result);
      else out.push({ role: 'user', content: [result] });
    }
  }
  return { system, messages: out };
};

const params = (
  model: DeploymentConfig<ModelOptions>,
  request: ChatRequest,
  omitTemperature = false,
): MessageCreateParamsBase => {
  const { system, messages } = toAnthropic(request.messages);
  const outputConfig = {
    ...(request.reasoning ? { effort: request.reasoning } : {}),
    ...(request.jsonSchema
      ? { format: { type: 'json_schema' as const, schema: request.jsonSchema.schema } }
      : {}),
  };
  return {
    model: model.deployment,
    max_tokens: request.maxTokens ?? model.options.defaultMaxTokens,
    messages,
    ...(system ? { system } : {}),
    ...(request.temperature === undefined || omitTemperature
      ? {}
      : { temperature: request.temperature }),
    ...(request.reasoning ? { thinking: { type: 'adaptive' as const } } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((t) => ({
            name: t.name,
            description: t.description,
            input_schema: { type: 'object' as const, ...t.parameters },
          })),
        }
      : {}),
  };
};

const inputTokens = (u: {
  input_tokens: number;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}) => u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);

const cached = (u: { cache_read_input_tokens?: number | null }) =>
  u.cache_read_input_tokens ? { cachedInputTokens: u.cache_read_input_tokens } : {};

const hasThinking = (blocks: { type: string }[]) =>
  blocks.some((b) => b.type === 'thinking' || b.type === 'redacted_thinking');

const fromContent = (blocks: ContentBlock[]) => ({
  content: blocks.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
  toolCalls: blocks.flatMap((b) =>
    b.type === 'tool_use' ? [{ id: b.id, name: b.name, arguments: JSON.stringify(b.input) }] : [],
  ),
  ...(hasThinking(blocks) ? { continuation: blocks } : {}),
});

const toModelError = (error: unknown): ModelError => {
  if (error instanceof ModelError) return error;
  if (error instanceof APIUserAbortError)
    return new ModelError('cancelled', 'the request was cancelled');
  if (error instanceof APIError) return errorFromStatus(error.status, error.message);
  return new ModelError('unavailable', error instanceof Error ? error.message : String(error));
};

type StreamBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; json: string }
  | { type: 'thinking'; thinking: string; signature: string }
  | { type: 'redacted_thinking'; data: string };

const toBlock = (b: StreamBlock): ContentBlockParam =>
  b.type === 'tool_use'
    ? { type: 'tool_use', id: b.id, name: b.name, input: parseArguments(b.json) }
    : b;

export const anthropicMessages: ModelAdapter<z.infer<typeof endpointOptions>, ModelOptions> = {
  protocol: 'anthropic-messages',
  endpointOptions,
  modelOptions,

  connect(endpoint: EndpointConfig) {
    const client = new Anthropic({
      baseURL: endpoint.baseURL,
      apiKey: 'replaced-by-fetch',
      authToken: null,
      credentials: null,
      fetch: authenticatedFetch(
        endpoint.credential,
        'x-api-key',
        ['x-api-key', 'authorization'],
        endpoint.fetch,
      ),
      maxRetries: endpoint.maxRetries,
      timeout: endpoint.timeoutMs,
    });

    const noTemperature = new Set<string>();
    const create = async <T>(
      model: DeploymentConfig<ModelOptions>,
      request: ChatRequest,
      send: (body: MessageCreateParamsBase) => Promise<T>,
    ): Promise<{ response: T; dropped: TunableParameter[] }> => {
      const known = request.temperature !== undefined && noTemperature.has(model.deployment);
      try {
        return {
          response: await send(params(model, request, known)),
          dropped: known ? ['temperature'] : [],
        };
      } catch (error) {
        const rejected =
          error instanceof APIError && rejectedParameter(error.status, error.message);
        if (request.temperature === undefined || !rejected) throw error;
        noTemperature.add(model.deployment);
        return { response: await send(params(model, request, true)), dropped: ['temperature'] };
      }
    };

    return {
      chat: async (model, request, signal): Promise<ChatResult> => {
        try {
          const { response: message, dropped } = await create(model, request, (body) =>
            client.messages.create({ ...body, stream: false }, { signal }),
          );
          return {
            ...fromContent(message.content),
            finishReason: (message.stop_reason && finishReasons[message.stop_reason]) || 'other',
            usage: {
              inputTokens: inputTokens(message.usage),
              outputTokens: message.usage.output_tokens,
              ...cached(message.usage),
              requests: 1,
            },
            servedModel: message.model,
            ...(dropped.length ? { droppedParameters: dropped } : {}),
          };
        } catch (error) {
          throw toModelError(error);
        }
      },

      chatStream: async function* (model, request, signal): AsyncIterable<ChatChunk> {
        const blocks = new Map<number, StreamBlock>();
        let served = model.deployment;
        let finish: FinishReason = 'other';
        const usage: ChatResult['usage'] = { inputTokens: 0, outputTokens: 0, requests: 1 };
        const dropped: TunableParameter[] = [];
        try {
          const opened = await create(model, request, (body) =>
            client.messages.create({ ...body, stream: true }, { signal }),
          );
          dropped.push(...opened.dropped);
          for await (const event of opened.response) {
            if (event.type === 'message_start') {
              served = event.message.model || served;
              usage.inputTokens = inputTokens(event.message.usage);
              usage.outputTokens = event.message.usage.output_tokens;
              Object.assign(usage, cached(event.message.usage));
            } else if (event.type === 'content_block_start') {
              const b = event.content_block;
              if (b.type === 'text') blocks.set(event.index, { type: 'text', text: '' });
              else if (b.type === 'tool_use')
                blocks.set(event.index, { type: 'tool_use', id: b.id, name: b.name, json: '' });
              else if (b.type === 'thinking')
                blocks.set(event.index, { type: 'thinking', thinking: '', signature: '' });
              else if (b.type === 'redacted_thinking')
                blocks.set(event.index, { type: 'redacted_thinking', data: b.data });
            } else if (event.type === 'content_block_delta') {
              const block = blocks.get(event.index);
              const d = event.delta;
              if (d.type === 'text_delta' && block?.type === 'text') {
                block.text += d.text;
                yield { kind: 'delta', text: d.text };
              } else if (d.type === 'input_json_delta' && block?.type === 'tool_use')
                block.json += d.partial_json;
              else if (d.type === 'thinking_delta' && block?.type === 'thinking')
                block.thinking += d.thinking;
              else if (d.type === 'signature_delta' && block?.type === 'thinking')
                block.signature += d.signature;
            } else if (event.type === 'message_delta') {
              if (event.delta.stop_reason)
                finish = finishReasons[event.delta.stop_reason] ?? 'other';
              usage.outputTokens = event.usage.output_tokens;
            }
          }
        } catch (error) {
          throw toModelError(error);
        }
        const ordered = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, b]) => b);
        const toolCalls: ToolCall[] = ordered.flatMap((b) =>
          b.type === 'tool_use'
            ? [{ id: b.id, name: b.name, arguments: JSON.stringify(parseArguments(b.json)) }]
            : [],
        );
        yield {
          kind: 'done',
          result: {
            content: ordered.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''),
            toolCalls,
            finishReason: finish,
            usage,
            servedModel: served,
            ...(dropped.length ? { droppedParameters: dropped } : {}),
            ...(hasThinking(ordered) ? { continuation: ordered.map(toBlock) } : {}),
          },
        };
      },
    };
  },
};
