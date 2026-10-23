import {
  ModelError,
  type ChatChunk,
  type ChatRequest,
  type ChatResult,
  type DeploymentConfig,
} from '@genai/port-model';
import type {
  Response,
  ResponseCreateParamsBase,
  ResponseInputItem,
  ResponseOutputItem,
  ResponseStreamEvent,
} from 'openai/resources/responses/responses';
import { z } from 'zod';

const continuationSchema = z.object({
  api: z.literal('openai-responses'),
  reasoning: z.array(
    z.object({
      type: z.literal('reasoning'),
      id: z.string(),
      summary: z.array(z.object({ type: z.literal('summary_text'), text: z.string() })),
      encrypted_content: z.string(),
    }),
  ),
});

export const responsesParams = (
  model: DeploymentConfig,
  request: ChatRequest,
  omitTemperature: boolean,
): ResponseCreateParamsBase => {
  const input: ResponseInputItem[] = [];
  for (const message of request.messages) {
    if (message.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: message.toolCallId,
        output: message.content,
      });
    } else if (message.role === 'assistant') {
      const continuation = continuationSchema.safeParse(message.continuation);
      if (continuation.success) input.push(...continuation.data.reasoning);
      if (message.content) input.push({ role: 'assistant', content: message.content });
      for (const call of message.toolCalls ?? []) {
        input.push({
          type: 'function_call',
          call_id: call.id,
          name: call.name,
          arguments: call.arguments,
        });
      }
    } else {
      input.push({
        role: message.role === 'system' ? 'developer' : 'user',
        content: message.content,
      });
    }
  }
  return {
    model: model.deployment,
    input,
    store: false,
    include: ['reasoning.encrypted_content'],
    ...(request.temperature === undefined || omitTemperature
      ? {}
      : { temperature: request.temperature }),
    ...(request.maxTokens === undefined ? {} : { max_output_tokens: request.maxTokens }),
    ...(request.reasoning ? { reasoning: { effort: request.reasoning } } : {}),
    ...(request.tools?.length
      ? {
          tools: request.tools.map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.parameters,
            strict: false,
          })),
        }
      : {}),
    ...(request.jsonSchema
      ? {
          text: {
            format: {
              type: 'json_schema' as const,
              name: request.jsonSchema.name,
              schema: request.jsonSchema.schema,
              strict: true,
            },
          },
        }
      : {}),
  };
};

export const responsesResult = (response: Response): ChatResult => {
  if (response.error || response.status === 'failed') {
    throw new ModelError(
      String(response.error?.code) === 'content_filter' ? 'content_filtered' : 'unavailable',
      response.error?.message ?? 'the response failed',
    );
  }
  const output = response.output;
  const toolCalls = output.flatMap((item) =>
    item.type === 'function_call'
      ? [{ id: item.call_id, name: item.name, arguments: item.arguments }]
      : [],
  );
  const reasoning = output.flatMap((item) =>
    item.type === 'reasoning' && item.encrypted_content ? [item] : [],
  );
  const reason = response.incomplete_details?.reason;
  return {
    content: output
      .flatMap((item) =>
        item.type === 'message'
          ? item.content.flatMap((part) => (part.type === 'output_text' ? [part.text] : []))
          : [],
      )
      .join(''),
    toolCalls,
    finishReason:
      reason === 'max_output_tokens'
        ? 'length'
        : reason === 'content_filter' ||
            output.some(
              (item) =>
                item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
            )
          ? 'content_filter'
          : response.status !== 'completed'
            ? 'other'
            : toolCalls.length
              ? 'tool_calls'
              : 'stop',
    usage: {
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      ...(response.usage?.input_tokens_details?.cached_tokens
        ? { cachedInputTokens: response.usage.input_tokens_details.cached_tokens }
        : {}),
      requests: 1,
    },
    servedModel: response.model,
    ...(reasoning.length ? { continuation: { api: 'openai-responses', reasoning } } : {}),
  };
};

export async function* responsesStream(
  stream: AsyncIterable<ResponseStreamEvent>,
): AsyncIterable<ChatChunk> {
  const output = new Map<number, ResponseOutputItem>();
  let content = '';
  let terminal: Response | undefined;
  for await (const event of stream) {
    if (event.type === 'response.output_text.delta') {
      content += event.delta;
      yield { kind: 'delta', text: event.delta };
    } else if (
      event.type === 'response.output_item.added' ||
      event.type === 'response.output_item.done'
    ) {
      output.set(event.output_index, event.item);
    } else if (event.type === 'response.function_call_arguments.delta') {
      const call = output.get(event.output_index);
      if (call?.type === 'function_call') call.arguments += event.delta;
    } else if (event.type === 'response.function_call_arguments.done') {
      const call = output.get(event.output_index);
      if (call?.type === 'function_call') call.arguments = event.arguments;
    } else if (
      event.type === 'response.completed' ||
      event.type === 'response.incomplete' ||
      event.type === 'response.failed'
    ) {
      terminal = event.response;
    } else if (event.type === 'error') {
      throw new ModelError(
        event.code === 'content_filter' ? 'content_filtered' : 'unavailable',
        event.message,
      );
    }
  }
  if (!terminal) throw new ModelError('unavailable', 'the response stream ended without a result');
  const result = responsesResult({
    ...terminal,
    output: terminal.output.length
      ? terminal.output
      : [...output.entries()].sort(([a], [b]) => a - b).map(([, item]) => item),
  });
  if (result.content && result.content !== content) {
    if (!result.content.startsWith(content))
      throw new ModelError('unavailable', 'the response stream text was inconsistent');
    yield { kind: 'delta', text: result.content.slice(content.length) };
    content = result.content;
  }
  yield { kind: 'done', result: { ...result, content } };
}
