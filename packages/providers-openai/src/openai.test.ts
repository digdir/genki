import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { ModelRouter, type ModelPort } from '@genai/port-model';
import { fakeHttp, testContext, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { azureDeployments, openAiChat } from './index.js';

const servers: FakeServer[] = [];
const fake = async (reply: (body: Record<string, unknown>, attempt: number) => FakeReply) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const completion = (content: string, extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  object: 'chat.completion',
  created: 0,
  model: 'gpt-4o-2024-11-20',
  choices: [
    {
      index: 0,
      message: { role: 'assistant', content, ...extra },
      finish_reason: extra.tool_calls ? 'tool_calls' : 'stop',
    },
  ],
  usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
});

const all = ['stream', 'tools', 'json-schema', 'reasoning'];

const router = (
  url: string,
  auth: Record<string, unknown> = { kind: 'bearer', secret: 'secret://env/test-key' },
  maxRetries = 2,
) =>
  new ModelRouter({
    catalog: {
      endpoints: { foundry: { protocol: 'openai-chat', baseURL: `${url}/v1`, auth } },
      models: [
        {
          id: 'foundry/gpt-4o',
          endpoint: 'foundry',
          deployment: 'gpt-4o-prod',
          residency: 'norway',
          capabilities: all,
        },
        {
          id: 'aivar/borealis',
          endpoint: 'foundry',
          deployment: 'borealis',
          residency: 'norway',
          options: { tokenParam: 'max_tokens' },
        },
      ],
    },
    adapters: [openAiChat],
    secrets: envSecrets({ TEST_KEY: 'test-key' }),
    tokenProviders: { entra: async () => 'entra-token' },
    maxRetries,
  });

const open = (r: ModelRouter, id = 'foundry/gpt-4o', ctx = testContext().ctx): ModelPort =>
  r.open({ kind: 'model', id }, ctx);

const user = (content: string) => ({ messages: [{ role: 'user' as const, content }] });

describe('openai-chat adapter', () => {
  it('drops temperature for a model that only accepts the default, and remembers it', async () => {
    const { url, seen } = await fake((body) =>
      'temperature' in body
        ? {
            status: 400,
            json: {
              error: {
                message:
                  "Unsupported value: 'temperature' does not support 0 with this model. Only the default (1) value is supported.",
                type: 'invalid_request_error',
              },
            },
          }
        : { status: 200, json: completion('Hei') },
    );
    const port = open(router(url));

    const first = await port.chat({ ...user('hei'), temperature: 0 });
    const second = await port.chat({ ...user('hei igjen'), temperature: 0 });

    expect(first.content).toBe('Hei');
    expect(second.content).toBe('Hei');
    expect(seen.map((s) => 'temperature' in s.body)).toEqual([true, false, false]);
  });

  it('switches to max_tokens for a deployment that refuses max_completion_tokens, and remembers it', async () => {
    const { url, seen } = await fake((body) =>
      'max_completion_tokens' in body
        ? {
            status: 422,
            json: {
              detail: [
                {
                  type: 'extra_forbidden',
                  loc: ['body', 'max_completion_tokens'],
                  msg: 'Extra inputs are not permitted',
                  input: 4000,
                },
              ],
            },
          }
        : { status: 200, json: completion('Hei') },
    );
    const r = router(url);
    const port = open(r);

    const first = await port.chat({ ...user('hei'), maxTokens: 4000 });
    const second = await port.chat({ ...user('hei igjen'), maxTokens: 4000 });

    expect([first.content, second.content]).toEqual(['Hei', 'Hei']);
    expect(seen.map((s) => [s.body.max_completion_tokens, s.body.max_tokens])).toEqual([
      [4000, undefined],
      [undefined, 4000],
      [undefined, 4000],
    ]);
    expect(r.describe().find((m) => m.id === 'foundry/gpt-4o')?.rejectedParameters).toEqual({});
  });

  it('does not retry an unrelated 400 or a token refusal when no token limit was sent', async () => {
    const { url, seen } = await fake(() => ({
      status: 400,
      json: {
        error: {
          message: "Unsupported parameter: 'max_completion_tokens' is not supported.",
          type: 'invalid_request_error',
        },
      },
    }));
    const port = open(router(url, undefined, 0));

    await expect(port.chat(user('hei'))).rejects.toThrow();
    expect(seen).toHaveLength(1);
  });

  it('reports the dropped temperature so the platform can suggest a rule', async () => {
    const { url } = await fake((body) =>
      'temperature' in body
        ? {
            status: 400,
            json: {
              error: {
                message:
                  "Unsupported value: 'temperature'. Only the default (1) value is supported.",
                type: 'invalid_request_error',
              },
            },
          }
        : { status: 200, json: completion('Hei') },
    );
    const r = router(url);
    await open(r).chat({ ...user('hei'), temperature: 0 });

    expect(
      Object.keys(r.describe().find((m) => m.id === 'foundry/gpt-4o')?.rejectedParameters ?? {}),
    ).toEqual(['temperature']);
  });

  it('sends the deployment name and the generic options in OpenAI terms', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: completion('Hei') }));

    const result = await open(router(url)).chat({
      ...user('hei'),
      maxTokens: 50,
      reasoning: 'low',
    });

    expect(result).toMatchObject({
      content: 'Hei',
      finishReason: 'stop',
      servedModel: 'gpt-4o-2024-11-20',
    });
    expect(result.usage).toEqual({ inputTokens: 11, outputTokens: 7, requests: 1 });
    expect(seen[0]?.path).toBe('/v1/chat/completions');
    expect(seen[0]?.body).toMatchObject({
      model: 'gpt-4o-prod',
      max_completion_tokens: 50,
      reasoning_effort: 'low',
    });
  });

  it('uses max_tokens for models configured for it', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: completion('ok') }));

    await open(router(url), 'aivar/borealis').chat({ ...user('x'), maxTokens: 9 });

    expect(seen[0]?.body).toMatchObject({ max_tokens: 9 });
    expect(seen[0]?.body).not.toHaveProperty('max_completion_tokens');
  });

  it.each([
    [{ kind: 'bearer', secret: 'secret://env/test-key' }, { authorization: 'Bearer test-key' }],
    [
      { kind: 'api-key', header: 'api-key', secret: 'secret://env/test-key' },
      { 'api-key': 'test-key' },
    ],
    [{ kind: 'token-provider', provider: 'entra' }, { authorization: 'Bearer entra-token' }],
  ])('authenticates with %j', async (auth, expected) => {
    const { url, seen } = await fake(() => ({ status: 200, json: completion('ok') }));

    await open(router(url, auth)).chat(user('x'));

    expect(seen[0]?.headers).toMatchObject(expected);
    expect(
      Object.keys(seen[0]?.headers ?? {}).filter((h) => h === 'authorization' || h === 'api-key'),
    ).toEqual(Object.keys(expected));
  });

  it('round-trips tool calls', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: completion('', {
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'search', arguments: '{"q":"x"}' } },
        ],
      }),
    }));

    const result = await open(router(url)).chat({
      messages: [
        { role: 'user', content: 'finn noe' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'call_0', name: 'search', arguments: '{}' }],
        },
        { role: 'tool', toolCallId: 'call_0', content: 'treff' },
      ],
      tools: [{ name: 'search', description: 'Søk', parameters: { type: 'object' } }],
    });

    expect(result.toolCalls).toEqual([{ id: 'call_1', name: 'search', arguments: '{"q":"x"}' }]);
    expect(result.finishReason).toBe('tool_calls');
    expect((seen[0]?.body.messages as unknown[])[2]).toEqual({
      role: 'tool',
      tool_call_id: 'call_0',
      content: 'treff',
    });
  });

  it('streams text deltas, assembles tool call fragments, and reports the final usage', async () => {
    const chunk = (
      delta: Record<string, unknown>,
      finish: string | null = null,
      usage?: unknown,
    ) => ({
      data: {
        id: 'c1',
        object: 'chat.completion.chunk',
        created: 0,
        model: 'gpt-4o-2024-11-20',
        choices: usage ? [] : [{ index: 0, delta, finish_reason: finish }],
        ...(usage ? { usage } : {}),
      },
    });
    const { url, seen } = await fake(() => ({
      status: 200,
      sse: [
        chunk({ content: 'Første ' }),
        chunk({ content: 'avsnitt.' }),
        chunk({
          tool_calls: [{ index: 0, id: 'call_9', function: { name: 'sea', arguments: '{"q":' } }],
        }),
        chunk(
          { tool_calls: [{ index: 0, function: { name: 'rch', arguments: '"x"}' } }] },
          'tool_calls',
        ),
        chunk({}, null, { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 }),
        { data: '[DONE]' },
      ],
    }));

    const chunks = [];
    for await (const c of open(router(url)).chatStream(user('x'))) chunks.push(c);

    expect(chunks.flatMap((c) => (c.kind === 'delta' ? [c.text] : []))).toEqual([
      'Første ',
      'avsnitt.',
    ]);
    expect(chunks.at(-1)).toMatchObject({
      kind: 'done',
      result: {
        content: 'Første avsnitt.',
        toolCalls: [{ id: 'call_9', name: 'search', arguments: '{"q":"x"}' }],
        finishReason: 'tool_calls',
        usage: { inputTokens: 5, outputTokens: 3, requests: 1 },
      },
    });
    expect(seen[0]?.body).toMatchObject({ stream: true, stream_options: { include_usage: true } });
  });

  it('retries a rate-limited request, and reports a persistent limit as rate_limited', async () => {
    const flaky = await fake((_b, attempt) =>
      attempt === 1
        ? { status: 429, json: { error: { message: 'slow down' } } }
        : { status: 200, json: completion('ok') },
    );
    const stuck = await fake(() => ({ status: 429, json: { error: { message: 'slow down' } } }));

    expect((await open(router(flaky.url)).chat(user('x'))).content).toBe('ok');
    expect(flaky.seen).toHaveLength(2);
    await expect(open(router(stuck.url, undefined, 0)).chat(user('x'))).rejects.toMatchObject({
      code: 'rate_limited',
    });
  });

  it('maps a content filter refusal and stops a request when the task is cancelled', async () => {
    const filtered = await fake(() => ({
      status: 400,
      json: { error: { code: 'content_filter', message: 'filtered' } },
    }));
    const slow = await fake(() => ({ status: 200, json: completion('for sent'), delayMs: 2_000 }));
    const controller = new AbortController();

    const refused = open(router(filtered.url)).chat(user('x'));
    const pending = open(
      router(slow.url),
      'foundry/gpt-4o',
      testContext(controller.signal).ctx,
    ).chat(user('x'));
    setTimeout(() => controller.abort(), 50);

    await expect(refused).rejects.toMatchObject({ code: 'content_filtered' });
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
  });

  it('refuses model options the adapter does not know', () => {
    const result = openAiChat.modelOptions.safeParse({ tokenParam: 'max_tokens', temperature: 2 });
    expect(result.success).toBe(false);
  });
});

const envFile = join(import.meta.dirname, '..', '..', '..', '.env.local');
if (existsSync(envFile)) process.loadEnvFile(envFile);
const live = process.env.FOUNDRY_OPENAI_BASE_URL && process.env.FOUNDRY_OPENAI_KEY;

describe.skipIf(!live)('live openai-chat on Azure AI Foundry', () => {
  it('discovers the deployments, picks a GPT-4o one, and answers a short question', async () => {
    const r = new ModelRouter({
      catalog: {
        endpoints: {
          foundry: {
            protocol: 'openai-chat',
            baseURL: process.env.FOUNDRY_OPENAI_BASE_URL,
            auth: { kind: 'api-key', header: 'api-key', secret: 'secret://env/foundry-openai-key' },
            discovery: {
              source: 'azure-deployments',
              capabilities: ['stream', 'tools', 'json-schema'],
            },
          },
        },
      },
      adapters: [openAiChat],
      sources: [azureDeployments],
      secrets: envSecrets(),
    });

    expect((await r.refresh()).failed).toEqual([]);
    const chosen = r.describe().find((m) => m.family === 'gpt-4o');
    expect(chosen).toBeDefined();
    const result = await open(r, chosen?.id ?? '').chat({
      ...user('Svar med ett ord: hva er hovedstaden i Norge?'),
      maxTokens: 20,
    });

    expect(result.content.toLowerCase()).toContain('oslo');
    expect(result.usage.inputTokens).toBeGreaterThan(0);
  }, 60_000);
});

describe('azure deployment discovery', () => {
  it('lists working deployments from the resource root with the endpoint credential', async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: {
        data: [
          { id: 'gpt-4o-2M-tps', model: 'gpt-4o', status: 'succeeded' },
          { id: 'gpt-4.5-preview', model: 'gpt-4.5-preview', status: 'failed' },
          { id: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5', status: 'succeeded' },
        ],
      },
    }));

    const found = await azureDeployments.list({
      baseURL: `${url}/openai/v1`,
      credential: { kind: 'api-key', header: 'api-key', key: async () => 'test-key' },
      timeoutMs: 5000,
    });

    expect(found).toEqual([
      { deployment: 'gpt-4o-2M-tps', model: 'gpt-4o' },
      { deployment: 'claude-sonnet-5-5', model: 'claude-sonnet-5-5' },
    ]);
    expect(seen[0]?.path).toBe('/openai/deployments?api-version=2022-12-01');
    expect(seen[0]?.headers['api-key']).toBe('test-key');
  });

  it('reports a refused listing as an error', async () => {
    const { url } = await fake(() => ({ status: 401, json: { error: { code: '401' } } }));

    await expect(
      azureDeployments.list({
        baseURL: url,
        credential: { kind: 'api-key', key: async () => 'x' },
        timeoutMs: 5000,
      }),
    ).rejects.toThrow(/HTTP 401/);
  });
});
