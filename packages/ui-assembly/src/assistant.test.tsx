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
    loadCorpora: vi.fn(async () => [{ key: 'kudos', label: 'Kudos' }]),
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
    const options = screen.getAllByRole('option', { hidden: true }).map((o) => o.textContent);
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
});
