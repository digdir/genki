import { describe, expect, it } from 'vitest';
import { envSecrets, type PortContext } from '@genai/kernel';
import { KnowledgeRouter } from '@genai/port-knowledge';
import {
  httpSearchAdapter,
  mcpSearchAdapter,
  type HttpSend,
  type McpCall,
} from './external-search.js';

const ctx: PortContext = {
  tenant: '991825827',
  principal: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: '991825827' },
  task: 't1',
  signal: new AbortController().signal,
  meter: async () => undefined,
};

const catalog = (engine: string, options: Record<string, unknown> = {}) => ({
  endpoints: {
    '991825827/sok': {
      engine,
      baseURL: 'https://sok.testetaten.example.no',
      auth: { kind: 'bearer', secret: 'secret://env/search-token' },
      options,
    },
  },
  datasets: [
    {
      id: '991825827/sider',
      endpoint: '991825827/sok',
      residency: 'norway',
      tenants: ['991825827'],
      options: { index: 'intranett' },
    },
  ],
});

describe('external knowledge sources', () => {
  it('searches an external HTTP endpoint with the tenant credential and maps its hits', async () => {
    const sent: { url: string; headers: Record<string, string>; body: unknown }[] = [];
    const send: HttpSend = async (url, init) => {
      sent.push({ url, headers: init.headers, body: JSON.parse(init.body) });
      return {
        status: 200,
        body: JSON.stringify({
          hits: [{ id: 7, text: 'Felles løsninger', score: 0.9, title: 'Om' }],
        }),
      };
    };
    const router = new KnowledgeRouter({
      catalog: catalog('http-search', { searchPath: '/api/sok' }),
      adapters: [httpSearchAdapter(send)],
      secrets: envSecrets({ SEARCH_TOKEN: 'hemmelig' }),
    });

    const result = await router.open({ kind: 'dataset', id: '991825827/sider' }, ctx).search({
      query: 'felles løsninger',
      limit: 3,
    });

    expect(result.hits).toEqual([
      { id: '7', text: 'Felles løsninger', score: 0.9, title: 'Om', fields: {} },
    ]);
    expect(sent[0]).toMatchObject({
      url: 'https://sok.testetaten.example.no/api/sok',
      body: { query: 'felles løsninger', limit: 3, index: 'intranett' },
    });
    expect(sent[0]?.headers.authorization).toBe('Bearer hemmelig');
    expect(() =>
      router.open({ kind: 'dataset', id: '991825827/sider' }, { ...ctx, tenant: '999888777' }),
    ).toThrow(/not shared/);
  });

  it('reports an unknown answer shape as unavailable instead of inventing hits', async () => {
    const router = new KnowledgeRouter({
      catalog: catalog('http-search'),
      adapters: [httpSearchAdapter(async () => ({ status: 200, body: '{"results":[]}' }))],
      secrets: envSecrets({ SEARCH_TOKEN: 'x' }),
    });

    await expect(
      router.open({ kind: 'dataset', id: '991825827/sider' }, ctx).search({ query: 'x' }),
    ).rejects.toThrow(/unknown shape/);
  });

  it('searches through an MCP tool and reads structured or text results', async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = [];
    const call: McpCall = async (_endpoint, tool, args) => {
      calls.push({ tool, args });
      return calls.length === 1
        ? { structuredContent: { hits: [{ id: 'a', text: 'Altinn' }] } }
        : { content: [{ type: 'text', text: '{"hits":[{"id":"b","text":"ID-porten"}]}' }] };
    };
    const router = new KnowledgeRouter({
      catalog: catalog('mcp', { tool: 'finn' }),
      adapters: [mcpSearchAdapter(call)],
      secrets: envSecrets({ SEARCH_TOKEN: 'x' }),
    });
    const port = router.open({ kind: 'dataset', id: '991825827/sider' }, ctx);

    expect((await port.search({ query: 'altinn' })).hits.map((h) => h.id)).toEqual(['a']);
    expect((await port.search({ query: 'id' })).hits.map((h) => h.id)).toEqual(['b']);
    expect(calls[0]).toEqual({
      tool: 'finn',
      args: { query: 'altinn', limit: 10, index: 'intranett' },
    });
  });
});
