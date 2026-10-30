// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { exampleOrganisations, mockFetch } from '../mock';
import { A2aChannel } from './integrations/A2aChannel';
import { expectAccessible, failingFetch, kari, renderAt } from '../test-utils';

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
afterEach(cleanup);

interface Call {
  method: string;
  url: string;
  reason: string | null;
  body: unknown;
}

const recording = () => {
  const calls: Call[] = [];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? 'GET',
      url,
      reason: decodeURIComponent(headers.get('change-reason') ?? ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return base(input, init);
  };
  return { calls, fetch };
};

describe('Integrasjoner: oversikt', () => {
  it('shows what needs follow-up and opens the failing system with its fix', async () => {
    await renderAt('#/developer/systems');

    expect(screen.getByRole('heading', { level: 1, name: 'Utviklerverktøy' })).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: '2 integrasjoner trenger oppfølging' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Systemer' }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getAllByLabelText('1 med feil')).toHaveLength(2);
    expect(
      screen.getByText('Kallene blir avvist fordi klienten mangler en tillatelse.'),
    ).toBeTruthy();
    expect(screen.getByText('Teknisk kode: 403 insufficient_scope')).toBeTruthy();
    await screen.findByRole('region', { name: 'Arkivsøk' });
    expectAccessible();

    fireEvent.click(screen.getAllByRole('button', { name: 'Endre tillatelser' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByRole('heading', { name: 'Tillatelser for Rapportverktøy for økonomi' }),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText(/Lese forbruk/));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre' }));
    expect(
      await screen.findByText(
        'Tillatelsene for Rapportverktøy for økonomi er lagret. Neste kall fra systemet blir godtatt.',
      ),
    ).toBeTruthy();
    expect(screen.getByRole('heading', { name: '1 integrasjon trenger oppfølging' })).toBeTruthy();
  });

  it('validates a new system and adds it', async () => {
    await renderAt('#/developer/systems');
    fireEvent.click(screen.getByRole('button', { name: 'Koble til system' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Koble til' }));
    expect(within(dialog).getByText('Rett opp i dette:')).toBeTruthy();
    expect(within(dialog).getAllByText('Skriv navnet på systemet.').length).toBeGreaterThan(0);

    fireEvent.change(within(dialog).getByLabelText('Navn på systemet'), {
      target: { value: 'Journalsystemet' },
    });
    fireEvent.change(within(dialog).getByLabelText('Klient-ID fra Maskinporten'), {
      target: { value: '8f3c2a1e-4b7d-4e19-9a52-6d0c3e7b1f99' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Koble til' }));
    expect(await screen.findByText(/Journalsystemet er koblet til\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Journalsystemet/, expanded: true })).toBeTruthy();
  });

  it('lists frontends and registers one in the test environment', async () => {
    await renderAt('#/developer/frontends');
    expect(screen.getByRole('button', { name: /Intranettet/ })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Registrer brukerflate' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Navn'), { target: { value: 'Ny side' } });
    fireEvent.change(
      within(dialog).getByLabelText('Adresse brukeren sendes tilbake til etter innlogging'),
      { target: { value: 'http://localhost:5173/cb' } },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer' }));
    expect(await screen.findByText('Ny side er registrert i testmiljøet.')).toBeTruthy();
  });
});

describe('Integrasjoner: utløser feiler', () => {
  it('opens the failing queue and pastes a new key', async () => {
    await renderAt('#/developer/triggers');
    expect(
      screen.getByText('Vi får ikke lest fra køen fordi tilgangsnøkkelen er utløpt.'),
    ).toBeTruthy();
    expect(screen.getByText('Siste hendelser')).toBeTruthy();
    expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Lim inn ny nøkkel' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Tilgangsnøkkel'), {
      target: { value: 'kort' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre og les køen' }));
    expect(
      within(dialog).getAllByText('Lim inn hele nøkkelen. Den er vanligvis over 40 tegn.').length,
    ).toBeGreaterThan(0);
    fireEvent.change(within(dialog).getByLabelText('Tilgangsnøkkel'), {
      target: { value: 'Endpoint=sb://testetaten/;SharedAccessKey=abcdefghijklmnop' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Lagre og les køen' }));
    expect(
      await screen.findByText('Nøkkelen er lagret. De 132 meldingene som ventet, behandles nå.'),
    ).toBeTruthy();
  });

  it('pauses and restarts a trigger', async () => {
    await renderAt('#/developer/triggers?open=plan-uke');
    fireEvent.click(screen.getByRole('button', { name: 'Start igjen' }));
    expect(await screen.findByText('Hver mandag kl. 06.00 er startet igjen.')).toBeTruthy();
  });
});

describe('Integrasjoner: Nøkler', () => {
  it('lists keys from the API with access, rate and last use', async () => {
    await renderAt('#/developer/keys');
    const list = await screen.findByRole('list', { name: 'API-nøkler' });
    expect(within(list).getByText('Publiseringssystemet')).toBeTruthy();
    expect(within(list).getByText('Alle tjenester og datasett')).toBeTruthy();
    expect(within(list).getByText('Trukket tilbake')).toBeTruthy();
    expect(within(list).getByText(/60 kall per minutt · sist brukt i dag kl. 02.03/)).toBeTruthy();
    expectAccessible();
  });

  it('offers the server default of 120 calls per minute for a new key', async () => {
    await renderAt('#/developer/keys');
    await screen.findByRole('list', { name: 'API-nøkler' });
    fireEvent.click(screen.getByRole('button', { name: 'Lag API-nøkkel' }));
    expect((screen.getByLabelText('Kall per minutt') as HTMLInputElement).value).toBe('120');
  });

  it('validates and creates a key shown once, through the API with a reason', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/keys', fetch);
    await screen.findByRole('list', { name: 'API-nøkler' });

    fireEvent.click(screen.getByRole('button', { name: 'Lag API-nøkkel' }));
    fireEvent.change(screen.getByLabelText('Kall per minutt'), { target: { value: '7000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lag nøkkel' }));
    expect(screen.getByText('Rett opp i dette:')).toBeTruthy();
    expect(screen.getAllByText('Skriv et helt tall fra 1 til 6 000.').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Gi nøkkelen et navn.').length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Analyseverktøy' } });
    fireEvent.click(screen.getByLabelText('Rapportassistenten'));
    fireEvent.change(screen.getByLabelText('Kall per minutt'), { target: { value: '120' } });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Nytt analyseverktøy' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag nøkkel' }));

    expect((await screen.findByLabelText('Den nye nøkkelen')).textContent).toBe(
      'gp_mockkey_7f3a91c2d4e6b8a0',
    );
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/api-keys'));
    expect(post?.reason).toBe('Nytt analyseverktøy');
    expect(post?.body).toEqual({
      name: 'Analyseverktøy',
      datasets: [],
      agents: ['rapportassistenten__default'],
      callsPerMinute: 120,
    });
    const list = await screen.findByRole('list', { name: 'API-nøkler' });
    await waitFor(() => expect(within(list).getByText('Analyseverktøy')).toBeTruthy());
    const created = within(list).getByText('Analyseverktøy').closest('li') as HTMLElement;
    expect(within(created).getByText(/^120 kall per minutt/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Jeg har lagret nøkkelen' }));
    expect(screen.queryByLabelText('Den nye nøkkelen')).toBeNull();
  });

  it('asks for confirmation and a reason before revoking', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/keys', fetch);
    const list = await screen.findByRole('list', { name: 'API-nøkler' });
    fireEvent.click(
      within(list).getAllByRole('button', { name: 'Trekk tilbake' })[0] as HTMLElement,
    );
    expect(
      screen.getByText(/får avvist alle kall med en gang. Dette kan ikke angres./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Trekk tilbake nøkkelen' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);

    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Ikke i bruk lenger' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Trekk tilbake nøkkelen' }));
    expect(
      await screen.findByText('Publiseringssystemet er trukket tilbake. Endringen er logget.'),
    ).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/key-cms/revoke'))?.reason).toBe('Ikke i bruk lenger');
  });

  it('refuses a revoke reason shorter than 10 characters', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/keys', fetch);
    const list = await screen.findByRole('list', { name: 'API-nøkler' });
    fireEvent.click(
      within(list).getAllByRole('button', { name: 'Trekk tilbake' })[0] as HTMLElement,
    );
    fireEvent.change(screen.getByLabelText('Begrunnelse'), { target: { value: '123456789' } });
    fireEvent.click(screen.getByRole('button', { name: 'Trekk tilbake nøkkelen' }));

    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/revoke'))).toBe(false);
  });

  it('shows the name read-only when changing access to a key', async () => {
    await renderAt('#/developer/keys');
    const list = await screen.findByRole('list', { name: 'API-nøkler' });
    fireEvent.click(
      within(list).getAllByRole('button', { name: 'Endre tilgang' })[0] as HTMLElement,
    );

    const name = screen.getByLabelText('Navn') as HTMLInputElement;
    expect(name.value).toBe('Publiseringssystemet');
    expect(name.readOnly).toBe(true);
  });

  it('offers no access change in live mode, where the API cannot change a key', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/developer/keys';
    render(<App auth={auth} fetch={mockFetch()} live />);
    const list = await screen.findByRole('list', { name: 'API-nøkler' });

    expect(within(list).getAllByRole('button', { name: 'Roter' }).length).toBeGreaterThan(0);
    expect(within(list).queryByRole('button', { name: 'Endre tilgang' })).toBeNull();
  });

  it('rotates a key: a new secret, and the old one is revoked', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/keys', fetch);
    const list = await screen.findByRole('list', { name: 'API-nøkler' });
    fireEvent.click(within(list).getAllByRole('button', { name: 'Roter' })[0] as HTMLElement);
    expect(await screen.findByLabelText('Den nye nøkkelen')).toBeTruthy();
    expect(
      screen.getByText(/Hvor lenge den gamle kan virke parallelt, er ikke bestemt./),
    ).toBeTruthy();
    expect(calls.some((c) => c.url.endsWith('/key-cms/revoke'))).toBe(true);
  });

  it('shows an error with retry when keys cannot be loaded', async () => {
    await renderAt('#/developer/keys', failingFetch(/\/access$/));
    expect(await screen.findByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
  });
});

describe('Integrasjoner: verktøy fra egne systemer', () => {
  it('needs a reason, then approves a pending tool change', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/developer/systems', fetch);
    const arkiv = await screen.findByRole('region', { name: 'Arkivsøk' });
    fireEvent.click(within(arkiv).getByRole('button', { name: 'Godkjenn arkiv.sok' }));
    expect(await screen.findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Ny versjon er gjennomgått' },
    });
    fireEvent.click(within(arkiv).getByRole('button', { name: 'Godkjenn arkiv.sok' }));
    expect(await screen.findByText('arkiv.sok er godkjent.')).toBeTruthy();
    expect(calls.find((c) => c.url.endsWith('/approve'))?.reason).toBe('Ny versjon er gjennomgått');
  });
});

describe('Integrasjoner: Sporing og evaluering', () => {
  it('shows a failing Langfuse connection, then a healthy one', async () => {
    await renderAt('#/developer/runs');
    expect(screen.getByRole('heading', { name: 'Sporing og evaluering' })).toBeTruthy();
    expect(screen.getByText('Langfuse avviser nøkkelen siden kl. 09.40.')).toBeTruthy();
    expectAccessible();

    cleanup();
    await renderAt('#/developer/runs?status=ok');
    expect(screen.queryByText('Langfuse avviser nøkkelen siden kl. 09.40.')).toBeNull();
    expect(screen.getAllByText('Tilkoblet').length).toBeGreaterThan(0);
  });

  it('validates before connecting a new tool', async () => {
    await renderAt('#/developer/runs?status=ok');
    fireEvent.click(screen.getByRole('button', { name: /Arize Phoenix/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Koble til' }));
    expect(screen.getByText('Rett opp i dette før du lagrer:')).toBeTruthy();
  });
});

describe('Integrasjoner: dokumentasjon og kode', () => {
  it('links to the guides and the API reference', async () => {
    await renderAt('#/developer/api');
    expect(
      screen.getAllByRole('link', { name: /API-referanse/ }).map((a) => a.getAttribute('href')),
    ).toContain('#/api-reference');
    fireEvent.click(screen.getByRole('button', { name: 'Last ned OpenAPI-fil' }));
    expect(await screen.findByText('OpenAPI-filen er lastet ned.')).toBeTruthy();
    expectAccessible();
  });

  it('shows how to call a service from code in each channel', async () => {
    await renderAt('#/developer/api/code');
    expect(
      screen.getByRole('heading', { level: 1, name: 'Kall en tjeneste fra kode' }),
    ).toBeTruthy();
    expect(screen.getByLabelText('POST /api/tools/call/rapportassistenten__default')).toBeTruthy();
    expectAccessible();

    fireEvent.click(screen.getByLabelText('OpenAI-kompatibel'));
    expect(screen.getByLabelText('POST /v1/chat/completions').textContent).toContain(
      '"model": "rapportassistenten__default"',
    );
    fireEvent.click(screen.getByLabelText('MCP'));
    expect(screen.getByLabelText('Oppsett for MCP-klient').textContent).toContain('/api/mcp');
    expect(screen.queryByRole('button', { name: 'Vis eksempel på svar' })).toBeNull();
  });

  it('says the example answer is only an example and nothing was sent', async () => {
    await renderAt('#/developer/api/code');
    fireEvent.click(screen.getByRole('button', { name: 'Vis eksempel på svar' }));

    expect(
      await screen.findByText('Eksempel på svar. Ingen kall er sendt.', {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(screen.queryByText(/logget som en testkjøring/)).toBeNull();
  });
});

describe('Integrasjoner: kall fra kode i live-modus', () => {
  const service = (id: string, name: string, lifecycle: string) => ({
    id,
    name,
    purpose: '',
    outputKind: 'answer',
    channels: ['api'],
    latestVersion: 1,
    status: 'active',
    statusReason: null,
    lifecycle,
    updatedAt: null,
    updatedBy: null,
    runsThisWeek: 0,
  });
  const liveFetch = (): typeof globalThis.fetch => {
    const base = mockFetch();
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    return async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, 'http://x').pathname.replace(/^\/api/, '');
      if (/^\/tenants\/[^/]+\/access$/.test(path))
        return reply({
          services: [
            { id: 'ka', name: 'KA', publicName: 'kunnskapsassistenten', requirement: {} },
            { id: 'old', name: 'Gammel', publicName: 'gammel__default', requirement: {} },
          ],
          keys: [],
        });
      if (/^\/tenants\/[^/]+\/services$/.test(path))
        return reply({
          data: [
            service('ka', 'Kunnskapsassistenten', 'active'),
            service('old', 'Gammel tjeneste', 'archived'),
          ],
        });
      return base(input, init);
    };
  };

  it("lists only the tenant's published services by their public name, not demo services", async () => {
    const auth = mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/developer/api/code';
    render(<App auth={auth} fetch={liveFetch()} live />);
    const select = await screen.findByLabelText('Tjeneste');
    const options = within(select)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['Kunnskapsassistenten (kunnskapsassistenten)']);
    expect(screen.getByLabelText('POST /api/tools/call/kunnskapsassistenten')).toBeTruthy();
    expect(screen.queryByText(/Rapportassistenten|borealis|opg_7f2kq9d1/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vis eksempel på svar' })).toBeNull();
  });
});

describe('Integrasjoner: Maskinporten-klienter', () => {
  const renderLive = async (fetch: typeof globalThis.fetch) => {
    const auth = mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = '#/developer/systems';
    render(<App auth={auth} fetch={fetch} live />);
    return screen.findByRole('region', { name: 'Maskinporten-klienter' });
  };

  it('lists registered clients with the services they may call and the scope they need', async () => {
    const section = await renderLive(mockFetch());

    expect(within(section).getAllByText(/digdir:ki\.tjenester\.kall/).length).toBeGreaterThan(0);
    const row = await within(section).findByRole('button', { name: /Tilskuddssystemet/ });
    expect(within(row).getByText('Kan kalle: Rapportassistenten')).toBeTruthy();
  });

  it('validates and registers a client for chosen services with a reason', async () => {
    const { calls, fetch } = recording();
    const section = await renderLive(fetch);
    fireEvent.click(within(section).getByRole('button', { name: 'Registrer Maskinporten-klient' }));
    const dialog = await screen.findByRole('dialog', { name: 'Registrer Maskinporten-klient' });

    fireEvent.click(within(dialog).getByLabelText('Bare utvalgte tjenester'));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer' }));
    expect(within(dialog).getByText(/Klient-ID-en skal se slik ut/)).toBeTruthy();
    expect(within(dialog).getByText('Velg minst én tjeneste.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'POST')).toBe(false);

    fireEvent.change(within(dialog).getByLabelText('Klient-ID fra Maskinporten'), {
      target: { value: '0b9d6c4e-2f1a-4a8b-9e3d-7c5b1a2f4e6d' },
    });
    fireEvent.change(within(dialog).getByLabelText('Navn på systemet'), {
      target: { value: 'Arkivsystemet' },
    });
    fireEvent.click(await within(dialog).findByLabelText('Møtereferat'));
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Arkivet skal forenkle brev' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer' }));

    expect(await screen.findByText(/Arkivsystemet er registrert/)).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/maskinporten-clients'));
    expect(post?.body).toEqual({
      clientId: '0b9d6c4e-2f1a-4a8b-9e3d-7c5b1a2f4e6d',
      name: 'Arkivsystemet',
      services: ['motereferat'],
    });
    expect(post?.reason).toBe('Arkivet skal forenkle brev');
    expect(await within(section).findByRole('button', { name: /^Arkivsystemet/ })).toBeTruthy();
  });

  it('registers a client for all services as a wildcard', async () => {
    const { calls, fetch } = recording();
    const section = await renderLive(fetch);
    fireEvent.click(within(section).getByRole('button', { name: 'Registrer Maskinporten-klient' }));
    const dialog = await screen.findByRole('dialog', { name: 'Registrer Maskinporten-klient' });
    fireEvent.change(within(dialog).getByLabelText('Klient-ID fra Maskinporten'), {
      target: { value: '0b9d6c4e-2f1a-4a8b-9e3d-7c5b1a2f4e6d' },
    });
    fireEvent.change(within(dialog).getByLabelText('Navn på systemet'), {
      target: { value: 'Arkivsystemet' },
    });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Arkivet bruker alle tjenestene' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Registrer' }));

    await screen.findByText(/Arkivsystemet er registrert/);
    expect(
      calls.find((c) => c.method === 'POST' && c.url.endsWith('/maskinporten-clients'))?.body,
    ).toMatchObject({ services: ['*'] });
    expect(await within(section).findByText('Kan kalle: Alle tjenester')).toBeTruthy();
  });

  it('asks for a reason before removing a client', async () => {
    const { calls, fetch } = recording();
    const section = await renderLive(fetch);
    fireEvent.click(await within(section).findByRole('button', { name: /Tilskuddssystemet/ }));
    fireEvent.click(within(section).getByRole('button', { name: 'Fjern' }));
    fireEvent.click(within(section).getByRole('button', { name: 'Fjern klienten' }));
    expect(within(section).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.change(within(section).getByLabelText('Begrunnelse'), {
      target: { value: 'Systemet er faset ut' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Fjern klienten' }));

    expect(await screen.findByText(/Tilskuddssystemet er fjernet/)).toBeTruthy();
    const removed = calls.find((c) => c.method === 'DELETE');
    expect(removed?.url).toMatch(/\/maskinporten-clients\/4f1c2a7e-91b3-4d0a-8c55-2e6f9a1b3c7d$/);
    expect(removed?.reason).toBe('Systemet er faset ut');
    await waitFor(() =>
      expect(within(section).queryByRole('button', { name: /Tilskuddssystemet/ })).toBeNull(),
    );
  });
});

describe('Integrasjoner: kroker', () => {
  const renderAtHash = async (fetch: typeof globalThis.fetch, hash: string) => {
    const auth = mockAnsattporten({ name: 'Kari Nordmann', organisations: exampleOrganisations });
    await auth.login();
    window.location.hash = hash;
    render(<App auth={auth} fetch={fetch} live />);
  };
  const renderHooks = async (fetch: typeof globalThis.fetch) => {
    await renderAtHash(fetch, '#/developer/hooks');
    return screen.findByRole('region', { name: 'Kroker' });
  };

  it('lists own hooks in a table with when they run, what they do and a switch', async () => {
    const section = await renderHooks(mockFetch());
    const link = await within(section).findByRole('link', {
      name: 'Stopp fødselsnummer før modellen',
    });
    const row = link.closest('tr') as HTMLElement;

    expect(within(row).getByText('Før modellkall')).toBeTruthy();
    expect(within(row).getByText('Stopper')).toBeTruthy();
    expect(within(row).getByText('Alle')).toBeTruthy();
    expect(within(row).getByText(/Innebygd: stopp ord og uttrykk · tidsavbrudd 2 s/)).toBeTruthy();
    expect((within(row).getByRole('switch', { name: /er på/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect(link.getAttribute('href')).toBe('#/developer/hooks/fodselsnummer');
  });

  it('turns a hook off from the list with a logged reason', async () => {
    const { calls, fetch } = recording();
    const section = await renderHooks(fetch);
    fireEvent.click(await within(section).findByRole('switch', { name: /er på/ }));

    expect(await screen.findByText(/er slått av/)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toMatch(/\/hooks\/fodselsnummer$/);
    expect(put?.body).toMatchObject({ enabled: false });
    expect(put?.reason).toMatch(/Slo av kroken/);
  });

  it('adds a webhook hook on its own page with a reason after checking the address and secret', async () => {
    const { calls, fetch } = recording();
    await renderAtHash(fetch, '#/developer/hooks/new');
    const form = await screen.findByRole('form', { name: 'Ny krok' });

    fireEvent.change(within(form).getByLabelText('Navn'), {
      target: { value: 'Logg svar til arkivet' },
    });
    fireEvent.change(within(form).getByLabelText('Når kroken kjører'), {
      target: { value: 'after_model' },
    });
    fireEvent.change(within(form).getByLabelText('Adresse'), {
      target: { value: 'http://arkiv.example.no/krok' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));
    expect(within(form).getByText('Adressen må starte med https://.')).toBeTruthy();
    expect(within(form).getByText(/Skriv en begrunnelse/)).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);

    fireEvent.change(within(form).getByLabelText('Adresse'), {
      target: { value: 'https://arkiv.example.no/krok' },
    });
    fireEvent.change(within(form).getByLabelText(/Navn på hemmeligheten/), {
      target: { value: 'arkiv-krok' },
    });
    fireEvent.change(within(form).getByLabelText('Begrunnelse'), {
      target: { value: 'Arkivet skal få kopi av svarene' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Lagre' }));

    expect(await screen.findByText('Kroken er lagret. Den kjører fra neste kall.')).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toMatch(/\/hooks\/logg-svar-til-arkivet$/);
    expect(put?.reason).toBe('Arkivet skal få kopi av svarene');
    expect(put?.body).toMatchObject({
      point: 'after_model',
      mode: 'observe',
      failure: 'open',
      handler: { kind: 'webhook', url: 'https://arkiv.example.no/krok', secret: 'arkiv-krok' },
    });
  });

  it('tests a saved hook and shows how long it took and what it did', async () => {
    await renderAtHash(mockFetch(), '#/developer/hooks/fodselsnummer');
    const panel = await screen.findByRole('region', { name: 'Test kroken' });
    fireEvent.click(within(panel).getByRole('button', { name: 'Test kroken' }));

    expect(await within(panel).findByText('Svarte på 212 ms')).toBeTruthy();
    expect(within(panel).getByText('Stoppet kallet')).toBeTruthy();
    expect(within(panel).getByText(/Brukeren ville sett/)).toBeTruthy();
  });
});

describe('A2A som kanal', () => {
  it('shows the agent card address, the skill and that the Maskinporten scope is not decided', () => {
    render(
      <A2aChannel
        name="Rapportassistenten"
        purpose="Svarer på spørsmål om rapporter i Kudos, med kilder."
        publicName="rapportassistenten__default"
        hasInputForm
        apiBase="https://ki.example.no"
      />,
    );

    expect((screen.getByLabelText('Adressen til agentkortet') as HTMLInputElement).value).toBe(
      'https://ki.example.no/a2a/rapportassistenten__default/.well-known/agent-card.json',
    );
    expect(screen.getByRole('button', { name: /Kopier/ })).toBeTruthy();
    expect(
      screen.getByText('Rapportassistenten: svarer på spørsmål om rapporter i Kudos, med kilder'),
    ).toBeTruthy();
    expect(screen.getByText('Tekst, og skjemaet for inndata som JSON Schema')).toBeTruthy();
    expect(screen.getByText('Ikke bestemt')).toBeTruthy();
  });
});
