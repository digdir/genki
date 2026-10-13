import {
  authenticatedFetch,
  authHeaders,
  errorFromStatus,
  ModelError,
  rejectedParameter,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type DeploymentConfig,
  type DiscoverySource,
  type EndpointConfig,
  type FinishReason,
  type ModelAdapter,
  type ToolCall,
  type TunableParameter,
} from '@genai/port-model';
import OpenAI, { APIError, APIUserAbortError } from 'openai';
import type {
  ChatCompletionCreateParamsBase,
  ChatCompletionMessageParam,
} from 'openai/resources/chat/completions';
import { z } from 'zod';

const withoutTrailingSlashes = (url: string) => {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
};

const cached = (tokens: number | undefined) => (tokens ? { cachedInputTokens: tokens } : {});

const endpointOptions = z.strictObject({});
const modelOptions = z.strictObject({
  tokenParam: z.enum(['max_tokens', 'max_completion_tokens']).default('max_completion_tokens'),
});
type ModelOptions = z.infer<typeof modelOptions>;

const finishReasons: Record<string, FinishReason> = {
  stop: 'stop',
  length: 'length',
  tool_calls: 'tool_calls',
  content_filter: 'content_filter',
};

const toOpenAi = (m: ChatMessage): ChatCompletionMessageParam => {
  if (m.role === 'tool') return { role: 'tool', tool_call_id: m.toolCallId, content: m.content };
  if (m.role === 'assistant') {
    return {
      role: 'assistant',
      content: m.content,
      ...(m.toolCalls?.length
        ? {
            tool_calls: m.toolCalls.map((c) => ({
              id: c.id,
              type: 'function' as const,
              function: { name: c.name, arguments: c.arguments },
            })),
          }
        : {}),
    };
  }
  return { role: m.role, content: m.content };
};

const rejectsTemperature = (error: unknown) =>
  error instanceof APIError && rejectedParameter(error.status, error.message) === 'temperature';

const params = (
  model: DeploymentConfig<ModelOptions>,
  request: ChatRequest,
  fixedTemperature = false,
): ChatCompletionCreateParamsBase => ({
  model: model.deployment,
  messages: request.messages.map(toOpenAi),
  ...(request.temperature === undefined || fixedTemperature
    ? {}
    : { temperature: request.temperature }),
  ...(request.maxTokens === undefined ? {} : { [model.options.tokenParam]: request.maxTokens }),
  ...(request.reasoning ? { reasoning_effort: request.reasoning } : {}),
  ...(request.tools?.length
    ? {
        tools: request.tools.map((t) => ({
          type: 'function' as const,
          function: { name: t.name, description: t.description, parameters: t.parameters },
        })),
      }
    : {}),
  ...(request.jsonSchema
    ? {
        response_format: {
          type: 'json_schema' as const,
          json_schema: {
            name: request.jsonSchema.name,
            schema: request.jsonSchema.schema,
            strict: true,
          },
        },
      }
    : {}),
});

const toModelError = (error: unknown): ModelError => {
  if (error instanceof ModelError) return error;
  if (error instanceof APIUserAbortError)
    return new ModelError('cancelled', 'the request was cancelled');
  if (error instanceof APIError) {
    const code = (error.error as { code?: string } | undefined)?.code ?? error.code ?? undefined;
    return errorFromStatus(error.status, error.message, code);
  }
  return new ModelError('unavailable', error instanceof Error ? error.message : String(error));
};

export const openAiChat: ModelAdapter<z.infer<typeof endpointOptions>, ModelOptions> = {
  protocol: 'openai-chat',
  endpointOptions,
  modelOptions,

  connect(endpoint: EndpointConfig) {
    const client = new OpenAI({
      baseURL: endpoint.baseURL,
      apiKey: 'replaced-by-fetch',
      fetch: authenticatedFetch(
        endpoint.credential,
        'authorization',
        ['authorization'],
        endpoint.fetch,
      ),
      maxRetries: endpoint.maxRetries,
      timeout: endpoint.timeoutMs,
    });

    const fixedTemperature = new Set<string>();
    const create = async <T>(
      model: DeploymentConfig<ModelOptions>,
      request: ChatRequest,
      send: (body: ChatCompletionCreateParamsBase) => Promise<T>,
    ): Promise<{ response: T; dropped: TunableParameter[] }> => {
      const dropsKnown =
        request.temperature !== undefined && fixedTemperature.has(model.deployment);
      try {
        return {
          response: await send(params(model, request, fixedTemperature.has(model.deployment))),
          dropped: dropsKnown ? ['temperature'] : [],
        };
      } catch (error) {
        if (request.temperature === undefined || !rejectsTemperature(error)) throw error;
        fixedTemperature.add(model.deployment);
        return { response: await send(params(model, request, true)), dropped: ['temperature'] };
      }
    };

    return {
      chat: async (model, request, signal): Promise<ChatResult> => {
        try {
          const { response, dropped } = await create(model, request, (body) =>
            client.chat.completions.create({ ...body, stream: false }, { signal }),
          );
          const choice = response.choices[0];
          return {
            content: choice?.message.content ?? '',
            toolCalls: (choice?.message.tool_calls ?? []).flatMap((c) =>
              c.type === 'function'
                ? [{ id: c.id, name: c.function.name, arguments: c.function.arguments }]
                : [],
            ),
            finishReason: finishReasons[choice?.finish_reason ?? ''] ?? 'other',
            usage: {
              inputTokens: response.usage?.prompt_tokens ?? 0,
              outputTokens: response.usage?.completion_tokens ?? 0,
              ...cached(response.usage?.prompt_tokens_details?.cached_tokens),
              requests: 1,
            },
            servedModel: response.model,
            ...(dropped.length ? { droppedParameters: dropped } : {}),
          };
        } catch (error) {
          throw toModelError(error);
        }
      },

      chatStream: async function* (model, request, signal): AsyncIterable<ChatChunk> {
        let content = '';
        let finish: FinishReason = 'other';
        let served = model.deployment;
        let usage: ChatResult['usage'] = { inputTokens: 0, outputTokens: 0, requests: 1 };
        const calls = new Map<number, ToolCall>();
        const dropped: TunableParameter[] = [];
        try {
          const opened = await create(model, request, (body) =>
            client.chat.completions.create(
              { ...body, stream: true, stream_options: { include_usage: true } },
              { signal },
            ),
          );
          dropped.push(...opened.dropped);
          for await (const chunk of opened.response) {
            served = chunk.model || served;
            if (chunk.usage) {
              usage = {
                inputTokens: chunk.usage.prompt_tokens,
                outputTokens: chunk.usage.completion_tokens,
                ...cached(chunk.usage.prompt_tokens_details?.cached_tokens),
                requests: 1,
              };
            }
            const choice = chunk.choices[0];
            if (!choice) continue;
            if (choice.finish_reason) finish = finishReasons[choice.finish_reason] ?? 'other';
            const text = choice.delta.content;
            if (text) {
              content += text;
              yield { kind: 'delta', text };
            }
            for (const d of choice.delta.tool_calls ?? []) {
              const current = calls.get(d.index) ?? { id: '', name: '', arguments: '' };
              calls.set(d.index, {
                id: d.id ?? current.id,
                name: current.name + (d.function?.name ?? ''),
                arguments: current.arguments + (d.function?.arguments ?? ''),
              });
            }
          }
        } catch (error) {
          throw toModelError(error);
        }
        yield {
          kind: 'done',
          result: {
            content,
            toolCalls: [...calls.entries()].sort(([a], [b]) => a - b).map(([, c]) => c),
            finishReason: finish,
            usage,
            servedModel: served,
            ...(dropped.length ? { droppedParameters: dropped } : {}),
          },
        };
      },
    };
  },
};

const azureRoot = (baseURL: string) =>
  withoutTrailingSlashes(baseURL)
    .replace(/\/openai(\/v1)?$/, '')
    .replace(/\/anthropic$/, '');

export const azureDeployments: DiscoverySource = {
  kind: 'azure-deployments',
  list: async (endpoint) => {
    const response = await fetch(
      `${azureRoot(endpoint.baseURL)}/openai/deployments?api-version=2022-12-01`,
      {
        headers: await authHeaders(endpoint.credential, 'api-key'),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      },
    );
    if (!response.ok) throw new Error(`listing deployments failed with HTTP ${response.status}`);
    const body = (await response.json()) as {
      data?: { id?: string; model?: string; status?: string }[];
    };
    return (body.data ?? []).flatMap((d) =>
      d.id && d.status === 'succeeded'
        ? [{ deployment: d.id, ...(d.model ? { model: d.model } : {}) }]
        : [],
    );
  },
};

export { openAiEmbeddings } from './embeddings.js';
