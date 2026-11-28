// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider, storedPreference } from '@genai/i18n/react';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const signedIn = async (path = '#/tenants', roles = [operatorRole], fetch = mockFetch()) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('a locked environment', () => {
  const health = (lockdown: boolean, readOnly = true): typeof fetch => {
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

  it('tells a read-only operator that changes, models and ingestion need an Entra login', async () => {
    await signedIn('#/tenants', [operatorRole], health(true));

    expect(
      await screen.findByText(
        'Låst testplattform: du kan se deg rundt, men endringer, modeller og innlesing krever innlogging med Entra ID.',
      ),
    ).toBeTruthy();
  });

  it('shows no banner to an admitted Entra login', async () => {
    const seen: string[] = [];
    const fetcher = health(true, false);
    await signedIn('#/tenants', [operatorRole], async (input, init) => {
      seen.push(String(input instanceof Request ? input.url : input));
      return fetcher(input, init);
    });

    await waitFor(() => expect(seen.some((url) => url.endsWith('/me'))).toBe(true));
    expect(await screen.findByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
    expect(screen.queryByText(/Låst testplattform/)).toBeNull();
  });

  it('shows no banner when the environment is not locked', async () => {
    await signedIn('#/tenants', [operatorRole], health(false));

    expect(await screen.findByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
    expect(screen.queryByText(/Låst testplattform/)).toBeNull();
  });
});

describe('operator shell', () => {
  it('asks for a Digdir login and opens the console for an operator', async () => {
    render(
      <App auth={mockEntra({ name: 'Lise Dahl', roles: [operatorRole] })} fetch={mockFetch()} />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Logg inn med Digdir-konto' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
  });

  it('refuses an account without the operator role', async () => {
    await signedIn('#/tenants', []);

    expect(
      screen.getByRole('heading', { name: 'Du har ikke tilgang til driftskonsollet' }),
    ).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
  });

  it('links to the system atlas screen inside the console from the user menu', async () => {
    await signedIn('#/tenants');

    fireEvent.click(screen.getByRole('button', { name: 'Brukermeny for Lise Dahl' }));
    const atlas = screen.getByRole('menuitem', { name: 'Systematlas' });

    expect(atlas.getAttribute('href')).toBe('#/atlas');
    expect(atlas.getAttribute('target')).toBeNull();
  });

  it('shows the atlas on the whole view without the console shell on the atlas route', async () => {
    await signedIn('#/atlas');

    expect(await screen.findByRole('heading', { level: 1, name: 'Systematlas' })).toBeTruthy();
    expect(screen.getByTitle('Systematlas for GenKI').getAttribute('src')).toBe(
      '/system-atlas.html',
    );
    expect(screen.queryByRole('navigation', { name: 'Konsollmeny' })).toBeNull();
    expect(screen.queryByText('Driftskonsoll')).toBeNull();
  });

  it('shows the environment, the grouped menu with the current page and a skip link', async () => {
    await signedIn('#/shared-services');

    expect(screen.getAllByText('Driftskonsoll').length).toBeGreaterThan(0);
    expect(screen.getByText('Lokalt')).toBeTruthy();
    const menu = screen.getByRole('navigation', { name: 'Konsollmeny' });
    expect(
      within(menu)
        .getAllByRole('list')
        .map((l) => l.getAttribute('aria-labelledby')),
    ).toEqual(['gruppe-work', 'gruppe-platform']);
    for (const label of ['Katalog', 'Logg', 'Kvalitet', 'Innstillinger'])
      expect(within(menu).getByRole('link', { name: label })).toBeTruthy();
    expect(
      within(menu).getByRole('link', { name: 'Delte tjenester' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(screen.getByRole('link', { name: 'Hopp til hovedinnhold' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Meny' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
  });

  it('says so for an address that does not exist', async () => {
    await signedIn('#/finnes-ikke');

    expect(screen.getByRole('heading', { name: 'Fant ikke siden' })).toBeTruthy();
  });

  it('logs the operator out on a 401 and offers a working Logg inn button', async () => {
    const base = mockFetch();
    let valid = false;
    const fetch: typeof globalThis.fetch = async (input, init) =>
      valid || !String(input).includes('/operator/tenants')
        ? base(input, init)
        : new Response(JSON.stringify({ title: 'Ikke logget inn', status: 401 }), { status: 401 });
    await signedIn('#/tenants', [operatorRole], fetch);

    expect(await screen.findByRole('heading', { name: 'Du er logget ut' })).toBeTruthy();
    expect(screen.queryByRole('navigation', { name: 'Konsollmeny' })).toBeNull();
    expect(screen.queryByText(/Logg inn på nytt/)).toBeNull();
    valid = true;
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
    expect(window.location.hash).toBe('#/tenants');
  });

  it('shows only a replacement notice on the old platform defaults page', async () => {
    await signedIn('#/platform-defaults');

    expect(screen.getByRole('heading', { name: 'Denne siden er erstattet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Åpne Innstillinger' }).getAttribute('href')).toBe(
      '#/settings',
    );
  });
});

describe('virksomheter', () => {
  afterEach(() => vi.useRealTimers());

  it('shows the status as text and the organisation number in groups of three', async () => {
    await signedIn();

    const table = await screen.findByRole('table');
    const row = within(table)
      .getByRole('link', { name: 'Testetaten' })
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('Aktiv')).toBeTruthy();
    expect(within(row).getByText('999 888 777')).toBeTruthy();
  });

  it('filters by status and search, and offers to reset when nothing matches', async () => {
    await signedIn();
    await screen.findByRole('table');

    fireEvent.change(screen.getByRole('combobox', { name: 'Status' }), {
      target: { value: 'onboarding' },
    });
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(4);

    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk' }), {
      target: { value: 'finnes ikke' },
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Nullstill søket' }));
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(12);
  });

  it('shows an error with retry when tenants cannot be loaded', async () => {
    await signedIn('#/tenants', [operatorRole], async () => new Response('{}', { status: 503 }));

    expect(await screen.findByRole('heading', { name: 'Kunne ikke hente dataene' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });
});

describe('revisjon', () => {
  afterEach(() => vi.useRealTimers());

  it('shows readable actions, tenant names and "Person i" instead of raw ids', async () => {
    const base = mockFetch();
    const raw: typeof fetch = async (input, init) =>
      String(input).includes('/operator/audit?')
        ? Response.json({
            data: [
              {
                task: 'a1',
                tenant: '991825827',
                action: 'platform.pipeline.execute',
                actor: 'employee:ansattporten:7f3c9a',
                at: new Date().toISOString(),
                outcome: 'applied',
                target: 'platform.pipeline.execute',
                reason: 'Ny innlesing',
              },
              {
                task: 'a2',
                tenant: '999888777',
                action: 'platform.something.new',
                actor: 'employee:ansattporten:91ab',
                at: new Date().toISOString(),
                outcome: 'applied',
                target: 'veiledere',
                reason: 'Test',
              },
            ],
          })
        : base(input, init);
    await signedIn('#/audit', [operatorRole], raw);

    const log = await screen.findByRole('region', { name: 'Logg' });
    const first = within(log).getByText('Ny innlesing').closest('tr') as HTMLElement;
    expect(within(first).getByText('Startet innlesing')).toBeTruthy();
    expect(within(first).getByText('Person i Digdir')).toBeTruthy();
    expect(first.textContent).not.toMatch(/991825827|7f3c9a|platform\./);
    const second = within(log).getByText('Test').closest('tr') as HTMLElement;
    expect(within(second).getByText(/^Annen handling/)).toBeTruthy();
    expect(await within(second).findByText('Person i Testetaten')).toBeTruthy();
  });

  it('names platform actions, like loading the local configuration, as the platform', async () => {
    const base = mockFetch();
    const raw: typeof fetch = async (input, init) =>
      String(input).includes('/operator/audit?')
        ? Response.json({
            data: [
              {
                task: 'a1',
                tenant: '991825827',
                action: 'platform.service.publish',
                actor: 'platform:seed',
                at: new Date().toISOString(),
                outcome: 'applied',
                target: 'definition:991825827/klarsprak@1',
                reason: 'local configuration',
              },
            ],
          })
        : base(input, init);
    await signedIn('#/audit', [operatorRole], raw);

    const log = await screen.findByRole('region', { name: 'Logg' });
    const row = within(log).getByText('local configuration').closest('tr') as HTMLElement;
    expect(within(row).getByText('Plattformen')).toBeTruthy();
    expect(row.textContent).not.toMatch(/Person i/);
  });

  it('shows the person and the service a publish concerns', async () => {
    const base = mockFetch();
    const raw: typeof fetch = async (input, init) =>
      String(input).includes('/operator/audit?')
        ? Response.json({
            data: [
              {
                task: 'p1',
                tenant: '991825827',
                action: 'platform.service.publish',
                actor: 'employee:ansattporten:7f3c9a',
                actorName: 'Kari Testansatt',
                at: new Date().toISOString(),
                outcome: 'applied',
                target: 'Service:klarsprak@3',
                reason: 'Ny versjon av klarspråk',
              },
            ],
          })
        : base(input, init);
    await signedIn('#/audit', [operatorRole], raw);

    const log = await screen.findByRole('region', { name: 'Logg' });
    const row = within(log).getByText('Ny versjon av klarspråk').closest('tr') as HTMLElement;
    expect(within(row).getByText(/^Kari Testansatt/)).toBeTruthy();
    expect(row.textContent).toMatch(/klarsprak/);
    expect(row.textContent).toMatch(/versjon 3/);
  });

  it('explains how to see a log when the cross-tenant log is not available', async () => {
    const base = mockFetch();
    const missing: typeof fetch = async (input, init) =>
      String(input).includes('/operator/audit?')
        ? new Response('{}', { status: 404 })
        : base(input, init);
    await signedIn('#/audit', [operatorRole], missing);

    expect(await screen.findByText(/ikke tilgjengelig ennå/)).toBeTruthy();
  });
});

describe('language choice for operators', () => {
  it('keeps the choice in this browser, since operators have no tenant to store it in', async () => {
    const stored = storedPreference(window.localStorage, 'genai.console.language');
    stored.save(null);
    const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
    await auth.login();
    window.location.hash = '#/tenants';
    render(
      <LocaleProvider initialPreference={stored.load()} onPreferenceChange={stored.save}>
        <App auth={auth} fetch={mockFetch()} />
      </LocaleProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Brukermeny for Lise Dahl' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Språk / Language' }));
    const choice = await screen.findByRole('group', { name: 'Språk / Language', hidden: true });
    fireEvent.click(within(choice).getByRole('radio', { name: 'English', hidden: true }));

    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(stored.load()).toBe('en');
    stored.save(null);
  });
});
