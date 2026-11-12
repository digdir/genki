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
  type AssistantLayout,
  type BuilderState,
  type ModelRow,
} from '@genai/ui-blocks';
import type { AnswerMarker, StreamEvent } from '@genai/client';
import { InLocale } from '@genai/i18n/react';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGenkiApi, HttpError, type AskParams, type AssistantApi } from './api.js';
import { Assistant } from './Assistant.js';
import type { AssistantProfile } from './profile.js';
import { browserStorage, type AssistantStorage } from './storage.js';
import { useAssistant } from './useAssistant.js';

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

const ask = async (question?: string) => {
  await send(question);
  await screen.findByText(/Rapporteringen er fast/);
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
    drawKa(storage, kaLayout, api);
    // Kept: the facets are asked for the stored filter, without the field that is not all strings.
    await waitFor(() =>
      expect(api.loadFacets).toHaveBeenCalledWith(
        { type: ['Årsrapport'] },
        'kudos',
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
    drawNext(reader, { ...nextLayout, zones: { ...nextLayout.zones, secondary: [] } });
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

  it('shows the folded panel as its button and one button per tool, which opens it on that tool (dev-verktoy-4)', async () => {
    drawNext();
    await opened();
    const tools = screen.getByRole('complementary', { name: 'Verktøypanelet' });
    const rail = tools.querySelector<HTMLElement>('.uib-shell-rail');
    if (!rail) throw new Error('The folded panel shows no tools');
    expect([...rail.querySelectorAll('button')].map((b) => b.getAttribute('aria-label'))).toEqual([
      'Fremgangsmåte',
      'Kilder',
    ]);
    fireEvent.click(within(rail).getByRole('button', { name: 'Kilder' }));
    expect(screen.getByRole('button', { name: 'Skjul verktøypanelet' })).toBeTruthy();
    expect(within(tools).getByRole('tab', { name: 'Kilder' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(tools.querySelector('.uib-shell-rail')).toBeNull();
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
    fireEvent.click(await screen.findByRole('link', { name: 'En gammel tråd' }));
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
      fireEvent.click(await screen.findByRole('link', { name: 'En gammel tråd' }));
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
        (screen.getByRole('button', { name: 'Send spørsmålet' }) as HTMLButtonElement).disabled,
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

  it('says under the field how many documents the next question reads from, and its values', async () => {
    drawNext(counted().api);
    await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
    await waitFor(() =>
      expect(note()).toBe('Neste spørsmål leser fra 5 dokumenter – endres i filteret til venstre'),
    );
    await tick(/^Årsrapport/);
    await waitFor(() =>
      expect(note()).toBe(
        'Neste spørsmål leser fra 3 dokumenter · Årsrapport – endres i filteret til venstre',
      ),
    );
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

  it('brings back a thread’s last filter when the thread is opened again', async () => {
    drawNext(counted().api);
    fireEvent.click(await screen.findByRole('link', { name: 'En gammel tråd' }));
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
