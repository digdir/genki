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

const router = (
  url: string,
  options: {
    auth?: Record<string, unknown>;
    endpointOptions?: Record<string, unknown>;
    modelOptions?: Record<string, unknown>;
    secrets?: SecretResolver;
  } = {},
) =>
  new EmbeddingRouter({
    catalog: {
      endpoints: {
        foundry: {
          protocol: 'openai-embeddings',
          baseURL: `${url}/openai`,
          auth: options.auth ?? { kind: 'api-key', header: 'api-key', secret: 'secret://env/key' },
          options: options.endpointOptions ?? { apiVersion: '2024-10-21' },
        },
      },
      models: [
        {
          id: 'foundry/embed-small',
          endpoint: 'foundry',
          deployment: 'text-embedding-3-small-prod',
          residency: 'eu',
          dimensions: 3,
          options: options.modelOptions ?? {},
        },
      ],
    },
    adapters: [openAiEmbeddings],
    secrets: options.secrets ?? counting(() => 'test-key').secrets,
    tokenProviders: { entra: async () => 'entra-token' },
    maxRetries: 0,
  });

const ref = { kind: 'embedder', id: 'foundry/embed-small' };

describe('openai-embeddings adapter', () => {
  it('the openai adapter sends deployment, input and api-version and parses vectors and usage', async () => {
    const { url, seen } = await fake((body) => ({ status: 200, json: embeddings(body) }));

    const result = await router(url).open(ref, testContext().ctx).embed(['skatt', 'barnehage']);

    expect(seen[0]?.path).toBe('/openai/embeddings?api-version=2024-10-21');
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

  it('leaves out api-version unless configured, and sends dimensions only when asked', async () => {
    const { url, seen } = await fake((body) => ({ status: 200, json: embeddings(body) }));

    await router(url, { endpointOptions: {}, modelOptions: { sendDimensions: true } })
      .open(ref, testContext().ctx)
      .embed(['a']);

    expect(seen[0]?.path).toBe('/openai/embeddings');
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
  ])('maps HTTP %i to %s', async (status, code) => {
    const { url } = await fake(() => ({ status, json: { error: { message: 'nei' } } }));

    await expect(router(url).open(ref, testContext().ctx).embed(['a'])).rejects.toMatchObject({
      code,
    });
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
