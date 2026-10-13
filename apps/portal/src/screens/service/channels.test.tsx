// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { mockFetch } from '../../mock';
import { expectAccessible } from '../../test-utils';
import { ServiceChannels } from './Channels';

afterEach(cleanup);

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

const setup = (service = 'rapportassistenten') => {
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
    if (new URL(url, 'http://test').pathname === '/api/settings')
      return new Response(JSON.stringify({ data: catalog }), {
        headers: { 'content-type': 'application/json' },
      });
    return base(input, init);
  };
  const api = createApiClient({ baseUrl: '/api', fetch, token: () => 'test' });
  render(
    <main>
      <h1>Rapportassistenten</h1>
      <ServiceChannels
        api={api}
        tenant="999888777"
        service={service}
        apiBase="https://api.example.no"
      />
    </main>,
  );
  return { calls };
};

const type = (label: RegExp | string, value: string) =>
  fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe('channels and frontends for a service', () => {
  it('lists endpoints and the registered frontends with how to connect', async () => {
    setup();
    const cards = await screen.findByRole('list', { name: 'Brukerflater' });
    expect(within(cards).getByRole('heading', { name: 'Intranettet' })).toBeTruthy();
    expect(within(cards).getByText('testetaten-intranett')).toBeTruthy();
    expect(within(cards).getByText('Nettleser med innlogging')).toBeTruthy();
    expect(screen.getByText('POST /api/mcp')).toBeTruthy();
    expect(within(cards).getByText(/client_id: 'testetaten-intranett'/)).toBeTruthy();
    expectAccessible();
  });

  it('registers a browser frontend with origins and Ansattporten, after validation', async () => {
    const { calls } = setup('nytt-oppslag');
    fireEvent.click(await screen.findByRole('button', { name: 'Registrer brukerflate' }));
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
    expect(within(cards).getByRole('heading', { name: 'Saksbehandlerportalen' })).toBeTruthy();
  });

  it('refuses an origin with a path', async () => {
    setup();
    fireEvent.click(await screen.findByRole('button', { name: 'Registrer brukerflate' }));
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
    const keys = await screen.findByRole('list', { name: 'API-nøkler for tjenesten' });
    expect(within(keys).getByText('Brukerflate: Intranettet')).toBeTruthy();
    expect(within(keys).getByText('Sist brukt aldri')).toBeTruthy();

    fireEvent.click(within(keys).getByRole('button', { name: 'Roter Intranett-server' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Lag ny nøkkel' }));
    expect(await screen.findByText(/slutter å virke med en gang\./)).toBeTruthy();
    await waitFor(() => expect(within(keys).getAllByText('Trukket tilbake')).toHaveLength(1));

    fireEvent.click(within(keys).getByRole('button', { name: 'Trekk tilbake Intranett-server' }));
    type('Begrunnelse', 'Trengs ikke lenger');
    fireEvent.click(screen.getByRole('button', { name: 'Trekk tilbake nøkkelen' }));
    await waitFor(() => expect(within(keys).getAllByText('Trukket tilbake')).toHaveLength(2));
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
    const keys = await screen.findByRole('list', { name: 'API-nøkler for tjenesten' });
    expect(
      await within(keys).findByText('Kan overstyre: Alt om søk, Språket svaret skrives på'),
    ).toBeTruthy();

    fireEvent.click(within(keys).getByRole('button', { name: 'Roter Overstyrer' }));
    const rotating = await screen.findByRole('group', { name: 'Roter Overstyrer' });
    fireEvent.click(within(rotating).getByLabelText('Språket svaret skrives på'));
    fireEvent.click(within(rotating).getByRole('button', { name: 'Lag ny nøkkel' }));
    expect(await within(keys).findByText('Kan overstyre: Alt om søk')).toBeTruthy();
    const rotated = calls.find((c) => c.url.endsWith('/rotate'));
    expect(rotated?.body).toEqual({ allowedOverrides: ['retrieval.*'] });
    expectAccessible();
  });
});
