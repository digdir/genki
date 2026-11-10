// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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

const preview = (
  client: ReturnType<typeof fakeClient>,
  layout: AssistantLayout,
  conversation = 0,
) => (
  <ServicePreview
    layout={layout}
    mode="try"
    address="byggesak.genki.no"
    run={{ api: client.api, tenant: 'eksempel', source: { definition } }}
    conversation={conversation}
    onMode={noop}
    onRemove={noop}
    onReload={noop}
  />
);

const tryOut = (layout: AssistantLayout, text = 'Ja, en garasje over 50 m² trenger søknad.') => {
  const client = fakeClient(answered(text));
  const view = render(preview(client, layout));
  return { ...client, restart: () => view.rerender(preview(client, layout, 1)) };
};

const ask = async (question: string) => {
  const field = await screen.findByRole('textbox', { name: /Spørsmål til Byggesaksveileder/ });
  fireEvent.change(field, { target: { value: question } });
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Send spørsmålet' }));
  });
};

const answer = /en garasje over 50 m² trenger søknad/;

describe('the try view', () => {
  it('draws the assistant the layout describes, and asks the draft through the playground', async () => {
    const { requests } = tryOut(defaultLayout);
    await ask('Trenger jeg søknad for en garasje?');
    expect(await screen.findByText(answer)).toBeTruthy();
    expect(requests[0]?.setup.service).toMatchObject({ id: 'byggesak', version: 'draft' });
    expect(requests[0]?.input).toEqual({ text: 'Trenger jeg søknad for en garasje?' });
  });

  it('shows the answer’s sources in the right panel, from the run', async () => {
    tryOut(defaultLayout);
    await ask('Trenger jeg søknad for en garasje?');
    const panel = await screen.findByRole('complementary', { name: 'Kilder og dokumentvisning' });
    await waitFor(() =>
      expect(within(panel).getAllByText('Plan- og bygningsloven').length).toBeGreaterThan(0),
    );
  });

  it('draws no right panel and no sources when the layout leaves them out', async () => {
    tryOut(fromTemplate('chat-only').layout);
    await ask('Trenger jeg søknad for en garasje?');
    await screen.findByText(answer);
    expect(screen.queryAllByRole('complementary')).toEqual([]);
    expect(screen.queryByText('Plan- og bygningsloven')).toBeNull();
  });

  it('starts the conversation again when asked to', async () => {
    const { restart } = tryOut(fromTemplate('chat-only').layout);
    await ask('Trenger jeg søknad for en garasje?');
    await screen.findByText(answer);
    restart();
    await screen.findByRole('textbox', { name: /Spørsmål til Byggesaksveileder/ });
    expect(screen.queryByText(answer)).toBeNull();
  });

  it('says what to do when the layout has no Chat, and shows no example content', async () => {
    tryOut({ version: 1, zones: { primary: [{ block: 'threads' }], main: [], secondary: [] } });
    expect(await screen.findByText('Legg Chat i innholdet for å prøve assistenten.')).toBeTruthy();
    expect(screen.queryByText(/Eksempelinnhold/)).toBeNull();
  });
});
