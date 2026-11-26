// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { fromTemplate, type AssistantLayout, type ProfileData } from '@genai/ui-blocks/builder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useBlocksState } from './BlocksStep';
import { definition, fakeClient, answered } from './draft.test-utils';
import { draftStart, layoutJson, readLayout } from './layoutStore';
import { ServicePreview } from './ServicePreview';
import { TemplatesPanel } from './TemplatesPanel';

beforeEach(() => {
  window.matchMedia = ((media: string) => ({
    media,
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  })) as unknown as typeof window.matchMedia;
  Element.prototype.scrollIntoView ??= () => {};
  Element.prototype.scrollTo ??= () => {};
  document.getAnimations ??= () => [];
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  sessionStorage.clear();
});
afterEach(cleanup);

const profile = (): ProfileData | null =>
  JSON.parse(
    screen.getByRole('status', { name: 'Profilen' }).textContent ?? 'null',
  ) as ProfileData | null;

describe('the words kept with the layout', () => {
  it("keeps a published service's Tekster words in its layout when another template is picked", () => {
    const words = { assistantName: 'Byggehjelpen', suggestions: ['Trenger jeg søknad?'] };
    const Templates = () => {
      const blocks = useBlocksState(() => ({
        layout: { ...fromTemplate('knowledge-assistant').layout, profile: words },
        template: 'knowledge-assistant',
      }));
      return (
        <>
          <TemplatesPanel current={blocks.template} onPick={blocks.pick} />
          <output aria-label="Profilen">{JSON.stringify(blocks.layout.profile ?? null)}</output>
        </>
      );
    };
    render(<Templates />);
    fireEvent.click(screen.getByRole('button', { name: 'Bruk Bare samtale' }));
    expect(profile()).toEqual(words);
  });

  it('go with «Kopier oppsettet» and «Lim inn oppsett»', () => {
    const layout = {
      ...fromTemplate('chat-only').layout,
      profile: { assistantName: 'Byggehjelpen', suggestions: ['Trenger jeg søknad?'] },
    };
    expect(readLayout(layoutJson(layout))).toEqual({ layout });
  });

  it('are opened from the draft past a limit, as typed, so a reload does not lose the layout', () => {
    const layout = {
      ...fromTemplate('chat-only').layout,
      profile: { assistantName: 'x'.repeat(81) },
    };
    const start = draftStart(layout);
    expect(start !== 'foreign' && start?.layout.profile).toEqual({ assistantName: 'x'.repeat(81) });
    // A pasted layout past a limit is still refused, with why.
    expect(readLayout(layoutJson(layout))).toMatchObject({ problem: 'breaks-rules' });
  });
});

describe('a layout in the draft that pins a block by ref', () => {
  it('is left to the YAML, since the builder would lose the ref', () => {
    const layout = fromTemplate('chat-only').layout;
    const pinned = {
      ...layout,
      zones: {
        ...layout.zones,
        main: layout.zones.main.map((placed) => ({ ...placed, ref: '991825827/chat@1' })),
      },
    };
    expect(draftStart(layout)).not.toBe('foreign');
    expect(draftStart(pinned)).toBe('foreign');
  });

  it('is refused when pasted, since the builder would lose the ref', () => {
    const layout = fromTemplate('chat-only').layout;
    const pinned = {
      ...layout,
      zones: {
        ...layout.zones,
        main: layout.zones.main.map((placed) => ({ ...placed, ref: '991825827/chat@1' })),
      },
    };
    expect(readLayout(layoutJson(pinned))).toEqual({ problem: 'pins-a-block' });
  });
});

describe('the try view', () => {
  const preview = (layout: AssistantLayout, client: ReturnType<typeof fakeClient>) => (
    <ServicePreview
      layout={layout}
      mode="try"
      address="byggesak.genki.no"
      run={{ api: client.api, tenant: 'eksempel', source: { definition } }}
      onMode={() => undefined}
      onRemove={() => undefined}
    />
  );

  it('draws the edited name, suggestions and a field’s label', async () => {
    const client = fakeClient(answered('Ja.'));
    const base = fromTemplate('knowledge-assistant').layout;
    const { rerender } = render(preview(base, client));
    await screen.findByRole('textbox', { name: /Spørsmål til Byggesaksveileder/ });
    const edited: AssistantLayout = {
      ...base,
      profile: {
        assistantName: 'Byggehjelpen',
        suggestions: ['Trenger jeg søknad for en garasje?', ''],
        corpora: { byggeregler: { fields: [{ id: 'kommune', label: 'Kommunene' }] } },
      },
    };
    await act(async () => {
      rerender(preview(edited, client));
    });
    expect(await screen.findByRole('textbox', { name: /Spørsmål til Byggehjelpen/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Trenger jeg søknad for en garasje?' })).toBeTruthy();
    // An empty suggestion draws no button.
    expect(screen.queryByRole('button', { name: '' })).toBeNull();
    await waitFor(() => expect(screen.getAllByText('Kommunene').length).toBeGreaterThan(0), {
      timeout: 3000,
    });
  });
});
