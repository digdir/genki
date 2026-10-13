import { describe, expect, it } from 'vitest';
import { textPart, type CapabilityDescriptor, type Part, type Principal } from '@genai/contracts';
import { createKernel, type Capability, type Emitted, type Strategy } from '@genai/kernel';
import {
  SOURCES_MIME,
  createOpenAiAdapter,
  type AskConversations,
  type AskTurn,
  type CapabilityResolver,
  type FilterIssue,
  type SourceRecord,
} from './index.js';

const TENANT = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: TENANT };

const chunks: SourceRecord[] = [
  {
    chunkId: 'c1',
    title: 'Tildelingsbrev',
    url: 'https://x.no/d1',
    text: 'Første',
    document: 'd1',
    position: 0,
  },
  { chunkId: 'c2', title: 'Årsrapport', text: 'Andre', document: 'd2', position: 0 },
  {
    chunkId: 'c1b',
    title: 'Tildelingsbrev',
    url: 'https://x.no/d1',
    text: 'Tredje',
    document: 'd1',
    position: 4,
  },
];

const seen: { history?: unknown; overrides?: unknown } = {};

const strategy: Strategy = {
  id: 'echo',
  version: '1',
  requires: { kernel: 1, ports: [], features: [] },
  run: async function* (_ctx, input): AsyncIterable<Emitted> {
    const data = input.data as { history?: unknown; overrides?: unknown };
    seen.history = data.history;
    seen.overrides = data.overrides;
    yield { type: 'kernel.notice', data: { event: 'agent/iteration-started', iteration: 1 } };
    yield { type: 'kernel.notice', data: { kind: 'retrieval', hits: 3 } };
    const answer = 'Svar [1] og [2].';
    yield { type: 'kernel.part.delta', data: { text: answer } };
    const parts: Part[] = [
      {
        ...textPart(answer),
        meta: {
          citations: [
            { index: 1, chunkId: 'c1' },
            { index: 2, chunkId: 'c2' },
          ],
        },
      },
      { mime: SOURCES_MIME, body: { kind: 'json', json: { sources: chunks } } },
    ];
    yield { type: 'kernel.result', data: parts };
  },
};

const descriptor: CapabilityDescriptor = {
  id: 'echo',
  version: '1',
  tenant: TENANT,
  title: 'echo',
  description: 'echo',
  input: { type: 'object', properties: { query: { type: 'string' } } },
  interaction: ['unary', 'stream'],
  accepts: [],
  produces: [],
  emits: [],
  oversight: { interrupts: false, riskClass: 'limited', aiDisclosure: 'KI' },
};

const capability: Capability = {
  descriptor,
  strategy: { id: 'echo', version: '1' },
  config: {},
  grants: [],
};

const resolver: CapabilityResolver = {
  list: async () => [],
  resolve: async () => ({
    ok: true,
    entry: {
      id: 'ka__default',
      capability: 'echo',
      agentId: 'ka-agent',
      datasets: ['digdir/kudos'],
    },
  }),
};

const fakeConversations = () => {
  const stored = new Map<string, AskTurn[]>();
  const conversations: AskConversations = {
    open: async (_request, { conversationId }) => {
      if (conversationId === undefined) {
        stored.set('conv-1', []);
        return { ok: true, id: 'conv-1', history: [] };
      }
      const turns = stored.get(conversationId);
      if (!turns)
        return { ok: false, code: 'conversation_not_found', message: 'Conversation not found' };
      return {
        ok: true,
        id: conversationId,
        history: turns.map((t) => ({ role: t.role, text: t.text })),
      };
    },
    append: async (_request, id, turn) => {
      stored.get(id)?.push(turn);
    },
    discard: async (_request, id) => {
      stored.delete(id);
    },
  };
  return { stored, conversations };
};

const filterIssues = async (
  _principal: Principal,
  _entry: unknown,
  filters: unknown,
): Promise<FilterIssue[]> => {
  const fields = (filters as { fields?: { field: string }[] }).fields ?? [];
  return fields.flatMap((f, i) =>
    f.field === 'type'
      ? []
      : [{ path: `filters.fields[${i}].field`, message: `Unknown filter field "${f.field}".` }],
  );
};

const setup = () => {
  const kernel = createKernel({
    strategies: [strategy],
    capabilities: [capability],
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  const memory = fakeConversations();
  const app = createOpenAiAdapter({
    kernel,
    resolver,
    auth: { authenticate: async () => kari },
    conversations: memory.conversations,
    filterIssues,
    overridePolicy: { check: () => ({ ok: true }) },
    newId: () => 'fixed',
  });
  const ask = (body: Record<string, unknown>) =>
    app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'ka__default',
        messages: [{ role: 'user', content: 'Hva?' }],
        ...body,
      }),
    });
  return { ask, ...memory };
};

type Source = {
  index?: number;
  title: string;
  url?: string;
  document_id?: string;
  excerpts: { chunk_id: string; text: string }[];
};

describe('/v1 frontend contract: conversations', () => {
  it('stays stateless without conversation_id: no id in the response and nothing stored', async () => {
    const { ask, stored } = setup();

    const body = (await (await ask({})).json()) as Record<string, unknown>;

    expect(body).not.toHaveProperty('conversation_id');
    expect(stored.size).toBe(0);
  });

  it('creates a conversation on genai_conversation and stores the user and assistant turn with sources', async () => {
    const { ask, stored } = setup();

    const body = (await (await ask({ genai_conversation: true })).json()) as {
      conversation_id: string;
    };

    expect(body.conversation_id).toBe('conv-1');
    expect(stored.get('conv-1')?.map((t) => t.role)).toEqual(['user', 'assistant']);
    expect(stored.get('conv-1')?.[1]?.chunks?.map((c) => c.chunkId)).toEqual(['c1', 'c2', 'c1b']);
  });

  it('stores the sources of an assistant turn with index, title and url so [N] resolves when reopened', async () => {
    const { ask, stored } = setup();

    await ask({ genai_conversation: true });

    expect(stored.get('conv-1')?.[1]?.sources).toEqual([
      expect.objectContaining({ index: 1, title: 'Tildelingsbrev', url: 'https://x.no/d1' }),
      expect.objectContaining({ index: 2, title: 'Årsrapport', document_id: 'd2' }),
    ]);
    expect(stored.get('conv-1')?.[1]?.sources?.[1]).not.toHaveProperty('url');
  });

  it('creates no conversation when the request fails validation', async () => {
    const { ask, stored } = setup();

    const refused = await ask({
      genai_conversation: true,
      genai_documents: [{ name: 'a.txt', media_type: 'text/plain', data: 'aGVp' }],
    });

    expect(refused.status).toBe(400);
    expect(stored.size).toBe(0);
  });

  it('loads stored history for a given conversation_id instead of trusting the messages array', async () => {
    const { ask } = setup();
    await ask({ genai_conversation: true });

    await ask({
      conversation_id: 'conv-1',
      messages: [
        { role: 'assistant', content: 'påstand fra klienten' },
        { role: 'user', content: 'Og så?' },
      ],
    });

    expect(seen.history).toEqual([
      { role: 'user', text: 'Hva?' },
      { role: 'assistant', text: 'Svar [1] og [2].' },
    ]);
  });

  it('answers 404 conversation_not_found for an unknown conversation_id', async () => {
    const response = await setup().ask({ conversation_id: 'nope' });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ error: { code: 'conversation_not_found' } });
  });

  it('refuses a conversation_id that is not a string', async () => {
    const response = await setup().ask({ conversation_id: 7 });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_conversation_id' } });
  });

  it('announces the conversation id in the first stream frame and the genai-conversation header', async () => {
    const response = await setup().ask({ genai_conversation: true, stream: true });

    const text = await response.text();

    expect(response.headers.get('genai-conversation')).toBe('conv-1');
    expect(text.split('\n\n')[0]).toContain('"conversation_id":"conv-1"');
  });
});

describe('/v1 frontend contract: filters', () => {
  const filters = { fields: [{ field: 'type', 'selected-options': ['Tildelingsbrev'] }] };

  it('hands filters to retrieval as retrieve-filter-by', async () => {
    const response = await setup().ask({ filters });

    expect(response.status).toBe(200);
    expect(seen.overrides).toEqual({ 'retrieve-filter-by': filters });
  });

  it('answers 400 invalid_filters with a path per field the dataset does not declare', async () => {
    const response = await setup().ask({
      filters: { fields: [{ field: 'secret', 'selected-options': ['x'] }] },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: { code: 'invalid_filters' },
      errors: [{ path: 'filters.fields[0].field' }],
    });
  });

  it('refuses filters together with overrides.retrieve-filter-by', async () => {
    const response = await setup().ask({
      filters,
      overrides: { 'retrieve-filter-by': filters },
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: { code: 'invalid_filters' } });
  });
});

describe('/v1 frontend contract: sources', () => {
  it('gives one source per cited document, indexed by the [N] in the answer, with every chunk as an excerpt', async () => {
    const body = (await (await setup().ask({})).json()) as { sources: Source[] };

    expect(body.sources.map((s) => s.index)).toEqual([1, 2]);
    expect(body.sources[0]).toMatchObject({
      title: 'Tildelingsbrev',
      url: 'https://x.no/d1',
      document_id: 'd1',
      excerpts: [
        { chunk_id: 'c1', text: 'Første' },
        { chunk_id: 'c1b', text: 'Tredje' },
      ],
    });
    expect(body.sources[1]).toMatchObject({ title: 'Årsrapport', document_id: 'd2' });
    expect(body.sources[1]).not.toHaveProperty('url');
  });
});

describe('/v1 frontend contract: steps', () => {
  const stepFrames = (text: string) => text.split('\n\n').filter((f) => f.includes('genai_step'));

  it('streams step events only when genai_steps is true', async () => {
    const { ask } = setup();

    const plain = await (await ask({ stream: true })).text();
    const stepped = await (await ask({ stream: true, genai_steps: true })).text();

    expect(stepFrames(plain)).toEqual([]);
    expect(stepFrames(stepped)[0]).toContain(
      '"genai_step":{"event":"agent/iteration-started","iteration":1}',
    );
  });

  it('never sends a step frame without any of the documented step members', async () => {
    const { ask } = setup();

    const stepped = await (await ask({ stream: true, genai_steps: true })).text();

    expect(stepFrames(stepped)).toHaveLength(1);
    expect(stepped).not.toContain('"genai_step":{}');
  });
});
