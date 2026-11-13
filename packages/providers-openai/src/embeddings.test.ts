import { afterEach, describe, expect, it } from 'vitest';
import type { SecretResolver } from '@genai/kernel';
import { EmbeddingRouter } from '@genai/port-embedding';
import { testContext } from '@genai/port-embedding/testing';
import { fakeHttp, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { openAiEmbeddings } from './index.js';

const servers: FakeServer[] = [];
const fake = async (reply: (body: Record<string, unknown>, attempt: number) => FakeReply) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const embeddings = (body: Record<string, unknown>) => {
  const input = body.input as string[];
  return {
    object: 'list',
    model: 'text-embedding-3-small',
    data: input
      .map((_, index) => ({ object: 'embedding', index, embedding: [index, 0.5, -0.5] }))
      .reverse(),
    usage: { prompt_tokens: 4 * input.length, total_tokens: 4 * input.length },
  };
};

const counting = (value: () => string) => {
  const resolved: string[] = [];
  const secrets: SecretResolver = {
    resolve: async (ref) => {
      resolved.push(ref);
      return value();
    },
  };
  return { secrets, resolved };
};

type RouterOptions = ConstructorParameters<typeof EmbeddingRouter>[0];

const routerOptions = (
  url: string,
  options: {
    auth?: Record<string, unknown>;
    modelOptions?: Record<string, unknown>;
    secrets?: SecretResolver;
  } = {},
): RouterOptions => ({
  catalog: {
    endpoints: {
      foundry: {
        baseURL: url,
        auth: options.auth ?? { kind: 'api-key', header: 'api-key', secret: 'secret://env/key' },
        families: { openai: '/openai' },
      },
    },
    models: [
      {
        id: 'foundry/embed-small',
        endpoint: 'foundry',
        deployment: 'text-embedding-3-small-prod',
        residency: 'eu',
        apis: { embed: 'openai/embeddings@1' },
        embed: { dimensions: 3 },
        options: options.modelOptions ?? {},
      },
    ],
  },
  adapters: [openAiEmbeddings],
  secrets: options.secrets ?? counting(() => 'test-key').secrets,
  tokenProviders: { entra: async () => 'entra-token' },
  maxRetries: 0,
});

const router = (url: string, options: Parameters<typeof routerOptions>[1] = {}) =>
  new EmbeddingRouter(routerOptions(url, options));

const ref = { kind: 'embedder', id: 'foundry/embed-small' };

describe('the openai/embeddings@1 adapter', () => {
  it('the openai adapter sends deployment and input to the family base and parses vectors and usage', async () => {
    const { url, seen } = await fake((body) => ({ status: 200, json: embeddings(body) }));

    const result = await router(url).open(ref, testContext().ctx).embed(['skatt', 'barnehage']);

    expect(seen[0]?.path).toBe('/openai/embeddings');
    expect(seen[0]?.headers['api-key']).toBe('test-key');
    expect(seen[0]?.headers.authorization).toBeUndefined();
    expect(seen[0]?.body).toEqual({
      model: 'text-embedding-3-small-prod',
      input: ['skatt', 'barnehage'],
      encoding_format: 'float',
    });
    expect(result).toEqual({
      vectors: [
        [0, 0.5, -0.5],
        [1, 0.5, -0.5],
      ],
      usage: { inputTokens: 8 },
    });
  });

  it('sends dimensions only when the model asks for it', async () => {
    const { url, seen } = await fake((body) => ({ status: 200, json: embeddings(body) }));

    await router(url, { modelOptions: { sendDimensions: true } })
      .open(ref, testContext().ctx)
      .embed(['a']);

    expect(seen[0]?.body).toMatchObject({ dimensions: 3 });
  });

  it('authenticates with an Entra token provider as a bearer token', async () => {
    const { url, seen } = await fake((body) => ({ status: 200, json: embeddings(body) }));

    await router(url, { auth: { kind: 'token-provider', provider: 'entra' } })
      .open(ref, testContext().ctx)
      .embed(['a']);

    expect(seen[0]?.headers.authorization).toBe('Bearer entra-token');
    expect(seen[0]?.headers['api-key']).toBeUndefined();
  });

  it('resolves the credential per request and never reads the environment', async () => {
    const { url, seen } = await fake((body) => ({ status: 200, json: embeddings(body) }));
    let key = 'first-key';
    const { secrets, resolved } = counting(() => key);
    const saved = { OPENAI_API_KEY: process.env.OPENAI_API_KEY };
    process.env.OPENAI_API_KEY = 'env-key';
    try {
      const port = router(url, { secrets }).open(ref, testContext().ctx);
      expect(resolved).toEqual([]);

      await port.embed(['a']);
      key = 'rotated-key';
      await port.embed(['b']);
    } finally {
      if (saved.OPENAI_API_KEY === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = saved.OPENAI_API_KEY;
    }

    expect(resolved).toEqual(['secret://env/key', 'secret://env/key']);
    expect(seen.map((s) => s.headers['api-key'])).toEqual(['first-key', 'rotated-key']);
  });

  it.each([
    [429, 'rate_limited'],
    [401, 'unauthorized'],
    [400, 'bad_request'],
    [503, 'unavailable'],
    [408, 'unavailable'],
    [409, 'unavailable'],
  ])('maps HTTP %i to %s', async (status, code) => {
    const { url } = await fake(() => ({ status, json: { error: { message: 'nei' } } }));

    await expect(router(url).open(ref, testContext().ctx).embed(['a'])).rejects.toMatchObject({
      code,
    });
  });

  it.each([
    [{ 'retry-after-ms': '1500' }, 1500],
    [{ 'retry-after': '7' }, 7000],
    [{}, undefined],
  ])(
    'a throttled embedder answers rate_limited with the wait from retry-after-ms or retry-after (%j)',
    async (headers, wait) => {
      const { url } = await fake(() => ({
        status: 429,
        headers,
        json: { error: { message: 'nei' } },
      }));

      const error = await router(url)
        .open(ref, testContext().ctx)
        .embed(['a'])
        .catch((e: unknown) => e);

      expect(error).toMatchObject({ code: 'rate_limited' });
      expect((error as { retryAfterMs?: number }).retryAfterMs).toBe(wait);
    },
  );

  it('an embedder opened with no retries sends a throttled call once', async () => {
    const { url, seen } = await fake(() => ({
      status: 429,
      headers: { 'retry-after-ms': '10' },
      json: { error: { message: 'nei' } },
    }));
    const withRetries = new EmbeddingRouter({ ...routerOptions(url), maxRetries: 2 });

    await expect(
      withRetries.open(ref, testContext().ctx, { retries: 0 }).embed(['a']),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    expect(seen).toHaveLength(1);
  });

  it('fails when the endpoint returns vectors of another length than the catalog says', async () => {
    const { url } = await fake(() => ({
      status: 200,
      json: { data: [{ index: 0, embedding: [1, 2] }], usage: { prompt_tokens: 1 } },
    }));

    await expect(router(url).open(ref, testContext().ctx).embed(['a'])).rejects.toMatchObject({
      code: 'invalid_response',
    });
  });
});
