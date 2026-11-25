// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LocaleProvider } from '@genai/i18n/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { RightsProvider } from '../../Shell';
import { expectAccessible } from '../../test-utils';
import type { HostnameView, PortalRight } from '../../types';
import { ServiceAddress, ServiceWebPage } from './ServiceAddress';

afterEach(cleanup);

const view = (hostname: string, fields: Partial<HostnameView> = {}): HostnameView => ({
  id: `id-${hostname}`,
  hostname,
  client: 'klarsprak-host',
  environment: 'prod',
  redirectTo: null,
  apex: false,
  assigned: false,
  managed: false,
  state: 'active',
  failure: null,
  records: [],
  checkedAt: null,
  createdAt: '2026-11-25T10:00:00Z',
  ...fields,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const setup = (
  initial: HostnameView[],
  {
    rights = ['manage-services'] as PortalRight[],
    client = 'klarsprak-host' as string | null,
    locale = 'nb',
    hasApp = true,
    assigns = true,
    published = true,
    page = false,
    refusal = undefined as { path: string; message: string } | undefined,
  } = {},
) => {
  let hostnames = [...initial];
  const calls: { method: string; path: string; reason: string; body: unknown }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://test');
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(String(init.body)) as Record<string, unknown>)
      : undefined;
    calls.push({
      method,
      path: url.pathname,
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      body,
    });
    if (method === 'GET') return json({ client, hostnames, assigns });
    if (url.pathname.endsWith('/address') && refusal)
      return json({ title: 'Forbidden', status: 403, errors: [refusal] }, 403);
    if (url.pathname.endsWith('/address')) {
      const made = view('klarsprak.apps.genki-test.digdir.cloud', {
        assigned: true,
        state: 'binding',
      });
      hostnames = [...hostnames, made];
      return json(made, 201);
    }
    if (method === 'POST') {
      const made = view(String(body?.hostname), {
        state: 'pending-dns',
        records: [
          { type: 'TXT', name: `_genki-challenge.${String(body?.hostname)}`, value: 'tok' },
        ],
      });
      hostnames = [...hostnames, made];
      return json(made, 201);
    }
    hostnames = hostnames.filter((h) => !url.pathname.endsWith(`/${h.hostname}`));
    return json({});
  };
  const api = createApiClient({ baseUrl: '/api', fetch, token: () => 'test' });
  render(
    <LocaleProvider preference={locale as 'nb' | 'en'}>
      <RightsProvider value={rights}>
        <main>
          <h1>Klarspråk</h1>
          {page ? (
            <ServiceWebPage
              api={api}
              tenant="991825827"
              service="klarsprak"
              published={published}
              hasApp={hasApp}
              canManage={rights.includes('manage-services')}
            />
          ) : (
            <ServiceAddress
              api={api}
              tenant="991825827"
              service="klarsprak"
              hasApp={hasApp}
              canManage={rights.includes('manage-services')}
            />
          )}
        </main>
      </RightsProvider>
    </LocaleProvider>,
  );
  return { calls };
};

describe('the address of a service', () => {
  it('opens the active production address, an own domain before genki’s', async () => {
    setup([
      view('klarsprak.apps.genki-test.digdir.cloud', { assigned: true }),
      view('ka.example.no'),
    ]);

    const open = await screen.findByRole('link', { name: /Åpne tjenesten/ });

    expect(open.getAttribute('href')).toBe('https://ka.example.no/');
    expect(screen.getAllByText('Aktiv')).toHaveLength(2);
    expectAccessible();
  });

  it('shows no open link before the address is active, and the state in plain words', async () => {
    setup([
      view('klarsprak.apps.genki-test.digdir.cloud', { assigned: true, state: 'binding' }),
      view('qa.example.no', { state: 'failed', failure: 'not_verified' }),
    ]);

    expect(await screen.findByText('Settes opp')).toBeTruthy();
    expect(screen.getByText('Feilet')).toBeTruthy();
    expect(screen.getByText('Fant ikke DNS-postene.')).toBeTruthy();
    expect(screen.queryByRole('link', { name: /Åpne tjenesten/ })).toBeNull();
  });

  it('lists the records to create for an own domain waiting for DNS', async () => {
    setup([
      view('ka.example.no', {
        state: 'pending-dns',
        records: [
          { type: 'TXT', name: '_genki-challenge.ka.example.no', value: 'hemmelig-token' },
          { type: 'CNAME', name: 'ka.example.no', value: 'host.azurecontainerapps.io' },
        ],
      }),
    ]);

    const table = await screen.findByRole('table', {
      name: 'Lag disse postene i DNS for domenet:',
    });

    expect(within(table).getByText('hemmelig-token')).toBeTruthy();
    expect(within(table).getByText('host.azurecontainerapps.io')).toBeTruthy();
    expect(screen.getByText('Venter på DNS')).toBeTruthy();
  });

  it('gives a published service its address on request', async () => {
    const { calls } = setup([]);

    fireEvent.click(await screen.findByRole('button', { name: 'Få en adresse' }));

    expect(await screen.findByText('Settes opp')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/api/tenants/991825827/services/klarsprak/address',
      reason: 'Gir tjenesten en adresse',
    });
    expect(screen.queryByRole('button', { name: 'Få en adresse' })).toBeNull();
  });

  it('explains that a design under Utforming and a publish give the service an address, with no button', async () => {
    setup([], { hasApp: false });

    expect(
      await screen.findByText(
        /Tjenesten får en egen nettside når den har en utforming under Utforming/,
      ),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Utforming' }).getAttribute('href')).toBe(
      '#/services/klarsprak/interface',
    );
    expect(screen.queryByRole('button', { name: 'Få en adresse' })).toBeNull();
  });

  it('adds and removes an own domain', async () => {
    const { calls } = setup([view('klarsprak.apps.genki-test.digdir.cloud', { assigned: true })]);

    fireEvent.change(await screen.findByLabelText('Eget domene'), {
      target: { value: 'KA.example.no ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));
    expect(await screen.findByText('Venter på DNS')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/api/tenants/991825827/clients/klarsprak-host/hostnames',
      body: { hostname: 'ka.example.no', environment: 'prod' },
    });

    fireEvent.click(screen.getByRole('button', { name: 'Fjern ka.example.no' }));

    await waitFor(() => expect(screen.queryByText('ka.example.no')).toBeNull());
    expect(calls.find((c) => c.method === 'DELETE')?.path).toBe(
      '/api/tenants/991825827/clients/klarsprak-host/hostnames/ka.example.no',
    );
  });

  it('offers no changes without manage-services', async () => {
    setup([view('ka.example.no')], { rights: ['use-services'] });

    expect(await screen.findByText('ka.example.no')).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByLabelText('Eget domene')).toBeNull();
  });

  it('says the platform gives no addresses when it has no zone to give them in', async () => {
    setup([], { assigns: false });

    expect(
      await screen.findByText('Denne plattformen gir ikke tjenester egne adresser.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Få en adresse' })).toBeNull();
  });

  it('speaks English', async () => {
    setup([view('ka.example.no', { state: 'pending-dns' })], { locale: 'en' });

    expect(await screen.findByText('Waiting for DNS')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Address' })).toBeTruthy();
  });
});

describe('the own web page of a service, in Kanaler and on Oversikt', () => {
  it('links to the address once it is served', async () => {
    setup([view('klarsprak.apps.genki-test.digdir.cloud', { assigned: true })], { page: true });

    const link = await screen.findByRole('link', { name: /klarsprak\.apps\.genki-test/ });

    expect(link.getAttribute('href')).toBe('https://klarsprak.apps.genki-test.digdir.cloud/');
    expectAccessible();
  });

  it('says the address is being set up and takes minutes while it binds', async () => {
    setup([view('klarsprak.apps.genki-test.digdir.cloud', { assigned: true, state: 'binding' })], {
      page: true,
    });

    expect(await screen.findByText('Settes opp')).toBeTruthy();
    expect(screen.getByText('Tar noen minutter.')).toBeTruthy();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('explains what gives a service without a design its address', async () => {
    setup([], { page: true, hasApp: false });

    expect(await screen.findByRole('link', { name: 'Gå til Utforming' })).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('asks nothing of the API before the service is published', async () => {
    const { calls } = setup([], { page: true, published: false, hasApp: true });

    expect(await screen.findByRole('link', { name: 'Gå til Utforming' })).toBeTruthy();
    expect(calls).toEqual([]);
  });

  it('gets an address on request and shows it being set up', async () => {
    const { calls } = setup([], { page: true });

    fireEvent.click(await screen.findByRole('button', { name: 'Få en adresse' }));

    expect(await screen.findByText('Settes opp')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')?.path).toBe(
      '/api/tenants/991825827/services/klarsprak/address',
    );
  });

  it('shows in plain words that only operators give an address in lockdown', async () => {
    setup([], {
      page: true,
      refusal: {
        path: 'principal',
        message: 'in lockdown only a platform operator marks a client hosted',
      },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Få en adresse' }));

    expect((await screen.findByRole('alert')).textContent).toBe(
      'Nå kan bare plattformens operatører gi en adresse.',
    );
  });

  it('shows a known refusal code in plain words', async () => {
    setup([], {
      page: true,
      refusal: { path: 'service', message: 'no_interface: the service has no assistant interface' },
    });

    fireEvent.click(await screen.findByRole('button', { name: 'Få en adresse' }));

    expect((await screen.findByRole('alert')).textContent).toMatch(
      /har en utforming under Utforming/,
    );
  });

  it('links to the organisation’s own domain over the assigned name once both are served', async () => {
    setup(
      [view('klarsprak.apps.genki-test.digdir.cloud', { assigned: true }), view('ka.example.no')],
      { page: true },
    );

    const link = await screen.findByRole('link', { name: /ka\.example\.no/ });

    expect(link.getAttribute('href')).toBe('https://ka.example.no/');
  });

  it('still offers an address while only an own domain waits for DNS', async () => {
    setup([view('ka.example.no', { state: 'pending-dns' })], { page: true });

    expect(await screen.findByText('Venter på DNS')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Få en adresse' })).toBeTruthy();
  });

  it.each([
    [
      'no_zone: the platform assigns no names',
      'Denne plattformen gir ikke tjenester egne adresser.',
    ],
    ['has_address: the service has an address already', 'Tjenesten har allerede en adresse.'],
    [
      'hostname_limit: at most 20 hostnames per organisation',
      'Virksomheten har nådd grensen for adresser.',
    ],
  ])('shows the refusal %s in plain words', async (message, text) => {
    setup([], { page: true, refusal: { path: 'service', message } });

    fireEvent.click(await screen.findByRole('button', { name: 'Få en adresse' }));

    expect((await screen.findByRole('alert')).textContent).toBe(text);
  });
});
