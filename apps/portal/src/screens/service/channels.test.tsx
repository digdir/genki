// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useEffect, useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { mockFetch } from '../../mock';
import { RightsProvider } from '../../Shell';
import { expectAccessible } from '../../test-utils';
import { ServiceChannels } from './Channels';

afterEach(() => {
  cleanup();
  window.location.hash = '';
});

const frontendIn = (hash: string) => /\/channels\/([^/]+)$/.exec(hash)?.[1];

const Routed = (props: Omit<Parameters<typeof ServiceChannels>[0], 'frontend'>) => {
  const [hash, setHash] = useState(window.location.hash);
  useEffect(() => {
    const changed = () => setHash(window.location.hash);
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  }, []);
  return <ServiceChannels {...props} frontend={frontendIn(hash)} />;
};

const openFrontend = async (service: string, id: string) => {
  window.location.hash = `#/services/${service}/channels/${id}`;
  await waitFor(() => expect(screen.queryByRole('list', { name: 'Brukerflater' })).toBeNull());
};

interface Call {
  method: string;
  url: string;
  reason: string | null;
  body: unknown;
}

const setting = (key: string, description: string, category: string, call = true) => ({
  key,
  description,
  category,
  axis: 'service',
  sensitivity: 'normal',
  default: null,
  settableAt: call ? ['platform', 'service', 'call'] : ['platform', 'service'],
});

const catalog = [
  setting('retrieval.topK', 'Antall tekstbiter per søk', 'Søk'),
  setting('retrieval.autoFilter', 'Automatisk filtrering', 'Søk'),
  setting('answer.language', 'Språket svaret skrives på', 'Svar'),
  setting('model.primary', 'Hovedmodell', 'Modell', false),
];

const setup = (service = 'rapportassistenten', { secretsFail = false } = {}) => {
  const calls: Call[] = [];
  const base = mockFetch();
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      method: init?.method ?? 'GET',
      url,
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    if (secretsFail && new URL(url, 'http://test').pathname.endsWith('/secrets'))
      return new Response(JSON.stringify({ title: 'Forbidden', status: 403 }), { status: 403 });
    if (new URL(url, 'http://test').pathname === '/api/settings')
      return new Response(JSON.stringify({ data: catalog }), {
        headers: { 'content-type': 'application/json' },
      });
    return base(input, init);
  };
  const api = createApiClient({ baseUrl: '/api', fetch, token: () => 'test' });
  render(
    <RightsProvider value={['manage-services']}>
      <main>
        <h1>Rapportassistenten</h1>
        <Routed api={api} tenant="999888777" service={service} apiBase="https://api.example.no" />
      </main>
    </RightsProvider>,
  );
  return { calls };
};

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('channels and frontends for a service', () => {
  it('lists endpoints and the registered frontends with how to connect', async () => {
    setup();
    const cards = await screen.findByRole('list', { name: 'Brukerflater' });
    expect(within(cards).getByText('Intranettet')).toBeTruthy();
    const endpoints = screen.getByRole('region', { name: 'Endepunkter' });
    expect(within(endpoints).getAllByText('POST /api/mcp').length).toBeGreaterThan(0);
    expectAccessible();

    await openFrontend('rapportassistenten', 'intranettet');
    expect(await screen.findByRole('heading', { name: 'Intranettet' })).toBeTruthy();
    expect(screen.getByText('testetaten-intranett')).toBeTruthy();
    expect(screen.getByText('Nettleser med innlogging')).toBeTruthy();
    expect(screen.getByText(/client_id: 'testetaten-intranett'/)).toBeTruthy();
    expectAccessible();
  });

  it('opens a frontend on its own page from the list, with a link back to Nøkler og kanaler', async () => {
    setup();
    const cards = await screen.findByRole('list', { name: 'Brukerflater' });
    const details = within(cards).getByRole('link', { name: 'Detaljer for Intranettet' });
    expect(details.getAttribute('href')).toBe('#/services/rapportassistenten/channels/intranettet');

    await openFrontend('rapportassistenten', 'intranettet');
    expect(await screen.findByRole('heading', { level: 2, name: 'Intranettet' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nøkler og kanaler' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten/channels',
    );
    expect(screen.getByRole('button', { name: /^Endre/ })).toBeTruthy();
  });

  it('keeps every endpoint of every channel under Alle endepunkter', async () => {
    setup();
    const endpoints = await screen.findByRole('region', { name: 'Endepunkter' });
    const all = within(endpoints).getByText('Alle endepunkter').closest('details') as HTMLElement;
    expect(within(all).getByText('GET /api/tools/openapi.json')).toBeTruthy();
    expect(within(all).getByText('GET /api/conversations')).toBeTruthy();
    expect(within(all).getByText('GET /api/facets')).toBeTruthy();
  });

  it('registers a browser frontend with origins and Ansattporten, after validation', async () => {
    const { calls } = setup('nytt-oppslag');
    fireEvent.click(await screen.findByRole('link', { name: 'Registrer brukerflate' }));
    fireEvent.click(screen.getByLabelText('Fra nettleseren med innlogging i Ansattporten'));
    fireEvent.click(screen.getByRole('button', { name: 'Registrer' }));
    expect(await screen.findByText('Rett opp i dette:')).toBeTruthy();
    expect(screen.getAllByText(/trenger en klient-ID/).length).toBeGreaterThan(0);

    type('Navn', 'Saksbehandlerportalen');
    type('Tillatte opprinnelser', 'https://sak.testetaten.example.no');
    type('Klient-ID', 'testetaten-sbp');
    type(/sendes tilbake til/, 'https://sak.testetaten.example.no/auth/callback');
    type('Begrunnelse', 'Ny portal for saksbehandlere');
    fireEvent.click(screen.getByRole('button', { name: 'Registrer' }));

    expect(await screen.findByText(/Saksbehandlerportalen er registrert/)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.url).toBe('/api/tenants/999888777/clients/saksbehandlerportalen');
    expect(put?.reason).toBe('Ny portal for saksbehandlere');
    expect(put?.body).toMatchObject({
      metadata: { name: 'Saksbehandlerportalen' },
      spec: {
        service: 'nytt-oppslag',
        kind: 'browser',
        channels: ['mcp'],
        allowedOrigins: ['https://sak.testetaten.example.no'],
        oidc: {
          clientId: 'testetaten-sbp',
          redirectUris: ['https://sak.testetaten.example.no/auth/callback'],
        },
      },
    });
    const cards = await screen.findByRole('list', { name: 'Brukerflater' });
    expect(await within(cards).findByText('Saksbehandlerportalen')).toBeTruthy();
  });

  it('stores a new webhook secret for the webhook address', async () => {
    const { calls } = setup('nytt-oppslag');
    fireEvent.click(await screen.findByRole('link', { name: 'Registrer brukerflate' }));
    type('Navn', 'Saksvarsler');
    type('Adresse varslene sendes til', 'https://varsel.testetaten.example.no/krok');
    fireEvent.click(screen.getByLabelText('En kjøring er ferdig'));
    type('Begrunnelse', 'Saksbehandlerne skal få varsel');
    fireEvent.click(screen.getByRole('button', { name: 'Registrer' }));
    expect(await screen.findByText(/Saksvarsler er registrert/)).toBeTruthy();
    await screen.findByText('Saksvarsler');
    await openFrontend('nytt-oppslag', 'saksvarsler');

    fireEvent.click(await screen.findByRole('button', { name: 'Lag ny hemmelighet' }));

    expect(await screen.findByLabelText('Ny verdi for nytt-oppslag-varsler')).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT' && c.url.includes('/secrets/'));
    expect(put?.url).toBe('/api/tenants/999888777/secrets/nytt-oppslag-varsler');
    expect(put?.body).toMatchObject({ allowedHosts: ['https://varsel.testetaten.example.no'] });
  });

  const registerWebhook = async (secretName?: string) => {
    fireEvent.click(await screen.findByRole('link', { name: 'Registrer brukerflate' }));
    type('Navn', 'Saksvarsler');
    type('Adresse varslene sendes til', 'https://varsel.testetaten.example.no/krok');
    fireEvent.click(screen.getByLabelText('En kjøring er ferdig'));
    if (secretName) type('Navn på hemmeligheten som signerer varslene', secretName);
    type('Begrunnelse', 'Saksbehandlerne skal få varsel');
    fireEvent.click(screen.getByRole('button', { name: 'Registrer' }));
    expect(await screen.findByText(/Saksvarsler er registrert/)).toBeTruthy();
    await screen.findByText('Saksvarsler');
    await openFrontend('nytt-oppslag', 'saksvarsler');
    fireEvent.click(await screen.findByRole('button', { name: 'Lag ny hemmelighet' }));
  };

  it('refuses to roll a webhook secret that is set up for other addresses', async () => {
    const { calls } = setup('nytt-oppslag');
    await registerWebhook('saks-api');

    expect(
      await screen.findByText(
        'Hemmeligheten «saks-api» er satt opp for andre adresser (https://sak.testetaten.example.no). Velg et annet navn på hemmeligheten.',
      ),
    ).toBeTruthy();
    expect(screen.queryByLabelText('Ny verdi for saks-api')).toBeNull();
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/secrets/'))).toBe(false);
  });

  it('stores no webhook secret when its addresses could not be checked', async () => {
    const { calls } = setup('nytt-oppslag', { secretsFail: true });
    await registerWebhook();

    expect(
      await screen.findByText(
        'Vi kunne ikke sjekke hvilke adresser hemmeligheten «nytt-oppslag-varsler» er satt opp for, så ingenting er lagret.',
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.method === 'PUT' && c.url.includes('/secrets/'))).toBe(false);
  });

  it('refuses an origin with a path', async () => {
    setup();
    fireEvent.click(await screen.findByRole('link', { name: 'Registrer brukerflate' }));
    type('Navn', 'Test');
    type('Tillatte opprinnelser', 'https://app.example.no/sti');
    fireEvent.click(screen.getByRole('button', { name: 'Registrer' }));
    expect((await screen.findAllByText(/uten sti/)).length).toBeGreaterThan(0);
  });

  it('creates a service key bound to a frontend, shows it once, rotates and revokes it', async () => {
    const { calls } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Lag API-nøkkel' }));
    type('Navn', 'Intranett-server');
    fireEvent.change(screen.getByLabelText('Brukerflate'), { target: { value: 'intranettet' } });
    type('Begrunnelse', 'Serveren til intranettet');
    fireEvent.click(screen.getByRole('button', { name: 'Lag nøkkel' }));

    expect(await screen.findByLabelText('Den nye nøkkelen')).toBeTruthy();
    const post = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/services/rapportassistenten/api-keys'),
    );
    expect(post?.body).toEqual({
      name: 'Intranett-server',
      client: 'intranettet',
      allowedOverrides: [],
    });
    const keys = await screen.findByRole('table');
    expect(await within(keys).findByText('Brukerflate: Intranettet')).toBeTruthy();
    expect(within(keys).getByText('Aldri')).toBeTruthy();

    fireEvent.click(within(keys).getByRole('button', { name: 'Roter Intranett-server' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lag ny nøkkel' }));
    expect(await screen.findByText(/slutter å virke med en gang\./)).toBeTruthy();
    await waitFor(() => expect(within(keys).getByText(/· rotert /)).toBeTruthy());
    expect(within(keys).getAllByRole('row')).toHaveLength(2);

    fireEvent.click(within(keys).getByRole('button', { name: 'Trekk tilbake Intranett-server' }));
    type('Begrunnelse', 'Trengs ikke lenger');
    fireEvent.click(screen.getByRole('button', { name: 'Trekk tilbake nøkkelen' }));
    await waitFor(() => expect(within(keys).getAllByText('Trukket tilbake')).toHaveLength(1));
  });

  it('picks overridable settings, with a wildcard per group, when creating and rotating a key', async () => {
    const { calls } = setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Lag API-nøkkel' }));
    const picker = await screen.findByRole('group', {
      name: /Innstillinger som kan overstyres per kall/,
    });
    await within(picker).findByLabelText('Alt om søk');
    expect(within(picker).queryByLabelText('Hovedmodell')).toBeNull();
    fireEvent.click(within(picker).getByLabelText('Antall tekstbiter per søk'));
    fireEvent.click(within(picker).getByLabelText('Alt om søk'));
    expect(within(picker).queryByLabelText('Antall tekstbiter per søk')).toBeNull();
    fireEvent.click(within(picker).getByLabelText('Språket svaret skrives på'));
    type('Navn', 'Overstyrer');
    type('Begrunnelse', 'Trenger egne søkeinnstillinger');
    fireEvent.click(screen.getByRole('button', { name: 'Lag nøkkel' }));

    await screen.findByLabelText('Den nye nøkkelen');
    const created = calls.find(
      (c) => c.method === 'POST' && c.url.endsWith('/services/rapportassistenten/api-keys'),
    );
    expect(created?.body).toEqual({
      name: 'Overstyrer',
      allowedOverrides: ['retrieval.*', 'answer.language'],
    });
    const keys = await screen.findByRole('table');
    const allowed = await within(keys).findByRole('list', { name: 'Har lov til' });
    expect(
      within(allowed)
        .getAllByRole('listitem')
        .map((i) => i.textContent),
    ).toEqual([
      'Alle miljøer',
      'Alle kanaler',
      'Kan overstyre: alt om søk, språket svaret skrives på',
    ]);

    fireEvent.click(within(keys).getByRole('button', { name: 'Roter Overstyrer' }));
    const rotating = await screen.findByRole('group', { name: 'Roter Overstyrer' });
    fireEvent.click(within(rotating).getByLabelText('Språket svaret skrives på'));
    fireEvent.click(within(rotating).getByRole('button', { name: 'Lag ny nøkkel' }));
    await waitFor(() =>
      expect(
        within(keys)
          .getAllByRole('list', { name: 'Har lov til' })
          .map((l) =>
            within(l)
              .getAllByRole('listitem')
              .map((i) => i.textContent),
          ),
      ).toContainEqual(['Alle miljøer', 'Alle kanaler', 'Kan overstyre: alt om søk']),
    );
    const rotated = calls.find((c) => c.url.endsWith('/rotate'));
    expect(rotated?.body).toEqual({ allowedOverrides: ['retrieval.*'] });
    expectAccessible();
  });
});
