import { describe, expect, it } from 'vitest';
import { textPart, type CapabilityDescriptor, type Principal } from '@genai/contracts';
import { createKernel, type Capability, type Kernel, type Strategy } from '@genai/kernel';
import {
  createMcpApp,
  progressTracker,
  protocolVersion,
  SOURCES_MIME,
  type CapabilityEntry,
  type CapabilityResolver,
} from './index.js';
import {
  advertisedInput,
  defaultOutput,
  defaultOutputSchema,
  RETRIEVAL_MIME,
  resourceLinks,
  searchAttribution,
  structuredContent,
} from './tools.js';

const tenant = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant };

const descriptor = (id: string, input: Record<string, unknown> = {}): CapabilityDescriptor => ({
  id,
  version: '1',
  tenant,
  title: 'Kunnskapsassistenten',
  description: 'Svarer på spørsmål om Kudos',
  input,
  interaction: ['unary', 'stream'],
  accepts: ['text/plain'],
  produces: ['text/plain'],
  emits: [],
  oversight: { interrupts: false, riskClass: 'limited', aiDisclosure: 'KI' },
});

const sources = [
  {
    chunkId: 'c1',
    document: 'd1',
    position: 0,
    title: 'Tildelingsbrev 2025',
    url: 'https://kudos.dfo.no/d1',
    text: 'x'.repeat(9000),
    headers: ['Mål', 'Styringsparametere'],
  },
  {
    chunkId: 'c2',
    document: 'd1',
    position: 1,
    title: 'Tildelingsbrev 2025',
    url: 'https://kudos.dfo.no/d1',
  },
  { chunkId: 'c3', document: 'd2', position: 4 },
];

const histories: unknown[] = [];

const tasks: string[] = [];

const strategies: Strategy[] = [
  {
    id: 'answer',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (ctx, input) {
      tasks.push(ctx.task);
      const { query, history } = input.data as { query: string; history: unknown };
      histories.push(history);
      yield {
        type: 'kernel.notice',
        data: { event: 'agent/iteration-started', iteration: 1, 'max-iterations': 4 },
      };
      yield {
        type: 'kernel.notice',
        data: { event: 'tool/call', 'tool-call': { tool: 'search' } },
      };
      yield { type: 'kernel.notice', data: { event: 'internal/noise' } };
      yield { type: 'kernel.part.delta', data: { text: 'Svar ' } };
      yield { type: 'kernel.part.delta', data: { text: `på: ${query}` } };
      yield {
        type: 'kernel.result',
        data: [
          textPart(`Svar på: ${query}`),
          {
            mime: SOURCES_MIME,
            body: {
              kind: 'json',
              json: { sources, queries: [query], searchAttribution: {}, insufficient: false },
            },
          },
        ],
      };
    },
  },
  {
    id: 'slow',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* (ctx) {
      tasks.push(ctx.task);
      yield { type: 'kernel.part.delta', data: { text: 'Starter' } };
      await new Promise((resolve) => ctx.signal.addEventListener('abort', resolve, { once: true }));
      yield { type: 'kernel.result', data: [textPart('for sent')] };
    },
  },
  {
    id: 'broken',
    version: '1',
    requires: { kernel: 1, ports: [], features: [] },
    run: async function* () {
      yield { type: 'kernel.part.delta', data: { text: '' } };
      throw new Error('connection string postgres://secret');
    },
  },
];

const capability = (
  id: string,
  strategy: string,
  input: Record<string, unknown> = {},
): Capability => ({
  descriptor: descriptor(id, input),
  strategy: { id: strategy, version: '1' },
  config: {},
  grants: [],
});

const capabilities = [
  capability(`${tenant}/ka/default`, 'answer', {
    type: 'object',
    properties: { 'user-query': { type: 'string' } },
    required: ['user-query'],
  }),
  capability(`${tenant}/ka/slow`, 'slow'),
  capability(`${tenant}/ka/broken`, 'broken'),
];

const entries: CapabilityEntry[] = [
  {
    id: 'kunnskapsassistenten__default',
    capability: `${tenant}/ka/default`,
    title: 'Kunnskapsassistenten',
    description: 'Svarer på spørsmål om Kudos',
    agentId: 'kunnskapsassistenten',
    mode: 'default',
    default: true,
    inputSchema: {
      type: 'object',
      properties: { 'user-query': { type: 'string' } },
      required: ['user-query'],
    },
  },
  {
    id: 'kunnskapsassistenten__slow',
    capability: `${tenant}/ka/slow`,
    agentId: 'kunnskapsassistenten',
    mode: 'slow',
  },
  {
    id: 'kunnskapsassistenten__broken',
    capability: `${tenant}/ka/broken`,
    agentId: 'kunnskapsassistenten',
    mode: 'broken',
  },
];

const resolver: CapabilityResolver = {
  list: async () => entries,
  resolve: async (principal, name) => {
    const entry = entries.find(
      (e) => e.id === name || (name === 'ka__default' && e.mode === 'default'),
    );
    if (entry)
      return principal.subject === 'kari'
        ? { ok: true, entry }
        : {
            ok: false,
            code: 'agent_not_authorized',
            message: 'API key cannot access agent: kunnskapsassistenten',
          };
    const [agent, mode] = name.split('__') as [string, string];
    return agent === 'kunnskapsassistenten'
      ? { ok: false, code: 'mode_not_allowed', message: `Mode not available for agent: ${mode}` }
      : {
          ok: false,
          code: 'agent_not_found',
          message: `Agent not found: ${agent.replace('.', '/')}`,
        };
  },
};

const setup = (extra: Partial<Parameters<typeof createMcpApp>[0]> = {}) => {
  const kernel: Kernel = createKernel({
    strategies,
    capabilities,
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  let n = 0;
  const app = createMcpApp({
    kernel,
    resolver,
    auth: {
      authenticate: async (r) => {
        const key = r.headers.get('x-api-key');
        if (key === 'good') return kari;
        return key === 'other' ? { ...kari, subject: 'ola' } : undefined;
      },
    },
    history: async (_p, conversationId) => [
      { role: 'user', text: `tidligere i ${conversationId}` },
    ],
    conversationId: () => `conv-${++n}`,
    heartbeatMs: 10_000,
    ...extra,
  });
  return { kernel, app };
};

interface ToolDescription {
  name: string;
  description: string;
  _meta: Record<string, unknown>;
  inputSchema: { required: string[]; properties: Record<string, unknown> };
  outputSchema: { required: string[] };
}

interface RpcBody {
  error: { code: number; message: string; data: Record<string, unknown> };
  result: {
    isError: boolean;
    instructions: string;
    tools: ToolDescription[];
    content: unknown[];
    structuredContent: {
      conversation_id: string;
      chunks: Record<string, unknown>[];
      [key: string]: unknown;
    };
    _meta: { conversation_id: string; [key: string]: unknown };
    [key: string]: unknown;
  };
}

type RpcResponse = Omit<Response, 'json'> & { json(): Promise<RpcBody> };

const typed = (res: Response) => res as RpcResponse;

const post = async (
  app: ReturnType<typeof setup>['app'],
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
  signal?: AbortSignal,
) => {
  const params = body.params as { name?: string } | undefined;
  const res = await app.request('/api/mcp', {
    method: 'POST',
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
    headers: {
      'content-type': 'application/json',
      'x-api-key': 'good',
      'MCP-Protocol-Version': protocolVersion,
      ...(typeof body.method === 'string' ? { 'Mcp-Method': body.method } : {}),
      ...(params?.name ? { 'Mcp-Name': params.name } : {}),
      ...headers,
    },
  });
  return typed(res);
};

const call = (
  app: ReturnType<typeof setup>['app'],
  name: string,
  args: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) =>
  post(app, {
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: args, ...extra },
  });

const KA = 'kunnskapsassistenten__default';

const sseFrames = (text: string) =>
  text
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => JSON.parse(f.slice(6)) as Record<string, unknown>);

const until = async (check: () => Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('condition never held');
};

describe('request metadata', () => {
  it('answers an initialize with the handshake version the client asked for, or its own when it does not know that one', async () => {
    const { app } = setup();
    const ask = (version: string) =>
      post(app, {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: version, capabilities: {}, clientInfo: { name: 'x' } },
      });

    const known = await ask('2025-06-18');
    const unknown = await ask('2024-11-05');

    expect(known.status).toBe(200);
    expect(known.headers.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(await known.json()).toMatchObject({
      result: { protocolVersion: '2025-06-18', capabilities: { tools: {} } },
    });
    expect(await unknown.json()).toMatchObject({ result: { protocolVersion: '2025-06-18' } });
  });

  it('serves a handshake-revision client without the newer Mcp-Method and Mcp-Name headers', async () => {
    const { app } = setup();
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'x-api-key': 'good',
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2025-06-18',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('mcp-protocol-version')).toBe('2025-06-18');
    expect(((await res.json()) as { result: { tools: unknown[] } }).result.tools).toBeDefined();
  });

  it('refuses a missing header, a header that contradicts the body, and an unsupported version', async () => {
    const { app } = setup();
    const missing = await post(
      app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'Mcp-Method': '' },
    );
    const noName = typed(
      await app.request('/api/mcp', {
        method: 'POST',
        headers: {
          'x-api-key': 'good',
          'MCP-Protocol-Version': protocolVersion,
          'Mcp-Method': 'tools/call',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: KA } }),
      }),
    );
    const wrongVersion = await post(
      app,
      { jsonrpc: '2.0', id: 3, method: 'tools/list' },
      { 'MCP-Protocol-Version': '2025-03-26' },
    );
    const contradicts = await post(app, {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/list',
      params: { _meta: { 'io.modelcontextprotocol/protocolVersion': '2025-11-25' } },
    });

    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toMatchObject({ code: -32020 });
    expect((await noName.json()).error).toEqual({
      code: -32020,
      message: 'Missing required header: Mcp-Name (required for tools/call)',
    });
    expect((await wrongVersion.json()).error).toMatchObject({
      code: -32022,
      data: { requested: '2025-03-26' },
    });
    expect((await contradicts.json()).error.message).toBe(
      `Header mismatch: MCP-Protocol-Version header '${protocolVersion}' does not match body _meta 'io.modelcontextprotocol/protocolVersion' value '2025-11-25'`,
    );
  });

  it('accepts a tool name sent in the base64 sentinel form', async () => {
    const res = await post(
      setup().app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: KA, arguments: { query: 'hei' } },
      },
      { 'Mcp-Name': `=?base64?${Buffer.from(KA).toString('base64')}?=` },
    );

    expect((await res.json()).result.isError).toBe(false);
  });
});

describe('transport', () => {
  it('answers 401 with a Bearer challenge before reading the request', async () => {
    const res = await post(
      setup().app,
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { 'x-api-key': 'bad' },
    );

    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toBe('Bearer');
    expect(await res.json()).toEqual({ error: 'Invalid or missing API key' });
  });

  it('answers GET and DELETE with 405 and POST only', async () => {
    const res = typed(
      await setup().app.request('/api/mcp', {
        method: 'GET',
        headers: { 'x-api-key': 'good' },
      }),
    );

    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('POST');
    expect((await res.json()).error).toMatchObject({ code: -32601, data: { allow: ['POST'] } });
  });

  it('accepts notifications with 202, rejects batches and broken JSON, and has no ping', async () => {
    const { app } = setup();
    const notification = await post(app, { jsonrpc: '2.0', method: 'notifications/cancelled' });
    const batch = typed(
      await app.request('/api/mcp', {
        method: 'POST',
        headers: { 'x-api-key': 'good' },
        body: '[]',
      }),
    );
    const broken = typed(
      await app.request('/api/mcp', {
        method: 'POST',
        headers: { 'x-api-key': 'good' },
        body: '{',
      }),
    );
    const ping = await post(app, { jsonrpc: '2.0', id: 9, method: 'ping' });

    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe('');
    expect((await batch.json()).error).toEqual({
      code: -32700,
      message: 'Batched requests are not supported',
    });
    expect(broken.status).toBe(400);
    expect((await broken.json()).error.code).toBe(-32700);
    expect(ping.status).toBe(404);
    expect(await ping.json()).toEqual({
      jsonrpc: '2.0',
      id: 9,
      error: { code: -32601, message: 'Method not found', data: { method: 'ping' } },
    });
  });
});

describe('discovery', () => {
  it('describes the server with public cache hints and echoes the protocol version', async () => {
    const res = await post(setup().app, { jsonrpc: '2.0', id: 1, method: 'server/discover' });
    const body = await res.json();

    expect(res.headers.get('mcp-protocol-version')).toBe(protocolVersion);
    expect(body.result).toMatchObject({
      resultType: 'complete',
      supportedVersions: [protocolVersion, '2025-06-18'],
      capabilities: { tools: {} },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: 'digdir-rag', version: '1.0' } },
      ttlMs: 3_600_000,
      cacheScope: 'public',
    });
    expect(body.result.instructions).toContain('conversation_id');
  });

  it('lists tools by their legacy name with query advertised and private cache hints', async () => {
    const body = await (
      await post(setup().app, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    ).json();
    const ka = body.result.tools[0] as ToolDescription;

    expect(body.result).toMatchObject({
      resultType: 'complete',
      ttlMs: 60_000,
      cacheScope: 'private',
    });
    expect(body.result.tools.map((t: { name: string }) => t.name)).toEqual([
      KA,
      'kunnskapsassistenten__slow',
      'kunnskapsassistenten__broken',
    ]);
    expect(ka._meta).toEqual({
      'agent-id': 'kunnskapsassistenten',
      mode: 'default',
      default: true,
    });
    expect(ka.inputSchema.required).toEqual(['query']);
    expect(Object.keys(ka.inputSchema.properties).sort()).toEqual([
      'conversation_id',
      'dataset_config_key',
      'overrides',
      'query',
      'tenant',
    ]);
    expect(ka.outputSchema.required).toEqual(['conversation_id']);
    expect(ka.description).toMatch(/Multi-turn/);
  });
});

describe('tools/call', () => {
  it('returns the answer, one resource link per document, structured chunks and a conversation id', async () => {
    const body = await (
      await call(setup().app, KA, { query: 'Hva sier tildelingsbrevet?' })
    ).json();
    const { content, structuredContent, isError, _meta } = body.result;

    expect(isError).toBe(false);
    expect(content).toEqual([
      { type: 'text', text: 'Svar på: Hva sier tildelingsbrevet?' },
      {
        type: 'resource_link',
        uri: 'https://kudos.dfo.no/d1',
        name: 'Tildelingsbrev 2025',
        mimeType: 'text/html',
        description: expect.stringMatching(/^x{200,299}…$/),
      },
      { type: 'resource_link', uri: 'digdir://doc/d2', name: 'Document d2', mimeType: 'text/html' },
    ]);
    expect(structuredContent.conversation_id).toBe('conv-1');
    expect(structuredContent.chunks[0]).toMatchObject({
      chunk_id: 'c1',
      doc_num: 'd1',
      chunk_index: 0,
      title: 'Tildelingsbrev 2025',
      url: 'https://kudos.dfo.no/d1',
      content_length: 9000,
      metadata: { 'Header 1': 'Mål', 'Header 2': 'Styringsparametere' },
    });
    expect(structuredContent.chunks[0]?.content_markdown).toHaveLength(8000);
    expect(structuredContent.chunks[2]).toEqual({ chunk_id: 'c3', doc_num: 'd2', chunk_index: 4 });
    expect(structuredContent.queries).toEqual(['Hva sier tildelingsbrevet?']);
    expect(structuredContent).not.toHaveProperty('search_attribution');
    expect(_meta).toEqual({
      conversation_id: 'conv-1',
      mode: 'default',
      agent_id: 'kunnskapsassistenten',
      status: 'complete',
      insufficient: false,
      ai_generated: true,
    });
  });

  it('continues a conversation on the same thread, under both the legacy and the new name', async () => {
    const { app, kernel } = setup();
    tasks.length = 0;
    histories.length = 0;

    await call(app, KA, { 'user-query': 'første' });
    const second = await (
      await call(app, 'ka__default', { query: 'andre', conversation_id: 'conv-1' })
    ).json();

    expect(second.result._meta.conversation_id).toBe('conv-1');
    const threads = await Promise.all(tasks.map(async (t) => (await kernel.task(kari, t)).thread));
    expect(threads).toEqual(['conv-1', 'conv-1']);
    expect(histories).toEqual([[], [{ role: 'user', text: 'tidligere i conv-1' }]]);
  });

  it('tells the model when the resolver refuses access, rather than failing the request', async () => {
    const res = await post(
      setup().app,
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: KA, arguments: { query: 'x' } },
      },
      { 'x-api-key': 'other' },
    );

    expect((await res.json()).result).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: 'API key cannot access agent: kunnskapsassistenten' }],
      isError: true,
      _meta: { code: 'agent_not_authorized' },
    });
  });

  it('separates a malformed name, an unknown mode and an unknown agent as invalid params', async () => {
    const { app } = setup();
    const errors = await Promise.all(
      ['nosep', 'kunnskapsassistenten__ghost', 'other.agent__x'].map(
        async (n) => (await (await call(app, n, { query: 'x' })).json()).error,
      ),
    );

    expect(errors).toEqual([
      {
        code: -32602,
        message: "Tool name must contain '__': nosep",
        data: { code: 'invalid_tool_name' },
      },
      {
        code: -32602,
        message: 'Mode not available for agent: ghost',
        data: { code: 'mode_not_allowed' },
      },
      { code: -32602, message: 'Agent not found: other/agent', data: { code: 'agent_not_found' } },
    ]);
  });

  it('tells the model about a missing query, and refuses bad overrides as invalid params', async () => {
    const { app } = setup();
    const missing = await (await call(app, KA, { query: '  ' })).json();
    const unknownKey = await (
      await call(app, KA, { query: 'x', overrides: { 'retrieve-k': 3 } })
    ).json();
    const topK = await (
      await call(app, KA, { query: 'x', overrides: { 'retrieve-top-k': 500 } })
    ).json();
    const injection = await (
      await call(app, KA, {
        query: 'x',
        overrides: {
          'retrieve-filter-by': {
            fields: [{ field: 'orgs_short', 'selected-options': ['NAV`) || true'] }],
          },
        },
      })
    ).json();

    expect(missing.result).toEqual({
      resultType: 'complete',
      content: [{ type: 'text', text: 'Tool call requires a non-empty `query` argument.' }],
      isError: true,
      _meta: { code: 'missing_query' },
    });
    expect(unknownKey.error).toMatchObject({ code: -32602, data: { code: 'invalid_overrides' } });
    expect(unknownKey.error.message).toBe(
      'Unsupported override keys: ["retrieve-k"]. Accepted: retrieve-auto-filter, retrieve-filter-by, retrieve-top-k.',
    );
    expect(topK.error.message).toBe('`retrieve-top-k` must be an integer from 1 to 200.');
    expect(injection.error.data).toEqual({ code: 'invalid_overrides' });
    const badType = await (
      await call(app, KA, {
        query: 'x',
        overrides: {
          'retrieve-filter-by': { fields: [{ field: 'type', type: 'regex', value: 'a' }] },
        },
      })
    ).json();
    expect(badType.error.message).toBe(
      'Invalid `retrieve-filter-by`: type must be multiselect, contains or not-in-set.',
    );
  });

  it('reports a failed service to the model without leaking the internal error', async () => {
    const body = await (
      await call(setup().app, 'kunnskapsassistenten__broken', { query: 'x' })
    ).json();

    expect(body.result).toMatchObject({
      isError: true,
      content: [{ type: 'text', text: 'the service failed' }],
      _meta: { status: 'error', code: 'strategy_error', conversation_id: 'conv-1' },
    });
    expect(JSON.stringify(body)).not.toContain('postgres://');
  });

  it('streams progress and deltas as notifications, then the result, when a progress token is sent', async () => {
    const res = await call(setup().app, KA, { query: 'hei' }, { _meta: { progressToken: 'p1' } });
    const frames = sseFrames(await res.text());

    expect(res.headers.get('content-type')).toBe('text/event-stream; charset=utf-8');
    expect(res.headers.get('cache-control')).toBe('no-cache, no-transform');
    expect(res.headers.get('x-accel-buffering')).toBe('no');
    const progress = frames
      .filter((f) => f.method === 'notifications/progress')
      .map((f) => f.params as Record<string, unknown>);
    expect(progress.map((p) => [p.progress, p.message])).toEqual([
      [1, 'Request started'],
      [2, 'Agent Iterate'],
      [3, 'Iteration 1 of 4'],
      [4, 'Tool call: search'],
      [5, 'Svar '],
      [6, 'på: hei'],
    ]);
    expect(progress[1]?._meta).toEqual({ event: 'stage/started', stage: 'agent-iteration' });
    expect(progress[2]).toMatchObject({
      progressToken: 'p1',
      total: 4,
      _meta: { event: 'agent/iteration-started' },
    });
    expect(progress[4]?._meta).toEqual({ event: 'response/chunk', delta: 'Svar ' });
    const final = frames.at(-1) as {
      id: number;
      result: { isError: boolean; content: { text?: string }[] };
    };
    expect(final.id).toBe(7);
    expect(final.result.isError).toBe(false);
    expect(final.result.content[0]?.text).toBe('Svar på: hei');
  });

  it('sends each progress frame as it happens, before the task has a result', async () => {
    const res = await call(
      setup().app,
      'kunnskapsassistenten__slow',
      { query: 'x' },
      { _meta: { progressToken: 'p1' } },
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('"response/chunk"')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    await reader.cancel();

    const frames = sseFrames(text);
    expect(frames.map((f) => (f.params as { message?: string } | undefined)?.message)).toEqual([
      'Request started',
      'Starter',
    ]);
    expect(frames.some((f) => 'result' in f)).toBe(false);
  });

  it('delivers dispatch errors inside the stream when a progress token is sent', async () => {
    const res = await call(
      setup().app,
      'nosep',
      { query: 'x' },
      { _meta: { progress_token: 'p1' } },
    );

    expect(sseFrames(await res.text())).toEqual([
      {
        jsonrpc: '2.0',
        id: 7,
        error: {
          code: -32602,
          message: "Tool name must contain '__': nosep",
          data: { code: 'invalid_tool_name' },
        },
      },
    ]);
  });

  it('cancels the task when a streaming client disconnects', async () => {
    const { app, kernel } = setup();
    tasks.length = 0;
    const res = await call(
      app,
      'kunnskapsassistenten__slow',
      { query: 'x' },
      { _meta: { progressToken: 'p1' } },
    );
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();

    await reader.read();
    await reader.cancel();

    await until(
      async () =>
        tasks.length === 1 && (await kernel.task(kari, tasks[0] as string)).status === 'cancelled',
    );
  });

  it('cancels the task when a plain request is aborted', async () => {
    const { app, kernel } = setup();
    tasks.length = 0;
    const controller = new AbortController();
    const pending = post(
      app,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'kunnskapsassistenten__slow', arguments: { query: 'x' } },
      },
      {},
      controller.signal,
    ).catch(() => undefined);

    await until(async () => tasks.length === 1);
    controller.abort();
    await pending;

    await until(async () => (await kernel.task(kari, tasks[0] as string)).status === 'cancelled');
  });
});

describe('tool description wording', () => {
  it("describes chunk text with headless-rag's exact words", () => {
    const items = (
      defaultOutputSchema.properties as Record<
        string,
        { items: { properties: Record<string, { description?: string }> } }
      >
    ).chunks?.items.properties;
    expect(items?.content_markdown?.description).toBe(
      "The chunk's text. PRESENT ONLY when the skill graph read it; at most 8000 characters, so a value shorter than content_length was cut.",
    );
  });

  it('advertises a declared query with its minimum length under the public name', () => {
    const schema = advertisedInput({
      type: 'object',
      properties: {
        'user-query': { type: 'string', minLength: 1 },
        temperature: { type: 'number' },
      },
      required: ['user-query'],
    }) as { properties: Record<string, Record<string, unknown>>; required: string[] };
    expect(schema.properties.query).toMatchObject({ type: 'string', minLength: 1 });
    expect(schema.properties.temperature).toEqual({ type: 'number' });
    expect(schema.required).toEqual(['query']);
  });
});

describe('retrieval details in structuredContent', () => {
  const retrieval = (attribution: Record<string, unknown>) => ({
    mime: RETRIEVAL_MIME,
    body: {
      kind: 'json' as const,
      json: { queries: ['tildelingsbrev Digdir', 'Digdir 2025'], attribution },
    },
  });

  it('reports queries, search attribution and the auto filter in headless-rag keys', () => {
    const { structured } = defaultOutput([
      retrieval({
        phrase: 12,
        metadata: 3,
        content: 8,
        autoFilter: { field: 'orgs_long', options: ['Digdir'] },
        rerankEnabled: true,
        rerankMs: 420,
      }),
    ]);
    const filter = {
      fields: [
        {
          type: 'multiselect',
          field: 'orgs_long',
          'selected-options': ['Digdir'],
          'value-type': 'string',
        },
      ],
    };

    expect(structuredContent(structured, 'c1')).toEqual({
      conversation_id: 'c1',
      queries: ['tildelingsbrev Digdir', 'Digdir 2025'],
      search_attribution: {
        phrase: 12,
        metadata: 3,
        content: 8,
        'filter-applied': filter,
        'filter-source': 'auto',
        'auto-filter-applied': filter,
        'rerank-enabled?': true,
        'rerank-ms': 420,
      },
      filters_applied: [{ filter, source: 'auto', auto_detected: filter }],
      no_answer: true,
      notice: 'Fant ikke noe svar.',
    });
  });

  it("reports the caller's retrieve-filter-by as explicit, merged with a detected filter", () => {
    const caller = [
      {
        type: 'multiselect',
        field: 'type',
        'selected-options': ['Evaluering'],
        'value-type': 'string',
      },
    ];
    expect(searchAttribution({ callerFilter: caller })).toMatchObject({
      'filter-applied': { fields: caller },
      'filter-source': 'explicit',
    });
    expect(
      searchAttribution({
        callerFilter: caller,
        autoFilter: { field: 'orgs_long', options: ['Digdir'] },
      }),
    ).toMatchObject({
      'filter-applied': {
        fields: [
          ...caller,
          {
            type: 'multiselect',
            field: 'orgs_long',
            'selected-options': ['Digdir'],
            'value-type': 'string',
          },
        ],
      },
      'filter-source': 'merged',
    });
  });

  it('marks a dropped auto filter and applies no filter', () => {
    const { structured } = defaultOutput([
      retrieval({
        phrase: 0,
        autoFilter: { field: 'title', options: ['2025'] },
        autoFilterFallback: true,
      }),
    ]);

    expect(structured.search_attribution).toEqual({
      phrase: 0,
      'auto-filter-applied': {
        fields: [
          {
            type: 'contains',
            field: 'title',
            'selected-options': ['2025'],
            'value-type': 'string',
          },
        ],
      },
      'auto-filter-fallback': true,
    });
    expect(structured.filters_applied).toBeUndefined();
  });

  it('marks an empty answer with no_answer and a Norwegian notice', () => {
    const { text, structured } = defaultOutput([
      { mime: SOURCES_MIME, body: { kind: 'json', json: { sources: [{ chunkId: 'c1' }] } } },
    ]);

    expect(text).toBe('');
    expect(structuredContent(structured, 'c1')).toMatchObject({
      no_answer: true,
      notice: 'Fant ikke noe svar.',
      chunks: [{ chunk_id: 'c1' }],
    });
  });

  it('answers a fields service with its text field and returns the fields', () => {
    const fields = { text: 'Klar tekst.', changes: ['kortere'] };
    const { text, structured } = defaultOutput([
      { mime: 'application/json', body: { kind: 'json', json: fields } },
    ]);

    expect(text).toBe('Klar tekst.');
    expect(structuredContent(structured, 'c1')).toEqual({ conversation_id: 'c1', fields });
  });

  it('keeps filters the strategy already reported in its sources part', () => {
    const own = [{ filter: { fields: [] }, source: 'explicit' }];
    const { structured } = defaultOutput([
      { mime: SOURCES_MIME, body: { kind: 'json', json: { sources: [], filtersApplied: own } } },
      retrieval({ autoFilter: { field: 'orgs_long', options: ['Digdir'] } }),
    ]);

    expect(structured.filters_applied).toEqual(own);
  });
});

describe('AI marking and version pinning over MCP', () => {
  const pinning = (seen: (number | undefined)[]): CapabilityResolver => ({
    list: async () => entries,
    resolve: async (_p, name, options) => {
      seen.push(options?.version);
      if (options?.version === 9)
        return { ok: false, code: 'version_not_found', message: 'Tjenesten har ingen versjon 9.' };
      if (name === 'paused__default')
        return {
          ok: false,
          code: 'service_paused',
          message: 'Modellen tjenesten bruker er tatt ut av bruk',
        };
      const entry = entries.find((e) => e.id === name);
      return entry
        ? { ok: true, entry: { ...entry, version: options?.version ?? 4 } }
        : { ok: false, code: 'agent_not_found', message: name };
    },
  });
  const tool = (app: ReturnType<typeof setup>['app'], name: string, version?: string) =>
    post(
      app,
      { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: { query: 'x' } } },
      version ? { 'GenAI-Version': version } : {},
    );

  it('marks the answer as AI-generated in headers and _meta', async () => {
    const { app } = setup({ resolver: pinning([]), modelsOf: async () => ['foundry/gpt-4o'] });
    const res = await tool(app, KA);
    const body = await res.json();

    expect(res.headers.get('genai-generated-by')).toBe('ai');
    expect(res.headers.get('genai-model')).toBe('foundry/gpt-4o');
    expect(res.headers.get('genai-service-version')).toBe('4');
    expect(body.result._meta).toMatchObject({
      ai_generated: true,
      model: 'foundry/gpt-4o',
      service_version: 4,
    });
  });

  it('runs the pinned version, and refuses unknown or malformed versions', async () => {
    const seen: (number | undefined)[] = [];
    const { app } = setup({ resolver: pinning(seen) });
    const pinned = await tool(app, KA, '2');
    const missing = await tool(app, KA, '9');
    const malformed = await tool(app, KA, 'nyeste');

    expect(seen).toEqual([2, 9]);
    expect(pinned.headers.get('genai-service-version')).toBe('2');
    expect(missing.status).toBe(409);
    expect((await missing.json()).error.data).toEqual({ code: 'version_not_found' });
    expect(malformed.status).toBe(400);
  });

  it('answers 503 when the service is paused', async () => {
    const { app } = setup({ resolver: pinning([]) });
    const res = await tool(app, 'paused__default');

    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatchObject({
      message: 'Modellen tjenesten bruker er tatt ut av bruk',
      data: { code: 'service_paused' },
    });
  });

  it('passes the link the knowledge layer gave and gives no Kudos link to a bare numeric id', () => {
    const search = 'https://kudos.dfo.no/dokumenter?query=%C3%85rsrapport';
    const output = defaultOutput([
      {
        mime: SOURCES_MIME,
        body: {
          kind: 'json',
          json: {
            sources: [
              {
                chunkId: 'k1',
                document: '330296',
                title: 'Årsrapport',
                url: search,
                text: '# Mål\n\nSkal levere.',
              },
              { chunkId: 'a1', document: '4711', title: 'Arkivsak' },
            ],
          },
        },
      },
    ]);
    const wire = structuredContent(output.structured, 'c');

    const chunks = wire.chunks as Record<string, unknown>[];
    expect(chunks[0]).toMatchObject({ url: search, excerpt: 'Mål Skal levere.' });
    expect(chunks[1]).not.toHaveProperty('url');
    expect(resourceLinks({ chunks: [{ doc_num: '4711', title: 'Arkivsak' }] })[0]?.uri).toBe(
      'digdir://doc/4711',
    );
  });

  it('gives chunk titles, headers and resource link names without markdown', () => {
    const output = defaultOutput([
      {
        mime: SOURCES_MIME,
        body: {
          kind: 'json',
          json: {
            sources: [
              {
                chunkId: 'm1',
                title: '**Tildelingsbrev 2024**',
                headers: ['## **9. Budsjettmessige forutsetninger**', '`8.2.1` Rapportering'],
              },
            ],
          },
        },
      },
    ]);
    const chunk = (
      structuredContent(output.structured, 'c').chunks as Record<string, unknown>[]
    )[0];

    expect(chunk).toMatchObject({
      title: 'Tildelingsbrev 2024',
      metadata: {
        'Header 1': '9. Budsjettmessige forutsetninger',
        'Header 2': '8.2.1 Rapportering',
      },
    });
    expect(
      resourceLinks({
        chunks: [{ doc_num: 'd1', url: 'https://a.no/d1', title: '__Årsrapport__' }],
      })[0]?.name,
    ).toBe('Årsrapport');
  });
});

describe('MCP wire parity with headless-rag streams and KA', () => {
  const event = (data: Record<string, unknown>) => ({
    task: 't1',
    seq: 1,
    ts: '2026-10-09T00:00:00Z',
    v: 1,
    type: 'kernel.notice',
    data,
  });

  it('turns a completed agent turn into one tool/result frame per tool before the turn frame', () => {
    const track = progressTracker('p1', 'q');
    const frames = track(
      event({
        event: 'agent/turn-completed',
        iteration: 2,
        'tool-calls': [{ tool: 'search', 'ok?': true, 'result-summary': 'Fant 3 treff' }],
      }) as never,
    ) as { params: { message: string; _meta: Record<string, unknown> } }[];

    expect(frames.map((f) => f.params._meta.event)).toEqual([
      'tool/result',
      'agent/turn-completed',
    ]);
    expect(frames[0]?.params).toMatchObject({
      message: 'Tool result: search',
      _meta: {
        'tool-result': { tool: 'search', summary: 'Fant 3 treff', 'ok?': true, iteration: 2 },
      },
    });
  });

  it('brackets the agent iterations with stage/started and stage/completed', () => {
    const track = progressTracker('p1', 'q');
    const started = track(
      event({ event: 'agent/iteration-started', iteration: 0, 'max-iterations': 10 }) as never,
    ) as { params: { _meta: Record<string, unknown> } }[];
    track(event({ event: 'agent/iteration-started', iteration: 1, 'max-iterations': 10 }) as never);
    const finalized = track(
      event({ event: 'agent/finalized', iteration: 1, 'response-length': 4 }) as never,
    ) as { params: { _meta: Record<string, unknown> } }[];

    expect(started.map((f) => f.params._meta.event)).toEqual([
      'stage/started',
      'agent/iteration-started',
    ]);
    expect(finalized.map((f) => f.params._meta.event)).toEqual([
      'stage/completed',
      'agent/finalized',
    ]);
    expect(finalized[0]?.params._meta).toMatchObject({ stage: 'agent-iteration' });
  });

  it('raises the agent-exhausted warning when the loop runs out of iterations', () => {
    const frames = progressTracker(
      'p1',
      'q',
    )(event({ stage: 'exhausted', iterations: 10 }) as never) as {
      params: { message: string; _meta: Record<string, unknown> };
    }[];

    expect(frames[0]?.params).toMatchObject({
      message: 'Agent reached max iterations',
      _meta: { event: 'warning/raised', warning: { code: 'agent-exhausted' } },
    });
  });

  it("keeps chunks followed by queries or the closing brace, so KA's probe regex can count them", () => {
    const withQueries = JSON.stringify(
      structuredContent(
        { chunks: [{ chunk_id: 'c1' }], queries: ['q'], search_attribution: { phrase: 1 } },
        'c',
      ),
    );
    const withoutQueries = JSON.stringify(
      structuredContent({ chunks: [{ chunk_id: 'c1' }], search_attribution: { phrase: 1 } }, 'c'),
    );

    expect(withQueries).toMatch(/"chunks":\[[^\]]*\],"queries"/);
    expect(withoutQueries).toMatch(/"chunks":\[[^\]]*\]\}$/);
  });

  it('records the user turn before the run and the assistant turn with its chunks after', async () => {
    const turns: { id: string; role: string; text: string; chunks?: unknown[] }[] = [];
    const { app } = setup({
      conversations: {
        open: async (_request, input) => ({
          ok: true,
          id: input.conversationId ?? 'stored-1',
          history: [{ role: 'user', text: 'forrige' }],
        }),
        append: async (_request, id, turn) => {
          turns.push({ id, ...turn });
        },
      },
    });

    const body = await (await call(app, KA, { query: 'hei' })).json();

    expect(body.result.structuredContent.conversation_id).toBe('stored-1');
    expect(histories.at(-1)).toEqual([{ role: 'user', text: 'forrige' }]);
    expect(turns.map((t) => [t.id, t.role, t.text])).toEqual([
      ['stored-1', 'user', 'hei'],
      ['stored-1', 'assistant', 'Svar på: hei'],
    ]);
    expect(turns[1]?.chunks).toHaveLength(3);
  });

  it('answers the conversation store refusal as a tool error without running the service', async () => {
    const { app } = setup({
      conversations: {
        open: async () => ({
          ok: false,
          code: 'conversation_not_found',
          message: 'Conversation not found: x',
        }),
        append: async () => undefined,
      },
    });
    const before = tasks.length;

    const body = await (await call(app, KA, { query: 'hei', conversation_id: 'x' })).json();

    expect(body.result).toMatchObject({ isError: true, _meta: { code: 'conversation_not_found' } });
    expect(tasks.length).toBe(before);
  });

  it('still answers when storing the assistant turn fails', async () => {
    const { app } = setup({
      conversations: {
        open: async () => ({ ok: true, id: 'c', history: [] }),
        append: async (_r, _id, turn) => {
          if (turn.role === 'assistant') throw new Error('db down');
        },
      },
    });

    const body = await (await call(app, KA, { query: 'hei' })).json();

    expect(body.result.isError).toBe(false);
  });

  it("refuses a tenant and dataset_config_key outside the service's datasets with dataset_not_authorized", async () => {
    const scoped: CapabilityResolver = {
      list: resolver.list,
      resolve: async (principal, name) => {
        const r = await resolver.resolve(principal, name);
        return r.ok
          ? { ok: true, entry: { ...r.entry, datasets: ['digdir/kudos', 'psk/default'] } }
          : r;
      },
    };
    const { app } = setup({ resolver: scoped });

    const ok = await (
      await call(app, KA, { query: 'hei', tenant: 'psk', dataset_config_key: 'default' })
    ).json();
    const other = await (
      await call(app, KA, { query: 'hei', tenant: 'nav', dataset_config_key: 'default' })
    ).json();

    expect(ok.result.isError).toBe(false);
    expect(other.result).toMatchObject({
      isError: true,
      _meta: { code: 'dataset_not_authorized' },
    });
  });
});
