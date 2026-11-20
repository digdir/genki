import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { ModelRouter, type ModelPort } from '@genai/port-model';
import { fakeHttp, testContext, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { azureDeployments, openAiChat, openAiModels } from './index.js';

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
      endpoints: { foundry: { families: { openai: '' }, baseURL: `${url}/v1`, auth } },
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
    const port = open(router(url));

    const first = await port.chat({ ...user('hei'), maxTokens: 4000 });
    const second = await port.chat({ ...user('hei igjen'), maxTokens: 4000 });

    expect([first.content, second.content]).toEqual(['Hei', 'Hei']);
    expect(seen.map((s) => [s.body.max_completion_tokens, s.body.max_tokens])).toEqual([
      [4000, undefined],
      [undefined, 4000],
      [undefined, 4000],
    ]);
  });

  it('does not report a token parameter switch as a rejected parameter', async () => {
    const { url } = await fake((body) =>
      'max_completion_tokens' in body
        ? {
            status: 400,
            json: { error: { message: "Unsupported parameter: 'max_completion_tokens'." } },
          }
        : { status: 200, json: completion('Hei') },
    );
    const r = router(url);

    await open(r).chat({ ...user('hei'), maxTokens: 50 });

    expect(r.describe().find((m) => m.id === 'foundry/gpt-4o')?.rejectedParameters).toEqual({});
  });

  it('does not retry a token refusal when no token limit was sent', async () => {
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

  it('does not switch token parameters when a different validation error forbids an extra field', async () => {
    const { url, seen } = await fake((_body, attempt) =>
      attempt === 1
        ? {
            status: 422,
            json: {
              detail: [
                {
                  type: 'less_than_equal',
                  loc: ['body', 'max_completion_tokens'],
                  msg: 'Input should be less than or equal to 1000',
                  input: 4000,
                },
                {
                  type: 'extra_forbidden',
                  loc: ['body', 'stream_options'],
                  msg: 'Extra inputs are not permitted',
                },
              ],
            },
          }
        : { status: 200, json: completion('ok') },
    );
    const port = open(router(url, undefined, 0));
    const stream = port.chatStream({ ...user('hei'), maxTokens: 4000 });

    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      code: 'bad_request',
    });
    expect(seen).toHaveLength(1);
    await port.chat({ ...user('hei'), maxTokens: 500 });
    expect(seen[1]?.body).toMatchObject({ max_completion_tokens: 500 });
    expect(seen[1]?.body).not.toHaveProperty('max_tokens');
  });

  it('does not switch token parameters when the error identifies another parameter', async () => {
    const { url, seen } = await fake(() => ({
      status: 400,
      json: {
        error: {
          param: 'reasoning_effort',
          message:
            "Unsupported parameter: 'reasoning_effort'. Use 'max_completion_tokens' without reasoning_effort.",
        },
      },
    }));

    await expect(
      open(router(url, undefined, 0)).chat({ ...user('hei'), maxTokens: 4000, reasoning: 'low' }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(seen).toHaveLength(1);
  });

  it('switches a configured max_tokens deployment only for the deployment that refused', async () => {
    const { url, seen } = await fake((body) =>
      body.model === 'borealis' && 'max_tokens' in body
        ? {
            status: 400,
            json: { error: { message: "Unrecognized parameter: 'max_tokens'." } },
          }
        : { status: 200, json: completion('ok') },
    );
    const r = router(url, undefined, 0);
    const port = open(r, 'aivar/borealis');

    await port.chat({ ...user('hei'), maxTokens: 10 });
    await port.chat({ ...user('hei igjen'), maxTokens: 20 });
    await open(r).chat({ ...user('hei'), maxTokens: 30 });

    expect(
      seen.map((s) => [s.body.model, s.body.max_tokens, s.body.max_completion_tokens]),
    ).toEqual([
      ['borealis', 10, undefined],
      ['borealis', undefined, 10],
      ['borealis', undefined, 20],
      ['gpt-4o-prod', undefined, 30],
    ]);
  });

  it.each(['temperature', 'max_completion_tokens'])(
    'streams after refusing %s first, then the other parameter, and shares the learned adjustments with chat',
    async (first) => {
      const { url, seen } = await fake((body) => {
        const rejected = [
          first,
          first === 'temperature' ? 'max_completion_tokens' : 'temperature',
        ].find((param) => param in body);
        if (rejected)
          return {
            status: 400,
            json: { error: { message: `Unsupported parameter: '${rejected}'.` } },
          };
        return body.stream
          ? {
              status: 200,
              sse: [
                {
                  data: {
                    id: 'c1',
                    object: 'chat.completion.chunk',
                    created: 0,
                    model: 'gpt-4o-prod',
                    choices: [{ index: 0, delta: { content: 'Hei' }, finish_reason: 'stop' }],
                  },
                },
                { data: '[DONE]' },
              ],
            }
          : { status: 200, json: completion('Hei') };
      });
      const r = router(url, undefined, 0);
      const port = open(r);
      const request = { ...user('hei'), temperature: 0, maxTokens: 50 };
      const chunks = [];

      for await (const c of port.chatStream(request)) chunks.push(c);
      expect(chunks).toMatchObject([
        { kind: 'delta', text: 'Hei' },
        { kind: 'done', result: { content: 'Hei' } },
      ]);
      expect((await port.chat(request)).content).toBe('Hei');
      expect(seen).toHaveLength(4);
      expect(seen.slice(2).map((s) => s.body.max_tokens)).toEqual([50, 50]);
      expect(seen.slice(2).every((s) => !('temperature' in s.body))).toBe(true);
      expect(
        Object.keys(r.describe().find((m) => m.id === 'foundry/gpt-4o')?.rejectedParameters ?? {}),
      ).toEqual(['temperature']);
    },
  );

  it('switches the token parameter once and gives up when the deployment refuses both', async () => {
    const { url, seen } = await fake((body) => ({
      status: 400,
      json: {
        error: {
          message: `Unknown parameter: '${'max_tokens' in body ? 'max_tokens' : 'max_completion_tokens'}'.`,
        },
      },
    }));

    await expect(
      open(router(url, undefined, 0)).chat({ ...user('hei'), maxTokens: 50 }),
    ).rejects.toMatchObject({ code: 'bad_request' });
    expect(seen.map((s) => [s.body.max_completion_tokens, s.body.max_tokens])).toEqual([
      [50, undefined],
      [undefined, 50],
    ]);
  });

  it('never retries a deployment that accepts max_completion_tokens', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: completion('Hei') }));
    const port = open(router(url));

    await port.chat({ ...user('hei'), maxTokens: 100 });
    await port.chat({ ...user('hei igjen'), maxTokens: 200 });

    expect(seen.map((s) => [s.body.max_completion_tokens, s.body.max_tokens])).toEqual([
      [100, undefined],
      [200, undefined],
    ]);
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

  it('refuses model options the bound API does not know', () => {
    const chatCompletions = openAiChat.apis.find((a) => a.id === 'openai/chat-completions@1');
    const result = chatCompletions?.modelOptions.safeParse({
      tokenParam: 'max_tokens',
      temperature: 2,
    });
    expect(result?.success).toBe(false);
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
            families: { openai: '' },
            baseURL: process.env.FOUNDRY_OPENAI_BASE_URL,
            auth: { kind: 'api-key', header: 'api-key', secret: 'secret://env/foundry-openai-key' },
            discovery: [
              {
                source: 'azure-deployments',
                capabilities: ['stream', 'tools', 'json-schema'],
              },
            ],
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

describe('OpenAI model list discovery', () => {
  const gatewayModels = {
    object: 'list',
    data: [
      { id: 'aivar:borealis', object: 'model', owned_by: 'aivar' },
      { id: 'sigma2:Borealis2-preview', object: 'model', owned_by: 'sigma2' },
      { id: 'sigma2:Qwen3.8-27B', object: 'model', owned_by: 'sigma2' },
      { id: 'azure:gpt-6.1-sol', object: 'model', owned_by: 'azure' },
    ],
  };

  const gateway = (
    url: string,
    rule: Record<string, unknown> = {},
    models: Record<string, unknown>[] = [],
    auth: Record<string, unknown> = { kind: 'bearer', secret: 'secret://env/test-key' },
  ) =>
    new ModelRouter({
      catalog: {
        endpoints: {
          'ai-gateway': {
            baseURL: `${url}/v1`,
            auth,
            families: { openai: '' },
            discovery: [{ source: 'openai-models', ...rule }],
          },
        },
        models,
      },
      adapters: [openAiChat],
      sources: [azureDeployments, openAiModels],
      secrets: envSecrets({ TEST_KEY: 'test-key' }),
    });

  it('an OpenAI-compatible connection lists its models from /models under its openai family base', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: gatewayModels }));

    const r = gateway(url);

    expect(await r.refresh()).toEqual({ discovered: 4, failed: [] });
    expect(seen.map((s) => s.path)).toEqual(['/v1/models']);
    expect(r.describe().map((m) => [m.id, m.deployment, m.origin, m.classified])).toEqual([
      ['ai-gateway/aivar-borealis', 'aivar:borealis', 'discovered', false],
      ['ai-gateway/azure-gpt-6.1-sol', 'azure:gpt-6.1-sol', 'discovered', false],
      ['ai-gateway/sigma2-borealis2-preview', 'sigma2:Borealis2-preview', 'discovered', false],
      ['ai-gateway/sigma2-qwen3.8-27b', 'sigma2:Qwen3.8-27B', 'discovered', false],
    ]);
  });

  it('include and exclude patterns apply to the listed model ids', async () => {
    const { url } = await fake(() => ({ status: 200, json: gatewayModels }));

    const r = gateway(url, { include: ['aivar:*', 'sigma2:*'], exclude: ['*-preview'] });
    await r.refresh();

    expect(r.describe().map((m) => m.deployment)).toEqual(['aivar:borealis', 'sigma2:Qwen3.8-27B']);
  });

  it('a listed id with a slash gets the same model id the console gives it when added by hand', async () => {
    const { url } = await fake(() => ({
      status: 200,
      json: { object: 'list', data: [{ id: '/Meta-Llama/Llama-3.1-8B/', object: 'model' }] },
    }));

    const r = gateway(url);
    await r.refresh();

    expect(r.describe().map((m) => [m.id, m.deployment])).toEqual([
      ['ai-gateway/meta-llama-llama-3.1-8b', '/Meta-Llama/Llama-3.1-8B/'],
    ]);
  });

  it('a model added by hand is not listed again as a candidate', async () => {
    const { url } = await fake(() => ({ status: 200, json: gatewayModels }));

    const r = gateway(url, { include: ['aivar:*'] }, [
      {
        id: 'ai-gateway/aivar-borealis',
        endpoint: 'ai-gateway',
        deployment: 'aivar:borealis',
        residency: 'norway',
      },
    ]);

    expect(await r.refresh()).toEqual({ discovered: 0, failed: [] });
    expect(r.describe().map((m) => [m.id, m.origin])).toEqual([
      ['ai-gateway/aivar-borealis', 'catalog'],
    ]);
  });

  it('takes the capabilities a /models entry names, in the shapes gateways use', async () => {
    const { url } = await fake(() => ({
      status: 200,
      json: {
        object: 'list',
        data: [
          { id: 'listed', capabilities: ['tools', 'json_schema', 'vision'] },
          { id: 'flagged', capabilities: { function_calling: true, streaming: false } },
          { id: 'parameters', supported_parameters: ['tools', 'structured_outputs', 'reasoning'] },
          { id: 'info', model_info: { supports_response_schema: true, supports_reasoning: false } },
          { id: 'bare' },
        ],
      },
    }));

    const r = gateway(url, { capabilities: [] });
    await r.refresh();

    expect(r.describe().map((m) => [m.deployment, m.capabilities])).toEqual([
      ['bare', []],
      ['flagged', ['tools']],
      ['info', ['json-schema']],
      ['listed', ['tools', 'json-schema']],
      ['parameters', ['tools', 'json-schema', 'reasoning']],
    ]);
  });

  it('a listed model with no capabilities in its rule that answers in the JSON shape learns json-schema over the wire', async () => {
    const server = await fakeHttp((body, _attempt, path) => {
      if (path === '/v1/models')
        return { status: 200, json: { object: 'list', data: [{ id: 'aivar:borealis' }] } };
      if (body.stream)
        return {
          status: 200,
          sse: [
            {
              data: {
                ...completion(''),
                object: 'chat.completion.chunk',
                choices: [{ index: 0, delta: { content: 'Blue' }, finish_reason: 'stop' }],
              },
            },
            { data: '[DONE]' },
          ],
        };
      if (body.response_format) return { status: 200, json: completion('{"colour":"blue"}') };
      return { status: 200, json: completion('Blue.') };
    });
    servers.push(server);

    const r = gateway(server.url, { capabilities: [] });
    await r.refresh();
    const result = await r.learn(testContext().ctx);

    expect(result.checked).toEqual([
      { model: 'ai-gateway/aivar-borealis', capability: 'json-schema', has: true },
      { model: 'ai-gateway/aivar-borealis', capability: 'stream', has: true },
    ]);
    expect(r.describe()[0]?.capabilities).toEqual(['json-schema', 'stream']);
    expect(server.seen.find((s) => s.body.response_format)?.body.response_format).toMatchObject({
      type: 'json_schema',
      json_schema: { strict: true },
    });
  });

  it('a refused model listing is reported for its connection', async () => {
    const { url } = await fake(() => ({ status: 400, json: { error: { message: 'bad' } } }));

    const r = gateway(url);

    expect(await r.refresh()).toEqual({
      discovered: 0,
      failed: [{ endpoint: 'ai-gateway', error: 'listing models failed with HTTP 400' }],
    });
  });

  it('bearer auth is sent as Authorization when listing models', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: gatewayModels }));

    await gateway(url).refresh();

    expect(seen[0]?.headers.authorization).toBe('Bearer test-key');
    expect(seen[0]?.headers['api-key']).toBeUndefined();
  });

  it('an api-key with its own header is sent in that header when listing models', async () => {
    const { url, seen } = await fake(() => ({ status: 200, json: gatewayModels }));

    await gateway(url, {}, [], {
      kind: 'api-key',
      header: 'api-key',
      secret: 'secret://env/test-key',
    }).refresh();

    expect(seen[0]?.headers['api-key']).toBe('test-key');
    expect(seen[0]?.headers.authorization).toBeUndefined();
  });

  it('a connection without the openai family reports that it cannot list models', async () => {
    const r = new ModelRouter({
      catalog: {
        endpoints: {
          claude: {
            baseURL: 'http://127.0.0.1:9',
            auth: { kind: 'bearer', secret: 'secret://env/test-key' },
            families: { anthropic: '/anthropic' },
            discovery: [{ source: 'openai-models', apis: {} }],
          },
        },
      },
      adapters: [openAiChat],
      sources: [openAiModels],
      secrets: envSecrets({ TEST_KEY: 'test-key' }),
    });

    expect((await r.refresh()).failed).toEqual([
      { endpoint: 'claude', error: 'claude does not offer the openai family to list through' },
    ]);
  });
});

describe('what a discovered model is offered for', () => {
  const deployment = (id: string, model = id) => ({ id, model, status: 'succeeded' });

  const foundry = async (deployments: Record<string, unknown>[], source = 'azure-deployments') => {
    const server = await fake(() =>
      source === 'azure-deployments'
        ? { status: 200, json: { data: deployments } }
        : { status: 200, json: { object: 'list', data: deployments } },
    );
    const r = new ModelRouter({
      catalog: {
        endpoints: {
          foundry: {
            baseURL: `${server.url}/openai/v1`,
            auth: { kind: 'api-key', header: 'api-key', secret: 'secret://env/test-key' },
            families: { openai: '' },
            discovery: [
              {
                source,
                idPrefix: 'foundry-openai',
                capabilities: ['stream', 'tools', 'json-schema'],
                apis: { chat: 'openai/chat-completions@1' },
              },
            ],
          },
        },
      },
      adapters: [openAiChat],
      sources: [azureDeployments, openAiModels],
      secrets: envSecrets({ TEST_KEY: 'test-key' }),
    });
    await r.refresh();
    return { r, seen: server.seen };
  };

  it('a discovered realtime model is not offered for chat', async () => {
    const { r, seen } = await foundry([deployment('gpt-realtime-2.1')]);

    const model = r.describe().find((m) => m.id === 'foundry-openai/gpt-realtime-2.1');
    const call = open(r, 'foundry-openai/gpt-realtime-2.1').chat(user('Hei'));

    expect(model).toMatchObject({ operations: [], apis: {}, capabilities: [] });
    expect(model?.transport).toBeUndefined();
    expect(r.models().has('foundry-openai/gpt-realtime-2.1')).toBe(false);
    await expect(call).rejects.toThrow();
    expect(seen.filter((s) => s.path.includes('chat/completions'))).toEqual([]);
  });

  it.each([
    'gpt-image-2.5-flare',
    'gpt-image-2.5-sunburst',
    'gpt-realtime-2.1-mini',
    'gpt-live-1',
    'gpt-4o-transcribe',
    'gpt-4o-mini-tts',
    'whisper',
    'dall-e-3',
    'sora-2',
    'text-embedding-3-large',
  ])('a discovered %s deployment is not offered for chat', async (name) => {
    const { r } = await foundry([deployment(name)]);

    expect(r.describe().map((m) => [m.deployment, m.operations])).toEqual([[name, []]]);
  });

  it('a discovered chat model and the model router are offered for chat as the rule says', async () => {
    const { r } = await foundry([deployment('gpt-5.6-terra'), deployment('model-router')]);

    expect(r.describe().map((m) => [m.deployment, m.operations, m.capabilities])).toEqual([
      ['gpt-5.6-terra', ['chat'], ['stream', 'tools', 'json-schema']],
      ['model-router', ['chat'], ['stream', 'tools', 'json-schema']],
    ]);
  });

  it('the model the provider reports decides, not the name the deployment was given', async () => {
    const { r } = await foundry([
      deployment('voice-desk', 'gpt-realtime-2.1'),
      deployment('realtime-helper', 'gpt-5.6-terra'),
    ]);

    expect(r.describe().map((m) => [m.deployment, m.operations])).toEqual([
      ['realtime-helper', ['chat']],
      ['voice-desk', []],
    ]);
  });

  it('a non-chat model in an OpenAI-compatible /models list is not offered for chat', async () => {
    const { r } = await foundry(
      [{ id: 'gpt-image-2.5-flare' }, { id: 'gpt-5.6-terra' }],
      'openai-models',
    );

    expect(r.describe().map((m) => [m.deployment, m.operations])).toEqual([
      ['gpt-5.6-terra', ['chat']],
      ['gpt-image-2.5-flare', []],
    ]);
  });

  it('reading a long listed model name takes linear time', async () => {
    const name = `${'-'.repeat(200_000)}x${' '.repeat(200_000)}`;
    const { url } = await fake(() => ({ status: 200, json: { data: [deployment('d', name)] } }));

    const started = performance.now();
    const found = await azureDeployments.list({
      baseURL: url,
      credential: { kind: 'api-key', key: async () => 'x' },
      timeoutMs: 5000,
    });

    expect(found).toHaveLength(1);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it("an operator's binding wins over discovery and survives the next listing", async () => {
    const { r } = await foundry([deployment('gpt-live-1')]);

    await r.classify('foundry-openai/gpt-live-1', {
      apis: { chat: 'openai/chat-completions@1' },
      capabilities: ['stream'],
    });
    await r.refresh();

    expect(r.describe()).toMatchObject([
      { id: 'foundry-openai/gpt-live-1', operations: ['chat'], capabilities: ['stream'] },
    ]);
    expect(r.models().has('foundry-openai/gpt-live-1')).toBe(true);
  });
});
