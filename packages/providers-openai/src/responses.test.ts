import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { ModelRouter, type ChatChunk, type ChatRequest } from '@genai/port-model';
import { fakeHttp, testContext, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { openAiChat } from './index.js';

const servers: FakeServer[] = [];
const fake = async (
  reply: (body: Record<string, unknown>, attempt: number, path: string) => FakeReply,
) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});
const text = (value: string) => ({
  type: 'message',
  id: 'msg_1',
  role: 'assistant',
  status: 'completed',
  content: [{ type: 'output_text', text: value, annotations: [] }],
});
const call = (id = 'call_1', name = 'search', args = '{"q":"Oslo"}') => ({
  type: 'function_call',
  id: `fc_${id}`,
  call_id: id,
  name,
  arguments: args,
  status: 'completed',
});
const reasoning = {
  type: 'reasoning',
  id: 'rs_1',
  summary: [],
  encrypted_content: 'opaque-reasoning',
};
const response = (output: Record<string, unknown>[] = [text('Hei')], extra = {}) => ({
  id: 'resp_1',
  object: 'response',
  model: 'gpt-6.1-sol-served',
  status: 'completed',
  output,
  usage: {
    input_tokens: 21,
    output_tokens: 8,
    total_tokens: 29,
    input_tokens_details: { cached_tokens: 13 },
    output_tokens_details: { reasoning_tokens: 3 },
  },
  ...extra,
});
const event = (type: string, extra: Record<string, unknown> = {}) => ({
  event: type,
  data: { type, ...extra },
});
const tools = [
  {
    name: 'search',
    description: 'Search documents',
    parameters: { type: 'object', properties: { q: { type: 'string' } }, required: ['q'] },
  },
];
const ask: ChatRequest = { messages: [{ role: 'user', content: 'Finn Oslo' }] };
const refusal =
  "Function tools with reasoning_effort are not supported for gpt-6.1-sol in /v1/chat/completions. To use function tools, use /v1/responses or set reasoning_effort to 'none'.";
const error = (message: string, status = 400): FakeReply => ({
  status,
  json: { error: { message } },
});
const setup = (
  url: string,
  options: Record<string, unknown> = { api: 'responses' },
  discovery = false,
) => {
  const router = new ModelRouter({
    catalog: {
      endpoints: {
        foundry: {
          protocol: 'openai-chat',
          baseURL: `${url}/v1`,
          auth: { kind: 'bearer', secret: 'secret://env/test-key' },
          ...(discovery
            ? {
                discovery: {
                  source: 'fake',
                  capabilities: ['stream', 'tools', 'json-schema', 'reasoning'],
                },
              }
            : {}),
        },
        other: {
          protocol: 'openai-chat',
          baseURL: `${url}/other/v1`,
          auth: { kind: 'bearer', secret: 'secret://env/test-key' },
        },
      },
      models: discovery
        ? []
        : [
            {
              id: 'foundry/gpt-6.1-sol',
              endpoint: 'foundry',
              deployment: 'gpt-6.1-sol',
              residency: 'norway',
              capabilities: ['stream', 'tools', 'json-schema', 'reasoning'],
              options,
            },
            {
              id: 'foundry/unchanged',
              endpoint: 'foundry',
              deployment: 'unchanged',
              residency: 'norway',
              capabilities: ['tools', 'reasoning'],
            },
            {
              id: 'other/gpt-6.1-sol',
              endpoint: 'other',
              deployment: 'gpt-6.1-sol',
              residency: 'norway',
              capabilities: ['tools', 'reasoning'],
            },
          ],
    },
    adapters: [openAiChat],
    secrets: envSecrets({ TEST_KEY: 'key' }),
    maxRetries: 0,
    sources: [{ kind: 'fake', list: async () => [{ deployment: 'gpt-6.1-sol' }] }],
  });
  const { ctx, metered } = testContext();
  const open = (id = 'foundry/gpt-6.1-sol') => router.open({ kind: 'model', id }, ctx);
  return { router, open, metered };
};
const collect = async (stream: AsyncIterable<ChatChunk>) => {
  const chunks: ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

describe('OpenAI Responses behind the model port', () => {
  it('round-trips full history, function calls and outputs with stateless encrypted reasoning', async () => {
    const { url, seen } = await fake((_body, attempt) => ({
      status: 200,
      json: response(
        attempt === 1 ? [reasoning, text('Looking'), call()] : [text('Oslo is the capital')],
      ),
    }));
    const { open, metered, router } = setup(url);
    const first = await open().chat({
      messages: [{ role: 'system', content: 'Be helpful' }, ...ask.messages],
      tools,
      reasoning: 'high',
    });
    expect(first.toolCalls).toEqual([{ id: 'call_1', name: 'search', arguments: '{"q":"Oslo"}' }]);
    expect(first.finishReason).toBe('tool_calls');
    const final = await open().chat({
      messages: [
        { role: 'system', content: 'Be helpful' },
        ...ask.messages,
        {
          role: 'assistant',
          content: first.content,
          toolCalls: first.toolCalls,
          continuation: first.continuation,
        },
        { role: 'tool', toolCallId: 'call_1', content: 'Capital: Oslo' },
      ],
      tools,
      reasoning: 'high',
    });
    expect(final.content).toBe('Oslo is the capital');
    expect(final.finishReason).toBe('stop');
    expect(seen.map((request) => request.path)).toEqual(['/v1/responses', '/v1/responses']);
    expect(seen[1]?.body.input).toEqual([
      { role: 'developer', content: 'Be helpful' },
      { role: 'user', content: 'Finn Oslo' },
      reasoning,
      { type: 'message', role: 'assistant', content: 'Looking' },
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"Oslo"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Capital: Oslo' },
    ]);
    for (const request of seen) {
      expect(request.body).toMatchObject({
        store: false,
        include: ['reasoning.encrypted_content'],
        tools: [{ type: 'function', ...tools[0], strict: false }],
      });
      expect(request.body).not.toHaveProperty('previous_response_id');
      expect(request.body).not.toHaveProperty('messages');
    }
    expect(metered).toHaveLength(2);
    expect(router.describe()[0]?.transport).toEqual({ api: 'responses', source: 'configured' });
  });

  it.each([false, true])(
    'replays assistant phases and output order with stream=%s',
    async (stream) => {
      const output = [
        { ...text('Checking Oslo'), phase: 'commentary' },
        reasoning,
        call(),
        { ...text('Waiting for search'), id: 'msg_2', phase: 'final_answer' },
      ];
      const { url, seen } = await fake((body, attempt) => ({
        status: 200,
        ...(body.stream
          ? { sse: [event('response.completed', { response: response(output) })] }
          : { json: response(attempt === 1 ? output : [text('Oslo')]) }),
      }));
      const { open } = setup(url);
      const port = open();
      const first = stream
        ? (await collect(port.chatStream({ ...ask, tools }))).find((chunk) => chunk.kind === 'done')
            ?.result
        : await port.chat({ ...ask, tools });
      expect(first).toBeDefined();
      if (!first) throw new Error('the stream ended without a result');
      await port.chat({
        messages: [
          ...ask.messages,
          {
            role: 'assistant',
            content: first.content,
            toolCalls: first.toolCalls,
            continuation: first.continuation,
          },
          { role: 'tool', toolCallId: 'call_1', content: 'Capital: Oslo' },
        ],
        tools,
      });
      expect(seen[1]?.body.input).toEqual([
        ...ask.messages,
        { type: 'message', role: 'assistant', content: 'Checking Oslo', phase: 'commentary' },
        reasoning,
        { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{"q":"Oslo"}' },
        {
          type: 'message',
          role: 'assistant',
          content: 'Waiting for search',
          phase: 'final_answer',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'Capital: Oslo' },
      ]);
    },
  );

  it('accepts an older reasoning-only continuation', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: response() }));
    await setup(url)
      .open()
      .chat({
        messages: [
          ...ask.messages,
          {
            role: 'assistant',
            content: 'Looking',
            toolCalls: [{ id: 'call_1', name: 'search', arguments: '{}' }],
            continuation: { api: 'openai-responses', reasoning: [reasoning] },
          },
          { role: 'tool', toolCallId: 'call_1', content: 'Oslo' },
        ],
        tools,
      });
    expect(seen[0]?.body.input).toEqual([
      ...ask.messages,
      reasoning,
      { role: 'assistant', content: 'Looking' },
      { type: 'function_call', call_id: 'call_1', name: 'search', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'Oslo' },
    ]);
  });

  it.each(['low', 'medium', 'high'] as const)(
    'passes reasoning effort %s and the Responses output ceiling',
    async (effort) => {
      const { url, seen } = await fake(() => ({ status: 200, json: response() }));
      await setup(url)
        .open()
        .chat({ ...ask, reasoning: effort, maxTokens: 57, temperature: 0.5 });
      expect(seen[0]?.body).toMatchObject({
        model: 'gpt-6.1-sol',
        reasoning: { effort },
        max_output_tokens: 57,
        temperature: 0.5,
      });
      expect(seen[0]?.body).not.toHaveProperty('reasoning_effort');
      expect(seen[0]?.body).not.toHaveProperty('max_completion_tokens');
    },
  );

  it('maps JSON schema to strict text.format and counts cached input once in usage', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: response([text('{"answer":"Oslo"}')]),
    }));
    const jsonSchema = {
      name: 'answer',
      schema: {
        type: 'object',
        properties: { answer: { type: 'string' } },
        required: ['answer'],
        additionalProperties: false,
      },
    };
    const { open, metered } = setup(url);
    const result = await open().chat({ ...ask, jsonSchema });
    expect(seen[0]?.body.text).toEqual({
      format: { type: 'json_schema', ...jsonSchema, strict: true },
    });
    expect(result.usage).toEqual({
      inputTokens: 21,
      outputTokens: 8,
      cachedInputTokens: 13,
      requests: 1,
    });
    expect(result.servedModel).toBe('gpt-6.1-sol-served');
    expect(metered[0]?.usage).toEqual(result.usage);
    expect(JSON.parse(result.content)).toEqual({ answer: 'Oslo' });
  });

  it('streams text and assembles interleaved tool arguments by output index without duplicating done values', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      sse: [
        event('response.output_text.delta', { delta: 'Hei ' }),
        event('response.output_text.delta', { delta: 'Oslo' }),
        event('response.output_item.added', { output_index: 2, item: call('b', 'second', '') }),
        event('response.output_item.added', { output_index: 1, item: call('a', 'first', '') }),
        event('response.function_call_arguments.delta', { output_index: 1, delta: '{"q":' }),
        event('response.function_call_arguments.delta', { output_index: 2, delta: '{"n":' }),
        event('response.function_call_arguments.delta', { output_index: 2, delta: '2}' }),
        event('response.function_call_arguments.delta', { output_index: 1, delta: '"Oslo"}' }),
        event('response.function_call_arguments.done', {
          output_index: 1,
          arguments: '{"q":"Oslo"}',
        }),
        event('response.output_item.done', { output_index: 3, item: reasoning }),
        event('response.completed', { response: response([]) }),
      ],
    }));
    const { open, metered } = setup(url);
    const chunks = await collect(open().chatStream({ ...ask, tools }));
    expect(chunks.slice(0, -1)).toEqual([
      { kind: 'delta', text: 'Hei ' },
      { kind: 'delta', text: 'Oslo' },
    ]);
    expect(chunks.at(-1)).toMatchObject({
      kind: 'done',
      result: {
        content: 'Hei Oslo',
        toolCalls: [
          { id: 'a', name: 'first', arguments: '{"q":"Oslo"}' },
          { id: 'b', name: 'second', arguments: '{"n":2}' },
        ],
        finishReason: 'tool_calls',
        usage: { inputTokens: 21, outputTokens: 8, cachedInputTokens: 13, requests: 1 },
        servedModel: 'gpt-6.1-sol-served',
        continuation: { api: 'openai-responses', output: expect.arrayContaining([reasoning]) },
      },
    });
    expect(seen[0]?.body).toMatchObject({ stream: true, store: false });
    expect(seen[0]?.body).not.toHaveProperty('stream_options');
    expect(metered).toHaveLength(1);
  });

  it('uses completed output items and terminal output without appending the same arguments twice', async () => {
    const { url } = await fake(() => ({
      status: 200,
      sse: [
        event('response.output_item.added', { output_index: 0, item: call('a', 'search', '') }),
        event('response.function_call_arguments.delta', { output_index: 0, delta: '{}' }),
        event('response.output_item.done', { output_index: 0, item: call('a', 'search', '{}') }),
        event('response.completed', { response: response([call('a', 'search', '{}')]) }),
      ],
    }));
    expect((await collect(setup(url).open().chatStream(ask))).at(-1)).toMatchObject({
      kind: 'done',
      result: { toolCalls: [{ id: 'a', name: 'search', arguments: '{}' }] },
    });
  });

  it.each([false, true])(
    'learns the exact tools/reasoning 400 on a discovered deployment with stream=%s and remembers across opens and refresh',
    async (stream) => {
      const { url, seen } = await fake((body, _attempt, path) =>
        path.endsWith('/chat/completions')
          ? error(refusal)
          : body.stream
            ? {
                status: 200,
                sse: [
                  event('response.output_text.delta', { delta: 'Hei' }),
                  event('response.completed', { response: response() }),
                ],
              }
            : { status: 200, json: response() },
      );
      const { router, open, metered } = setup(url, {}, true);
      await router.refresh();
      expect(
        router.describe().find((model) => model.id === 'foundry/gpt-6.1-sol')?.transport,
      ).toEqual({ api: 'chat-completions', source: 'default' });
      const request = { ...ask, tools, reasoning: 'high' as const };
      if (stream) await collect(open().chatStream(request));
      else await open().chat(request);
      await router.refresh();
      await open().chat(ask);
      expect(seen.map((request) => request.path)).toEqual([
        '/v1/chat/completions',
        '/v1/responses',
        '/v1/responses',
      ]);
      expect(
        router.describe().find((model) => model.id === 'foundry/gpt-6.1-sol')?.transport,
      ).toEqual({ api: 'responses', source: 'learned' });
      expect(metered).toHaveLength(2);
    },
  );

  it('learns the exact refusal when the provider applies reasoning by default', async () => {
    const { url, seen } = await fake((_body, _attempt, path) =>
      path.endsWith('/chat/completions') ? error(refusal) : { status: 200, json: response() },
    );
    await setup(url, {})
      .open()
      .chat({ ...ask, tools });
    expect(seen.map((request) => request.path)).toEqual(['/v1/chat/completions', '/v1/responses']);
    expect(seen[1]?.body).not.toHaveProperty('reasoning');
  });

  it('resets learned selection when the catalog rebuilds endpoint connections', async () => {
    const { url } = await fake((_body, _attempt, path) =>
      path.endsWith('/chat/completions') ? error(refusal) : { status: 200, json: response() },
    );
    const { router, open } = setup(url, {});
    await open().chat({ ...ask, tools });
    const fresh = setup(url, {});
    expect(fresh.router.describe()[0]?.transport).toEqual({
      api: 'chat-completions',
      source: 'default',
    });
    router.reload({
      endpoints: {
        foundry: {
          protocol: 'openai-chat',
          baseURL: `${url}/v1`,
          auth: { kind: 'bearer', secret: 'secret://env/test-key' },
        },
      },
      models: [
        {
          id: 'foundry/gpt-6.1-sol',
          endpoint: 'foundry',
          deployment: 'gpt-6.1-sol',
          residency: 'norway',
          capabilities: ['tools'],
        },
      ],
    });
    expect(router.describe()[0]?.transport).toEqual({ api: 'chat-completions', source: 'default' });
  });

  it('isolates learned API selection by deployment and endpoint', async () => {
    const { url, seen } = await fake((_body, _attempt, path) =>
      path.endsWith('/chat/completions') ? error(refusal) : { status: 200, json: response() },
    );
    const { open, router } = setup(url, {});
    await open().chat({ ...ask, tools, reasoning: 'high' });
    await expect(open('foundry/unchanged').chat(ask)).rejects.toMatchObject({
      code: 'bad_request',
    });
    await expect(open('other/gpt-6.1-sol').chat(ask)).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(seen.map((request) => request.path)).toEqual([
      '/v1/chat/completions',
      '/v1/responses',
      '/v1/chat/completions',
      '/other/v1/chat/completions',
    ]);
    expect(
      router
        .describe()
        .filter((model) => model.transport?.source === 'learned')
        .map((model) => model.id),
    ).toEqual(['foundry/gpt-6.1-sol']);
  });

  it.each([
    [400, 'Unsupported tools'],
    [400, "Unsupported value: 'reasoning_effort'."],
    [403, refusal],
    [400, refusal + ' different error'],
  ])('does not learn Responses from unrelated refusal %s %s', async (status, message) => {
    const { url, seen } = await fake(() => error(message as string, status as number));
    const { open, router } = setup(url, {});
    await expect(open().chat({ ...ask, tools, reasoning: 'high' })).rejects.toBeDefined();
    expect(seen).toHaveLength(1);
    expect(router.describe()[0]?.transport?.source).toBe('default');
  });

  it('honors an explicit chat-completions selection even for the exact refusal', async () => {
    const { url, seen } = await fake(() => error(refusal));
    await expect(
      setup(url, { api: 'chat-completions' })
        .open()
        .chat({ ...ask, tools, reasoning: 'high' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.path).toBe('/v1/chat/completions');
  });

  it.each([false, true])(
    'learns temperature refusals on Responses after learning the API with stream=%s and reports the omission',
    async (stream) => {
      const { url, seen } = await fake((body, _attempt, path) =>
        path.endsWith('/chat/completions')
          ? error(refusal)
          : 'temperature' in body
            ? error("Unsupported value: 'temperature'. Only the default (1) value is supported.")
            : body.stream
              ? {
                  status: 200,
                  sse: [
                    event('response.output_text.delta', { delta: 'Hei' }),
                    event('response.completed', { response: response() }),
                  ],
                }
              : { status: 200, json: response() },
      );
      const { open, router } = setup(url, {});
      const request = { ...ask, tools, reasoning: 'high' as const, temperature: 0 };
      if (stream) await collect(open().chatStream(request));
      else await open().chat(request);
      await open().chat(request);
      expect(seen.map((request) => [request.path, 'temperature' in request.body])).toEqual([
        ['/v1/chat/completions', true],
        ['/v1/responses', true],
        ['/v1/responses', false],
        ['/v1/responses', false],
      ]);
      expect(router.describe()[0]?.rejectedParameters).toHaveProperty('temperature');
    },
  );

  it.each(['max_output_tokens', 'content_filter'])(
    'maps incomplete %s for both chat and stream',
    async (reason) => {
      const terminal = response([text('Partial')], {
        status: 'incomplete',
        incomplete_details: { reason },
      });
      const { url } = await fake((body) =>
        body.stream
          ? {
              status: 200,
              sse: [
                event('response.output_text.delta', { delta: 'Partial' }),
                event('response.incomplete', { response: terminal }),
              ],
            }
          : { status: 200, json: terminal },
      );
      const port = setup(url).open();
      const expected = reason === 'max_output_tokens' ? 'length' : 'content_filter';
      expect((await port.chat(ask)).finishReason).toBe(expected);
      expect((await collect(port.chatStream(ask))).at(-1)).toMatchObject({
        kind: 'done',
        result: { finishReason: expected },
      });
    },
  );

  it('maps refusal output to content_filter for chat and streaming', async () => {
    const terminal = response([
      {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'Cannot comply' }],
      },
    ]);
    const { url } = await fake((body) =>
      body.stream
        ? { status: 200, sse: [event('response.completed', { response: terminal })] }
        : { status: 200, json: terminal },
    );
    const port = setup(url).open();
    expect((await port.chat(ask)).finishReason).toBe('content_filter');
    expect((await collect(port.chatStream(ask))).at(-1)).toMatchObject({
      kind: 'done',
      result: { finishReason: 'content_filter' },
    });
  });

  it.each(['error', 'response.failed', 'truncated'])(
    'fails an unsuccessful %s stream without metering a completed request',
    async (kind) => {
      const { url } = await fake(() => ({
        status: 200,
        sse: [
          event('response.output_text.delta', { delta: 'Partial' }),
          ...(kind === 'truncated'
            ? []
            : [
                kind === 'error'
                  ? event('error', { code: 'server_error', message: 'broken' })
                  : event('response.failed', {
                      response: response([], {
                        status: 'failed',
                        error: { code: 'server_error', message: 'broken' },
                      }),
                    }),
              ]),
        ],
      }));
      const { open, metered } = setup(url);
      await expect(collect(open().chatStream(ask))).rejects.toMatchObject({ code: 'unavailable' });
      expect(metered).toEqual([]);
    },
  );
});
