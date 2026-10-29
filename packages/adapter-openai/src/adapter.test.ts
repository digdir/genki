import { citedOf } from './sources.js';
import { describe, expect, it } from 'vitest';
import { TABLE_MIME, tableMarker } from './table.js';
import { textPart, type CapabilityDescriptor, type Part, type Principal } from '@genai/contracts';
import { createKernel, type Capability, type Emitted, type Strategy } from '@genai/kernel';
import {
  SOURCES_MIME,
  citationBundle,
  createOpenAiAdapter,
  excerptOf,
  splitMessages,
  AnswerTracker,
  bodyLimits,
  documentLimits,
  type CapabilityResolver,
  type OpenAiAdapterOptions,
  type ModelEntry,
  type SourceRecord,
} from './index.js';

const TENANT = '991825827';
const kari: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: TENANT };

const records: SourceRecord[] = [
  {
    chunkId: 'c1',
    title: 'Tildelingsbrev 2025',
    url: 'https://kudos.dfo.no/d1',
    text: 'Digdir skal ...',
    headers: ['Tildelingsbrev 2025', 'Mål ### Delmål', 'Styringsparametere\nmer'],
    document: 'd1',
    position: 3,
  },
  { chunkId: 'c2', text: 'Uten tittel', headers: ['Årsrapport'], document: 'd2' },
];

const sourcesPart = (sources: SourceRecord[]): Part => ({
  mime: SOURCES_MIME,
  body: { kind: 'json', json: { sources } },
});

type Behaviour =
  'answer' | 'stream' | 'fail' | 'empty' | 'fields' | 'model-down' | 'agent' | 'uncited';

const behaviours: Behaviour[] = [
  'answer',
  'stream',
  'fail',
  'empty',
  'fields',
  'model-down',
  'agent',
  'uncited',
];

const notice = (data: Record<string, unknown>): Emitted => ({ type: 'kernel.notice', data });
const delta = (text: string): Emitted => ({ type: 'kernel.part.delta', data: { text } });
const finalAnswer = 'Digdir skal samordne [2].';

const strategy = (behaviour: Behaviour): Strategy => ({
  id: behaviour,
  version: '1',
  requires: { kernel: 1, ports: [], features: [] },
  run: async function* (ctx, input): AsyncIterable<Emitted> {
    if (behaviour === 'fail') throw new Error('modellen svarte ikke');
    if (behaviour === 'model-down')
      throw Object.assign(new Error('upstream 503'), { name: 'ModelError' });
    await ctx.budget.charge({ inputTokens: 150, outputTokens: 25 });
    const query = (input.data as { query?: string } | undefined)?.query ?? '';
    if (behaviour === 'empty') {
      yield { type: 'kernel.result', data: [sourcesPart(records)] };
      return;
    }
    if (behaviour === 'fields') {
      yield {
        type: 'kernel.result',
        data: [
          {
            mime: 'application/json',
            body: { kind: 'json', json: { text: 'Klar tekst.', changes: ['kortere'] } },
          },
        ],
      };
      return;
    }
    if (behaviour === 'agent') {
      yield notice({ event: 'agent/iteration-started', iteration: 0 });
      yield delta('Jeg søker først i Kudos.');
      yield notice({ stage: 'tool', tool: 'search', iteration: 0 });
      yield notice({ event: 'agent/iteration-started', iteration: 1 });
      yield notice({ stage: 'tool', tool: 'generate_response', iteration: 1 });
      yield delta('Første utkast.');
      yield notice({ stage: 'answer-discarded', iteration: 1 });
      yield notice({ event: 'agent/iteration-started', iteration: 2 });
      yield notice({ stage: 'tool', tool: 'generate_response', iteration: 2 });
      yield delta('Andre utkast ');
      yield delta('uten kilder.');
      yield notice({ stage: 'citations', action: 'backfill', adopted: true });
      yield notice({ stage: 'answer-discarded', reason: 'uncited' });
      yield delta(finalAnswer);
      yield {
        type: 'kernel.result',
        data: [
          { ...textPart(finalAnswer), meta: { citations: [{ index: 2, chunkId: 'c2' }] } },
          sourcesPart(records),
        ],
      };
      return;
    }
    if (behaviour === 'uncited') {
      yield {
        type: 'kernel.result',
        data: [
          { ...textPart('Svar uten kildehenvisninger.'), meta: { citations: [] } },
          sourcesPart([...records, { ...records[0], chunkId: 'c1b' } as SourceRecord]),
        ],
      };
      return;
    }
    if (behaviour === 'stream') {
      yield { type: 'kernel.part.delta', data: { text: 'Første ' } };
      yield { type: 'kernel.part.delta', data: { text: 'avsnitt.' } };
      yield { type: 'kernel.result', data: [textPart('Første avsnitt.'), sourcesPart(records)] };
      return;
    }
    yield { type: 'kernel.result', data: [textPart(`Svar på: ${query}`), sourcesPart(records)] };
  },
});

const descriptor = (id: string): CapabilityDescriptor => ({
  id,
  version: '1',
  tenant: TENANT,
  title: id,
  description: id,
  input: { type: 'object', properties: { query: { type: 'string' } } },
  interaction: ['unary', 'stream'],
  accepts: [],
  produces: [],
  emits: [],
  oversight: { interrupts: false, riskClass: 'limited', aiDisclosure: 'KI' },
});

const capability = (id: string): Capability => ({
  descriptor: descriptor(id),
  strategy: { id, version: '1' },
  config: {},
  grants: [],
});

const entries: ModelEntry[] = [
  {
    id: 'kunnskapsassistenten__default',
    capability: 'answer',
    title: 'Kunnskapsassistenten',
    description: 'Svar fra Kudos',
    agentId: 'kunnskapsassistenten',
    mode: 'default',
    default: true,
    inputSchema: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
  },
  { id: 'kunnskapsassistenten__stream', capability: 'stream' },
  { id: 'kunnskapsassistenten__broken', capability: 'fail' },
  { id: 'kunnskapsassistenten__empty', capability: 'empty' },
  { id: 'klarsprak__default', capability: 'fields' },
  {
    id: 'legacy__default',
    capability: 'answer',
    inputSchema: {
      type: 'object',
      properties: { 'user-query': { type: 'string', minLength: 1 } },
      required: ['user-query'],
    },
  },
];

const unlisted: ModelEntry[] = [
  { id: 'kunnskapsassistenten__model-down', capability: 'model-down' },
  {
    id: 'kunnskapsassistenten__agent',
    capability: 'agent',
    datasets: ['digdir/kudos', 'public-sector-knowledge/default'],
  },
  { id: 'kunnskapsassistenten__uncited', capability: 'uncited' },
];

const resolver: CapabilityResolver = {
  list: async () => entries,
  resolve: async (_p, name) => {
    if (name === 'nav__secret')
      return { ok: false, code: 'agent_not_authorized', message: 'Not authorized for nav' };
    const entry = [...entries, ...unlisted].find((e) => e.id === name);
    return entry
      ? { ok: true, entry }
      : {
          ok: false,
          code: 'model_not_found',
          message: `Model not found: ${name}. Use the id from GET /v1/models.`,
        };
  },
};

const setup = (extra: Partial<OpenAiAdapterOptions> = {}) => {
  const kernel = createKernel({
    strategies: behaviours.map(strategy),
    capabilities: behaviours.map(capability),
    ports: {},
    policy: { decide: async () => ({ allow: true }) },
  });
  const app = createOpenAiAdapter({
    kernel,
    resolver,
    auth: {
      authenticate: async (req) =>
        req.headers.get('authorization') === 'Bearer good' ||
        req.headers.get('x-api-key') === 'good'
          ? kari
          : undefined,
    },
    now: () => new Date('2026-10-06T10:00:00Z'),
    newId: () => 'fixed',
    ...extra,
  });
  const post = (path: string, body: unknown, key = 'good', headers: Record<string, string> = {}) =>
    app.request(path, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    });
  return { app, post };
};

interface Frame {
  id: string;
  object: string;
  model: string;
  citations?: string[];
  sources?: unknown[];
  retract?: boolean;
  choices: { delta: Record<string, unknown>; logprobs: null; finish_reason: string | null }[];
}

interface Spec {
  openapi: string;
  servers: unknown;
  paths: Record<string, { post: unknown }>;
}

const sse = async (response: Response) =>
  (await response.text())
    .split('\n\n')
    .filter((f) => f.startsWith('data: '))
    .map((f) => f.slice(6));

const frames = async (response: Response) =>
  (await sse(response)).slice(0, -1).map((f) => JSON.parse(f) as Frame);

const shownText = (chunks: Frame[]) =>
  chunks.reduce(
    (text, c) =>
      c.retract ? '' : text + String((c.choices[0]?.delta.content as string | undefined) ?? ''),
    '',
  );

describe('/v1/models', () => {
  it('lists one model per entry with the fields KA and Open WebUI read', async () => {
    const response = await setup().app.request('/v1/models', { headers: { 'x-api-key': 'good' } });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      object: 'list',
      data: [
        {
          id: 'kunnskapsassistenten__default',
          object: 'model',
          created: 1791280800,
          owned_by: 'digdir-rag',
          title: 'Kunnskapsassistenten',
          description: 'Svar fra Kudos',
          _agent_id: 'kunnskapsassistenten',
          _service: 'kunnskapsassistenten',
          _mode: 'default',
          _variant: 'default',
          _pickable: false,
          _default: true,
          _chat: false,
        },
        {
          id: 'kunnskapsassistenten__stream',
          object: 'model',
          created: 1791280800,
          owned_by: 'digdir-rag',
          _pickable: false,
          _chat: false,
        },
        {
          id: 'kunnskapsassistenten__broken',
          object: 'model',
          created: 1791280800,
          owned_by: 'digdir-rag',
          _pickable: false,
          _chat: false,
        },
        ...['kunnskapsassistenten__empty', 'klarsprak__default', 'legacy__default'].map((id) => ({
          id,
          object: 'model',
          created: 1791280800,
          owned_by: 'digdir-rag',
          _pickable: false,
          _chat: false,
        })),
      ],
    });
  });

  it('serves the plain purpose as the description, with no multi-turn or MCP text appended', async () => {
    const response = await setup().app.request('/v1/models', { headers: { 'x-api-key': 'good' } });
    const { data } = (await response.json()) as { data: { description?: string }[] };

    expect(data.flatMap((m) => (m.description ? [m.description] : []))).toEqual(['Svar fra Kudos']);
  });

  it('gives every model a boolean _chat so a frontend never has to guess what absent means', async () => {
    const response = await setup().app.request('/v1/models', { headers: { 'x-api-key': 'good' } });
    const { data } = (await response.json()) as { data: { _chat?: unknown }[] };

    expect(data.every((m) => typeof m._chat === 'boolean')).toBe(true);
  });

  it('gives a model the service title so clients can show a name instead of the id', async () => {
    const response = await setup().app.request('/v1/models', { headers: { 'x-api-key': 'good' } });
    const { data } = (await response.json()) as { data: { id: string; title?: string }[] };

    expect(data.find((m) => m.id === 'kunnskapsassistenten__default')?.title).toBe(
      'Kunnskapsassistenten',
    );
  });

  it('refuses a missing or wrong key with OpenAI’s 401 body', async () => {
    const { app } = setup();
    const missing = await app.request('/v1/models');
    const wrong = await app.request('/v1/models', { headers: { authorization: 'Bearer bad' } });

    for (const response of [missing, wrong]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        error: {
          message: 'Invalid or missing API key',
          type: 'invalid_request_error',
          code: 'invalid_api_key',
        },
      });
    }
  });
});

describe('/v1/chat/completions', () => {
  it('answers the last user message with usage, citations and Open WebUI sources', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'kunnskapsassistenten__default',
      messages: [
        { role: 'system', content: 'Vær kort.' },
        { role: 'user', content: 'Hva sier tildelingsbrevet?' },
      ],
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      id: 'chatcmpl-fixed',
      object: 'chat.completion',
      created: 1791280800,
      model: 'kunnskapsassistenten__default',
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'Svar på: Hva sier tildelingsbrevet?' },
          logprobs: null,
          finish_reason: 'stop',
        },
      ],
      usage: { prompt_tokens: 150, completion_tokens: 25, total_tokens: 175 },
      citations: ['https://kudos.dfo.no/d1'],
      sources: [
        {
          source: { name: 'Tildelingsbrev 2025', id: 'c1', url: 'https://kudos.dfo.no/d1' },
          document: ['Digdir skal ...'],
          metadata: [
            {
              source: 'c1',
              chunk_id: 'c1',
              name: 'Tildelingsbrev 2025 › Mål Delmål › Styringsparametere',
            },
          ],
          excerpt: 'Digdir skal ...',
          title: 'Tildelingsbrev 2025',
          url: 'https://kudos.dfo.no/d1',
          document_id: 'd1',
          excerpts: [{ chunk_id: 'c1', text: 'Digdir skal ...', position: 3 }],
        },
        {
          source: { name: 'Årsrapport', id: 'c2', url: 'chunk:c2' },
          document: ['Uten tittel'],
          metadata: [{ source: 'c2', chunk_id: 'c2', name: 'Årsrapport' }],
          excerpt: 'Uten tittel',
          title: 'Årsrapport',
          document_id: 'd2',
          excerpts: [{ chunk_id: 'c2', text: 'Uten tittel' }],
        },
      ],
      ai_generated: true,
    });
  });

  it('names the run in a genai-task header so the client can give feedback on it', async () => {
    const ask = (stream: boolean) =>
      setup().post('/v1/chat/completions', {
        model: 'kunnskapsassistenten__default',
        messages: [{ role: 'user', content: 'Hva sier tildelingsbrevet?' }],
        stream,
      });

    expect((await ask(false)).headers.get('genai-task')).toBeTruthy();
    expect((await ask(true)).headers.get('genai-task')).toBeTruthy();
  });

  it('marks an empty answer with no_answer, also when streaming', async () => {
    const { post } = setup();
    const unary = (await (
      await post('/v1/chat/completions', {
        model: 'kunnskapsassistenten__empty',
        messages: [{ role: 'user', content: 'x' }],
      })
    ).json()) as { choices: { message: { content: string } }[] };
    const frames = await sse(
      await post('/v1/chat/completions', {
        model: 'kunnskapsassistenten__empty',
        messages: [{ role: 'user', content: 'x' }],
        stream: true,
      }),
    );

    expect(unary.choices[0]?.message.content).toBe('');
    expect(unary).toMatchObject({ no_answer: true, notice: 'Fant ikke noe svar.' });
    expect(frames.some((f) => f.includes('"no_answer":true'))).toBe(true);
  });

  it('answers a fields service with its text field', async () => {
    const body = (await (
      await setup().post('/v1/chat/completions', {
        model: 'klarsprak__default',
        messages: [{ role: 'user', content: 'Skriv om.' }],
      })
    ).json()) as Record<string, unknown> & { choices: { message: { content: string } }[] };

    expect(body.choices[0]?.message.content).toBe('Klar tekst.');
    expect(body.no_answer).toBeUndefined();
  });

  it('streams the role intro, token deltas, sources, a stop frame and [DONE] when the client asks for live streaming', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'kunnskapsassistenten__stream',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
      genai_stream: 'live',
    });
    const frames = await sse(response);
    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f) as Frame);

    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(frames.at(-1)).toBe('[DONE]');
    for (const chunk of chunks) {
      expect(chunk).toMatchObject({
        id: 'chatcmpl-fixed',
        object: 'chat.completion.chunk',
        model: 'kunnskapsassistenten__stream',
      });
      expect(chunk.choices[0]).toHaveProperty('logprobs', null);
      expect(chunk.choices[0]).toHaveProperty('finish_reason');
    }
    expect(chunks.map((c) => c.choices[0]?.delta)).toEqual([
      { role: 'assistant' },
      { content: 'Første ' },
      { content: 'avsnitt.' },
      {},
      {},
    ]);
    expect(chunks[3]?.citations).toEqual(['https://kudos.dfo.no/d1']);
    expect(chunks[3]?.sources).toHaveLength(2);
    expect(chunks.map((c) => c.choices[0]?.finish_reason)).toEqual([
      null,
      null,
      null,
      null,
      'stop',
    ]);
  });

  it('sends a third-party client the final answer once, after the sources, even when the strategy streams drafts', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'kunnskapsassistenten__agent',
      messages: [{ role: 'user', content: 'Hva er målet?' }],
      stream: true,
    });
    const chunks = await frames(response);

    expect(
      chunks.map((c) => [c.choices[0]?.delta, Boolean(c.sources), c.choices[0]?.finish_reason]),
    ).toEqual([
      [{ role: 'assistant' }, false, null],
      [{}, true, null],
      [{ content: finalAnswer }, false, null],
      [{}, false, 'stop'],
    ]);
    expect(chunks.some((c) => c.retract)).toBe(false);
  });

  it('never streams intermediate turns live, and retracts a discarded or replaced answer', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'kunnskapsassistenten__agent',
      messages: [{ role: 'user', content: 'Hva er målet?' }],
      stream: true,
      genai_stream: 'live',
    });
    const chunks = await frames(response);
    const contents = chunks.flatMap((c) =>
      typeof c.choices[0]?.delta.content === 'string' ? [c.choices[0].delta.content] : [],
    );

    expect(contents.join('')).not.toContain('Jeg søker først');
    expect(chunks.filter((c) => c.retract)).toHaveLength(2);
    expect(shownText(chunks)).toBe(finalAnswer);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.at(-2)?.sources).toHaveLength(1);
  });

  it('sends the cited source with its citation number so [N] resolves', async () => {
    const chunks = await frames(
      await setup().post('/v1/chat/completions', {
        model: 'kunnskapsassistenten__agent',
        messages: [{ role: 'user', content: 'Hva er målet?' }],
        stream: true,
      }),
    );
    const sourced = chunks.find((c) => c.sources);

    expect(sourced?.sources).toEqual([expect.objectContaining({ index: 2 })]);
    expect(sourced).not.toHaveProperty('citations');
  });

  it('sends the retrieved sources, one per document, when the answer cites none', async () => {
    const { post } = setup();
    const request = {
      model: 'kunnskapsassistenten__uncited',
      messages: [{ role: 'user', content: 'x' }],
    };
    const unary = (await (await post('/v1/chat/completions', request)).json()) as Frame;
    const streamed = (
      await frames(await post('/v1/chat/completions', { ...request, stream: true }))
    ).find((c) => c.sources);

    expect(unary.sources).toHaveLength(2);
    expect(unary.citations).toBeUndefined();
    expect(streamed?.sources).toHaveLength(2);
    expect(streamed?.sources?.[0]).not.toHaveProperty('index');
  });

  it('accepts the tenant and dataset_config_key extensions only for a dataset the service uses', async () => {
    const { post } = setup();
    const ask = (extra: Record<string, unknown>) =>
      post('/v1/chat/completions', {
        model: 'kunnskapsassistenten__agent',
        messages: [{ role: 'user', content: 'x' }],
        ...extra,
      });

    const alias = await ask({ tenant: 'public-sector-knowledge', dataset_config_key: 'default' });
    const canonical = await ask({ tenant: 'digdir', dataset_config_key: 'kudos' });
    const half = await ask({ tenant: 'nav' });
    const other = await ask({ tenant: 'nav', dataset_config_key: 'default' });

    expect([alias.status, canonical.status, half.status]).toEqual([200, 200, 200]);
    expect(other.status).toBe(403);
    expect(await other.json()).toMatchObject({
      error: { code: 'dataset_not_authorized', type: 'invalid_request_error' },
    });
  });

  it('sends the whole answer as one delta after the sources when the strategy does not stream', async () => {
    const response = await setup().post('/v1/chat/completions', {
      model: 'kunnskapsassistenten__default',
      messages: [{ role: 'user', content: 'hei' }],
      stream: true,
    });
    const chunks = (await sse(response)).slice(0, -1).map((f) => JSON.parse(f) as Frame);

    expect(
      chunks.map((c) => [c.choices[0]?.delta, Boolean(c.sources), c.choices[0]?.finish_reason]),
    ).toEqual([
      [{ role: 'assistant' }, false, null],
      [{}, true, null],
      [{ content: 'Svar på: hei' }, false, null],
      [{}, false, 'stop'],
    ]);
  });

  it('reports a failed run as a 500 server_error, and as finish_reason error when streaming', async () => {
    const { post } = setup();
    const blocking = await post('/v1/chat/completions', {
      model: 'kunnskapsassistenten__broken',
      messages: [{ role: 'user', content: 'x' }],
    });
    const streaming = await post('/v1/chat/completions', {
      model: 'kunnskapsassistenten__broken',
      messages: [{ role: 'user', content: 'x' }],
      stream: true,
    });
    const chunks = (await sse(streaming)).slice(0, -1).map((f) => JSON.parse(f) as Frame);

    expect(blocking.status).toBe(500);
    expect(await blocking.json()).toEqual({
      error: {
        message: 'the service failed',
        type: 'server_error',
        param: null,
        code: 'invoke_failed',
        failure_code: 'strategy_error',
        model_failed: false,
      },
    });
    expect(chunks.at(-2)?.choices[0]?.delta.content).toBe('Error: the service failed');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('error');
    expect(chunks.at(-1)).toMatchObject({
      error: { code: 'invoke_failed', failure_code: 'strategy_error', model_failed: false },
    });
  });

  it('marks a run that failed in the model call as a model failure', async () => {
    const { post } = setup();
    const request = {
      model: 'kunnskapsassistenten__model-down',
      messages: [{ role: 'user', content: 'x' }],
    };

    const blocking = await post('/v1/chat/completions', request);
    const streaming = await post('/v1/chat/completions', { ...request, stream: true });
    const chunks = (await sse(streaming)).slice(0, -1).map((f) => JSON.parse(f) as Frame);

    expect(await blocking.json()).toMatchObject({
      error: { failure_code: 'model_error', model_failed: true },
    });
    expect(chunks.at(-1)).toMatchObject({
      error: { failure_code: 'model_error', model_failed: true },
    });
  });

  it.each([
    [{ messages: [{ role: 'user', content: 'x' }] }, 400, 'missing_model'],
    [{ model: 'kunnskapsassistenten__default', messages: [] }, 400, 'missing_messages'],
    [
      { model: 'kunnskapsassistenten__default', messages: [{ role: 'system', content: 'x' }] },
      400,
      'invalid_messages',
    ],
    [{ model: 'gpt-4o', messages: [{ role: 'user', content: 'x' }] }, 404, 'model_not_found'],
    [
      { model: 'nav__secret', messages: [{ role: 'user', content: 'x' }] },
      403,
      'agent_not_authorized',
    ],
  ])('refuses %j with %i %s in the exact OpenAI error shape', async (body, status, code) => {
    const response = await setup().post('/v1/chat/completions', body);
    const json = (await response.json()) as { error: Record<string, unknown> };

    expect(response.status).toBe(status);
    expect(Object.keys(json.error).sort()).toEqual(['code', 'message', 'param', 'type']);
    expect(json.error).toMatchObject({ code, type: 'invalid_request_error', param: null });
  });
});

describe('/api/tools', () => {
  it('describes one OpenAPI operation per model, named after it', async () => {
    const response = await setup().app.request('http://platform.test/api/tools/openapi.json', {
      headers: { 'x-api-key': 'good' },
    });
    const spec = (await response.json()) as Spec;

    expect(spec.openapi).toBe('3.1.0');
    expect(spec.servers).toEqual([{ url: 'http://platform.test' }]);
    expect(Object.keys(spec.paths)).toEqual([
      '/api/tools/call/kunnskapsassistenten__default',
      '/api/tools/call/kunnskapsassistenten__stream',
      '/api/tools/call/kunnskapsassistenten__broken',
      '/api/tools/call/kunnskapsassistenten__empty',
      '/api/tools/call/klarsprak__default',
      '/api/tools/call/legacy__default',
    ]);
    expect(spec.paths['/api/tools/call/kunnskapsassistenten__default']?.post).toMatchObject({
      operationId: 'kunnskapsassistenten__default',
      summary: 'Kunnskapsassistenten',
      requestBody: { content: { 'application/json': { schema: entries[0]?.inputSchema } } },
    });
  });

  it('calls a tool and returns the answer first, with document links and chunks', async () => {
    const response = await setup().post('/api/tools/call/kunnskapsassistenten__default', {
      query: 'tildelingsbrev',
      conversation_id: 'conv-1',
    });

    expect(await response.json()).toEqual({
      answer: 'Svar på: tildelingsbrev',
      status: 'ok',
      ai_generated: true,
      conversation_id: 'conv-1',
      sources: [
        { uri: 'https://kudos.dfo.no/d1', name: 'Tildelingsbrev 2025', excerpt: 'Digdir skal ...' },
        { uri: 'digdir://doc/d2', name: 'Untitled source', excerpt: 'Uten tittel' },
      ],
      chunks: [
        {
          chunk_id: 'c1',
          doc_num: 'd1',
          chunk_index: 3,
          title: 'Tildelingsbrev 2025',
          url: 'https://kudos.dfo.no/d1',
        },
        { chunk_id: 'c2', doc_num: 'd2' },
      ],
    });
  });

  it('documents and accepts `query` where the capability declares `user-query`', async () => {
    const { app, post } = setup();
    const spec = (await (
      await app.request('/api/tools/openapi.json', { headers: { 'x-api-key': 'good' } })
    ).json()) as { paths: Record<string, { post: { requestBody: { content: unknown } } }> };
    const schema = (
      spec.paths['/api/tools/call/legacy__default']?.post.requestBody.content as {
        'application/json': { schema: { properties: object; required: string[] } };
      }
    )['application/json'].schema;
    const byQuery = await post('/api/tools/call/legacy__default', { query: 'tilskudd' });
    const byAlias = await post('/api/tools/call/legacy__default', { 'user-query': 'tilskudd' });

    expect(schema.required).toEqual(['query']);
    expect(Object.keys(schema.properties)).toContain('query');
    expect(Object.keys(schema.properties)).not.toContain('user-query');
    expect(await byQuery.json()).toMatchObject({ answer: 'Svar på: tilskudd', status: 'ok' });
    expect(await byAlias.json()).toMatchObject({ answer: 'Svar på: tilskudd', status: 'ok' });
  });

  it('marks an empty answer with no_answer and a Norwegian notice, keeping the sources', async () => {
    const body = (await (
      await setup().post('/api/tools/call/kunnskapsassistenten__empty', { query: 'x' })
    ).json()) as Record<string, unknown>;

    expect(body).toMatchObject({
      answer: '',
      status: 'ok',
      no_answer: true,
      notice: 'Fant ikke noe svar.',
    });
    expect(body.sources).toHaveLength(2);
  });

  it('renders fields output as the text field and returns the fields', async () => {
    const body = await (
      await setup().post('/api/tools/call/klarsprak__default', { query: 'Skriv om.' })
    ).json();

    expect(body).toEqual({
      answer: 'Klar tekst.',
      status: 'ok',
      ai_generated: true,
      fields: { text: 'Klar tekst.', changes: ['kortere'] },
    });
  });

  it('answers 200 with status error for what a model can fix, and a 4xx problem keeping the error code for what it cannot', async () => {
    const { app, post } = setup();
    const missing = await post('/api/tools/call/kunnskapsassistenten__default', {});
    const unknown = await post('/api/tools/call/nope', { query: 'x' });
    const refused = await post('/api/tools/call/nav__secret', { query: 'x' });
    const anonymous = await app.request('/api/tools/openapi.json');

    expect(missing.status).toBe(200);
    expect(await missing.json()).toMatchObject({
      status: 'error',
      error: { code: 'missing_query' },
    });
    expect(unknown.status).toBe(404);
    expect(unknown.headers.get('content-type')).toContain('application/problem+json');
    expect(await unknown.json()).toMatchObject({
      type: 'about:blank',
      status: 404,
      code: 'invalid_tool_name',
      error: { code: 'invalid_tool_name' },
    });
    expect(refused.status).toBe(403);
    expect(anonymous.status).toBe(401);
    expect(await anonymous.json()).toMatchObject({
      status: 401,
      title: 'Invalid or missing API key',
      error: 'Invalid or missing API key',
    });
  });
});

describe('helpers', () => {
  it('ends a live stream with exactly the final answer: the missing tail, or a retract and the whole answer', () => {
    const run = (deltas: string[], final: string) => {
      const out: string[] = [];
      const tracker = new AnswerTracker(true, {
        content: (text) => out.push(text),
        retract: () => out.push('<retract>'),
      });
      deltas.forEach((d) => tracker.delta(d));
      tracker.settle(final);
      return out;
    };

    expect(run(['Hei '], 'Hei verden.')).toEqual(['Hei ', 'verden.']);
    expect(run(['Hei verden.'], 'Hei verden.')).toEqual(['Hei verden.']);
    expect(run(['Utkast.'], 'Endelig [1].')).toEqual(['Utkast.', '<retract>', 'Endelig [1].']);
    expect(run(['Utkast.'], '')).toEqual(['Utkast.', '<retract>']);
  });

  it('splits OpenAI messages into history and the last user query', () => {
    expect(
      splitMessages([
        { role: 'user', content: 'første' },
        { role: 'assistant', content: 'svar' },
        { role: 'user', content: [{ type: 'text', text: 'andre' }] },
      ]),
    ).toEqual({
      query: 'andre',
      history: [
        { role: 'user', text: 'første' },
        { role: 'assistant', text: 'svar' },
      ],
    });
  });

  it('keeps the breadcrumb alone when it already starts with the title', () => {
    expect(
      citationBundle([{ chunkId: 'x', title: 'Lofoten', headers: ['Lofoten', 'Fiske'] }]).sources[0]
        ?.metadata,
    ).toEqual([{ source: 'x', chunk_id: 'x', name: 'Lofoten › Fiske' }]);
  });
});

describe('citations from the answer', () => {
  const records = ['c1', 'c2', 'c3'].map((chunkId, i) => ({
    chunkId,
    title: `Rapport ${i + 1}`,
    url: `https://kudos.dfo.no/d${i + 1}`,
    text: `tekst ${chunkId}`,
  }));
  const sources: Part = {
    mime: 'application/vnd.genai.sources+json',
    body: { kind: 'json', json: { sources: records } },
  };
  const answer = (citations: unknown[] | undefined): Part => ({
    ...textPart('Svar.'),
    ...(citations ? { meta: { citations } } : {}),
  });

  it('uses only the cited chunks, in citation order, when the answer carries citations', () => {
    const cited = citedOf([
      answer([
        { index: 2, chunkId: 'c1' },
        { index: 1, chunkId: 'c3' },
      ]),
      sources,
    ]);
    expect(cited.map((r) => r.chunkId)).toEqual(['c3', 'c1']);
  });

  it('gives no citations for an answer that cites nothing, even with chunks read', () => {
    expect(citedOf([answer([]), sources])).toEqual([]);
  });

  it('falls back to all sources when the strategy reports no citation metadata', () => {
    expect(citedOf([answer(undefined), sources]).map((r) => r.chunkId)).toEqual(['c1', 'c2', 'c3']);
  });
});

describe('AI marking and version pinning', () => {
  const ask = {
    model: 'kunnskapsassistenten__default',
    messages: [{ role: 'user', content: 'Hei' }],
  };
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
        : { ok: false, code: 'model_not_found', message: name };
    },
  });

  it('marks /v1 and REST answers as AI-generated in a header and in the body', async () => {
    const { post } = setup({ modelsOf: async () => ['foundry/gpt-4o'] });
    const completion = await post('/v1/chat/completions', ask);
    const tool = await post('/api/tools/call/kunnskapsassistenten__default', { query: 'x' });
    const stream = await post('/v1/chat/completions', { ...ask, stream: true });

    for (const response of [completion, tool]) {
      expect(response.headers.get('genai-generated-by')).toBe('ai');
      expect(response.headers.get('genai-model')).toBe('foundry/gpt-4o');
      expect(await response.json()).toMatchObject({ ai_generated: true });
    }
    expect(stream.headers.get('genai-generated-by')).toBe('ai');
  });

  it('names no model when several models produced the answer', async () => {
    const { post } = setup({ modelsOf: async () => ['a/one', 'b/two'] });
    const response = await post('/v1/chat/completions', ask);

    expect(response.headers.get('genai-generated-by')).toBe('ai');
    expect(response.headers.has('genai-model')).toBe(false);
  });

  it('runs the version in GenAI-Version and names the version that ran', async () => {
    const seen: (number | undefined)[] = [];
    const { post } = setup({ resolver: pinning(seen) });
    const pinned = await post('/v1/chat/completions', ask, 'good', { 'GenAI-Version': '2' });
    const latest = await post('/api/tools/call/kunnskapsassistenten__default', { query: 'x' });

    expect(seen).toEqual([2, undefined]);
    expect(pinned.headers.get('genai-service-version')).toBe('2');
    expect(latest.headers.get('genai-service-version')).toBe('4');
  });

  it('pins the version with metadata.version like the GenAI-Version header', async () => {
    const seen: (number | undefined)[] = [];
    const { post } = setup({ resolver: pinning(seen) });
    const fromMetadata = await post('/v1/chat/completions', { ...ask, metadata: { version: '2' } });
    const agreeing = await post(
      '/v1/chat/completions',
      { ...ask, metadata: { version: '3' } },
      'good',
      {
        'GenAI-Version': '3',
      },
    );
    const missing = await post('/v1/chat/completions', { ...ask, metadata: { version: '9' } });

    expect(seen).toEqual([2, 3, 9]);
    expect(fromMetadata.headers.get('genai-service-version')).toBe('2');
    expect(agreeing.headers.get('genai-service-version')).toBe('3');
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: { code: 'version_not_found' } });
  });

  it('refuses a malformed metadata.version and one that disagrees with the header with 400', async () => {
    const seen: (number | undefined)[] = [];
    const { post } = setup({ resolver: pinning(seen) });
    const malformed = await post('/v1/chat/completions', {
      ...ask,
      metadata: { version: 'siste' },
    });
    const disagreeing = await post(
      '/v1/chat/completions',
      { ...ask, metadata: { version: '2' } },
      'good',
      { 'GenAI-Version': '3' },
    );

    expect(seen).toEqual([]);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({
      error: {
        code: 'invalid_version',
        message: '`metadata.version` must be a positive whole number.',
      },
    });
    expect(disagreeing.status).toBe(400);
    expect(await disagreeing.json()).toMatchObject({
      error: {
        code: 'invalid_version',
        message:
          '`GenAI-Version` asks for version 3 and `metadata.version` for version 2. Send one version.',
      },
    });
  });

  it('refuses an unknown version with 409 and a malformed one with 400', async () => {
    const { post } = setup({ resolver: pinning([]) });
    const missing = await post('/v1/chat/completions', ask, 'good', { 'GenAI-Version': '9' });
    const toolMissing = await post(
      '/api/tools/call/kunnskapsassistenten__default',
      { query: 'x' },
      'good',
      {
        'GenAI-Version': '9',
      },
    );
    const malformed = await post('/v1/chat/completions', ask, 'good', { 'GenAI-Version': 'siste' });

    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ error: { code: 'version_not_found' } });
    expect(toolMissing.status).toBe(409);
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ error: { code: 'invalid_version' } });
  });

  it('answers 503 when the service is paused because its model is retired', async () => {
    const { post } = setup({ resolver: pinning([]) });
    const completion = await post('/v1/chat/completions', { ...ask, model: 'paused__default' });
    const tool = await post('/api/tools/call/paused__default', { query: 'x' });

    expect(completion.status).toBe(503);
    expect(await completion.json()).toMatchObject({
      error: { code: 'service_paused', message: 'Modellen tjenesten bruker er tatt ut av bruk' },
    });
    expect(tool.status).toBe(503);
  });

  it('documents the marking, the version header and the platform name in the OpenAPI', async () => {
    const { app } = setup();
    const spec = (await (
      await app.request('/api/tools/openapi.json', { headers: { 'x-api-key': 'good' } })
    ).json()) as {
      info: { title: string };
      paths: Record<string, { post: Record<string, unknown> }>;
    };
    const operation = spec.paths['/api/tools/call/kunnskapsassistenten__default']?.post as {
      parameters: { name: string }[];
      responses: Record<string, { headers?: Record<string, unknown>; content?: unknown }>;
    };

    expect(spec.info.title).toBe('Fellesløsning for generativ KI');
    const english = (await (
      await app.request('/api/tools/openapi.json', {
        headers: { 'x-api-key': 'good', 'accept-language': 'en-GB' },
      })
    ).json()) as { info: { title: string; description: string } };
    expect(english.info.title).toBe('Generative AI platform for the public sector');
    expect(english.info.description).toMatch(/^Generative AI services for the public sector\./);
    expect(operation.parameters.map((p) => p.name)).toEqual(['GenAI-Version']);
    expect(Object.keys(operation.responses['200']?.headers ?? {})).toEqual(
      expect.arrayContaining(['genai-generated-by', 'genai-model', 'genai-service-version']),
    );
    expect(JSON.stringify(operation.responses['200']?.content)).toContain('ai_generated');
    expect(Object.keys(operation.responses)).toEqual(expect.arrayContaining(['409', '503']));
  });
});

describe('sources people can open', () => {
  it('cites the link the knowledge layer gave and no Kudos link for a bare numeric id', () => {
    const search = 'https://kudos.dfo.no/dokumenter?query=Tildelingsbrev%202025';
    const bundle = citationBundle([
      { chunkId: 'k1', title: 'Tildelingsbrev 2025', document: '330296', url: search },
      { chunkId: 'a1', title: 'Arkivsak', text: 'Sak.', document: '4711' },
    ]);

    expect(bundle.citations).toEqual([search]);
    expect(bundle.sources[1]?.source.url).toBe('chunk:a1');
    expect(bundle.sources[1]).not.toHaveProperty('url');
  });

  it('gives a source a url and a citations entry only when the link is http or https', () => {
    const bundle = citationBundle([
      { chunkId: 'attached:abc:0', title: 'vedtak.txt', document: 'attached:abc' },
      { chunkId: 'f1', title: 'Fil', url: 'file:///srv/notat.pdf' },
      { chunkId: 'w1', title: 'Side', url: 'https://www.digdir.no/side' },
    ]);

    expect(bundle.citations).toEqual(['https://www.digdir.no/side']);
    expect(bundle.sources.map((s) => s.url)).toEqual([
      undefined,
      undefined,
      'https://www.digdir.no/side',
    ]);
  });

  it('shows source titles and heading paths without markdown', () => {
    const bundle = citationBundle([
      {
        chunkId: 'm1',
        title: 'Tildelingsbrev(pdf) 2024',
        headers: ['**9. Budsjettmessige forutsetninger**', '## **8.2.1 Rapportering**'],
      },
      { chunkId: 'm2', headers: ['# __Årsrapport__'] },
    ]);

    expect(bundle.sources[0]?.metadata[0]?.name).toBe(
      'Tildelingsbrev(pdf) 2024 › 9. Budsjettmessige forutsetninger › 8.2.1 Rapportering',
    );
    expect(bundle.sources[1]?.source.name).toBe('Årsrapport');
  });

  it('trims the excerpt to about 300 characters at a word boundary', () => {
    const long = `## Mål\n\n${'Digitaliseringsdirektoratet skal styrke samordningen. '.repeat(20)}`;
    const excerpt = excerptOf(long) ?? '';

    expect(excerpt.length).toBeLessThanOrEqual(300);
    expect(excerpt.startsWith('Mål Digitaliseringsdirektoratet')).toBe(true);
    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerptOf('   ')).toBeUndefined();
  });

  it('carries the document version and publish date when the source knows them', () => {
    const bundle = citationBundle([
      {
        chunkId: 'c1',
        text: 'Tekst',
        url: 'https://x.no/a',
        version: 3,
        publishedAt: '2025-01-15',
      },
    ]);

    expect(bundle.sources[0]).toMatchObject({ version: '3', published_at: '2025-01-15' });
  });
});

describe('table results', () => {
  it('passes a table with its source links and its CSV alongside the answer', () => {
    const table = {
      kind: 'table',
      columns: [{ key: 'goal', label: 'Mål' }],
      rows: [
        {
          cells: {
            goal: {
              value: 'Felles løsninger',
              sources: [
                {
                  chunkId: 'c1',
                  title: 'Årsrapport 2024',
                  url: 'https://kudos.dfo.no/dokumenter?query=%C3%85rsrapport%202024',
                },
              ],
            },
          },
        },
      ],
      skipped: [],
    };

    const marker = tableMarker([
      { mime: TABLE_MIME, body: { kind: 'json', json: table } },
      { mime: 'text/csv', body: { kind: 'text', text: 'Mål,Mål (kilde)' } },
    ]);

    expect(marker.csv).toBe('Mål,Mål (kilde)');
    expect(marker.table).toMatchObject({
      rows: [
        {
          cells: {
            goal: {
              sources: [
                {
                  chunkId: 'c1',
                  url: 'https://kudos.dfo.no/dokumenter?query=%C3%85rsrapport%202024',
                },
              ],
            },
          },
        },
      ],
    });
    expect(tableMarker([{ mime: 'text/plain', body: { kind: 'text', text: 'hei' } }])).toEqual({});
  });

  it('gives each cell source chunk_id and document_id like a chat source, and a url only when it opens', () => {
    const table = {
      columns: [{ key: 'goal', label: 'Mål' }],
      rows: [
        {
          cells: {
            goal: {
              value: 'Mål 1',
              sources: [
                { chunkId: 'c1', document: 'd1', title: 'Rapport', url: 'chunk:c1' },
                { chunkId: 'c2', document: 'd2', url: 'https://x.no/d2', publishedAt: '2025' },
              ],
            },
          },
        },
      ],
    };

    const marker = tableMarker([{ mime: TABLE_MIME, body: { kind: 'json', json: table } }]);
    const sources = (marker.table as typeof table).rows[0]?.cells.goal.sources;

    expect(sources).toEqual([
      { chunkId: 'c1', chunk_id: 'c1', document: 'd1', document_id: 'd1', title: 'Rapport' },
      {
        chunkId: 'c2',
        chunk_id: 'c2',
        document: 'd2',
        document_id: 'd2',
        url: 'https://x.no/d2',
        publishedAt: '2025',
        published_at: '2025',
      },
    ]);
  });
});

const streamOf = (bytes: number) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (let sent = 0; sent < bytes; sent += 64 * 1024)
        controller.enqueue(new Uint8Array(Math.min(64 * 1024, bytes - sent)).fill(32));
      controller.close();
    },
  });

describe('request body limits', () => {
  it('answers 413 when a chat body streams in past the limit', async () => {
    const { app } = setup();
    const res = await app.request('/v1/chat/completions', {
      method: 'POST',
      headers: { authorization: 'Bearer good', 'content-type': 'application/json' },
      body: streamOf(bodyLimits.chat + 1),
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: 'request_too_large' } });
  });

  it('answers 413 when a tool call body is over the limit', async () => {
    const { post } = setup();
    const res = await post('/api/tools/call/kunnskapsassistenten__default', {
      query: 'x'.repeat(bodyLimits.tools),
    });
    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ status: 413, code: 'request_too_large' });
  });

  it('leaves room for the largest set of documents a chat request may carry', () => {
    const encoded = Math.ceil((documentLimits.maxBytes * documentLimits.maxCount * 4) / 3);
    expect(bodyLimits.chat).toBeGreaterThan(encoded);
  });
});
