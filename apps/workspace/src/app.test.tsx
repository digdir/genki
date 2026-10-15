// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import type { AuthClient } from './auth';
import type { Session, WorkspaceApi } from './types';
import {
  caseworker,
  exampleDraft,
  exampleGoalTable,
  mockApprovalsApi,
  mockWorkspaceApi,
} from './mock';
import { tableFrom, type ResultTable } from './ResultTable';
import { expectAccessible, renderApp } from './testing';

document.getAnimations ??= () => [];

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('a locked environment', () => {
  it('tells a TestID login that changes, models and ingestion need an Entra login', async () => {
    await renderApp('', { api: { ...mockWorkspaceApi(), lockdown: async () => true } });

    expect(
      await screen.findByText(
        'Låst testmiljø: du kan se deg rundt, men endringer, modeller og innlesing krever innlogging med Entra ID.',
      ),
    ).toBeTruthy();
  });

  it('shows no banner when the environment is not locked', async () => {
    await renderApp('', { api: { ...mockWorkspaceApi(), lockdown: async () => false } });

    expect(await screen.findByText('KI-arbeidsflaten')).toBeTruthy();
    expect(screen.queryByText(/Låst testmiljø/)).toBeNull();
  });
});

describe('workspace shell', () => {
  it('has a skip link, the agency, the person menu and the views as links', async () => {
    const { container } = await renderApp('');
    expect(screen.getByRole('link', { name: 'Hopp til hovedinnhold' }).getAttribute('href')).toBe(
      '#hovedinnhold',
    );
    expect(screen.getByText('Testetaten')).toBeTruthy();
    expect(screen.getByText('KI-arbeidsflaten')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Per Hansen, åpne brukermeny' })).toBeTruthy();
    const nav = screen.getByRole('navigation', { name: 'Arbeidsflaten' });
    expect(
      within(nav)
        .getAllByRole('link')
        .map((l) => l.textContent),
    ).toEqual(['Samtale', 'Prosjekter', 'Til godkjenning', 'Feilmeldinger', 'Dokumentutkast']);
    expect(within(nav).getByRole('link', { name: 'Samtale' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' }),
    ).toBeTruthy();
    expect(screen.getByRole('main').getAttribute('id')).toBe('hovedinnhold');
    expectAccessible(container);
  });

  it('switches view from the links and keeps the conversation', async () => {
    await renderApp('#/chat');
    const field = await screen.findByRole('textbox', { name: 'Still et spørsmål om rapportene' });
    fireEvent.change(field, { target: { value: 'Hva er nytt?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await screen.findByText('Hva er nytt?');
    window.location.hash = '#/document';
    await screen.findByRole('article');
    expect(screen.getByRole('link', { name: 'Dokumentutkast' }).getAttribute('aria-current')).toBe(
      'page',
    );
    window.location.hash = '#/chat';
    await screen.findByText('Hva er nytt?');
  });

  it('sets the written standard for answers in the person menu, for this person only', async () => {
    const saved: string[] = [];
    const api = {
      ...mockWorkspaceApi(),
      setWrittenStandard: async (_tenant: string, value: string) => {
        saved.push(value);
      },
    } as WorkspaceApi;
    const { container } = await renderApp('#/chat', { api });
    fireEvent.click(screen.getByRole('button', { name: 'Per Hansen, åpne brukermeny' }));
    const menu = screen.getByRole('dialog', { name: 'Brukermeny' });
    const group = within(menu).getByRole('group', { name: 'Målform i svarene dine' });
    expect(within(group).getByRole('radio', { name: 'Samme som spørsmålet' })).toHaveProperty(
      'checked',
      true,
    );
    expect(within(menu).getByText(/Gjelder bare deg\./)).toBeTruthy();
    expectAccessible(container);

    fireEvent.click(within(group).getByRole('radio', { name: 'Nynorsk' }));

    expect(await screen.findByText('Svarene dine skrives nå på nynorsk.')).toBeTruthy();
    expect(saved).toEqual(['nynorsk']);
    expect(screen.queryByRole('dialog', { name: 'Brukermeny' })).toBeNull();
  });

  it('logs in on start and offers a retry when login fails', async () => {
    let fail = true;
    const auth: AuthClient = {
      current: () => undefined,
      login: async () => {
        if (fail) throw new Error('no');
        return { ...caseworker, token: 't' };
      },
    };
    render(
      <App
        auth={auth}
        api={mockWorkspaceApi()}
        approvals={mockApprovalsApi()}
        draft={exampleDraft}
      />,
    );
    await screen.findByText('Innloggingen mislyktes');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await screen.findByRole('link', { name: 'Samtale' });
  });

  it('shows the person, logs out and logs in again', async () => {
    let session: Session | undefined;
    let logins = 0;
    const auth: AuthClient = {
      current: () => session,
      login: async () => {
        logins += 1;
        session = {
          name: 'Ingrid Berg',
          organisations: [{ orgNumber: '405003309', name: 'Testdepartementet' }],
          token: 't',
        };
        return session;
      },
      logout: async () => {
        session = undefined;
      },
    };
    render(
      <App
        auth={auth}
        api={mockWorkspaceApi()}
        approvals={mockApprovalsApi()}
        draft={exampleDraft}
      />,
    );
    expect(await screen.findByText('Testdepartementet')).toBeTruthy();
    expect(screen.getByText('Ingrid Berg')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Ingrid Berg, åpne brukermeny' }));
    fireEvent.click(screen.getByRole('button', { name: 'Logg ut' }));

    await screen.findByText('Du er logget ut.');
    expect(logins).toBe(1);
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));
    await screen.findByText('Testdepartementet');
    expect(logins).toBe(2);
  });

  it('names the organisation in the header, never "Virksomheten · intranett"', async () => {
    const login = (organisations: Session['organisations']): AuthClient => {
      const session: Session = { name: 'Ola', organisations, token: 't' };
      return { current: () => session, login: async () => session };
    };
    render(
      <App
        auth={login([{ orgNumber: '991825827', name: '991825827' }])}
        api={mockWorkspaceApi()}
      />,
    );
    expect(await screen.findByText('Org.nr. 991 825 827')).toBeTruthy();
    cleanup();

    render(<App auth={login([])} api={mockWorkspaceApi()} />);
    expect(await screen.findByText('Fellesløsning for generativ KI')).toBeTruthy();
    expect(screen.queryByText(/Virksomheten|intranett/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Prosjekter' })).toBeNull();
  });
  it('hides Projects and Errors and names the role when the person lacks the right to use services', async () => {
    const api: WorkspaceApi = { ...mockWorkspaceApi(), rights: async () => [] };
    await renderApp('', { api });
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Prosjekter' })).toBeNull());
    expect(screen.queryByRole('link', { name: 'Feilmeldinger' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Per Hansen, åpne brukermeny' }));
    expect(screen.getByText('Uten tilgang til tjenester, Testetaten')).toBeTruthy();
  });

  it('shows the service owner role for people who manage services', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      rights: async () => ['use-services', 'manage-services'],
    };
    await renderApp('', { api });
    await screen.findByRole('heading', { level: 1, name: 'Rapportassistenten' });
    fireEvent.click(screen.getByRole('button', { name: 'Per Hansen, åpne brukermeny' }));
    await screen.findByText('Tjenesteansvarlig, Testetaten');
    expect(screen.getByRole('link', { name: 'Prosjekter' })).toBeTruthy();
  });

  it('says there is no organisation in the menu and hides the tenant pages for a person without one', async () => {
    const session: Session = { name: 'Maake', organisations: [], token: 't' };
    render(
      <App
        auth={{ current: () => session, login: async () => session }}
        api={mockWorkspaceApi()}
      />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Maake, åpne brukermeny' }));
    expect(screen.getByText('Ingen virksomhet valgt')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Feilmeldinger' })).toBeNull();
  });
  it('names the service on a table opened straight from its link', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      tableReview: async () => ({
        service: '999888777/rapportassistenten/default',
        createdAt: '2026-10-09T08:26:35.233Z',
        table: tableFrom(exampleGoalTable) as ResultTable,
        edits: [],
        approval: { status: 'draft' },
      }),
    };
    await renderApp('#/table/task-9', { api });

    expect(await screen.findByText(/^Rapportassistenten ·/)).toBeTruthy();
    expect(screen.queryByText('Tabell fra en kjøring')).toBeNull();
  });

  it('shows the choices a table was made from when it is opened from its link', async () => {
    const api: WorkspaceApi = {
      ...mockWorkspaceApi(),
      tableReview: async () => ({
        service: '999888777/maloppnaelse/default',
        createdAt: '2026-10-09T08:26:35.233Z',
        input: { ministry: 'Kunnskapsdepartementet', agency: 'Utdanningsdirektoratet', year: 2025 },
        table: tableFrom(exampleGoalTable) as ResultTable,
        edits: [],
        approval: { status: 'draft' },
      }),
    };
    await renderApp('#/table/task-9', { api });

    expect(await screen.findByText(/^Vurdering av måloppnåelse ·/)).toBeTruthy();
    expect(screen.getByText('Virksomhet:').nextElementSibling?.textContent).toBe(
      'Utdanningsdirektoratet',
    );
    expect(screen.getByText('År:').nextElementSibling?.textContent).toBe('2025');
  });
});
