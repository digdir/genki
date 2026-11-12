import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenkiApi, sourceFromWire } from './api.js';

afterEach(() => vi.unstubAllGlobals());

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
});

// genki names the run behind an answer, which feedback is sent on: `task` on a stored message, the
// `genai-task` header on a stream.
describe('the run behind an answer', () => {
  const api = () => createGenkiApi({ baseUrl: '/genki', tenant: 'digdir' });

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

  it('comes with the end of an answer asked here, from the stream’s `genai-task` header', async () => {
    const frames = [
      { choices: [{ delta: { content: 'Svar.' } }] },
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
    ];
    const body = `${frames.map((f) => `data: ${JSON.stringify(f)}\n\n`).join('')}data: [DONE]\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(body, {
            headers: { 'content-type': 'text/event-stream', 'genai-task': 'task-9' },
          }),
      ),
    );
    const events = [];
    for await (const event of api().ask({
      question: 'Hva er fast?',
      model: 'ka__default',
      conversationId: 't1',
      steps: false,
      signal: new AbortController().signal,
    }))
      events.push(event);
    const done = events.at(-1);
    expect(done?.type === 'done' ? done.answer.taskId : undefined).toBe('task-9');
  });
});
