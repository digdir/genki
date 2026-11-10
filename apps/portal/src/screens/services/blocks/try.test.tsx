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

describe('a draft the playground cannot run yet', () => {
  it('says what the draft lacks, in the portal’s words, above the try view', async () => {
    const client = fakeClient(() => [
      {
        event: 'failed',
        setup: 'setup',
        problem: {
          status: 422,
          title: 'Invalid setup',
          errors: [
            {
              path: 'setup.spec.purpose',
              message: 'Too small: expected string to have >=1 characters',
            },
          ],
        },
      },
    ]);
    render(preview(client, defaultLayout));
    await ask('Trenger jeg søknad for en garasje?');
    const notice = await screen.findByText(/Oppsettet er ikke klart til å prøves ennå\./);
    expect(notice.closest('.service-preview-frame')).toBeNull();
  });
});

describe('this visit’s threads', () => {
  it('are kept when the try view is drawn again, as when the window turns narrow', async () => {
    const client = fakeClient(answered('Ja.'));
    const threadsOnly = fromTemplate('approach-only').layout;
    const first = render(preview(client, threadsOnly));
    await ask('Trenger jeg søknad for en garasje?');
    await screen.findByRole('link', { name: /Trenger jeg søknad for en garasje/ });
    first.unmount();
    render(preview(client, threadsOnly));
    expect(
      await screen.findByRole('link', { name: /Trenger jeg søknad for en garasje/ }),
    ).toBeTruthy();
  });
});

describe('a run of the draft that fails', () => {
  it('says why in the platform’s words above the try view', async () => {
    const client = fakeClient(() => [
      {
        event: 'failed',
        setup: 'setup',
        problem: {
          status: 502,
          title: 'Tjenesten feilet underveis.',
          detail: 'the service has no dataset to search',
        },
      },
    ]);
    render(preview(client, fromTemplate('chat-only').layout));
    await ask('Trenger jeg søknad for en garasje?');
    const notice = await screen.findByText(
      'Tjenesten feilet underveis. the service has no dataset to search',
    );
    expect(notice.closest('.service-preview-frame')).toBeNull();
  });
});
