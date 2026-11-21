// @vitest-environment jsdom
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import {
  blockCatalogue,
  fromTemplate,
  type AssistantLayout,
  type ModelRow,
  type PlacedBlock,
} from '@genai/ui-blocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AssistantApi } from './api.js';
import { Assistant } from './Assistant.js';
import { blockRegistry, resolveBlock } from './registry.js';

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
  loadThreads: vi.fn(async () => []),
  loadThread: vi.fn(async () => ({ title: '', turns: [] })),
  loadCorpora: vi.fn(async () => [{ key: 'kudos', label: 'Kudos' }]),
  loadFields: vi.fn(async () => [{ id: 'type', label: 'Dokumenttyper' }]),
  loadFacets: vi.fn(async () => []),
  loadAbout: vi.fn(async () => undefined),
  ask: async function* () {},
};

const draw = (layout: AssistantLayout) =>
  render(
    <Assistant
      api={api}
      layout={layout}
      service="ka"
      tenant="digdir"
      profile={{ assistantName: 'KA' }}
    />,
  );

const pinned = (layout: AssistantLayout): AssistantLayout => ({
  ...layout,
  zones: {
    primary: layout.zones.primary.map((p) => ({ ...p, ref: `991825827/${p.block}@1` })),
    main: layout.zones.main.map((p) => ({ ...p, ref: `991825827/${p.block}@1` })),
    secondary: layout.zones.secondary.map((p) => ({ ...p, ref: `991825827/${p.block}@1` })),
  },
});

const withEntry = (
  layout: AssistantLayout,
  zone: 'primary' | 'main' | 'secondary',
  entry: object,
) => ({
  ...layout,
  zones: { ...layout.zones, [zone]: [...layout.zones[zone], entry as PlacedBlock] },
});

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

describe('the block registry', () => {
  it('has a built-in block for every built catalogue block, and none for a planned one', () => {
    expect([...blockRegistry.keys()]).toEqual(
      blockCatalogue.filter((spec) => spec.status === 'built').map((spec) => spec.id),
    );
  });

  it('resolves an entry that pins a Block definition by ref to the built-in block it names', () => {
    expect(resolveBlock({ block: 'chat', ref: '991825827/chat@1' })).toMatchObject({
      kind: 'built-in',
      block: { id: 'chat' },
    });
  });

  it("resolves a host's own block without a ref to nothing, so it is not drawn, as before", () => {
    expect(resolveBlock({ block: 'x-ka-glossary' } as unknown as PlacedBlock)).toBeUndefined();
  });

  it.each(['knowledge-assistant', 'knowledge-assistant-next'] as const)(
    'draws the %s layout pinned by ref exactly as it draws it by id',
    async (template) => {
      const settled = async (layout: AssistantLayout) => {
        const { container, unmount } = draw(layout);
        await screen.findByRole('textbox', { name: /^(Spørsmål til KA|Still et spørsmål)$/ });
        await waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
        const ids = new Map<string, string>();
        const html = container.innerHTML.replace(/_r_[0-9a-z]+_/g, (id) => {
          if (!ids.has(id)) ids.set(id, `id-${ids.size}`);
          return ids.get(id) ?? id;
        });
        unmount();
        return html;
      };
      const layout = fromTemplate(template).layout;

      expect(await settled(pinned(layout))).toBe(await settled(layout));
    },
  );

  it('draws a placeholder in the main column for a ref this host has no component for, and keeps Chat beside it', async () => {
    draw(
      withEntry(fromTemplate('knowledge-assistant').layout, 'main', {
        block: 'kart',
        ref: '991825827/kart@2',
      }),
    );

    const main = await screen.findByRole('main');
    expect(within(main).getByRole('heading', { name: 'Blokken kan ikke vises' })).toBeTruthy();
    expect(
      within(main).getByText('Denne verten har ingen innebygd blokk for 991825827/kart@2.'),
    ).toBeTruthy();
    expect(within(main).getByRole('textbox', { name: 'Spørsmål til KA' })).toBeTruthy();
  });

  it('draws a placeholder as a tool of the secondary panel for a ref this host has no component for', async () => {
    draw(
      withEntry(fromTemplate('chat-only').layout, 'secondary', {
        block: 'kart',
        ref: '991825827/kart@2',
      }),
    );

    const panel = await screen.findByRole('complementary', { hidden: true });
    expect(
      within(panel).getByText('Denne verten har ingen innebygd blokk for 991825827/kart@2.'),
    ).toBeTruthy();
  });

  it('draws a placeholder in the primary panel for a ref this host has no component for, also without one', async () => {
    draw(
      withEntry(fromTemplate('chat-only').layout, 'primary', {
        block: 'notes',
        ref: '991825827/notes@1',
      }),
    );

    const panel = await screen.findByRole('navigation', { hidden: true });
    expect(
      within(panel).getByText('Denne verten har ingen innebygd blokk for 991825827/notes@1.'),
    ).toBeTruthy();
  });

  it("draws a placeholder under the primary panel's blocks for a ref this host has no component for", async () => {
    draw(
      withEntry(fromTemplate('knowledge-assistant').layout, 'primary', {
        block: 'notes',
        ref: '991825827/notes@1',
      }),
    );

    const panel = await screen.findByRole('navigation', { hidden: true });
    expect(
      within(panel).getByText('Denne verten har ingen innebygd blokk for 991825827/notes@1.'),
    ).toBeTruthy();
    expect(within(panel).getAllByText('Filtrering').length).toBeGreaterThan(0);
  });
});
