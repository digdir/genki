import { describe, expect, it } from 'vitest';
import { ApiError, createClient, selection } from './index.js';

const sse = (chunks: unknown[], headers: Record<string, string> = {}) =>
  new Response(
    [
      ...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`),
      ': keep-alive\n\n',
      'data: [DONE]\n\n',
    ].join(''),
    { headers: { 'content-type': 'text/event-stream', ...headers } },
  );

const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  id: 'chatcmpl-1',
  object: 'chat.completion.chunk',
  choices: [{ index: 0, delta, finish_reason: null }],
  ...extra,
});

const recording = (respond: (url: string, init: RequestInit) => Response) => {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchFn = async (input: Parameters<typeof fetch>[0], init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    return respond(String(input), init);
  };
  return { calls, fetchFn: fetchFn as typeof fetch };
};

const bodyOf = (call: { init: RequestInit } | undefined) =>
  JSON.parse(String(call?.init.body)) as Record<string, unknown>;

const excerptBody = {
  id: 'c',
  choices: [{ message: { content: 'Første [1], tredje [2] og andre [3].' } }],
  sources: [
    {
      index: 1,
      title: 'Tildelingsbrev',
      document_id: 'd1',
      excerpts: [
        { chunk_id: 'c1', text: 'Første', position: 0, markers: ['1'] },
        { chunk_id: 'c1b', text: 'Tredje', position: 4, markers: ['2'] },
        { chunk_id: 'c1c', text: 'Ikke sitert', position: 7 },
      ],
      markers: ['1', '2'],
    },
    {
      index: 3,
      title: 'Årsrapport',
      document_id: 'd2',
      excerpts: [{ chunk_id: 'c2', text: 'Andre', position: 0, markers: ['3'] }],
      markers: ['3'],
    },
  ],
  markers: [
    { marker: '1', chunk_id: 'c1', document: 'd1' },
    { marker: '2', chunk_id: 'c1b', document: 'd1' },
    { marker: '3', chunk_id: 'c2', document: 'd2' },
  ],
};

const excerptMarkers = [
  { marker: '1', chunkId: 'c1', documentId: 'd1' },
  { marker: '2', chunkId: 'c1b', documentId: 'd1' },
  { marker: '3', chunkId: 'c2', documentId: 'd2' },
];

const excerptSources = [
  {
    index: 1,
    title: 'Tildelingsbrev',
    documentId: 'd1',
    excerpts: [
      { chunkId: 'c1', text: 'Første', position: 0, markers: ['1'] },
      { chunkId: 'c1b', text: 'Tredje', position: 4, markers: ['2'] },
      { chunkId: 'c1c', text: 'Ikke sitert', position: 7 },
    ],
    markers: ['1', '2'],
  },
  {
    index: 3,
    title: 'Årsrapport',
    documentId: 'd2',
    excerpts: [{ chunkId: 'c2', text: 'Andre', position: 0, markers: ['3'] }],
    markers: ['3'],
  },
];

// Each excerpt's own section, in the shape the client reads when a response carries one.
const headedSource = {
  index: 1,
  title: 'Tildelingsbrev',
  document_id: 'd1',
  excerpts: [
    { chunk_id: 'c1', text: 'Første', position: 0, heading: '1 Innledning' },
    { chunk_id: 'c7', text: 'Mål', position: 4, heading: '3 Styringsparametere › 3.2 Mål' },
  ],
};

const headedExcerpts = [
  { chunkId: 'c1', text: 'Første', position: 0, heading: '1 Innledning' },
  { chunkId: 'c7', text: 'Mål', position: 4, heading: '3 Styringsparametere › 3.2 Mål' },
];

describe('@genai/client requests', () => {
  it('sends the API key, the end user and the pinned version as the contract headers', async () => {
    const { calls, fetchFn } = recording(() => Response.json({ data: [] }));
    const client = createClient({
      baseUrl: 'http://api/',
      apiKey: 'k',
      userId: 'ola',
      version: 3,
      fetch: fetchFn,
    });

    await client.listServices();

    const headers = new Headers(calls[0]?.init.headers);
    expect(calls[0]?.url).toBe('http://api/v1/models');
    expect([
      headers.get('x-api-key'),
      headers.get('x-user-id'),
      headers.get('genai-version'),
    ]).toEqual(['k', 'ola', '3']);
  });

  it('sends a bearer token from a function for browser clients, never an API key', async () => {
    const { calls, fetchFn } = recording(() => Response.json({ data: [] }));
    const client = createClient({ baseUrl: 'http://api', token: async () => 't1', fetch: fetchFn });

    await client.listServices();

    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer t1');
    expect(headers.has('x-api-key')).toBe(false);
  });

  it('puts conversation, filters and dataset on the ask in the documented field names', async () => {
    const { calls, fetchFn } = recording(() =>
      Response.json({
        id: 'c',
        choices: [{ message: { content: 'Svar' } }],
        conversation_id: 'k1',
      }),
    );
    const client = createClient({ baseUrl: 'http://api', apiKey: 'k', fetch: fetchFn });
    const filters = { fields: [selection('concerned_years', [2024, 2025])] };

    const answer = await client.ask({
      service: 'ka__default',
      question: 'Hva?',
      newConversation: true,
      filters,
      dataset: { tenant: 'digdir', key: 'kudos' },
    });

    expect(bodyOf(calls[0])).toMatchObject({
      model: 'ka__default',
      messages: [{ role: 'user', content: 'Hva?' }],
      genai_conversation: true,
      tenant: 'digdir',
      dataset_config_key: 'kudos',
      filters: {
        fields: [
          { field: 'concerned_years', 'value-type': 'integer', 'selected-options': [2024, 2025] },
        ],
      },
    });
    expect(answer.conversationId).toBe('k1');
  });

  it('maps the sources to one document each with indexed excerpts and the task id', async () => {
    const { fetchFn } = recording(
      () =>
        new Response(
          JSON.stringify({
            id: 'c',
            choices: [{ message: { content: 'Se [1].' } }],
            sources: [
              {
                index: 1,
                title: 'Tildelingsbrev',
                url: 'https://x.no/d1',
                document_id: 'd1',
                excerpts: [
                  { chunk_id: 'c1', text: 'A', position: 0 },
                  { chunk_id: 'c2', text: 'B' },
                ],
              },
            ],
          }),
          { headers: { 'genai-task': 't-9', 'content-type': 'application/json' } },
        ),
    );

    const answer = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask({
      service: 's',
      question: 'q',
    });

    expect(answer.taskId).toBe('t-9');
    expect(answer.sources).toEqual([
      {
        index: 1,
        title: 'Tildelingsbrev',
        url: 'https://x.no/d1',
        documentId: 'd1',
        excerpts: [
          { chunkId: 'c1', text: 'A', position: 0 },
          { chunkId: 'c2', text: 'B' },
        ],
      },
    ]);
  });

  it('passes on the excerpt each marker cites when the service cites excerpts', async () => {
    const { fetchFn } = recording(() => Response.json(excerptBody));

    const answer = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask({
      service: 's',
      question: 'q',
    });

    expect(answer.markers).toEqual(excerptMarkers);
    expect(answer.sources).toEqual(excerptSources);
  });

  it('leaves the markers out when the service cites documents', async () => {
    const { fetchFn } = recording(() =>
      Response.json({
        id: 'c',
        choices: [{ message: { content: 'Se [1].' } }],
        sources: [{ index: 1, title: 'T', excerpts: [{ chunk_id: 'c1', text: 'A' }] }],
      }),
    );

    const answer = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask({
      service: 's',
      question: 'q',
    });

    expect(answer).not.toHaveProperty('markers');
    expect(answer.sources[0]).not.toHaveProperty('markers');
    expect(answer.sources[0]?.excerpts[0]).not.toHaveProperty('markers');
  });

  it('drops a marker that does not name its excerpt and document', async () => {
    const { fetchFn } = recording(() =>
      Response.json({
        ...excerptBody,
        markers: [
          { marker: '1', chunk_id: 'c1', document: 'd1' },
          { marker: '2', document: 'd1' },
          { marker: '3', chunk_id: 'c2' },
          { chunk_id: 'c2', document: 'd2' },
          '4',
        ],
      }),
    );

    const answer = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask({
      service: 's',
      question: 'q',
    });

    expect(answer.markers).toEqual([{ marker: '1', chunkId: 'c1', documentId: 'd1' }]);
  });

  it('answers without markers when none of the listed markers names its excerpt and document', async () => {
    const { fetchFn } = recording(() =>
      Response.json({ ...excerptBody, markers: [{ marker: '1' }, '2'] }),
    );

    const answer = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask({
      service: 's',
      question: 'q',
    });

    expect(answer).not.toHaveProperty('markers');
  });

  it('keeps only the markers that are text on a source and an excerpt', async () => {
    const [first] = excerptBody.sources;
    const { fetchFn } = recording(() =>
      Response.json({
        ...excerptBody,
        sources: [
          {
            ...first,
            markers: ['1', 2, null],
            excerpts: [{ chunk_id: 'c1', text: 'Første', markers: ['1', { n: 1 }] }],
          },
        ],
      }),
    );

    const answer = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask({
      service: 's',
      question: 'q',
    });

    expect(answer.sources[0]?.markers).toEqual(['1']);
    expect(answer.sources[0]?.excerpts[0]?.markers).toEqual(['1']);
  });

  it("keeps each excerpt's heading from the answer", async () => {
    const { fetchFn } = recording(() =>
      Response.json({
        id: 'c',
        choices: [{ message: { content: 'Se [1].' } }],
        sources: [headedSource],
      }),
    );

    const answer = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask({
      service: 's',
      question: 'q',
    });

    expect(answer.sources[0]?.excerpts).toEqual(headedExcerpts);
  });

  it('leaves the heading out when the excerpt has none', async () => {
    const { fetchFn } = recording(() =>
      Response.json({
        id: 'c',
        choices: [{ message: { content: 'Se [1].' } }],
        sources: [
          {
            index: 1,
            title: 'T',
            excerpts: [
              { chunk_id: 'c1', text: 'A', heading: '1 Innledning' },
              { chunk_id: 'c2', text: 'B' },
              { chunk_id: 'c3', text: 'C', heading: 3 },
            ],
          },
        ],
      }),
    );

    const answer = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask({
      service: 's',
      question: 'q',
    });

    expect(answer.sources[0]?.excerpts).toStrictEqual([
      { chunkId: 'c1', text: 'A', heading: '1 Innledning' },
      { chunkId: 'c2', text: 'B' },
      { chunkId: 'c3', text: 'C' },
    ]);
  });

  it('turns an error body into an ApiError with status, code and field errors', async () => {
    const { fetchFn } = recording(() =>
      Response.json(
        {
          error: { code: 'invalid_filters', message: 'Unknown field' },
          errors: [{ path: 'filters.fields[0].field', message: 'Unknown field' }],
        },
        { status: 400 },
      ),
    );
    const client = createClient({ baseUrl: 'http://api', fetch: fetchFn });

    const error = await client.ask({ service: 's', question: 'q' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: 'invalid_filters',
      fieldErrors: [{ path: 'filters.fields[0].field', message: 'Unknown field' }],
    });
  });
});

describe('@genai/client stored conversations', () => {
  const conversation = {
    id: 'k1',
    topic: 'Ventetid',
    serviceId: 's',
    agentId: 's',
    userId: 'u',
    tags: [],
    created: 1,
  };
  const question = {
    id: 'm1',
    role: 'user',
    text: 'Hva?',
    created: 1,
    tags: [],
    filterValue: null,
    chunks: [],
  };
  const stored = (answer: Record<string, unknown>) =>
    recording(() => Response.json({ conversation, messages: [question, answer] }));
  const reply = {
    id: 'm2',
    role: 'assistant',
    text: excerptBody.choices[0]?.message.content,
    created: 2,
    tags: [],
    filterValue: null,
    chunks: [
      { chunkId: 'c1', docTitle: 'Tildelingsbrev', docNum: 'd1', contentMarkdown: 'Første' },
    ],
    task: 't-1',
  };

  it('reads the markers of a stored turn that cites excerpts', async () => {
    const { sources, markers } = excerptBody;
    const { fetchFn } = stored({ ...reply, sources, markers });

    const { messages } = await createClient({
      baseUrl: 'http://api',
      fetch: fetchFn,
    }).conversations.get('k1');

    expect(messages[1]?.markers).toEqual(excerptMarkers);
    expect(messages[1]?.sources).toEqual(excerptSources);
  });

  it('reads the sources of a stored turn in the same shape as an answer gives them', async () => {
    const { fetchFn } = stored({ ...reply, sources: [headedSource] });

    const { messages } = await createClient({
      baseUrl: 'http://api',
      fetch: fetchFn,
    }).conversations.get('k1');

    expect(messages[1]?.sources).toEqual([
      { index: 1, title: 'Tildelingsbrev', documentId: 'd1', excerpts: headedExcerpts },
    ]);
    expect(messages[1]).not.toHaveProperty('markers');
  });

  it('leaves out stored markers when none of them names its excerpt and document', async () => {
    const { sources } = excerptBody;
    const { fetchFn } = stored({ ...reply, sources, markers: [{ marker: '1' }, '2'] });

    const { messages } = await createClient({
      baseUrl: 'http://api',
      fetch: fetchFn,
    }).conversations.get('k1');

    expect(messages[1]).not.toHaveProperty('markers');
  });

  it('reads a stored turn without sources or markers as before, every field kept', async () => {
    const { fetchFn } = stored(reply);

    const body = await createClient({ baseUrl: 'http://api', fetch: fetchFn }).conversations.get(
      'k1',
    );

    expect(body).toStrictEqual({ conversation, messages: [question, reply] });
  });
});

describe('@genai/client streaming', () => {
  const live = [
    frame({ role: 'assistant' }, { conversation_id: 'k1' }),
    frame({ content: 'Første utkast' }),
    frame({}, { retract: true }),
    frame({ content: 'Svar [1].' }),
    frame({}, { genai_step: { event: 'agent/iteration-started', iteration: 1 } }),
    frame({}, { sources: [{ index: 1, title: 'T', excerpts: [] }], citations: ['u'] }),
    { ...frame({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];

  it('replays the retract so the visible text is only the final answer', async () => {
    const { fetchFn } = recording(() => sse(live, { 'genai-task': 't1' }));
    const client = createClient({ baseUrl: 'http://api', fetch: fetchFn });
    const shown: string[] = [''];

    const answer = await client.ask(
      { service: 's', question: 'q' },
      {
        onText: (t) => (shown[0] += t),
        onRetract: () => (shown[0] = ''),
      },
    );

    expect(shown[0]).toBe('Svar [1].');
    expect(answer).toMatchObject({
      text: 'Svar [1].',
      conversationId: 'k1',
      taskId: 't1',
      citations: ['u'],
    });
    expect(answer.sources[0]?.index).toBe(1);
  });

  it('asks for live streaming, and for steps only when a step handler is given', async () => {
    const { calls, fetchFn } = recording(() => sse(live));
    const client = createClient({ baseUrl: 'http://api', fetch: fetchFn });

    await client.ask({ service: 's', question: 'q' }, { onText: () => undefined });
    await client.ask({ service: 's', question: 'q' }, { onStep: () => undefined });

    expect(bodyOf(calls[0])).toMatchObject({ stream: true, genai_stream: 'live' });
    expect(bodyOf(calls[0])).not.toHaveProperty('genai_steps');
    expect(bodyOf(calls[1])).toMatchObject({ genai_steps: true });
  });

  it('yields typed events in order and throws when the run fails inside the stream', async () => {
    const failing = [
      frame({ content: 'Error: modellen svarte ikke' }),
      {
        ...frame({}),
        choices: [{ index: 0, delta: {}, finish_reason: 'error' }],
        error: { message: 'modellen svarte ikke', failure_code: 'model_error' },
      },
    ];
    const ok = recording(() => sse(live));
    const bad = recording(() => sse(failing));

    const types = [];
    for await (const e of createClient({ baseUrl: 'http://api', fetch: ok.fetchFn }).stream(
      { service: 's', question: 'q' },
      { steps: true },
    ))
      types.push(e.type);
    const error = await createClient({ baseUrl: 'http://api', fetch: bad.fetchFn })
      .ask({ service: 's', question: 'q' }, {})
      .catch((e: unknown) => e);

    expect(types).toEqual(['conversation', 'text', 'retract', 'text', 'step', 'sources', 'done']);
    expect(error).toMatchObject({ code: 'model_error', message: 'modellen svarte ikke' });
  });

  it('passes the markers on with the streamed sources and with the finished answer', async () => {
    const { sources, markers } = excerptBody;
    const { fetchFn } = recording(() =>
      sse([
        frame({ content: 'Første [1], tredje [2] og andre [3].' }),
        frame({}, { sources, markers }),
        { ...frame({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    const events = [];
    for await (const e of createClient({ baseUrl: 'http://api', fetch: fetchFn }).stream({
      service: 's',
      question: 'q',
    }))
      events.push(e);

    expect(events.at(-2)).toEqual({
      type: 'sources',
      sources: excerptSources,
      citations: [],
      markers: excerptMarkers,
    });
    expect(events.at(-1)).toMatchObject({
      type: 'done',
      answer: { sources: excerptSources, markers: excerptMarkers },
    });
  });

  it('hands the markers to onSources along with the sources', async () => {
    const { sources, markers } = excerptBody;
    const { fetchFn } = recording(() =>
      sse([
        frame({ content: 'Første [1].' }),
        frame({}, { sources, markers }),
        { ...frame({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]),
    );
    const seen: unknown[] = [];

    await createClient({ baseUrl: 'http://api', fetch: fetchFn }).ask(
      { service: 's', question: 'q' },
      { onSources: (_sources, markers) => seen.push(markers) },
    );

    expect(seen).toEqual([excerptMarkers]);
  });

  it('streams no markers when the service cites documents', async () => {
    const { fetchFn } = recording(() => sse(live));

    const events = [];
    for await (const e of createClient({ baseUrl: 'http://api', fetch: fetchFn }).stream({
      service: 's',
      question: 'q',
    }))
      events.push(e);

    const done = events.at(-1);
    expect(events.find((e) => e.type === 'sources')).not.toHaveProperty('markers');
    expect(done?.type === 'done' && done.answer).not.toHaveProperty('markers');
  });

  it("keeps each excerpt's heading in the streamed sources and the finished answer", async () => {
    const { fetchFn } = recording(() =>
      sse([
        frame({ content: 'Se [1].' }),
        frame({}, { sources: [headedSource] }),
        { ...frame({}), choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
      ]),
    );

    const events = [];
    for await (const e of createClient({ baseUrl: 'http://api', fetch: fetchFn }).stream({
      service: 's',
      question: 'q',
    }))
      events.push(e);

    const streamed = events.find((e) => e.type === 'sources');
    const done = events.at(-1);
    expect(streamed?.type === 'sources' && streamed.sources[0]?.excerpts).toEqual(headedExcerpts);
    expect(done?.type === 'done' && done.answer.sources[0]?.excerpts).toEqual(headedExcerpts);
  });
});
