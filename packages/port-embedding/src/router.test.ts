import { describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { EmbeddingRouter, parseEmbeddingCatalog, type Residency } from './index.js';
import { fakeEmbedder, fakeEmbeddingAdapter, fakeVector, testContext } from './testing.js';

const catalog = (model: Record<string, unknown> = {}) => ({
  endpoints: {
    foundry: {
      protocol: 'fake',
      baseURL: 'https://foundry.example/openai/v1',
      auth: { kind: 'api-key', header: 'api-key', secret: 'secret://env/k' },
    },
  },
  models: [
    {
      id: 'foundry/embed-small',
      endpoint: 'foundry',
      deployment: 'text-embedding-3-small',
      residency: 'eu',
      dimensions: 16,
      ...model,
    },
  ],
});

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

describe('embedding catalog', () => {
  it('refuses a literal key, a protocol without an adapter and a missing dimension count', () => {
    const result = parseEmbeddingCatalog(
      {
        endpoints: {
          main: {
            protocol: 'fake',
            baseURL: 'https://e.example',
            auth: { kind: 'bearer', secret: 'abc' },
          },
        },
        models: [{ id: 'x', endpoint: 'main', deployment: 'd', residency: 'eu' }],
      },
      [fakeEmbeddingAdapter()],
    );
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual([
      'endpoints.main.auth.secret',
      'models.0.dimensions',
    ]);

    const unknown = parseEmbeddingCatalog(catalog(), [fakeEmbeddingAdapter('other')]);
    expect(!unknown.ok && unknown.errors.map((e) => e.path)).toEqual([
      'endpoints.foundry.protocol',
    ]);
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

  it('refuses a model whose residency exceeds the request', () => {
    const { router } = setup({ residency: 'global' }, fakeEmbeddingAdapter(), 'global');
    const { router: strict } = setup({ residency: 'global' }, fakeEmbeddingAdapter(), 'eu');

    expect(() => router.open(ref, testContext().ctx, { maxResidency: 'norway' })).toThrow(
      expect.objectContaining({
        code: 'residency',
        message: expect.stringMatching(/outside norway/),
      }),
    );
    expect(() => strict.open(ref, testContext().ctx)).toThrow(/outside eu/);
    expect(() => router.open(ref, testContext().ctx)).not.toThrow();
    expect(() => router.open({ kind: 'embedder', id: 'none' }, testContext().ctx)).toThrow(
      /no embedder none/,
    );
  });

  it('a vector of the wrong length fails', async () => {
    const short = fakeEmbeddingAdapter('fake', (_, texts) => ({
      vectors: texts.map((t) => fakeVector(t, 8)),
      usage: { inputTokens: 1 },
    }));
    const missing = fakeEmbeddingAdapter('fake', () => ({
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

  it('reports failures as unavailable, and a cancelled task as cancelled', async () => {
    const failing = fakeEmbeddingAdapter('fake', () => {
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
