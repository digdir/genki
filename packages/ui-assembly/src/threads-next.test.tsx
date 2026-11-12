// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { fromTemplate, type ModelRow } from '@genai/ui-blocks';
import type { StreamEvent } from '@genai/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantApi } from './api.js';
import { Assistant } from './Assistant.js';

// The dev-trader board's thread list, behind `knowledge-assistant-next`; «Kunnskapsassistenten»
// keeps its own. A fake genki: one variant, one collection with a filter field, one stored thread.
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

const api: AssistantApi = {
  loadModels: vi.fn(async () => rows),
  loadThreads: vi.fn(async () => [
    { id: 't-old', title: 'En gammel tråd', updatedAt: Date.now(), service: 'ka' },
  ]),
  loadThread: vi.fn(async () => ({ title: 'En gammel tråd', turns: [] })),
  loadCorpora: vi.fn(async () => [{ key: 'kudos', label: 'Kudos' }]),
  loadFields: vi.fn(async () => [{ id: 'type', label: 'Dokumenttyper' }]),
  loadFacets: vi.fn(async () => []),
  loadAbout: vi.fn(async () => undefined),
  // eslint-disable-next-line require-yield -- nothing is asked in these tests
  ask: async function* (): AsyncGenerator<StreamEvent, void> {
    return;
  },
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

const draw = (template: 'knowledge-assistant' | 'knowledge-assistant-next') =>
  render(
    <Assistant
      api={api}
      layout={fromTemplate(template).layout}
      service="ka"
      tenant="digdir"
      profile={{ assistantName: 'KA' }}
      threadInUrl
    />,
  );
const list = () => document.querySelector<HTMLElement>('.uib-threads');

describe('the thread list in kunnskapsassistenten’s next look', () => {
  it('draws the design’s list: «Ny tråd» first, no search, no way to the filter', async () => {
    draw('knowledge-assistant-next');
    const nav = screen.getByRole('navigation', { name: 'Tråder og filter' });
    await within(nav).findByRole('link', { name: 'En gammel tråd' });
    expect(list()?.getAttribute('data-variant')).toBe('nav');
    expect(within(nav).queryByRole('searchbox')).toBeNull();
    expect(within(nav).queryByRole('button', { name: 'Filtrer dokumenter' })).toBeNull();
    expect(list()?.firstElementChild?.textContent).toBe('Ny tråd');
  });

  it('stays on «Tråder» after «Ny tråd», since the filter is not in this panel', async () => {
    draw('knowledge-assistant-next');
    const nav = screen.getByRole('navigation', { name: 'Tråder og filter' });
    await within(nav).findByRole('link', { name: 'En gammel tråd' });
    fireEvent.click(within(nav).getByRole('link', { name: 'Ny tråd' }));
    expect(within(nav).getByRole('link', { name: 'En gammel tråd' })).toBeTruthy();
    expect(within(nav).queryByRole('button', { name: 'Tråder' })).toBeNull();
  });

  it('leaves «Kunnskapsassistenten» its own list: the search, the way to the filter, the links', async () => {
    draw('knowledge-assistant');
    fireEvent.click(await screen.findByRole('button', { name: /Tråder/ }));
    const nav = screen.getByRole('navigation', { name: 'Tråder og filter' });
    await within(nav).findByRole('link', { name: 'En gammel tråd' });
    expect(list()?.hasAttribute('data-variant')).toBe(false);
    expect(within(nav).getByRole('searchbox', { name: 'Søk i tråder' })).toBeTruthy();
    expect(within(nav).getByRole('button', { name: 'Filtrer dokumenter' })).toBeTruthy();
  });
});
