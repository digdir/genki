// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LocaleProvider, storedPreference } from '@genai/i18n/react';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { exampleModels, mockFetch } from './mock';
import type { RefreshResult } from './types';

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
  const health = (lockdown: boolean): typeof fetch => {
    const base = mockFetch();
    return async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      return url.endsWith('/health')
        ? Response.json({ status: 'ok', version: 'test', lockdown })
        : base(input, init);
    };
  };

  it('tells a TestID operator that changes, models and ingestion need an Entra login', async () => {
    await signedIn('#/tenants', [operatorRole], health(true));

    expect(
      await screen.findByText(
        'Låst testmiljø: du kan se deg rundt, men endringer, modeller og innlesing krever innlogging med Entra ID.',
      ),
    ).toBeTruthy();
  });

  it('shows an Entra login the ordinary locked-environment banner', async () => {
    const token = `e30.${btoa(JSON.stringify({ acr: 'entraid' })).replace(/=+$/, '')}.sig`;
    const session = { name: 'Lise Dahl', roles: [operatorRole], token };
    window.location.hash = '#/tenants';
    render(
      <App
        auth={{
          current: () => session,
          login: async () => session,
          logout: async () => undefined,
          expire: () => undefined,
        }}
        fetch={health(true)}
      />,
    );

    expect(
      await screen.findByText(
        'Låst testmiljø: bare Entra ID-innlogging kan endre. Den og API-nøklene og klientene den lager kan bruke modeller og lese inn.',
      ),
    ).toBeTruthy();
  });

  it('shows no banner when the environment is not locked', async () => {
    await signedIn('#/tenants', [operatorRole], health(false));

    expect(await screen.findByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
    expect(screen.queryByText(/Låst testmiljø/)).toBeNull();
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

  it('links to the system atlas screen inside the console from the support menu', async () => {
    await signedIn('#/tenants');

    const menu = screen.getByRole('navigation', { name: 'Konsollmeny' });
    const atlas = within(menu).getByRole('link', { name: 'Systematlas' });

    expect(atlas.getAttribute('href')).toBe('#/atlas');
    expect(atlas.getAttribute('target')).toBeNull();
    expect(within(menu).getByText('Atlaset finnes bare på engelsk.')).toBeTruthy();
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

  it('shows the dark header, audit notice, grouped menu with badges and the current page', async () => {
    await signedIn('#/shared-services');

    expect(screen.getByText('Driftskonsoll')).toBeTruthy();
    expect(screen.getByText('Lokalt')).toBeTruthy();
    expect(screen.getByRole('note').textContent).toMatch(/Alt du gjør her, logges i Revisjon/);
    const menu = screen.getByRole('navigation', { name: 'Konsollmeny' });
    expect(
      within(menu)
        .getAllByRole('list')
        .map((l) => l.getAttribute('aria-labelledby')),
    ).toEqual(['gruppe-customers', 'gruppe-platform', 'gruppe-support']);
    for (const label of [
      'Byggeklosser',
      'Søkemotorer',
      'Innstillinger',
      'Kvalitet',
      'Kvalitetsmatrise og dommere',
      'Sporing og evaluering',
    ])
      expect(within(menu).getByRole('link', { name: label })).toBeTruthy();
    expect(within(menu).queryByRole('link', { name: 'Dommere' })).toBeNull();
    expect(
      within(menu).getByRole('link', { name: 'Fellestjenester' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(await within(menu).findByRole('link', { name: /3 feil/ })).toBeTruthy();
    expect(await within(menu).findByRole('link', { name: /venter på beslutning/ })).toBeTruthy();
    expect(within(menu).getByRole('link', { name: 'Oppstart' })).toBeTruthy();
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
  it('lists tenants with KPIs, status as text and a quota warning', async () => {
    await signedIn();

    const table = await screen.findByRole('table');
    expect(screen.getByText('Tokens i oktober', { selector: 'dt' })).toBeTruthy();
    const row = within(table)
      .getByRole('rowheader', { name: /Eksempeldirektoratet/ })
      .closest('tr') as HTMLElement;
    expect(within(row).getByText('Aktiv')).toBeTruthy();
    expect(within(row).getByText('Nær kvoten')).toBeTruthy();
    expect(within(row).getByText('11 i bruk av 14')).toBeTruthy();
    expect(within(table).getByText(/999 888 777/)).toBeTruthy();
  });

  it('filters by status and search, and blocks support access for tenants in onboarding', async () => {
    await signedIn();
    await screen.findByRole('table');

    fireEvent.click(screen.getByRole('radio', { name: 'Oppstart' }));
    const table = screen.getByRole('table');
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    const blocked = within(table).getByRole('button', {
      name: 'Støttetilgang til Eksempel kommune',
    });
    expect(blocked.getAttribute('aria-disabled')).toBe('true');

    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk etter navn eller org.nr.' }), {
      target: { value: 'finnes ikke' },
    });
    expect(screen.getByText(/Ingen virksomheter passer søket/)).toBeTruthy();
  });

  it('shows an error with retry when tenants cannot be loaded', async () => {
    await signedIn('#/tenants', [operatorRole], async () => new Response('{}', { status: 503 }));

    expect(await screen.findByRole('heading', { name: 'Kunne ikke hente dataene' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });
});

describe('modeller', () => {
  const modelTable = async () =>
    within(await screen.findByRole('region', { name: 'Modeller' })).getByRole('table');
  const recording = (fetch = mockFetch()) => {
    const calls: { method: string; path: string; body?: unknown; reason?: string }[] = [];
    const wrapped: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input), 'http://mock');
      const raw = new Headers(init?.headers).get('change-reason');
      const reason = raw && decodeURIComponent(raw);
      calls.push({
        method: init?.method ?? 'GET',
        path: url.pathname,
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
        ...(reason ? { reason } : {}),
      });
      return fetch(input, init);
    };
    return { calls, fetch: wrapped };
  };

  const giveReason = (text = 'Bekreftet med Azure-teamet') =>
    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: text },
    });

  it('lists every model with where it came from and marks unconfirmed ones', async () => {
    await signedIn('#/models');

    const table = await modelTable();
    const rows = within(table).getAllByRole('row');
    expect(rows).toHaveLength(exampleModels.length + 1);
    const first = within(rows[1] as HTMLElement);
    expect(first.getByText('gpt-4o-2M-tps')).toBeTruthy();
    expect(first.getByText('Ikke bekreftet')).toBeTruthy();
    expect(
      (screen.getByLabelText('Datalagring for gpt-4o-2M-tps') as HTMLSelectElement).value,
    ).toBe('global');
  });

  it('shows the price per 1 000 tokens or Ikke priset, and why GlobalStandard is global', async () => {
    await signedIn('#/models');

    const table = await modelTable();
    const row = (name: string) =>
      within(table).getByText(name, { selector: 'strong' }).closest('tr') as HTMLElement;
    expect(within(row('gpt-4.1')).getByText('0,02 kr inn, 0,08 kr ut')).toBeTruthy();
    expect(within(row('gpt-4o-2M-tps')).getByText('Ikke priset')).toBeTruthy();
    expect(within(row('gpt-4o-2M-tps')).queryByText(/0 kr/)).toBeNull();
    const select = screen.getByLabelText('Datalagring for gpt-4o-2M-tps');
    const hint = document.getElementById(select.getAttribute('aria-describedby') ?? '');
    expect(hint?.textContent).toBe('GlobalStandard-utrullinger i Azure er «Globalt».');
  });

  it('saves a residency, a capability and switching a model on, with the reason', async () => {
    const { calls, fetch } = recording();
    await signedIn('#/models', [operatorRole], fetch);
    await modelTable();
    giveReason();

    fireEvent.change(screen.getByLabelText('Datalagring for gpt-4o-2M-tps'), {
      target: { value: 'norway' },
    });
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Datalagring for gpt-4o-2M-tps') as HTMLSelectElement).value,
      ).toBe('norway'),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: 'Resonnering for gpt-4.1' }));
    await waitFor(() =>
      expect(
        (screen.getByRole('checkbox', { name: 'Resonnering for gpt-4.1' }) as HTMLInputElement)
          .checked,
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole('switch', { name: 'claude-sonnet-5-5 er i bruk' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(3));

    expect(
      calls.filter((c) => c.method === 'PATCH').map((c) => [c.path, c.body, c.reason]),
    ).toEqual([
      [
        '/api/operator/models/foundry-openai/gpt-4o-2m-tps',
        { residency: 'norway' },
        'Bekreftet med Azure-teamet',
      ],
      [
        '/api/operator/models/foundry-openai/gpt-4.1',
        { capabilities: ['stream', 'tools', 'json-schema', 'reasoning'] },
        'Bekreftet med Azure-teamet',
      ],
      [
        '/api/operator/models/foundry-claude/claude-sonnet-5-5',
        { enabled: true },
        'Bekreftet med Azure-teamet',
      ],
    ]);
  });

  it('retires a model only through a dialog that says services pause instead of switching', async () => {
    const { calls, fetch } = recording();
    await signedIn('#/models', [operatorRole], fetch);
    await modelTable();

    fireEvent.click(screen.getByRole('switch', { name: 'gpt-4.1 er i bruk' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Ingen tjeneste bytter av seg selv/).textContent).toMatch(
      /settes på pause/,
    );
    expect(within(dialog).getByText('Vedtaksutkast')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fas ut' }));
    expect(await within(dialog).findByText(/minst 10 tegn/)).toBeTruthy();
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);

    fireEvent.change(within(dialog).getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Microsoft avslutter versjonen' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fas ut' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(1));
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ enabled: false });
    expect(await screen.findByText(/er faset ut\. Endringen er logget i Revisjon\./)).toBeTruthy();
  });

  it('says how many models a refresh found and which providers did not answer', async () => {
    const result: RefreshResult = {
      discovered: 41,
      failed: [{ endpoint: 'foundry-claude', error: 'listing deployments failed with HTTP 401' }],
    };
    await signedIn('#/models', [operatorRole], mockFetch(undefined, undefined, result));
    await modelTable();
    giveReason('Ny deployment i Foundry');

    fireEvent.click(screen.getByRole('button', { name: 'Hent modeller på nytt' }));

    expect(await screen.findByText('Fant 41 modeller.')).toBeTruthy();
    expect(
      screen.getByText(/foundry-claude: listing deployments failed with HTTP 401/),
    ).toBeTruthy();
  });

  it('asks for a reason before a change or refresh, and sends nothing without one', async () => {
    const { calls, fetch } = recording();
    await signedIn('#/models', [operatorRole], fetch);
    await modelTable();

    fireEvent.click(screen.getByRole('button', { name: 'Hent modeller på nytt' }));

    expect(await screen.findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  const recorded = () => {
    const base = mockFetch();
    const calls: { method: string; path: string; body?: unknown; reason?: string }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const raw = new Headers(init?.headers).get('change-reason');
      calls.push({
        method: init?.method ?? 'GET',
        path: new URL(String(input), 'http://mock').pathname.replace(/^\/api/, ''),
        ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
        ...(raw ? { reason: decodeURIComponent(raw) } : {}),
      });
      return base(input, init);
    };
    return { calls, fetch };
  };

  const fillReason = (scope: HTMLElement, text = 'Ny avtale med leverandøren') =>
    fireEvent.change(within(scope).getByLabelText('Begrunnelse'), { target: { value: text } });

  it('adds a model endpoint and stores its secret without showing it again', async () => {
    const { calls, fetch } = recorded();
    await signedIn('#/models', [operatorRole], fetch);

    fireEvent.click(await screen.findByRole('button', { name: 'Legg til modellendepunkt' }));
    const panel = screen.getByRole('dialog', { name: 'Legg til modellendepunkt' });
    fireEvent.change(within(panel).getByLabelText('Navn'), { target: { value: 'foundry-eu' } });
    fireEvent.change(within(panel).getByLabelText('Protokoll'), {
      target: { value: 'anthropic-messages' },
    });
    fireEvent.change(within(panel).getByLabelText('Adresse (base URL)'), {
      target: { value: 'https://eu.foundry.example' },
    });
    fireEvent.change(within(panel).getByLabelText('Navn på hemmeligheten'), {
      target: { value: 'foundry-eu-key' },
    });
    fireEvent.change(within(panel).getByLabelText('Verdi'), { target: { value: 'sk-hemmelig' } });
    fillReason(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre hemmelighet' }));

    expect(await within(panel).findByText(/foundry-eu-key er lagret/)).toBeTruthy();
    expect((within(panel).getByLabelText('Verdi') as HTMLInputElement).value).toBe('');
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/operator/secrets/foundry-eu-key',
      body: { value: 'sk-hemmelig' },
      reason: 'Ny avtale med leverandøren',
    });

    fireEvent.click(within(panel).getByRole('button', { name: 'Legg til endepunkt' }));
    const table = await screen.findByRole('region', { name: 'Modellendepunkter' });
    const row = (await within(table).findByText('foundry-eu')).closest('tr') as HTMLElement;
    expect(within(row).getByText('Anthropic-kompatibel (Messages)')).toBeTruthy();
    expect(within(row).getByText('foundry-eu-key')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      id: 'foundry-eu',
      protocol: 'anthropic-messages',
      baseURL: 'https://eu.foundry.example',
      auth: { kind: 'api-key', secret: 'secret://platform/foundry-eu-key' },
    });
    expect(document.body.textContent).not.toContain('sk-hemmelig');
  });

  it('lists the services that still use an endpoint instead of removing it', async () => {
    await signedIn('#/models');

    const table = await screen.findByRole('region', { name: 'Modellendepunkter' });
    fireEvent.click(within(table).getByRole('button', { name: 'Fjern foundry-openai' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fjern foundry-openai' });
    fillReason(dialog, 'Avtalen med leverandøren er sagt opp');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fjern' }));

    expect(await within(dialog).findByText('Henvisningssortering')).toBeTruthy();
    expect(within(dialog).getByText(/fortsatt i bruk/)).toBeTruthy();
    expect(within(table).getByText('foundry-openai')).toBeTruthy();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));
    fireEvent.click(within(table).getByRole('button', { name: 'Fjern foundry-claude' }));
    const second = await screen.findByRole('dialog', { name: 'Fjern foundry-claude' });
    fillReason(second, 'Avtalen med leverandøren er sagt opp');
    fireEvent.click(within(second).getByRole('button', { name: 'Fjern' }));

    expect(await screen.findByText(/foundry-claude er fjernet/)).toBeTruthy();
    await waitFor(() => expect(within(table).queryByText('foundry-claude')).toBeNull());
  });

  it('adds a model under an endpoint', async () => {
    const { calls, fetch } = recorded();
    await signedIn('#/models', [operatorRole], fetch);

    const table = await screen.findByRole('region', { name: 'Modellendepunkter' });
    fireEvent.click(
      within(table).getByRole('button', { name: 'Legg til modell under foundry-claude' }),
    );
    const panel = screen.getByRole('dialog', { name: 'Legg til modell' });
    fireEvent.change(within(panel).getByLabelText('Utrulling (deployment)'), {
      target: { value: 'claude-haiku-5' },
    });
    fireEvent.change(within(panel).getByLabelText('Datalagring'), { target: { value: 'eu' } });
    fireEvent.click(within(panel).getByLabelText('Verktøy'));
    fireEvent.click(within(panel).getByLabelText('I bruk'));
    fillReason(panel);
    fireEvent.click(within(panel).getByRole('button', { name: 'Lagre modell' }));

    const models = await modelTable();
    expect(await within(models).findByText('claude-haiku-5')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')).toEqual({
      method: 'PUT',
      path: '/operator/models/foundry-claude/claude-haiku-5',
      body: {
        endpoint: 'foundry-claude',
        deployment: 'claude-haiku-5',
        residency: 'eu',
        capabilities: ['stream', 'tools'],
        enabled: true,
      },
      reason: 'Ny avtale med leverandøren',
    });
  });

  it('sets a price in kroner per 1 000 tokens', async () => {
    const { calls, fetch } = recorded();
    await signedIn('#/models', [operatorRole], fetch);

    const models = await modelTable();
    const row = within(models).getByText('gpt-4o-2M-tps', { selector: 'strong' }).closest('tr');
    expect(within(row as HTMLElement).getByText('Ikke priset')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Sett pris for gpt-4o-2M-tps' }));
    const dialog = await screen.findByRole('dialog', { name: 'Sett pris for gpt-4o-2M-tps' });
    fireEvent.change(within(dialog).getByLabelText('Inn (kr per 1 000 tokens)'), {
      target: { value: '0,01' },
    });
    fireEvent.change(within(dialog).getByLabelText('Ut (kr per 1 000 tokens)'), {
      target: { value: 'gratis' },
    });
    fillReason(dialog, 'Pris fra avtalen for 2027');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre pris' }));
    expect(await within(dialog).findByText(/begge prisene som tall/)).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText('Ut (kr per 1 000 tokens)'), {
      target: { value: '0,03' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre pris' }));

    await waitFor(() =>
      expect(within(row as HTMLElement).getByText('0,01 kr inn, 0,03 kr ut')).toBeTruthy(),
    );
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      path: '/operator/models/foundry-openai/gpt-4o-2m-tps/price',
      body: { inputPerThousand: 0.01, outputPerThousand: 0.03 },
    });
  });

  it('marks temperature as not sent for a model and shows the rule in the row', async () => {
    const { calls, fetch } = recorded();
    await signedIn('#/models', [operatorRole], fetch);

    const models = await modelTable();
    const row = within(models).getByText('gpt-4o-2M-tps', { selector: 'strong' }).closest('tr');
    fireEvent.click(screen.getByRole('button', { name: 'Parametere for gpt-4o-2M-tps' }));
    const dialog = await screen.findByRole('dialog', { name: 'Parametere for gpt-4o-2M-tps' });
    fireEvent.change(within(dialog).getByLabelText('Temperatur'), {
      target: { value: 'unsupported' },
    });
    fillReason(dialog, 'Modellen avviser temperatur');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre parametere' }));

    await waitFor(() =>
      expect(within(row as HTMLElement).getByText('Temperatur: sendes ikke')).toBeTruthy(),
    );
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      path: '/operator/models/foundry-openai/gpt-4o-2m-tps',
      body: { parameters: { temperature: { mode: 'unsupported' } } },
      reason: 'Modellen avviser temperatur',
    });
  });

  it('tells the operator that a model has rejected temperature and suggests a rule', async () => {
    const rejected = exampleModels.map((m, i) =>
      i === 0 ? { ...m, rejectedParameters: { temperature: '2026-10-09T08:00:00Z' } } : m,
    );
    await signedIn('#/models', [operatorRole], mockFetch(undefined, rejected));

    const models = await modelTable();
    expect(await within(models).findByText('Har avvist temperatur')).toBeTruthy();
  });

  it('explains what to do when no models were found', async () => {
    await signedIn('#/models', [operatorRole], mockFetch(undefined, []));

    expect(await screen.findByRole('heading', { name: 'Ingen modeller funnet' })).toBeTruthy();
  });
});

describe('støttetilgang', () => {
  it('needs a reason of 10 characters, then shows a banner on every page saying changes are logged', async () => {
    await signedIn('#/support-access?tenant=999888777');

    fireEvent.click(await screen.findByRole('button', { name: 'Start støttetilgang' }));
    expect(await screen.findByText('Før du kan starte, må du rette opp i dette:')).toBeTruthy();
    expect(screen.getAllByText(/Nå er det 0/).length).toBeGreaterThan(0);

    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Kunden ser ikke kvoten riktig, sak DIG-4420' },
    });
    fireEvent.click(screen.getByRole('radio', { name: '15 minutter' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start støttetilgang' }));

    expect(
      await screen.findByRole('heading', { name: 'Portalen til Testetaten, støttetilgang' }),
    ).toBeTruthy();
    const banner = screen
      .getAllByRole('status')
      .find((s) => s.textContent?.includes('Støttetilgang til Testetaten')) as HTMLElement;
    expect(banner.textContent).toMatch(/endringer logges som «Endring fra Digdir» · 15 min igjen/);

    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Konsollmeny' })).getByRole('link', {
        name: 'Revisjon',
      }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: 'Revisjon' })).toBeTruthy();
    expect(screen.getByText(/Støttetilgang til Testetaten/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Avslutt økten' }));
    await waitFor(() => expect(screen.queryByText(/Støttetilgang til Testetaten/)).toBeNull());
  });
});

describe('revisjon', () => {
  afterEach(() => vi.useRealTimers());

  it('lists every action across tenants and filters by Digdir, person and action', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T12:00:00+02:00'));
    await signedIn('#/audit');

    const log = await screen.findByRole('region', { name: 'Revisjonslogg' });
    expect(screen.getByText('10 hendelser')).toBeTruthy();
    expect(within(log).getAllByText('Digdir').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('checkbox', { name: 'Bare handlinger fra Digdir' }));
    expect(screen.getByText('5 hendelser')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Person' }), {
      target: { value: 'Jon' },
    });
    expect(screen.getByText('2 hendelser')).toBeTruthy();

    fireEvent.change(screen.getByRole('combobox', { name: 'Handling' }), {
      target: { value: 'Satte modell til utfasing' },
    });
    expect(within(log).getByText('Microsoft avslutter versjonen')).toBeTruthy();

    fireEvent.change(screen.getByRole('searchbox', { name: 'Person' }), {
      target: { value: 'ingen slik' },
    });
    expect(screen.getByText(/Ingen hendelser passer filteret/)).toBeTruthy();
  });

  it('shows readable actions, tenant names and "Person i" instead of raw ids', async () => {
    const base = mockFetch();
    const raw: typeof fetch = async (input, init) =>
      String(input).endsWith('/operator/audit')
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

    const log = await screen.findByRole('region', { name: 'Revisjonslogg' });
    const first = within(log).getByText('Ny innlesing').closest('tr') as HTMLElement;
    expect(within(first).getByText('Startet innlesing')).toBeTruthy();
    expect(within(first).getByText('Person i Digdir')).toBeTruthy();
    expect(first.textContent).not.toMatch(/991825827|7f3c9a|platform\./);
    const second = within(log).getByText('Test').closest('tr') as HTMLElement;
    expect(within(second).getByText('Annen handling')).toBeTruthy();
    expect(await within(second).findByText('Person i Testetaten')).toBeTruthy();
  });

  it('shows the person and the service a publish concerns, with a link to the service', async () => {
    const base = mockFetch();
    const raw: typeof fetch = async (input, init) =>
      String(input).endsWith('/operator/audit')
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

    const log = await screen.findByRole('region', { name: 'Revisjonslogg' });
    const row = within(log).getByText('Ny versjon av klarspråk').closest('tr') as HTMLElement;
    expect(within(row).getByText('Kari Testansatt')).toBeTruthy();
    expect(within(row).getByText('versjon 3')).toBeTruthy();
    fireEvent.click(within(row).getByRole('button', { name: 'klarsprak' }));
    expect(window.location.hash).toContain('/tenants/services');
    expect(window.location.hash).toContain('id=klarsprak');
  });

  it('explains how to see a log when the cross-tenant log is not available', async () => {
    const base = mockFetch();
    const missing: typeof fetch = async (input, init) =>
      String(input).endsWith('/operator/audit')
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

    fireEvent.click(await screen.findByRole('button', { name: 'Språk / Language' }));
    const choice = await screen.findByRole('group', { name: 'Språk / Language', hidden: true });
    fireEvent.click(within(choice).getByRole('radio', { name: 'English', hidden: true }));

    await waitFor(() => expect(document.documentElement.lang).toBe('en'));
    expect(stored.load()).toBe('en');
    stored.save(null);
  });
});
