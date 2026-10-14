import { describe, expect, it } from 'vitest';
import { createWorkspaceApi, sourcesFrom } from './api';
import { localDevLogin } from './auth';

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const recorder = (respond: (call: Call) => Response) => {
  const calls: Call[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { url: String(input), init };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  return { calls, fetcher };
};

const sse = (chunks: unknown[], headers: Record<string, string> = {}) => {
  const encoder = new TextEncoder();
  const text = [...chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`), 'data: [DONE]\n\n'].join(
    '',
  );
  const mid = Math.floor(text.length / 2);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text.slice(0, mid)));
        controller.enqueue(encoder.encode(text.slice(mid)));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream', ...headers } },
  );
};

const delta = (content: string, finish: string | null = null) => ({
  choices: [{ index: 0, delta: { content }, finish_reason: finish }],
});

const client = (fetcher: typeof fetch) =>
  createWorkspaceApi({ baseUrl: '/api', fetch: fetcher, token: () => 'tok' });

describe('source passages', () => {
  it('shows the whole cited passage, not the first 300 characters the API cut it to', () => {
    const passage = `Adresse og referanse. ${'Tekst. '.repeat(60)}Kostnadsrammen er 3,8 mill. kroner.`;
    const [source] = sourcesFrom({
      sources: [
        {
          source: { id: 'c1', name: 'Tildelingsbrev', url: 'https://example.no/a' },
          excerpt: 'Adresse og referanse. Tekst. Tekst. …',
          excerpts: [{ chunk_id: 'c1', text: passage }],
        },
      ],
    });

    expect(source?.excerpt).toContain('Kostnadsrammen er 3,8 mill. kroner.');
  });
});

describe('workspace api', () => {
  it('lists services from /v1/models with the bearer token', async () => {
    const { calls, fetcher } = recorder(() =>
      Response.json({
        object: 'list',
        data: [{ id: 'ka__default', object: 'model', _chat: true }],
      }),
    );
    expect(await client(fetcher).listServices()).toEqual([{ id: 'ka__default', name: 'Ka' }]);
    expect(calls[0]?.url).toBe('/api/v1/models');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer tok');
  });

  it('lists only services exposed for chat, without raw aliases', async () => {
    const { fetcher } = recorder(() =>
      Response.json({
        object: 'list',
        data: [
          { id: 'ka__default', title: 'KA', _chat: true },
          { id: 'kunnskapsassistenten__x', title: 'Kunnskapsassistenten' },
          { id: 'ai-overview__default', title: 'KI-oversikt' },
        ],
      }),
    );
    expect(await client(fetcher).listServices()).toEqual([{ id: 'ka__default', name: 'KA' }]);
  });

  it('shows the service title when /v1/models gives one', async () => {
    const { fetcher } = recorder(() =>
      Response.json({
        object: 'list',
        data: [
          { id: 'ki-veilederen__default', title: 'KI-veilederen', _chat: true },
          { id: 'klarsprak__default', _chat: true },
        ],
      }),
    );
    expect(await client(fetcher).listServices()).toEqual([
      { id: 'ki-veilederen__default', name: 'KI-veilederen' },
      { id: 'klarsprak__default', name: 'Klarsprak' },
    ]);
  });

  it('leaves the MCP conversation note out of the service description', async () => {
    const { fetcher } = recorder(() =>
      Response.json({
        object: 'list',
        data: [
          {
            id: 'ka__default',
            _chat: true,
            title: 'KA',
            description:
              'Svar fra Kudos Multi-turn: the response carries structuredContent.conversation_id; pass it back.',
          },
        ],
      }),
    );
    expect(await client(fetcher).listServices()).toEqual([
      { id: 'ka__default', name: 'KA', description: 'Svar fra Kudos' },
    ]);
  });

  it('names a service without a title from its id, not the raw id, and marks paused ones', async () => {
    const { fetcher } = recorder(() =>
      Response.json({
        object: 'list',
        data: [
          { id: 'ai-overview__default', _chat: true },
          { id: 'gammel__default', title: 'Gammel', status: 'paused', _chat: true },
        ],
      }),
    );
    expect(await client(fetcher).listServices()).toEqual([
      { id: 'ai-overview__default', name: 'Ai overview' },
      { id: 'gammel__default', name: 'Gammel', paused: true },
    ]);
  });

  it('marks a service that runs as a batch job so the workspace does not offer a chat for it', async () => {
    const api = createWorkspaceApi({
      baseUrl: '/api',
      token: () => 'kari',
      fetch: async () =>
        new Response(
          JSON.stringify({
            data: [
              { id: 'maal__default', _chat: true, _batch: true },
              { id: 'klarsprak__default', _chat: true },
            ],
          }),
        ),
    });

    const services = await api.listServices();

    expect(services.map((s) => s.batch)).toEqual([true, undefined]);
  });

  it('keeps the reason a service is paused', async () => {
    const { fetcher } = recorder(() =>
      Response.json({
        object: 'list',
        data: [
          {
            id: 'gammel__default',
            _chat: true,
            title: 'Gammel',
            status: 'paused',
            status_reason: 'Modellen er byttet ut. Tjenesten må publiseres med en ny modell.',
          },
        ],
      }),
    );
    expect(await client(fetcher).listServices()).toEqual([
      {
        id: 'gammel__default',
        name: 'Gammel',
        paused: true,
        pausedReason: 'Modellen er byttet ut. Tjenesten må publiseres med en ny modell.',
      },
    ]);
  });

  it('turns a 503 for a paused service into a paused failure, not an outage', async () => {
    const paused = recorder(() =>
      Response.json(
        {
          error: {
            code: 'service_paused',
            message: 'Modellen tjenesten bruker er tatt ut av bruk',
          },
        },
        { status: 503 },
      ),
    );
    expect((await client(paused.fetcher).chat('s', [], () => undefined)).failure).toEqual({
      kind: 'paused',
    });
  });

  it('marks an answer the API says has no answer, and keeps the sources', async () => {
    const { fetcher } = recorder(() =>
      sse([
        {
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          sources: [{ source: { name: 'Veileder om KI', url: 'https://digdir.no/ki' } }],
        },
        { no_answer: true, notice: 'Fant ikke noe svar.' },
        delta('', 'stop'),
      ]),
    );
    const reply = await client(fetcher).chat('ki-veilederen__default', [], () => {});
    expect(reply).toMatchObject({
      text: '',
      noAnswer: true,
      sources: [{ title: 'Veileder om KI', url: 'https://digdir.no/ki' }],
    });
    expect(reply.failure).toBeUndefined();
  });

  it('returns a table with its CSV and does not stream the CSV as text', async () => {
    const table = {
      kind: 'table',
      title: 'Måloppnåelse',
      columns: [{ key: 'goal', label: 'Mål' }],
      rows: [
        {
          document: 'd1',
          cells: {
            goal: {
              value: 'Felles løsninger',
              sources: [{ chunkId: 'c1', title: 'Årsrapport', url: 'javascript:alert(1)' }],
            },
          },
        },
      ],
      skipped: [],
    };
    const { fetcher } = recorder(() =>
      sse([{ table, csv: 'Mål,Mål (kilde)' }, delta('Mål,Mål (kilde)'), delta('', 'stop')]),
    );
    const seen: string[] = [];

    const reply = await client(fetcher).chat('maloppnaelse__default', [], (t) => seen.push(t));

    expect(seen).toEqual([]);
    expect(reply.csv).toBe('Mål,Mål (kilde)');
    expect(reply.table?.rows[0]?.cells.goal).toEqual({
      value: 'Felles løsninger',
      sources: [{ chunkId: 'c1', title: 'Årsrapport' }],
    });
  });

  it('streams chat deltas and returns sources and the task', async () => {
    const { calls, fetcher } = recorder(() =>
      sse(
        [
          { choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }] },
          delta('Ventetida '),
          delta('gjekk ned [1].'),
          {
            choices: [{ index: 0, delta: {}, finish_reason: null }],
            citations: ['https://kudos.example.no/a.pdf'],
            sources: [
              {
                source: {
                  name: 'Årsrapport 2025',
                  id: 'c1',
                  url: 'https://kudos.example.no/a.pdf',
                },
                metadata: [{ name: 'Årsrapport 2025 › Telefon' }],
                excerpt: 'Ventetida gjekk ned.',
                version: 2,
                published_at: '2026-03-01',
              },
              { source: { name: 'Internt notat', id: 'c2', url: 'chunk:c2' }, metadata: [{}] },
            ],
          },
          delta('', 'stop'),
        ],
        { 'genai-task': 'task-9' },
      ),
    );
    const seen: string[] = [];
    const reply = await client(fetcher).chat(
      'ka__default',
      [{ role: 'user', content: 'Kva seier rapportane?' }],
      (text) => seen.push(text),
    );
    expect(seen).toEqual(['Ventetida ', 'Ventetida gjekk ned [1].']);
    expect(reply).toEqual({
      text: 'Ventetida gjekk ned [1].',
      task: 'task-9',
      sources: [
        {
          title: 'Årsrapport 2025 › Telefon',
          url: 'https://kudos.example.no/a.pdf',
          excerpt: 'Ventetida gjekk ned.',
          version: '2',
          publishedAt: '2026-03-01',
        },
        { title: 'Internt notat' },
      ],
    });
    expect(calls[0]?.url).toBe('/api/v1/chat/completions');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      model: 'ka__default',
      messages: [{ role: 'user', content: 'Kva seier rapportane?' }],
      stream: true,
      genai_stream: 'live',
    });
  });

  it('drops a draft the server retracts and keeps only the answer that replaced it', async () => {
    const { fetcher } = recorder(() =>
      sse([
        delta('Første utkast.'),
        { choices: [{ index: 0, delta: {}, finish_reason: null }], retract: true },
        delta('Digdir skal samordne [2].'),
        {
          choices: [{ index: 0, delta: {}, finish_reason: null }],
          sources: [
            {
              source: { name: 'Tildelingsbrev', id: 'c2', url: 'https://kudos.dfo.no/d2' },
              index: 2,
            },
          ],
        },
        delta('', 'stop'),
      ]),
    );
    const seen: string[] = [];

    const reply = await client(fetcher).chat('ka__default', [], (t) => seen.push(t));

    expect(seen).toEqual(['Første utkast.', '', 'Digdir skal samordne [2].']);
    expect(reply.text).toBe('Digdir skal samordne [2].');
    expect(reply.sources).toEqual([
      { title: 'Tildelingsbrev', url: 'https://kudos.dfo.no/d2', index: 2 },
    ]);
  });

  it('turns a failed stream into an outage without showing the raw error', async () => {
    const { fetcher } = recorder(() =>
      sse([delta('Error: the model is unavailable'), delta('', 'error')]),
    );
    const seen: string[] = [];
    const reply = await client(fetcher).chat('s', [], (t) => seen.push(t));
    expect(reply.failure).toEqual({ kind: 'unavailable' });
    expect(reply.text).toBe('');
    expect(seen).toEqual([]);
  });

  it('tells a service failure apart from a model failure by the run error code', async () => {
    const failed = (error: Record<string, unknown>) =>
      recorder(() => sse([delta('Error: the service failed'), { ...delta('', 'error'), error }]))
        .fetcher;

    const service = await client(
      failed({ code: 'invoke_failed', failure_code: 'strategy_error', model_failed: false }),
    ).chat('s', [], () => undefined);
    const model = await client(
      failed({ code: 'invoke_failed', failure_code: 'model_error', model_failed: true }),
    ).chat('s', [], () => undefined);
    const blocking = await client(
      recorder(() =>
        Response.json(
          { error: { code: 'invoke_failed', failure_code: 'misconfigured', model_failed: false } },
          { status: 500 },
        ),
      ).fetcher,
    ).chat('s', [], () => undefined);

    expect(service.failure).toEqual({ kind: 'service-failed' });
    expect(model.failure).toEqual({ kind: 'unavailable' });
    expect(blocking.failure).toEqual({ kind: 'service-failed' });
  });

  it('maps HTTP errors and guardrail refusals to failures', async () => {
    const quota = recorder(() =>
      Response.json({ error: { code: 'rate_limit_exceeded', message: 'x' } }, { status: 429 }),
    );
    expect((await client(quota.fetcher).chat('s', [], () => undefined)).failure).toEqual({
      kind: 'quota',
    });
    const refused = recorder(() =>
      sse([delta('Dette spørsmålet kan ikke besvares i denne tjenesten.'), delta('', 'stop')]),
    );
    expect((await client(refused.fetcher).chat('s', [], () => undefined)).failure).toEqual({
      kind: 'refused',
    });
    const filtered = recorder(() =>
      sse([
        {
          choices: [{ index: 0, delta: { refusal: 'Ikke lov.' }, finish_reason: 'content_filter' }],
        },
      ]),
    );
    expect((await client(filtered.fetcher).chat('s', [], () => undefined)).failure).toEqual({
      kind: 'refused',
      message: 'Ikke lov.',
    });
    const offline = (async () => {
      throw new TypeError('network');
    }) as typeof fetch;
    expect((await client(offline).chat('s', [], () => undefined)).failure).toEqual({
      kind: 'unavailable',
    });
  });

  it('posts feedback to the platform /api/feedback through the /api proxy prefix', async () => {
    const { calls, fetcher } = recorder(() => Response.json({ ok: true }, { status: 201 }));
    await client(fetcher).sendFeedback({
      task: 'task-9',
      rating: 'down',
      reasons: ['Feil'],
      comment: ' Feil år ',
    });
    expect(calls[0]?.url).toBe('/api/api/feedback');
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({
      task: 'task-9',
      rating: 'down',
      reasons: ['Feil'],
      comment: 'Feil år',
    });
    await expect(
      client(fetcher).sendFeedback({ rating: 'up', reasons: [], comment: '' }),
    ).rejects.toThrow();
  });

  it('logs in through the local dev login', async () => {
    const { calls, fetcher } = recorder(() =>
      Response.json({
        token: 't',
        name: 'Per Hansen',
        organisations: [{ orgNumber: '999888777', name: 'Testetaten' }],
      }),
    );
    const auth = localDevLogin(fetcher);
    expect((await auth.login()).name).toBe('Per Hansen');
    expect(auth.current()?.token).toBe('t');
    expect(calls[0]?.url).toBe('/api/mock/dev-login');
  });
});

describe('the locked environment flag', () => {
  it('reads lockdown from /health', async () => {
    const { calls, fetcher } = recorder(() =>
      Response.json({ status: 'ok', version: 't', lockdown: true }),
    );

    expect(await client(fetcher).lockdown?.()).toBe(true);
    expect(calls[0]?.url).toBe('/api/health');
  });

  it('treats a missing flag as not locked', async () => {
    const { fetcher } = recorder(() => Response.json({ status: 'ok', version: 't' }));

    expect(await client(fetcher).lockdown?.()).toBe(false);
  });
});
