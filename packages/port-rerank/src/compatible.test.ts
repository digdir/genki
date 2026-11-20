import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets, type PortContext } from '@genai/kernel';
import { loadDescriptors } from '@genai/operations';
import { fakeHttp, type FakeServer } from '@genai/plugins';
import { RerankRouter } from './index.js';

const servers: FakeServer[] = [];
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

const gatewayModels = (url: string, model: Record<string, unknown> = {}) => ({
  endpoints: {
    gw: {
      baseURL: `${url}/v1`,
      auth: { kind: 'bearer', secret: 'secret://env/k' },
      families: { openai: '' },
      gateway: true,
    },
  },
  models: [
    {
      id: 'gw/sigma2-qwen-reranker',
      endpoint: 'gw',
      deployment: 'sigma2:qwen-reranker',
      residency: 'norway',
      apis: { rerank: 'compatible/rerank@1' },
      ...model,
    },
  ],
});

describe('the generic rerank adapter', () => {
  it('the generic rerank adapter sends query and documents and reads index and relevance_score', async () => {
    const server = await fakeHttp(() => ({
      status: 200,
      json: {
        results: [
          { index: 2, relevance_score: 0.8, document: { text: 'c' } },
          { index: 0, relevance_score: 0.3 },
        ],
      },
    }));
    servers.push(server);
    const router = new RerankRouter({
      catalog: { endpoints: {}, rerankers: [] },
      models: gatewayModels(server.url),
      adapters: [],
      descriptors: loadDescriptors(),
      secrets: envSecrets({ K: 'k' }),
    });

    const result = await router
      .open({ kind: 'reranker', id: 'gw/sigma2-qwen-reranker' }, ctx)
      .rerank({ query: 'frist', documents: ['a', 'b', 'c'] });

    expect(server.seen.map((s) => [s.path, s.body])).toEqual([
      ['/v1/rerank', { model: 'sigma2:qwen-reranker', query: 'frist', documents: ['a', 'b', 'c'] }],
    ]);
    expect(result).toEqual({
      ranking: [
        { index: 2, score: 0.8, rank: 1 },
        { index: 0, score: 0.3, rank: 2 },
      ],
    });
  });

  it('a reranker served by a descriptor names its deployment', () => {
    const router = new RerankRouter({
      catalog: { endpoints: {}, rerankers: [] },
      adapters: [],
      descriptors: loadDescriptors(),
      secrets: envSecrets({ K: 'k' }),
    });

    expect(router.problems(gatewayModels('http://127.0.0.1:9', { deployment: undefined }))).toEqual(
      [
        {
          path: 'models.0.deployment',
          message: 'a reranker served by a descriptor names its deployment',
        },
      ],
    );
  });
});
