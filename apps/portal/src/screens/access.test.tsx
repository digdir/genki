// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { mockAnsattporten, type AuthClient } from '../auth';
import { exampleAccess, mockFetch } from '../mock';
import { expectAccessible, failingFetch, heldFetch, renderAt } from '../test-utils';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const peopleReady = () => screen.findByText('Viser 10 av 10 personer');
const expander = (name: RegExp) => screen.getByRole('button', { name, expanded: false });
const servicesList = () => screen.findByRole('list', { name: 'Tjenester' });

describe('Tilgang', () => {
  it('opens on the people tab and lists people with their rights', async () => {
    await renderAt('#/access');

    expect(await screen.findByRole('heading', { level: 1, name: 'Tilgang' })).toBeTruthy();
    await peopleReady();
    expect(screen.getByRole('tab', { name: 'Personer' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    for (const right of [
      'Bruke tjenester',
      'Administrere tjenester',
      'Administrere datasett',
      'Se forbruk og kostnad',
    ])
      expect(screen.getAllByText(right).length).toBeGreaterThan(0);
    fireEvent.click(expander(/Per Hansen/));
    expect(screen.getByText('Gitt av Kari Nordmann i Altinn 2. april 2026.')).toBeTruthy();
    expect(
      screen.getByText('Alle tjenestene. Tilgang kan ikke begrenses per tjeneste ennå.'),
    ).toBeTruthy();
    expect(screen.queryByText('Rettigheter fra Altinn')).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Grupper' })).toBeNull();
    expect(screen.queryByRole('tab', { name: 'Datasett' })).toBeNull();
    expectAccessible();
  });

  it('filters people by name and right, and resets the filter', async () => {
    await renderAt('#/access/people');
    await peopleReady();

    fireEvent.change(screen.getByLabelText('Søk etter person'), { target: { value: 'tilskudd' } });
    expect(screen.getByText('Viser 3 av 10 personer')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Ingen rettigheter' }));
    expect(screen.getByText('Viser 0 av 10 personer')).toBeTruthy();
    expect(screen.getByText('Ingen personer passer søket')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(screen.getByText('Viser 10 av 10 personer')).toBeTruthy();
  });

  it('warns on a person who lacks the right to use services', async () => {
    await renderAt('#/access/people');
    await peopleReady();
    const tor = expander(/Tor Eriksen/);
    expect(within(tor).getByText('Mangler «Bruke tjenester»')).toBeTruthy();
    fireEvent.click(tor);
    expect(screen.getByText('Ingen. Trenger «Bruke tjenester» i Altinn.')).toBeTruthy();
  });

  it('opens the services tab from its own address', async () => {
    await renderAt('#/access/services');
    await servicesList();
    expect(screen.getByRole('tab', { name: 'Tjenester' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('link', { name: 'Tilgang' }).getAttribute('aria-current')).toBe('page');
  });

  it('puts the chosen tab in the address', async () => {
    await renderAt('#/access');
    await peopleReady();
    fireEvent.click(screen.getByRole('tab', { name: 'Tjenester' }));
    await waitFor(() => expect(window.location.hash).toBe('#/access/services'));
    await servicesList();
  });

  it('redirects the old tab query to the services tab', async () => {
    await renderAt('#/access?tab=groups&org=999888777');
    await waitFor(() => expect(window.location.hash).toBe('#/access/services?org=999888777'));
  });

  it('lists services read-only in alphabetical order', async () => {
    const [first] = exampleAccess.services;
    if (!first) throw new Error('exampleAccess has no services');
    const access = {
      ...exampleAccess,
      services: [
        ...exampleAccess.services,
        { ...first, id: 'postsortering', name: 'Postsortering' },
      ],
    };
    await renderAt(
      '#/access/services',
      mockFetch(undefined, undefined, undefined, undefined, { access }),
    );
    const list = await servicesList();
    const names = within(list)
      .getAllByRole('link')
      .map((a) => a.textContent);
    expect(names).toEqual([...names].sort((a, b) => (a ?? '').localeCompare(b ?? '', 'nb')));
    expect(names).toContain('Postsortering');
    expect(within(list).getByRole('link', { name: 'Postsortering' }).getAttribute('href')).toBe(
      '#/services/postsortering',
    );
    expect(screen.getByText('Alle med «Bruke tjenester» kan bruke alle tjenestene.')).toBeTruthy();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.queryByRole('button', { name: /Legg til/ })).toBeNull();
    expectAccessible();
  });

  it('counts the active API keys bound to each service, leaving out revoked and expired ones', async () => {
    const [first] = exampleAccess.keys;
    if (!first) throw new Error('exampleAccess has no keys');
    const bound = (id: string, extra: Partial<typeof first> = {}) => ({
      ...first,
      id,
      name: id,
      service: 'rapportassistenten',
      ...extra,
    });
    const access = {
      ...exampleAccess,
      keys: [
        bound('k1'),
        bound('k2', { expiresAt: '2999-01-01T00:00:00Z' }),
        bound('k3', { revokedAt: '2026-06-03T09:00:00Z' }),
        bound('k4', { expiresAt: '2020-01-01T00:00:00Z' }),
        { ...first, id: 'k5', service: null },
      ],
    };
    await renderAt(
      '#/access/services',
      mockFetch(undefined, undefined, undefined, undefined, { access }),
    );
    const list = await servicesList();
    const row = within(list).getByRole('link', { name: 'Rapportassistenten' })
      .parentElement as HTMLElement;
    expect(row.textContent).toContain('2 API-nøkler er bundet til tjenesten');
    expect(screen.getByText(/Systemer kaller en tjeneste med en API-nøkkel/)).toBeTruthy();
  });

  it('shows a load error with retry instead of an Altinn warning', async () => {
    let fail = true;
    const ok = mockFetch();
    const broken = failingFetch(/\/access$/);
    await renderAt('#/access/services', (input, init) =>
      fail ? broken(input, init) : ok(input, init),
    );
    expect(await screen.findByRole('heading', { name: 'Kunne ikke hente dataene' })).toBeTruthy();
    expect(screen.queryByText('Fikk ikke kontakt med Altinn')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await servicesList();
  });

  it('shows a refusal for a 403', async () => {
    await renderAt('#/access/services', failingFetch(/\/access$/, 403));
    expect(await screen.findByRole('heading', { name: 'Du har ikke tilgang' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
  });

  it('keeps the services list on screen when the tab is opened again', async () => {
    let hold = false;
    const held = heldFetch(/\/access$/);
    const base = mockFetch();
    await renderAt('#/access/services', (input, init) =>
      hold ? held.fetch(input, init) : base(input, init),
    );
    await servicesList();
    fireEvent.click(screen.getByRole('tab', { name: 'Personer' }));
    await peopleReady();
    hold = true;
    fireEvent.click(screen.getByRole('tab', { name: 'Tjenester' }));
    expect(await screen.findByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    await held.release();
  });

  it('writes the Altinn message for the chosen rights instead of granting', async () => {
    const calls: { url: string; method: string }[] = [];
    const base = mockFetch();
    await renderAt('#/access', async (input, init) => {
      calls.push({ url: String(input), method: init?.method ?? 'GET' });
      return base(input, init);
    });
    await peopleReady();
    const writesBefore = calls.filter((c) => c.method !== 'GET').length;
    fireEvent.click(screen.getByRole('button', { name: 'Gi en kollega tilgang' }));
    expect(
      await screen.findByText('Velg minst én ting over, så skriver vi meldingen.'),
    ).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Hvem skal få tilgang?'), {
      target: { value: 'Ola Nordmann' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Administrere tjenester/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Se forbruk og kostnad/ }));
    const message = screen.getByLabelText('Meldingen til tilgangsstyreren') as HTMLTextAreaElement;
    expect(message.value).toContain(
      'Kan du gi Ola Nordmann rettighetene «Administrere tjenester» og «Se forbruk og kostnad» for genki i Altinn, på vegne av Testetaten (org.nr. 999 888 777)?',
    );
    expect(message.value).toContain('Hilsen Kari Nordmann');

    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    fireEvent.click(screen.getByRole('button', { name: 'Kopier meldingen' }));
    expect(
      await screen.findByText(
        'Kopiert. Lim inn meldingen i en e-post eller i Teams til tilgangsstyreren.',
      ),
    ).toBeTruthy();
    expect(writeText).toHaveBeenCalledWith(message.value);
    const altinn = screen.getAllByRole('link', { name: /Åpne Altinn/ }).at(-1) as HTMLElement;
    expect(altinn.getAttribute('target')).toBe('_blank');
    expect(altinn.textContent).toContain('(åpnes i ny fane)');
    expect(calls.filter((c) => c.method !== 'GET').length).toBe(writesBefore);
  });

  it('says so when the message could not be copied', async () => {
    await renderAt('#/access');
    await peopleReady();
    fireEvent.click(screen.getByRole('button', { name: 'Gi en kollega tilgang' }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /Bruke tjenester/ }));
    Object.assign(navigator, {
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kopier meldingen' }));
    expect(
      await screen.findByText('Fikk ikke kopiert. Merk teksten og kopier den selv.'),
    ).toBeTruthy();
  });

  it('asks before discarding a typed name in the grant dialog', async () => {
    await renderAt('#/access');
    await peopleReady();
    fireEvent.click(screen.getByRole('button', { name: 'Gi en kollega tilgang' }));
    fireEvent.change(await screen.findByLabelText('Hvem skal få tilgang?'), {
      target: { value: 'Ola' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }));
    expect(screen.getByText('Forkaste det du har skrevet?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fortsett å skrive' }));
    expect((screen.getByLabelText('Hvem skal få tilgang?') as HTMLInputElement).value).toBe('Ola');
    fireEvent.click(screen.getByRole('button', { name: 'Lukk' }));
    fireEvent.click(screen.getByRole('button', { name: 'Forkast' }));
    await waitFor(() => expect(screen.queryByLabelText('Hvem skal få tilgang?')).toBeNull());
  });

  it('can force the Altinn warning with altinn=error in the example', async () => {
    await renderAt('#/access?altinn=error');
    expect(
      await screen.findByRole('heading', { name: 'Fikk ikke kontakt med Altinn' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(screen.queryByRole('heading', { name: 'Fikk ikke kontakt med Altinn' })).toBeNull();
  });

  it('shows the signed-in person their own rights in live mode', async () => {
    const auth = mockAnsattporten({
      name: 'Erik Larsen',
      organisations: [
        { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services', 'view-usage'] },
      ],
    });
    await auth.login();
    window.location.hash = '#/access';
    render(<App auth={auth} fetch={mockFetch()} live />);
    const own = await screen.findByRole('list', { name: 'Dine rettigheter' });
    expect(within(own).getByText('Bruke tjenester')).toBeTruthy();
    expect(
      screen.getByText(/Portalen henter ikke kollegenes rettigheter fra Altinn ennå/),
    ).toBeTruthy();
    expect(screen.queryByText('Viser 10 av 10 personer')).toBeNull();
  });
});

describe('Uten tilgang', () => {
  it('previews the no-access page at view=no-access', async () => {
    await renderAt('#/access?view=no-access');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' }),
    ).toBeTruthy();
    expect(
      screen.getByText(/Du er logget inn som Erik Strand og handler for Testetaten\./),
    ).toBeTruthy();
    expectAccessible();
  });

  it('shows the full page without the shell when the user has no organisation', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const auth = mockAnsattporten({ name: 'Erik Strand', organisations: [] });
    await auth.login();
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={mockFetch()} />);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' }),
    ).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Hovedmeny' })).toBeNull();
    expect(screen.getByRole('img', { name: 'Erik Strand' })).toBeTruthy();

    const managers = screen.getByRole('list');
    const mail = within(managers).getByRole('link', {
      name: 'kari.nordmann@testetaten.example.no',
    });
    expect(mail.getAttribute('href')).toMatch(
      /^mailto:kari\.nordmann@testetaten\.example\.no\?subject=/,
    );
    expect(screen.getByText('Bruke tjenester')).toBeTruthy();

    const message = screen.getByLabelText(
      'Forslag til melding du kan sende',
    ) as HTMLTextAreaElement;
    expect(message.value).toContain('Kan du gi meg rettigheten «Bruke tjenester» i Altinn?');
    expect(message.value).toContain('Hilsen Erik Strand');

    fireEvent.click(screen.getByRole('button', { name: 'Kopier meldingen' }));
    expect(screen.getByText('Meldingen er kopiert.').getAttribute('role')).toBe('status');

    const recheck = screen.getByRole('button', { name: 'Sjekk på nytt' });
    fireEvent.click(recheck);
    expect(screen.getByText('Sjekker Altinn')).toBeTruthy();
    expect(recheck.getAttribute('aria-disabled')).toBe('true');
    await act(() => vi.advanceTimersByTimeAsync(1300));
    await waitFor(() =>
      expect(
        screen.getByText('Du har fortsatt ingen rettigheter. Prøv igjen om litt.'),
      ).toBeTruthy(),
    );
    expectAccessible();
  });

  it('checks access again by signing in anew and opens the portal once rights have been granted', async () => {
    let granted = false;
    const auth: AuthClient = {
      current: () => ({ name: 'Erik Strand', organisations: [], token: 't' }),
      login: async () => ({
        name: 'Erik Strand',
        organisations: granted
          ? [{ orgNumber: '999888777', name: 'Testetaten', actions: ['read'] }]
          : [],
        token: 't',
      }),
      logout: async () => undefined,
    };
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={mockFetch()} />);
    await screen.findByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' });

    fireEvent.click(screen.getByRole('button', { name: 'Sjekk på nytt' }));
    expect(
      await screen.findByText('Du har fortsatt ingen rettigheter. Prøv igjen om litt.'),
    ).toBeTruthy();

    granted = true;
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk på nytt' }));
    expect(await screen.findByRole('navigation', { name: 'Hovedmeny' })).toBeTruthy();
  });

  it('lets a person without access switch organisation by signing out instead of linking to the same page', async () => {
    const auth = mockAnsattporten({ name: 'Erik Strand', organisations: [] });
    await auth.login();
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={mockFetch()} />);
    await screen.findByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' });
    expect(screen.queryByRole('link', { name: 'Bytt virksomhet' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bytt virksomhet' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('heading', { level: 1, name: 'Du har ikke tilgang ennå' }),
      ).toBeNull(),
    );
  });
});
