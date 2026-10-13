import { describe, expect, it } from 'vitest';
import type { ApiContext } from '../api';
import { assistantApi, readAssistantEvents, type AssistantTurn } from './assistant';

const turn: AssistantTurn = {
  turnId: 'trn_1',
  status: 'completed',
  message: 'Første avsnitt.\n\nAndre avsnitt.',
  proposals: [],
  usage: { tokens: 10, budgetLeftToday: 199990, dailyBudget: 200000 },
};

const sse = (chunks: string[]) =>
  new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        chunks.forEach((c) => controller.enqueue(encoder.encode(c)));
        controller.close();
      },
    }),
    { headers: { 'content-type': 'text/event-stream' } },
  );

const stream = [
  'event: delta\ndata: {"text":"Første "}\n\n',
  'event: delta\ndata: {"text":"avsnitt."}\n\nevent: paragraph\ndata: {"text":"Første avsnitt."}\n',
  '\nevent: rejected\ndata: {"attempted":"x = 1","reason":"For stor","code":"VALIDATION_MAXIMUM"}\n\n',
  `event: done\ndata: ${JSON.stringify({ turn })}\n\n`,
];

describe('assistant API client', () => {
  it('reads server-sent events split across chunks', async () => {
    const events = [];
    for await (const event of readAssistantEvents(sse(stream))) events.push(event);
    expect(events.map((e) => e.type)).toEqual(['delta', 'delta', 'paragraph', 'rejected', 'done']);
    expect(events[2]).toEqual({ type: 'paragraph', text: 'Første avsnitt.' });
    expect(events[4]).toEqual({ type: 'done', turn });
  });

  it('reads a JSON answer when a streaming request gets no event stream back', async () => {
    const api = assistantApi({
      get: async () => undefined as never,
      request: async () => undefined as never,
      tenantPath: (t) => `/tenants/${t}`,
      send: async () =>
        new Response(JSON.stringify(turn), { headers: { 'content-type': 'application/json' } }),
    });

    const result = await api.turn(
      '999888777',
      'soknadsuttrekk',
      { message: 'Hei', draft: { definition: {} } },
      () => undefined,
    );

    expect(result).toEqual({ turn, streamed: false });
  });

  it('streams when the context can send raw requests and falls back to JSON otherwise', async () => {
    const sent: { path: string; body: unknown; headers?: Record<string, string> }[] = [];
    const base: ApiContext = {
      get: async () => undefined as never,
      request: async <T>(_method: string, path: string, body: unknown) => {
        sent.push({ path, body });
        return turn as T;
      },
      tenantPath: (t) => `/tenants/${t}`,
    };
    const json = await assistantApi(base).turn(
      '999888777',
      'new',
      { message: 'Hei', draft: { definition: {} } },
      () => undefined,
    );
    expect(json).toEqual({ turn, streamed: false });
    expect(sent[0]).toEqual({
      path: '/tenants/999888777/services/new/assistant/turns',
      body: { message: 'Hei', draft: { definition: {} }, stream: false },
    });

    const events: string[] = [];
    const streaming = assistantApi({
      ...base,
      send: async (_method, path, body, headers) => {
        sent.push({ path, body, ...(headers ? { headers } : {}) });
        return sse(stream);
      },
    });
    const result = await streaming.turn(
      '999888777',
      'soknadsuttrekk',
      { message: 'Hei', draft: { definition: {} } },
      (e) => events.push(e.type),
    );
    expect(result).toEqual({ turn, streamed: true });
    expect(events).toHaveLength(5);
    expect(sent[1]?.headers).toEqual({ accept: 'text/event-stream' });
    expect((sent[1]?.body as { stream: boolean }).stream).toBe(true);
  });
});
