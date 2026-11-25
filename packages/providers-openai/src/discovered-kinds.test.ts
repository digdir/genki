import { afterEach, describe, expect, it } from 'vitest';
import { envSecrets } from '@genai/kernel';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  bundledDescriptorDir,
  descriptorRegistry,
  loadDescriptors,
  parseDescriptor,
} from '@genai/operations';
import { ModelRouter } from '@genai/port-model';
import { fakeHttp, type FakeServer } from '@genai/port-model/testing';
import { openAiChat, openAiModels } from './index.js';

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const gateway = async (
  data: Record<string, unknown>[],
  rule: Record<string, unknown> = {},
  descriptors: ReturnType<typeof loadDescriptors> = loadDescriptors(),
) => {
  const server = await fakeHttp(() => ({ status: 200, json: { object: 'list', data } }));
  servers.push(server);
  const router = new ModelRouter({
    catalog: {
      endpoints: {
        'ai-gateway': {
          baseURL: `${server.url}/v1`,
          auth: { kind: 'bearer', secret: 'secret://env/test-key' },
          families: { openai: '' },
          gateway: true,
          discovery: [
            {
              source: 'openai-models',
              include: ['sigma2:*'],
              apis: { chat: 'openai/chat-completions@1' },
              ...rule,
            },
          ],
        },
      },
    },
    adapters: [openAiChat],
    descriptors,
    sources: [openAiModels],
    secrets: envSecrets({ TEST_KEY: 'test-key' }),
  });
  await router.refresh();
  return router;
};

const sigma2 = [
  { id: 'sigma2:Qwen3.8-27B', mode: 'chat', endpoints: ['/v1/chat/completions'] },
  { id: 'sigma2:qwen-embedding', mode: 'embedding', endpoints: ['/v1/embeddings'] },
  { id: 'sigma2:qwen-reranker', mode: 'rerank', endpoints: ['/v1/rerank'] },
  { id: 'sigma2:clef-flash', mode: 'evaluation', endpoints: ['/v1/decisions', '/v1/systemone'] },
];

const kinds = (r: ModelRouter) =>
  r.describe().map((m) => [m.deployment, m.kind, m.kindFrom, m.apis, r.models().has(m.id)]);

describe('what kind a discovered model is', () => {
  it('the gateway listing decides the kind and the API of each model', async () => {
    const r = await gateway(sigma2);

    expect(kinds(r)).toEqual([
      ['sigma2:clef-flash', 'evaluation', 'listing', {}, false],
      ['sigma2:qwen-embedding', 'embed', 'listing', { embed: 'openai/embeddings@1' }, false],
      ['sigma2:qwen-reranker', 'rerank', 'listing', { rerank: 'compatible/rerank@1' }, false],
      ['sigma2:Qwen3.8-27B', 'chat', 'listing', { chat: 'openai/chat-completions@1' }, true],
    ]);
  });

  it('a model the gateway reports as rerank is a reranker whatever its name', async () => {
    const r = await gateway([{ id: 'sigma2:Borealis-sorter', mode: 'rerank' }]);

    expect(kinds(r)).toEqual([
      ['sigma2:Borealis-sorter', 'rerank', 'listing', { rerank: 'compatible/rerank@1' }, false],
    ]);
  });

  it('a discovered rerank model is a reranker, never a chat model', async () => {
    const r = await gateway([{ id: 'sigma2:qwen-reranker' }]);

    expect(kinds(r)).toEqual([
      ['sigma2:qwen-reranker', 'rerank', 'name', { rerank: 'compatible/rerank@1' }, false],
    ]);
    expect(r.describe()[0]?.operations).not.toContain('chat');
  });

  it('a model with an endpoint genki has no port for is listed with that endpoint and never offered for chat', async () => {
    const r = await gateway([{ id: 'sigma2:clef-flash', endpoints: ['/v1/systemone'] }]);

    expect(r.describe()).toMatchObject([
      {
        deployment: 'sigma2:clef-flash',
        kind: 'unknown',
        listedEndpoints: ['/v1/systemone'],
        apis: {},
        operations: [],
      },
    ]);
    expect(r.models().size).toBe(0);
  });

  it('an operator can set the kind of a discovered model', async () => {
    const r = await gateway([{ id: 'sigma2:clef-flash' }], {
      models: { 'sigma2:clef-flash': { kind: 'decide' } },
    });

    expect(kinds(r)).toEqual([
      ['sigma2:clef-flash', 'decide', 'operator', { decide: 'openai/decide@1' }, true],
    ]);
  });

  it('an operator kind wins over what the gateway reports', async () => {
    const r = await gateway([{ id: 'sigma2:qwen-reranker', mode: 'chat' }], {
      models: { 'sigma2:qwen-reranker': { kind: 'rerank' } },
    });

    expect(r.describe()[0]).toMatchObject({ kind: 'rerank', kindFrom: 'operator' });
  });

  it('an uploaded descriptor is bound to a discovered model only when the rule names it', async () => {
    const bundled = loadDescriptors();
    const uploaded = parseDescriptor(
      readFileSync(join(bundledDescriptorDir, 'compatible/rerank@1.yaml'), 'utf8').replace(
        'id: compatible/rerank@1',
        'id: acme/rerank@1',
      ),
    );
    const registry = { ...descriptorRegistry([...bundled.list(), uploaded]), bundled };
    const listing = [{ id: 'sigma2:qwen-reranker', mode: 'rerank' }];

    const inferred = await gateway(listing, {}, registry);
    const named = await gateway(listing, { apis: { rerank: 'acme/rerank@1' } }, registry);

    expect(inferred.describe()[0]?.apis).toEqual({ rerank: 'compatible/rerank@1' });
    expect(named.describe()[0]?.apis).toEqual({ rerank: 'acme/rerank@1' });
  });

  it('a model nothing says anything about is a chat model by its name', async () => {
    const r = await gateway([{ id: 'sigma2:DeepSeek-V4-Flash' }]);

    expect(kinds(r)).toEqual([
      ['sigma2:DeepSeek-V4-Flash', 'chat', 'name', { chat: 'openai/chat-completions@1' }, true],
    ]);
  });

  it("a model discovered on a connection inherits the connection's data location", async () => {
    const r = await gateway(sigma2.slice(0, 1), { residency: 'norway' });

    expect(r.describe().map((m) => [m.deployment, m.residency])).toEqual([
      ['sigma2:Qwen3.8-27B', 'norway'],
    ]);
  });

  it("an operator's data location for one model wins over the connection's", async () => {
    const r = await gateway(sigma2.slice(0, 1), { residency: 'norway' });

    await r.classify('ai-gateway/sigma2-qwen3.8-27b', { residency: 'eu' });
    await r.refresh();

    expect(r.describe()[0]?.residency).toBe('eu');
  });

  it('a discovered embedding model is served by the embedding port once its dimensions are set', async () => {
    const without = await gateway(sigma2);
    const withDimensions = await gateway(sigma2, {
      models: { 'sigma2:qwen-embedding': { embed: { dimensions: 1024 } } },
    });

    expect(without.discoveredForOtherPorts().map((m) => m.id)).toEqual([
      'ai-gateway/sigma2-qwen-reranker',
    ]);
    expect(withDimensions.discoveredForOtherPorts()).toMatchObject([
      {
        id: 'ai-gateway/sigma2-qwen-embedding',
        deployment: 'sigma2:qwen-embedding',
        apis: { embed: 'openai/embeddings@1' },
        embed: { dimensions: 1024 },
      },
      { id: 'ai-gateway/sigma2-qwen-reranker', apis: { rerank: 'compatible/rerank@1' } },
    ]);
  });

  it('a disabled discovered reranker is not served', async () => {
    const r = await gateway([{ id: 'sigma2:qwen-reranker', mode: 'rerank' }]);

    await r.classify('ai-gateway/sigma2-qwen-reranker', { enabled: false });

    expect(r.discoveredForOtherPorts()).toEqual([]);
  });

  it('reading a long listed mode and endpoint takes linear time', async () => {
    const long = `/${'a/'.repeat(200_000)}!`;
    const started = performance.now();
    const r = await gateway([{ id: 'sigma2:x', mode: '-'.repeat(200_000), endpoints: [long] }]);

    expect(r.describe()[0]?.kind).toBe('chat');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});
