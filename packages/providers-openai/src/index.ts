import {
  authenticatedFetch,
  authHeaders,
  errorFromStatus,
  discoveredKind,
  listedCapabilities,
  ListingError,
  ModelError,
  rejectedParameter,
  type ChatChunk,
  type ChatMessage,
  type ChatRequest,
  type ChatResult,
  type DeploymentConfig,
  type BuiltInApi,
  type DiscoveredDeployment,
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
import { decisionsBody, decisionsPath, decisionsResult } from './decisions.js';
import {
  responsesContinuation,
  responsesParams,
  responsesResult,
  responsesStream,
} from './responses.js';

const withoutTrailingSlashes = (url: string) => {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47) end -= 1;
  return url.slice(0, end);
};

const cached = (tokens: number | undefined) => (tokens ? { cachedInputTokens: tokens } : {});

const chatCompletionsOptions = z.strictObject({
  tokenParam: z.enum(['max_tokens', 'max_completion_tokens']).default('max_completion_tokens'),
});
type ModelOptions = z.infer<typeof chatCompletionsOptions>;

export const openAiApis = {
  chatCompletions: 'openai/chat-completions@1',
  responses: 'openai/responses@1',
  decide: 'openai/decide@1',
} as const;

const tokenUnits: BuiltInApi['units'] = [
  'input-token',
  'output-token',
  'cached-input-token',
  'request',
];

const apis: BuiltInApi[] = [
  {
    id: openAiApis.chatCompletions,
    kind: 'chat',
    family: 'openai',
    modelOptions: chatCompletionsOptions,
    units: tokenUnits,
    default: true,
  },
  {
    id: openAiApis.responses,
    kind: 'chat',
    family: 'openai',
    modelOptions: z.strictObject({}),
    units: tokenUnits,
  },
  {
    id: openAiApis.decide,
    kind: 'decide',
    family: 'openai',
    modelOptions: z.strictObject({}),
    units: tokenUnits,
  },
];

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

type TokenParam = ModelOptions['tokenParam'];

const refusedTokenParam = (error: unknown) => {
  if (!(error instanceof APIError)) return undefined;
  const rejected = rejectedParameter(error.status, error.message, error.param);
  return rejected === 'temperature' ? undefined : rejected;
};

interface Adjustments {
  fixedTemperature: boolean;
  tokenParam?: TokenParam;
}

const params = (
  model: DeploymentConfig<Partial<ModelOptions>>,
  request: ChatRequest,
  adjust: Adjustments = { fixedTemperature: false },
): ChatCompletionCreateParamsBase => ({
  model: model.deployment,
  messages: request.messages.map(toOpenAi),
  ...(request.temperature === undefined || adjust.fixedTemperature
    ? {}
    : { temperature: request.temperature }),
  ...(request.maxTokens === undefined
    ? {}
    : {
        [adjust.tokenParam ?? model.options.tokenParam ?? 'max_completion_tokens']:
          request.maxTokens,
      }),
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

const toModelError = (error: unknown, signal: AbortSignal): ModelError => {
  if (signal.aborted || error instanceof APIUserAbortError)
    return new ModelError('cancelled', 'the request was cancelled');
  if (error instanceof ModelError) return error;
  if (error instanceof APIError) {
    const code = (error.error as { code?: string } | undefined)?.code ?? error.code ?? undefined;
    return errorFromStatus(error.status, error.message, code, error.message);
  }
  return new ModelError('unavailable', error instanceof Error ? error.message : String(error));
};

export const openAiChat: ModelAdapter<Partial<ModelOptions>> = {
  apis,
  continuation: responsesContinuation,

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
    const tokenParams = new Map<string, TokenParam>();
    const learnedResponses = new Set<string>();
    const configured = (model: DeploymentConfig) => model.api === openAiApis.responses;
    const apiFor = (model: DeploymentConfig) =>
      configured(model) || learnedResponses.has(model.deployment)
        ? 'responses'
        : 'chat-completions';
    const create = async <T>(
      model: DeploymentConfig<Partial<ModelOptions>>,
      request: ChatRequest,
      send: (
        api: 'chat-completions' | 'responses',
        omitTemperature: boolean,
        tokenParam: TokenParam | undefined,
      ) => Promise<T>,
    ): Promise<{ response: T; dropped: TunableParameter[] }> => {
      for (;;) {
        const api = apiFor(model);
        const key = `${api}/${model.deployment}`;
        const omit = fixedTemperature.has(key);
        const tokenParam = tokenParams.get(key);
        try {
          return {
            response: await send(api, omit, tokenParam),
            dropped: request.temperature !== undefined && omit ? ['temperature'] : [],
          };
        } catch (error) {
          const current = model.options.tokenParam ?? 'max_completion_tokens';
          if (request.temperature !== undefined && !omit && rejectsTemperature(error)) {
            fixedTemperature.add(key);
          } else if (
            api === 'chat-completions' &&
            !tokenParam &&
            request.maxTokens !== undefined &&
            refusedTokenParam(error) === current
          ) {
            tokenParams.set(key, current === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens');
          } else if (
            api === 'chat-completions' &&
            !configured(model) &&
            request.tools?.length &&
            error instanceof APIError &&
            error.status === 400 &&
            /^Function tools with reasoning_effort are not supported for \S+ in \/v1\/chat\/completions\. To use function tools, use \/v1\/responses or set reasoning_effort to 'none'\.$/.test(
              (error.error as { message?: string } | undefined)?.message ?? '',
            )
          ) {
            learnedResponses.add(model.deployment);
          } else throw error;
        }
      }
    };

    return {
      describe: (model) => ({
        api: apiFor(model),
        source: configured(model)
          ? 'configured'
          : learnedResponses.has(model.deployment)
            ? 'learned'
            : 'default',
      }),
      chat: async (model, request, signal): Promise<ChatResult> => {
        try {
          const { response: result, dropped } = await create(
            model,
            request,
            async (api, omit, tokenParam) => {
              if (api === 'responses') {
                return {
                  api,
                  response: await client.responses.create(
                    { ...responsesParams(model, request, omit), stream: false },
                    { signal },
                  ),
                } as const;
              }
              return {
                api,
                response: await client.chat.completions.create(
                  {
                    ...params(model, request, {
                      fixedTemperature: omit,
                      ...(tokenParam ? { tokenParam } : {}),
                    }),
                    stream: false,
                  },
                  { signal },
                ),
              } as const;
            },
          );
          if (result.api === 'responses')
            return {
              ...responsesResult(result.response),
              ...(dropped.length ? { droppedParameters: dropped } : {}),
            };
          const response = result.response;
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
          throw toModelError(error, signal);
        }
      },

      decide: async (model, request, signal) => {
        try {
          const raw = await client.post<unknown>(decisionsPath, {
            body: decisionsBody(model, request),
            signal,
          });
          return decisionsResult(model, request, raw);
        } catch (error) {
          throw toModelError(error, signal);
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
          const opened = await create(model, request, async (api, omit, tokenParam) => {
            if (api === 'responses')
              return {
                api,
                stream: await client.responses.create(
                  { ...responsesParams(model, request, omit), stream: true },
                  { signal },
                ),
              } as const;
            return {
              api,
              stream: await client.chat.completions.create(
                {
                  ...params(model, request, {
                    fixedTemperature: omit,
                    ...(tokenParam ? { tokenParam } : {}),
                  }),
                  stream: true,
                  stream_options: { include_usage: true },
                },
                { signal },
              ),
            } as const;
          });
          dropped.push(...opened.dropped);
          if (opened.response.api === 'responses') {
            for await (const chunk of responsesStream(opened.response.stream)) {
              if (signal.aborted) throw new APIUserAbortError();
              yield chunk.kind === 'done' && dropped.length
                ? { kind: 'done', result: { ...chunk.result, droppedParameters: dropped } }
                : chunk;
            }
            return;
          }
          for await (const chunk of opened.response.stream) {
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
          throw toModelError(error, signal);
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

const listed = (deployment: string, model?: string, entry?: unknown): DiscoveredDeployment => {
  const { kind, from, endpoints } = discoveredKind(entry, model ?? deployment);
  return {
    deployment,
    ...(model ? { model } : {}),
    kind,
    kindFrom: from,
    ...(endpoints ? { endpoints } : {}),
  };
};

const maxListingPages = 100;

interface ListingPage {
  data?: unknown;
  has_more?: unknown;
  last_id?: unknown;
  next?: unknown;
  nextLink?: unknown;
}

/** Every entry of a list answer, following `has_more` and `last_id`, or a `next` or `nextLink` on the same origin. */
const listedEntries = async (
  first: string,
  init: () => Promise<RequestInit>,
  what: string,
): Promise<unknown[]> => {
  const origin = new URL(first).origin;
  const entries: unknown[] = [];
  const visited = new Set<string>();
  let url: string | undefined = first;
  while (url) {
    if (visited.size >= maxListingPages)
      throw new ListingError(`listing ${what} gave more than ${maxListingPages} pages`);
    visited.add(url);
    const response = await fetch(url, { ...(await init()), redirect: 'error' });
    if (!response.ok)
      throw new ListingError(
        `listing ${what} failed with HTTP ${response.status}`,
        response.status,
      );
    const page = (await response.json()) as ListingPage;
    const data = Array.isArray(page.data) ? (page.data as unknown[]) : [];
    entries.push(...data);
    const link = typeof page.next === 'string' ? page.next : page.nextLink;
    let next: URL | undefined;
    if (typeof link === 'string' && link) {
      if (!URL.canParse(link, url))
        throw new ListingError(`listing ${what} gave a next page that is not a URL`);
      next = new URL(link, url);
    } else if (page.has_more === true) {
      const lastEntry = data.at(-1) as { id?: unknown } | undefined;
      const last = typeof page.last_id === 'string' ? page.last_id : lastEntry?.id;
      if (typeof last !== 'string' || !last)
        throw new ListingError(`listing ${what} has more pages but names no last id`);
      next = new URL(url);
      next.searchParams.set('after', last);
    }
    if (next && next.origin !== origin)
      throw new ListingError(`listing ${what} pointed its next page at another host`);
    url = next?.href;
    if (url && visited.has(url)) throw new ListingError(`listing ${what} repeats a page`);
  }
  return entries;
};

export const azureDeployments: DiscoverySource = {
  kind: 'azure-deployments',
  list: async (endpoint) => {
    const data = (await listedEntries(
      `${azureRoot(endpoint.baseURL)}/openai/deployments?api-version=2022-12-01`,
      async () => ({
        headers: await authHeaders(endpoint.credential, 'api-key'),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      }),
      'deployments',
    )) as { id?: string; model?: string; status?: string }[];
    return data.flatMap((d) => (d?.id && d.status === 'succeeded' ? [listed(d.id, d.model)] : []));
  },
};

export const openAiModels: DiscoverySource = {
  kind: 'openai-models',
  family: 'openai',
  list: async (endpoint) => {
    const data = (await listedEntries(
      `${withoutTrailingSlashes(endpoint.baseURL)}/models`,
      async () => ({
        headers: await authHeaders(endpoint.credential, 'authorization'),
        signal: AbortSignal.timeout(endpoint.timeoutMs),
      }),
      'models',
    )) as { id?: unknown }[];
    return data.flatMap((m) => {
      if (typeof m?.id !== 'string' || !m.id) return [];
      const found = listedCapabilities(m);
      return [
        { ...listed(m.id, undefined, m), ...(found.length > 0 ? { capabilities: found } : {}) },
      ];
    });
  },
};

export { openAiEmbeddings, openAiEmbeddingsApi } from './embeddings.js';
