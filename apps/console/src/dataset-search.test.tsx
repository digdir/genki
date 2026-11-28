// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { Catalog } from './screens/Catalog';

document.getAnimations ??= () => [];
beforeEach(() => window.history.replaceState(null, '', '/'));
afterEach(cleanup);

interface Call {
  method: string;
  path: string;
  body: unknown;
}

type Routes = Record<string, (call: Call) => [number, unknown]>;

const platform = (routes: Routes) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`;
    const method = init?.method ?? 'GET';
    const call = { method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined };
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

const kudos = {
  id: 'digdir/kudos',
  kind: 'dataset',
  scope: 'platform',
  origin: 'api',
  version: 3,
  spec: {
    name: 'Kudos',
    endpoint: 'knowledge-pg',
    residency: 'norway',
    filters: { owner_orgnr: 'select', type: 'multiselect' },
  },
};

const encoded = encodeURIComponent(kudos.id);

const answer = (hits: unknown[], extra: Record<string, unknown> = {}) => ({
  dataset: kudos.id,
  profile: 'content',
  filters: { owner_orgnr: '991825827' },
  limit: 10,
  tookMs: 412,
  hits,
  ...extra,
});

const hit = {
  id: 'kudos-1#4',
  document: 'kudos-1',
  title: 'Årsrapport 2025 for Digdir',
  position: 4,
  page: 12,
  pageEnd: 13,
  score: 0.912,
  text: 'Digdir fikk tilskudd til felles løsninger.',
  fields: { owner_orgnr: '991825827', type: 'Årsrapport' },
};

const platformRoutes = (search: (call: Call) => [number, unknown]): Routes => ({
  'GET /operator/tenants': () => [200, { data: [] }],
  'GET /operator/catalog/entries?kind=dataset': () => [200, { data: [kudos] }],
  [`GET /operator/catalog/dataset/${encoded}/versions`]: () => [200, { data: [] }],
  [`GET /operator/datasets/${encoded}/pipelines`]: () => [200, { data: [] }],
  [`POST /operator/datasets/${encoded}/search`]: search,
});

const openKudos = async (verb: 'Åpne' | 'Vis' = 'Åpne') => {
  fireEvent.click(await screen.findByRole('button', { name: `${verb} digdir/kudos` }));
  return screen.findByRole('region', { name: 'Søk i dokumentsamlingen' });
};

const searchFor = (panel: HTMLElement, query: string, orgnr?: string) => {
  fireEvent.change(within(panel).getByRole('textbox', { name: 'Søketekst' }), {
    target: { value: query },
  });
  if (orgnr !== undefined)
    fireEvent.change(within(panel).getByRole('textbox', { name: 'owner_orgnr' }), {
      target: { value: orgnr },
    });
  fireEvent.click(within(panel).getByRole('button', { name: 'Søk' }));
};

describe('searching a dataset in the console', () => {
  it('shows the hits of a search with a filter chosen in the console', async () => {
    at('/catalog?tab=dataset');
    const { api, calls } = platform(platformRoutes(() => [200, answer([hit], { found: 1 })]));
    render(<Catalog api={api} tab="dataset" />);

    const panel = await openKudos();
    searchFor(panel, 'tilskudd', '991825827');

    const results = await within(panel).findByRole('list', { name: 'Treff' });
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      query: 'tilskudd',
      filters: { owner_orgnr: '991825827' },
      limit: 10,
    });
    const first = within(results).getByRole('listitem');
    expect(within(first).getByText('Årsrapport 2025 for Digdir')).toBeTruthy();
    expect(within(first).getByText(/Poeng 0,912/)).toBeTruthy();
    expect(within(first).getByText(/Side 12–13/)).toBeTruthy();
    expect(within(first).getByText('Digdir fikk tilskudd til felles løsninger.')).toBeTruthy();
    expect(within(panel).getByText(/owner_orgnr = 991825827/)).toBeTruthy();
    expect(within(panel).getByText(/412 ms/)).toBeTruthy();
  });

  it('says there are no hits when a filter matches nothing', async () => {
    at('/catalog?tab=dataset');
    const { api } = platform(
      platformRoutes(() => [200, answer([], { filters: { owner_orgnr: '000000000' } })]),
    );
    render(<Catalog api={api} tab="dataset" />);

    const panel = await openKudos();
    searchFor(panel, 'tilskudd', '000000000');

    expect(await within(panel).findByText('Ingen treff for dette søket.')).toBeTruthy();
    expect(within(panel).queryByRole('list', { name: 'Treff' })).toBeNull();
  });

  it('says the search took too long on a 504', async () => {
    at('/catalog?tab=dataset');
    const { api } = platform(
      platformRoutes(() => [
        504,
        {
          type: 'about:blank',
          title: 'The search took too long',
          status: 504,
          errors: [{ path: 'knowledge', message: 'search timed out after 15000 ms' }],
        },
      ]),
    );
    render(<Catalog api={api} tab="dataset" />);

    const panel = await openKudos();
    searchFor(panel, 'tilskudd');

    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('Søket tok lengre tid enn grensen');
    expect(within(alert).getByText('Melding fra søkemotoren, på engelsk:')).toBeTruthy();
    expect(within(alert).getByRole('listitem').textContent).toBe('search timed out after 15000 ms');
  });

  it("shows a kernel refusal's reason, not as an engine message", async () => {
    at('/catalog?tab=dataset');
    const { api } = platform(
      platformRoutes(() => [
        403,
        {
          type: 'about:blank',
          title: 'Søket ble ikke sluppet gjennom',
          status: 403,
          errors: [{ path: 'kernel', message: 'the authorization service is unavailable' }],
        },
      ]),
    );
    render(<Catalog api={api} tab="dataset" />);

    const panel = await openKudos();
    searchFor(panel, 'tilskudd');

    const alert = await within(panel).findByRole('alert');
    expect(alert.textContent).toContain('Søket ble stoppet før det nådde søkemotoren.');
    expect(within(alert).getByRole('listitem').textContent).toBe(
      'the authorization service is unavailable',
    );
    expect(alert.textContent).not.toContain('Melding fra søkemotoren');
  });

  it('keeps the chosen filter when the dataset tab is opened again', async () => {
    at('/catalog?tab=dataset');
    const { api, calls } = platform(platformRoutes(() => [200, answer([hit])]));
    const { rerender } = render(<Catalog api={api} tab="dataset" />);

    const panel = await openKudos();
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Søketekst' }), {
      target: { value: 'tilskudd' },
    });
    fireEvent.change(within(panel).getByRole('textbox', { name: 'owner_orgnr' }), {
      target: { value: '991825827' },
    });

    rerender(<Catalog api={api} tab="model" />);
    rerender(<Catalog api={api} tab="dataset" />);

    const again = await openKudos();
    expect(calls.filter((c) => c.path === '/operator/catalog/entries?kind=dataset')).toHaveLength(
      1,
    );
    expect(
      (within(again).getByRole('textbox', { name: 'Søketekst' }) as HTMLInputElement).value,
    ).toBe('tilskudd');
    expect(
      (within(again).getByRole('textbox', { name: 'owner_orgnr' }) as HTMLInputElement).value,
    ).toBe('991825827');
  });

  it('shows the search panel on a read-only platform dataset in the tenant view', async () => {
    at(`/catalog?tab=dataset&tenant=${org}`);
    const { api, calls } = platform({
      'GET /operator/tenants': () => [
        200,
        { data: [{ orgNumber: org, name: 'Testetaten', status: 'active', services: 1 }] },
      ],
      [`GET /tenants/${org}/catalog`]: () => [200, { data: [], tenantKinds: ['dataset'] }],
      [`GET /tenants/${org}/catalog?kind=dataset`]: () => [
        200,
        { data: [{ ...kudos, editable: false }] },
      ],
      [`POST /tenants/${org}/datasets/${encoded}/search`]: () => [200, answer([hit])],
    });
    render(<Catalog api={api} tab="dataset" />);

    const panel = await openKudos('Vis');
    searchFor(panel, 'tilskudd', '991825827');

    expect(await within(panel).findByRole('list', { name: 'Treff' })).toBeTruthy();
    expect(calls.filter((c) => c.method === 'POST').map((c) => c.path)).toEqual([
      `/tenants/${org}/datasets/${encoded}/search`,
    ]);
    expect(screen.queryByRole('region', { name: 'Innlesing' })).toBeNull();
    expect(calls.some((c) => c.path.includes('/pipelines'))).toBe(false);
  });
});
