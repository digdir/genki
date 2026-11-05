import { describe, expect, it } from 'vitest';
import { createGate, envSecrets } from '@genai/kernel';
import { EmbeddingRouter, parseEmbedders, type Residency } from './index.js';
import { fakeEmbedder, fakeEmbeddingAdapter, fakeVector, testContext } from './testing.js';

const catalog = (model: Record<string, unknown> = {}) => {
  const { maxBatch, ...rest } = model;
  return {
    endpoints: {
      foundry: {
        baseURL: 'https://foundry.example',
        auth: { kind: 'api-key', header: 'api-key', secret: 'secret://env/k' },
        families: { fake: '/openai/v1' },
      },
    },
    models: [
      {
        id: 'foundry/gpt',
        endpoint: 'foundry',
        deployment: 'gpt',
        residency: 'eu',
        apis: { chat: 'fake/chat@1' },
      },
      {
        id: 'foundry/embed-small',
        endpoint: 'foundry',
        deployment: 'text-embedding-3-small',
        residency: 'eu',
        apis: { embed: 'fake/embeddings@1' },
        embed: { dimensions: 16, ...(maxBatch === undefined ? {} : { maxBatch }) },
        ...rest,
      },
    ],
  };
};

const setup = (
  model: Record<string, unknown> = {},
  adapter = fakeEmbeddingAdapter(),
  maxResidency?: Residency,
) => {
  const router = new EmbeddingRouter({
    catalog: catalog(model),
    adapters: [adapter],
    secrets: envSecrets({}),
    ...(maxResidency ? { maxResidency } : {}),
  });
  return { router, adapter };
};

const ref = { kind: 'embedder', id: 'foundry/embed-small' };

describe('embedders in the model catalogue', () => {
  it('the embedders are the models that bind an API for embed, the others are left to their ports', () => {
    const result = parseEmbedders(catalog(), [fakeEmbeddingAdapter()]);
    expect(result.ok && result.catalog.embedders.map((e) => e.id)).toEqual(['foundry/embed-small']);
    expect(result.ok && result.catalog.embedders[0]?.baseURL).toBe(
      'https://foundry.example/openai/v1',
    );
  });

  it('an embedder names its dimensions, an API with an implementation, and a family its connection offers', () => {
    const missing = parseEmbedders(
      {
        ...catalog(),
        models: [
          {
            id: 'x',
            endpoint: 'foundry',
            deployment: 'd',
            residency: 'eu',
            apis: { embed: 'fake/embeddings@1' },
          },
        ],
      },
      [fakeEmbeddingAdapter()],
    );
    expect(!missing.ok && missing.errors.map((e) => e.path)).toEqual(['models.0.embed']);

    const unknown = parseEmbedders(catalog(), [fakeEmbeddingAdapter('other/embeddings@1')]);
    expect(!unknown.ok && unknown.errors.map((e) => e.path)).toEqual(['models.1.apis.embed']);

    const otherFamily = parseEmbedders(catalog({ apis: { embed: 'openai/embeddings@1' } }), [
      fakeEmbeddingAdapter('openai/embeddings@1'),
    ]);
    expect(!otherFamily.ok && otherFamily.errors[0]?.message).toMatch(
      /does not offer the openai family/,
    );
  });

  it('an embedder bound to the old id openai/embed@1 runs on openai/embeddings@1', () => {
    const result = parseEmbedders(
      {
        ...catalog({ apis: { embed: 'openai/embed@1' } }),
        endpoints: {
          foundry: {
            baseURL: 'https://foundry.example',
            auth: { kind: 'bearer', secret: 'secret://env/k' },
            families: { openai: '/openai/v1' },
          },
        },
      },
      [fakeEmbeddingAdapter('openai/embeddings@1')],
    );
    expect(result.ok && result.catalog.embedders[0]?.api).toBe('openai/embeddings@1');
  });

  it('a new embedder in the catalogue runs after a reload, with no deploy', async () => {
    const adapter = fakeEmbeddingAdapter();
    const router = new EmbeddingRouter({
      catalog: { endpoints: {}, models: [] },
      adapters: [adapter],
      secrets: envSecrets({}),
    });
    expect(router.describe()).toEqual([]);
    router.reload(catalog());
    await router.open(ref, testContext().ctx).embed(['hei']);
    expect(adapter.calls).toHaveLength(1);
  });
});

describe('embedding router', () => {
  it("embeds a batch in input order with the catalog's dimensions", async () => {
    const { router, adapter } = setup();
    const port = router.open(ref, testContext().ctx);

    const result = await port.embed(['skatt', 'barnehage', 'skatt']);

    expect(port.info()).toEqual({ id: 'foundry/embed-small', residency: 'eu', dimensions: 16 });
    expect(adapter.calls).toEqual([
      { deployment: 'text-embedding-3-small', texts: ['skatt', 'barnehage', 'skatt'] },
    ]);
    expect(result.vectors).toEqual([
      fakeVector('skatt', 16),
      fakeVector('barnehage', 16),
      fakeVector('skatt', 16),
    ]);
    expect(result.vectors.every((v) => v.length === 16)).toBe(true);
  });

  it('splits input into batches of maxBatch and keeps order', async () => {
    const { router, adapter } = setup({ maxBatch: 2 });
    const texts = ['a', 'b', 'c', 'd', 'e'];

    const result = await router.open(ref, testContext().ctx).embed(texts);

    expect(adapter.calls.map((c) => c.texts)).toEqual([['a', 'b'], ['c', 'd'], ['e']]);
    expect(result.vectors).toEqual(texts.map((t) => fakeVector(t, 16)));
    expect(result.usage).toEqual({ inputTokens: 5 });
  });

  it('skips the call for no texts', async () => {
    const { router, adapter } = setup();

    expect(await router.open(ref, testContext().ctx).embed([])).toEqual({
      vectors: [],
      usage: { inputTokens: 0 },
    });
    expect(adapter.calls).toEqual([]);
  });

  it('refuses a model whose residency exceeds the request when it is called', async () => {
    const { router } = setup({ residency: 'global' }, fakeEmbeddingAdapter(), 'global');
    const { router: strict } = setup({ residency: 'global' }, fakeEmbeddingAdapter(), 'eu');

    await expect(
      router.open(ref, testContext().ctx, { maxResidency: 'norway' }).embed(['hei']),
    ).rejects.toMatchObject({
      code: 'residency',
      message: expect.stringMatching(/outside norway/),
    });
    await expect(strict.open(ref, testContext().ctx).embed(['hei'])).rejects.toThrow(/outside eu/);
    await expect(router.open(ref, testContext().ctx).embed(['hei'])).resolves.toBeDefined();
    expect(() => router.open({ kind: 'embedder', id: 'none' }, testContext().ctx)).toThrow(
      /no embedder none/,
    );
  });

  it('a vector of the wrong length fails', async () => {
    const short = fakeEmbeddingAdapter(undefined, (_, texts) => ({
      vectors: texts.map((t) => fakeVector(t, 8)),
      usage: { inputTokens: 1 },
    }));
    const missing = fakeEmbeddingAdapter(undefined, () => ({
      vectors: [],
      usage: { inputTokens: 1 },
    }));
    const { ctx, metered } = testContext();

    await expect(setup({}, short).router.open(ref, ctx).embed(['a'])).rejects.toMatchObject({
      code: 'invalid_response',
      message: expect.stringMatching(/8 dimensions, expected 16/),
    });
    await expect(setup({}, missing).router.open(ref, ctx).embed(['a'])).rejects.toMatchObject({
      code: 'invalid_response',
    });
    expect(metered).toEqual([]);
  });

  it('meters input tokens to the caller', async () => {
    const { router } = setup({ maxBatch: 2 });
    const { ctx, metered } = testContext();

    await router.open(ref, ctx).embed(['to ord', 'tre ord her', 'ett']);

    expect(metered).toEqual([
      {
        usage: { inputTokens: 5, requests: 1 },
        model: { kind: 'embedder', id: 'foundry/embed-small' },
      },
      {
        usage: { inputTokens: 1, requests: 1 },
        model: { kind: 'embedder', id: 'foundry/embed-small' },
      },
    ]);
  });

  it('meters input tokens at the list price', async () => {
    const router = new EmbeddingRouter({
      catalog: catalog(),
      adapters: [fakeEmbeddingAdapter()],
      secrets: envSecrets({}),
      priceOf: (id) => (id === 'foundry/embed-small' ? { 'input-token': 0.0000012 } : undefined),
    });
    const { ctx, metered } = testContext();

    await router.open(ref, ctx).embed(['to ord', 'tre ord her']);

    expect(metered.map((m) => m.usage)).toEqual([{ inputTokens: 5, requests: 1, costMicroNok: 6 }]);
  });

  it('reports failures as unavailable, and a cancelled task as cancelled', async () => {
    const failing = fakeEmbeddingAdapter(undefined, () => {
      throw new Error('connection refused');
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      setup({}, failing).router.open(ref, testContext().ctx).embed(['a']),
    ).rejects.toMatchObject({ code: 'unavailable', message: 'connection refused' });
    await expect(
      setup({}, failing).router.open(ref, testContext(controller.signal).ctx).embed(['a']),
    ).rejects.toMatchObject({ code: 'cancelled' });
  });
});

describe('embedding through the gate', () => {
  it("an embedding call outside the service's residency is refused", async () => {
    const { router, adapter } = setup({ residency: 'eu' });
    const { ctx } = testContext();

    await expect(
      router.open(ref, { ...ctx, serviceResidency: 'norway' }).embed(['a']),
    ).rejects.toMatchObject({
      code: 'residency',
      message: expect.stringMatching(/outside norway/),
    });
    expect(adapter.calls).toEqual([]);
  });

  it('an embedding call is let through in lockdown for a login without model access, so search keeps working', async () => {
    const adapter = fakeEmbeddingAdapter();
    const router = new EmbeddingRouter({
      catalog: catalog(),
      adapters: [adapter],
      secrets: envSecrets({}),
      gate: createGate({ admits: () => false }),
    });

    await router.open(ref, testContext().ctx).embed(['a']);

    expect(adapter.calls).toHaveLength(1);
  });

  it('an embedding call for a tenant the embedder is not shared with is refused', async () => {
    const { router, adapter } = setup({ tenants: ['111222333'] });

    await expect(router.open(ref, testContext().ctx).embed(['a'])).rejects.toMatchObject({
      code: 'bad_request',
      message: expect.stringMatching(/not shared/),
    });
    expect(adapter.calls).toEqual([]);
  });

  it("embedding calls go through the gate's egress guard for the endpoint", async () => {
    const given: (typeof fetch | undefined)[] = [];
    const reached: string[] = [];
    const guarded = (async (input: string) => {
      reached.push(input);
      return new Response();
    }) as unknown as typeof fetch;
    const adapter = fakeEmbeddingAdapter();
    new EmbeddingRouter({
      catalog: catalog(),
      adapters: [
        {
          ...adapter,
          connect: (endpoint: Parameters<typeof adapter.connect>[0]) => {
            given.push(endpoint.fetch);
            return adapter.connect(endpoint);
          },
        },
      ],
      secrets: envSecrets({}),
      gate: createGate({ egress: (endpoint) => (endpoint === 'foundry' ? guarded : undefined) }),
    });

    await given[0]?.('https://foundry.example/embeddings');
    expect(reached).toEqual(['https://foundry.example/embeddings']);
  });
});

describe('fake embedder', () => {
  it('returns deterministic unit vectors of the configured length and records calls', async () => {
    const embedder = fakeEmbedder({ dimensions: 40 });

    const first = await embedder.embed(['hei', 'hallo']);
    const again = await embedder.embed(['hei']);

    expect(first.vectors[0]).toEqual(again.vectors[0]);
    expect(first.vectors[0]).not.toEqual(first.vectors[1]);
    for (const v of first.vectors) {
      expect(v).toHaveLength(40);
      expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    }
    expect(embedder.calls).toEqual([['hei', 'hallo'], ['hei']]);
    expect(embedder.info().dimensions).toBe(40);
  });
});
