// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { mockFetch } from './mock';
import { Catalog } from './screens/Catalog';
import { Policies } from './screens/Policies';

document.getAnimations ??= () => [];
beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(cleanup);

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

const platform = (routes: Record<string, (call: Call) => [number, unknown]>) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`;
    const method = init?.method ?? 'GET';
    const call = {
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    const [status, body] = handler ? handler(call) : [404, { title: 'Not found' }];
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'ops' }) };
};

const org = '999888777';
const at = (hash: string) => window.history.replaceState(null, '', `/#${hash}`);

const tenants = () =>
  [
    200,
    {
      data: [
        { orgNumber: org, name: 'Testetaten', status: 'active', services: 6, quotaUsedPercent: 9 },
        {
          orgNumber: '910111222',
          name: 'Prøvekommunen',
          status: 'active',
          services: 3,
          quotaUsedPercent: 4,
        },
      ],
    },
  ] as [number, unknown];

const kinds = () =>
  [
    200,
    { data: [], tenantKinds: ['model-endpoint', 'model', 'knowledge-endpoint', 'dataset'] },
  ] as [number, unknown];

const shared = {
  id: 'search',
  kind: 'knowledge-endpoint',
  scope: 'platform',
  origin: 'seed',
  version: 2,
  spec: { engine: 'typesense', baseURL: 'https://search.example.no' },
};

const own = {
  id: `${org}/sok`,
  kind: 'knowledge-endpoint',
  scope: org,
  origin: 'api',
  version: 1,
  spec: { engine: 'http-search', baseURL: 'https://sok.testetaten.example.no' },
  by: 'employee:ansattporten:kari',
  at: '2026-10-05T12:00:00Z',
};

const tenantCatalog = {
  'GET /operator/tenants': tenants,
  [`GET /tenants/${org}/catalog`]: kinds,
  [`GET /tenants/${org}/catalog?kind=knowledge-endpoint`]: () =>
    [200, { data: [shared, own] }] as [number, unknown],
  [`GET /tenants/${org}/catalog/knowledge-endpoint/sok/versions`]: () =>
    [200, { data: [] }] as [number, unknown],
};

describe('an operator working on one tenant', () => {
  it("shows platform entries and the chosen tenant's own entries when an operator picks a tenant", async () => {
    const { api } = platform({
      ...tenantCatalog,
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, { data: [shared] }],
    });
    render(<Catalog api={api} tab="knowledge-endpoint" />);
    expect(await screen.findByRole('button', { name: /Åpne search/ })).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Én virksomhet' }));
    const select = await screen.findByRole('combobox', { name: 'Virksomhet' });
    await screen.findByRole('option', { name: 'Testetaten (999 888 777)' });
    fireEvent.change(select, { target: { value: org } });

    expect(
      await screen.findByText(
        'Du endrer oppføringer for Testetaten. Endringen logges hos virksomheten som endring fra Digdir.',
      ),
    ).toBeTruthy();
    expect(window.location.hash).toContain(`tenant=${org}`);
    const table = await screen.findByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Eier' })).toBeTruthy();
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((r) => within(r).getAllByRole('cell')[0]?.textContent)).toEqual([
      'Plattformen',
      'Testetaten',
    ]);
    expect(within(table).getByRole('rowheader', { name: /^sok/ })).toBeTruthy();
  });

  it('saves a tenant entry to the tenant path with If-Match and a reason', async () => {
    at(`/catalog?tab=knowledge-endpoint&tenant=${org}`);
    const { api, calls } = platform({
      ...tenantCatalog,
      [`PUT /tenants/${org}/catalog/knowledge-endpoint/sok`]: (c) => [
        200,
        { ...own, version: 2, spec: c.body },
      ],
    });
    render(<Catalog api={api} tab="knowledge-endpoint" />);

    fireEvent.click(await screen.findByRole('button', { name: `Åpne ${org}/sok` }));
    expect(screen.queryByRole('checkbox', { name: /Påkrevd/ })).toBeNull();
    fireEvent.change(screen.getByRole('textbox', { name: 'Innhold (JSON)' }), {
      target: {
        value: JSON.stringify({ ...own.spec, baseURL: 'https://sok2.testetaten.example.no' }),
      },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Ny adresse etter flytting' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre ny versjon' }));

    expect(
      await screen.findByText('sok er lagret. Endringen er logget hos Testetaten.'),
    ).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe(`/tenants/${org}/catalog/knowledge-endpoint/sok`);
    expect(put?.headers.get('if-match')).toBe('"1"');
    expect(decodeURIComponent(put?.headers.get('change-reason') ?? '')).toBe(
      'Ny adresse etter flytting',
    );
    expect(put?.body).toEqual({
      engine: 'http-search',
      baseURL: 'https://sok2.testetaten.example.no',
    });
  });

  it('shows platform entries read-only in the tenant view', async () => {
    at(`/catalog?tab=knowledge-endpoint&tenant=${org}`);
    const { api } = platform(tenantCatalog);
    render(<Catalog api={api} tab="knowledge-endpoint" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Vis search' }));
    const json = screen.getByRole('textbox', { name: 'Innhold (JSON)' });
    expect(json.hasAttribute('readonly')).toBe(true);
    expect(screen.queryByRole('button', { name: 'Lagre ny versjon' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Slett' })).toBeNull();
    expect(screen.queryByRole('textbox', { name: /Begrunnelse/ })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Endre i plattformvisning' }));
    await waitFor(() => expect(window.location.hash).toBe('#/catalog?tab=knowledge-endpoint'));
  });

  it('offers only kinds tenants can register in the tenant view', async () => {
    at(`/catalog?tab=price&tenant=${org}`);
    const { api, calls } = platform(tenantCatalog);
    render(<Catalog api={api} tab="price" />);

    expect(await screen.findByText(/Bare plattformen kan registrere priser/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ny' })).toBeNull();
    expect(calls.some((c) => c.path.includes('kind=price'))).toBe(false);
  });

  it('removes a tenant gate with a reason', async () => {
    at(`/policies?tab=gates&tenant=${org}`);
    const { api, calls } = platform({
      'GET /operator/tenants': tenants,
      [`GET /tenants/${org}/gates`]: () => [
        200,
        {
          data: [
            {
              id: 'kvalitet',
              scope: 'platform',
              version: 1,
              mandatory: true,
              editable: false,
              spec: { metric: 'judge.helpfulness', kind: 'threshold', threshold: 0.6 },
            },
            {
              id: 'hjelpsom',
              scope: org,
              version: 3,
              mandatory: false,
              editable: true,
              spec: { metric: 'judge.helpfulness', kind: 'threshold', threshold: 0.8 },
            },
          ],
        },
      ],
      [`GET /tenants/${org}/gates/hjelpsom/versions`]: () => [200, { data: [] }],
      [`DELETE /tenants/${org}/gates/hjelpsom`]: () => [200, { deleted: 'hjelpsom' }],
    });
    render(<Policies api={api} tab="gates" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Åpne hjelpsom' }));
    expect(screen.queryByRole('checkbox', { name: /Påkrevd/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Slett' }));
    expect(await screen.findByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);

    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Erstattet av plattformens krav' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Slett' }));

    expect(
      await screen.findByText('hjelpsom er slettet. Endringen er logget hos Testetaten.'),
    ).toBeTruthy();
    const removed = calls.find((c) => c.method === 'DELETE');
    expect(removed?.path).toBe(`/tenants/${org}/gates/hjelpsom`);
    expect(decodeURIComponent(removed?.headers.get('change-reason') ?? '')).toBe(
      'Erstattet av plattformens krav',
    );
  });

  it("serves the tenant's own entries next to the platform's in mock mode", async () => {
    at(`/catalog?tab=knowledge-endpoint&tenant=${org}`);
    const api = createApiClient({ baseUrl: '/api', fetch: mockFetch(), token: () => 'ops' });
    render(<Catalog api={api} tab="knowledge-endpoint" />);

    expect(await screen.findByRole('button', { name: `Åpne ${org}/sok` })).toBeTruthy();
    expect(await screen.findByText(/Du endrer oppføringer for Testetaten/)).toBeTruthy();
  });

  it('refuses a mandatory flag on a tenant gate in mock mode', async () => {
    const fetch = mockFetch();
    const put = await fetch(`/api/tenants/${org}/gates/streng`, {
      method: 'PUT',
      headers: { 'change-reason': 'Test av obligatorisk', 'content-type': 'application/json' },
      body: JSON.stringify({ metric: 'x', kind: 'threshold', threshold: 1, mandatory: true }),
    });
    expect(put.status).toBe(400);
    const listed = (await (await fetch(`/api/tenants/${org}/gates`)).json()) as {
      data: { id: string; editable: boolean }[];
    };
    expect(listed.data.map((g) => [g.id, g.editable])).toEqual([
      ['klarsprak-overall', false],
      ['hjelpsom', true],
    ]);
  });
});
