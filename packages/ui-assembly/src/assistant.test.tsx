// @vitest-environment jsdom
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import {
  answerCopy,
  fromTemplate,
  placeIn,
  turnOff,
  turnOn,
  withSetting,
  type AssistantLayout,
  type BuilderState,
  type ModelRow,
  type ProfileData,
} from '@genai/ui-blocks';
import type { AnswerMarker, StreamEvent } from '@genai/client';
import { InLocale } from '@genai/i18n/react';
import { FileSearchIcon } from '@navikt/aksel-icons';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  createGenkiApi,
  FACETS_URL_LIMIT,
  HttpError,
  type AskParams,
  type AssistantApi,
} from './api.js';
import { Assistant } from './Assistant.js';
import type { AssistantProfile, FieldSpec } from './profile.js';
import { browserStorage, type AssistantStorage } from './storage.js';
import { useAssistant, type AssistantFeedback } from './useAssistant.js';

// A fake genki: two variants of nothing, one service with a collection that has filter fields,
// one stored thread, and an answer that cites one excerpt and reports two steps.
const rows: ModelRow[] = [
  {
    id: 'ka__default',
    _service: 'ka',
    _service_title: 'KA',
    _variant_title: 'Svar med kilder',
    _pickable: true,
    _chat: true,
    _datasets: [
      {
        tenant: 'digdir',
        'dataset-config-key': 'kudos',
        filters: [{ field: 'type', kinds: ['multiselect'], 'value-type': 'string' }],
      },
    ],
  },
];

const answer = 'Rapporteringen er fast [1].';
const source = {
  index: 1,
  title: 'Tildelingsbrev 2022',
  documentId: '42',
  excerpts: [{ chunkId: 'c1', text: 'Rapporteringen skjer hvert år.' }],
};

// `streamed`: the markers the stream names, from a service that cites excerpts.
const fakeApi = (streamed?: AnswerMarker[]) => {
  const asked: AskParams[] = [];
  const api: AssistantApi = {
    loadModels: vi.fn(async () => rows),
    loadThreads: vi.fn(async () => [
      { id: 't-old', title: 'En gammel tråd', updatedAt: Date.now(), service: 'ka' },
      { id: 't-other', title: 'En annen tjenestes tråd', updatedAt: Date.now(), service: 'other' },
    ]),
    // A stored answer cites excerpts by marker, as genki's chunks give them.
    loadThread: vi.fn(async () => ({
      title: 'En gammel tråd',
      turns: [
        {
          id: 'm1',
          question: 'Hva er fast?',
          askedAt: 1,
          answer: {
            text: answer,
            status: 'complete' as const,
            sources: [source],
            markers: [{ marker: '1', chunkId: 'c1', documentId: '42' }],
            created: 2,
          },
        },
      ],
    })),
    loadCorpora: vi.fn(async () => [
      { key: 'kudos', label: 'Kudos' },
      { key: 'genki-docs', label: 'GenKI-dokumentasjon' },
    ]),
    loadFields: vi.fn(async () => [{ id: 'type', label: 'Dokumenttyper' }]),
    loadFacets: vi.fn(async () => [
      { id: 'type', label: 'Dokumenttyper', options: [{ value: 'Årsrapport', count: 3 }] },
    ]),
    loadAbout: vi.fn(async () => undefined),
    ask: async function* (params): AsyncGenerator<StreamEvent, void> {
      asked.push(params);
      if (!params.conversationId) yield { type: 'conversation', conversationId: 't-new' };
      if (params.steps) {
        yield { type: 'step', step: { tool: 'search' } };
        yield { type: 'step', step: { tool: 'generate_response' } };
      }
      yield { type: 'text', text: answer };
      yield {
        type: 'done',
        answer: {
          id: 'a1',
          text: answer,
          sources: [source],
          citations: [],
          ...(streamed ? { markers: streamed } : {}),
          noAnswer: false,
        },
      };
    },
  };
  return { api, asked };
};

// Two document types, so one chosen narrows: the fake's only type, chosen, is the whole field.
const twoTypes = async () => [
  {
    id: 'type',
    label: 'Dokumenttyper',
    options: [
      { value: 'Årsrapport', count: 3 },
      { value: 'Tildelingsbrev', count: 2 },
    ],
  },
];

// A wide window: both panels fit beside the main column.
beforeEach(() => {
  window.matchMedia = ((media: string) => ({
    media,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Object.defineProperty(document.documentElement, 'clientWidth', {
    configurable: true,
    get: () => 1920,
  });
  Element.prototype.scrollIntoView ??= () => {};
  document.getAnimations ??= () => [];
  Element.prototype.scrollTo ??= () => {};
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  history.replaceState(null, '', '/');
});
afterEach(cleanup);

const draw = (layout: AssistantLayout, api: AssistantApi, threadInUrl = false) =>
  render(
    <Assistant
      api={api}
      layout={layout}
      service="ka"
      tenant="digdir"
      profile={{ assistantName: 'KA', suggestions: ['Hva er fast?'] }}
      threadInUrl={threadInUrl}
    />,
  );

const send = async (question = 'Hva er fast?') => {
  const field = await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
  // The service's collection must be known before the question can go.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send spørsmålet' })).toBeTruthy());
  fireEvent.change(field, { target: { value: question } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send spørsmålet' }));
  });
};

// Read as a whole, since a footnote mark holds the word before it on its own line.
const ask = async (question?: string) => {
  await send(question);
  await waitFor(() =>
    expect(
      [...document.querySelectorAll('.uib-answer-text')].some((text) =>
        text.textContent?.includes('Rapporteringen er fast'),
      ),
    ).toBe(true),
  );
};

const footnotes = () =>
  [...document.querySelectorAll<HTMLElement>('.uib-answer-mark')].filter((mark) =>
    /^Utdrag \d+: /.test(mark.getAttribute('aria-label') ?? ''),
  );

const state = (template: Parameters<typeof fromTemplate>[0]): BuilderState =>
  fromTemplate(template);

describe('the assistant a layout describes', () => {
  it('draws no panel for a zone the layout leaves empty', async () => {
    draw(state('chat-only').layout, fakeApi().api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('complementary')).toBeNull();
  });

  it('says to put Chat in the content when the layout has no Chat', async () => {
    draw(turnOff(state('sources-only'), 'chat').layout, fakeApi().api);
    expect(await screen.findByText('Legg Chat i innholdet for å prøve assistenten.')).toBeTruthy();
  });

  it('asks a question and streams the answer, with Fremgangsmåte over it from the steps', async () => {
    const { api, asked } = fakeApi();
    draw(state('knowledge-assistant').layout, api);
    await ask();
    expect(asked[0]?.steps).toBe(true);
    expect(asked[0]?.dataset).toEqual({ tenant: 'digdir', key: 'kudos' });
    const card = document.querySelector('.uib-approach-card');
    const drawn = document.querySelector('.uib-answer');
    if (!card || !drawn) throw new Error('no card or no answer');
    expect(card.compareDocumentPosition(drawn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(card.textContent).toContain('Lette etter steder som handler om spørsmålet');
    expect(card.textContent).toContain('Skrev svaret');
    expect(drawn.textContent).toContain('Rapporteringen er fast');
  });

  it('asks for no steps without Fremgangsmåte, and draws none', async () => {
    const { api, asked } = fakeApi();
    draw(state('sources-only').layout, api);
    await ask();
    expect(asked[0]?.steps).toBe(false);
    expect(document.querySelector('.uib-approach-card')).toBeNull();
  });

  // A stored thread opened from the address: its answer cites one excerpt by marker.
  const stored = async (layout: AssistantLayout) => {
    history.replaceState(null, '', '/?t=t-old');
    draw(layout, fakeApi().api, true);
    await waitFor(() =>
      expect(document.querySelector('.uib-answer')?.textContent).toContain(
        'Rapporteringen er fast',
      ),
    );
  };

  it('draws the footnote of a stored answer that cites an excerpt, with Kilder placed', async () => {
    await stored(state('sources-only').layout);
    expect(footnotes()).toHaveLength(1);
  });

  it('draws the footnote of a streamed answer by the markers the stream names', async () => {
    draw(
      state('sources-only').layout,
      fakeApi([{ marker: '1', chunkId: 'c1', documentId: '42' }]).api,
    );
    // The footnote takes the last word with it, so the sentence is no longer one text.
    await send();
    await waitFor(() => expect(footnotes()).toHaveLength(1));
  });

  it('draws the footnote while the answer streams, by the markers the `sources` event names', async () => {
    let finish = () => {};
    const finished = new Promise<void>((resolve) => (finish = resolve));
    const { api } = fakeApi();
    api.ask = async function* (): AsyncGenerator<StreamEvent, void> {
      yield { type: 'conversation', conversationId: 't-new' };
      yield { type: 'text', text: answer };
      yield {
        type: 'sources',
        sources: [source],
        citations: [],
        markers: [{ marker: '1', chunkId: 'c1', documentId: '42' }],
      };
      // No `done` until the test ends: the footnote comes from the `sources` event alone.
      await finished;
    };
    try {
      draw(state('sources-only').layout, api);
      await send();
      await waitFor(() => expect(footnotes()).toHaveLength(1));
    } finally {
      finish();
    }
  });

  it('keeps no markers from earlier sources once the finished answer names none', async () => {
    const { api } = fakeApi();
    const finished = api.ask;
    api.ask = async function* (params): AsyncGenerator<StreamEvent, void> {
      yield {
        type: 'sources',
        sources: [source],
        citations: [],
        markers: [{ marker: '1', chunkId: 'c1', documentId: '42' }],
      };
      yield* finished(params);
    };
    draw(state('sources-only').layout, api);
    await send();
    // Finished: the text is there, however a footnote splits it, and no longer being written.
    await waitFor(() => {
      expect(document.body.textContent).toContain('Rapporteringen er fast');
      expect(document.querySelector('.uib-answer-writing')).toBeNull();
    });
    expect(footnotes()).toEqual([]);
  });

  it('draws no footnote for a streamed answer without markers: `[1]` then names a document', async () => {
    draw(state('sources-only').layout, fakeApi().api);
    await ask();
    // The fake's sources come with the end of the answer.
    expect((await screen.findAllByText('Tildelingsbrev 2022')).length).toBeGreaterThan(0);
    expect(footnotes()).toEqual([]);
  });

  it('pairs each footnote of a streamed answer with its excerpt, from genki’s stream through @genai/client', async () => {
    // What a service that cites excerpts streams: one document, two excerpts, a marker each.
    const frames = [
      { id: 'a1', choices: [{ delta: { content: 'Rapporteringen er fast [1] og årlig [2].' } }] },
      {
        id: 'a1',
        sources: [
          {
            index: 1,
            title: 'Tildelingsbrev 2022',
            document_id: '42',
            excerpts: [
              {
                chunk_id: 'c1',
                text: 'Rapporteringen skjer hvert år.',
                position: 0,
                markers: ['1'],
              },
              { chunk_id: 'c2', text: 'Fristen er 15. mars.', position: 1, markers: ['2'] },
            ],
            markers: ['1', '2'],
          },
        ],
        markers: [
          { marker: '1', chunk_id: 'c1', document: '42' },
          { marker: '2', chunk_id: 'c2', document: '42' },
        ],
      },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/conversations')
          ? Response.json({ conversation: { id: 't1' } })
          : new Response(
              [...frames.map((f) => JSON.stringify(f)), '[DONE]']
                .map((f) => `data: ${f}\n\n`)
                .join(''),
              { headers: { 'content-type': 'text/event-stream' } },
            ),
      ),
    );
    try {
      const { api } = fakeApi();
      api.ask = createGenkiApi({ baseUrl: '/genki', tenant: 'digdir' }).ask;
      draw(state('sources-only').layout, api);
      await send();
      await waitFor(() =>
        expect(footnotes().map((mark) => mark.getAttribute('aria-label')?.slice(0, 9))).toEqual([
          'Utdrag 1:',
          'Utdrag 2:',
        ]),
      );
      // Each numbered excerpt in Kilder leads back to its own footnote.
      const backLinks = [...document.querySelectorAll('a')]
        .map((link) => link.getAttribute('aria-label') ?? link.textContent ?? '')
        .filter((name) => /fotnote \d/.test(name));
      expect(backLinks).toEqual(['1: fotnote 1 i svaret', '1: fotnote 2 i svaret']);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  // One document whose two excerpts are from different sections, each with its heading.
  const headedSource = {
    index: 1,
    title: 'Tildelingsbrev 2022',
    document_id: '42',
    excerpts: [
      { chunk_id: 'c1', text: 'Rapporteringen skjer hvert år.', heading: '1 Innledning' },
      { chunk_id: 'c2', text: 'Fristen er 15. mars.', heading: '3 Styringsparametere › 3.2 Mål' },
    ],
  };
  const sections = async () => {
    const kilder = await screen.findByRole('complementary', { name: 'Kilder', hidden: true });
    await within(kilder).findAllByText('Tildelingsbrev 2022');
    return ['1 Innledning', '3.2 Mål'].map((s) => within(kilder).queryAllByText(s).length > 0);
  };

  it("shows each excerpt's heading in Kilder for an answer streamed through @genai/client", async () => {
    const frames = [
      { id: 'a1', choices: [{ delta: { content: 'Rapporteringen er fast [1].' } }] },
      { id: 'a1', sources: [headedSource] },
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.endsWith('/api/conversations')
          ? Response.json({ conversation: { id: 't1' } })
          : new Response(
              [...frames.map((f) => JSON.stringify(f)), '[DONE]']
                .map((f) => `data: ${f}\n\n`)
                .join(''),
              { headers: { 'content-type': 'text/event-stream' } },
            ),
      ),
    );
    try {
      const { api } = fakeApi();
      api.ask = createGenkiApi({ baseUrl: '/genki', tenant: 'digdir' }).ask;
      draw(state('sources-only').layout, api);
      await send();
      expect(await sections()).toEqual([true, true]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("shows a stored excerpt's heading after a reload", async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          conversation: { id: 't-old', topic: 'En gammel tråd', tags: [], created: 1 },
          messages: [
            { id: 'q', role: 'user', text: 'Hva er fast?', created: 1, chunks: [] },
            {
              id: 'a',
              role: 'assistant',
              text: 'Rapporteringen er fast [1].',
              created: 2,
              chunks: [],
              sources: [headedSource],
            },
          ],
        }),
      ),
    );
    try {
      const { api } = fakeApi();
      api.loadThread = createGenkiApi({ baseUrl: '/genki', tenant: 'digdir' }).loadThread;
      history.replaceState(null, '', '/?t=t-old');
      draw(state('sources-only').layout, api, true);
      expect(await sections()).toEqual([true, true]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws each footnote of a reloaded chunks-only answer at the excerpt its stored marker names', async () => {
    const chunk = (chunkId: string, docTitle: string, docNum: string, contentMarkdown: string) => ({
      chunkId,
      docTitle,
      docNum,
      contentMarkdown,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          conversation: { id: 't-old', topic: 'Ansatte', tags: [], created: 1 },
          messages: [
            { id: 'q', role: 'user', text: 'Hvor mange ansatte?', created: 1, chunks: [] },
            {
              id: 'a',
              role: 'assistant',
              text: 'I 2022 var det 169 ansatte [1], i 2020 var lønnen 153 mill. [2].',
              created: 2,
              chunks: [
                chunk('c1', 'Årsrapport 2020', 'd20', 'Lønn var 153 mill.'),
                chunk('c2', 'Årsrapport 2020', 'd20', '176 ansatte.'),
                chunk('c3', 'Årsrapport 2022', 'd22', '169 ansatte.'),
              ],
              markers: [
                { marker: '1', chunk_id: 'c3', document: 'd22' },
                { marker: '2', chunk_id: 'c1', document: 'd20' },
              ],
            },
          ],
        }),
      ),
    );
    try {
      const { api } = fakeApi();
      api.loadThread = createGenkiApi({ baseUrl: '/genki', tenant: 'digdir' }).loadThread;
      history.replaceState(null, '', '/?t=t-old');
      draw(state('sources-only').layout, api, true);
      await waitFor(() =>
        expect(footnotes().map((mark) => mark.getAttribute('aria-label'))).toEqual([
          'Utdrag 1: Årsrapport 2022',
          'Utdrag 2: Årsrapport 2020',
        ]),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('draws no footnote of a reloaded chunks-only answer without markers at the excerpt in its place', async () => {
    const chunk = (chunkId: string, docTitle: string, docNum: string) => ({
      chunkId,
      docTitle,
      docNum,
      contentMarkdown: `${docTitle}.`,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          conversation: { id: 't-old', topic: 'Ansatte', tags: [], created: 1 },
          messages: [
            { id: 'q', role: 'user', text: 'Hvor mange ansatte?', created: 1, chunks: [] },
            {
              id: 'a',
              role: 'assistant',
              text: 'I 2020 var lønnen 153 mill. [1], i 2022 var det 169 ansatte [2].',
              created: 2,
              chunks: [
                chunk('c1', 'Årsrapport 2020', 'd20'),
                chunk('c2', 'Årsrapport 2020', 'd20'),
                chunk('c3', 'Årsrapport 2022', 'd22'),
              ],
            },
          ],
        }),
      ),
    );
    try {
      const { api } = fakeApi();
      api.loadThread = createGenkiApi({ baseUrl: '/genki', tenant: 'digdir' }).loadThread;
      history.replaceState(null, '', '/?t=t-old');
      draw(state('sources-only').layout, api, true);
      const kilder = await screen.findByRole('complementary', { name: 'Kilder', hidden: true });
      await within(kilder).findAllByText('Årsrapport 2022');
      expect(footnotes()).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('shows no footnotes without Kilder: a footnote never points nowhere', async () => {
    await stored(state('without-secondary').layout);
    expect(footnotes()).toEqual([]);
    expect(screen.queryByText(/\[1\]/)).toBeNull();
    expect(screen.queryByText('Kilder brukt i svaret')).toBeNull();
  });

  it('shows no footnotes when Chat’s Fotnoter is turned off, though Kilder is there', async () => {
    const layout = state('sources-only').layout;
    await stored({
      ...layout,
      zones: { ...layout.zones, main: [{ block: 'chat', settings: { footnotes: false } }] },
    });
    expect(footnotes()).toEqual([]);
  });

  it('narrows nothing and asks for no facets without Filter', async () => {
    const { api, asked } = fakeApi();
    draw(state('without-filter').layout, api);
    await ask();
    expect(asked[0]?.filters).toBeUndefined();
    expect(api.loadFacets).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Filtrering' })).toBeNull();
  });

  it('puts Filter in the main column as a strip with «Endre» that opens the filter', async () => {
    const { api } = fakeApi();
    draw(placeIn(state('sources-only'), 'filter', 'main').layout, api);
    const change = await screen.findByRole('button', { name: 'Endre' });
    expect(screen.queryByRole('heading', { name: 'Filtrering' })).toBeNull();
    fireEvent.click(change);
    expect(await screen.findByRole('heading', { name: 'Filtrering' })).toBeTruthy();
  });

  it('keeps the thread in the address with Tråder, and starts afresh on a reload without', async () => {
    const withThreads = fakeApi();
    draw(state('approach-only').layout, withThreads.api, true);
    await ask();
    expect(new URLSearchParams(location.search).get('t')).toBe('t-new');
    cleanup();
    history.replaceState(null, '', '/');
    const without = fakeApi();
    draw(state('chat-only').layout, without.api, true);
    await ask();
    expect(location.search).toBe('');
    expect(without.api.loadThreads).not.toHaveBeenCalled();
  });

  it('opens a thread from `?t=` only when its id looks like one genki makes', async () => {
    for (const id of ['..%2F..%2Fapi%2Fdatasets', '..', '.', 'a%2Fb', 'a%5Cb', 'a%3Fb', 'a.b']) {
      history.replaceState(null, '', `/?t=${id}`);
      const { api } = fakeApi();
      const { unmount } = draw(state('approach-only').layout, api, true);
      await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
      expect(api.loadThread, id).not.toHaveBeenCalled();
      unmount();
    }
    for (const id of ['V1StGXR8_Z5jdHi6B-myT', '0b6f0a3e-6c1e-4a8e-9f3b-2d4c5e6f7a8b', 't-old']) {
      history.replaceState(null, '', `/?t=${id}`);
      const { api } = fakeApi();
      const { unmount } = draw(state('approach-only').layout, api, true);
      await waitFor(() => expect(api.loadThread).toHaveBeenCalledWith(id));
      unmount();
    }
  });

  // The secondary panel starts folded, as in kunnskapsassistenten, so its tools are hidden.
  const tools = () => document.querySelector<HTMLElement>('.uib-shell-tools');

  it('gives the secondary panel a heading for one tool and tabs for two', async () => {
    const { api } = fakeApi();
    const { unmount } = draw(state('approach-only').layout, api);
    await waitFor(() => expect(tools()?.dataset.mode).toBe('heading'));
    expect(screen.getByRole('heading', { name: 'Fremgangsmåte', hidden: true })).toBeTruthy();
    unmount();
    draw(turnOn(state('approach-only'), 'sources').layout, api);
    await waitFor(() => expect(tools()?.dataset.mode).toBe('tabs'));
    const tabs = screen.getAllByRole('tab', { hidden: true });
    expect(tabs.map((tab) => tab.textContent)).toEqual(['Fremgangsmåte', 'Kilder']);
  });

  it('offers three tools in a dropdown, in the order Fremgangsmåte, Chat, Kilder', async () => {
    const three = placeIn(
      placeIn(state('sources-only'), 'approach', 'secondary'),
      'chat',
      'secondary',
    );
    draw(three.layout, fakeApi().api);
    await waitFor(() => expect(tools()?.dataset.mode).toBe('dropdown'));
    const options = [...document.querySelectorAll('.uib-shell-tools-choice option')].map(
      (o) => o.textContent,
    );
    expect(options).toEqual(['Fremgangsmåte', 'Chat', 'Kilder']);
  });

  it('opens Kilder on its tool when a footnote is followed', async () => {
    await stored(turnOn(state('approach-only'), 'sources').layout);
    const tab = (name: string) => screen.getByRole('tab', { name, hidden: true });
    expect(tab('Fremgangsmåte').getAttribute('aria-selected')).toBe('true');
    const [first] = footnotes();
    if (!first) throw new Error('no footnote');
    fireEvent.click(first);
    await waitFor(() => expect(tab('Kilder').getAttribute('aria-selected')).toBe('true'));
  });

  it('offers no variant picker when the service has one variant', async () => {
    draw(state('knowledge-assistant').layout, fakeApi().api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(screen.queryByRole('button', { name: /variant/i })).toBeNull();
  });

  it('names the service over its variants in the picker, from the platform’s service title', async () => {
    const { api } = fakeApi();
    api.loadModels = vi.fn(async (): Promise<ModelRow[]> => [
      { ...rows[0], id: 'ka__default', _variant_title: 'Svar med kilder' },
      { ...rows[0], id: 'ka__fast', _variant_title: 'Rask' },
    ]);
    draw(state('knowledge-assistant').layout, api);
    const list = await screen.findByRole('list', { name: 'KA', hidden: true });
    expect(
      within(list)
        .getAllByRole('button', { hidden: true })
        .map((button) => button.textContent),
    ).toEqual(['Svar med kilder', 'Rask']);
  });

  it('lists the threads only with Tråder, and only the service’s own', async () => {
    const { api } = fakeApi();
    const { unmount } = draw(state('without-filter').layout, api);
    expect(await screen.findByRole('link', { name: /En gammel tråd/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /En annen tjenestes tråd/ })).toBeNull();
    unmount();
    const without = fakeApi().api;
    draw(state('chat-only').layout, without);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(screen.queryByRole('link', { name: /En gammel tråd/ })).toBeNull();
    expect(without.loadThreads).not.toHaveBeenCalled();
  });

  it('lists every thread the key can read with `allThreads`, of any service', async () => {
    const { api } = fakeApi();
    render(
      <Assistant
        api={api}
        layout={state('without-filter').layout}
        service="ka"
        tenant="digdir"
        allThreads
      />,
    );
    expect(await screen.findByRole('link', { name: /En annen tjenestes tråd/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: /En gammel tråd/ })).toBeTruthy();
  });
});

// kunnskapsassistenten's own arrangement, as the UI blocks preview draws it: its template.
describe('the assistant with kunnskapsassistenten’s choices', () => {
  const kaLayout = fromTemplate('knowledge-assistant').layout;
  const memory = () => {
    const kept = new Map<string, unknown>();
    const storage: AssistantStorage = {
      read: (key) => kept.get(key),
      write: (key, value) => void kept.set(key, value),
      remove: (key) => void kept.delete(key),
    };
    return { kept, storage };
  };
  const hostSignOut = vi.fn();
  const profile: AssistantProfile = {
    assistantName: 'KA',
    signedInAs: 'Testidentitet: test',
    signOut: { href: '/auth/logout', onSignOut: hostSignOut },
    settingsNote: 'Valgene huskes i denne nettleseren.',
    experiments: [
      { id: 'year-ranges', title: 'Årsfilter med perioder' },
      { id: 'filters-right-panel', title: 'Filtreringen i høyre panel' },
    ],
  };
  const drawKa = (storage: AssistantStorage, layout = kaLayout, api = fakeApi().api) =>
    render(
      <Assistant
        api={api}
        layout={layout}
        service="ka"
        tenant="digdir"
        profile={profile}
        storage={storage}
        threadInUrl
      />,
    );

  it('keeps Kilder’s own heading when it is the secondary panel’s only tool', async () => {
    drawKa(memory().storage);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(document.querySelector('.uib-shell-tools')).toBeNull();
    expect(screen.getByRole('complementary', { name: 'Kilder', hidden: true })).toBeTruthy();
  });

  it('offers the profile’s experiments in «Innstillinger», with its note, and keeps the choice', async () => {
    const { kept, storage } = memory();
    drawKa(storage);
    fireEvent.click(await screen.findByRole('link', { name: 'Innstillinger' }));
    expect(location.hash).toBe('#innstillinger');
    expect(await screen.findByText('Valgene huskes i denne nettleseren.')).toBeTruthy();
    const trial = screen.getByRole('switch', { name: /Årsfilter med perioder/ });
    fireEvent.click(trial);
    expect(kept.get('flags')).toEqual(['year-ranges']);
  });

  it('does not count a field with every value chosen as narrowing, under the answer or in the strip', async () => {
    const both = () => {
      const { api } = fakeApi();
      api.loadFacets = vi.fn(twoTypes);
      const { storage } = memory();
      storage.write('filter', { type: ['Årsrapport', 'Tildelingsbrev'] });
      return { api, storage };
    };
    // The field's one chip, «Alle dokumenttyper», once the facets are in.
    const shown = () => screen.findByText(/Alle dokumenttyper/);
    const ka = both();
    const { unmount } = drawKa(ka.storage, kaLayout, ka.api);
    await shown();
    await ask();
    expect(screen.queryByText(/Avgrenset til/)).toBeNull();
    unmount();
    const strip = both();
    drawKa(strip.storage, placeIn(state('sources-only'), 'filter', 'main').layout, strip.api);
    fireEvent.click(await screen.findByRole('button', { name: 'Endre' }));
    await shown();
    expect(document.querySelector('.uia-filter-strip')?.textContent).not.toMatch(/Avgrenset til/);
  });

  it('names chosen years as periods, under the answer and in the strip', async () => {
    const years = () => {
      const { api } = fakeApi();
      api.loadFields = vi.fn(async () => [{ id: 'year', label: 'År', kind: 'year' as const }]);
      api.loadFacets = vi.fn(async () => [
        {
          id: 'year',
          label: 'År',
          kind: 'year' as const,
          options: Array.from({ length: 8 }, (_, i) => ({ value: String(2018 + i), count: 1 })),
        },
      ]);
      const { storage } = memory();
      storage.write('filter', { year: ['2020', '2021', '2022', '2025'] });
      return { api, storage };
    };
    const ka = years();
    const { unmount } = drawKa(ka.storage, kaLayout, ka.api);
    await waitFor(() => expect(ka.api.loadFacets).toHaveBeenCalled());
    await act(async () => {});
    await ask();
    expect(screen.getByText('Avgrenset til: 2020–2022 · 2025')).toBeTruthy();
    unmount();
    const strip = years();
    drawKa(strip.storage, placeIn(state('sources-only'), 'filter', 'main').layout, strip.api);
    await waitFor(() =>
      expect(document.querySelector('.uia-filter-strip')?.textContent).toContain(
        'Avgrenset til: 2020–2022 · 2025',
      ),
    );
  });

  it('puts the filter over Kilder with the trial «filters-right-panel», and only threads on the left', async () => {
    const { storage } = memory();
    storage.write('flags', ['filters-right-panel']);
    drawKa(storage);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(screen.getByRole('navigation', { name: 'Tråder' })).toBeTruthy();
    expect(
      screen.getByRole('complementary', { name: 'Filter og kilder', hidden: true }),
    ).toBeTruthy();
  });

  it('keeps the filter, and forgets it, the trials, the collection and the threads’ filters on «Logg ut», which goes to the host’s sign-out', async () => {
    const { kept, storage } = memory();
    storage.write('filter', { type: ['Årsrapport'], bad: [1] });
    storage.write('flags', ['year-ranges']);
    storage.write('corpus', 'kudos');
    storage.write('threadFilters', { 't-old': { type: ['Årsrapport'] } });
    const { api } = fakeApi();
    api.loadFacets = vi.fn(twoTypes);
    drawKa(storage, kaLayout, api);
    // Kept: the facets are asked for the stored filter, without the field that is not all strings.
    await waitFor(() =>
      expect(api.loadFacets).toHaveBeenCalledWith(
        { type: ['Årsrapport'] },
        'kudos',
        expect.anything(),
        expect.anything(),
      ),
    );
    fireEvent.click(await screen.findByRole('button', { name: /Tråder/ }));
    const signOut = await screen.findByRole('link', { name: 'Logg ut' });
    expect(signOut.getAttribute('href')).toBe('/auth/logout');
    signOut.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(signOut);
    expect([...kept.keys()]).toEqual([]);
    expect(hostSignOut).toHaveBeenCalled();
  });

  it('says who is signed in, with no «Logg ut», when the host gives no sign-out', async () => {
    render(
      <Assistant
        api={fakeApi().api}
        layout={kaLayout}
        service="ka"
        tenant="digdir"
        profile={{ ...profile, signOut: undefined }}
        storage={memory().storage}
        threadInUrl
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Tråder/ }));
    expect(await screen.findByText('Testidentitet: test')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Logg ut' })).toBeNull();
  });

  // A host that is only the assistant: a path per page, as the UI blocks preview has them.
  const paths = { home: '/', settings: '/innstillinger' };
  const drawWithPaths = () =>
    render(
      <Assistant
        api={fakeApi().api}
        layout={kaLayout}
        service="ka"
        tenant="digdir"
        profile={profile}
        threadInUrl
        paths={paths}
      />,
    );

  it('gives «Innstillinger» its own path with `paths`, and a thread the home path with only `?t=`', async () => {
    history.replaceState(null, '', '/?model=ka__default');
    drawWithPaths();
    const settings = await screen.findByRole('link', { name: 'Innstillinger' });
    expect(settings.getAttribute('href')).toBe('/innstillinger');
    fireEvent.click(settings);
    expect(`${location.pathname}${location.search}${location.hash}`).toBe('/innstillinger');
    expect(await screen.findByRole('heading', { level: 1, name: 'Innstillinger' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Tråder/ }));
    const thread = await screen.findByRole('link', { name: /En gammel tråd/ });
    expect(thread.getAttribute('href')).toBe('/?t=t-old');
    fireEvent.click(thread);
    expect(`${location.pathname}${location.search}`).toBe('/?t=t-old');
    expect(screen.queryByRole('heading', { level: 1, name: 'Innstillinger' })).toBeNull();
  });

  it('opens «Innstillinger» when the page is opened at its path with `paths`', async () => {
    history.replaceState(null, '', '/innstillinger');
    drawWithPaths();
    expect(await screen.findByRole('heading', { level: 1, name: 'Innstillinger' })).toBeTruthy();
  });

  it('keeps «Innstillinger» at `#innstillinger` without `paths`, and the rest of the host’s address', async () => {
    history.replaceState(null, '', '/prov?layout=abc');
    drawKa(memory().storage);
    const settings = await screen.findByRole('link', { name: 'Innstillinger' });
    expect(settings.getAttribute('href')).toBe('#innstillinger');
    fireEvent.click(settings);
    expect(`${location.pathname}${location.search}${location.hash}`).toBe(
      '/prov?layout=abc#innstillinger',
    );
    fireEvent.click(screen.getByRole('button', { name: /Tråder/ }));
    const thread = await screen.findByRole('link', { name: /En gammel tråd/ });
    expect(thread.getAttribute('href')).toBe('/prov?layout=abc&t=t-old');
  });

  it('reads and writes the choices as JSON under the host’s prefix, so the keys it already has carry over', async () => {
    localStorage.clear();
    localStorage.setItem('preview.filter', JSON.stringify({ type: ['Årsrapport'] }));
    localStorage.setItem('preview.flags', JSON.stringify(['filters-right-panel']));
    const { api } = fakeApi();
    api.loadFacets = vi.fn(twoTypes);
    render(
      <Assistant
        api={api}
        layout={kaLayout}
        service="ka"
        tenant="digdir"
        profile={profile}
        storage={browserStorage('preview.')}
        threadInUrl
      />,
    );
    await waitFor(() =>
      expect(api.loadFacets).toHaveBeenCalledWith(
        { type: ['Årsrapport'] },
        'kudos',
        expect.anything(),
        expect.anything(),
      ),
    );
    expect(
      screen.getByRole('complementary', { name: 'Filter og kilder', hidden: true }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Innstillinger' }));
    fireEvent.click(await screen.findByRole('switch', { name: /Årsfilter med perioder/ }));
    expect(JSON.parse(localStorage.getItem('preview.flags') ?? 'null')).toEqual([
      'filters-right-panel',
      'year-ranges',
    ]);
    localStorage.clear();
  });

  it('says so when a new collection starts a new thread', async () => {
    const notices: string[] = [];
    render(
      <Assistant
        api={fakeApi().api}
        layout={kaLayout}
        service="ka"
        tenant="digdir"
        profile={profile}
        onNotice={(text) => notices.push(text)}
      />,
    );
    const choice = await screen.findByRole('combobox', { name: 'Dokumentsamling' });
    fireEvent.change(choice, { target: { value: 'genki-docs' } });
    expect(notices).toEqual([
      'Byttet til GenKI-dokumentasjon. Du har fått en ny tråd, og filteret er tømt.',
    ]);
  });
});

// The «_Ready for dev» boards' frame (dev-navbar, dev-innstillinger-0-start), behind its template.
describe('kunnskapsassistenten’s next look, `knowledge-assistant-next`', () => {
  const nextLayout = fromTemplate('knowledge-assistant-next').layout;
  const reader: AssistantProfile = {
    assistantName: 'KA',
    signedInAs: 'Kari Marie Nordmann',
    organisation: 'Digitaliseringsdirektoratet',
    signOut: { href: '/auth/logout' },
  };
  const drawNext = (profile: AssistantProfile = reader, layout = nextLayout) =>
    render(
      <Assistant
        api={fakeApi().api}
        layout={layout}
        service="ka"
        tenant="digdir"
        profile={profile}
        threadInUrl
      />,
    );
  const opened = async () => screen.findByRole('textbox', { name: /Spørsmål til KA/ });
  const menu = () => document.querySelector<HTMLElement>('.uib-shell-profile-menu');
  const entries = () =>
    [...(menu()?.querySelectorAll('li .uib-shell-profile-label') ?? [])].map((e) => e.textContent);

  it('draws the cards frame, with no top bar, and lands on «Tråder», titled so, not on the filter', async () => {
    drawNext();
    await opened();
    expect(document.querySelector('.uib-shell')?.getAttribute('data-frame')).toBe('cards');
    const nav = screen.getByRole('navigation', { name: 'Tråder og filter' });
    expect(within(nav).getByRole('heading', { level: 2, name: 'Tråder' })).toBeTruthy();
    expect(within(nav).getByRole('link', { name: 'Ny tråd' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Kunnskapsassistenten' })).toBeNull();
  });

  it('titles the tool panel «Verktøy» over Fremgangsmåte and Kilder as two joined buttons (dev-verktoy-2)', async () => {
    drawNext();
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Vis verktøypanelet' }));
    const tools = screen.getByRole('complementary', { name: 'Verktøypanelet' });
    expect(
      within(tools)
        .getAllByRole('heading')
        .map((h) => `${h.tagName} ${h.textContent}`),
    ).toEqual(['H2 Verktøy']);
    const tablist = within(tools).getByRole('tablist', { name: 'Verktøy' });
    expect(tablist.getAttribute('data-variant')).toBe('tinted');
    expect(
      within(tablist)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Fremgangsmåte', 'Kilder']);
    // Each with its icon, as the board draws them.
    expect(
      within(tablist)
        .getAllByRole('tab')
        .every((tab) => tab.querySelector('svg')),
    ).toBe(true);
  });

  it('makes one tool’s name the panel’s title, with no switcher (dev-verktoy-1)', async () => {
    drawNext(reader, {
      ...nextLayout,
      zones: { ...nextLayout.zones, secondary: [{ block: 'approach' }] },
    });
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Vis verktøypanelet' }));
    const tools = screen.getByRole('complementary', { name: 'Verktøypanelet' });
    expect(within(tools).getByRole('heading', { level: 2 }).textContent).toBe('Fremgangsmåte');
    expect(within(tools).queryByRole('tablist')).toBeNull();
    expect(within(tools).queryByRole('button', { name: /velg verktøy/ })).toBeNull();
  });

  it('offers three tools in a tinted button that opens a menu of them (dev-verktoy-3)', async () => {
    drawNext(reader, {
      ...nextLayout,
      zones: {
        ...nextLayout.zones,
        secondary: [...nextLayout.zones.secondary, { block: 'document-view' }],
      },
    });
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Vis verktøypanelet' }));
    const tools = screen.getByRole('complementary', { name: 'Verktøypanelet' });
    const trigger = within(tools).getByRole('button', { name: 'Fremgangsmåte, velg verktøy' });
    expect(trigger.className).toContain('uib-shell-tools-trigger');
    const menu = document.querySelector<HTMLElement>('.uib-shell-tools-menu');
    expect([...(menu?.querySelectorAll('button') ?? [])].map((b) => b.textContent)).toEqual([
      'Fremgangsmåte',
      'Kilder',
      'Dokumentvisning',
    ]);
    const kilder = [...(menu?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'Kilder',
    );
    if (!kilder) throw new Error('Kilder is not in the menu');
    fireEvent.click(kilder);
    expect(within(tools).getByRole('button', { name: 'Kilder, velg verktøy' })).toBeTruthy();
  });

  it('folds the tool panel to its button alone, with no tool icons (dev-verktoy-4)', async () => {
    drawNext();
    await opened();
    const tools = screen.getByRole('complementary', { name: 'Verktøypanelet' });
    expect(tools.querySelector('.uib-shell-rail')).toBeNull();
    expect(
      within(tools)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Vis verktøypanelet']);
  });

  it('folds the threads’ panel to its button and «Ny tråd», with no avatar (dev-navbar)', async () => {
    drawNext();
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Skjul tråder og filter' }));
    const nav = screen.getByRole('navigation', { name: 'Tråder og filter' });
    const rail = nav.querySelector<HTMLElement>('.uib-shell-rail');
    if (!rail) throw new Error('The folded panel has no rail');
    expect(within(rail).getByRole('link', { name: 'Ny tråd' }).getAttribute('href')).toBe('/');
    expect(nav.querySelector('.uib-shell-rail-foot')).toBeNull();
    expect(within(nav).queryByRole('button', { name: 'Kari Marie Nordmann' })).toBeNull();
    expect(
      within(nav)
        .getAllByRole('button')
        .map((b) => b.getAttribute('aria-label')),
    ).toEqual(['Vis tråder og filter']);
  });

  it('starts a new thread from «Ny tråd» on the folded threads’ panel', async () => {
    drawNext();
    fireEvent.click(await screen.findByRole('link', { name: 'En gammel tråd' }));
    await screen.findByRole('heading', { level: 1, name: 'En gammel tråd' });
    fireEvent.click(screen.getByRole('button', { name: 'Skjul tråder og filter' }));
    const rail = document.querySelector<HTMLElement>('.uib-shell-rail');
    fireEvent.click(within(rail as HTMLElement).getByRole('link', { name: 'Ny tråd' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Ny tråd' })).toBeTruthy();
    expect(location.search).toBe('');
  });

  it('leaves a click for a new tab on the rail’s «Ny tråd» to the browser', async () => {
    drawNext();
    fireEvent.click(await screen.findByRole('link', { name: 'En gammel tråd' }));
    await screen.findByRole('heading', { level: 1, name: 'En gammel tråd' });
    fireEvent.click(screen.getByRole('button', { name: 'Skjul tråder og filter' }));
    const rail = document.querySelector<HTMLElement>('.uib-shell-rail');
    const link = within(rail as HTMLElement).getByRole('link', { name: 'Ny tråd' });
    // Records whether the page took each click; `stay` then keeps jsdom from following the link.
    const taken: boolean[] = [];
    const record = (event: Event) => taken.push(event.defaultPrevented);
    const stay = (event: Event) => event.preventDefault();
    document.body.addEventListener('click', record);
    document.addEventListener('click', stay);
    onTestFinished(() => {
      document.body.removeEventListener('click', record);
      document.removeEventListener('click', stay);
    });
    for (const init of [
      { metaKey: true },
      { ctrlKey: true },
      { shiftKey: true },
      { altKey: true },
      { button: 1 },
    ])
      fireEvent.click(link, init);
    expect(taken).toEqual([false, false, false, false, false]);
    expect(location.search).toBe('?t=t-old');
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('En gammel tråd');
  });

  it('gives Kilder Aksel’s FileSearch icon in the switcher (dev-verktoy-2)', async () => {
    drawNext();
    await opened();
    fireEvent.click(screen.getByRole('button', { name: 'Vis verktøypanelet' }));
    const tab = within(screen.getByRole('tablist', { name: 'Verktøy' })).getByRole('tab', {
      name: 'Kilder',
    });
    const drawn = render(<FileSearchIcon aria-hidden />).container.querySelector('svg');
    expect(tab.querySelector('svg')?.innerHTML).toBe(drawn?.innerHTML);
  });

  it('draws the answer with no name over it (dev-kilder-hoyre)', async () => {
    drawNext();
    await ask();
    expect(document.querySelector('.uib-answer')?.hasAttribute('data-plain')).toBe(true);
    expect(document.querySelector('.uib-conversation-label')).toBeNull();
  });

  it('draws the footnote marks 16 px tall, through --genai-answer-footnote-size (dev-kilder-hoyre)', async () => {
    drawNext();
    await opened();
    expect(
      document
        .querySelector<HTMLElement>('.uia-chat')
        ?.style.getPropertyValue('--genai-answer-footnote-size'),
    ).toBe('var(--ds-size-4)');
  });

  it('lists the steps of a question asked here in «Fremgangsmåte», each with its mark', async () => {
    drawNext();
    await ask();
    // The sources may have opened it already.
    const show = screen.queryByRole('button', { name: 'Vis verktøypanelet' });
    if (show) fireEvent.click(show);
    const tools = screen.getByRole('complementary', { name: 'Verktøypanelet' });
    fireEvent.click(within(tools).getByRole('tab', { name: 'Fremgangsmåte' }));
    const panel = within(tools).getByRole('tabpanel', { name: 'Fremgangsmåte' });
    expect(within(panel).getByText('Slik jobbet assistenten med svaret')).toBeTruthy();
    const steps = within(panel).getByRole('list', { name: 'Fremgangsmåte' });
    expect(
      within(steps)
        .getAllByRole('listitem')
        .map((step) => step.getAttribute('data-status')),
    ).toEqual(['done', 'done']);
  });

  it('makes the thread’s title the page’s one h1, «Ny tråd» before, the thread’s own after', async () => {
    drawNext();
    await opened();
    const h1 = () => screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent);
    expect(h1()).toEqual(['Ny tråd']);
    fireEvent.click(await screen.findByRole('link', { name: /En gammel tråd/ }));
    await waitFor(() =>
      expect(document.querySelector('.uib-answer')?.textContent).toContain(
        'Rapporteringen er fast',
      ),
    );
    expect(h1()).toEqual(['En gammel tråd']);
    // Named once: the conversation draws no title of its own under it.
    expect(screen.getAllByRole('heading', { name: 'En gammel tråd' })).toHaveLength(1);
  });

  it('puts the reader at the panel’s foot, pinned, in place of «Innlogget som» and the links', async () => {
    drawNext();
    await opened();
    const nav = screen.getByRole('navigation', { name: 'Tråder og filter' });
    const button = within(nav).getByRole('button', { name: 'Kari Marie Nordmann' });
    expect(button.closest('.uib-shell-foot')?.parentElement?.classList).toContain('uib-shell-box');
    expect(document.querySelector('.uib-threads-signed-in')).toBeNull();
    expect(document.querySelector('.uib-settings-links')).toBeNull();
  });

  it('offers «Innstillinger» and «Logg ut» in the menu, with the reader’s organisation, and no page the host does not give', async () => {
    drawNext();
    await opened();
    expect(entries()).toEqual(['Innstillinger', 'Logg ut']);
    expect(menu()?.querySelector('a[href="/auth/logout"]')?.textContent).toContain('Logg ut');
    expect(menu()?.querySelector('.uib-shell-profile-who')?.textContent).toContain(
      'Digitaliseringsdirektoratet',
    );
    expect(menu()?.querySelector('.uib-shell-profile-news')).toBeNull();
  });

  it('leaves «Logg ut» out of the menu when the host gives no sign-out', async () => {
    drawNext({ ...reader, signOut: undefined });
    await opened();
    expect(entries()).toEqual(['Innstillinger']);
  });

  it('offers the host’s pages from the profile, in the design’s order, with the dot only when it says so', async () => {
    drawNext({
      ...reader,
      menu: {
        changelog: { href: '/endringslogg', news: true },
        about: { href: '/om' },
        contact: { href: 'mailto:post@digdir.no', to: 'Digdir' },
      },
    });
    await opened();
    expect(entries()).toEqual([
      'Innstillinger',
      'Endringslogg',
      'Om tjenesten',
      'Kontakt Digdir',
      'Logg ut',
    ]);
    expect(menu()?.querySelector('.uib-shell-profile-news')).toBeTruthy();
  });

  it('adds the host’s own entries from the profile’s menu, before «Logg ut»', async () => {
    const back = vi.fn();
    drawNext({
      ...reader,
      menu: {
        about: { href: '/om' },
        extra: [
          { id: 'old', label: 'Tilbake til gammel versjon', href: '/gammel', onSelect: back },
        ],
      },
    });
    await opened();
    expect(entries()).toEqual([
      'Innstillinger',
      'Om tjenesten',
      'Tilbake til gammel versjon',
      'Logg ut',
    ]);
    fireEvent.click(
      within(menu() as HTMLElement).getByRole('link', {
        name: 'Tilbake til gammel versjon',
        hidden: true,
      }),
    );
    expect(back).toHaveBeenCalledTimes(1);
  });

  it('opens «Innstillinger» from the menu', async () => {
    drawNext();
    await opened();
    const settings = within(menu() as HTMLElement).getByRole('link', {
      name: 'Innstillinger',
      hidden: true,
    });
    fireEvent.click(settings);
    expect(location.hash).toBe('#innstillinger');
    // On «Generelt», the settings menu titled «Innstillinger» beside it (dev-innstillinger-0).
    expect(await screen.findByRole('heading', { level: 1, name: 'Generelt' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Innstillinger' })).toBeTruthy();
  });

  // dev-innstillinger-1 to -4: the primary panel is the settings menu, each page in the main card.
  describe('«Innstillinger»', () => {
    const settingsProfile: AssistantProfile = {
      ...reader,
      experiments: [
        { id: 'year-ranges', title: 'Årsfilter med perioder' },
        { id: 'compact-filter-chips', title: 'Samlede merkelapper i filteret' },
      ],
      menu: { feedback: { href: '/tilbakemelding' } },
    };
    const kept = new Map<string, unknown>();
    const storage: AssistantStorage = {
      read: (key) => kept.get(key),
      write: (key, value) => void kept.set(key, value),
      remove: (key) => void kept.delete(key),
    };
    const drawSettings = (onColorSchemeChange = vi.fn()) => {
      history.replaceState(null, '', '/#innstillinger');
      render(
        <Assistant
          api={fakeApi().api}
          layout={nextLayout}
          service="ka"
          tenant="digdir"
          profile={settingsProfile}
          storage={storage}
          threadInUrl
          colorScheme="dark"
          onColorSchemeChange={onColorSchemeChange}
        />,
      );
      return onColorSchemeChange;
    };
    const settingsNav = () => screen.getByRole('navigation', { name: 'Innstillinger' });
    const go = (name: RegExp) =>
      fireEvent.click(within(settingsNav()).getByRole('button', { name }));
    beforeEach(() => kept.clear());

    it('turns the primary panel into the settings menu, with no secondary panel, and Generelt in the main card', async () => {
      drawSettings();
      expect(await screen.findByRole('heading', { level: 1, name: 'Generelt' })).toBeTruthy();
      const nav = settingsNav();
      expect(within(nav).getByRole('heading', { level: 2, name: 'Innstillinger' })).toBeTruthy();
      expect(within(nav).getByRole('link', { name: 'Tilbake til trådene' })).toBeTruthy();
      const pages = within(within(nav).getByRole('list', { name: 'Sidene i innstillingene' }));
      expect(pages.getAllByRole('button').map((page) => page.getAttribute('aria-current'))).toEqual(
        ['page', null, null, null],
      );
      expect(screen.queryByRole('link', { name: 'Ny tråd' })).toBeNull();
      expect(document.querySelector('.uib-shell-side[data-side="secondary"]')).toBeNull();
      // The reader stays at the panel's foot.
      expect(within(nav).getByRole('button', { name: 'Kari Marie Nordmann' })).toBeTruthy();
    });

    it('draws the settings menu at the board’s 220 when opened from a thread, not as wide as the threads and their filter, and keeps no width for it', async () => {
      render(
        <Assistant
          api={fakeApi().api}
          layout={nextLayout}
          service="ka"
          tenant="digdir"
          profile={settingsProfile}
          storage={storage}
          threadInUrl
        />,
      );
      fireEvent.click(await screen.findByRole('link', { name: /En gammel tråd/ }));
      await screen.findByRole('heading', { level: 1, name: 'En gammel tråd' });
      const width = () =>
        document
          .querySelector<HTMLElement>('.uib-shell')
          ?.style.getPropertyValue('--uib-shell-primary-width');
      // The threads with the filter's panel in their card, 220 + 440 (dev-filter-panel).
      expect(width()).toBe('660px');
      fireEvent.click(
        within(menu() as HTMLElement).getByRole('link', { name: 'Innstillinger', hidden: true }),
      );
      expect(await screen.findByRole('heading', { level: 1, name: 'Generelt' })).toBeTruthy();
      // dev-innstillinger-1: the menu alone, 220 at 1720, with no filter column beside it.
      expect(width()).toBe('220px');
      expect(screen.queryByRole('region', { name: 'Filter for tråden' })).toBeNull();
      // The reader dragged nothing, so the host keeps no width for the next visit.
      expect((kept.get('layout') as { widths?: object } | undefined)?.widths ?? {}).toEqual({});
    });

    it('draws on «Generelt» only «Utseende», which the host keeps, and hands the choice to it', async () => {
      const onColorSchemeChange = drawSettings();
      const group = await screen.findByRole('group', { name: 'Utseende' });
      expect(within(group).getByRole<HTMLInputElement>('radio', { name: 'Mørkt' }).checked).toBe(
        true,
      );
      fireEvent.click(within(group).getByRole('radio', { name: 'Lyst' }));
      expect(onColorSchemeChange).toHaveBeenLastCalledWith('light');
      // What genki cannot honour yet is not drawn, nor the level no board has.
      for (const missing of ['Språk i svarene', 'Svarlengde', 'Tekststørrelse', 'Svar'])
        expect(screen.queryByText(missing)).toBeNull();
      expect(screen.getAllByRole('radio')).toHaveLength(3);
    });

    it('shows the reader from the sign-in on «Om deg», and says «Personvern og data» has nothing yet', async () => {
      drawSettings();
      await screen.findByRole('heading', { level: 1, name: 'Generelt' });
      go(/^Om deg/);
      expect(screen.getByRole('heading', { level: 1, name: 'Om deg' })).toBeTruthy();
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Navn' }).value).toBe(
        'Kari Marie Nordmann',
      );
      expect(screen.getByRole<HTMLInputElement>('textbox', { name: 'Virksomhet' }).readOnly).toBe(
        true,
      );
      go(/^Personvern og data/);
      expect(screen.getByRole('heading', { level: 1, name: 'Personvern og data' })).toBeTruthy();
      expect(screen.getByText('Ingen valg her ennå.')).toBeTruthy();
    });

    it('lists the profile’s trials on «Beta-funksjoner», counts those on in the menu, and turns them all off at once', async () => {
      kept.set('flags', ['year-ranges', 'compact-filter-chips']);
      drawSettings();
      await screen.findByRole('heading', { level: 1, name: 'Generelt' });
      go(/^Beta-funksjoner ?\(2 slått på\)$/);
      expect(document.querySelector('.uib-settings-count')?.textContent).toContain(
        '2 av 2 slått på',
      );
      expect(screen.getByRole('link', { name: 'Gi tilbakemelding' }).getAttribute('href')).toBe(
        '/tilbakemelding',
      );
      fireEvent.click(screen.getByRole('button', { name: 'Slå av alle' }));
      expect(kept.get('flags')).toEqual([]);
      expect(screen.getAllByRole<HTMLInputElement>('switch').map((one) => one.checked)).toEqual([
        false,
        false,
      ]);
      expect(within(settingsNav()).getByRole('button', { name: 'Beta-funksjoner' })).toBeTruthy();
    });

    it('goes back to the thread list and the panels with «Tilbake til trådene»', async () => {
      drawSettings();
      await screen.findByRole('heading', { level: 1, name: 'Generelt' });
      fireEvent.click(screen.getByRole('link', { name: 'Tilbake til trådene' }));
      expect(location.hash).toBe('');
      expect(await screen.findByRole('link', { name: 'Ny tråd' })).toBeTruthy();
      expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual([
        'Ny tråd',
      ]);
    });

    it('leaves «Kunnskapsassistenten»’s settings page as it was, one page with no menu', async () => {
      history.replaceState(null, '', '/#innstillinger');
      render(
        <Assistant
          api={fakeApi().api}
          layout={fromTemplate('knowledge-assistant').layout}
          service="ka"
          tenant="digdir"
          profile={settingsProfile}
          threadInUrl
        />,
      );
      expect(await screen.findByRole('heading', { level: 1, name: 'Innstillinger' })).toBeTruthy();
      expect(screen.getByRole('group', { name: 'Fargemodus' })).toBeTruthy();
      expect(screen.queryByRole('link', { name: 'Tilbake til trådene' })).toBeNull();
      expect(document.querySelector('.uib-settings-menu')).toBeNull();
    });
  });

  it('hides the greeting and the suggestions while the reader writes a question, and keeps the field’s focus', async () => {
    drawNext({ ...reader, suggestions: ['Hva er fast?'] });
    const field = await opened();
    const chat = document.querySelector<HTMLElement>('.uia-chat');
    const greeting = screen.getByRole('heading', { name: /Hva lurer du på/ });
    const suggestions = document.querySelector('.uia-suggestions');
    expect(greeting.closest('.uia-welcome')).not.toBeNull();
    expect(suggestions?.textContent).toContain('Hva er fast?');
    expect(chat?.hasAttribute('data-typing')).toBe(false);

    field.focus();
    fireEvent.change(field, { target: { value: 'H' } });
    // Hidden by the sheet, still in the page: nothing moves and nothing is announced.
    expect(chat?.getAttribute('data-typing')).toBe('true');
    expect(greeting.isConnected).toBe(true);
    expect(document.activeElement).toBe(field);

    fireEvent.change(field, { target: { value: '' } });
    expect(chat?.hasAttribute('data-typing')).toBe(false);
    expect(document.activeElement).toBe(field);

    // A picked suggestion fills the field and puts the caret there before the list is hidden.
    fireEvent.click(screen.getByRole('button', { name: 'Hva er fast?' }));
    expect(document.activeElement).toBe(field);
    expect(chat?.getAttribute('data-typing')).toBe('true');
  });

  it('leaves «Kunnskapsassistenten»’s front page as it was while the reader writes', async () => {
    render(
      <Assistant
        api={fakeApi().api}
        layout={fromTemplate('knowledge-assistant').layout}
        service="ka"
        tenant="digdir"
        profile={{ ...reader, suggestions: ['Hva er fast?'] }}
        threadInUrl
      />,
    );
    const field = await opened();
    fireEvent.change(field, { target: { value: 'H' } });
    expect(document.querySelector('.uia-chat')?.hasAttribute('data-typing')).toBe(false);
  });

  it('keeps the links in the foot when the host names no reader, so «Innstillinger» stays in reach', async () => {
    drawNext({ assistantName: 'KA' });
    await opened();
    expect(screen.queryByRole('button', { name: 'Kari Marie Nordmann' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Innstillinger' })).toBeTruthy();
  });

  it('stands the docked field on the main card’s ground, not the page’s', async () => {
    drawNext();
    await opened();
    expect(
      document
        .querySelector<HTMLElement>('.uia-chat')
        ?.style.getPropertyValue('--genai-composer-sticky-background'),
    ).toBe('var(--genai-shell-card-background, var(--ds-color-neutral-surface-default))');
  });

  it('offers no follow-up questions under an answer, which «Kunnskapsassistenten» still offers', async () => {
    const followUps = { ...reader, followUps: ['Kan du utdype?'] };
    const { unmount } = drawNext(followUps, fromTemplate('knowledge-assistant').layout);
    await ask();
    expect(await screen.findByRole('button', { name: 'Kan du utdype?' })).toBeTruthy();
    unmount();
    history.replaceState(null, '', '/');
    drawNext(followUps);
    await ask();
    await screen.findByRole('button', { name: 'Kopier svaret' });
    expect(screen.queryByRole('button', { name: 'Kan du utdype?' })).toBeNull();
    expect(document.querySelector('.uib-composer-follow-ups')).toBeNull();
  });

  it('draws the look the layout names, whatever its template, and so offers no follow-ups in the next one', async () => {
    const followUps = { ...reader, followUps: ['Kan du utdype?'] };
    const { unmount } = drawNext(followUps, {
      ...fromTemplate('knowledge-assistant').layout,
      look: 'next',
    });
    await opened();
    expect(document.querySelector('.uib-shell')?.getAttribute('data-frame')).toBe('cards');
    await ask();
    await screen.findByRole('button', { name: 'Kopier svaret' });
    expect(screen.queryByRole('button', { name: 'Kan du utdype?' })).toBeNull();
    unmount();
    history.replaceState(null, '', '/');
    drawNext(reader, { ...nextLayout, look: 'current' });
    await opened();
    expect(document.querySelector('.uib-shell')?.getAttribute('data-frame')).not.toBe('cards');
  });

  it('copies the thread’s link with no note that it works only here, and keeps the answer’s time', async () => {
    const clipboard: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void clipboard.push(text) },
    });
    history.replaceState(null, '', '/?t=t-old');
    drawNext();
    const copyLink = await screen.findByRole('button', { name: 'Kopier lenke til tråden' });
    expect(copyLink.hasAttribute('aria-describedby')).toBe(false);
    expect(document.querySelector('.uib-answer-actions [hidden]')).toBeNull();
    expect(document.querySelector('.uib-answer-actions time')).toBeTruthy();
    await act(async () => {
      fireEvent.click(copyLink);
    });
    expect(clipboard).toEqual([new URL('/?t=t-old', location.href).href]);
    expect(document.querySelector('.uib-answer-actions-receipt')?.textContent).toBe(
      'Lenken til tråden er kopiert.',
    );
    expect(document.body.textContent).not.toContain('Virker bare for deg');
  });

  it('leaves «Kunnskapsassistenten»’s note on the thread’s link as it was', async () => {
    history.replaceState(null, '', '/?t=t-old');
    drawNext(reader, fromTemplate('knowledge-assistant').layout);
    const copyLink = await screen.findByRole('button', { name: 'Kopier lenke til tråden' });
    const note = document.getElementById(copyLink.getAttribute('aria-describedby') ?? '');
    expect(note?.textContent).toBe('Virker bare for deg, i denne nettleseren.');
  });

  it('leaves «Kunnskapsassistenten» as it was: flush, the hidden name as the h1, the filter first, the links in the foot', async () => {
    drawNext(reader, fromTemplate('knowledge-assistant').layout);
    await opened();
    expect(document.querySelector('.uib-shell')?.hasAttribute('data-frame')).toBe(false);
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['KA']);
    expect(screen.queryByRole('heading', { level: 2, name: 'Tråder' })).toBeNull();
    expect(screen.getByRole('button', { name: /Tråder/ })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Innstillinger' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Kari Marie Nordmann' })).toBeNull();
    expect(document.querySelector('.uia-chat')?.getAttribute('style')).toBeNull();
  });

  it('leaves «Kunnskapsassistenten»’s folded panels and answer as they were: no rails, a card with no label', async () => {
    drawNext(reader, fromTemplate('knowledge-assistant').layout);
    await ask();
    fireEvent.click(screen.getByRole('button', { name: 'Skjul tråder og filter' }));
    expect(document.querySelector('.uib-shell-rail, .uib-shell-rail-foot')).toBeNull();
    expect(screen.queryByRole('link', { name: 'Ny tråd' })).toBeNull();
    expect(document.querySelector('.uib-answer')?.hasAttribute('data-plain')).toBe(false);
    expect(document.querySelector('.uib-conversation-label')).toBeNull();
    expect(document.querySelector('.uia-chat')?.getAttribute('style')).toBeNull();
  });
});

describe('the filter in the next look (dev-filter-panel)', () => {
  const nextLayout = fromTemplate('knowledge-assistant-next').layout;
  const counted = () => {
    const fake = fakeApi();
    fake.api.loadFields = vi.fn(async () => [
      { id: 'type', label: 'Dokumenttyper', heading: 'Dokumenttype' },
    ]);
    fake.api.loadFacets = vi.fn(async () => [
      {
        id: 'type',
        label: 'Dokumenttyper',
        heading: 'Dokumenttype',
        options: [
          { value: 'Årsrapport', count: 3 },
          { value: 'Tildelingsbrev', count: 2 },
        ],
      },
    ]);
    return fake;
  };
  const drawNext = (api: AssistantApi, layout = nextLayout) =>
    render(
      <Assistant
        api={api}
        layout={layout}
        service="ka"
        tenant="digdir"
        profile={{
          assistantName: 'KA',
          signedInAs: 'Kari Marie Nordmann',
          // The field each document has one value in, which the filter counts exactly by.
          corpora: { kudos: { typeField: 'type' } },
        }}
        threadInUrl
      />,
    );
  const filterPanel = () => screen.getByRole('region', { name: 'Filter for tråden' });
  const tick = async (name: RegExp) => {
    const box = await within(filterPanel()).findByRole('checkbox', { name });
    await act(async () => {
      fireEvent.click(box);
    });
  };
  const answers = () => document.querySelectorAll('.uib-answer').length;
  /** Asks, and waits until the answers on screen are one more. */
  const askMore = async (question: string) => {
    const before = answers();
    const field = await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    fireEvent.change(field, { target: { value: question } });
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: 'Send spørsmålet' }).hasAttribute('aria-disabled'),
      ).toBe(false),
    );
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Send spørsmålet' }));
    });
    await waitFor(() => expect(answers()).toBe(before + 1));
    await waitFor(() => expect(screen.queryByRole('button', { name: /Avbryt/ })).toBeNull());
  };
  const note = () => document.querySelector('.uib-filter-next')?.textContent;
  const bars = () =>
    [...document.querySelectorAll('.uib-approach summary')].map((summary) => summary.textContent);

  it('draws the filter as its own panel in the threads’ card, for the next question', async () => {
    drawNext(counted().api);
    const nav = await screen.findByRole('navigation', { name: 'Tråder og filter' });
    expect(nav.contains(filterPanel())).toBe(true);
    expect(within(filterPanel()).getByRole('heading', { level: 2, name: 'Filter' })).toBeTruthy();
    expect(within(filterPanel()).getByText('Gjelder neste spørsmål')).toBeTruthy();
    expect(
      await within(filterPanel()).findByRole('button', { name: 'Dokumenttype Alle' }),
    ).toBeTruthy();
    expect(within(filterPanel()).getByRole('checkbox', { name: /^Årsrapport/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Filtrer dokumenter' })).toBeNull();
    expect(document.querySelector('.uib-documents-scope-summary')?.textContent).toBe(
      'Assistenten leser fra 5 av 5 dokumenter i Kudos',
    );
  });

  it('takes periods in the year field and says «Alle år» with none chosen, with no trial on', async () => {
    const fake = counted();
    const years = { id: 'concerned_years', label: 'År', heading: 'År', kind: 'year' as const };
    fake.api.loadFields = vi.fn(async () => [
      { id: 'type', label: 'Dokumenttyper', heading: 'Dokumenttype' },
      years,
    ]);
    fake.api.loadFacets = vi.fn(async () => [
      {
        id: 'type',
        label: 'Dokumenttyper',
        heading: 'Dokumenttype',
        options: [{ value: 'Årsrapport', count: 3 }],
      },
      {
        ...years,
        options: Array.from({ length: 20 }, (_, n) => ({ value: String(2006 + n), count: 1 })),
      },
    ]);
    drawNext(fake.api);
    const row = await within(filterPanel()).findByRole('button', { name: 'År Alle år' });
    await act(async () => {
      fireEvent.click(row);
    });
    const input = filterPanel().querySelector<HTMLInputElement>(
      '.uib-filter-row-body:not([hidden]) input',
    );
    if (!input) throw new Error('the year row opened to no field');
    await act(async () => {
      input.value = '20-22';
      input.dispatchEvent(
        new InputEvent('input', { bubbles: true, inputType: 'insertText', data: '20-22' }),
      );
    });
    expect(
      screen.getByRole('option', { name: '2020–2022 (3 år med dokumenter)', hidden: true }),
    ).toBeTruthy();
  });

  it('draws no line under the field about what the next question reads from (dev-filter-panel)', async () => {
    drawNext(counted().api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    await tick(/^Årsrapport/);
    await waitFor(() =>
      expect(document.querySelector('.uib-documents-scope-summary')?.textContent).toBe(
        'Assistenten leser fra 3 av 5 dokumenter i Kudos',
      ),
    );
    expect(note()).toBeUndefined();
    expect(screen.queryByText(/Neste spørsmål leser fra/)).toBeNull();
  });

  it('says the filter inside Fremgangsmåte, and «filteret er endret» only when it changed', async () => {
    const { api, asked } = counted();
    drawNext(api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    await tick(/^Årsrapport/);
    await askMore('Hva er fast?');
    await waitFor(() => expect(bars()).toEqual(['FremgangsmåteBrukte 1 kilde']));
    const chips = screen.getByRole('list', {
      name: 'Filteret dette svaret bygger på',
      hidden: true,
    });
    expect(chips.textContent).toBe('Årsrapport');
    expect(chips.closest('.uib-approach-scope')?.textContent).toBe(
      'Leste fra 3 dokumenter:Årsrapport',
    );
    await tick(/^Tildelingsbrev/);
    await askMore('Og i år?');
    await waitFor(() => expect(bars()).toHaveLength(2));
    expect(bars()[1]).toBe('FremgangsmåteBrukte 1 kilde · filteret er endret');
    await askMore('Og neste år?');
    await waitFor(() => expect(bars()).toHaveLength(3));
    expect(bars()[2]).toBe('FremgangsmåteBrukte 1 kilde');
    expect(asked).toHaveLength(3);
    // Not said again under the answer: the filter is in Fremgangsmåte.
    expect(screen.queryByText(/Avgrenset til/)).toBeNull();
  });

  it('says the filter in full in the tool, and only how many it read from in the bar beside it', async () => {
    drawNext(counted().api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    await tick(/^Årsrapport/);
    await askMore('Hva er fast?');
    const scopes = () =>
      [...document.querySelectorAll('.uib-approach-scope')].map((scope) => [
        scope.closest('aside') ? 'tool' : 'bar',
        scope.textContent,
      ]);
    await waitFor(() => expect(scopes()).toHaveLength(2));
    expect(scopes()).toEqual([
      ['bar', 'Leste fra 3 dokumenter'],
      ['tool', 'Leste fra 3 dokumenter:Årsrapport'],
    ]);
    const tool = document.querySelector('aside .uib-approach[data-variant="list"]');
    expect(tool?.querySelector('.uib-approach-footer')?.textContent).toMatch(/^Brukte 1 kilde/);
  });

  it('draws the bar alone, with the filter in full, when the layout puts Fremgangsmåte only in the main column', async () => {
    const barOnly = {
      ...nextLayout,
      zones: {
        ...nextLayout.zones,
        secondary: nextLayout.zones.secondary.filter((placed) => placed.block !== 'approach'),
      },
    };
    drawNext(counted().api, barOnly);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    await tick(/^Årsrapport/);
    await askMore('Hva er fast?');
    await waitFor(() => expect(bars()).toEqual(['FremgangsmåteBrukte 1 kilde']));
    expect(document.querySelector('aside .uib-approach')).toBeNull();
    expect(document.querySelector('.uib-approach-scope')?.textContent).toBe(
      'Leste fra 3 dokumenter:Årsrapport',
    );
  });

  it('brings back a thread’s last filter when the thread is opened again', async () => {
    drawNext(counted().api);
    fireEvent.click(await screen.findByRole('link', { name: /En gammel tråd/ }));
    await waitFor(() => expect(answers()).toBe(1));
    await tick(/^Årsrapport/);
    await askMore('Og i år?');
    // «Ny tråd» starts with no filter, as kunnskapsassistenten's does.
    fireEvent.click(screen.getByRole('link', { name: 'Ny tråd' }));
    expect(within(filterPanel()).getByRole('button', { name: 'Dokumenttype Alle' })).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'En gammel tråd' }));
    await waitFor(() =>
      expect(
        within(filterPanel()).getByRole('button', { name: 'Dokumenttype Årsrapport' }),
      ).toBeTruthy(),
    );
  });

  it('reads no kept filter for a thread whose id every object has as a property, such as constructor', async () => {
    const fake = counted();
    fake.api.loadThreads = vi.fn(async () => [
      { id: 'constructor', title: 'En tråd fra adressen', updatedAt: Date.now(), service: 'ka' },
    ]);
    drawNext(fake.api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    await tick(/^Årsrapport/);
    fireEvent.click(await screen.findByRole('link', { name: 'En tråd fra adressen' }));
    await waitFor(() => expect(answers()).toBe(1));
    expect(
      within(filterPanel()).getByRole('button', { name: 'Dokumenttype Årsrapport' }),
    ).toBeTruthy();
  });

  describe('with the trial «compact-filter»', () => {
    const drawTrial = (on: boolean) => {
      const kept = new Map<string, unknown>([['flags', on ? ['compact-filter'] : []]]);
      render(
        <Assistant
          api={counted().api}
          layout={nextLayout}
          service="ka"
          tenant="digdir"
          profile={{
            assistantName: 'KA',
            signedInAs: 'Kari Marie Nordmann',
            corpora: { kudos: { typeField: 'type' } },
            experiments: [{ id: 'compact-filter', title: 'Smalere filter' }],
          }}
          storage={{
            read: (key) => kept.get(key),
            write: (key, value) => void kept.set(key, value),
            remove: (key) => void kept.delete(key),
          }}
          threadInUrl
        />,
      );
    };
    const card = () =>
      screen
        .getByRole('navigation', { name: 'Tråder og filter' })
        .querySelector<HTMLElement>('.uib-shell-box');
    const edge = () => screen.getByRole('separator', { name: 'Endre bredde på tråder og filter' });
    const columns = () =>
      filterPanel()
        .querySelector<HTMLElement>('[style*="--genai-filter-checkboxes-columns"]')
        ?.style.getPropertyValue('--genai-filter-checkboxes-columns');
    const shown = () => within(filterPanel()).findByRole('checkbox', { name: /^Årsrapport/ });

    it('draws the filter 230 wide, its ticks in one column, and gives the threads the rest of the card', async () => {
      drawTrial(true);
      await shown();
      expect(card()?.style.getPropertyValue('--uib-shell-lead-width')).toBe('calc(100% - 230px)');
      expect(columns()).toBe('1');
      expect(edge().getAttribute('aria-valuenow')).toBe('660');
    });

    it('keeps the filter 230 wide as the card is resized, down to the threads’ 220 beside it', async () => {
      drawTrial(true);
      await shown();
      expect(edge().getAttribute('aria-valuemin')).toBe('450');
      fireEvent.keyDown(edge(), { key: 'Home' });
      expect(edge().getAttribute('aria-valuenow')).toBe('450');
      fireEvent.keyDown(edge(), { key: 'ArrowRight', shiftKey: true });
      expect(edge().getAttribute('aria-valuenow')).toBe('514');
      expect(card()?.style.getPropertyValue('--uib-shell-lead-width')).toBe('calc(100% - 230px)');
    });

    it('leaves the filter as it was while the trial is off: 440 wide, two columns, the card at least 660', async () => {
      drawTrial(false);
      await shown();
      expect(card()?.style.getPropertyValue('--uib-shell-lead-width')).toBe('220px');
      expect(columns()).toBeUndefined();
      expect(edge().getAttribute('aria-valuemin')).toBe('660');
      expect(edge().getAttribute('aria-valuenow')).toBe('660');
    });
  });

  // As Kudos's «Virksomhet» (457): 300 long names in one address pass Node's 16 KB, answered 431.
  describe('a field with hundreds of values', () => {
    const agencies = Array.from(
      { length: 300 },
      (_, i) => `Direktoratet for forvaltning og økonomistyring nr. ${i + 1}`,
    );
    const types = [
      { value: 'Årsrapport', count: 3 },
      { value: 'Tildelingsbrev', count: 2 },
    ];
    let sent: string[] = [];
    const filterOf = (url: string) =>
      new URL(url, 'http://localhost').searchParams.get('filter') ?? '';
    /** `answered`: how many requests genki answers before it is unavailable. */
    const drawWide = (stored?: Record<string, readonly string[]>, answered = Infinity) => {
      sent = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: string) => {
          const url = String(input);
          sent.push(url);
          if (sent.length > answered) return new Response(null, { status: 503 });
          if (url.length > 16_384)
            return new Response(null, {
              status: 431,
              statusText: 'Request Header Fields Too Large',
            });
          const field = new URL(url, 'http://localhost').searchParams.get('fields');
          const options =
            field === 'virksomhet' ? agencies.map((value) => ({ value, count: 1 })) : types;
          return Response.json({ fields: [{ field, options }] });
        }),
      );
      const fake = fakeApi();
      fake.api.loadFields = vi.fn(async () => [
        { id: 'type', label: 'Dokumenttyper', heading: 'Dokumenttype' },
        { id: 'virksomhet', label: 'Virksomheter', heading: 'Virksomhet' },
      ]);
      fake.api.loadFacets = createGenkiApi({ baseUrl: '/genki', tenant: 'digdir' }).loadFacets;
      const kept = new Map<string, unknown>(stored ? [['filter', stored]] : []);
      render(
        <Assistant
          api={fake.api}
          layout={nextLayout}
          service="ka"
          tenant="digdir"
          profile={{
            assistantName: 'KA',
            signedInAs: 'Kari Marie Nordmann',
            corpora: { kudos: { typeField: 'type' } },
          }}
          storage={{
            read: (key) => kept.get(key),
            write: (key, value) => void kept.set(key, value),
            remove: (key) => void kept.delete(key),
          }}
          threadInUrl
        />,
      );
      return fake;
    };
    afterEach(() => vi.unstubAllGlobals());
    const failed = () => within(filterPanel()).queryByText('Klarte ikke å hente filtrene.');
    const row = (name: RegExp) => within(filterPanel()).queryByRole('button', { name });
    /** The filter has drawn its fields, or said it could not fetch them. */
    const settled = () => waitFor(() => expect(failed() ?? row(/^Virksomhet /)).toBeTruthy());

    it('leaves a field with every value chosen out of the facets request', async () => {
      drawWide();
      fireEvent.click(
        await within(filterPanel()).findByRole('button', { name: 'Virksomhet Alle' }),
      );
      const from = sent.length;
      await act(async () => {
        fireEvent.click(
          within(filterPanel()).getByRole('button', { name: 'Velg alle virksomheter' }),
        );
      });
      await waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(from + 2));
      await settled();
      expect(failed()).toBeNull();
      expect(sent.slice(from).filter((url) => filterOf(url).includes('virksomhet'))).toEqual([]);
      expect(row(/^Virksomhet Alle/)).toBeTruthy();
      expect(row(/^Dokumenttype Alle/)).toBeTruthy();
    });

    it('leaves it out of the question’s filter', async () => {
      const { asked } = drawWide({ virksomhet: agencies });
      await settled();
      await askMore('Hva er fast?');
      expect(asked).toHaveLength(1);
      expect(asked[0]?.filters).toBeUndefined();
    });

    it('keeps every value ticked after a question asked without the field', async () => {
      const { asked } = drawWide();
      fireEvent.click(
        await within(filterPanel()).findByRole('button', { name: 'Virksomhet Alle' }),
      );
      await act(async () => {
        fireEvent.click(
          within(filterPanel()).getByRole('button', { name: 'Velg alle virksomheter' }),
        );
      });
      await settled();
      await askMore('Hva er fast?');
      expect(asked[0]?.filters).toBeUndefined();
      expect(
        within(filterPanel()).queryByRole('button', {
          name: 'Velg alle virksomheter',
          hidden: true,
        }),
      ).toBeNull();
    });

    it('leaves it out of the question’s filter while the facets cannot be fetched, by the collection’s values', async () => {
      // The collection's values come back, one request per field; then genki is unavailable.
      const { asked } = drawWide({ virksomhet: agencies }, 2);
      await settled();
      expect(failed()).toBeTruthy();
      await askMore('Hva er fast?');
      expect(asked).toHaveLength(1);
      expect(asked[0]?.filters).toBeUndefined();
    });

    it('refuses a facets request longer than the server takes, with the error the filter already shows', async () => {
      // 100 names, as many as genki takes, each long enough that together they pass the limit.
      const long = Array.from(
        { length: 100 },
        (_, i) =>
          `Direktoratet for forvaltning og økonomistyring, avdeling for samordning nr. ${i}`,
      );
      drawWide({ virksomhet: long });
      await settled();
      expect(failed()).toBeTruthy();
      expect(sent.filter((url) => url.length > FACETS_URL_LIMIT)).toEqual([]);
    });

    // genki's filter takes at most 100 values a field (`maxOptions` in adapter-rest).
    const leftOut = (filter: string) =>
      (JSON.parse(filter || '{"fields":[]}') as { fields: Record<string, unknown>[] }).fields.find(
        (field) => field.field === 'virksomhet',
      );

    it('asks the facets with more than 100 chosen and at most 100 left out as the values left out', async () => {
      drawWide({ virksomhet: agencies.slice(1) });
      await settled();
      expect(failed()).toBeNull();
      const asked = sent.filter((url) => filterOf(url).includes('virksomhet'));
      expect(asked.length).toBeGreaterThan(0);
      expect(asked.map((url) => leftOut(filterOf(url)))).toEqual(
        asked.map(() => ({
          field: 'virksomhet',
          type: 'not-in-set',
          'value-type': 'string',
          'selected-options': [agencies[0]],
        })),
      );
    });

    it('asks the question with them as the values left out', async () => {
      const { asked } = drawWide({ virksomhet: agencies.slice(1) });
      await settled();
      await askMore('Hva er fast?');
      expect(asked[0]?.filters).toEqual({
        fields: [
          {
            field: 'virksomhet',
            type: 'not-in-set',
            'value-type': 'string',
            'selected-options': [agencies[0]],
          },
        ],
      });
    });

    const tooMany =
      'Virksomheter: for mange er valgt. Velg høyst 100, eller alle unntatt høyst 100.';

    it('says why in the filter, and asks nothing with it, when more than 100 are chosen and more than 100 left out', async () => {
      drawWide({ virksomhet: agencies.slice(0, 150) });
      expect(await within(filterPanel()).findByText(tooMany)).toBeTruthy();
      expect(sent.filter((url) => filterOf(url).includes('virksomhet'))).toEqual([]);
      expect(within(filterPanel()).queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
    });

    it('fails a question with that filter before sending it, saying why', async () => {
      const { asked } = drawWide({ virksomhet: agencies.slice(0, 150) });
      await within(filterPanel()).findByText(tooMany);
      await askMore('Hva er fast?');
      expect(asked).toEqual([]);
      const answer = document.querySelector<HTMLElement>('.uib-answer');
      expect(answer?.textContent).toContain('Filteret kan ikke brukes');
      expect(answer?.textContent).toContain(tooMany);
    });
  });

  it('leaves «Kunnskapsassistenten»’s filter as it was: a view of the panel, no line under the field', async () => {
    drawNext(counted().api, fromTemplate('knowledge-assistant').layout);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(screen.queryByRole('region', { name: 'Filter for tråden' })).toBeNull();
    expect(document.querySelector('.uib-filter-next')).toBeNull();
    expect(document.querySelector('.uib-filter-rows')).toBeNull();
  });
});

describe('Dokumentvisning in the assistant', () => {
  // The stored thread, whose answer cites the excerpt c1 of «Tildelingsbrev 2022».
  const stored = async (layout: AssistantLayout, api = fakeApi().api) => {
    history.replaceState(null, '', '/?t=t-old');
    draw(layout, api, true);
    await waitFor(() => expect(footnotes()).toHaveLength(1));
    return footnotes()[0] as HTMLElement;
  };
  const withView = () => turnOn(state('sources-only'), 'document-view');
  const withoutSources = () => turnOff(withView(), 'sources');
  const tab = (name: string) => screen.getByRole('tab', { name, hidden: true });
  const documentTitle = () => screen.findByRole('heading', { name: 'Tildelingsbrev 2022' });

  it('opens the document from «Vis i dokumentet» on an excerpt in Kilder, on its own tool', async () => {
    const footnote = await stored(withView().layout);
    fireEvent.click(footnote);
    const show = await screen.findByRole('button', { name: /Vis i dokumentet/ });
    fireEvent.click(show);
    await waitFor(() => expect(tab('Dokumentvisning').getAttribute('aria-selected')).toBe('true'));
    expect(await documentTitle()).toBeTruthy();
  });

  it('names «Vis i dokumentet» in one piece, the words seen and then the document', async () => {
    const footnote = await stored(withView().layout);
    fireEvent.click(footnote);
    const show = await screen.findByRole('button', {
      name: 'Vis i dokumentet, Tildelingsbrev 2022',
    });
    // No hidden box after the words, which a browser reads with a space before the comma.
    expect(show.querySelector('.ds-sr-only')).toBeNull();
    expect(show.textContent).toBe('Vis i dokumentet');
  });

  it('names in its hint what opens a document here: «Vis i dokumentet» with Kilder, a footnote without', async () => {
    const hint = () => document.querySelector('.uib-document-view')?.textContent ?? '';
    const withKilder = draw(withView().layout, fakeApi().api);
    await waitFor(() =>
      expect(hint()).toContain(
        'Åpne et utdrag i kildene og velg «Vis i dokumentet», så vises dokumentet her.',
      ),
    );
    withKilder.unmount();
    draw(withoutSources().layout, fakeApi().api);
    await waitFor(() =>
      expect(hint()).toContain('Velg en fotnote i svaret, så vises dokumentet her.'),
    );
    expect(hint()).not.toContain('kildene');
  });

  it('gives the focus back to «Vis i dokumentet» on «Tilbake til kildene», with Kilder shown', async () => {
    const footnote = await stored(withView().layout);
    fireEvent.click(footnote);
    const show = await screen.findByRole('button', { name: /Vis i dokumentet/ });
    show.focus();
    fireEvent.click(show);
    fireEvent.click(await screen.findByRole('button', { name: 'Tilbake til kildene' }));
    await waitFor(() => expect(document.activeElement).toBe(show));
    expect(tab('Kilder').getAttribute('aria-selected')).toBe('true');
  });

  it('keeps the footnotes without Kilder when Dokumentvisning is on, and a footnote opens the document', async () => {
    const footnote = await stored(withoutSources().layout);
    expect(screen.queryByRole('complementary', { name: 'Kilder', hidden: true })).toBeNull();
    fireEvent.click(footnote);
    expect(await documentTitle()).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Tilbake til svaret' })).toBeTruthy();
  });

  it('gives the focus back to the footnote on «Tilbake til svaret»', async () => {
    const footnote = await stored(withoutSources().layout);
    footnote.focus();
    fireEvent.click(footnote);
    fireEvent.click(await screen.findByRole('button', { name: 'Tilbake til svaret' }));
    await waitFor(() =>
      expect(document.activeElement?.getAttribute('aria-label')).toBe(
        footnote.getAttribute('aria-label'),
      ),
    );
  });

  it('prevents Escape’s default in the document, which would also close a drawer around it, but not in its question field', async () => {
    const footnote = await stored(withView().layout);
    fireEvent.click(footnote);
    fireEvent.click(await screen.findByRole('button', { name: /Vis i dokumentet/ }));
    const field = await screen.findByRole('textbox', { name: 'Spør om dette dokumentet' });
    // `fireEvent` says false when the default was prevented.
    expect(fireEvent.keyDown(field, { key: 'Escape' })).toBe(true);
    const title = await documentTitle();
    expect(fireEvent.keyDown(title, { key: 'Escape' })).toBe(false);
    await waitFor(() => expect(tab('Kilder').getAttribute('aria-selected')).toBe('true'));
  });

  const askInDocument = async (question = 'Hvor ofte rapporteres det?') => {
    const field = await screen.findByRole('textbox', { name: 'Spør om dette dokumentet' });
    fireEvent.change(field, { target: { value: question } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Spør' }));
    });
  };

  it('asks a question from the document in the thread, naming the document', async () => {
    const { api, asked } = fakeApi();
    const footnote = await stored(withoutSources().layout, api);
    fireEvent.click(footnote);
    await askInDocument();
    await waitFor(() => expect(asked).toHaveLength(1));
    const named = 'Om «Tildelingsbrev 2022»: Hvor ofte rapporteres det?';
    expect(asked[0]?.question).toBe(named);
    expect(asked[0]?.conversationId).toBe('t-old');
    expect(await screen.findByText(named)).toBeTruthy();
  });

  it('searches only the document a question is asked in, where the collection declares its number as a filter', async () => {
    const { api, asked } = fakeApi();
    const declared: ModelRow = {
      ...(rows[0] as ModelRow),
      _datasets: [
        {
          tenant: 'digdir',
          'dataset-config-key': 'kudos',
          filters: [
            { field: 'type', kinds: ['multiselect'], 'value-type': 'string' },
            { field: 'doc_num', kinds: ['multiselect'], 'value-type': 'string' },
          ],
        },
      ],
    };
    api.loadModels = vi.fn(async () => [declared]);
    history.replaceState(null, '', '/?t=t-old');
    render(
      <Assistant
        api={api}
        layout={withoutSources().layout}
        service="ka"
        tenant="digdir"
        profile={{
          assistantName: 'KA',
          corpora: { kudos: { about: { idField: 'doc_num', fields: ['type'] } } },
        }}
        threadInUrl
      />,
    );
    await waitFor(() => expect(footnotes()).toHaveLength(1));
    fireEvent.click(footnotes()[0] as HTMLElement);
    await askInDocument();
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]?.filters).toEqual({
      fields: [
        {
          field: 'doc_num',
          type: 'multiselect',
          'value-type': 'string',
          'selected-options': ['42'],
        },
      ],
    });
    expect(await screen.findByText(/Avgrenset til: Tildelingsbrev 2022/)).toBeTruthy();
  });

  it('narrows nothing by the document where the collection does not declare its number as a filter', async () => {
    const { api, asked } = fakeApi();
    history.replaceState(null, '', '/?t=t-old');
    render(
      <Assistant
        api={api}
        layout={withoutSources().layout}
        service="ka"
        tenant="digdir"
        profile={{
          assistantName: 'KA',
          corpora: { kudos: { about: { idField: 'doc_num', fields: ['type'] } } },
        }}
        threadInUrl
      />,
    );
    await waitFor(() => expect(footnotes()).toHaveLength(1));
    fireEvent.click(footnotes()[0] as HTMLElement);
    await askInDocument();
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(JSON.stringify(asked[0]?.filters ?? {})).not.toContain('doc_num');
  });

  // The secondary panel starts folded, as in kunnskapsassistenten, so its tools are hidden.
  const tools = () => document.querySelector<HTMLElement>('.uib-shell-tools');

  it('is one of the secondary panel’s tools: a heading alone, tabs with one more, a dropdown with two', async () => {
    const api = fakeApi().api;
    const alone = draw(turnOn(state('chat-only'), 'document-view').layout, api);
    await waitFor(() => expect(tools()?.dataset.mode).toBe('heading'));
    expect(screen.getByRole('heading', { name: 'Dokumentvisning', hidden: true })).toBeTruthy();
    alone.unmount();
    const two = draw(withView().layout, api);
    await waitFor(() => expect(tools()?.dataset.mode).toBe('tabs'));
    expect(screen.getAllByRole('tab', { hidden: true }).map((t) => t.textContent)).toEqual([
      'Kilder',
      'Dokumentvisning',
    ]);
    two.unmount();
    draw(placeIn(withView(), 'approach', 'secondary').layout, api);
    await waitFor(() => expect(tools()?.dataset.mode).toBe('dropdown'));
    const options = [...document.querySelectorAll('.uib-shell-tools-choice option')].map(
      (o) => o.textContent,
    );
    expect(options).toEqual(['Fremgangsmåte', 'Kilder', 'Dokumentvisning']);
  });

  it('stops its jumps under the secondary panel’s pinned switcher, at the height the shell measures', async () => {
    // Every element 52 px tall. The ResizeObserver stub never reports: the height is the one the
    // shell sets as the panel opens, and the assembly measures nothing of its own.
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(52);
    try {
      draw(withView().layout, fakeApi().api);
      await waitFor(() => expect(tools()?.dataset.mode).toBe('tabs'));
      const view = document.querySelector<HTMLElement>('.uib-document-view');
      const region = view?.closest<HTMLElement>('.uib-shell-content');
      expect(region?.style.getPropertyValue('--uib-shell-pinned-block-size')).toBe('52px');
      expect(view?.parentElement?.style.getPropertyValue('--genai-document-view-jumps-inset')).toBe(
        'var(--uib-shell-pinned-block-size, 0px)',
      );
      // The variable the block stops its jumps at, so a rename in the block fails here.
      expect(
        readFileSync(
          `${import.meta.dirname}/../../ui-blocks/src/document-view/document-view.css`,
          'utf8',
        ),
      ).toMatch(/inset-block-start:\s*var\(--genai-document-view-jumps-inset\b/);
    } finally {
      height.mockRestore();
    }
  });

  it('leaves a folded panel’s scroll padding to the shell, which has it as the document opens', async () => {
    // The ResizeObserver stub never reports, as the shell's comes a frame too late.
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(52);
    try {
      const footnote = await stored(withoutSources().layout);
      fireEvent.click(footnote);
      await documentTitle();
      const region = document
        .querySelector('.uib-document-view')
        ?.closest<HTMLElement>('.uib-shell-content');
      expect(region?.style.scrollPaddingBlockStart).toBe('52px');
    } finally {
      height.mockRestore();
    }
  });

  it('stands in «Innhold» in the conversation’s place while a document is open, and gives it back', async () => {
    const inMain = placeIn(withoutSources(), 'document-view', 'main');
    const footnote = await stored(inMain.layout);
    const chat = () => document.querySelector<HTMLElement>('.uia-main-chat');
    expect(screen.queryByRole('heading', { name: 'Dokumentvisning' })).toBeNull();
    fireEvent.click(footnote);
    expect(await screen.findByRole('heading', { level: 2, name: 'Dokumentvisning' })).toBeTruthy();
    expect(chat()?.hidden).toBe(true);
    expect(document.querySelector('.uib-shell-tools')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tilbake til svaret' }));
    await waitFor(() => expect(chat()?.hidden).toBe(false));
    expect(screen.queryByRole('heading', { name: 'Dokumentvisning' })).toBeNull();
  });

  it('is not in kunnskapsassistenten’s template: Kilder has no «Vis i dokumentet»', async () => {
    const footnote = await stored(state('knowledge-assistant').layout);
    fireEvent.click(footnote);
    await waitFor(() => expect(screen.getByRole('complementary', { name: 'Kilder' })).toBeTruthy());
    expect(screen.queryByRole('button', { name: /Vis i dokumentet/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Dokumentvisning', hidden: true })).toBeNull();
  });
});

// A stored thread opened from the address, with its one footnote.
const openStored = async (layout: AssistantLayout, api = fakeApi().api) => {
  history.replaceState(null, '', '/?t=t-old');
  draw(layout, api, true);
  await waitFor(() => expect(footnotes()).toHaveLength(1));
  return footnotes()[0] as HTMLElement;
};
const focusIsOn = (footnote: HTMLElement) =>
  waitFor(() =>
    expect(document.activeElement?.getAttribute('aria-label')).toBe(
      footnote.getAttribute('aria-label'),
    ),
  );
const typeInField = async (text: string) => {
  const field = await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
  fireEvent.change(field, { target: { value: text } });
  return field as HTMLTextAreaElement;
};
const pressSend = () =>
  act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send spørsmålet' }));
  });

describe('asking, whatever genki has said of the service', () => {
  it('sends a question asked before genki has said what the service backs, once it has', async () => {
    const { api, asked } = fakeApi();
    let answerModels: (found: ModelRow[]) => void = () => {};
    api.loadModels = vi.fn(
      () =>
        new Promise<ModelRow[]>((resolve) => {
          answerModels = resolve;
        }),
    );
    draw(state('sources-only').layout, api);
    await typeInField('Hva er fast?');
    await pressSend();
    expect(asked).toHaveLength(0);
    await act(async () => answerModels(rows));
    await screen.findByText(/Rapporteringen er fast/);
    expect(asked[0]?.dataset).toEqual({ tenant: 'digdir', key: 'kudos' });
  });

  it('asks a service that answers in a chat of its own with no collection', async () => {
    const { api, asked } = fakeApi();
    api.loadModels = vi.fn(async () => [
      { id: 'chat__default', _service: 'chat', _pickable: true, _chat: true },
    ]);
    render(
      <Assistant
        api={api}
        layout={state('chat-only').layout}
        service="chat"
        tenant="digdir"
        profile={{ assistantName: 'KA' }}
      />,
    );
    await ask();
    expect(asked[0]?.dataset).toBeUndefined();
  });

  it('says so when genki cannot say what the service backs, and tries again when a question is sent', async () => {
    const { api, asked } = fakeApi();
    api.loadModels = vi
      .fn<() => Promise<ModelRow[]>>()
      .mockRejectedValueOnce(new HttpError(502, '502 Bad Gateway'))
      .mockResolvedValue(rows);
    draw(state('sources-only').layout, api);
    expect(
      await screen.findByRole('heading', { name: 'Fikk ikke kontakt med tjenesten' }),
    ).toBeTruthy();
    expect(screen.getByText(/Den svarte med feilkode 502\./)).toBeTruthy();
    await typeInField('Hva er fast?');
    await pressSend();
    await screen.findByText(/Rapporteringen er fast/);
    expect(api.loadModels).toHaveBeenCalledTimes(2);
    expect(asked).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Fikk ikke kontakt med tjenesten' })).toBeNull();
  });

  it('says in the reader’s language why genki cannot be reached, never the browser’s or genki’s own words', async () => {
    const { api } = fakeApi();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.loadModels = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    draw(state('sources-only').layout, api);
    const alert = (
      await screen.findByRole('heading', { name: 'Fikk ikke kontakt med tjenesten' })
    ).closest('[role="alert"]') as HTMLElement;
    expect(alert.textContent).toContain('Spørsmål kan ikke sendes før tjenesten svarer.');
    expect(alert.textContent).not.toMatch(/Failed to fetch|Feilen var/);
    cleanup();
    api.loadModels = vi.fn(async () => {
      throw new HttpError(503, '503 Service Unavailable: upstream connect error');
    });
    draw(state('sources-only').layout, api);
    const again = (
      await screen.findByRole('heading', { name: 'Fikk ikke kontakt med tjenesten' })
    ).closest('[role="alert"]') as HTMLElement;
    expect(again.textContent).toContain(
      'Spørsmål kan ikke sendes før tjenesten svarer. Den svarte med feilkode 503.',
    );
    expect(again.textContent).not.toMatch(/Service Unavailable|upstream/);
    quiet.mockRestore();
  });

  it('says in the reader’s language why a thread could not be loaded, never the browser’s or genki’s own words', async () => {
    const { api } = fakeApi();
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    api.loadThread = vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    });
    history.replaceState(null, '', '/?t=t-old');
    draw(state('sources-only').layout, api, true);
    const alert = (await screen.findByRole('heading', { name: 'Kunne ikke hente tråden' })).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(alert.textContent).toContain('Fikk ikke kontakt med tjenesten.');
    expect(alert.textContent).not.toMatch(/Failed to fetch/);
    cleanup();
    api.loadThread = vi.fn(async () => {
      throw new HttpError(500, '500 Internal Server Error');
    });
    draw(state('sources-only').layout, api, true);
    const again = (await screen.findByRole('heading', { name: 'Kunne ikke hente tråden' })).closest(
      '[role="alert"]',
    ) as HTMLElement;
    expect(again.textContent).toContain('Tjenesten svarte med feilkode 500.');
    expect(again.textContent).not.toMatch(/Internal Server Error/);
    quiet.mockRestore();
  });

  it('keeps the question in the field when genki still cannot be reached', async () => {
    const { api, asked } = fakeApi();
    api.loadModels = vi.fn(async () => {
      throw new Error('502 Bad Gateway');
    });
    draw(state('sources-only').layout, api);
    await screen.findByRole('heading', { name: 'Fikk ikke kontakt med tjenesten' });
    const field = await typeInField('Hva er fast?');
    await pressSend();
    await waitFor(() => expect(api.loadModels).toHaveBeenCalledTimes(2));
    await screen.findByRole('heading', { name: 'Fikk ikke kontakt med tjenesten' });
    expect(asked).toHaveLength(0);
    expect(field.value).toBe('Hva er fast?');
  });

  it('leaves the field’s text alone when an answer is asked again, and empties it for the question sent from it', async () => {
    const { api, asked } = fakeApi();
    // The first question fails, so its answer offers «Prøv igjen».
    const answers = api.ask;
    api.ask = (params) =>
      asked.length === 0
        ? (async function* (): AsyncGenerator<StreamEvent, void> {
            asked.push(params);
            yield { type: 'conversation', conversationId: 't-new' };
            throw new HttpError(503, '503 Service Unavailable');
          })()
        : answers(params);
    draw(state('sources-only').layout, api);
    await typeInField('Hva er fast?');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send spørsmålet' })).toBeTruthy(),
    );
    await pressSend();
    const again = await screen.findByRole('button', { name: 'Prøv igjen' });
    const field = await typeInField('Et halvt spørs');
    await act(async () => {
      fireEvent.click(again);
    });
    await screen.findByText(/Rapporteringen er fast/);
    expect(asked.map((one) => one.question)).toEqual(['Hva er fast?', 'Hva er fast?']);
    expect(field.value).toBe('Et halvt spørs');
    await pressSend();
    await waitFor(() => expect(asked).toHaveLength(3));
    expect(field.value).toBe('');
  });

  it('stops its answer when it goes, and reports nothing after', async () => {
    const { api } = fakeApi();
    const signals: AbortSignal[] = [];
    api.ask = async function* (params): AsyncGenerator<StreamEvent, void> {
      signals.push(params.signal);
      yield { type: 'step', step: { tool: 'search' } };
      await new Promise((_, reject) =>
        params.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    };
    const reported = vi.fn();
    const { unmount } = render(
      <Assistant
        api={api}
        layout={state('knowledge-assistant').layout}
        service="ka"
        tenant="digdir"
        profile={{ assistantName: 'KA' }}
        onStepsReported={reported}
      />,
    );
    await typeInField('Hva er fast?');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Send spørsmålet' })).toBeTruthy(),
    );
    await pressSend();
    await waitFor(() => expect(signals).toHaveLength(1));
    unmount();
    expect(signals[0]?.aborted).toBe(true);
    expect(reported).not.toHaveBeenCalled();
  });
});

describe('leaving a thread while its answer streams', () => {
  it('shows the thread asked in, from genki, when the reader comes back to it', async () => {
    const { api } = fakeApi();
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    let made = false;
    api.loadThreads = vi.fn(async () => [
      ...(made
        ? [{ id: 't-new', title: 'Hva er nytt?', updatedAt: Date.now(), service: 'ka' }]
        : []),
      { id: 't-old', title: 'En gammel tråd', updatedAt: Date.now(), service: 'ka' },
    ]);
    api.loadThread = vi.fn(async (id: string) =>
      id === 't-new'
        ? {
            title: 'Hva er nytt?',
            turns: [
              {
                id: 'n1',
                question: 'Hva er nytt?',
                askedAt: 1,
                answer: { text: 'Det nye svaret.', status: 'complete' as const, created: 2 },
              },
            ],
          }
        : {
            title: 'En gammel tråd',
            turns: [
              {
                id: 'o1',
                question: 'Hva var gammelt?',
                askedAt: 1,
                answer: { text: 'Det gamle svaret.', status: 'complete' as const, created: 2 },
              },
            ],
          },
    );
    api.ask = async function* (params) {
      made = true;
      // genki says the new thread twice: the assembly's POST, then the stream itself.
      yield { type: 'conversation', conversationId: 't-new' };
      yield { type: 'conversation', conversationId: 't-new' };
      // The answer is on its way when the reader leaves; leaving aborts it, as fetch does.
      await new Promise<void>((resolve, reject) => {
        void held.then(resolve);
        params.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        );
      });
      yield { type: 'text', text: 'Det nye svaret.' };
    };
    draw(state('without-filter').layout, api, true);
    await send('Hva er nytt?');
    await act(async () => {
      fireEvent.click(await screen.findByRole('link', { name: /En gammel tråd/ }));
    });
    expect(await screen.findByText('Det gamle svaret.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(await screen.findByRole('link', { name: /Hva er nytt\?/ }));
    });
    expect(await screen.findByText('Det nye svaret.')).toBeTruthy();
    expect(screen.queryByText('Det gamle svaret.')).toBeNull();
    expect(screen.queryByText('Hva var gammelt?')).toBeNull();
    release();
  });

  it('leaves no «Henter svar.» in the live region when the reader comes back before genki has stored the answer', async () => {
    const { api } = fakeApi();
    let made = false;
    api.loadThreads = vi.fn(async () => [
      ...(made
        ? [{ id: 't-new', title: 'Hva er nytt?', updatedAt: Date.now(), service: 'ka' }]
        : []),
      { id: 't-old', title: 'En gammel tråd', updatedAt: Date.now(), service: 'ka' },
    ]);
    api.loadThread = vi.fn(async (id: string) =>
      id === 't-new'
        ? // genki is still writing the answer: the thread holds the question alone.
          { title: 'Hva er nytt?', turns: [{ id: 'n1', question: 'Hva er nytt?', askedAt: 1 }] }
        : {
            title: 'En gammel tråd',
            turns: [
              {
                id: 'o1',
                question: 'Hva var gammelt?',
                askedAt: 1,
                answer: { text: 'Det gamle svaret.', status: 'complete' as const, created: 2 },
              },
            ],
          },
    );
    api.ask = async function* (params) {
      made = true;
      yield { type: 'conversation', conversationId: 't-new' };
      // Leaving aborts the answer on its way, as fetch does.
      await new Promise<void>((_, reject) =>
        params.signal.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      );
    };
    draw(state('without-filter').layout, api, true);
    const region = () =>
      document.querySelector('.uib-conversation > [aria-live="polite"]')?.textContent;
    await send('Hva er nytt?');
    await waitFor(() => expect(region()).toBe('Henter svar.'));
    await act(async () => {
      fireEvent.click(await screen.findByRole('link', { name: /En gammel tråd/ }));
    });
    expect(await screen.findByText('Det gamle svaret.')).toBeTruthy();
    expect(region()).toBe('');
    await act(async () => {
      fireEvent.click(await screen.findByRole('link', { name: /Hva er nytt\?/ }));
    });
    await waitFor(() => expect(screen.queryByText('Det gamle svaret.')).toBeNull());
    expect(await screen.findByText('Hva er nytt?', { selector: 'p' })).toBeTruthy();
    await waitFor(() => expect(region()).toBe(''));
  });
});

describe('the way back to the answer', () => {
  const tab = (name: string) => screen.getByRole('tab', { name, hidden: true });
  const chatBesideSources = () => placeIn(state('sources-only'), 'chat', 'secondary');

  it('shows Chat’s own tool again, with the footnote focused, on «Tilbake til svaret» from Kilder in the same panel', async () => {
    const footnote = await openStored(chatBesideSources().layout);
    footnote.focus();
    fireEvent.click(footnote);
    await waitFor(() => expect(tab('Kilder').getAttribute('aria-selected')).toBe('true'));
    fireEvent.click(screen.getByRole('button', { name: 'Tilbake til svaret', hidden: true }));
    await waitFor(() => expect(tab('Chat').getAttribute('aria-selected')).toBe('true'));
    await focusIsOn(footnote);
  });

  it('shows Chat’s own tool when a question is asked from Dokumentvisning in the same panel', async () => {
    const { api, asked } = fakeApi();
    const footnote = await openStored(turnOn(chatBesideSources(), 'document-view').layout, api);
    fireEvent.click(footnote);
    fireEvent.click(await screen.findByRole('button', { name: /Vis i dokumentet/, hidden: true }));
    const choice = () =>
      document.querySelector<HTMLSelectElement>('.uib-shell-tools-choice select')?.value;
    await waitFor(() => expect(choice()).toBe('document-view'));
    const field = await screen.findByRole('textbox', {
      name: 'Spør om dette dokumentet',
      hidden: true,
    });
    fireEvent.change(field, { target: { value: 'Hvor ofte?' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Spør', hidden: true }));
    });
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(choice()).toBe('chat');
  });

  it('moves the focus on to Chat’s field when a question from Dokumentvisning in the same panel hides the field it was typed in, while the answer comes', async () => {
    const { api } = fakeApi();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked: AskParams[] = [];
    api.ask = async function* (params): AsyncGenerator<StreamEvent, void> {
      asked.push(params);
      yield { type: 'text', text: 'Rapporteringen' };
      await held;
      yield {
        type: 'done',
        answer: { id: 'a2', text: answer, sources: [source], citations: [], noAnswer: false },
      };
    };
    const footnote = await openStored(turnOn(chatBesideSources(), 'document-view').layout, api);
    fireEvent.click(footnote);
    fireEvent.click(await screen.findByRole('button', { name: /Vis i dokumentet/, hidden: true }));
    const field = await screen.findByRole('textbox', {
      name: 'Spør om dette dokumentet',
      hidden: true,
    });
    field.focus();
    fireEvent.change(field, { target: { value: 'Hvor ofte?' } });
    await act(async () => {
      fireEvent.submit(field.closest('form') as HTMLFormElement);
    });
    await waitFor(() => expect(asked).toHaveLength(1));
    // The answer is still coming, and the focus is in Chat's field, not on the page.
    expect(screen.getByRole('button', { name: 'Avbryt genereringen', hidden: true })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole('textbox', { name: /Spørsmål til KA/, hidden: true }),
      ),
    );
    await act(async () => release());
  });

  it('closes a document standing in the conversation’s place on Kilder’s way back, with the footnote focused', async () => {
    const layout = placeIn(turnOn(state('sources-only'), 'document-view'), 'document-view', 'main');
    const footnote = await openStored(layout.layout);
    footnote.focus();
    fireEvent.click(footnote);
    fireEvent.click(await screen.findByRole('button', { name: /Vis i dokumentet/ }));
    const chat = () => document.querySelector<HTMLElement>('.uia-main-chat');
    await waitFor(() => expect(chat()?.hidden).toBe(true));
    // The document came from Kilder, so its own way back is «Tilbake til kildene»: this is Kilder's.
    fireEvent.click(screen.getByRole('button', { name: 'Tilbake til svaret', hidden: true }));
    await waitFor(() => expect(chat()?.hidden).toBe(false));
    await focusIsOn(footnote);
  });
});

describe('footnotes per document in the next look, until genki cites excerpts', () => {
  const documentMarks = () =>
    [...document.querySelectorAll<HTMLElement>('.uib-answer-mark')].map((mark) =>
      mark.getAttribute('aria-label'),
    );

  it('draws a mark per cited document, which opens the document in Kilder', async () => {
    draw(fromTemplate('knowledge-assistant-next').layout, fakeApi().api, true);
    await ask();
    await waitFor(() => expect(documentMarks()).toEqual(['Kilde 1: Tildelingsbrev 2022']));
    fireEvent.click(screen.getByRole('link', { name: 'Kilde 1: Tildelingsbrev 2022' }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Kilder' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
    await waitFor(() => expect(document.activeElement?.textContent).toBe('Tildelingsbrev 2022'));
    expect(screen.getByRole('button', { name: /Tilbake til svaret/ })).toBeTruthy();
  });

  it('copies the marks as drawn, with a numbered line per document', async () => {
    const clipboard: string[] = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void clipboard.push(text) },
    });
    draw(fromTemplate('knowledge-assistant-next').layout, fakeApi().api, true);
    await ask();
    await act(async () => {
      fireEvent.click(await screen.findByRole('button', { name: 'Kopier svaret' }));
    });
    expect(clipboard).toEqual(['Rapporteringen er fast [1].\n\nKilder\n[1] Tildelingsbrev 2022.']);
  });

  it('keeps one number per excerpt for an answer that cites excerpts', async () => {
    await openStored(fromTemplate('knowledge-assistant-next').layout);
    expect(documentMarks()).toEqual(['Utdrag 1: Tildelingsbrev 2022']);
  });

  it('leaves «Kunnskapsassistenten» drawing no mark for a document', async () => {
    draw(fromTemplate('knowledge-assistant').layout, fakeApi().api, true);
    await ask();
    expect((await screen.findAllByText('Tildelingsbrev 2022')).length).toBeGreaterThan(0);
    expect(documentMarks()).toEqual([]);
  });
});

describe('copying from an answer', () => {
  let clipboard: string[] = [];
  beforeEach(() => {
    clipboard = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: async (text: string) => void clipboard.push(text) },
    });
  });

  it('copies what the screen says: the footnotes numbered as drawn, and a line per numbered excerpt', async () => {
    await openStored(state('sources-only').layout);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Kopier svaret' }));
    });
    const markers = [{ marker: '1', chunkId: 'c1', documentId: '42' }];
    expect(clipboard).toEqual([answerCopy(answer, { sources: [source], markers }).text]);
    expect(clipboard[0]).toBe('Rapporteringen er fast [1].\n\nKilder\n[1] Tildelingsbrev 2022.');
  });

  it('copies an answer whose footnotes name only documents without them, with a line per document', async () => {
    draw(state('sources-only').layout, fakeApi().api);
    await ask();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Kopier svaret' }));
    });
    expect(clipboard).toEqual(['Rapporteringen er fast.\n\nKilder\nTildelingsbrev 2022.']);
  });

  it('offers «Kopier lenke til tråden» only where the thread is in the address, and copies a link that opens it', async () => {
    const { unmount } = draw(state('knowledge-assistant').layout, fakeApi().api);
    await ask();
    expect(screen.queryByRole('button', { name: 'Kopier lenke til tråden' })).toBeNull();
    unmount();
    history.replaceState(null, '', '/?t=t-old');
    draw(state('knowledge-assistant').layout, fakeApi().api, true);
    const copyLink = await screen.findByRole('button', { name: 'Kopier lenke til tråden' });
    await act(async () => {
      fireEvent.click(copyLink);
    });
    expect(clipboard).toEqual([new URL('/?t=t-old', location.href).href]);
  });
});

describe('Kilder in the next look', () => {
  const read = {
    index: 2,
    title: 'Årsrapport 2021',
    documentId: '43',
    excerpts: [{ chunkId: 'c2', text: 'Lest, men ikke brukt i svaret.' }],
  };
  const drawStored = (template: 'knowledge-assistant' | 'knowledge-assistant-next') => {
    const { api } = fakeApi();
    api.loadThread = vi.fn(async () => ({
      title: 'En gammel tråd',
      turns: [
        {
          id: 'm1',
          question: 'Hva er fast?',
          askedAt: 1,
          answer: {
            text: answer,
            status: 'complete' as const,
            sources: [read, source],
            markers: [{ marker: '1', chunkId: 'c1', documentId: '42' }],
            created: 2,
          },
        },
      ],
    }));
    history.replaceState(null, '', '/?t=t-old');
    draw(fromTemplate(template).layout, api, true);
  };
  const showKilder = async () => {
    await waitFor(() => expect(footnotes()).toHaveLength(1));
    const shown = screen.queryByRole('button', { name: 'Vis verktøypanelet' });
    if (shown) fireEvent.click(shown);
    const tab = screen.queryByRole('tab', { name: 'Kilder' });
    if (tab) fireEvent.click(tab);
  };
  const fold = () => document.querySelector<HTMLDetailsElement>('details.uib-sources-others');

  it('folds the sources the answer read but did not cite under «Andre kilder som ble lest (N)»', async () => {
    drawStored('knowledge-assistant-next');
    await showKilder();
    expect(fold()?.open).toBe(false);
    expect(fold()?.querySelector('summary')?.textContent).toBe('Andre kilder som ble lest (1)');
    expect(within(fold() as HTMLElement).getByRole('heading', { name: read.title })).toBeTruthy();
    const cited = screen.getByRole('list', { name: 'Utdrag svaret bygger på' });
    expect(within(cited).getByRole('heading', { name: source.title })).toBeTruthy();
    expect(within(cited).queryByRole('heading', { name: read.title })).toBeNull();
  });

  it('leaves «Kunnskapsassistenten»’s Kilder listing every source together', async () => {
    drawStored('knowledge-assistant');
    await showKilder();
    await screen.findByRole('heading', { name: read.title });
    expect(fold()).toBeNull();
  });
});

// genki takes feedback on a run, so the host is handed the run behind the answer it is on.
describe('feedback on an answer', () => {
  const withFeedback = withSetting(state('knowledge-assistant'), 'chat', 'feedback', true).layout;
  const drawWith = (api: AssistantApi, onFeedback: (feedback: AssistantFeedback) => void) =>
    render(
      <Assistant
        api={api}
        layout={withFeedback}
        service="ka"
        tenant="digdir"
        profile={{ assistantName: 'KA', suggestions: ['Hva er fast?'] }}
        threadInUrl
        onFeedback={onFeedback}
      />,
    );
  const rate = async () => {
    const group = await screen.findByRole('group', { name: 'Tilbakemelding på svaret' });
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Ja' }));
    });
    return group;
  };
  const withRun = (taskId?: string): AssistantApi => {
    const { api } = fakeApi();
    return {
      ...api,
      ask: async function* (): AsyncGenerator<StreamEvent, void> {
        yield { type: 'conversation', conversationId: 't-new' };
        yield { type: 'text', text: answer };
        yield {
          type: 'done',
          answer: {
            id: 'a1',
            text: answer,
            sources: [source],
            citations: [],
            noAnswer: false,
            ...(taskId ? { taskId } : {}),
          },
        };
      },
    };
  };

  it('hands the host the run id of an answer asked here, with the rating', async () => {
    const given: AssistantFeedback[] = [];
    drawWith(withRun('task-1'), (feedback) => void given.push(feedback));
    await ask();
    await rate();
    expect(given).toEqual([expect.objectContaining({ runId: 'task-1', rating: 'up' })]);
  });

  it('sends the rating on the click, and a comment after it as the whole feedback again', async () => {
    const given: AssistantFeedback[] = [];
    drawWith(withRun('task-1'), (feedback) => void given.push(feedback));
    await ask();
    const group = await rate();
    expect(given).toEqual([
      { answerId: expect.any(String), runId: 'task-1', rating: 'up', reasons: [], comment: '' },
    ]);
    await within(group).findByText('Takk!');

    fireEvent.change(within(group).getByRole('textbox', { name: 'Kommentar (valgfritt)' }), {
      target: { value: 'Godt svar' },
    });
    await act(async () => {
      fireEvent.click(within(group).getByRole('button', { name: 'Send' }));
    });
    expect(given).toHaveLength(2);
    expect(given[1]).toEqual({
      answerId: given[0]?.answerId,
      runId: 'task-1',
      rating: 'up',
      reasons: [],
      comment: 'Godt svar',
    });
    await within(group).findByText(
      'Takk! Tilbakemeldingen lagres for tjenesten, ikke for deg som person.',
    );
  });

  it('hands the host the run id of a stored answer in a thread opened again', async () => {
    const { api } = fakeApi();
    const stored = await api.loadThread('t-old');
    const turn = stored.turns[0];
    if (!turn?.answer) throw new Error('the fake thread has an answer');
    const given: AssistantFeedback[] = [];
    history.replaceState(null, '', '/?t=t-old');
    drawWith(
      {
        ...api,
        loadThread: async () => ({
          ...stored,
          turns: [{ ...turn, answer: { ...turn.answer, runId: 'task-old' } }],
        }),
      },
      (feedback) => void given.push(feedback),
    );
    await rate();
    expect(given).toEqual([expect.objectContaining({ answerId: 'm1', runId: 'task-old' })]);
  });

  it('still offers feedback without a run id, and leaves it out, so the host decides', async () => {
    const given: AssistantFeedback[] = [];
    drawWith(withRun(), (feedback) => void given.push(feedback));
    await ask();
    await rate();
    expect(given).toHaveLength(1);
    expect(given[0]).not.toHaveProperty('runId');
  });

  it('offers feedback in a layout straight from knowledge-assistant-next, with no option set by the host', async () => {
    const given: AssistantFeedback[] = [];
    render(
      <Assistant
        api={withRun('task-1')}
        layout={fromTemplate('knowledge-assistant-next').layout}
        service="ka"
        tenant="digdir"
        profile={{ assistantName: 'KA' }}
        threadInUrl
        onFeedback={(feedback) => void given.push(feedback)}
      />,
    );
    await ask();
    await rate();
    expect(given).toEqual([expect.objectContaining({ runId: 'task-1', rating: 'up' })]);
  });
});

describe('the page around the blocks', () => {
  it('is the chat everywhere without Innstillinger, even at its address', async () => {
    history.replaceState(null, '', '/#innstillinger');
    draw(turnOff(state('knowledge-assistant'), 'settings').layout, fakeApi().api, true);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(document.title).toBe('Ny tråd – KA');
    expect(screen.getByRole('link', { name: /Hopp til skrivefeltet/ })).toBeTruthy();
  });

  it('keeps no thread in the address without Tråder', async () => {
    history.replaceState(null, '', '/?t=t-old&layout=abc');
    draw(state('chat-only').layout, fakeApi().api, true);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    await waitFor(() => expect(location.search).toBe('?layout=abc'));
  });

  // The main column's headings, and the page's h1s that a reader can reach.
  const outline = () => {
    const main = document.querySelector('main');
    const shown = (element: Element) => element.closest('[hidden]') === null;
    return {
      h1s: [...document.querySelectorAll('h1')].filter(shown),
      first: [...(main?.querySelectorAll('h1, h2, h3, h4, h5, h6') ?? [])].find(shown),
    };
  };

  it('has one h1 with Chat in the right panel, first in the main column', async () => {
    draw(placeIn(state('sources-only'), 'chat', 'secondary').layout, fakeApi().api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/, hidden: true });
    expect(outline().h1s.map((h) => h.textContent)).toEqual(['KA']);
    expect(outline().first?.tagName).toBe('H1');
  });

  it('puts the h1 before the filter strip opened over Chat, and before Fremgangsmåte over it', async () => {
    const strip = placeIn(state('knowledge-assistant'), 'filter', 'main');
    const { unmount } = draw(strip.layout, fakeApi().api);
    fireEvent.click(await screen.findByRole('button', { name: 'Endre' }));
    await screen.findByRole('heading', { name: 'Filtrering' });
    expect(outline().h1s).toHaveLength(1);
    expect(outline().first?.tagName).toBe('H1');
    unmount();
    draw(placeIn(state('knowledge-assistant'), 'chat', 'secondary').layout, fakeApi().api);
    await screen.findByText('Fremgangsmåten vises her når du stiller et spørsmål.');
    expect(outline().h1s).toHaveLength(1);
    expect(outline().first?.tagName).toBe('H1');
  });

  it('names Fremgangsmåte by a heading at the head of the main column without Chat, as the secondary panel names it', async () => {
    const approachInMain = placeIn(state('knowledge-assistant'), 'chat', 'secondary');
    draw(approachInMain.layout, fakeApi().api);
    const note = await screen.findByText('Fremgangsmåten vises her når du stiller et spørsmål.');
    const region = screen.getByRole('region', { name: 'Fremgangsmåte' });
    expect(region.contains(note)).toBe(true);
    expect(within(region).getByRole('heading', { level: 2, name: 'Fremgangsmåte' })).toBeTruthy();
    // The column's head, after the page's h1 and before the rest of the column.
    const main = document.getElementById('main-content') as HTMLElement;
    expect(main.contains(region)).toBe(true);
    expect(
      [...main.querySelectorAll('h1, h2')].map((h) => `${h.tagName} ${h.textContent}`).slice(0, 2),
    ).toEqual(['H1 KA', 'H2 Fremgangsmåte']);
  });

  it('keeps the h1 while a document stands in the conversation’s place', async () => {
    const inMain = placeIn(
      turnOff(turnOn(state('sources-only'), 'document-view'), 'sources'),
      'document-view',
      'main',
    );
    const footnote = await openStored(inMain.layout);
    fireEvent.click(footnote);
    await screen.findByRole('heading', { level: 2, name: 'Dokumentvisning' });
    expect(outline().h1s).toHaveLength(1);
    expect(outline().first?.tagName).toBe('H1');
  });

  it('opens the panel Chat stands in from the start, as a drawer on a phone, so there is a field to ask in', async () => {
    window.matchMedia = ((media: string) => {
      const below = /\(width < (\d+(?:\.\d+)?)px\)/.exec(media);
      return {
        media,
        matches: below ? 390 < Number(below[1]) : false,
        addEventListener: () => {},
        removeEventListener: () => {},
      };
    }) as unknown as typeof window.matchMedia;
    Object.defineProperty(document.documentElement, 'clientWidth', {
      configurable: true,
      get: () => 390,
    });
    HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
      this.setAttribute('open', '');
    };
    HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
      this.removeAttribute('open');
    };
    draw(placeIn(state('sources-only'), 'chat', 'secondary').layout, fakeApi().api);
    const field = await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(field.closest('dialog')?.hasAttribute('open')).toBe(true);
  });

  it('names a panel of three tools as one phrase', async () => {
    const three = placeIn(turnOn(state('sources-only'), 'document-view'), 'approach', 'secondary');
    draw(three.layout, fakeApi().api);
    expect(
      await screen.findByRole('complementary', {
        name: 'Fremgangsmåte, kilder og dokumentvisning',
        hidden: true,
      }),
    ).toBeTruthy();
  });

  it('says in Fremgangsmåte’s panel that stored answers keep no steps, on a thread that has answers', async () => {
    await openStored(turnOn(state('approach-only'), 'sources').layout);
    expect(
      screen.getByText(
        'Fremgangsmåten lagres ikke med svarene i tråden. Den vises her når du stiller et nytt spørsmål.',
      ),
    ).toBeTruthy();
  });

  it('draws the collection’s line once when the strip’s filter is open', async () => {
    draw(placeIn(state('knowledge-assistant'), 'filter', 'main').layout, fakeApi().api);
    fireEvent.click(await screen.findByRole('button', { name: 'Endre' }));
    await screen.findByRole('heading', { name: 'Filtrering' });
    const strip = screen.getByRole('region', { name: 'Filter' });
    await waitFor(() =>
      expect(strip.querySelectorAll('.uib-corpus-line, [class*="corpus-line"]').length).toBe(1),
    );
  });

  it('starts at the standard level when a stored layout holds a level that does not exist', async () => {
    const layout = state('knowledge-assistant').layout;
    const zones = Object.fromEntries(
      Object.entries(layout.zones).map(([zone, placed]) => [
        zone,
        placed.map((block) =>
          block.block === 'approach' ? { ...block, settings: { level: 'x' } } : block,
        ),
      ]),
    ) as AssistantLayout['zones'];
    // Made once: the hook reads a new api or layout as a new setup.
    const options = {
      api: fakeApi().api,
      layout: { ...layout, zones },
      service: 'ka',
      tenant: 'digdir',
    };
    const { result } = renderHook(() => useAssistant(options));
    await waitFor(() => expect(result.current.facts).toBeDefined());
    expect(result.current.level).toBe('standard');
  });

  it('reads the collection’s values again when the collection changes, so another’s never leave a field out', async () => {
    const { api } = fakeApi();
    api.loadFields = vi.fn(async () => [
      { id: 'type', label: 'Dokumenttyper' },
      { id: 'year', label: 'År' },
    ]);
    // Both chosen types are every type in Kudos, and two of three in the other collection.
    api.loadFacets = vi.fn(async (_selection: unknown, dataset: string) => [
      {
        id: 'type',
        label: 'Dokumenttyper',
        options: [
          ...(dataset === 'kudos' ? [] : [{ value: 'Evaluering', count: 1 }]),
          { value: 'Årsrapport', count: 3 },
          { value: 'Tildelingsbrev', count: 2 },
        ],
      },
      { id: 'year', label: 'År', options: [{ value: '2024', count: 5 }] },
    ]);
    const kept = new Map<string, unknown>([
      ['corpus', 'genki-docs'],
      ['filter', { type: ['Årsrapport', 'Tildelingsbrev'] }],
    ]);
    const storage: AssistantStorage = {
      read: (key) => kept.get(key),
      write: (key, value) => void kept.set(key, value),
      remove: (key) => void kept.delete(key),
    };
    const ka = state('knowledge-assistant');
    const setup = (layout: AssistantLayout) => ({
      api,
      layout,
      service: 'ka',
      tenant: 'digdir',
      storage,
    });
    // Without the choice of collection, the service's own: Kudos.
    const { rerender } = renderHook((options) => useAssistant(options), {
      initialProps: setup(withSetting(ka, 'filter', 'corpus', false).layout),
    });
    await waitFor(() =>
      expect(api.loadFacets).toHaveBeenCalledWith(
        { type: [] },
        'kudos',
        expect.anything(),
        expect.anything(),
      ),
    );
    rerender(setup(ka.layout));
    await waitFor(() =>
      expect(api.loadFacets).toHaveBeenCalledWith(
        { type: ['Årsrapport', 'Tildelingsbrev'] },
        'genki-docs',
        expect.anything(),
        expect.anything(),
      ),
    );
  });

  it('offers in the picker the variants the facts count, one rule for both', async () => {
    const { api } = fakeApi();
    const kudos = rows[0]?._datasets;
    api.loadModels = vi.fn(async (): Promise<ModelRow[]> => [
      {
        id: 'ka__default',
        _service: 'ka',
        _variant_title: 'KA standard',
        _pickable: true,
        _chat: true,
        _datasets: kudos,
      },
      {
        id: 'ka__fast',
        _service: 'ka',
        _variant_title: 'KA rask',
        _pickable: true,
        _chat: true,
        _datasets: kudos,
      },
      {
        id: 'other__a',
        _service: 'other',
        _variant_title: 'Annen A',
        _pickable: true,
        _chat: true,
      },
      {
        id: 'other__b',
        _service: 'other',
        _variant_title: 'Annen B',
        _pickable: true,
        _chat: true,
      },
    ]);
    render(
      <Assistant
        api={api}
        layout={state('knowledge-assistant').layout}
        service="ka"
        tenant="digdir"
        profile={{ assistantName: 'KA', family: (other) => other === 'other' }}
      />,
    );
    await waitFor(() => expect(screen.getByText('Annen A', { exact: false })).toBeTruthy());
    expect(screen.getByText('Annen B', { exact: false })).toBeTruthy();
    expect(screen.queryByText('KA rask', { exact: false })).toBeNull();
  });

  it('keeps one observer on the docked field while an answer streams, rather than one per render', async () => {
    const Real = globalThis.ResizeObserver;
    const observed: Element[] = [];
    globalThis.ResizeObserver = class {
      observe(element: Element) {
        observed.push(element);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const docks = () => observed.filter((element) => element.classList.contains('uia-composer'));
    try {
      draw(state('knowledge-assistant').layout, fakeApi().api);
      await ask();
      const before = docks().length;
      expect(before).toBeGreaterThan(0);
      await typeInField('Hva mer er fast?');
      await pressSend();
      await waitFor(() => expect(document.querySelectorAll('.uib-answer')).toHaveLength(2));
      expect(docks()).toHaveLength(before);
    } finally {
      globalThis.ResizeObserver = Real;
    }
  });

  it('leaves the docked field’s room to the field’s own scroll margin, and pads the main column with nothing', async () => {
    // A ResizeObserver that reports at once, and every element 52 px tall.
    const Real = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      callback: ResizeObserverCallback;
      constructor(callback: ResizeObserverCallback) {
        this.callback = callback;
      }
      observe() {
        this.callback([], this as unknown as ResizeObserver);
      }
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    const height = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(52);
    // jsdom loads no stylesheet: the docked field reads as sticky, as the browser draws it.
    const real = window.getComputedStyle.bind(window);
    const styles = vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
      const style = real(element, pseudo);
      if (!element.classList.contains('uia-composer')) return style;
      return new Proxy(style, {
        get: (target, key) => {
          if (key === 'position') return 'sticky';
          const value: unknown = Reflect.get(target, key);
          return typeof value === 'function' ? (value as () => unknown).bind(target) : value;
        },
      });
    });
    try {
      draw(state('knowledge-assistant').layout, fakeApi().api);
      await ask();
      const field = document.querySelector<HTMLElement>('.uia-composer[data-sticky]');
      await waitFor(() =>
        expect(field?.parentElement?.style.getPropertyValue('--uib-composer-block-size')).toBe(
          '52px',
        ),
      );
      // Scroll padding would cover the field too, and in Chrome it also pulls a footnote that is
      // centred on the way back from Kilder up under the top of the column.
      const main = document.querySelector<HTMLElement>('main');
      expect(main).not.toBeNull();
      expect(main?.style.scrollPaddingBlockEnd).toBe('');
    } finally {
      styles.mockRestore();
      height.mockRestore();
      globalThis.ResizeObserver = Real;
    }
  });
});

// The same assistant on an English page, with English data, so any Norwegian is the assembly's.
describe('the assistant in English', () => {
  const english = () => {
    const { api } = fakeApi();
    const sourceEn = {
      index: 1,
      title: 'Allocation letter 2022',
      documentId: '42',
      excerpts: [{ chunkId: 'c1', text: 'Reporting happens every year.' }],
    };
    api.loadThreads = vi.fn(async () => [
      { id: 't-old', title: 'An old thread', updatedAt: Date.now(), service: 'ka' },
    ]);
    api.loadThread = vi.fn(async () => ({
      title: 'An old thread',
      turns: [
        {
          id: 'm1',
          question: 'What is fixed?',
          askedAt: 1,
          answer: {
            text: 'Reporting is fixed [1].',
            status: 'complete' as const,
            sources: [sourceEn],
            markers: [{ marker: '1', chunkId: 'c1', documentId: '42' }],
            created: 2,
          },
        },
      ],
    }));
    api.loadFields = vi.fn(async () => [{ id: 'type', label: 'Document types' }]);
    api.loadFacets = vi.fn(async () => [
      { id: 'type', label: 'Document types', options: [{ value: 'Annual report', count: 3 }] },
    ]);
    api.loadCorpora = vi.fn(async () => [{ key: 'kudos', label: 'Kudos' }]);
    return api;
  };
  const norwegian =
    /[æøåÆØÅ]|\b(?:Kilder|Endre|Lukk|Innstillinger|Hopp|Tekniske|Ingen|Legg|Uten|Fant|Kunne|Venter|Byttet|Avgrenset|Dokumentvisning|Spørsmål|Tråd)/;
  const words = () => [
    document.body.textContent ?? '',
    document.title,
    ...[...document.querySelectorAll('[aria-label]')].map(
      (e) => e.getAttribute('aria-label') ?? '',
    ),
  ];
  const drawEnglish = (layout: AssistantLayout) =>
    render(
      <InLocale locale="en">
        <Assistant
          api={english()}
          layout={layout}
          service="ka"
          tenant="digdir"
          profile={{ assistantName: 'KA' }}
          threadInUrl
        />
      </InLocale>,
    );

  it('draws every word of kunnskapsassistenten’s template in the reader’s language', async () => {
    history.replaceState(null, '', '/?t=t-old');
    drawEnglish(state('knowledge-assistant').layout);
    await waitFor(() =>
      expect(document.querySelector('.uib-answer')?.textContent).toContain('Reporting is fixed'),
    );
    expect(screen.getByRole('navigation', { name: 'Threads and filter' })).toBeTruthy();
    expect(document.title).toBe('An old thread – KA');
    expect(words().filter((text) => norwegian.test(text))).toEqual([]);
  });

  it('draws every word of the builder’s own arrangements in the reader’s language', async () => {
    const layout = placeIn(
      placeIn(turnOn(state('knowledge-assistant'), 'document-view'), 'filter', 'main'),
      'approach',
      'secondary',
    ).layout;
    drawEnglish(layout);
    fireEvent.click(await screen.findByRole('button', { name: 'Change' }));
    expect(
      screen.getByRole('complementary', {
        name: 'Approach, sources and document view',
        hidden: true,
      }),
    ).toBeTruthy();
    expect(screen.getByText('The approach shows here when you ask a question.')).toBeTruthy();
    expect(words().filter((text) => norwegian.test(text))).toEqual([]);
  });

  it('says a missing thread is missing in the reader’s language', async () => {
    history.replaceState(null, '', '/?t=t-gone');
    const api = english();
    api.loadThread = vi.fn(async () => {
      throw new HttpError(404, '404 Not Found');
    });
    render(
      <InLocale locale="en">
        <Assistant
          api={api}
          layout={state('knowledge-assistant').layout}
          service="ka"
          tenant="digdir"
          threadInUrl
        />
      </InLocale>,
    );
    expect(await screen.findByRole('heading', { name: 'Thread not found' })).toBeTruthy();
    expect(document.title).toMatch(/^Thread not found – /);
  });
});

describe('Fremgangsmåte as the card, the tool or both', () => {
  // genki's agent loop says how long each tool call took when the turn completes.
  const timedApi = () => {
    const fake = fakeApi();
    const plain = fake.api.ask;
    fake.api.ask = async function* (params) {
      for await (const event of plain(params)) {
        if (event.type === 'text' && params.steps)
          yield {
            type: 'step',
            step: {
              event: 'agent/turn-completed',
              'tool-calls': [
                { tool: 'search', 'duration-ms': 2400 },
                { tool: 'generate_response', 'duration-ms': 900 },
              ],
            },
          };
        yield event;
      }
    };
    return fake;
  };
  const inMain = () =>
    [...document.querySelectorAll('.uib-approach')].filter((one) => one.closest('main'));
  const inPanel = () =>
    [...document.querySelectorAll('.uib-approach')].filter((one) => one.closest('aside'));
  const times = (root: Element) =>
    [...root.querySelectorAll('.uib-approach-step-time')].map((time) => time.textContent);
  const frames = (root: Element) =>
    root.parentElement?.querySelector('.uia-frames') ? 'frames' : 'none';

  it('draws the card alone, as before, when Fremgangsmåte stands only in the main column', async () => {
    draw(state('knowledge-assistant').layout, timedApi().api);
    await ask();
    expect(inMain()).toHaveLength(1);
    expect(inPanel()).toHaveLength(0);
    expect(screen.queryByRole('tab', { name: 'Fremgangsmåte', hidden: true })).toBeNull();
    const [card] = inMain();
    if (!card) throw new Error('no card');
    expect(times(card)).toEqual([]);
    expect(card.querySelector('.uib-approach-footer')?.textContent).toMatch(
      /^Brukte 1 kilde · tok/,
    );
  });

  it('draws the tool alone, with each step’s time and the totals, when it stands only in the secondary panel', async () => {
    draw(turnOn(state('approach-only'), 'sources').layout, timedApi().api);
    await ask();
    expect(inMain()).toHaveLength(0);
    expect(inPanel()).toHaveLength(1);
    const [tool] = inPanel();
    if (!tool) throw new Error('no tool');
    expect(times(tool)).toEqual([' · 2,4 s', ' · 0,9 s']);
    expect(tool.querySelector('.uib-approach-footer')?.textContent).toMatch(
      /^Brukte 1 kilde · tok/,
    );
  });

  it('draws both when it stands in both, the card compact and the tool with the detail', async () => {
    const both = withSetting(
      placeIn(state('knowledge-assistant'), 'approach', 'both'),
      'approach',
      'level',
      'detailed',
    );
    draw(both.layout, timedApi().api);
    await ask();
    const [card] = inMain();
    const [tool] = inPanel();
    if (!card || !tool) throw new Error('not in both places');
    expect(card.closest('.uib-conversation')).not.toBeNull();
    expect(times(card)).toEqual([]);
    expect(frames(card)).toBe('none');
    expect(times(tool)).toEqual([' · 2,4 s', ' · 0,9 s']);
    expect(frames(tool)).toBe('frames');
    expect(screen.getByRole('tab', { name: 'Fremgangsmåte', hidden: true })).toBeTruthy();
  });

  it('keeps the frames in the card at the detailed level when the card stands alone', async () => {
    const alone = withSetting(state('knowledge-assistant'), 'approach', 'level', 'detailed');
    draw(alone.layout, timedApi().api);
    await ask();
    const [card] = inMain();
    if (!card) throw new Error('no card');
    expect(frames(card)).toBe('frames');
  });
});

describe('a year field’s values', () => {
  const noisy = ['12', '1985', '1990', '2025', '2026', '2027', '2252'];
  const setup = (fields: readonly FieldSpec[], chosen?: Record<string, string[]>) => {
    const { api } = fakeApi();
    api.loadFields = vi.fn(async () => fields);
    api.loadFacets = vi.fn(async () =>
      fields.map((field) => ({
        id: field.id,
        label: field.label,
        ...(field.kind ? { kind: field.kind } : {}),
        options: noisy.map((value) => ({ value, count: 1 })),
      })),
    );
    const kept = new Map<string, unknown>(chosen ? [['filter', chosen]] : []);
    const storage: AssistantStorage = {
      read: (key) => kept.get(key),
      write: (key, value) => void kept.set(key, value),
      remove: (key) => void kept.delete(key),
    };
    // Made once: the hook reads a new api or layout as a new setup.
    const options = {
      api,
      layout: state('knowledge-assistant').layout,
      service: 'ka',
      tenant: 'digdir',
      storage,
      now: () => new Date('2026-11-13T12:00:00Z'),
    };
    return renderHook(() => useAssistant(options)).result;
  };
  const valuesOf = (
    field: string,
    facets: readonly { id: string; options: readonly { value: string }[] }[] | undefined,
  ) => facets?.find((one) => one.id === field)?.options.map((option) => option.value);

  it('offers a year field 1900 up to this year, newest first, whatever else genki returns', async () => {
    const result = setup([
      { id: 'concerned_years', label: 'År', kind: 'year' },
      { id: 'pages', label: 'Sider' },
    ]);
    await waitFor(() => expect(result.current.facets).toBeDefined());
    expect(valuesOf('concerned_years', result.current.facets)).toEqual([
      '2026',
      '2025',
      '1990',
      '1985',
    ]);
    // A field that is not a year field keeps every value.
    expect(valuesOf('pages', result.current.facets)).toEqual(noisy);
  });

  it('keeps a chosen year outside the bounds listed when every year inside them is chosen too', async () => {
    const result = setup(
      [{ id: 'concerned_years', label: 'År', kind: 'year', years: { first: 2025 } }],
      { concerned_years: ['2252', '2025', '2026'] },
    );
    await waitFor(() =>
      expect(valuesOf('concerned_years', result.current.facets)).toEqual(['2252', '2026', '2025']),
    );
  });

  it('offers a year field the years its profile gives, and keeps a chosen value outside them', async () => {
    const result = setup(
      [{ id: 'concerned_years', label: 'År', kind: 'year', years: { first: 1990 } }],
      {
        concerned_years: ['2252'],
      },
    );
    await waitFor(() =>
      expect(valuesOf('concerned_years', result.current.facets)).toEqual([
        '2252',
        '2026',
        '2025',
        '1990',
      ]),
    );
  });
});

describe('in a host’s preview', () => {
  it('draws no `h1` and no main landmark of its own, since the page is the host’s', async () => {
    const { api } = fakeApi();
    render(
      <Assistant
        api={api}
        layout={fromTemplate('knowledge-assistant').layout}
        service="ka"
        tenant="digdir"
        profile={{ assistantName: 'KA', suggestions: ['Hva er fast?'] }}
        frameWidth={1280}
      />,
    );
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(screen.queryAllByRole('heading', { level: 1 })).toEqual([]);
    expect(screen.queryByRole('main')).toBeNull();
  });

  it('titles «Innstillinger» below the host’s own `h1`', async () => {
    const { api } = fakeApi();
    render(
      <Assistant
        api={api}
        layout={fromTemplate('knowledge-assistant').layout}
        service="ka"
        tenant="digdir"
        frameWidth={1280}
      />,
    );
    fireEvent.click(await screen.findByRole('link', { name: 'Innstillinger' }));
    expect(await screen.findByRole('heading', { level: 2, name: 'Innstillinger' })).toBeTruthy();
    expect(screen.queryAllByRole('heading', { level: 1 })).toEqual([]);
  });

  it('draws its name as the page’s `h1` on a page of its own', async () => {
    draw(fromTemplate('knowledge-assistant').layout, fakeApi().api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    expect(screen.getAllByRole('heading', { level: 1 }).map((h) => h.textContent)).toEqual(['KA']);
  });
});

// A service made in the builder has no host code: its words come with its layout.
describe('the profile a layout carries', () => {
  const data: ProfileData = {
    assistantName: 'Kunnskapsassistenten',
    suggestions: ['Hva handler dokumentene i Kudos om?'],
    settingsNote: 'Valgene huskes i denne nettleseren.',
  };
  const layout: AssistantLayout = { ...state('knowledge-assistant').layout, profile: data };

  it('draws the layout’s name, suggestions and settings note when the host passes no profile', async () => {
    render(<Assistant api={fakeApi().api} layout={layout} service="ka" tenant="digdir" />);
    expect(
      await screen.findByRole('textbox', { name: /Spørsmål til Kunnskapsassistenten/ }),
    ).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Hva handler dokumentene i Kudos om?' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('link', { name: 'Innstillinger' }));
    expect(await screen.findByText('Valgene huskes i denne nettleseren.')).toBeTruthy();
  });

  it('draws the host’s name over the layout’s, and the layout’s suggestions where the host gives none', async () => {
    render(
      <Assistant
        api={fakeApi().api}
        layout={layout}
        service="ka"
        tenant="digdir"
        profile={{ assistantName: 'KA' }}
      />,
    );
    expect(await screen.findByRole('textbox', { name: /Spørsmål til KA/ })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Kunnskapsassistenten/ })).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Hva handler dokumentene i Kudos om?' }),
    ).toBeTruthy();
  });

  it('hands on the host’s own profile when the layout carries none, and both together when it does', async () => {
    const family = (other: string) => other === 'other';
    const host: AssistantProfile = { assistantName: 'KA', family };
    // Made once: the hook reads a new api or layout as a new setup.
    const own = { api: fakeApi().api, layout: state('knowledge-assistant').layout };
    const carried = { api: fakeApi().api, layout };
    const hostOnly = renderHook(() =>
      useAssistant({ ...own, service: 'ka', tenant: 'digdir', profile: host }),
    ).result;
    const both = renderHook(() =>
      useAssistant({ ...carried, service: 'ka', tenant: 'digdir', profile: host }),
    ).result;
    await waitFor(() => expect(hostOnly.current.facts).toBeDefined());
    await waitFor(() => expect(both.current.facts).toBeDefined());
    expect(hostOnly.current.profile).toBe(host);
    expect(both.current.profile).toEqual({ ...data, assistantName: 'KA', family });
    expect(both.current.assistantName).toBe('KA');
  });
});
