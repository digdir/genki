// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from './api';
import { App } from './App';
import { mockLogin } from './auth';
import { caseworker, mockWorkspaceApi } from './mock';
import { expectAccessible, renderApp } from './testing';
import type { FeedbackInput, WorkspaceApi } from './types';

document.getAnimations ??= () => [];

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

const conversation = () => screen.getByRole('list', { name: 'Samtale' });

const firstFeedback = () =>
  within(conversation()).getAllByRole('group', {
    name: 'Tilbakemelding på svaret',
  })[0] as HTMLElement;

describe('chat', () => {
  it('keeps the privacy hint generic so it fits any service', async () => {
    await renderApp('#/chat');
    expect(await screen.findByText('Ikke skriv navn eller andre personopplysninger.')).toBeTruthy();
    expect(document.body.textContent).not.toContain('om søkere');
  });

  it('says answers are made by AI, where data is processed and links to how data is handled', async () => {
    await renderApp('#/chat');
    const notice = await screen.findByText(/Svarene lages av KI\./);
    const alert = notice.closest('.ds-alert') as HTMLElement;
    expect(alert.textContent).toContain(
      'Spørsmål og svar behandles i Norge, av språkmodellen Borealis-27B hos AIVAR.',
    );
    const link = within(alert).getByRole('link', { name: 'Slik behandles data' });
    expect(link.getAttribute('href')).toMatch(/\/#\/data-handling$/);
    expect(link.getAttribute('href')).not.toContain('example.no');
  });

  it('shows each source as a link with its version, date and a collapsible excerpt', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      chat: async () => ({
        text: 'Ventetida gjekk ned [1].',
        sources: [
          {
            title: 'Årsrapport 2025',
            url: 'https://kudos.dfo.no/dokument/48211',
            excerpt: 'Ventetida på telefon gjekk ned til fire minutt.',
            version: '3',
            publishedAt: '2026-03-01',
          },
          { title: 'Internt notat' },
        ],
      }),
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    fireEvent.change(await screen.findByRole('textbox', { name: /^Still et spørsmål/ }), {
      target: { value: 'Kva seier rapportane?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    const link = await screen.findByRole('link', { name: 'Årsrapport 2025' });
    expect(link.getAttribute('href')).toBe('https://kudos.dfo.no/dokument/48211');
    const item = link.closest('li') as HTMLElement;
    expect(item.textContent).toContain('versjon 3, 1. mars 2026');
    const details = item.querySelector('details') as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(item).getByText('Utdrag')).toBeTruthy();
    expect(details.textContent).toContain('Ventetida på telefon gjekk ned til fire minutt.');
    expect(screen.queryByRole('link', { name: 'Internt notat' })).toBeNull();
    expect(screen.getByText('Internt notat')).toBeTruthy();
    expect(within(conversation()).getByText('Svar laget med KI')).toBeTruthy();
  });

  it('marks a paused service, does not pick it and lets no one ask it', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [
        { id: 'a', name: 'Gammel assistent', paused: true },
        { id: 'b', name: 'Klarspråk' },
      ],
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    const select = (await screen.findByRole('combobox', { name: 'Tjeneste' })) as HTMLSelectElement;
    expect(select.value).toBe('b');
    const paused = within(select).getByRole('option', { name: 'Gammel assistent (satt på pause)' });
    expect((paused as HTMLOptionElement).disabled).toBe(true);
    cleanup();

    const only: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [{ id: 'a', name: 'Gammel assistent', paused: true }],
    };
    await renderApp('#/chat', { api: only, initialMessages: [] });
    expect(
      await screen.findByText('Satt på pause: Modellen tjenesten bruker er tatt ut av bruk'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('explains why a service is paused, in the picker and when it is the only one', async () => {
    const reason = 'Modellen er byttet ut. Tjenesten må publiseres med en ny modell.';
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [
        { id: 'a', name: 'Gammel assistent', paused: true, pausedReason: reason },
        { id: 'b', name: 'Klarspråk' },
      ],
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    const list = await screen.findByRole('list', { name: 'Tjenester satt på pause' });
    expect(list.textContent).toBe(`Gammel assistent er satt på pause: ${reason}`);
    cleanup();

    const only: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [
        { id: 'a', name: 'Gammel assistent', paused: true, pausedReason: reason },
      ],
    };
    await renderApp('#/chat', { api: only, initialMessages: [] });
    expect(await screen.findByText(`Satt på pause: ${reason}`)).toBeTruthy();
  });

  it('marks a nynorsk answer as nynorsk while it streams', async () => {
    let finish: () => void = () => undefined;
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      chat: async (_service, _history, onText) => {
        onText?.('Eg veit ikkje kva fristen er.');
        await new Promise<void>((resolve) => (finish = resolve));
        return { text: 'Eg veit ikkje kva fristen er.', sources: [] };
      },
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    fireEvent.change(await screen.findByLabelText(/Still et spørsmål/), {
      target: { value: 'Kva er fristen?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const streamed = await screen.findByText('Eg veit ikkje kva fristen er.');
    expect(streamed.closest('[lang]')?.getAttribute('lang')).toBe('nn');
    expect(document.querySelector('.chat > [role="status"]')?.textContent).toBe('');
    finish();
    await waitFor(() =>
      expect(document.querySelector('.chat > [role="status"]')?.textContent).toBe(
        'Svaret er klart.',
      ),
    );
  });

  it('shows the date of a source that has no version', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      chat: async () => ({
        text: 'Ventetida gjekk ned.',
        task: 't-1',
        sources: [{ title: 'Årsrapport 2025', publishedAt: '2026-03-01T00:00:00Z' }],
      }),
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    fireEvent.change(await screen.findByLabelText(/Still et spørsmål/), {
      target: { value: 'Kva seier rapportane?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    const source = (await screen.findByText('Årsrapport 2025')).closest('li') as HTMLElement;
    expect(source.textContent).toBe('Årsrapport 2025 · 1. mars 2026');
  });

  it('tags every answer as made with AI, lists sources and marks nynorsk text with lang="nn"', async () => {
    await renderApp('#/chat');
    await screen.findByRole('list', { name: 'Samtale' });
    expect(within(conversation()).getAllByText('Svar laget med KI')).toHaveLength(2);
    expect(
      screen.getByRole('link', { name: 'Årsrapport 2025, side 21' }).closest('ol'),
    ).toBeTruthy();
    const nynorskQuestion = screen.getByText('Kva seier rapportane om ventetida på telefon?');
    expect(nynorskQuestion.closest('[lang]')?.getAttribute('lang')).toBe('nn');
    const nynorskAnswer = screen.getByText(/Ventetida på telefon gjekk ned/);
    expect(nynorskAnswer.closest('[lang]')?.getAttribute('lang')).toBe('nn');
    expect(
      screen
        .getByText(/Evalueringene peker på tre ting/)
        .closest('[lang]')
        ?.getAttribute('lang'),
    ).toBe('nb');
    expect(within(conversation()).getAllByText('Du skrev:', { exact: false })).toHaveLength(2);
  });

  it('records a thumbs down with reasons and a comment for the service, not the person', async () => {
    const sent: FeedbackInput[] = [];
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      sendFeedback: async (input) => {
        sent.push(input);
      },
    };
    const { container } = await renderApp('#/chat', { api });
    await screen.findByRole('list', { name: 'Samtale' });
    const group = firstFeedback();
    const yes = within(group).getByRole('button', { name: 'Ja' });
    const no = within(group).getByRole('button', { name: 'Nei' });
    expect(yes.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(yes);
    expect(yes.getAttribute('aria-pressed')).toBe('true');
    expect(within(group).queryByRole('group', { name: 'Hva var galt? (valgfritt)' })).toBeNull();

    fireEvent.click(no);
    expect(no.getAttribute('aria-pressed')).toBe('true');
    expect(yes.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(within(group).getByRole('checkbox', { name: 'Mangler kilde' }));
    fireEvent.change(within(group).getByRole('textbox', { name: 'Kommentar (valgfritt)' }), {
      target: { value: 'Mangler årstall' },
    });
    expect(within(group).getByText('15 av 300 tegn. Ikke skriv personopplysninger.')).toBeTruthy();
    expectAccessible(container);

    fireEvent.click(within(group).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(within(group).getByRole('status').textContent).toBe(
        'Takk! Tilbakemeldingen lagres for tjenesten, ikke for deg som person.',
      ),
    );
    expect(sent).toEqual([
      { task: 'task-a1', rating: 'down', reasons: ['Mangler kilde'], comment: 'Mangler årstall' },
    ]);
    expect(no.getAttribute('aria-disabled')).toBe('true');
    expect(within(group).queryByRole('textbox')).toBeNull();
  });

  it('sends only the rating when the person skips the details', async () => {
    const sendFeedback = vi.fn(async () => undefined);
    await renderApp('#/chat', { api: { ...mockWorkspaceApi(), sendFeedback } });
    await screen.findByRole('list', { name: 'Samtale' });
    const group = firstFeedback();
    fireEvent.click(within(group).getByRole('button', { name: 'Ja' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Hopp over' }));
    await waitFor(() => expect(within(group).getByRole('status').textContent).toBe('Takk!'));
    expect(sendFeedback).toHaveBeenCalledWith({
      task: 'task-a1',
      rating: 'up',
      reasons: [],
      comment: '',
    });
  });

  it('tells the person when feedback could not be sent', async () => {
    await renderApp('#/chat', {
      api: {
        ...mockWorkspaceApi(),
        sendFeedback: async () => {
          throw new Error('offline');
        },
      },
    });
    await screen.findByRole('list', { name: 'Samtale' });
    const group = firstFeedback();
    fireEvent.click(within(group).getByRole('button', { name: 'Ja' }));
    fireEvent.click(within(group).getByRole('button', { name: 'Send' }));
    await waitFor(() =>
      expect(within(group).getByRole('status').textContent).toBe(
        'Tilbakemeldingen ble ikke sendt. Prøv igjen om litt.',
      ),
    );
  });

  it('asks for a question before sending and links the error to the field', async () => {
    const { container } = await renderApp('#/chat');
    const field = await screen.findByRole('textbox', { name: 'Still et spørsmål om rapportene' });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Skriv et spørsmål.')).toBeTruthy();
    expect(field.getAttribute('aria-invalid')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toContain('question-error');
    expect(document.activeElement).toBe(field);
    expectAccessible(container);
  });

  it('streams a new answer with sources into the conversation', async () => {
    await renderApp('#/chat');
    const field = await screen.findByRole('textbox', { name: 'Still et spørsmål om rapportene' });
    fireEvent.change(field, { target: { value: 'Oppsummer tilsynsrapportene fra 2025.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Oppsummer tilsynsrapportene fra 2025.')).toBeTruthy();
    await screen.findByText(/Tilsynene i 2025 fant oftest mangler/);
    expect(screen.getByRole('link', { name: 'Tilsynsrapport 2025/12, side 3' })).toBeTruthy();
    expect(within(conversation()).getAllByText('Svar laget med KI')).toHaveLength(3);
    expect((field as HTMLTextAreaElement).value).toBe('');
  });

  it('shows a table answer as a summary that opens the table with its sources', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      chat: async () => ({
        text: 'Mål,Mål (kilde)',
        sources: [],
        csv: 'Mål,Mål (kilde)',
        table: {
          title: 'Måloppnåelse',
          columns: [
            { key: 'doc', label: 'Dokument' },
            { key: 'goal', label: 'Mål' },
          ],
          rows: [
            {
              cells: {
                doc: {
                  value: 'Årsrapport Digdir 2024',
                  sources: [{ document: 'd1', title: 'Årsrapport Digdir 2024' }],
                },
                goal: {
                  value: 'Felles løsninger',
                  sources: [
                    {
                      chunkId: 'c1',
                      title: 'Årsrapport Digdir 2024',
                      url: 'https://kudos.dfo.no/a',
                    },
                  ],
                },
              },
            },
          ],
          skipped: [{ index: 1, document: { document: 'd2', title: 'Tildelingsbrev DFØ' } }],
        },
      }),
    };
    const { container } = await renderApp('#/chat', { api, initialMessages: [] });
    const field = await screen.findByRole('textbox', { name: 'Still et spørsmål om rapportene' });
    fireEvent.change(field, { target: { value: 'Lag oversikten' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    await within(conversation()).findByText('Måloppnåelse');
    expect(within(conversation()).getByText('1 rad, 1 kunne ikke leses')).toBeTruthy();
    expect(within(conversation()).queryByText('Mål,Mål (kilde)')).toBeNull();
    expect(within(conversation()).getByText('Svar laget med KI')).toBeTruthy();
    expectAccessible(container);

    fireEvent.click(
      within(conversation()).getByRole('button', { name: 'Åpne tabellen med kilder' }),
    );

    expect(await screen.findByRole('heading', { level: 1, name: 'Måloppnåelse' })).toBeTruthy();
    const region = screen.getByRole('region', { name: 'Måloppnåelse' });
    expect(within(region).getByRole('columnheader', { name: /Mål/ })).toBeTruthy();
    expect(
      within(region).getAllByRole('button', {
        name: 'Kilde 1 for Årsrapport Digdir 2024, Årsrapport Digdir 2024',
      }),
    ).toHaveLength(2);
    expect(within(region).getByText('Tildelingsbrev DFØ')).toBeTruthy();
    expect(within(region).getByText('Feilet')).toBeTruthy();
  });

  it.each([
    ['marked by the API', { text: '', noAnswer: true }],
    ['with no text', { text: '' }],
  ])('says no answer was found, with the sources, for an answer %s', async (_label, reply) => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      chat: async () => ({ ...reply, sources: [{ title: 'Veileder om KI' }] }),
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    const field = await screen.findByRole('textbox', { name: 'Still et spørsmål om rapportene' });
    fireEvent.change(field, { target: { value: 'Hva er de ti budene for KI?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));

    expect(await within(conversation()).findByText('Fant ikke noe svar i kildene')).toBeTruthy();
    expect(within(conversation()).queryByText('Svar laget med KI')).toBeNull();
    expect(within(conversation()).getByText('Veileder om KI')).toBeTruthy();
  });

  it('shows a model outage in plain words and retries the same question', async () => {
    let calls = 0;
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      chat: async (_service, history) => {
        calls += 1;
        if (calls === 1) return { text: '', sources: [], failure: { kind: 'unavailable' } };
        return { text: `Svar på: ${history[history.length - 1]?.content}`, sources: [] };
      },
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    const field = await screen.findByRole('textbox', { name: 'Still et spørsmål om rapportene' });
    fireEvent.change(field, { target: { value: 'Hva sier evalueringene om chat?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Språkmodellen svarer ikke akkurat nå');
    expect(within(conversation()).queryByRole('group')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await screen.findByText('Svar på: Hva sier evalueringene om chat?');
    expect(screen.queryByText('Språkmodellen svarer ikke akkurat nå')).toBeNull();
  });

  it('shows an error with retry when the services cannot be listed', async () => {
    let fail = true;
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => {
        if (fail) throw new Error('down');
        return [{ id: 'ka__default', name: 'ka__default' }];
      },
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    await screen.findByText('Kunne ikke hente tjenestene dine');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await screen.findByRole('textbox', { name: 'Still et spørsmål' });
    expect(screen.getByText(/behandles av Fellesløsning for generativ KI/)).toBeTruthy();
  });

  it('lets the person pick a service when they have more than one', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [
        { id: 'a', name: 'Rapportassistenten' },
        { id: 'b', name: 'Klarspråk' },
      ],
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    const select = await screen.findByRole('combobox', { name: 'Tjeneste' });
    fireEvent.change(select, { target: { value: 'b' } });
    expect(screen.getAllByText('Klarspråk').length).toBeGreaterThan(0);
  });

  it('opens on the service the person chose last time', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [
        { id: 'a', name: 'Rapportassistenten' },
        { id: 'b', name: 'Klarspråk' },
      ],
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    fireEvent.change(await screen.findByRole('combobox', { name: 'Tjeneste' }), {
      target: { value: 'b' },
    });
    cleanup();
    await renderApp('#/chat', { api, initialMessages: [] });
    const select = (await screen.findByRole('combobox', { name: 'Tjeneste' })) as HTMLSelectElement;
    expect(select.value).toBe('b');
  });

  it('keeps the text typed before and after switching service', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => [
        { id: 'a', name: 'Rapportassistenten' },
        { id: 'b', name: 'Klarspråk' },
      ],
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    const select = await screen.findByRole('combobox', { name: 'Tjeneste' });
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Første utkast' } });
    fireEvent.change(select, { target: { value: 'b' } });
    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Første utkast');
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Skrevet etter byttet' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tjeneste' }), {
      target: { value: 'a' },
    });
    await waitFor(() =>
      expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe(
        'Skrevet etter byttet',
      ),
    );
  });

  it('shows the AI label only on real answers, not above a model error', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      chat: async () => ({ text: '', sources: [], failure: { kind: 'unavailable' } }),
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    fireEvent.change(await screen.findByRole('textbox'), { target: { value: 'Hei' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Språkmodellen svarer ikke akkurat nå');
    expect(within(conversation()).queryByText('Svar laget med KI')).toBeNull();
  });

  it('sends the person to log in again when the session has expired', async () => {
    let loggedOut = 0;
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => {
        throw new ApiError(401, { error: 'invalid_token' });
      },
    };
    const auth = mockLogin(caseworker);
    await auth.login();
    const logout = auth.logout?.bind(auth);
    auth.logout = async () => {
      loggedOut += 1;
      await logout?.();
    };
    window.location.hash = '#/chat';
    render(<App auth={auth} api={api} />);
    expect(await screen.findByText('Du er logget ut.')).toBeTruthy();
    expect(screen.getByText('Økten din er utløpt. Logg inn igjen for å fortsette.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Logg inn' })).toBeTruthy();
    expect(screen.queryByText('Kunne ikke hente tjenestene dine')).toBeNull();
    expect(loggedOut).toBe(1);
  });

  it('keeps the error alert in its own box so the icon does not cover the text', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      listServices: async () => {
        throw new Error('down');
      },
    };
    await renderApp('#/chat', { api, initialMessages: [] });
    const title = await screen.findByText('Kunne ikke hente tjenestene dine');
    const alert = title.closest('.ds-alert') as HTMLElement;
    expect(alert.classList.contains('state')).toBe(false);
  });
  it('starts a new conversation and lists earlier ones', async () => {
    const calls: { service: string; conversation?: { id?: string } | undefined }[] = [];
    const base = mockWorkspaceApi();
    const api: WorkspaceApi = {
      ...base,
      chat: async (service, history, onDelta, signal, input, conversation) => {
        calls.push({ service, conversation });
        const reply = await base.chat(service, history, onDelta, signal, input);
        return { ...reply, conversationId: 'samtale-1' };
      },
      conversations: {
        list: async () => [
          {
            id: 'samtale-0',
            title: 'Ventetid på telefon',
            agentId: 'rapportassistenten',
            created: '',
          },
          { id: 'x', title: 'Annen tjeneste', agentId: 'klarsprak', created: '' },
        ],
        messages: async () => [
          { id: 'saved-0', role: 'user', text: 'Hva er ventetida?', lang: 'nb' },
          { id: 'saved-1', role: 'assistant', text: 'Fire minutter.', lang: 'nb', sources: [] },
        ],
      },
    };
    await renderApp('#/chat', { api, initialMessages: [] });

    await screen.findByRole('button', { name: 'Ny samtale' });
    const field = await screen.findByRole('textbox', { name: 'Still et spørsmål om rapportene' });
    fireEvent.change(field, { target: { value: 'Hva er nytt?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Hva er nytt?');
    await waitFor(() => expect(calls).toHaveLength(1));
    expect(calls[0]?.conversation).toEqual({});

    fireEvent.change(screen.getByRole('textbox', { name: 'Still et spørsmål om rapportene' }), {
      target: { value: 'Og så?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls).toHaveLength(2));
    expect(calls[1]?.conversation).toEqual({ id: 'samtale-1' });

    fireEvent.click(screen.getByText('Tidligere samtaler'));
    expect(screen.queryByText('Annen tjeneste')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Ventetid på telefon' }));
    await screen.findByText('Fire minutter.');

    fireEvent.click(screen.getByRole('button', { name: 'Ny samtale' }));
    expect(screen.queryByText('Fire minutter.')).toBeNull();
  });
  it('keeps the conversation when the person switches service and back', async () => {
    await renderApp('#/chat', { initialMessages: [] });
    const field = await screen.findByRole('textbox', { name: 'Still et spørsmål om rapportene' });
    fireEvent.change(field, { target: { value: 'Hva er nytt?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Hva er nytt?');

    fireEvent.change(screen.getByRole('combobox', { name: 'Tjeneste' }), {
      target: { value: 'maloppnaelse__default' },
    });
    await screen.findByRole('heading', { level: 1, name: 'Vurdering av måloppnåelse' });
    fireEvent.change(screen.getByRole('combobox', { name: 'Tjeneste' }), {
      target: { value: 'rapportassistenten' },
    });

    expect(await screen.findByText('Hva er nytt?')).toBeTruthy();
  });
});
