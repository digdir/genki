import { ApiError, type StreamEvent } from '@genai/client';
import { emptyLayout, readFootnotes } from '@genai/ui-blocks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AssistantApi,
  createGenkiApi,
  failureOf,
  filterSet,
  FilterTooLarge,
  type GenkiApiOptions,
  HttpError,
  sourceFromWire,
} from './api.js';
import { profileOf, type FieldSpec } from './profile.js';

// A service that cites excerpts: one document, two excerpts, `[1]` and `[2]` one each.
const wireSource = {
  index: 1,
  title: 'Årsrapport 2023',
  document_id: '42',
  excerpts: [
    { chunk_id: 'c1', text: 'Ventetiden gikk ned.', position: 0, markers: ['1'] },
    { chunk_id: 'c2', text: 'Svartiden var kort.', position: 1, markers: ['2'] },
  ],
  markers: ['1', '2'],
};
const wireMarkers = [
  { marker: '1', chunk_id: 'c1', document: '42' },
  { marker: '2', chunk_id: 'c2', document: '42' },
];
const markers = [
  { marker: '1', chunkId: 'c1', documentId: '42' },
  { marker: '2', chunkId: 'c2', documentId: '42' },
];

// A turn answered through MCP has no `sources`: here three chunks from two documents.
const chunks = [
  {
    chunkId: 'c1',
    docTitle: 'Årsrapport 2020',
    docNum: 'd20',
    contentMarkdown: 'Lønn var 153 mill.',
  },
  { chunkId: 'c2', docTitle: 'Årsrapport 2020', docNum: 'd20', contentMarkdown: '176 ansatte.' },
  { chunkId: 'c3', docTitle: 'Årsrapport 2022', docNum: 'd22', contentMarkdown: '169 ansatte.' },
];
const chunkMarkers = [
  { marker: '1', chunk_id: 'c3', document: 'd22' },
  { marker: '2', chunk_id: 'c1', document: 'd20' },
];

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const stream = (...frames: unknown[]) =>
  new Response(
    frames.map((f) => `data: ${typeof f === 'string' ? f : JSON.stringify(f)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const api = () => createGenkiApi({ baseUrl: '/genki', tenant: 'digdir' });

afterEach(() => vi.unstubAllGlobals());

describe('the excerpt markers a service names', () => {
  it('passes on the markers @genai/client reads off the stream, on `sources` and on the answer', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/conversations')
          ? json({ conversation: { id: 't1' } })
          : stream(
              { id: 'a1', choices: [{ delta: { content: 'Ned [1], kort [2].' } }] },
              { id: 'a1', sources: [wireSource], citations: [], markers: wireMarkers },
              '[DONE]',
            ),
      ),
    );
    const events: StreamEvent[] = [];
    for await (const event of api().ask({
      question: 'Ventetid?',
      model: 'ka__default',
      dataset: { tenant: 'digdir', key: 'kudos' },
      steps: false,
      signal: new AbortController().signal,
    }))
      events.push(event);
    const sources = events.find((e) => e.type === 'sources');
    const done = events.find((e) => e.type === 'done');
    expect(sources?.type === 'sources' && sources.markers).toEqual(markers);
    expect(done?.type === 'done' && done.answer.markers).toEqual(markers);
  });

  it('reads a stored turn’s markers off its excerpts when the turn keeps no list of its own', async () => {
    const { index, title, document_id, excerpts } = wireSource;
    const storedSource = { index, title, document_id, excerpts };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          conversation: { id: 't1', topic: 'Ventetid', tags: ['corpus:kudos'], created: 1 },
          messages: [
            { id: 'q', role: 'user', text: 'Ventetid?', created: 1, chunks: [] },
            {
              id: 'a',
              role: 'assistant',
              text: 'Ned [1], kort [2].',
              created: 2,
              chunks: [],
              sources: [storedSource],
            },
          ],
        }),
      ),
    );
    const { turns } = await api().loadThread('t1');
    expect(turns[0]?.answer?.markers).toEqual(markers);
  });

  const reloadTurn = async (turn: Record<string, unknown>) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          conversation: { id: 't1', topic: 'Ventetid', tags: [], created: 1 },
          messages: [
            { id: 'q', role: 'user', text: 'Ventetid?', created: 1, chunks: [] },
            {
              id: 'a',
              role: 'assistant',
              text: 'Ned [1], kort [2].',
              created: 2,
              chunks: [],
              ...turn,
            },
          ],
        }),
      ),
    );
    return (await api().loadThread('t1')).turns[0]?.answer;
  };

  const reload = (sources: unknown[]) => reloadTurn({ text: 'Ned [1].', sources });

  it('leads a stored marker to the excerpt as drawn, also one without an id of its own', async () => {
    const answer = await reload([
      {
        index: 1,
        title: 'Årsrapport 2023',
        excerpts: [{ text: 'Ventetiden gikk ned.', markers: ['1'] }],
      },
    ]);
    const chunkId = answer?.sources?.[0]?.excerpts[0]?.chunkId;
    expect(chunkId).toMatch(/^minted:/);
    expect(answer?.markers).toEqual([{ marker: '1', chunkId }]);
  });

  it('opens a thread whose stored markers are not text, without those markers', async () => {
    const answer = await reload([
      {
        index: 1,
        title: 'Årsrapport 2023',
        document_id: '42',
        excerpts: [
          { chunk_id: 'c1', text: 'Ventetiden gikk ned.', markers: 7 },
          { chunk_id: 'c2', text: 'Svartiden var kort.', markers: [2, '2'] },
        ],
      },
    ]);
    expect(answer?.markers).toEqual([{ marker: '2', chunkId: 'c2', documentId: '42' }]);
  });

  it('reads the markers of a stored turn that cites excerpts from the turn’s own list', async () => {
    const { index, title, document_id } = wireSource;
    const excerpts = wireSource.excerpts.map(({ chunk_id, text, position }) => ({
      chunk_id,
      text,
      position,
    }));
    const answer = await reloadTurn({
      sources: [{ index, title, document_id, excerpts }],
      markers: wireMarkers,
    });
    expect(answer?.markers).toEqual(markers);
  });

  it('follows a stored turn’s own markers where its excerpts name others', async () => {
    const answer = await reloadTurn({
      sources: [wireSource],
      markers: [
        { marker: '1', chunk_id: 'c2', document: '42' },
        { marker: '2', chunk_id: 'c1', document: '42' },
      ],
    });
    expect(answer?.markers).toEqual([
      { marker: '1', chunkId: 'c2', documentId: '42' },
      { marker: '2', chunkId: 'c1', documentId: '42' },
    ]);
  });

  it('gives a chunks-only stored turn its stored markers, not positions', async () => {
    const answer = await reloadTurn({ chunks, markers: chunkMarkers });
    expect(answer?.markers).toEqual([
      { marker: '1', chunkId: 'c3', documentId: 'd22' },
      { marker: '2', chunkId: 'c1', documentId: 'd20' },
    ]);
  });

  it('keeps only the stored markers that name their excerpt and document', async () => {
    const answer = await reloadTurn({
      chunks,
      markers: [
        chunkMarkers[0],
        { marker: '2', chunk_id: 'c1' },
        { marker: 3, chunk_id: 'c2', document: 'd20' },
        { chunk_id: 'c2', document: 'd20' },
        '4',
        null,
      ],
    });
    expect(answer?.markers).toEqual([{ marker: '1', chunkId: 'c3', documentId: 'd22' }]);
  });

  it('reads a chunks-only stored turn by document when none of its markers names an excerpt', async () => {
    const answer = await reloadTurn({ chunks, markers: [{ marker: '1' }, '2'] });
    expect(answer?.markers).toBeUndefined();
    expect(answer?.sources?.map((s) => [s.index, s.documentId])).toEqual([
      [1, 'd20'],
      [2, 'd22'],
    ]);
  });

  it('numbers a chunks-only stored turn without markers by document, never by chunk position', async () => {
    const answer = await reloadTurn({ chunks });
    expect(answer?.markers).toBeUndefined();
    expect(answer?.sources?.map((s) => [s.index, s.documentId])).toEqual([
      [1, 'd20'],
      [2, 'd22'],
    ]);
    expect(answer?.sources?.[0]?.excerpts.map((e) => e.chunkId)).toEqual(['c1', 'c2']);
  });

  it('pairs each footnote of a reloaded answer with its excerpt', async () => {
    const answer = await reloadTurn({ chunks, markers: chunkMarkers });
    const { pairing } = readFootnotes(answer?.text ?? '', answer?.sources, answer?.markers);
    expect(pairing.mode).toBe('excerpt');
    expect(pairing.targets).toEqual(['c3', 'c1']);
    expect(pairing.unpaired).toEqual([]);
  });

  it('names no markers for a service that cites documents', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          conversation: { id: 't1', topic: 'Ventetid', tags: [], created: 1 },
          messages: [
            { id: 'q', role: 'user', text: 'Ventetid?', created: 1, chunks: [] },
            {
              id: 'a',
              role: 'assistant',
              text: 'Ned [1].',
              created: 2,
              chunks: [],
              sources: [{ index: 1, title: 'Årsrapport 2023', document_id: '42' }],
            },
          ],
        }),
      ),
    );
    const { turns } = await api().loadThread('t1');
    expect(turns[0]?.answer?.markers).toBeUndefined();
  });
});

describe('a source from the wire', () => {
  it('gives each excerpt without an id one of its own, the same on every read', () => {
    const raw = {
      title: 'Årsrapport 2023',
      document_id: '7',
      excerpts: [{ text: 'Først.' }, { text: 'Så.' }, { chunk_id: 'c9', text: 'Med id.' }],
    };
    const ids = sourceFromWire(raw).excerpts.map((excerpt) => excerpt.chunkId);
    expect(ids).toEqual(['minted:7:0', 'minted:7:1', 'c9']);
    expect(sourceFromWire(raw).excerpts.map((excerpt) => excerpt.chunkId)).toEqual(ids);
  });

  it('keeps the minted ids of two sources without a document id apart, by their place', () => {
    const raw = { title: 'Uten nummer', excerpts: [{ text: 'Et utdrag.' }] };
    const first = sourceFromWire(raw, undefined, 0).excerpts[0]?.chunkId;
    const second = sourceFromWire(raw, undefined, 1).excerpts[0]?.chunkId;
    expect(first).not.toBe(second);
  });

  it('leaves a missing title empty, for the blocks to name in the reader’s language', () => {
    expect(sourceFromWire({ excerpts: [] }).title).toBe('');
  });

  it("keeps each excerpt's heading for the Sources block to title it by", () => {
    const { excerpts } = sourceFromWire({
      title: 'Tildelingsbrev',
      document_id: '7',
      excerpts: [
        { chunk_id: 'c1', text: 'Først.', heading: '1 Innledning' },
        { chunk_id: 'c7', text: 'Så.', heading: '3 Styringsparametere › 3.2 Mål' },
      ],
    });
    expect(excerpts.map((excerpt) => excerpt.heading)).toEqual([
      '1 Innledning',
      '3 Styringsparametere › 3.2 Mål',
    ]);
  });

  it('leaves the heading out when the excerpt has none, or a stored one that is not text', () => {
    const { excerpts } = sourceFromWire({
      title: 'Tildelingsbrev',
      document_id: '7',
      excerpts: [
        { chunk_id: 'c1', text: 'Først.', heading: '1 Innledning' },
        { chunk_id: 'c2', text: 'Så.' },
        { chunk_id: 'c3', text: 'Til slutt.', heading: 3 as unknown as string },
      ],
    });
    expect(excerpts.map((excerpt) => 'heading' in excerpt)).toEqual([true, false, false]);
  });

  it('links a source without a link of its own from the collection’s templates, and keeps one it has', () => {
    const corpus = { documentLinks: { digits: 'https://example.org/documents/{id}' } };
    expect(sourceFromWire({ document_id: '7', excerpts: [] }, corpus).url).toBe(
      'https://example.org/documents/7',
    );
    expect(
      sourceFromWire({ document_id: '7', url: 'https://source.example/7', excerpts: [] }, corpus)
        .url,
    ).toBe('https://source.example/7');
  });

  it('links each document of a stored turn of chunks from the collection’s templates', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          conversation: { id: 't1', topic: 'Ansatte', tags: ['corpus:kudos'], created: 1 },
          messages: [
            { id: 'q', role: 'user', text: 'Ansatte?', created: 1, chunks: [] },
            { id: 'a', role: 'assistant', text: '176 [1].', created: 2, chunks },
          ],
        }),
      ),
    );
    const linked = createGenkiApi({
      baseUrl: '/genki',
      tenant: 'digdir',
      profile: { corpora: { kudos: { documentLinks: { any: 'https://example.org/d/{id}' } } } },
    });
    const sources = (await linked.loadThread('t1')).turns[0]?.answer?.sources;
    expect(sources?.map((source) => source.url)).toEqual([
      'https://example.org/d/d20',
      'https://example.org/d/d22',
    ]);
  });

  // A stored thread with these tags; none is one asked in another client.
  const storedThread = (tags: string[]) =>
    vi.fn(async () =>
      json({
        conversation: { id: 't1', topic: 'Ventetid', tags, created: 1 },
        messages: [
          { id: 'q', role: 'user', text: 'Ventetid?', created: 1, chunks: [] },
          {
            id: 'a',
            role: 'assistant',
            text: 'Ned [1].',
            created: 2,
            chunks: [],
            sources: [wireSource],
          },
        ],
      }),
    );
  const kudos = { documentLinks: { digits: 'https://example.org/documents/{id}' } };
  const linksIn = async (api: AssistantApi) =>
    (await api.loadThread('t1')).turns[0]?.answer?.sources?.map((source) => source.url);

  it('links the documents of a thread that names no collection from the profile’s only collection', async () => {
    vi.stubGlobal('fetch', storedThread([]));
    const linked = createGenkiApi({
      baseUrl: '/genki',
      tenant: 'digdir',
      profile: { corpora: { kudos } },
    });
    expect(await linksIn(linked)).toEqual(['https://example.org/documents/42']);
  });

  it('names no collection for a thread that names none, though its documents are linked', async () => {
    vi.stubGlobal('fetch', storedThread([]));
    const linked = createGenkiApi({
      baseUrl: '/genki',
      tenant: 'digdir',
      profile: { corpora: { kudos } },
    });
    expect((await linked.loadThread('t1')).corpus).toBeUndefined();
  });

  it('guesses no collection for a thread that names none when the profile describes several', async () => {
    vi.stubGlobal('fetch', storedThread([]));
    const several = createGenkiApi({
      baseUrl: '/genki',
      tenant: 'digdir',
      profile: {
        corpora: { kudos, other: { documentLinks: { any: 'https://other.example/{id}' } } },
      },
    });
    expect(await linksIn(several)).toEqual([undefined]);
  });

  it('links no document of a thread whose collection the profile does not describe', async () => {
    vi.stubGlobal('fetch', storedThread(['corpus:other']));
    const linked = createGenkiApi({
      baseUrl: '/genki',
      tenant: 'digdir',
      profile: { corpora: { kudos } },
    });
    expect(await linksIn(linked)).toEqual([undefined]);
  });
});

// The run feedback is sent on, from `task` on a stored message.
describe('the run behind an answer', () => {
  it('is kept from the stored message for a thread opened again', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          conversation: { id: 't1', topic: 'Tråd', tags: [] },
          messages: [
            { id: 'm1', role: 'user', text: 'Hva er fast?', created: 1, chunks: [] },
            { id: 'm2', role: 'assistant', text: 'Svar.', created: 2, chunks: [], task: 'task-7' },
          ],
        }),
      ),
    );
    const { turns } = await api().loadThread('t1');
    expect(turns[0]?.answer?.runId).toBe('task-7');
  });

  it('is left out of a stored message that names none', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          conversation: { id: 't1', topic: 'Tråd', tags: [] },
          messages: [{ id: 'm2', role: 'assistant', text: 'Svar.', created: 2, chunks: [] }],
        }),
      ),
    );
    const { turns } = await api().loadThread('t1');
    expect(turns[0]?.answer).not.toHaveProperty('runId');
  });
});

// A host that calls genki with the person's token, as the workspace does.
describe('the host’s credentials', () => {
  // genki, refusing with 401 where `refused` says; returns each request's address and headers.
  const genki = (refused: (url: string) => boolean = () => false, threadStatus = 200) => {
    const sent: { url: string; headers: Headers }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        sent.push({ url, headers: new Headers(init?.headers) });
        if (refused(url)) return Response.json({ error: 'unauthorized' }, { status: 401 });
        const path = url.split('?')[0];
        if (path === '/genki/api/conversations' && init?.method === 'POST')
          return threadStatus === 200
            ? json({ conversation: { id: 't1' } })
            : Response.json({ error: 'not here' }, { status: threadStatus });
        if (path === '/genki/v1/models') return json({ data: [] });
        if (path === '/genki/api/conversations') return json({ conversations: [] });
        if (path === '/genki/api/conversations/t1')
          return json({ conversation: { id: 't1', topic: null, tags: [] }, messages: [] });
        if (path === '/genki/api/datasets') return json({ datasets: [] });
        if (path === '/genki/api/datasets/kudos')
          return json({ dataset: { filters: [{ field: 'year', kinds: ['multiselect'] }] } });
        if (path === '/genki/api/facets') return json({ fields: [] });
        return stream({ id: 'a1', choices: [{ delta: { content: 'Svar.' } }] }, '[DONE]');
      }),
    );
    return sent;
  };

  const withHeaders = (headers: GenkiApiOptions['headers']) =>
    createGenkiApi({ baseUrl: '/genki', tenant: 'digdir', headers });

  const ask = async (assistant: AssistantApi, conversationId?: string) => {
    const events: StreamEvent[] = [];
    for await (const event of assistant.ask({
      question: 'Ventetid?',
      model: 'ka__default',
      conversationId,
      steps: true,
      signal: new AbortController().signal,
    }))
      events.push(event);
    return events;
  };

  const bearer = () => ({ authorization: 'Bearer tok' });

  it('sends the host’s headers with every read', async () => {
    const sent = genki();
    const reads = withHeaders(bearer);
    await reads.loadModels();
    await reads.loadThreads();
    await reads.loadThread('t1');
    await reads.loadCorpora();
    await reads.loadFacets({}, 'kudos', await reads.loadFields('kudos'));
    expect(sent.map((r) => [r.url.split('?')[0], r.headers.get('authorization')])).toEqual([
      ['/genki/v1/models', 'Bearer tok'],
      ['/genki/api/conversations', 'Bearer tok'],
      ['/genki/api/conversations/t1', 'Bearer tok'],
      ['/genki/api/datasets', 'Bearer tok'],
      ['/genki/api/datasets/kudos', 'Bearer tok'],
      ['/genki/api/facets', 'Bearer tok'],
    ]);
  });

  it('sends the host’s headers with the new thread and with the question’s stream', async () => {
    const sent = genki();
    await ask(withHeaders(async () => bearer()));
    expect(sent.map((r) => [r.url, r.headers.get('authorization')])).toEqual([
      ['/genki/api/conversations', 'Bearer tok'],
      ['/genki/v1/chat/completions', 'Bearer tok'],
    ]);
  });

  it('asks the host for its headers before each request, so a renewed token is used', async () => {
    const sent = genki();
    let renewed = 0;
    await ask(
      withHeaders(() => {
        renewed += 1;
        return { authorization: `Bearer tok-${renewed}` };
      }),
    );
    expect(sent.map((r) => r.headers.get('authorization'))).toEqual([
      'Bearer tok-1',
      'Bearer tok-2',
    ]);
  });

  it('keeps the assembly’s own Accept and Content-Type over the host’s', async () => {
    const sent = genki();
    await ask(
      withHeaders(() => ({ ...bearer(), accept: 'text/html', 'content-type': 'text/plain' })),
    );
    expect(sent.map((r) => [r.headers.get('accept'), r.headers.get('content-type')])).toEqual([
      ['application/json', 'application/json'],
      ['text/event-stream', 'application/json'],
    ]);
  });

  it('adds no credentials for a host that passes none, as one behind a proxy', async () => {
    const sent = genki();
    const plain = api();
    await plain.loadModels();
    await ask(plain);
    expect(sent.map((r) => r.headers.has('authorization'))).toEqual([false, false, false]);
  });

  it('fails a read refused with 401 with that status, which the assembly calls access', async () => {
    genki(() => true);
    const error = await withHeaders(bearer)
      .loadModels()
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect((error as HttpError).status).toBe(401);
    expect(failureOf(error)).toEqual({ kind: 'access' });
  });

  it('fails a question whose stream is refused with 401 with that status, as access', async () => {
    genki((url) => url.endsWith('/v1/chat/completions'));
    const error = await ask(withHeaders(bearer), 't1').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(401);
    expect(failureOf(error)).toEqual({ kind: 'access' });
  });

  it('stops at a new thread refused with 401, without sending the question', async () => {
    const sent = genki((url) => url.endsWith('/api/conversations'));
    const error = await ask(withHeaders(bearer)).catch((e: unknown) => e);
    expect((error as HttpError).status).toBe(401);
    expect(failureOf(error)).toEqual({ kind: 'access' });
    expect(sent.map((r) => r.url)).toEqual(['/genki/api/conversations']);
  });

  it('asks without a thread when the new thread fails for another reason', async () => {
    const sent = genki(() => false, 404);
    const events = await ask(withHeaders(bearer));
    expect(sent.map((r) => r.url)).toEqual([
      '/genki/api/conversations',
      '/genki/v1/chat/completions',
    ]);
    expect(events.some((e) => e.type === 'conversation')).toBe(false);
  });
});

// genki's filter takes at most 100 values a field (`maxOptions` in adapter-rest's filters.ts).
describe('the filter as genki takes it', () => {
  const names = (count: number, from = 1) =>
    Array.from({ length: count }, (_, i) => `Virksomhet ${from + i}`);
  const organisations = [{ id: 'org', label: 'Virksomheter' }];
  const listed = (id: string, values: readonly string[]) => [
    { id, label: id, options: values.map((value) => ({ value, count: 1 })) },
  ];

  it('sends a field with at most 100 chosen as the values chosen', () => {
    expect(filterSet({ org: names(100) }, organisations, listed('org', names(150)))).toEqual({
      fields: [
        {
          field: 'org',
          type: 'multiselect',
          'value-type': 'string',
          'selected-options': names(100),
        },
      ],
    });
  });

  it('sends a field with more than 100 chosen and at most 100 left out as the values left out', () => {
    expect(filterSet({ org: names(101) }, organisations, listed('org', names(150)))).toEqual({
      fields: [
        {
          field: 'org',
          type: 'not-in-set',
          'value-type': 'string',
          'selected-options': names(49, 102),
        },
      ],
    });
  });

  it('leaves out a year field’s years as integers', () => {
    const years = Array.from({ length: 150 }, (_, i) => String(1900 + i));
    expect(
      filterSet(
        { year: years.slice(0, 101) },
        [{ id: 'year', label: 'År', kind: 'year', integer: true }],
        listed('year', years),
      ),
    ).toEqual({
      fields: [
        {
          field: 'year',
          type: 'not-in-set',
          'value-type': 'integer',
          'selected-options': Array.from({ length: 49 }, (_, i) => 2001 + i),
        },
      ],
    });
  });

  it('refuses a field with more than 100 chosen and more than 100 left out, naming it', () => {
    expect(() => filterSet({ org: names(101) }, organisations, listed('org', names(202)))).toThrow(
      new FilterTooLarge('org'),
    );
  });

  it('refuses a field with more than 100 chosen when the values it has are not known', () => {
    expect(() => filterSet({ org: names(101) }, organisations)).toThrow(FilterTooLarge);
  });
});

// A layout's profile says nothing of the wire; the dataset does.
describe('the fields a profile chooses', () => {
  const dataset = () =>
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          dataset: {
            filters: [
              { field: 'type', kinds: ['multiselect'], 'value-type': 'string' },
              { field: 'concerned_years', kinds: ['multiselect'], 'value-type': 'integer' },
              { field: 'doc_num', kinds: ['multiselect'], 'value-type': 'integer' },
            ],
          },
        }),
      ),
    );
  const withFields = (fields: readonly FieldSpec[]) =>
    createGenkiApi({
      baseUrl: '/genki',
      tenant: 'digdir',
      profile: { corpora: { kudos: { fields } } },
    });

  it('takes whether a field’s values are integers from the dataset where the profile does not say', async () => {
    dataset();
    const fields = await withFields([
      { id: 'type', label: 'Dokumenttyper' },
      { id: 'concerned_years', label: 'År', kind: 'year' },
    ]).loadFields('kudos');
    expect(fields).toEqual([
      { id: 'type', label: 'Dokumenttyper' },
      { id: 'concerned_years', label: 'År', kind: 'year', integer: true },
    ]);
  });

  it('keeps what the profile says of integers, and leaves out a field the dataset does not offer', async () => {
    dataset();
    const fields = await withFields([
      { id: 'concerned_years', label: 'År', integer: false },
      { id: 'gone', label: 'Borte' },
    ]).loadFields('kudos');
    expect(fields).toEqual([{ id: 'concerned_years', label: 'År', integer: false }]);
  });

  it('offers a layout’s fields in its words when the host passes its profile through profileOf', async () => {
    dataset();
    const year = {
      id: 'concerned_years',
      label: 'År',
      kind: 'year',
      years: { first: 1990 },
    } as const;
    const layout = { ...emptyLayout, profile: { corpora: { kudos: { fields: [year] } } } };
    const reads = createGenkiApi({
      baseUrl: '/genki',
      tenant: 'digdir',
      profile: profileOf(layout),
    });
    expect(await reads.loadFields('kudos')).toEqual([{ ...year, integer: true }]);
  });
});
