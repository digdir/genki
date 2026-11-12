import type { StreamEvent } from '@genai/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createGenkiApi, sourceFromWire } from './api.js';

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

  it('reads a stored turn’s markers off its excerpts, which is all a stored turn keeps of them', async () => {
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

  const reload = async (sources: unknown[]) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        json({
          conversation: { id: 't1', topic: 'Ventetid', tags: [], created: 1 },
          messages: [
            { id: 'q', role: 'user', text: 'Ventetid?', created: 1, chunks: [] },
            { id: 'a', role: 'assistant', text: 'Ned [1].', created: 2, chunks: [], sources },
          ],
        }),
      ),
    );
    return (await api().loadThread('t1')).turns[0]?.answer;
  };

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
