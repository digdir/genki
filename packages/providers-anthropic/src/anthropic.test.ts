import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { ModelRouter, type ChatChunk, type ModelPort } from '@genai/port-model';
import { fakeHttp, testContext, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { azureDeployments, openAiChat } from '@genai/providers-openai';
import { anthropicMessages } from './index.js';

const servers: FakeServer[] = [];
const fake = async (reply: (body: Record<string, unknown>, attempt: number) => FakeReply) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  return server;
};
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const message = (content: unknown[], stopReason = 'end_turn') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model: 'claude-opus-5-5',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: {
    input_tokens: 20,
    output_tokens: 9,
    cache_read_input_tokens: 5,
    cache_creation_input_tokens: 0,
  },
});

const router = (
  url: string,
  auth: Record<string, unknown> = { kind: 'api-key', secret: 'secret://env/test-key' },
  maxRetries = 2,
) =>
  new ModelRouter({
    catalog: {
      endpoints: { foundry: { protocol: 'anthropic-messages', baseURL: `${url}/anthropic`, auth } },
      models: [
        {
          id: 'foundry/claude-opus',
          endpoint: 'foundry',
          deployment: 'claude-opus-dep',
          residency: 'global',
          capabilities: ['stream', 'tools', 'json-schema', 'reasoning'],
          options: { defaultMaxTokens: 8192 },
        },
      ],
    },
    adapters: [anthropicMessages],
    secrets: envSecrets({ TEST_KEY: 'test-key' }),
    tokenProviders: { entra: async () => 'entra-token' },
    maxRetries,
  });

const open = (r: ModelRouter, ctx = testContext().ctx): ModelPort =>
  r.open({ kind: 'model', id: 'foundry/claude-opus' }, ctx);

describe('anthropic-messages adapter', () => {
  it('retries once without temperature when the model has deprecated it, and reports the drop', async () => {
    const { url, seen } = await fake((body) =>
      'temperature' in body
        ? {
            status: 400,
            json: {
              type: 'error',
              error: {
                type: 'invalid_request_error',
                message: '`temperature` is deprecated for this model.',
              },
            },
          }
        : { status: 200, json: message([{ type: 'text', text: 'Hei' }]) },
    );
    const port = router(url).open({ kind: 'model', id: 'foundry/claude-opus' }, testContext().ctx);

    const first = await port.chat({ messages: [{ role: 'user', content: 'hei' }], temperature: 0 });
    const second = await port.chat({
      messages: [{ role: 'user', content: 'igjen' }],
      temperature: 0,
    });

    expect(first.content).toBe('Hei');
    expect(second.content).toBe('Hei');
    expect(seen.map((s) => 'temperature' in s.body)).toEqual([true, false, false]);
  });

  it('keeps temperature off the wire when the operator marked it unsupported', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: message([{ type: 'text', text: 'Hei' }]),
    }));
    const r = router(url);
    await r.classify('foundry/claude-opus', {
      parameters: { temperature: { mode: 'unsupported' } },
    });

    await r
      .open({ kind: 'model', id: 'foundry/claude-opus' }, testContext().ctx)
      .chat({ messages: [{ role: 'user', content: 'hei' }], temperature: 0.4 });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.body).not.toHaveProperty('temperature');
  });

  it('moves system prompts to the system field and fills in max_tokens from the catalog', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: message([{ type: 'text', text: 'Hei' }]),
    }));

    const result = await open(router(url)).chat({
      messages: [
        { role: 'system', content: 'Du er hjelpsom.' },
        { role: 'system', content: 'Svar kort.' },
        { role: 'user', content: 'hei' },
      ],
    });

    expect(result).toMatchObject({
      content: 'Hei',
      finishReason: 'stop',
      servedModel: 'claude-opus-5-5',
    });
    expect(result.usage).toEqual({
      inputTokens: 25,
      outputTokens: 9,
      cachedInputTokens: 5,
      requests: 1,
    });
    expect(seen[0]?.path).toBe('/anthropic/v1/messages');
    expect(seen[0]?.body).toEqual({
      model: 'claude-opus-dep',
      max_tokens: 8192,
      system: 'Du er hjelpsom.\n\nSvar kort.',
      messages: [{ role: 'user', content: 'hei' }],
      stream: false,
    });
    expect(seen[0]?.headers['anthropic-version']).toBeDefined();
  });

  it.each([
    [{ kind: 'api-key', secret: 'secret://env/test-key' }, { 'x-api-key': 'test-key' }],
    [{ kind: 'token-provider', provider: 'entra' }, { authorization: 'Bearer entra-token' }],
  ])('authenticates with %j and never with a key from the environment', async (auth, expected) => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: message([{ type: 'text', text: 'ok' }]),
    }));
    vi.stubEnv('ANTHROPIC_API_KEY', 'from-environment');
    vi.stubEnv('ANTHROPIC_AUTH_TOKEN', 'from-environment');

    await open(router(url, auth)).chat({ messages: [{ role: 'user', content: 'x' }] });

    const sent = Object.fromEntries(
      Object.entries(seen[0]?.headers ?? {}).filter(
        ([h]) => h === 'x-api-key' || h === 'authorization',
      ),
    );
    expect(sent).toEqual(expected);
  });

  it('round-trips tool calls and sends parallel tool results in one user turn', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: message(
        [
          { type: 'text', text: 'Søker.' },
          { type: 'tool_use', id: 'toolu_2', name: 'search', input: { q: 'y' } },
        ],
        'tool_use',
      ),
    }));

    const result = await open(router(url)).chat({
      messages: [
        { role: 'user', content: 'finn to ting' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [
            { id: 'toolu_0', name: 'search', arguments: '{"q":"a"}' },
            { id: 'toolu_1', name: 'search', arguments: '{"q":"b"}' },
          ],
        },
        { role: 'tool', toolCallId: 'toolu_0', content: 'treff a' },
        { role: 'tool', toolCallId: 'toolu_1', content: 'treff b' },
      ],
      tools: [
        {
          name: 'search',
          description: 'Søk',
          parameters: { properties: { q: { type: 'string' } } },
        },
      ],
    });

    expect(result).toMatchObject({
      content: 'Søker.',
      toolCalls: [{ id: 'toolu_2', name: 'search', arguments: '{"q":"y"}' }],
      finishReason: 'tool_calls',
    });
    expect(seen[0]?.body.messages).toEqual([
      { role: 'user', content: 'finn to ting' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_0', name: 'search', input: { q: 'a' } },
          { type: 'tool_use', id: 'toolu_1', name: 'search', input: { q: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_0', content: 'treff a' },
          { type: 'tool_result', tool_use_id: 'toolu_1', content: 'treff b' },
        ],
      },
    ]);
    expect(seen[0]?.body.tools).toEqual([
      {
        name: 'search',
        description: 'Søk',
        input_schema: { type: 'object', properties: { q: { type: 'string' } } },
      },
    ]);
  });

  it('turns on adaptive thinking for reasoning and hands back the signed thinking verbatim', async () => {
    const thinking = { type: 'thinking', thinking: 'Må søke først.', signature: 'sig-abc' };
    const toolUse = { type: 'tool_use', id: 'toolu_1', name: 'search', input: {} };
    const { url, seen } = await fake(() => ({
      status: 200,
      json: message([thinking, toolUse], 'tool_use'),
    }));
    const port = open(router(url));
    const tools = [{ name: 'search', description: 'Søk', parameters: {} }];

    const first = await port.chat({
      messages: [{ role: 'user', content: 'x' }],
      reasoning: 'high',
      tools,
    });
    await port.chat({
      messages: [
        { role: 'user', content: 'x' },
        {
          role: 'assistant',
          content: first.content,
          toolCalls: first.toolCalls,
          continuation: first.continuation,
        },
        { role: 'tool', toolCallId: 'toolu_1', content: 'treff' },
      ],
      reasoning: 'high',
      tools,
    });

    expect(seen[0]?.body).toMatchObject({
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
    });
    expect((seen[1]?.body.messages as unknown[])[1]).toEqual({
      role: 'assistant',
      content: [thinking, toolUse],
    });
  });

  it('asks for structured output with the JSON schema', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: message([{ type: 'text', text: '{"kategori":"klage"}' }]),
    }));
    const schema = {
      type: 'object',
      properties: { kategori: { type: 'string' } },
      required: ['kategori'],
    };

    const result = await open(router(url)).chat({
      messages: [{ role: 'user', content: 'x' }],
      jsonSchema: { name: 'sortering', schema },
    });

    expect(JSON.parse(result.content)).toEqual({ kategori: 'klage' });
    expect(seen[0]?.body.output_config).toEqual({ format: { type: 'json_schema', schema } });
  });

  it('streams text, assembles tool input and thinking, and adds up usage', async () => {
    const frame = (data: Record<string, unknown>) => ({ event: data.type as string, data });
    const { url } = await fake(() => ({
      status: 200,
      sse: [
        frame({
          type: 'message_start',
          message: {
            ...message([], null as unknown as string),
            usage: { input_tokens: 12, output_tokens: 1 },
          },
        }),
        frame({
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }),
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'thinking_delta', thinking: 'Tenker.' },
        }),
        frame({
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'signature_delta', signature: 'sig-xyz' },
        }),
        frame({ type: 'content_block_stop', index: 0 }),
        frame({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
        frame({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'Første ' },
        }),
        frame({
          type: 'content_block_delta',
          index: 1,
          delta: { type: 'text_delta', text: 'avsnitt.' },
        }),
        frame({ type: 'content_block_stop', index: 1 }),
        frame({
          type: 'content_block_start',
          index: 2,
          content_block: { type: 'tool_use', id: 'toolu_9', name: 'search', input: {} },
        }),
        frame({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '{"q":' },
        }),
        frame({
          type: 'content_block_delta',
          index: 2,
          delta: { type: 'input_json_delta', partial_json: '"x"}' },
        }),
        frame({ type: 'content_block_stop', index: 2 }),
        frame({
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: 30 },
        }),
        frame({ type: 'message_stop' }),
      ],
    }));

    const chunks: ChatChunk[] = [];
    for await (const c of open(router(url)).chatStream({
      messages: [{ role: 'user', content: 'x' }],
      reasoning: 'low',
    })) {
      chunks.push(c);
    }

    expect(chunks.flatMap((c) => (c.kind === 'delta' ? [c.text] : []))).toEqual([
      'Første ',
      'avsnitt.',
    ]);
    expect(chunks.at(-1)).toEqual({
      kind: 'done',
      result: {
        content: 'Første avsnitt.',
        toolCalls: [{ id: 'toolu_9', name: 'search', arguments: '{"q":"x"}' }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 12, outputTokens: 30, requests: 1 },
        servedModel: 'claude-opus-5-5',
        continuation: [
          { type: 'thinking', thinking: 'Tenker.', signature: 'sig-xyz' },
          { type: 'text', text: 'Første avsnitt.' },
          { type: 'tool_use', id: 'toolu_9', name: 'search', input: { q: 'x' } },
        ],
      },
    });
  });

  it('maps rate limits, overload, refusals and cancellation', async () => {
    const limited = await fake(() => ({
      status: 429,
      json: { type: 'error', error: { type: 'rate_limit_error', message: 'slow' } },
    }));
    const overloaded = await fake(() => ({
      status: 529,
      json: { type: 'error', error: { type: 'overloaded_error', message: 'busy' } },
    }));
    const refusing = await fake(() => ({ status: 200, json: message([], 'refusal') }));
    const slow = await fake(() => ({
      status: 200,
      json: message([{ type: 'text', text: 'sent' }]),
      delayMs: 2_000,
    }));
    const controller = new AbortController();
    const ask = { messages: [{ role: 'user' as const, content: 'x' }] };

    const pending = open(router(slow.url), testContext(controller.signal).ctx).chat(ask);
    setTimeout(() => controller.abort(), 50);

    await expect(open(router(limited.url, undefined, 0)).chat(ask)).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await expect(open(router(overloaded.url, undefined, 0)).chat(ask)).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect((await open(router(refusing.url)).chat(ask)).finishReason).toBe('content_filter');
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });
});

const envFile = join(import.meta.dirname, '..', '..', '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const live =
  process.env.FOUNDRY_CLAUDE_BASE_URL &&
  process.env.FOUNDRY_CLAUDE_KEY &&
  process.env.FOUNDRY_OPENAI_BASE_URL &&
  process.env.FOUNDRY_OPENAI_KEY;

describe.skipIf(!live)('live anthropic-messages on Azure AI Foundry', () => {
  it('finds the Claude deployments through the resource listing and answers a short question', async () => {
    const r = new ModelRouter({
      catalog: {
        endpoints: {
          listing: {
            protocol: 'openai-chat',
            baseURL: process.env.FOUNDRY_OPENAI_BASE_URL,
            auth: { kind: 'api-key', header: 'api-key', secret: 'secret://env/foundry-openai-key' },
          },
          claude: {
            protocol: 'anthropic-messages',
            baseURL: process.env.FOUNDRY_CLAUDE_BASE_URL,
            auth: { kind: 'api-key', secret: 'secret://env/foundry-claude-key' },
            discovery: {
              source: 'azure-deployments',
              from: 'listing',
              include: ['claude-sonnet-*'],
            },
          },
        },
      },
      adapters: [openAiChat, anthropicMessages],
      sources: [azureDeployments],
      secrets: envSecrets(),
    });

    expect((await r.refresh()).failed).toEqual([]);
    const chosen = r.describe().find((m) => m.endpoint === 'claude');
    expect(chosen).toBeDefined();
    const result = await r.open({ kind: 'model', id: chosen?.id ?? '' }, testContext().ctx).chat({
      messages: [{ role: 'user', content: 'Svar med ett ord: hva er hovedstaden i Norge?' }],
      maxTokens: 20,
    });

    expect(result.content.toLowerCase()).toContain('oslo');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 60_000);
});
