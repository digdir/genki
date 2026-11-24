import { afterEach, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { fakeHttp, testContext, type FakeServer } from '@genai/port-model/testing';
import { bootPlatform, digdir, readJson } from './testkit.js';

const people: Record<string, Principal> = {
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const servers: FakeServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

const sigma2 = [
  { id: 'sigma2:Qwen3.8-27B', mode: 'chat', endpoints: ['/v1/chat/completions'] },
  { id: 'sigma2:qwen-embedding', mode: 'embedding', endpoints: ['/v1/embeddings'] },
  { id: 'sigma2:qwen-reranker', endpoints: ['/v1/rerank'] },
  { id: 'sigma2:clef-flash', mode: 'evaluation', endpoints: ['/v1/decisions', '/v1/systemone'] },
];

const boot = async () => {
  const gateway = await fakeHttp((body, _attempt, path) => {
    if (path === '/v1/models') return { status: 200, json: { object: 'list', data: sigma2 } };
    if (path === '/v1/embeddings')
      return {
        status: 200,
        json: {
          data: (body.input as string[]).map((_, index) => ({ index, embedding: [0, 1, 0, 1] })),
          usage: { prompt_tokens: 3, total_tokens: 3 },
        },
      };
    if (path === '/v1/rerank')
      return {
        status: 200,
        json: {
          results: [
            { index: 1, relevance_score: 0.9 },
            { index: 0, relevance_score: 0.1 },
          ],
        },
      };
    return { status: 404, json: {} };
  });
  servers.push(gateway);
  const booted = await bootPlatform({
    people,
    models: {
      endpoints: {
        'ai-gateway': {
          baseURL: `${gateway.url}/v1`,
          auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          families: { openai: '' },
          discovery: [
            {
              source: 'openai-models',
              include: ['sigma2:*'],
              apis: { chat: 'openai/chat-completions@1' },
              residency: 'norway',
              models: { 'sigma2:qwen-embedding': { embed: { dimensions: 4 } } },
            },
          ],
        },
      },
      models: [],
    },
  });
  await booted.send('/operator/models/refresh', 'drift', {
    method: 'POST',
    reason: 'Hent modellene fra gatewayen',
  });
  return { ...booted, gateway };
};

const ctx = () => ({ ...testContext().ctx, tenant: digdir });

describe('a discovered model lands where it can be used', () => {
  it("a discovered embedding model can be a dataset's embedding model", async () => {
    const { platform, gateway } = await boot();

    const embedder = platform.embedders
      .describe()
      .find((e) => e.id === 'ai-gateway/sigma2-qwen-embedding');
    const embedded = await platform.embedders
      .open({ kind: 'embedder', id: 'ai-gateway/sigma2-qwen-embedding' }, ctx(), {
        maxResidency: 'norway',
      })
      .embed(['Frist for tilskudd']);

    expect(embedder).toMatchObject({ dimensions: 4, residency: 'norway' });
    expect(embedded.vectors).toEqual([[0, 1, 0, 1]]);
    expect(gateway.seen.filter((s) => s.path === '/v1/embeddings')).toMatchObject([
      { body: { model: 'sigma2:qwen-embedding', input: ['Frist for tilskudd'] } },
    ]);
  });

  it('a discovered rerank model is a reranker a service can name', async () => {
    const { platform, gateway } = await boot();

    const ranked = await platform.rerank
      .open({ kind: 'reranker', id: 'ai-gateway/sigma2-qwen-reranker' }, ctx())
      .rerank({ query: 'frist', documents: ['Reiseregning', 'Frist for tilskudd'] });

    expect(platform.rerank.rerankers()).toContain('ai-gateway/sigma2-qwen-reranker');
    expect(platform.rerank.residency('ai-gateway/sigma2-qwen-reranker')).toBe('norway');
    expect(ranked.ranking.map((r) => r.index)).toEqual([1, 0]);
    expect(gateway.seen.filter((s) => s.path === '/v1/rerank')).toHaveLength(1);
  });

  it('only the chat model is offered for chat', async () => {
    const { send } = await boot();

    const listed = await readJson<{ data: { id: string }[] }>(await send('/models', 'drift'));

    expect(listed.data.map((m) => m.id)).toEqual(['ai-gateway/sigma2-qwen3.8-27b']);
  });

  it('the operator model list shows each discovered model with its kind', async () => {
    const { send } = await boot();

    const listed = await readJson<{
      data: { id: string; kind: string; kindFrom?: string; listedEndpoints?: string[] }[];
    }>(await send('/operator/models', 'drift'));

    expect(listed.data.map((m) => [m.id, m.kind, m.kindFrom, m.listedEndpoints])).toEqual([
      ['ai-gateway/sigma2-clef-flash', 'evaluation', 'listing', ['/v1/decisions', '/v1/systemone']],
      ['ai-gateway/sigma2-qwen-embedding', 'embed', 'listing', ['/v1/embeddings']],
      ['ai-gateway/sigma2-qwen-reranker', 'rerank', 'listing', ['/v1/rerank']],
      ['ai-gateway/sigma2-qwen3.8-27b', 'chat', 'listing', ['/v1/chat/completions']],
    ]);
  });
});
