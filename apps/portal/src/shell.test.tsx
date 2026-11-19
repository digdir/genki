// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { rightsFor } from './Shell';
import { mockAnsattporten, type AuthClient } from './auth';
import { mockFetch } from './mock';
import { expectAccessible, go, kari, renderAt } from './test-utils';
import type { Session } from './types';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('the organisation in the header', () => {
  it('is plain text without a button when the person can act for only one organisation', async () => {
    const single: AuthClient = mockAnsattporten({
      name: 'Ingrid Berg',
      organisations: [{ orgNumber: '991825827', name: 'Digitaliseringsdirektoratet' }],
    });
    render(<App auth={single} fetch={mockFetch()} />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Logg inn' }))[0] as HTMLElement);

    expect(await screen.findByText('Digitaliseringsdirektoratet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Bytt virksomhet/ })).toBeNull();
  });

  it('lists the organisations under Handler for in the user menu when the person can act for several', async () => {
    render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Logg inn' }))[0] as HTMLElement);

    fireEvent.click(
      await screen.findByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
    );

    const menu = screen.getByRole('menu', { name: 'Brukermeny' });
    const group = within(menu).getByRole('group', { name: 'Handler for' });
    expect(within(group).getAllByRole('menuitemradio')).toHaveLength(kari.organisations.length);
    expect(within(group).getByText('org.nr. 999 888 777')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Bytt virksomhet/ })).toBeNull();
  });

  it('keeps the user menu open when it is clicked as soon as the sidebar appears', async () => {
    const name = 'Brukermeny for Kari Nordmann, Testetaten';
    const clicked = new Promise<void>((resolve) => {
      const observer = new MutationObserver(() => {
        const button = document.querySelector(`[aria-label="${name}"]`);
        if (!button) return;
        observer.disconnect();
        fireEvent.click(button);
        resolve();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    });
    render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} />);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Logg inn' }))[0] as HTMLElement);
    await clicked;

    expect(screen.getByRole('menu', { name: 'Brukermeny' })).toBeTruthy();
  });
});

describe('login from the start page', () => {
  it('opens the portal on Oversikt after logging in', async () => {
    render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Logg inn' }))[0] as HTMLElement);

    expect(await screen.findAllByRole('navigation', { name: 'Hovedmeny' })).toHaveLength(1);
    expect(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
    ).toBeTruthy();
  });

  it('tells the user when the login fails', async () => {
    const failing: AuthClient = {
      current: () => undefined,
      login: () => Promise.reject(new Error('no')),
      logout: async () => undefined,
    };
    render(<App auth={failing} fetch={mockFetch()} />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Logg inn' }))[0] as HTMLElement);

    expect((await screen.findByRole('alert')).textContent).toMatch(/Innloggingen mislyktes/);
  });
});

describe('an expired session', () => {
  it('logs out on 401 and offers Logg inn instead of an error with Prøv igjen', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    let loggedOut = 0;
    const logout = auth.logout.bind(auth);
    auth.logout = async () => {
      loggedOut += 1;
      await logout();
    };
    const base = mockFetch();
    let expiredOnce = false;
    const expiring: typeof fetch = async (input, init) => {
      if (expiredOnce || !/\/overview$/.test(String(input))) return base(input, init);
      expiredOnce = true;
      return Response.json({ title: 'Du er ikke logget inn', status: 401 }, { status: 401 });
    };
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={expiring} />);

    expect(await screen.findByRole('heading', { name: 'Du er logget ut' })).toBeTruthy();
    expect(screen.getByText('Økten din er utløpt. Logg inn igjen for å fortsette.')).toBeTruthy();
    expect(screen.queryByText('Kunne ikke hente dataene')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
    expect(loggedOut).toBe(1);

    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Oversikt' })).toBeTruthy();
  });
});

describe('shell', () => {
  it('the side menu groups the items in design order and marks the current one with aria-current=page', async () => {
    await renderAt('#/statistics');

    expect(screen.getByRole('link', { name: 'Hopp til hovedinnhold' }).getAttribute('href')).toBe(
      '#hovedinnhold',
    );
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    for (const group of ['Bygg', 'Analyse', 'Administrasjon'])
      expect(within(menu).getByRole('list', { name: group })).toBeTruthy();
    expect(within(menu).queryByRole('heading')).toBeNull();
    expect(
      within(menu)
        .getAllByRole('listitem')
        .map((li) => li.querySelector('a')?.firstChild?.textContent),
    ).toEqual([
      'Oversikt',
      'Tjenester',
      'Fellestjenester',
      'Datasett',
      'Byggeklosser',
      'Prøveområde',
      'Utviklerverktøy',
      'Statistikk',
      'Logg',
      'Tilgang',
      'Innstillinger',
    ]);
    expect(
      within(menu).getByRole('link', { name: 'Statistikk' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.queryByRole('banner')).toBeNull();
    expect(document.documentElement.lang || 'nb').toBe('nb');
  });

  it('sends the old usage address on to Statistikk', async () => {
    await renderAt('#/usage');
    await waitFor(() => expect(window.location.hash).toBe('#/statistics'));
  });

  it.each([
    ['#/integrations', '#/developer/systems'],
    ['#/integrations?tab=hooks&saved=Fnr', '#/developer/hooks?saved=Fnr'],
    ['#/integrations?tab=tracing', '#/developer/runs'],
    ['#/integrations/code', '#/developer/api'],
    ['#/integrations/hooks/fnr', '#/developer/hooks/fnr'],
  ])('sends the old Integrasjoner address %s on to %s', async (from, to) => {
    await renderAt(from);
    await waitFor(() => expect(window.location.hash).toBe(to));
  });

  it.each([
    ['#/status', '#/developer/status'],
    ['#/developer/api/code', '#/developer/api'],
    ['#/developer/settings', '#/settings/all'],
    ['#/step-flows', '#/developer/step-flows'],
    ['#/step-flows/ai-overview', '#/developer/step-flows/ai-overview'],
    ['#/log?tab=changes', '#/log/changes'],
  ])('sends the old address %s on to %s', async (from, to) => {
    await renderAt(from);
    await waitFor(() => expect(window.location.hash).toBe(to));
  });

  it('marks Utviklerverktøy, not Tjenester, as the current menu item on the step-flow page', async () => {
    await renderAt('#/developer/step-flows/ai-overview');

    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(
      within(menu).getByRole('link', { name: 'Utviklerverktøy' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(within(menu).getByRole('link', { name: 'Tjenester' }).getAttribute('aria-current')).toBe(
      null,
    );
  });

  it('names the platform Generativ KI-plattform from Digdir in the side menu', async () => {
    await renderAt('#/overview');

    const brand = within(screen.getByRole('navigation', { name: 'Hovedmeny' })).getByRole('link', {
      name: /Generativ KI-plattform/,
    });
    expect(brand.textContent).toBe('DigdirGenerativ KI-plattform');
  });

  it('shows the person and the organisation by name on the account button and in its menu', async () => {
    await renderAt('#/overview');

    const button = screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' });
    expect(button.textContent).toBe('KNKari NordmannTestetaten');
    fireEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'Brukermeny' });
    expect(
      within(menu)
        .getByRole('menuitemradio', { name: /Testetaten/ })
        .getAttribute('aria-checked'),
    ).toBe('true');
  });

  it('shows the organisation number only when the organisation has no name', async () => {
    const auth = mockAnsattporten({
      name: 'Ingrid Berg',
      organisations: [{ orgNumber: '312521172', name: '312521172' }],
    });
    await auth.login();
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={mockFetch()} />);

    const button = await screen.findByRole('button', {
      name: 'Brukermeny for Ingrid Berg, Org.nr. 312 521 172',
    });
    fireEvent.click(button);
    expect(screen.getByText('Handler for org.nr. 312 521 172')).toBeTruthy();
    expect(await screen.findByText(/^Org.nr. 312 521 172 · /)).toBeTruthy();
  });

  it('sends the old user guide address on to Kom i gang', async () => {
    await renderAt('#/help');
    await waitFor(() => expect(window.location.hash).toBe('#/onboarding'));
  });

  it('shrinks the sidebar to icons, keeps the menu and the organisation, and remembers it', async () => {
    await renderAt('#/overview');
    fireEvent.click(screen.getByRole('button', { name: 'Skjul sidepanelet' }));
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(within(menu).getByRole('link', { name: 'Tjenester' }).getAttribute('title')).toBe(
      'Tjenester',
    );
    expect(
      within(menu).getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
    ).toBeTruthy();
    expect(localStorage.getItem('genki.sidebarCollapsed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Vis sidepanelet' }));
    expect(within(menu).getByRole('link', { name: 'Tjenester' })).toBeTruthy();
  });

  it('switches organisation from Handler for in the user menu and closes it back on its button', async () => {
    await renderAt('#/overview');

    fireEvent.click(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
    );
    const menu = screen.getByRole('menu', { name: 'Brukermeny' });
    fireEvent.click(within(menu).getByRole('menuitemradio', { name: /Prøvekommunen/ }));

    const button = screen.getByRole('button', {
      name: 'Brukermeny for Kari Nordmann, Prøvekommunen',
    });
    expect(screen.queryByRole('menu', { name: 'Brukermeny' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('Profil lists each right with what it allows, and saves the theme choice in the browser', async () => {
    await renderAt('#/profile');

    const rights = await screen.findByRole('region', { name: 'Rettighetene dine' });
    expect(
      within(rights).getByText(
        'Stille spørsmål og få svar i tjenestene virksomheten har tatt i bruk.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Mørkt' }));
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe('dark');
    expect(window.localStorage.getItem('genai.theme')).toBe('dark');
    expect(screen.getByText('Lagret i denne nettleseren')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Følg systemet' }));
    expect(document.documentElement.getAttribute('data-color-scheme')).toBe('auto');
  });

  it('lists the user menu in design order and closes it with Escape, back on its button', async () => {
    await renderAt('#/overview');

    const button = screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' });
    fireEvent.click(button);
    const menu = screen.getByRole('menu', { name: 'Brukermeny' });
    expect(
      within(menu)
        .getAllByRole('menuitem')
        .map((a) => a.textContent),
    ).toEqual(['Profil', 'Kom i gang', 'Slik behandles data', 'Logg ut']);
    expect(document.activeElement?.textContent).toBe('Profil');

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('menu', { name: 'Brukermeny' })).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('moves through the user menu with the arrow keys, Home and End', async () => {
    await renderAt('#/overview');

    fireEvent.keyDown(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
      {
        key: 'ArrowDown',
      },
    );
    const menu = screen.getByRole('menu', { name: 'Brukermeny' });
    expect(document.activeElement?.textContent).toBe('Profil');
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement?.textContent).toBe('Kom i gang');
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement?.textContent).toBe('Logg ut');
    const firstOrganisation = within(menu).getAllByRole('menuitemradio')[0];
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(firstOrganisation);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement?.textContent).toBe('Logg ut');
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(firstOrganisation);
  });

  it('switching agency on a page other than Oversikt goes to Oversikt with ?org=', async () => {
    await renderAt('#/usage');

    fireEvent.click(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Prøvekommunen/ }));

    expect(window.location.hash).toBe('#/overview?org=999777666');
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    await waitFor(() =>
      expect(
        within(menu).getByRole('link', { name: 'Oversikt' }).getAttribute('aria-current'),
      ).toBe('page'),
    );
    expect(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Prøvekommunen' }),
    ).toBeTruthy();
  });

  it('switching agency on Oversikt stays on Oversikt and reloads for the new agency', async () => {
    const seen: string[] = [];
    const base = mockFetch();
    await renderAt('#/overview', async (input, init) => {
      seen.push(String(input));
      return base(input, init);
    });

    fireEvent.click(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
    );
    fireEvent.click(screen.getByRole('menuitemradio', { name: /Prøvekommunen/ }));

    expect(window.location.hash).toBe('#/overview');
    await waitFor(() => expect(seen.some((u) => u.includes('/tenants/999777666/'))).toBe(true));
  });

  it('reads ?org= at start-up', async () => {
    await renderAt('#/overview?org=999666555');

    expect(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Eksempeldirektoratet' }),
    ).toBeTruthy();
  });

  it('Escape and an outside click close the user menu', async () => {
    await renderAt('#/overview');

    fireEvent.click(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
    );
    const menu = screen.getByRole('menu', { name: 'Brukermeny' });
    fireEvent.mouseDown(within(menu).getByText('Profil'));
    expect(screen.getByRole('menu', { name: 'Brukermeny' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('menu', { name: 'Brukermeny' })).toBeNull();
  });

  it.each([
    ['/building-blocks', 'Byggeklosser', 'Byggeklosser'],
    ['/skills', 'Ferdigheter', 'Byggeklosser'],
    ['/playground', 'Prøveområdet', 'Prøveområde'],
  ])('renders the %s page and highlights %s in the menu', async (path, heading, item) => {
    await renderAt(`#${path}`);

    expect(await screen.findByRole('heading', { level: 1, name: heading })).toBeTruthy();
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(within(menu).getByRole('link', { name: item }).getAttribute('aria-current')).toBe(
      'page',
    );
    expectAccessible();
  });

  it('follows the hash when navigating', async () => {
    await renderAt('#/overview');
    await go('#/log');
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    await waitFor(() =>
      expect(within(menu).getByRole('link', { name: 'Logg' }).getAttribute('aria-current')).toBe(
        'page',
      ),
    );
  });

  it('moves focus to the main content when going to another page', async () => {
    await renderAt('#/overview');
    await go('#/log');
    await waitFor(() => expect(document.activeElement?.id).toBe('hovedinnhold'));
  });

  it.each([
    ['/onboarding', 'Kom i gang'],
    ['/contact', 'Kontakt Digdir'],
  ])('gives the unbuilt %s page its own h1', async (path, title) => {
    await renderAt(`#${path}`);
    expect(await screen.findByRole('heading', { level: 1, name: title })).toBeTruthy();
  });

  it.each([
    ['/onboarding', /Fra ingenting til en tjeneste kollegene dine kan bruke/],
    ['/contact', /ikke et eget kontaktpunkt for brukerstøtte ennå/],
  ])(
    'gives the footer page %s honest content instead of the not designed placeholder',
    async (path, content) => {
      await renderAt(`#${path}`);
      expect(screen.queryByText(/ikke tegnet ennå/)).toBeNull();
      expect(screen.getByText(content)).toBeTruthy();
    },
  );
});

describe('login through Ansattporten in live mode', () => {
  const callbackClient = (): AuthClient => {
    let session: Session | undefined;
    let pending = true;
    return {
      current: () => session,
      callbackPending: () => pending,
      login: async () => {
        pending = false;
        session = {
          name: 'Ingrid Berg',
          organisations: [
            { orgNumber: '405003309', name: 'Testdepartementet', actions: ['read', 'write'] },
          ],
          token: 'access',
        };
        return session;
      },
      logout: async () => {
        session = undefined;
      },
    };
  };

  it('finishes the login on return and shows the person and organisation from the token', async () => {
    render(<App auth={callbackClient()} fetch={mockFetch()} live />);

    expect(await screen.findByText('Testdepartementet')).toBeTruthy();
    go('#/profile');
    const menu = screen.getByRole('main');
    expect(await within(menu).findByText('Testdepartementet (org.nr. 405 003 309)')).toBeTruthy();
    expect(within(menu).getByText('Administrere tjenester')).toBeTruthy();
  });

  it('shows only the finer Altinn rights in the user menu when the token also has read and write', async () => {
    const auth: AuthClient = {
      current: () => ({
        name: 'Ingrid Berg',
        organisations: [
          {
            orgNumber: '405003309',
            name: 'Testdepartementet',
            actions: [
              'read',
              'write',
              'use-services',
              'manage-services',
              'manage-datasets',
              'register-building-blocks',
              'view-usage',
            ],
          },
        ],
        token: 'access',
      }),
      login: () => Promise.reject(new Error('unused')),
      logout: async () => undefined,
    };
    window.location.hash = '#/profile';
    render(<App auth={auth} fetch={mockFetch()} live />);

    const menu = await screen.findByRole('main');
    expect(
      within(menu)
        .getAllByText(/./, { selector: '.profile-right' })
        .map((t) => t.textContent),
    ).toEqual([
      'Bruke tjenester',
      'Administrere tjenester',
      'Administrere datasett',
      'Registrere byggeklosser',
      'Se forbruk og kostnad',
    ]);
  });

  it('returns to the start page after Logg ut', async () => {
    render(<App auth={callbackClient()} fetch={mockFetch()} live />);
    await screen.findByRole('button', { name: 'Brukermeny for Ingrid Berg, Testdepartementet' });

    await waitFor(() => {
      if (!screen.queryByRole('menu', { name: 'Brukermeny' }))
        fireEvent.click(
          screen.getByRole('button', { name: 'Brukermeny for Ingrid Berg, Testdepartementet' }),
        );
      const menu = screen.getByRole('menu', { name: 'Brukermeny' });
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Logg ut' }));
    });

    expect((await screen.findAllByRole('button', { name: 'Logg inn' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('navigation', { name: 'Hovedmeny' })).toBeNull();
  });
});

it('shows the Datasett badge on a deep link with the same count as the Trenger oppfølging filter', async () => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/services';
  render(<App auth={auth} fetch={mockFetch()} live />);
  const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
  await waitFor(() =>
    expect(within(menu).getByRole('link', { name: /Datasett/ }).textContent).toBe('Datasett2'),
  );

  await go('#/datasets');

  expect(await screen.findByText('Trenger oppfølging (2)')).toBeTruthy();
});

it('derives rights from the old read and write actions the same way as the API', () => {
  expect(rightsFor(['read'])).toEqual({ rights: ['use-services', 'view-usage'], labels: ['Lese'] });
  expect(rightsFor(['read', 'write']).rights).toEqual([
    'use-services',
    'manage-services',
    'manage-datasets',
    'register-building-blocks',
    'view-usage',
  ]);
  expect(rightsFor(['write', 'manage-services']).rights).toEqual(['manage-services']);
  expect(rightsFor(['read', 'write', 'use-services']).labels).toEqual(['Bruke tjenester']);
});

describe('language choice on the profile page', () => {
  it('follows the browser until the person picks a language, saves it and sends it to the API', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    const base = mockFetch();
    const sent: { url: string; language: string | null; body?: unknown }[] = [];
    const recording: typeof fetch = async (input, init) => {
      const headers = new Headers(init?.headers);
      sent.push({
        url: String(input),
        language: headers.get('accept-language'),
        ...(init?.method === 'PUT' ? { body: JSON.parse(String(init.body)) } : {}),
      });
      return base(input, init);
    };
    render(<App auth={auth} fetch={recording} languages={['en-GB', 'nb']} />);

    window.location.hash = '#/profile';
    const choice = await screen.findByRole('group', { name: 'Språk / Language' });
    expect(within(choice).getByRole('radio', { name: 'Same as browser' })).toHaveProperty(
      'checked',
      true,
    );
    expect(document.documentElement.lang).toBe('en');

    fireEvent.click(within(choice).getByRole('radio', { name: 'Norsk bokmål' }));

    await waitFor(() => expect(document.documentElement.lang).toBe('nb'));
    await waitFor(() =>
      expect(sent.find((s) => s.url.endsWith('/me/preferences') && s.body)).toMatchObject({
        body: { language: 'nb' },
      }),
    );
    expect(sent.some((s) => s.language === 'en')).toBe(true);
    expect(sent.at(-1)?.language).toBe('nb');
  });
});

describe('a locked environment', () => {
  const locked = (lockdown: boolean, readOnly = true): typeof fetch => {
    const base = mockFetch();
    return async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith('/health'))
        return Response.json({ status: 'ok', version: 'test', lockdown });
      if (url.endsWith('/me'))
        return Response.json({
          organisations: [],
          ...(readOnly ? { lockdownReadOnly: true } : {}),
        });
      return base(input, init);
    };
  };

  it('tells a read-only login that changes, models and ingestion need an Entra login', async () => {
    await renderAt('/overview', locked(true));

    expect(
      await screen.findByText(
        'Låst testmiljø: du kan se deg rundt, men endringer, modeller og innlesing krever innlogging med Entra ID.',
      ),
    ).toBeTruthy();
  });

  it('shows no banner to an admitted Entra login', async () => {
    const seen: string[] = [];
    const fetcher = locked(true, false);
    await renderAt('/overview', async (input, init) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return fetcher(input, init);
    });

    await waitFor(() => expect(seen.some((url) => url.endsWith('/me'))).toBe(true));
    expect(await screen.findAllByRole('navigation', { name: 'Hovedmeny' })).toHaveLength(1);
    expect(screen.queryByText(/Låst testmiljø/)).toBeNull();
  });

  it('shows no banner when the environment is not locked', async () => {
    await renderAt('/overview', locked(false));

    expect(await screen.findAllByRole('navigation', { name: 'Hovedmeny' })).toHaveLength(1);
    expect(screen.queryByText(/Låst testmiljø/)).toBeNull();
  });
});

describe('the shell on a phone', () => {
  const wide = window.innerWidth;
  beforeEach(() => {
    window.innerWidth = 390;
  });
  afterEach(() => {
    window.innerWidth = wide;
  });

  const focusable = () =>
    [...document.querySelectorAll<HTMLElement>('a[href], button')].filter(
      (el) => el.tabIndex >= 0 && !el.closest('[role="menu"]'),
    );

  it('shows the brand first and Meny last in the top bar, with no account there', async () => {
    await renderAt('#/services');
    const bar = await screen.findByRole('banner');
    const controls = [...bar.querySelectorAll('a, button')];

    expect(controls[0]?.getAttribute('href')).toBe('#/overview');
    expect(controls.at(-1)?.textContent).toBe('Meny');
    expect(within(bar).queryByRole('button', { name: /Brukermeny/ })).toBeNull();
  });

  it('opens the menu with the navigation right after Meny and the account at its end', async () => {
    await renderAt('#/services');
    const toggle = await screen.findByRole('button', { name: 'Meny' });

    fireEvent.click(toggle);

    const nav = screen.getByRole('navigation', { name: 'Hovedmeny' });
    const order = focusable();
    const links = within(nav).getAllByRole('link');
    expect(order[order.indexOf(toggle) + 1]).toBe(links[0]);
    const account = within(nav).getByRole('button', {
      name: 'Brukermeny for Kari Nordmann, Testetaten',
    });
    expect(order.indexOf(account)).toBeGreaterThan(order.indexOf(links.at(-1) as HTMLElement));
  });

  it('closes the menu with Escape and puts focus back on Meny', async () => {
    await renderAt('#/services');
    const toggle = await screen.findByRole('button', { name: 'Meny' });
    fireEvent.click(toggle);
    within(screen.getByRole('navigation', { name: 'Hovedmeny' }))
      .getAllByRole('link')[0]
      ?.focus();

    fireEvent.keyDown(window, { key: 'Escape' });

    expect(screen.queryByRole('navigation', { name: 'Hovedmeny' })).toBeNull();
    expect(document.activeElement).toBe(toggle);
  });

  it('keeps the menu open while the user menu inside it is open', async () => {
    await renderAt('#/services');
    fireEvent.click(await screen.findByRole('button', { name: 'Meny' }));

    fireEvent.click(
      screen.getByRole('button', { name: 'Brukermeny for Kari Nordmann, Testetaten' }),
    );

    expect(screen.getByRole('menu', { name: 'Brukermeny' })).toBeTruthy();
    expect(screen.getByRole('navigation', { name: 'Hovedmeny' })).toBeTruthy();
  });
});
