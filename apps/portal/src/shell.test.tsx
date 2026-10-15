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

    fireEvent.click(screen.getAllByRole('button', { name: 'Logg inn' })[0] as HTMLElement);

    expect(await screen.findByText('Digitaliseringsdirektoratet')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Bytt virksomhet/ })).toBeNull();
  });

  it('opens the switcher when the person can act for several organisations', async () => {
    render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Logg inn' })[0] as HTMLElement);

    fireEvent.click(
      await screen.findByRole('button', {
        name: 'Handler for Testetaten, org.nr. 999 888 777. Bytt virksomhet',
      }),
    );

    expect(screen.getByRole('dialog', { name: 'Velg virksomhet' })).toBeTruthy();
  });
});

describe('login from the start page', () => {
  it('opens the portal on Oversikt after logging in', async () => {
    render(<App auth={mockAnsattporten(kari)} fetch={mockFetch()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Logg inn' })[0] as HTMLElement);

    expect(await screen.findAllByRole('navigation', { name: 'Hovedmeny' })).toHaveLength(1);
    expect(
      screen.getByRole('button', {
        name: 'Handler for Testetaten, org.nr. 999 888 777. Bytt virksomhet',
      }),
    ).toBeTruthy();
  });

  it('tells the user when the login fails', async () => {
    const failing: AuthClient = {
      current: () => undefined,
      login: () => Promise.reject(new Error('no')),
      logout: async () => undefined,
    };
    render(<App auth={failing} fetch={mockFetch()} />);

    fireEvent.click(screen.getAllByRole('button', { name: 'Logg inn' })[0] as HTMLElement);

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
  it('the side menu lists the eleven items in design order and marks the current one with aria-current=page', async () => {
    await renderAt('#/usage');

    expect(screen.getByRole('link', { name: 'Hopp til hovedinnhold' }).getAttribute('href')).toBe(
      '#hovedinnhold',
    );
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(
      within(menu)
        .getAllByRole('link')
        .map((a) => a.firstChild?.textContent),
    ).toEqual([
      'Oversikt',
      'Tjenester',
      'Fellestjenester',
      'Datasett',
      'Byggeklosser',
      'Prøveområde',
      'Tilgang',
      'Forbruk',
      'Integrasjoner',
      'Logg',
      'Innstillinger',
      'Brukerveiledning',
      'Driftsstatus',
      'Kontakt Digdir',
    ]);
    expect(within(menu).getByRole('link', { name: 'Forbruk' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(document.documentElement.lang || 'nb').toBe('nb');
  });

  it('switches organisation from the org switcher and shows role per organisation', async () => {
    await renderAt('#/overview');

    fireEvent.click(screen.getByRole('button', { name: /Handler for Testetaten/ }));
    const dialog = screen.getByRole('dialog', { name: 'Velg virksomhet' });
    expect(within(dialog).getByText('Org.nr. 999 777 666 · Utvikler')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('radio', { name: /Prøvekommunen/ }));

    expect(screen.getByRole('button', { name: /Handler for Prøvekommunen/ })).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Velg virksomhet' })).toBeNull();
  });

  it('shows rights from Altinn in the user menu and closes it with Escape', async () => {
    await renderAt('#/overview');

    fireEvent.click(screen.getByRole('button', { name: 'Kari Nordmann, åpne brukermeny' }));
    const menu = screen.getByRole('dialog', { name: 'Brukermeny' });
    expect(within(menu).getByText('Se forbruk og kostnad')).toBeTruthy();
    expect(within(menu).getByRole('link', { name: /Se eller endre i Altinn/ })).toBeTruthy();

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Brukermeny' })).toBeNull();
  });

  it('switching agency on a page other than Oversikt goes to Oversikt with ?org=', async () => {
    await renderAt('#/usage');

    fireEvent.click(screen.getByRole('button', { name: /Handler for Testetaten/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Prøvekommunen/ }));

    expect(window.location.hash).toBe('#/overview?org=999777666');
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    await waitFor(() =>
      expect(
        within(menu).getByRole('link', { name: 'Oversikt' }).getAttribute('aria-current'),
      ).toBe('page'),
    );
    expect(screen.getByRole('button', { name: /Handler for Prøvekommunen/ })).toBeTruthy();
  });

  it('switching agency on Oversikt stays on Oversikt and reloads for the new agency', async () => {
    const seen: string[] = [];
    const base = mockFetch();
    await renderAt('#/overview', async (input, init) => {
      seen.push(String(input));
      return base(input, init);
    });

    fireEvent.click(screen.getByRole('button', { name: /Handler for Testetaten/ }));
    fireEvent.click(screen.getByRole('radio', { name: /Prøvekommunen/ }));

    expect(window.location.hash).toBe('#/overview');
    await waitFor(() => expect(seen.some((u) => u.includes('/tenants/999777666/'))).toBe(true));
  });

  it('reads ?org= at start-up', async () => {
    await renderAt('#/overview?org=999666555');

    expect(screen.getByRole('button', { name: /Handler for Eksempeldirektoratet/ })).toBeTruthy();
  });

  it('Escape and an outside click close the agency and user dialogs', async () => {
    await renderAt('#/overview');

    fireEvent.click(screen.getByRole('button', { name: /Handler for Testetaten/ }));
    expect(screen.getByRole('dialog', { name: 'Velg virksomhet' })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Velg virksomhet' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Handler for Testetaten/ }));
    fireEvent.mouseDown(screen.getByRole('main'));
    expect(screen.queryByRole('dialog', { name: 'Velg virksomhet' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Kari Nordmann, åpne brukermeny' }));
    const menu = screen.getByRole('dialog', { name: 'Brukermeny' });
    fireEvent.mouseDown(within(menu).getByText('Rettighetene dine'));
    expect(screen.getByRole('dialog', { name: 'Brukermeny' })).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('dialog', { name: 'Brukermeny' })).toBeNull();
  });

  it.each([
    ['/building-blocks', 'Byggeklosser', 'Byggeklosser'],
    ['/skills', 'Ferdigheter', 'Byggeklosser'],
    ['/playground', 'Prøveområde', 'Prøveområde'],
  ])('renders the %s page and highlights %s in the menu', async (path, heading, item) => {
    await renderAt(`#${path}`);

    expect(screen.getByRole('heading', { level: 1, name: heading })).toBeTruthy();
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(within(menu).getByRole('link', { name: item }).getAttribute('aria-current')).toBe(
      'page',
    );
    expectAccessible();
  });

  it('follows the hash when navigating', async () => {
    await renderAt('#/overview');
    go('#/log');
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(within(menu).getByRole('link', { name: 'Logg' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  it('moves focus to the main content when going to another page', async () => {
    await renderAt('#/overview');
    go('#/log');
    expect(document.activeElement?.id).toBe('hovedinnhold');
  });

  it.each([
    ['/help', 'Brukerveiledning'],
    ['/status', 'Driftsstatus'],
    ['/contact', 'Kontakt Digdir'],
  ])('gives the unbuilt %s page its own h1', async (path, title) => {
    await renderAt(`#${path}`);
    expect(screen.getByRole('heading', { level: 1, name: title })).toBeTruthy();
  });

  it.each([
    ['/help', /Slik henger sidene sammen/],
    ['/status', /Siden spør plattformens API om det svarer/],
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
    fireEvent.click(screen.getByRole('button', { name: 'Ingrid Berg, åpne brukermeny' }));
    const menu = screen.getByRole('dialog', { name: 'Brukermeny' });
    expect(within(menu).getByText('Lese')).toBeTruthy();
    expect(within(menu).getByText('Skrive')).toBeTruthy();
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
    render(<App auth={auth} fetch={mockFetch()} live />);

    fireEvent.click(screen.getByRole('button', { name: 'Ingrid Berg, åpne brukermeny' }));
    const menu = screen.getByRole('dialog', { name: 'Brukermeny' });
    expect(
      within(menu)
        .getAllByText(/./, { selector: '.ds-tag' })
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
    await screen.findByRole('button', { name: 'Ingrid Berg, åpne brukermeny' });

    await waitFor(() => {
      if (!screen.queryByRole('dialog', { name: 'Brukermeny' }))
        fireEvent.click(screen.getByRole('button', { name: 'Ingrid Berg, åpne brukermeny' }));
      const menu = screen.getByRole('dialog', { name: 'Brukermeny' });
      fireEvent.click(within(menu).getByRole('button', { name: 'Logg ut' }));
    });

    expect((await screen.findAllByRole('button', { name: 'Logg inn' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('navigation', { name: 'Hovedmeny' })).toBeNull();
  });
});

it('counts the ingest badge in live mode from the datasets whose last ingestion failed', async () => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/overview';
  render(<App auth={auth} fetch={mockFetch()} live />);
  const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
  await waitFor(() =>
    expect(within(menu).getByRole('link', { name: /Datasett/ }).textContent).toBe('Datasett1'),
  );
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

describe('language choice in the user menu', () => {
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

    fireEvent.click(await screen.findByRole('button', { name: 'Kari Nordmann, open user menu' }));
    const choice = screen.getByRole('group', { name: 'Språk / Language' });
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
  const locked = (lockdown: boolean): typeof fetch => {
    const base = mockFetch();
    return async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/health')
        ? Response.json({ status: 'ok', version: 'test', lockdown })
        : base(input, init);
    };
  };

  it('tells a TestID login that changes, models and ingestion need an Entra login', async () => {
    await renderAt('/overview', locked(true));

    expect(
      await screen.findByText(
        'Låst testmiljø: du kan se deg rundt, men endringer, modeller og innlesing krever innlogging med Entra ID.',
      ),
    ).toBeTruthy();
  });

  it('shows an Entra login the ordinary locked-environment banner', async () => {
    const token = `e30.${btoa(JSON.stringify({ acr: 'entraid' })).replace(/=+$/, '')}.sig`;
    const auth: AuthClient = {
      current: () => ({ ...kari, token }),
      login: async () => ({ ...kari, token }),
      logout: async () => undefined,
    };
    window.location.hash = '#/overview';
    render(<App auth={auth} fetch={locked(true)} />);

    expect(
      await screen.findByText(
        'Låst testmiljø: bare Entra ID-innlogging kan endre. Den og API-nøklene og klientene den lager kan bruke modeller og lese inn.',
      ),
    ).toBeTruthy();
  });

  it('shows no banner when the environment is not locked', async () => {
    await renderAt('/overview', locked(false));

    expect(await screen.findAllByRole('navigation', { name: 'Hovedmeny' })).toHaveLength(1);
    expect(screen.queryByText(/Låst testmiljø/)).toBeNull();
  });
});
