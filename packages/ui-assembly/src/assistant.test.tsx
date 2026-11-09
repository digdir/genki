// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  fromTemplate,
  placeIn,
  turnOff,
  turnOn,
  type AssistantLayout,
  type BuilderState,
  type ModelRow,
} from '@genai/ui-blocks';
import type { StreamEvent } from '@genai/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AskParams, AssistantApi } from './api.js';
import { Assistant } from './Assistant.js';
import type { AssistantProfile } from './profile.js';
import { browserStorage, type AssistantStorage } from './storage.js';

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

const fakeApi = () => {
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
        answer: { id: 'a1', text: answer, sources: [source], citations: [], noAnswer: false },
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

const ask = async (question = 'Hva er fast?') => {
  const field = await screen.findByRole('textbox', { name: /Spørsmål til KA/ });
  // The service's collection must be known before the question can go.
  await waitFor(() => expect(screen.getByRole('button', { name: 'Send spørsmålet' })).toBeTruthy());
  fireEvent.change(field, { target: { value: question } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send spørsmålet' }));
  });
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
    expect(document.querySelector('.uib-procedure-card')).not.toBeNull();
  });

  it('asks for no steps without Fremgangsmåte, and draws none', async () => {
    const { api, asked } = fakeApi();
    draw(state('sources-only').layout, api);
    await ask();
    expect(asked[0]?.steps).toBe(false);
    expect(document.querySelector('.uib-procedure-card')).toBeNull();
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
    draw(state('without-filter').layout, api);
    expect(await screen.findByRole('link', { name: /En gammel tråd/ })).toBeTruthy();
    expect(screen.queryByRole('link', { name: /En annen tjenestes tråd/ })).toBeNull();
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
  const profile: AssistantProfile = {
    assistantName: 'KA',
    signedInAs: 'Testidentitet: test',
    settingsNote: 'Valgene huskes i denne nettleseren.',
    experiments: [
      { id: 'year-ranges', title: 'Årsfilter med perioder' },
      { id: 'filters-right-panel', title: 'Filtreringen i høyre panel' },
    ],
  };
  const drawKa = (storage: AssistantStorage, layout = kaLayout) =>
    render(
      <Assistant
        api={fakeApi().api}
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

  it('keeps the filter, and forgets it, the trials and the collection on «Logg ut»', async () => {
    const { kept, storage } = memory();
    storage.write('filter', { type: ['Årsrapport'], bad: [1] });
    storage.write('flags', ['year-ranges']);
    storage.write('corpus', 'kudos');
    drawKa(storage);
    fireEvent.click(await screen.findByRole('button', { name: /Tråder/ }));
    const signOut = await screen.findByRole('link', { name: 'Logg ut' });
    signOut.addEventListener('click', (event) => event.preventDefault());
    fireEvent.click(signOut);
    expect([...kept.keys()]).toEqual([]);
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

  it('asks a question from the document in the thread, as any question', async () => {
    const { api, asked } = fakeApi();
    const footnote = await stored(withoutSources().layout, api);
    fireEvent.click(footnote);
    const field = await screen.findByRole('textbox', { name: 'Spør om dette dokumentet' });
    fireEvent.change(field, { target: { value: 'Hvor ofte rapporteres det?' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Spør' }));
    });
    await waitFor(() => expect(asked).toHaveLength(1));
    expect(asked[0]?.question).toBe('Hvor ofte rapporteres det?');
    expect(asked[0]?.conversationId).toBe('t-old');
    expect(await screen.findByText('Hvor ofte rapporteres det?')).toBeTruthy();
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
