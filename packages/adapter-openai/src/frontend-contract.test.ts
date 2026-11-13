import { afterEach, describe, expect, it } from 'vitest';
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
let pool = chunks;

const seen: { history?: unknown; overrides?: unknown } = {};

const byDocument = {
  answer: 'Svar [1] og [2].',
  meta: {
    citations: [
      { index: 1, chunkId: 'c1' },
      { index: 2, chunkId: 'c2' },
    ],
  } as Record<string, unknown>,
};
let reply = byDocument;

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
    yield { type: 'kernel.part.delta', data: { text: reply.answer } };
    const parts: Part[] = [
      { ...textPart(reply.answer), meta: reply.meta },
      { mime: SOURCES_MIME, body: { kind: 'json', json: { sources: pool } } },
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

  it('stores a turn that cites documents as before, with no markers on the turn, its sources or their excerpts', async () => {
    const { ask, stored } = setup();

    await ask({ genai_conversation: true });
    const turn = stored.get('conv-1')?.[1];

    expect(turn).not.toHaveProperty('markers');
    expect(turn?.sources).toStrictEqual([
      {
        index: 1,
        title: 'Tildelingsbrev',
        url: 'https://x.no/d1',
        document_id: 'd1',
        excerpts: [
          { chunk_id: 'c1', text: 'Første', position: 0 },
          { chunk_id: 'c1b', text: 'Tredje', position: 4 },
        ],
      },
      {
        index: 2,
        title: 'Årsrapport',
        document_id: 'd2',
        excerpts: [{ chunk_id: 'c2', text: 'Andre', position: 0 }],
      },
    ]);
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
    expect(body).not.toHaveProperty('markers');
  });

  describe('when the answer cites excerpts', () => {
    afterEach(() => {
      reply = byDocument;
    });
    const byExcerpt = {
      answer: 'Første [1], tredje [2] og andre [3].',
      meta: {
        citations: [
          { index: 1, chunkId: 'c1', document: 'd1' },
          { index: 2, chunkId: 'c1b', document: 'd1' },
          { index: 3, chunkId: 'c2', document: 'd2' },
        ],
        citeBy: 'excerpt',
      },
    };
    const markers = [
      { marker: '1', chunk_id: 'c1', document: 'd1' },
      { marker: '2', chunk_id: 'c1b', document: 'd1' },
      { marker: '3', chunk_id: 'c2', document: 'd2' },
    ];

    it('resolves every marker to one excerpt, and lists on each excerpt the markers that cite it', async () => {
      reply = byExcerpt;
      const body = (await (await setup().ask({})).json()) as {
        sources: (Source & { markers?: string[] })[];
        markers?: unknown;
      };

      expect(body.markers).toEqual(markers);
      expect(body.sources.map((s) => [s.document_id, s.index, s.markers])).toEqual([
        ['d1', 1, ['1', '2']],
        ['d2', 3, ['3']],
      ]);
      expect(body.sources[0]?.excerpts).toEqual([
        { chunk_id: 'c1', text: 'Første', position: 0, markers: ['1'] },
        { chunk_id: 'c1b', text: 'Tredje', position: 4, markers: ['2'] },
      ]);
    });

    it('sends the same markers when the answer is streamed', async () => {
      reply = byExcerpt;
      const text = await (await setup().ask({ stream: true })).text();

      expect(text).toContain(`"markers":${JSON.stringify(markers)}`);
    });

    it('keeps the markers of an answer that cites excerpts when the turn is stored', async () => {
      reply = byExcerpt;
      const { ask, stored } = setup();

      const body = (await (await ask({ genai_conversation: true })).json()) as {
        markers?: unknown;
      };
      const turn = stored.get('conv-1')?.[1];

      expect(turn?.markers).toEqual(markers);
      expect(turn?.markers).toEqual(body.markers);
      expect(turn?.sources?.map((s) => [s.document_id, s.index, s.markers])).toEqual([
        ['d1', 1, ['1', '2']],
        ['d2', 3, ['3']],
      ]);
      expect(turn?.sources?.[0]?.excerpts).toStrictEqual([
        { chunk_id: 'c1', text: 'Første', position: 0, markers: ['1'] },
        { chunk_id: 'c1b', text: 'Tredje', position: 4, markers: ['2'] },
      ]);
    });

    it('stores each excerpt of a turn exactly as the answer gave it, every field kept', async () => {
      reply = byExcerpt;
      const { ask, stored } = setup();

      const body = (await (await ask({ genai_conversation: true })).json()) as {
        sources: Source[];
      };

      expect(stored.get('conv-1')?.[1]?.sources?.map((s) => s.excerpts)).toStrictEqual(
        body.sources.map((s) => s.excerpts),
      );
    });

    it('keeps the same markers on the stored turn when the answer is streamed', async () => {
      reply = byExcerpt;
      const { ask, stored } = setup();

      await (await ask({ genai_conversation: true, stream: true })).text();
      const turn = stored.get('conv-1')?.[1];

      expect(turn?.markers).toEqual(markers);
      expect(turn?.sources?.map((s) => s.markers)).toEqual([['1', '2'], ['3']]);
      expect(turn?.sources?.[0]?.excerpts.map((e) => e.markers)).toEqual([['1'], ['2']]);
    });
  });

  describe('when the chunks carry section headings', () => {
    afterEach(() => {
      pool = chunks;
    });
    const headed: SourceRecord[] = [
      { ...chunks[0], chunkId: 'c1', headers: ['# **1 Innledning**'] },
      { ...chunks[1], chunkId: 'c2' },
      { ...chunks[2], chunkId: 'c1b', headers: ['## **3 Styringsparametere**', '3.2 Mål'] },
    ];
    type Headed = Omit<Source, 'excerpts'> & {
      metadata: { name?: string }[];
      excerpts: { chunk_id: string; text: string; heading?: string }[];
    };
    const answer = async () => {
      pool = headed;
      return ((await (await setup().ask({})).json()) as { sources: Headed[] }).sources;
    };

    it("gives each excerpt its own heading, not the first excerpt's", async () => {
      const sources = await answer();

      expect(sources[0]?.excerpts.map((e) => [e.chunk_id, e.heading])).toEqual([
        ['c1', '1 Innledning'],
        ['c1b', '3 Styringsparametere › 3.2 Mål'],
      ]);
    });

    it('writes the heading as the document breadcrumb is written, plain levels joined by ›', async () => {
      const [first] = await answer();

      expect(first?.excerpts[1]?.heading).toBe('3 Styringsparametere › 3.2 Mål');
      expect(first?.metadata[0]?.name).toBe(`Tildelingsbrev › ${first?.excerpts[0]?.heading}`);
    });

    it('leaves the heading out when the chunk has no headers', async () => {
      const sources = await answer();

      expect(sources[1]?.excerpts).toHaveLength(1);
      expect(sources[1]?.excerpts[0]).not.toHaveProperty('heading');
    });

    it("keeps the document breadcrumb as it was, the first excerpt's under the title", async () => {
      const sources = await answer();

      expect(sources[0]?.metadata).toEqual([
        { source: 'c1', chunk_id: 'c1', name: 'Tildelingsbrev › 1 Innledning' },
      ]);
      expect(sources[1]?.metadata).toEqual([{ source: 'c2', chunk_id: 'c2' }]);
    });

    it('sends each excerpt its heading when the answer is streamed', async () => {
      pool = headed;
      const text = await (await setup().ask({ stream: true })).text();

      expect(text).toContain('"heading":"1 Innledning"');
      expect(text).toContain('"heading":"3 Styringsparametere › 3.2 Mål"');
    });
  });

  describe("when the headings carry Marker's page anchors", () => {
    afterEach(() => {
      pool = chunks;
    });
    const anchored: SourceRecord[] = [
      { ...chunks[0], chunkId: 'c1', headers: ['<span id="page-2-0"></span>1. Innledning'] },
      {
        ...chunks[1],
        chunkId: 'c2',
        headers: ['[DEL 3 – Aktiviteter og](#page-12-0) [resultater i 2024](#page-12-0)'],
      },
      {
        ...chunks[2],
        chunkId: 'c1b',
        headers: ['<span id="page-8-3"></span>', '5.2 Tildelingsbrev'],
      },
    ];
    type Headed = Omit<Source, 'excerpts'> & {
      metadata: { name?: string }[];
      excerpts: { chunk_id: string; heading?: string }[];
    };
    const answer = async (records: SourceRecord[]) => {
      pool = records;
      return ((await (await setup().ask({})).json()) as { sources: Headed[] }).sources;
    };

    it("gives a heading without Marker's page anchors", async () => {
      const [first] = await answer(anchored);

      expect(first?.excerpts[0]?.heading).toBe('1. Innledning');
    });

    it("gives a heading without Marker's links to its page anchors", async () => {
      const sources = await answer(anchored);

      expect(sources[1]?.excerpts[0]?.heading).toBe('DEL 3 – Aktiviteter og resultater i 2024');
    });

    it("gives a heading without Marker's underline and superscript tags", async () => {
      const [first] = await answer([
        { ...chunks[0], chunkId: 'c1', headers: ['<u>Styrken til porteføljen</u>'] },
        { ...chunks[2], chunkId: 'c1b', headers: ['Note <sup>a)</sup>'] },
      ]);

      expect(first?.excerpts.map((e) => e.heading)).toEqual(['Styrken til porteføljen', 'Note a)']);
    });

    it('raises a footnote number in a heading, written as a superscript or as a link to its page', async () => {
      const [first] = await answer([
        {
          ...chunks[0],
          chunkId: 'c1',
          headers: ['Tilgang i året <sup>1</sup>', 'KOSTRA – Gruppering[[11]](#page-35-0)'],
        },
        {
          ...chunks[2],
          chunkId: 'c1b',
          headers: ['Mål[\\[2\\]](#page-4-0) og tiltak[3](#page-5-1)'],
        },
      ]);

      expect(first?.excerpts.map((e) => e.heading)).toEqual([
        'Tilgang i året ¹ › KOSTRA – Gruppering¹¹',
        'Mål² og tiltak³',
      ]);
    });

    it('leaves out a heading level that is only markup', async () => {
      const [first] = await answer(anchored);
      const [bare] = await answer([
        { ...chunks[0], chunkId: 'c1', headers: ['<span id="page-3-0"></span>'] },
      ]);
      const [untitled] = await answer([
        {
          chunkId: 'c9',
          text: 'Niende',
          document: 'd9',
          headers: ['<span id="page-1-0"></span>', 'Mål'],
        },
      ]);

      expect(first?.excerpts[1]?.heading).toBe('5.2 Tildelingsbrev');
      expect(bare?.excerpts[0]).not.toHaveProperty('heading');
      expect(bare?.metadata).toEqual([{ source: 'c1', chunk_id: 'c1' }]);
      expect(untitled?.title).toBe('Mål');
    });

    it('keeps the breadcrumb plain text', async () => {
      const [first] = await answer(anchored);
      const [untitled] = await answer([
        {
          chunkId: 'c9',
          text: 'Niende',
          document: 'd9',
          headers: ['<span id="page-2-0"></span>1. Innledning', '1.1 Mål'],
        },
      ]);

      expect(first?.metadata[0]?.name).toBe('Tildelingsbrev › 1. Innledning');
      expect(untitled?.title).toBe('1. Innledning');
      expect(untitled?.metadata[0]?.name).toBe('1. Innledning › 1.1 Mål');
    });
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
