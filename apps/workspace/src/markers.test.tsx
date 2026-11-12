// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createWorkspaceApi } from './api';
import { Conversation } from './Conversation';
import type { AssistantMessage, ChatReply } from './types';

document.getAnimations ??= () => [];

afterEach(cleanup);

const answerText = 'Ventetida gjekk ned [1], bemanninga auka [2], og no er ho fire minutt [3].';

const markers = [
  { marker: '1', chunk_id: 'c1', document: 'd1' },
  { marker: '2', chunk_id: 'c2', document: 'd2' },
  { marker: '3', chunk_id: 'c3', document: 'd1' },
];

const excerpts = {
  c1: { chunk_id: 'c1', text: 'Ventetida gjekk ned.', position: 0, markers: ['1'] },
  c2: { chunk_id: 'c2', text: 'Bemanninga auka.', position: 0, markers: ['2'] },
  c3: { chunk_id: 'c3', text: 'No er ventetida fire minutt.', position: 4, markers: ['3'] },
};

const liveSources = [
  {
    source: { name: 'Årsrapport 2025', id: 'c1', url: 'chunk:c1' },
    metadata: [{ source: 'c1', chunk_id: 'c1', name: 'Årsrapport 2025 › Telefon' }],
    excerpt: 'Ventetida gjekk ned.',
    index: 1,
    title: 'Årsrapport 2025',
    document_id: 'd1',
    excerpts: [excerpts.c1, excerpts.c3],
    markers: ['1', '3'],
  },
  {
    source: { name: 'Tildelingsbrev 2025', id: 'c2', url: 'chunk:c2' },
    metadata: [{ source: 'c2', chunk_id: 'c2' }],
    excerpt: 'Bemanninga auka.',
    index: 2,
    title: 'Tildelingsbrev 2025',
    document_id: 'd2',
    excerpts: [excerpts.c2],
    markers: ['2'],
  },
];

const respond = (body: string, type: string) =>
  (async () => new Response(body, { headers: { 'content-type': type } })) as typeof fetch;

const ask = (sourcesFrame: Record<string, unknown>): Promise<ChatReply> => {
  const frames = [
    { choices: [{ index: 0, delta: { content: answerText }, finish_reason: null }] },
    { choices: [{ index: 0, delta: {}, finish_reason: null }], ...sourcesFrame },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ];
  const sse = [...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), 'data: [DONE]\n\n'];
  const api = createWorkspaceApi({
    baseUrl: '/api',
    fetch: respond(sse.join(''), 'text/event-stream'),
    token: () => 'tok',
  });
  return api.chat('ka__default', [], () => undefined);
};

const reload = async (stored: Record<string, unknown>) => {
  const api = createWorkspaceApi({
    baseUrl: '/api',
    fetch: respond(
      JSON.stringify({ messages: [{ role: 'assistant', text: answerText, ...stored }] }),
      'application/json',
    ),
    token: () => 'tok',
  });
  const [message] = (await api.conversations?.messages('conv-1')) ?? [];
  return message as AssistantMessage;
};

const show = (message: Partial<AssistantMessage>) =>
  render(
    <Conversation
      messages={[
        { id: 'a1', role: 'assistant', text: answerText, lang: 'nb', sources: [], ...message },
      ]}
      organisation="Digdir"
      now={new Date('2026-10-09T10:00:00Z')}
      onRetry={() => undefined}
      onFeedback={async () => undefined}
    />,
  );

const opened = (name: string) => {
  const link = screen.getByRole('link', { name });
  return document.getElementById(link.getAttribute('href')?.slice(1) ?? '');
};

describe('an answer that cites excerpts', () => {
  it('opens the excerpt a marker names when the answer cites excerpts', async () => {
    const reply = await ask({ sources: liveSources, markers });
    show({ sources: reply.sources });

    const third = opened('Kilde 3: Årsrapport 2025');
    expect(third?.getAttribute('value')).toBe('3');
    expect(third?.querySelector('details')?.textContent).toContain('No er ventetida fire minutt.');
    expect(third?.textContent).not.toContain('Ventetida gjekk ned.');
    const first = opened('Kilde 1: Årsrapport 2025 › Telefon');
    expect(first?.querySelector('details')?.textContent).toContain('Ventetida gjekk ned.');
    expect(opened('Kilde 2: Tildelingsbrev 2025')?.textContent).toContain('Bemanninga auka.');
  });

  it("gives a marker's source the heading only when the heading belongs to that excerpt", async () => {
    const reply = await ask({ sources: liveSources, markers });

    expect(reply.sources.map((s) => [s.index, s.title])).toEqual([
      [1, 'Årsrapport 2025 › Telefon'],
      [2, 'Tildelingsbrev 2025'],
      [3, 'Årsrapport 2025'],
    ]);
  });

  it('counts a document that several markers cite once among the sources used, as before', async () => {
    const reply = await ask({ sources: liveSources, markers });
    show({
      sources: reply.sources,
      procedure: {
        steps: [
          { id: 'search', key: 'search', title: 'Søkte', titleTool: undefined, status: 'done' },
        ],
        startedAt: 0,
        finishedAt: 1000,
      },
    });

    expect(screen.getByText(/Brukte 2 kilder/)).toBeTruthy();
  });

  it('numbers by index as before when the markers name no usable entry', async () => {
    const reply = await ask({
      sources: liveSources,
      markers: [{ marker: 'første', chunk_id: 'c1', document: 'd1' }, { marker: '2' }],
    });

    expect(reply.sources.map((s) => [s.index, s.excerpt])).toEqual([
      [1, 'Ventetida gjekk ned.'],
      [2, 'Bemanninga auka.'],
    ]);
  });

  it('leaves a marker whose excerpt no source holds as plain text, as before', async () => {
    const reply = await ask({
      sources: liveSources,
      markers: [...markers, { marker: '4', chunk_id: 'c9', document: 'd9' }],
    });
    show({ text: 'Svar [4].', sources: reply.sources });

    expect(screen.queryByRole('link', { name: /Kilde 4/ })).toBeNull();
    expect(document.querySelector('.answer-text')?.textContent).toBe('Svar [4].');
  });
});

describe('a stored turn', () => {
  const chunks = [
    {
      chunkId: 'c2',
      docTitle: 'Tildelingsbrev 2025',
      docNum: 'd2',
      contentMarkdown: 'Bemanninga auka.',
    },
    {
      chunkId: 'c1',
      docTitle: 'Årsrapport 2025',
      docNum: 'd1',
      contentMarkdown: 'Ventetida gjekk ned.',
    },
    {
      chunkId: 'c3',
      docTitle: 'Årsrapport 2025',
      docNum: 'd1',
      contentMarkdown: 'No er ventetida fire minutt.',
    },
  ];
  const marked = [
    { title: 'Årsrapport 2025', index: 1, document: 'd1', excerpt: 'Ventetida gjekk ned.' },
    { title: 'Tildelingsbrev 2025', index: 2, document: 'd2', excerpt: 'Bemanninga auka.' },
    { title: 'Årsrapport 2025', index: 3, document: 'd1', excerpt: 'No er ventetida fire minutt.' },
  ];

  it('opens the excerpt a marker names when a stored turn carries markers', async () => {
    const stored = liveSources.map((s) => ({
      index: s.index,
      title: s.title,
      document_id: s.document_id,
      excerpts: s.excerpts,
      markers: s.markers,
    }));
    const message = await reload({ sources: stored, markers, chunks });

    expect(message.sources).toEqual(marked);
    show({ sources: message.sources });
    expect(opened('Kilde 3: Årsrapport 2025')?.textContent).toContain(
      'No er ventetida fire minutt.',
    );
  });

  it("finds a marker's excerpt in the stored chunks when the turn has no sources", async () => {
    const message = await reload({ markers, chunks });

    expect(message.sources).toEqual(marked);
  });

  it('numbers by position as before when a stored turn has no markers', async () => {
    const message = await reload({ sources: liveSources, chunks });

    expect(message.sources).toEqual([
      { title: 'Tildelingsbrev 2025', index: 1, excerpt: 'Bemanninga auka.' },
      { title: 'Årsrapport 2025', index: 2, excerpt: 'Ventetida gjekk ned.' },
      { title: 'Årsrapport 2025', index: 3, excerpt: 'No er ventetida fire minutt.' },
    ]);
  });
});
