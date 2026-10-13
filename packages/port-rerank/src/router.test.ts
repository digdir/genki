import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { envSecrets, type PortContext } from '@genai/kernel';
import {
  parseRerankCatalog,
  RerankError,
  RerankRouter,
  type Ranked,
  type RerankAdapter,
} from './index.js';

const context = (tenant = '991825827', signal = new AbortController().signal): PortContext => ({
  tenant,
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant },
  task: 't1',
  signal,
  meter: async () => undefined,
});

const stub = (behave: () => Promise<Ranked[]>) => {
  const adapter: RerankAdapter<Record<string, never>, { k: number }> = {
    engine: 'stub',
    endpointOptions: z.strictObject({}),
    rerankerOptions: z.strictObject({ k: z.number().default(5) }),
    connect: () => ({ rerank: () => behave() }),
  };
  return adapter;
};

const catalog = (onFailure: 'degrade' | 'fail' = 'degrade', residency = 'norway') => ({
  endpoints: {
    main: {
      engine: 'stub',
      baseURL: 'https://rerank.example/rerank',
      auth: { kind: 'api-key', secret: 'secret://env/k' },
    },
  },
  rerankers: [{ id: 'colbert', endpoint: 'main', residency, onFailure }],
});

const router = (
  behave: () => Promise<Ranked[]>,
  onFailure: 'degrade' | 'fail' = 'degrade',
  extra = {},
) => {
  const warnings: string[] = [];
  const r = new RerankRouter({
    catalog: catalog(onFailure),
    adapters: [stub(behave)],
    secrets: envSecrets({ K: 'k' }),
    onWarning: (m) => warnings.push(m),
    ...extra,
  });
  return { r, warnings };
};

const docs = { query: 'q', documents: ['a', 'b', 'c'] };

describe('rerank catalog', () => {
  it('refuses a literal key, an engine without an adapter and unknown options', () => {
    const literal = parseRerankCatalog(
      {
        endpoints: {
          main: {
            engine: 'stub',
            baseURL: 'https://r.example',
            auth: { kind: 'bearer', secret: 'abc' },
          },
        },
        rerankers: [],
      },
      [stub(async () => [])],
    );
    expect(!literal.ok && literal.errors.map((e) => e.path)).toEqual([
      'endpoints.main.auth.secret',
    ]);

    const result = parseRerankCatalog(
      {
        endpoints: {
          main: {
            engine: 'cohere',
            baseURL: 'https://r.example',
            auth: { kind: 'bearer', secret: 'secret://v/x' },
          },
        },
        rerankers: [{ id: 'x', endpoint: 'main', residency: 'eu', options: { colour: 1 } }],
      },
      [stub(async () => [])],
    );
    expect(!result.ok && result.errors.map((e) => e.path)).toEqual(['endpoints.main.engine']);
  });

  it('defaults to degrading on failure', () => {
    const result = parseRerankCatalog(catalog(), [stub(async () => [])]);
    expect(result.ok && result.catalog.rerankers[0]?.onFailure).toBe('degrade');
  });
});

describe('rerank router', () => {
  it('drops entries that point outside the candidate list', async () => {
    const { r } = router(async () => [
      { index: 2, score: 0.9, rank: 1 },
      { index: 7, score: 0.8, rank: 2 },
      { index: -1, score: 0.7, rank: 3 },
      { index: 0, score: 0.1, rank: 4 },
    ]);

    expect(
      (await r.open({ kind: 'reranker', id: 'colbert' }, context()).rerank(docs)).ranking.map(
        (x) => x.index,
      ),
    ).toEqual([2, 0]);
  });

  it('degrades to no ranking and warns once per tenant', async () => {
    const { r, warnings } = router(() => Promise.reject(new Error('connection refused')));

    const first = await r.open({ kind: 'reranker', id: 'colbert' }, context()).rerank(docs);
    await r.open({ kind: 'reranker', id: 'colbert' }, context()).rerank(docs);
    await r.open({ kind: 'reranker', id: 'colbert' }, context('889640782')).rerank(docs);

    expect(first).toEqual({
      ranking: [],
      degraded: { reason: 'error', message: 'connection refused' },
    });
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain("tenant '991825827'");
  });

  it('throws in fail mode, and reports a cancelled task as cancelled in either mode', async () => {
    const failing = router(
      () => Promise.reject(new RerankError('rate_limited', 'slow down')),
      'fail',
    ).r;
    const controller = new AbortController();
    controller.abort();
    const degrading = router(() => Promise.reject(new Error('aborted'))).r;

    await expect(
      failing.open({ kind: 'reranker', id: 'colbert' }, context()).rerank(docs),
    ).rejects.toMatchObject({ code: 'rate_limited' });
    await expect(
      degrading
        .open({ kind: 'reranker', id: 'colbert' }, context('991825827', controller.signal))
        .rerank(docs),
    ).rejects.toMatchObject({
      code: 'cancelled',
    });
  });

  it('skips the call for no documents and refuses too many', async () => {
    let calls = 0;
    const { r } = router(
      async () => {
        calls++;
        return [];
      },
      'degrade',
      { maxDocuments: 2 },
    );
    const port = r.open({ kind: 'reranker', id: 'colbert' }, context());

    expect(await port.rerank({ query: 'q', documents: [] })).toEqual({ ranking: [] });
    await expect(port.rerank(docs)).rejects.toThrow(/at most 2/);
    expect(calls).toBe(0);
  });

  it('refuses an unknown reranker and one outside the allowed residency', () => {
    const r = new RerankRouter({
      catalog: catalog('degrade', 'global'),
      adapters: [stub(async () => [])],
      secrets: envSecrets({}),
      maxResidency: 'eu',
    });

    expect(() => r.open({ kind: 'reranker', id: 'none' }, context())).toThrow(/no reranker none/);
    expect(() => r.open({ kind: 'reranker', id: 'colbert' }, context())).toThrow(/outside eu/);
  });
});
