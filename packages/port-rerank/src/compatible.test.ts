import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createGate, envSecrets, type PortContext } from '@genai/kernel';
import {
  bundledDescriptorDir,
  descriptorRegistry,
  loadDescriptors,
  parseDescriptor,
} from '@genai/operations';
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

  it("a rerank provider's error text never reaches the log", async () => {
    const echoed = 'frist for tilskudd til Kari Nordmann';
    let status = 400;
    const server = await fakeHttp(() => ({
      status,
      json: { error: { message: `could not rank: ${echoed}` } },
    }));
    servers.push(server);
    const warnings: string[] = [];
    const router = new RerankRouter({
      catalog: { endpoints: {}, rerankers: [] },
      models: gatewayModels(server.url),
      adapters: [],
      descriptors: loadDescriptors(),
      secrets: envSecrets({ K: 'k' }),
      onWarning: (m) => warnings.push(m),
    });
    const port = () => router.open({ kind: 'reranker', id: 'gw/sigma2-qwen-reranker' }, ctx);

    const refused = await port().rerank({ query: echoed, documents: ['a', 'b'] });
    status = 500;
    const failed = await port().rerank({ query: echoed, documents: ['a', 'b'] });

    expect(warnings).toHaveLength(1);
    expect(warnings.join(' ')).not.toContain('Kari');
    expect([refused.degraded?.message, failed.degraded?.message]).toEqual([
      'the reranker refused the request with HTTP 400',
      'the reranker answered HTTP 500',
    ]);
  });

  it("a described rerank call reads the connection's settings", async () => {
    const descriptor = parseDescriptor(
      readFileSync(join(bundledDescriptorDir, 'compatible', 'rerank@1.yaml'), 'utf8')
        .replace('id: compatible/rerank@1', 'id: fake/rerank-described@1')
        .replace(
          '  path: /rerank\n',
          '  path: /rerank\n  headers:\n    x-key-id: $connection.keyId\n',
        )
        .replace(
          'wire:\n  request:',
          'wire:\n  headers:\n    object:\n      x-key-id: plain\n  request:',
        ),
    );
    const keyIds: (string | null)[] = [];
    const egress: typeof fetch = async (_url, init) => {
      keyIds.push(new Headers(init?.headers).get('x-key-id'));
      return Response.json({ results: [{ index: 0, relevance_score: 0.5 }] });
    };
    const base = gatewayModels('https://gateway.example', {
      apis: { rerank: descriptor.id },
    });
    const router = new RerankRouter({
      catalog: { endpoints: {}, rerankers: [] },
      models: {
        ...base,
        endpoints: { gw: { ...base.endpoints.gw, settings: { keyId: 'AKID-7' } } },
      },
      adapters: [],
      descriptors: descriptorRegistry([descriptor]),
      secrets: envSecrets({ K: 'k' }),
      gate: { ...createGate({ tier: 'test' }), egress: () => egress },
    });

    const result = await router
      .open({ kind: 'reranker', id: 'gw/sigma2-qwen-reranker' }, ctx)
      .rerank({ query: 'q', documents: ['a'] });

    expect(result.ranking).toEqual([{ index: 0, score: 0.5, rank: 1 }]);
    expect(keyIds).toEqual(['AKID-7']);
  });
});
