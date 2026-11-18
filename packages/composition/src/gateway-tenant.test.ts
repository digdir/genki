import { describe, expect, it } from 'vitest';
import { InMemoryDefinitionStore } from '@genai/definitions';
import {
  envSecrets,
  InMemoryEventLog,
  InMemoryStateStore,
  InMemoryTaskStore,
  type PortContext,
} from '@genai/kernel';
import { createRuntime } from './runtime.js';
import { TenantSecretVault } from './tenant-secrets.js';

const tenant = '991825827';

const streamed = () => {
  const chunk = (delta: object, finish: string | null, usage?: object) =>
    `data: ${JSON.stringify({
      id: 'c1',
      object: 'chat.completion.chunk',
      created: 0,
      model: 'chat',
      choices: [{ index: 0, delta, finish_reason: finish }],
      ...(usage ? { usage } : {}),
    })}\n\n`;
  return new Response(
    chunk({ role: 'assistant', content: 'Hei' }, null) +
      chunk({}, 'stop', { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 }) +
      'data: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
};

const answerFor = (url: string, body: string) => {
  if (body.includes('"stream":true')) return streamed();
  if (url.endsWith('/rerank')) return Response.json([{ index: 0, score: 0.9, rank: 1 }]);
  if (url.endsWith('/embeddings'))
    return Response.json({
      object: 'list',
      data: [{ object: 'embedding', index: 0, embedding: [0.1, 0.2, 0.3, 0.4] }],
      model: 'embed',
      usage: { prompt_tokens: 3, total_tokens: 3 },
    });
  return Response.json({
    id: 'c1',
    object: 'chat.completion',
    created: 0,
    model: 'chat',
    choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'Hei' } }],
    usage: { prompt_tokens: 3, completion_tokens: 1, total_tokens: 4 },
  });
};

const connection = (host: string, gateway?: boolean) => ({
  baseURL: `https://${host}/v1`,
  auth: { kind: 'api-key', secret: 'secret://env/model-key' },
  families: { openai: '', colbert: '/rerank' },
  ...(gateway === undefined ? {} : { gateway }),
});

const modelsOn = (endpoint: string) => [
  {
    id: `${endpoint}/chat`,
    endpoint,
    deployment: 'chat',
    residency: 'norway',
    capabilities: ['stream'],
    apis: { chat: 'openai/chat-completions@1' },
  },
  {
    id: `${endpoint}/embed`,
    endpoint,
    deployment: 'embed',
    residency: 'norway',
    apis: { embed: 'openai/embeddings@1' },
    embed: { dimensions: 4 },
  },
  {
    id: `${endpoint}/rerank`,
    endpoint,
    deployment: 'rerank',
    residency: 'norway',
    apis: { rerank: 'colbert/rerank@1' },
  },
];

const setup = async () => {
  const sent: { endpoint: string; tenant: string | null }[] = [];
  const fakeFor =
    (endpoint: string): typeof fetch =>
    async (input, init) => {
      const request = new Request(input, init);
      sent.push({ endpoint, tenant: request.headers.get('genki-tenant') });
      return answerFor(request.url, await request.text());
    };
  const runtime = await createRuntime({
    platformTenant: tenant,
    catalogs: {
      models: {
        endpoints: {
          gateway: connection('api.aivar.example', true),
          direct: connection('foundry.example'),
          off: connection('other.example', false),
        },
        models: [...modelsOn('gateway'), ...modelsOn('direct'), ...modelsOn('off')],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ MODEL_KEY: 'k' }),
    vault: new TenantSecretVault(),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) } as never,
    log: new InMemoryEventLog(),
    tasks: new InMemoryTaskStore(),
    state: new InMemoryStateStore(),
    endpointFetch: fakeFor,
  });
  const ctxFor = (org: string): PortContext => ({
    tenant: org,
    principal: { kind: 'agency-system', issuer: 'platform', subject: 'test' },
    task: 'run-1',
    signal: new AbortController().signal,
    meter: async () => undefined,
  });
  const callAll = async (endpoint: string, org = tenant) => {
    const ctx = ctxFor(org);
    await runtime.models
      .open({ kind: 'model', id: `${endpoint}/chat` }, ctx)
      .chat({ messages: [{ role: 'user', content: 'Hei' }] });
    for await (const chunk of runtime.models
      .open({ kind: 'model', id: `${endpoint}/chat` }, ctx)
      .chatStream({ messages: [{ role: 'user', content: 'Hei' }] }))
      void chunk;
    await runtime.embedders.open({ kind: 'embedder', id: `${endpoint}/embed` }, ctx).embed(['Hei']);
    const ranked = await runtime.rerank
      .open({ kind: 'reranker', id: `${endpoint}/rerank` }, ctx)
      .rerank({ query: 'Hei', documents: ['Hei'] });
    expect(ranked.degraded).toBeUndefined();
  };
  return { sent, callAll };
};

describe('genki-tenant on calls through the AI gateway', () => {
  it('sends the organisation number of the calling tenant on every chat, stream, embedding and rerank call through a gateway connection', async () => {
    const { sent, callAll } = await setup();
    await callAll('gateway');

    expect(sent.map((s) => s.tenant)).toEqual([tenant, tenant, tenant, tenant]);
  });

  it('never sends genki-tenant to a connection that is not marked as the gateway', async () => {
    const { sent, callAll } = await setup();
    await callAll('direct');
    await callAll('off');

    expect(sent.map((s) => s.tenant)).toEqual(Array(8).fill(null));
  });

  it('leaves genki-tenant out when the tenant is not an organisation number of 9 digits', async () => {
    const { sent, callAll } = await setup();
    await callAll('gateway', 'platform');

    expect(sent.map((s) => s.tenant)).toEqual([null, null, null, null]);
  });
});
