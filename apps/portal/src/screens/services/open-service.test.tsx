// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch } from '../../mock';
import { kari } from '../../test-utils';
import type { ClientSpec, ClientView, HostnameView } from '../../types';
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

const withClients = (clients: ClientView[], claimed: HostnameView[] = []) => {
  const base = mockFetch();
  const answered = { clients: false };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    if ((init?.method ?? 'GET') === 'GET' && /\/services\/[^/]+\/hostnames$/.test(url))
      return new Response(JSON.stringify({ client: null, hostnames: claimed, assigns: true }), {
        headers: { 'content-type': 'application/json' },
      });
    if ((init?.method ?? 'GET') === 'GET' && /\/clients\?service=/.test(url)) {
      answered.clients = true;
      return new Response(JSON.stringify({ clients, endpoints: {}, oidc: {} }), {
        headers: { 'content-type': 'application/json' },
      });
    }
    return base(input, init);
  };
  return { fetch, answered };
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

  it('counts a hostname without an environment as production', () => {
    expect(
      serviceAddress(
        [
          client('web', {
            hosted: true,
            hostnames: [
              { hostname: 'test.rapport.apps.genki-test.digdir.cloud', environment: 'test' },
              { hostname: 'rapport.apps.genki-test.digdir.cloud' },
            ],
          }),
        ],
        'rapportassistenten',
      ),
    ).toBe('https://rapport.apps.genki-test.digdir.cloud/');
  });

  it('is missing when the service has no hosted browser client', () => {
    expect(
      serviceAddress(
        [
          client('api', {
            kind: 'server',
            hosted: true,
            hostnames: [{ hostname: 'api.rapport.apps.genki-test.digdir.cloud' }],
          }),
          client('web', {}),
        ],
        'rapportassistenten',
      ),
    ).toBeUndefined();
  });
});

describe('Åpne tjenesten in the service header', () => {
  it('opens the hosted address of a published service in a new tab', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    const { fetch } = withClients([
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

  it('opens an active claimed domain, which no client lists', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    const { fetch } = withClients(
      [client('rapportassistenten-host', { hosted: true, hostnames: [] })],
      [
        {
          id: 'krav-1',
          hostname: 'rapport.example.no',
          client: 'rapportassistenten-host',
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
        },
      ],
    );
    render(<App auth={auth} fetch={fetch} live />);
    await waitFor(() => expect(header()?.textContent).toMatch(/Publiser/), { timeout: 15000 });
    const link = await screen.findByRole(
      'link',
      { name: /^Åpne tjenesten ?\(åpnes i ny fane\)$/ },
      { timeout: 5000 },
    );
    expect(link.getAttribute('href')).toBe('https://rapport.example.no/');
  }, 30000);

  it('is also shown on the I bruk edition of a published service', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten?edition=in-use';
    const { fetch } = withClients([
      client('web', {
        hosted: true,
        hostnames: [{ hostname: 'rapport.apps.genki-test.digdir.cloud' }],
      }),
    ]);
    render(<App auth={auth} fetch={fetch} live />);
    await waitFor(
      () => expect(header()?.querySelector('[aria-current="page"]')?.textContent).toBe('I bruk'),
      { timeout: 15000 },
    );
    const link = await screen.findByRole(
      'link',
      { name: /^Åpne tjenesten ?\(åpnes i ny fane\)$/ },
      { timeout: 5000 },
    );
    expect(link.getAttribute('href')).toBe('https://rapport.apps.genki-test.digdir.cloud/');
  }, 30000);

  it('is not shown for a published service without a hosted address', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    const { fetch, answered } = withClients([client('api', { kind: 'server' })]);
    render(<App auth={auth} fetch={fetch} live />);
    await waitFor(() => expect(header()?.textContent).toMatch(/Publiser/), { timeout: 8000 });
    await waitFor(() => expect(answered.clients).toBe(true), { timeout: 8000 });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole('link', { name: /Åpne tjenesten/ })).toBeNull();
  }, 20000);

  it('is not shown for an archived service', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    const { fetch: clientsFetch, answered } = withClients([
      client('web', {
        hosted: true,
        hostnames: [{ hostname: 'rapport.apps.genki-test.digdir.cloud' }],
      }),
    ]);
    const fetch: typeof globalThis.fetch = async (input, init) =>
      /\/services\/rapportassistenten\/lifecycle$/.test(String(input))
        ? Response.json({ state: 'archived', reason: 'Erstattet', at: '2026-11-20T10:00:00Z' })
        : clientsFetch(input, init);
    render(<App auth={auth} fetch={fetch} live />);
    await waitFor(() => expect(header()?.textContent).toMatch(/Arkivert/), { timeout: 15000 });
    await waitFor(() => expect(answered.clients).toBe(true), { timeout: 8000 });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByRole('link', { name: /Åpne tjenesten/ })).toBeNull();
  }, 30000);

  it('is not shown for a new service that has never been published', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/new';
    const { fetch, answered } = withClients([
      client('web', {
        hosted: true,
        hostnames: [{ hostname: 'rapport.apps.genki-test.digdir.cloud' }],
      }),
    ]);
    render(<App auth={auth} fetch={fetch} live />);
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' }, { timeout: 8000 });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(answered.clients).toBe(false);
    expect(screen.queryByRole('link', { name: /Åpne tjenesten/ })).toBeNull();
  }, 20000);
});

const hosted = () =>
  withClients([
    client('web', {
      hosted: true,
      hostnames: [{ hostname: 'rapport.apps.genki-test.digdir.cloud' }],
    }),
  ]);

const openInterface = async (fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = '#/services/rapportassistenten/interface';
  render(<App auth={auth} fetch={fetch} live />);
  await waitFor(() => expect(header()?.textContent).toMatch(/Publiser/), { timeout: 15000 });
};

describe('the address in the Prøv pane', () => {
  it("shows the header's address in the Prøv pane's address bar", async () => {
    await openInterface(hosted().fetch);
    await screen.findByRole('link', { name: /Åpne tjenesten/ }, { timeout: 5000 });
    expect(
      await screen.findByText('rapport.apps.genki-test.digdir.cloud', {}, { timeout: 5000 }),
    ).toBeTruthy();
  }, 30000);

  it('shows Forhåndsvisning in the Prøv pane when the service has no address', async () => {
    const { fetch, answered } = withClients([client('api', { kind: 'server' })]);
    await openInterface(fetch);
    await waitFor(() => expect(answered.clients).toBe(true), { timeout: 8000 });
    expect(await screen.findByText('Forhåndsvisning', {}, { timeout: 5000 })).toBeTruthy();
  }, 30000);

  it('never shows an address made from the service id in the Prøv pane', async () => {
    const { fetch, answered } = withClients([client('api', { kind: 'server' })]);
    await openInterface(fetch);
    await waitFor(() => expect(answered.clients).toBe(true), { timeout: 8000 });
    await screen.findByText('Forhåndsvisning', {}, { timeout: 5000 });
    expect(screen.queryByText(/\.genki\.no$/)).toBeNull();
  }, 30000);
});

describe('the no-address note in the service header', () => {
  const openWithout = async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    const { fetch, answered } = withClients([client('api', { kind: 'server' })]);
    render(<App auth={auth} fetch={fetch} live />);
    await waitFor(() => expect(header()?.textContent).toMatch(/Publiser/), { timeout: 15000 });
    await waitFor(() => expect(answered.clients).toBe(true), { timeout: 8000 });
  };

  it('says Ingen adresse ennå in the header of a published service without an address', async () => {
    await openWithout();
    const note = await screen.findByRole('link', { name: /Ingen adresse ennå/ }, { timeout: 5000 });
    expect(header()?.contains(note)).toBe(true);
  }, 30000);

  it('links the no-address note to Egen nettside in Oppsett', async () => {
    await openWithout();
    const note = await screen.findByRole('link', { name: /Ingen adresse ennå/ }, { timeout: 5000 });
    expect(note.getAttribute('href')).toBe('#/services/rapportassistenten/setup/channels');
  }, 30000);

  it('shows no address note on a service that is not published', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/new';
    const { fetch } = withClients([client('api', { kind: 'server' })]);
    render(<App auth={auth} fetch={fetch} live />);
    await screen.findByRole('heading', { level: 1, name: 'Ny tjeneste' }, { timeout: 8000 });
    await act(() => new Promise((r) => setTimeout(r, 50)));
    expect(screen.queryByText(/Ingen adresse ennå/)).toBeNull();
  }, 20000);

  it('shows Åpne tjenesten and no note when the service has an active address', async () => {
    const auth = mockAnsattporten(kari);
    await auth.login();
    window.location.hash = '#/services/rapportassistenten';
    render(<App auth={auth} fetch={hosted().fetch} live />);
    await waitFor(() => expect(header()?.textContent).toMatch(/Publiser/), { timeout: 15000 });
    await screen.findByRole('link', { name: /Åpne tjenesten/ }, { timeout: 5000 });
    expect(screen.queryByText(/Ingen adresse ennå/)).toBeNull();
  }, 30000);
});
