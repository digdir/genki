import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets, type PortContext } from '@genai/kernel';
import { fakeHttp, type FakeReply, type FakeServer } from '@genai/port-model/testing';
import { RerankRouter, type RerankPort } from '@genai/port-rerank';
import { colbert } from './index.js';

const servers: FakeServer[] = [];
const fake = async (reply: (body: Record<string, unknown>) => FakeReply) => {
  const server = await fakeHttp(reply);
  servers.push(server);
  return server;
};
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const ctx: PortContext = {
  tenant: '991825827',
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
};

const port = (
  url: string,
  onFailure: 'degrade' | 'fail' = 'fail',
  timeoutMs?: number,
): RerankPort =>
  new RerankRouter({
    catalog: {
      endpoints: {
        colbert: {
          engine: 'colbert',
          baseURL: `${url}/rerank`,
          auth: { kind: 'api-key', secret: 'secret://env/colbert-key' },
        },
      },
      rerankers: [{ id: 'colbert', endpoint: 'colbert', residency: 'norway', onFailure }],
    },
    adapters: [colbert],
    secrets: envSecrets({ COLBERT_KEY: 'test-key' }),
    ...(timeoutMs ? { timeoutMs } : {}),
  }).open({ kind: 'reranker', id: 'colbert' }, ctx);

describe('colbert adapter', () => {
  it("sends headless-rag's request shape with the key header and a query cut to 1000 characters", async () => {
    const { url, seen } = await fake(() => ({
      status: 200,
      json: [
        { index: 1, score: 21.5, rank: 1 },
        { index: 0, score: 18.25, rank: 2 },
      ],
    }));
    const query = 'å'.repeat(1200);

    const result = await port(url).rerank({
      query,
      documents: ['Title: A\n\ntekst', 'Title: B\n\ntekst'],
    });

    expect(seen[0]?.path).toBe('/rerank');
    expect(seen[0]?.headers['x-api-key']).toBe('test-key');
    expect(seen[0]?.body).toEqual({
      user_input: 'å'.repeat(1000),
      k: 2,
      documents: ['Title: A\n\ntekst', 'Title: B\n\ntekst'],
    });
    expect(result.ranking).toEqual([
      { index: 1, score: 21.5, rank: 1 },
      { index: 0, score: 18.25, rank: 2 },
    ]);
  });

  it('treats an empty body or empty list as no ranking', async () => {
    const empty = await fake(() => ({ status: 200, json: [] }));
    expect((await port(empty.url).rerank({ query: 'q', documents: ['a'] })).ranking).toEqual([]);
  });

  it('maps errors, and degrades instead when configured to', async () => {
    const limited = await fake(() => ({ status: 429, json: { detail: 'slow' } }));
    const refused = await fake(() => ({ status: 401, json: { detail: 'no' } }));
    const down = await fake(() => ({ status: 502, json: {} }));
    const odd = await fake(() => ({ status: 200, json: { results: [] } }));

    await expect(port(limited.url).rerank({ query: 'q', documents: ['a'] })).rejects.toMatchObject({
      code: 'rate_limited',
    });
    await expect(port(refused.url).rerank({ query: 'q', documents: ['a'] })).rejects.toMatchObject({
      code: 'unauthorized',
    });
    await expect(port(down.url).rerank({ query: 'q', documents: ['a'] })).rejects.toMatchObject({
      code: 'unavailable',
    });
    await expect(port(odd.url).rerank({ query: 'q', documents: ['a'] })).rejects.toMatchObject({
      code: 'unavailable',
    });
    expect(await port(down.url, 'degrade').rerank({ query: 'q', documents: ['a'] })).toMatchObject({
      ranking: [],
      degraded: { reason: 'error' },
    });
  });

  it('gives up after its timeout, which headless-rag did not have', async () => {
    const slow = await fake(() => ({ status: 200, json: [], delayMs: 1_000 }));

    const result = await port(slow.url, 'degrade', 50).rerank({ query: 'q', documents: ['a'] });

    expect(result.degraded?.reason).toBe('error');
  });
});
