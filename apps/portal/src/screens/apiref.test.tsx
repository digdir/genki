// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { endpoints, missingAreas } from '../data/api-reference';
import { translator } from '../i18n';
import { exampleShared, mockFetch } from '../mock';
import { publicApiBase } from '../public-api';
import { expectAccessible, renderAt } from '../test-utils';

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const nav = () => screen.getByRole('navigation', { name: 'Endepunkter' });

describe('API-referanse', () => {
  it('links to the platform reference served by the api, in both languages', async () => {
    await renderAt('#/developer/api/reference');
    const link = await screen.findByRole('link', { name: /Hele plattformens API-referanse/ });
    expect(link.getAttribute('href')).toBe(`${publicApiBase}/reference`);
    expect(translator('en')('apiref.platformReference')).toBe(
      'The whole platform API reference (every endpoint)',
    );
  });

  it('lists the real endpoints by area and shows the selected one', async () => {
    await renderAt('#/developer/api/reference?endpoint=tj-pub');
    expect(await screen.findByRole('heading', { level: 3, name: 'API-referanse' })).toBeTruthy();
    expect(within(nav()).getByText('Eksport og import')).toBeTruthy();
    const detail = screen.getByRole('article');
    expect(
      within(detail).getByRole('heading', { level: 4, name: 'Publiser en utgave' }),
    ).toBeTruthy();
    expect(within(detail).getByText('/definitions')).toBeTruthy();
    expect(within(detail).getByText('POST')).toBeTruthy();
    expect(within(detail).getByText('Administrere tjenester')).toBeTruthy();
    expect(within(detail).getByRole('region', { name: 'Parametre' })).toBeTruthy();
    expect(within(detail).getByLabelText('curl').textContent).toContain('change-reason');
    expect(within(detail).getByText('400 Begrunnelse mangler')).toBeTruthy();
    expect(within(detail).getAllByRole('button', { name: /^Kopier / }).length).toBe(3);
    expect(within(detail).getByRole('button', { name: 'Kopier curl' })).toBeTruthy();
    expectAccessible();
  });

  it('keeps /v1 as the OpenAI-compatible endpoint and requires the caller for a timeline', async () => {
    await renderAt('#/developer/api/reference?endpoint=oa-chat');
    expect(await screen.findByText('/v1/chat/completions')).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('button', { name: /Hent tidslinjen/ }));
    await waitFor(() => expect(window.location.hash).toContain('endpoint=op-tl'));
    expect(
      await screen.findByText('Den som startet kjøringen, eller Administrere tjenester'),
    ).toBeTruthy();
    expect(screen.getByText('/tenants/{tenant}/tasks/{task}/timeline')).toBeTruthy();
  });

  it('lists the v4 areas with their real paths and rights', async () => {
    await renderAt('#/developer/api/reference');
    await screen.findByRole('navigation', { name: 'Endepunkter' });
    for (const area of [
      'Byggeassistenten',
      'Forslag',
      'Arbeidsinstrukser',
      'Katalog',
      'Prøveområdet',
      'Søkemotorer',
    ])
      expect(within(nav()).getByText(area)).toBeTruthy();

    fireEvent.click(within(nav()).getByRole('button', { name: /Spør byggeassistenten/ }));
    expect(await screen.findByText('/tenants/{tenant}/services/{id}/assistant/turns')).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('button', { name: /Legg til en del i katalogen/ }));
    expect(await screen.findByText('Legge til i katalogen')).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('button', { name: /Bytt til den nye søkemotoren/ }));
    expect(
      await screen.findByText('/tenants/{tenant}/datasets/{id}/engine-switches/{sid}/activate'),
    ).toBeTruthy();
    expect(screen.getByText('Administrere dokumentsamlinger')).toBeTruthy();
  });

  it('searches the endpoints', async () => {
    await renderAt('#/developer/api/reference');
    fireEvent.change(await screen.findByLabelText('Søk i endepunkter'), {
      target: { value: 'api-keys' },
    });
    expect(within(nav()).getAllByRole('button', { name: /API-nøkkel/ })).toHaveLength(2);
    expect(within(nav()).queryByText('Dokumentsamlinger')).toBeNull();
    fireEvent.change(screen.getByLabelText('Søk i endepunkter'), {
      target: { value: 'finnesikke' },
    });
    expect(screen.getByText('Ingen endepunkter passer søket.')).toBeTruthy();
  });

  it('says so when an endpoint does not exist in the API', async () => {
    await renderAt('#/developer/api/reference?endpoint=ds-inn');
    expect(await screen.findByText(/Endepunktet «ds-inn» finnes ikke i API-et ennå/)).toBeTruthy();
  });

  it('says who calls with which rights, and that the call goes to the API', async () => {
    const auth = mockAnsattporten({
      name: 'Erik Larsen',
      organisations: [{ orgNumber: '999888777', name: 'Testetaten', actions: ['Bruke tjenester'] }],
    });
    await auth.login();
    window.location.hash = '#/developer/api/reference?endpoint=models';
    render(<App auth={auth} fetch={mockFetch()} />);

    const intro = (await screen.findByText(/Du kaller som/)).closest('p') as HTMLElement;
    expect(intro.textContent).toBe(
      'Du kaller som Erik Larsen for Testetaten, med rettighetene dine fra Altinn: Bruke tjenester. Kallet sendes til API-et med din innlogging.',
    );
  });

  it('tries a read call against the API as the signed-in person and shows the real answer', async () => {
    const calls: string[] = [];
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(`${init?.method ?? 'GET'} ${new URL(url, 'http://test').pathname}`);
      return base(input, init);
    };
    await renderAt('#/developer/api/reference?endpoint=tj-list', fetch);
    fireEvent.change(await screen.findByLabelText('tenant'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Fyll ut «tenant».')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('tenant'), { target: { value: '999888777' } });
    calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('200 OK')).toBeTruthy();
    expect(calls.some((c) => c.endsWith('/tenants/999888777/definitions'))).toBe(true);
  });

  it('keeps a typed path value inside its own path segment', async () => {
    const calls: string[] = [];
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(new URL(url, 'http://test').pathname);
      return base(input, init);
    };
    await renderAt('#/developer/api/reference?endpoint=tj-list', fetch);
    fireEvent.change(await screen.findByLabelText('tenant'), { target: { value: '../admin' } });
    calls.length = 0;
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls.some((c) => c.endsWith('/tenants/..%2Fadmin/definitions'))).toBe(true);
  });

  it('shows the refusal the API gives when the person lacks the right', async () => {
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (new URL(url, 'http://test').pathname.endsWith('/tenants/999888777/settings'))
        return Promise.resolve(
          new Response(JSON.stringify({ title: 'Forbidden', status: 403 }), { status: 403 }),
        );
      return base(input, init);
    };
    await renderAt('#/developer/api/reference?endpoint=inn-get', fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Send' }));
    expect(await screen.findByText('403 Forbidden')).toBeTruthy();
    expect(screen.getByText(/mangler rettigheten det krever/)).toBeTruthy();
  });

  it('offers no try for calls that change something', async () => {
    await renderAt('#/developer/api/reference?endpoint=inn-put');
    expect(await screen.findByText(/bare prøve lesekall \(GET\)/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Send' })).toBeNull();
  });

  it('sends the old address #/api-reference on to the reference under Integrasjoner', async () => {
    await renderAt('#/api-reference?endpoint=oa-chat');
    await waitFor(() =>
      expect(window.location.hash).toBe('#/developer/api/reference?endpoint=oa-chat'),
    );
    expect(await screen.findByText('/v1/chat/completions')).toBeTruthy();
  });
});

describe('API-referanse: innhold', () => {
  const byId = (id: string) => endpoints.find((e) => e.id === id);

  it('documents ingestion, improvement proposals and clients instead of listing them as missing', () => {
    expect(byId('ds-pipeline-run')).toMatchObject({
      method: 'POST',
      path: '/tenants/{tenant}/datasets/{dataset}/pipelines/{id}/execute',
      right: 'ds',
      status: 202,
    });
    expect(byId('ds-pipeline-runs')?.path).toBe(
      '/tenants/{tenant}/datasets/{dataset}/pipelines/{id}/executions',
    );
    expect(byId('kv-improve-decide')).toMatchObject({
      method: 'POST',
      path: '/tenants/{tenant}/services/{id}/improvements/{pid}/decision',
      body: { approve: true },
    });
    expect(byId('int-client-save')).toMatchObject({
      method: 'PUT',
      path: '/tenants/{tenant}/clients/{id}',
    });
    expect(missingAreas.map((key) => translator('nb')(key)).join(' ')).not.toMatch(
      /Innlesing|forbedringsforslag|brukerflater|GenAI/,
    );
  });

  it('shows the responses the API really gives', () => {
    expect(byId('kv-feedback-new')).toMatchObject({ status: 201, response: { ok: true } });
    expect(byId('kv-feedback-chat')).toMatchObject({ status: 201, response: { ok: true } });
    expect(byId('ds-list')?.response).toMatchObject({
      datasets: [{ id: 'kudos', status: 'configured' }],
    });
    expect(byId('op-conv-list')?.response).toMatchObject({ total: 1, pageIndex: 0 });
    expect(byId('op-conv-new')?.response).toHaveProperty('conversation');
    expect(byId('op-conv-delete')?.response).toEqual({ success: true });
    expect(byId('as-turn')?.errors ?? []).not.toContainEqual(
      expect.arrayContaining([expect.stringMatching(/^409/)]),
    );
    expect(translator('nb')(byId('as-turn')?.desc ?? 'apirefData.tj-list.desc')).toContain(
      'status: refused',
    );
  });
});

describe('Tjenesten som API', () => {
  it('shows variants with public names and aliases, and the version selector', async () => {
    await renderAt('#/developer/api/reference?view=service');
    expect(
      await screen.findByRole('heading', { level: 3, name: 'Tjenesten som API' }),
    ).toBeTruthy();
    const variants = screen.getByRole('region', { name: 'Varianter' });
    expect(within(variants).getByText('ka__retrieve-only')).toBeTruthy();
    expect(within(variants).getByText('ka')).toBeTruthy();
    expect(within(variants).getByText('ka-retrieve-only')).toBeTruthy();
    const example = screen.getByLabelText('Eksempel på å velge utgave');
    expect(example.textContent).toContain('uten utgave brukes siste publiserte');
    fireEvent.change(screen.getByLabelText('Utgave'), { target: { value: '6' } });
    expect(example.textContent).toContain('GenAI-Version: 6');
    expect(example.textContent).toContain('metadata.version = "6"');
    expect(screen.queryByText('ka__v7')).toBeNull();
    expect(screen.getByText(/med utgaven som kjørte/).textContent).toContain('GenAI-Version');
    await screen.findByRole('option', { name: /Klarspråk/ });
    expectAccessible();
  });

  it('documents metadata.version next to GenAI-Version for chat completions', async () => {
    await renderAt('#/developer/api/reference?endpoint=oa-chat');
    const params = await screen.findByRole('region', { name: 'Parametre' });
    expect(within(params).getByText('GenAI-Version')).toBeTruthy();
    expect(within(params).getByText('metadata.version')).toBeTruthy();
    expect(within(params).getByText('innhold')).toBeTruthy();
    expect(screen.getByText('400 invalid_version')).toBeTruthy();
    expect(screen.getByText('409 version_not_found')).toBeTruthy();
  });

  it('takes variants from shared services in the API', async () => {
    const shared = [
      {
        ...(exampleShared[0] as (typeof exampleShared)[number]),
        variants: [
          { id: 'default', publicName: 'klarsprak__default', aliases: [] },
          { id: 'kort', publicName: 'klarsprak__kort', aliases: ['klarsprak-kort'] },
        ],
      },
    ];
    await renderAt(
      '#/developer/api/reference?view=service',
      mockFetch(undefined, undefined, undefined, undefined, { shared }),
    );
    await screen.findByRole('option', { name: /Klarspråk/ });
    act(() => {
      fireEvent.change(screen.getByLabelText('Tjeneste'), {
        target: { value: 'shared:991825827:klarsprak' },
      });
    });
    const variants = screen.getByRole('region', { name: 'Varianter' });
    expect(within(variants).getByText('klarsprak__kort')).toBeTruthy();
    expect(within(variants).getByText('klarsprak-kort')).toBeTruthy();
    expect(screen.getAllByText('Skjemaet er ikke tilgjengelig i API-et ennå.')).toHaveLength(2);
  });
});

describe('Vis API-kall', () => {
  it('shows the call behind a portal action without pretending to do it', async () => {
    await renderAt('#/developer/api/reference?view=actions');
    expect(await screen.findByRole('heading', { level: 3, name: 'Vis API-kall' })).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getAllByRole('button', { name: 'Vis API-kall' })[1] as HTMLElement);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('/tenants/999888777/settings/search.top_k')).toBeTruthy();
    expect(within(panel).getByText('Administrere tjenester')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lagre' })).toBeNull();
  });
});
