// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { defaultLayout, fromTemplate, type AssistantLayout } from '@genai/ui-blocks/builder';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiError } from '../../../api/error';
import type { PlaygroundStreamEvent } from '../../../api/playground';
import { answered, definition, fakeClient, gate, result } from './draft.test-utils';
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

  it('shows only the refusal’s reason: no failed answer, no missing thread, and no thread kept', async () => {
    const client = fakeClient(() => {
      throw new ApiError(422, {
        type: 'about:blank',
        title: 'Invalid setup',
        status: 422,
        errors: [{ path: 'setup.spec.purpose', message: 'Too small' }],
      });
    });
    render(preview(client, fromTemplate('knowledge-assistant-next').layout));
    await ask('Trenger jeg søknad for en garasje?');
    await screen.findByText(/Oppsettet er ikke klart til å prøves ennå\./);
    const frame = document.querySelector('.service-preview-frame') as HTMLElement;
    await within(frame).findByRole('textbox', { name: /Spørsmål til Byggesaksveileder/ });
    expect(within(frame).queryByText('Fant ikke tråden')).toBeNull();
    expect(within(frame).queryByText('Tråden har ingen meldinger ennå')).toBeNull();
    expect(within(frame).queryByText('Svaret kom ikke fram')).toBeNull();
    expect(
      within(frame).queryByText(/Trenger jeg søknad for en garasje/, { selector: 'p' }),
    ).toBeNull();
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

describe('answers in more than one thread', () => {
  const threadsAndChat: AssistantLayout = {
    version: 1,
    zones: { primary: [{ block: 'threads' }], main: [{ block: 'chat' }], secondary: [] },
  };
  const delta = (text: string): PlaygroundStreamEvent => ({
    event: 'delta',
    setup: 'setup',
    text,
    channel: 'answer',
  });
  const finished: PlaygroundStreamEvent = {
    event: 'done',
    quota: { usedPercent: 0, monthlyTokens: 0 },
  };
  const failed: PlaygroundStreamEvent = {
    event: 'failed',
    setup: 'setup',
    problem: { status: 502, title: 'Tjenesten feilet underveis.' },
  };
  const refused: PlaygroundStreamEvent = {
    event: 'failed',
    setup: 'setup',
    problem: {
      status: 422,
      title: 'Invalid setup',
      errors: [{ path: 'setup.spec.purpose', message: 'Too small' }],
    },
  };
  const notReady = /Oppsettet er ikke klart til å prøves ennå\./;
  const failure = 'Tjenesten feilet underveis.';
  // Each question's run, by its text.
  const runs = (byQuestion: Record<string, readonly (PlaygroundStreamEvent | Promise<void>)[]>) =>
    fakeClient((request) =>
      'text' in request.input ? (byQuestion[request.input.text ?? ''] ?? []) : [],
    );
  // Every event up to the next gate is read, and what it changes drawn, before the test goes on.
  const release = (held: { open: () => void }) =>
    act(async () => {
      held.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  const answerText = () =>
    [...document.querySelectorAll('.uib-answer-text')].map((text) => text.textContent).join(' ');
  const newThread = async () => {
    // «Ny tråd» is «Start din første tråd» while the list is empty.
    const link = await screen.findByRole('link', { name: /^(Ny tråd|Start din første tråd)$/ });
    await act(async () => {
      fireEvent.click(link);
    });
  };
  const open = async (name: RegExp) => {
    const link = await screen.findByRole('link', { name });
    await act(async () => {
      fireEvent.click(link);
    });
  };

  it('shows why an answer failed over its own thread only, not over the thread the reader went to', async () => {
    const first = gate();
    render(
      preview(runs({ 'Første spørsmål': [delta('Første '), first.shut, failed] }), threadsAndChat),
    );
    await ask('Første spørsmål');
    await waitFor(() => expect(answerText()).toContain('Første'));
    await newThread();
    await release(first);
    expect(screen.queryByText(failure)).toBeNull();
    await open(/Første spørsmål/);
    expect(await screen.findByText(failure)).toBeTruthy();
  });

  it('keeps why an answer failed over its thread when an answer in another thread comes', async () => {
    const first = gate();
    render(
      preview(
        runs({
          'Første spørsmål': [delta('Første '), first.shut, result('Første svar.'), finished],
          'Andre spørsmål': [delta('Andre '), failed],
        }),
        threadsAndChat,
      ),
    );
    await ask('Første spørsmål');
    await waitFor(() => expect(answerText()).toContain('Første'));
    await newThread();
    await ask('Andre spørsmål');
    await screen.findByText(failure);
    await release(first);
    expect(screen.getByText(failure)).toBeTruthy();
  });

  it('shows no refusal of a question over the answer to one asked after it', async () => {
    const first = gate();
    render(
      preview(
        runs({
          'Første spørsmål': [first.shut, refused],
          'Andre spørsmål': [delta('Andre '), result('Andre svar.'), finished],
        }),
        threadsAndChat,
      ),
    );
    await ask('Første spørsmål');
    await newThread();
    await ask('Andre spørsmål');
    await waitFor(() => expect(answerText()).toBe('Andre svar.'));
    await release(first);
    expect(screen.queryByText(notReady)).toBeNull();
  });

  it('shows the playground’s refusal over every thread until the next question goes', async () => {
    const held = gate();
    render(
      preview(
        runs({
          'Første spørsmål': [delta('Første '), result('Første svar.'), finished],
          'Andre spørsmål': [refused],
          'Tredje spørsmål': [delta('Tredje '), held.shut, result('Tredje svar.'), finished],
        }),
        threadsAndChat,
      ),
    );
    await ask('Første spørsmål');
    await waitFor(() => expect(answerText()).toBe('Første svar.'));
    await newThread();
    await ask('Andre spørsmål');
    await screen.findByText(notReady);
    await open(/Første spørsmål/);
    await waitFor(() => expect(answerText()).toBe('Første svar.'));
    expect(screen.getByText(notReady)).toBeTruthy();
    await ask('Tredje spørsmål');
    await waitFor(() => expect(screen.queryByText(notReady)).toBeNull());
    await release(held);
  });

  it('lets the answers in other threads go on when the playground refuses the question on screen', async () => {
    const first = gate();
    render(
      preview(
        runs({
          'Første spørsmål': [delta('Første '), first.shut, result('Første svar.'), finished],
          'Andre spørsmål': [refused],
        }),
        threadsAndChat,
      ),
    );
    await ask('Første spørsmål');
    await waitFor(() => expect(answerText()).toContain('Første'));
    await newThread();
    await ask('Andre spørsmål');
    expect(await screen.findByText(notReady)).toBeTruthy();
    await release(first);
    await open(/Første spørsmål/);
    await waitFor(() => expect(answerText()).toBe('Første svar.'));
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

  it('takes why away once the thread’s next question is on its way', async () => {
    const held = gate();
    let runs = 0;
    const client = fakeClient(() => {
      runs += 1;
      return runs === 1
        ? [
            { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
            { event: 'failed', setup: 'setup', problem: { status: 502, title: 'Feilet.' } },
          ]
        : [
            { event: 'delta', setup: 'setup', text: 'Ja', channel: 'answer' },
            held.shut,
            result('Ja.'),
            { event: 'done', quota: { usedPercent: 0, monthlyTokens: 0 } },
          ];
    });
    render(preview(client, fromTemplate('chat-only').layout));
    await ask('Trenger jeg søknad for en garasje?');
    const again = await screen.findByRole('button', { name: 'Prøv igjen' });
    expect(screen.getByText('Feilet.')).toBeTruthy();
    await act(async () => {
      fireEvent.click(again);
    });
    await waitFor(() => expect(screen.queryByText('Feilet.')).toBeNull());
    expect(runs).toBe(2);
    await act(async () => {
      held.open();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  });
});
