// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { mockAnsattporten, type AuthClient } from '../auth';
import { exampleAccess, mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';

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

const ready = () => screen.findByText('Hentet fra Altinn i dag kl. 10.52');
const expander = (name: RegExp) => screen.getByRole('button', { name, expanded: false });

describe('Tilgang', () => {
  it('shows rights from Altinn and lists people with their rights', async () => {
    const calls: string[] = [];
    const base = mockFetch();
    await renderAt('#/access', async (input, init) => {
      calls.push(String(input));
      return base(input, init);
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Tilgang' })).toBeTruthy();
    expect(screen.getByText('Henter fra Altinn')).toBeTruthy();
    expect((await ready()).getAttribute('role')).toBe('status');
    expect(calls.some((c) => /\/tenants\/999888777\/access$/.test(c))).toBe(true);

    const altinn = screen.getByRole('link', { name: /Endre i Altinn/ });
    expect(altinn.getAttribute('target')).toBe('_blank');
    expect(altinn.textContent).toContain('(åpnes i ny fane)');

    for (const right of [
      'Bruke tjenester',
      'Administrere tjenester',
      'Administrere datasett',
      'Se forbruk og kostnad',
    ])
      expect(screen.getAllByText(right).length).toBeGreaterThan(0);
    expect(screen.getByText('Viser 10 av 10 personer')).toBeTruthy();

    const per = screen.getByRole('button', { name: /Per Hansen/, expanded: true });
    expect(per).toBeTruthy();
    expect(screen.getByText('Gitt av Kari Nordmann i Altinn 2. april 2026.')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Fikk ikke kontakt med Altinn' })).toBeNull();
    expectAccessible();
  });

  it('filters people by name and right, and resets the filter', async () => {
    await renderAt('#/access');
    await ready();

    fireEvent.change(screen.getByLabelText('Søk etter person'), { target: { value: 'tilskudd' } });
    expect(screen.getByText('Viser 3 av 10 personer')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Ingen rettigheter' }));
    expect(screen.getByText('Viser 0 av 10 personer')).toBeTruthy();
    expect(screen.getByText('Ingen personer passer søket')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(screen.getByText('Viser 10 av 10 personer')).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Ingen rettigheter' }));
    fireEvent.click(expander(/Tor Eriksen/));
    expect(screen.getByText('Ingen. Trenger «Bruke tjenester» i Altinn.')).toBeTruthy();
  });

  it('narrows access to a service and adds people from the dialog', async () => {
    await renderAt('#/access');
    await ready();

    expect(screen.getByRole('tab', { name: 'Tjenester' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    const vedtak = screen.getByRole('button', { name: /Vedtaksutkast/, expanded: true });
    const item = vedtak.closest('li') as HTMLElement;
    expect(
      within(item).getByRole('radio', { name: /Bare utvalgte grupper og personer/ }),
    ).toHaveProperty('checked', true);

    fireEvent.click(within(item).getByRole('button', { name: 'Legg til gruppe eller person' }));
    expect(
      await screen.findByRole('heading', { name: 'Gi tilgang til Vedtaksutkast' }),
    ).toBeTruthy();
    const tor = screen.getByRole('checkbox', { name: /Tor Eriksen/ });
    expect(tor.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(tor);
    expect(screen.getByRole('button', { name: 'Legg til' })).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Søk'), { target: { value: 'Ingrid' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Ingrid Berg/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Legg til 1' }));
    expect(await screen.findByText('Ingrid Berg har fått tilgang til Vedtaksutkast.')).toBeTruthy();

    fireEvent.click(within(item).getByRole('button', { name: 'Fjern tilgangen for Ingrid Berg' }));
    expect(
      screen.getByText('Tilgangen for Ingrid Berg til Vedtaksutkast er fjernet.'),
    ).toBeTruthy();

    fireEvent.click(within(item).getByRole('radio', { name: /Alle med «Bruke tjenester»/ }));
    expect(within(vedtak).getByText('Alle med «Bruke tjenester» (8 personer)')).toBeTruthy();
    expectAccessible();
  });

  it('shows locked datasets and edits groups', async () => {
    await renderAt('#/access?tab=datasets');
    await ready();

    expect(screen.getByRole('tab', { name: 'Datasett' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.click(expander(/Kudos-rapporter/));
    expect(
      screen.getByText(
        'Rapportene i Kudos er offentlige. Alle med «Bruke tjenester» kan søke i dem.',
      ),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: 'Grupper' }));
    fireEvent.click(expander(/Prosjekt nynorsk/));
    expect(screen.getByText('Gruppen har ingen medlemmer ennå.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Legg til personer' }));
    expect(
      await screen.findByRole('heading', { name: 'Legg til i Prosjekt nynorsk' }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: /Line Johansen/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tor Eriksen/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Legg til 2' }));
    expect(await screen.findByText('2 personer lagt til i Prosjekt nynorsk.')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Fjern Tor Eriksen fra Prosjekt nynorsk' }));
    expect(screen.getByText('Tor Eriksen er fjernet fra Prosjekt nynorsk.')).toBeTruthy();
    expectAccessible();
  });

  it('adds services from the access API that the design data does not know', async () => {
    const [first] = exampleAccess.services;
    if (!first) throw new Error('exampleAccess has no services');
    const access = {
      ...exampleAccess,
      services: [
        ...exampleAccess.services,
        { ...first, id: 'postsortering', name: 'Postsortering' },
      ],
    };
    await renderAt('#/access', mockFetch(undefined, undefined, undefined, undefined, { access }));
    await ready();
    expect(screen.getByRole('button', { name: /Postsortering/ })).toBeTruthy();
  });

  it('warns when Altinn cannot be reached and recovers on retry', async () => {
    let fail = true;
    const ok = mockFetch();
    const broken = failingFetch(/\/access$/);
    await renderAt('#/access', (input, init) => (fail ? broken(input, init) : ok(input, init)));

    expect(
      await screen.findByRole('heading', { name: 'Fikk ikke kontakt med Altinn' }),
    ).toBeTruthy();
    expect(screen.getByText('Sist hentet i dag kl. 08.14')).toBeTruthy();
    expect(screen.getByText('Viser 10 av 10 personer')).toBeTruthy();
    expectAccessible();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await ready();
    expect(screen.queryByRole('heading', { name: 'Fikk ikke kontakt med Altinn' })).toBeNull();
  });

  it('can force the Altinn warning with altinn=error', async () => {
    await renderAt('#/access?altinn=error');
    expect(
      await screen.findByRole('heading', { name: 'Fikk ikke kontakt med Altinn' }),
    ).toBeTruthy();
    await screen.findByText('Sist hentet i dag kl. 08.14');
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await ready();
    expect(screen.queryByRole('heading', { name: 'Fikk ikke kontakt med Altinn' })).toBeNull();
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
