// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { LocaleProvider } from '@genai/i18n/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { RightsProvider } from '../../Shell';
import { expectAccessible } from '../../test-utils';
import type { HostnameView, PortalRight } from '../../types';
import { ServiceAddress } from './ServiceAddress';

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
    if (method === 'GET') return json({ client, hostnames, assigns: true });
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
          <ServiceAddress
            api={api}
            tenant="991825827"
            service="klarsprak"
            canManage={rights.includes('manage-services')}
          />
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

    expect(await screen.findByText('Kobles til')).toBeTruthy();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Gi tjenesten en adresse' }));

    expect(await screen.findByText('Kobles til')).toBeTruthy();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      path: '/api/tenants/991825827/services/klarsprak/address',
      reason: 'Gir tjenesten en adresse',
    });
    expect(screen.queryByRole('button', { name: 'Gi tjenesten en adresse' })).toBeNull();
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

  it('speaks English', async () => {
    setup([view('ka.example.no', { state: 'pending-dns' })], { locale: 'en' });

    expect(await screen.findByText('Waiting for DNS')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Address' })).toBeTruthy();
  });
});
