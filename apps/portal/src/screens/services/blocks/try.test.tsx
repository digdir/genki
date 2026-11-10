// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { defaultLayout, fromTemplate, type AssistantLayout } from '@genai/ui-blocks/builder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { answered, definition, fakeClient } from './draft.test-utils';
import { ServicePreview } from './ServicePreview';

// A wide window, so the assistant's panels stand beside its main column.
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
});
afterEach(cleanup);

const noop = () => undefined;

const tryOut = (layout: AssistantLayout, text = 'Ja, en garasje over 50 m² trenger søknad.') => {
  const client = fakeClient(answered(text));
  render(
    <ServicePreview
      layout={layout}
      mode="try"
      address="byggesak.genki.no"
      run={{ api: client.api, tenant: 'eksempel', source: { definition } }}
      conversation={0}
      onMode={noop}
      onRemove={noop}
      onReload={noop}
    />,
  );
  return client;
};

const ask = async (question: string) => {
  const field = await screen.findByRole('textbox', { name: /Spørsmål til Byggesaksveileder/ });
  fireEvent.change(field, { target: { value: question } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send spørsmålet' }));
  });
};

describe('the try view', () => {
  it('draws the assistant the layout describes, and asks the draft through the playground', async () => {
    const { requests } = tryOut(defaultLayout);
    await ask('Trenger jeg søknad for en garasje?');
    expect(await screen.findByText(/en garasje over 50 m² trenger søknad/)).toBeTruthy();
    expect(requests[0]?.setup.service).toMatchObject({ id: 'byggesak', version: 'draft' });
    expect(requests[0]?.input).toEqual({ text: 'Trenger jeg søknad for en garasje?' });
  });

  it('shows the answer’s sources in Kilder, from the run', async () => {
    tryOut(defaultLayout);
    await ask('Trenger jeg søknad for en garasje?');
    await waitFor(() =>
      expect(screen.getAllByText('Plan- og bygningsloven').length).toBeGreaterThan(0),
    );
  });

  it('draws no Kilder when the layout leaves it out', async () => {
    tryOut(fromTemplate('chat-only').layout);
    await ask('Trenger jeg søknad for en garasje?');
    await screen.findByText(/en garasje over 50 m² trenger søknad/);
    expect(screen.queryByRole('complementary', { name: 'Kilder' })).toBeNull();
  });

  it('says what to do when the layout has no Chat, and shows no example content', async () => {
    tryOut({ version: 1, zones: { primary: [{ block: 'threads' }], main: [], secondary: [] } });
    expect(await screen.findByText('Legg Chat i innholdet for å prøve assistenten.')).toBeTruthy();
    expect(screen.queryByText(/Eksempelinnhold/)).toBeNull();
  });
});
