// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch } from '../../mock';
import { kari } from '../../test-utils';
import type { ClientSpec, ClientView } from '../../types';
import { serviceAddress } from '../service/service-address';

afterEach(cleanup);

const client = (id: string, spec: Partial<ClientSpec>): ClientView => ({
  definition: {
    apiVersion: 'genai.digdir.no/v1',
    kind: 'Client',
    metadata: { tenant: '991825827', id },
    spec: {
      service: 'rapportassistenten',
      kind: 'browser',
      channels: [],
      allowedOrigins: [],
      ...spec,
    },
  },
  version: 1,
  updatedAt: '2026-11-25T10:00:00Z',
  updatedBy: 'kari',
  deliveries: [],
});

const withClients = (clients: ClientView[]): typeof globalThis.fetch => {
  const base = mockFetch();
  return async (input, init) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'GET' && /\/clients\?service=/.test(url))
      return new Response(JSON.stringify({ clients, endpoints: {}, oidc: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    return base(input, init);
  };
};

const header = () =>
  screen.getByRole('heading', { level: 1, name: 'Rapportassistenten' }).closest('header');

describe('the service address', () => {
  it('is the production hostname of a hosted client for the service', () => {
    expect(
      serviceAddress(
        [
          client('api', { kind: 'server' }),
          client('other', {
            service: 'annen',
            hosted: true,
            hostnames: [{ hostname: 'annen.apps.genki-test.digdir.cloud' }],
          }),
          client('web', {
            hosted: true,
            hostnames: [
              { hostname: 'test.rapport.apps.genki-test.digdir.cloud', environment: 'test' },
              { hostname: 'rapport.apps.genki-test.digdir.cloud', environment: 'prod' },
            ],
          }),
        ],
        'rapportassistenten',
      ),
    ).toBe('https://rapport.apps.genki-test.digdir.cloud/');
  });

  it('is missing when the service has no hosted client', () => {
    expect(
      serviceAddress([client('api', { kind: 'server' }), client('web', {})], 'rapportassistenten'),
    ).toBeUndefined();
  });
});

describe('Åpne tjenesten in the service header', () => {
  it('opens the hosted address of a published service in a new tab', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    const fetch = withClients([
      client('web', {
        hosted: true,
        hostnames: [{ hostname: 'rapport.apps.genki-test.digdir.cloud' }],
      }),
    ]);
    render(<App auth={auth} fetch={fetch} live />);
    await waitFor(() => expect(header()?.textContent).toMatch(/Publiser/), { timeout: 15000 });
    const link = await screen.findByRole(
      'link',
      { name: /^Åpne tjenesten ?\(åpnes i ny fane\)$/ },
      { timeout: 5000 },
    );
    expect(link.getAttribute('href')).toBe('https://rapport.apps.genki-test.digdir.cloud/');
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  }, 30000);

  it('is not shown for a published service without a hosted address', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    render(<App auth={auth} fetch={withClients([client('api', { kind: 'server' })])} live />);
    await waitFor(() => expect(header()?.textContent).toMatch(/Publiser/), { timeout: 8000 });
    expect(screen.queryByRole('link', { name: /Åpne tjenesten/ })).toBeNull();
  }, 20000);

  it('is not shown for a new service that has never been published', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/new';
    const fetch = withClients([
      client('web', {
        hosted: true,
        hostnames: [{ hostname: 'rapport.apps.genki-test.digdir.cloud' }],
      }),
    ]);
    render(<App auth={auth} fetch={fetch} live />);
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' }, { timeout: 8000 });
    expect(screen.queryByRole('link', { name: /Åpne tjenesten/ })).toBeNull();
  }, 20000);
});
