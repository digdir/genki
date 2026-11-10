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
    await renderAt('#/api-reference');
    const link = await screen.findByRole('link', { name: /Hele plattformens API-referanse/ });
    expect(link.getAttribute('href')).toBe(`${publicApiBase}/reference`);
    expect(translator('en')('apiref.platformReference')).toBe(
      'The whole platform API reference (every endpoint)',
    );
  });

  it('lists the real endpoints by area and shows the selected one', async () => {
    await renderAt('#/api-reference?endpoint=tj-pub');
    expect(await screen.findByRole('heading', { level: 1, name: 'API-referanse' })).toBeTruthy();
    expect(within(nav()).getByText('Eksport og import')).toBeTruthy();
    const detail = screen.getByRole('article');
    expect(
      within(detail).getByRole('heading', { level: 2, name: 'Publiser en versjon' }),
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
    await renderAt('#/api-reference?endpoint=oa-chat');
    expect(await screen.findByText('/v1/chat/completions')).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('button', { name: /Hent tidslinjen/ }));
    await waitFor(() => expect(window.location.hash).toContain('endpoint=op-tl'));
    expect(
      await screen.findByText('Den som startet kjøringen, eller Administrere tjenester'),
    ).toBeTruthy();
    expect(screen.getByText('/tenants/{tenant}/tasks/{task}/timeline')).toBeTruthy();
  });

  it('lists the v4 areas with their real paths and rights', async () => {
    await renderAt('#/api-reference');
    await screen.findByRole('navigation', { name: 'Endepunkter' });
    for (const area of [
      'Byggeassistenten',
      'Forslag',
      'Ferdigheter',
      'Byggeklosser',
      'Prøveområdet',
      'Søkemotorer',
    ])
      expect(within(nav()).getByText(area)).toBeTruthy();

    fireEvent.click(within(nav()).getByRole('button', { name: /Spør byggeassistenten/ }));
    expect(await screen.findByText('/tenants/{tenant}/services/{id}/assistant/turns')).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('button', { name: /Registrer en byggekloss/ }));
    expect(await screen.findByText('Registrere byggeklosser')).toBeTruthy();
    fireEvent.click(within(nav()).getByRole('button', { name: /Ta i bruk den nye søkemotoren/ }));
    expect(
      await screen.findByText('/tenants/{tenant}/datasets/{id}/engine-switches/{sid}/activate'),
    ).toBeTruthy();
    expect(screen.getByText('Administrere datasett')).toBeTruthy();
  });

  it('searches the endpoints', async () => {
    await renderAt('#/api-reference');
    fireEvent.change(await screen.findByLabelText('Søk i endepunkter'), {
      target: { value: 'api-keys' },
    });
    expect(within(nav()).getAllByRole('button', { name: /API-nøkkel/ })).toHaveLength(2);
    expect(within(nav()).queryByText('Datasett')).toBeNull();
    fireEvent.change(screen.getByLabelText('Søk i endepunkter'), {
      target: { value: 'finnesikke' },
    });
    expect(screen.getByText('Ingen endepunkter passer søket.')).toBeTruthy();
  });

  it('says so when an endpoint does not exist in the API', async () => {
    await renderAt('#/api-reference?endpoint=ds-inn');
    expect(await screen.findByText(/Endepunktet «ds-inn» finnes ikke i API-et ennå/)).toBeTruthy();
  });

  it('says who calls with which rights, and that the answer is only an example', async () => {
    const auth = mockAnsattporten({
      name: 'Erik Larsen',
      organisations: [{ orgNumber: '999888777', name: 'Testetaten', actions: ['Bruke tjenester'] }],
    });
    await auth.login();
    window.location.hash = '#/api-reference?endpoint=tj-pub';
    render(<App auth={auth} fetch={mockFetch()} />);

    const intro = (await screen.findByText(/Du kaller som/)).closest('p') as HTMLElement;
    expect(intro.textContent).toBe(
      'Du kaller som Erik Larsen for Testetaten, med rettighetene dine fra Altinn: Bruke tjenester. Svaret er et eksempel. Ingen kall sendes.',
    );
  });

  it('tries a call: checks JSON and parameters, and answers 403 for Digdir-only endpoints', async () => {
    await renderAt('#/api-reference?endpoint=inn-put');
    const body = screen.getByLabelText('Innhold (JSON)');
    fireEvent.change(body, { target: { value: '{ ikke json' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('Innholdet er ikke gyldig JSON.')).toBeTruthy();
    fireEvent.change(body, { target: { value: '{"value": 15}' } });
    fireEvent.change(screen.getByLabelText('key'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByText('400 Ugyldig forespørsel')).toBeTruthy();
    expect(screen.getByText('Fyll ut «key».')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('key'), { target: { value: 'search.top_k' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(await screen.findByText('200 OK', {}, { timeout: 2000 })).toBeTruthy();

    cleanup();
    await renderAt('#/api-reference?endpoint=inn-plattform');
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    expect(screen.getByRole('button', { name: 'Send' }).getAttribute('aria-disabled')).toBe('true');
    expect(await screen.findByText('403 Ingen tilgang', {}, { timeout: 2000 })).toBeTruthy();
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
    await renderAt('#/api-reference?view=service');
    expect(screen.getByRole('heading', { level: 1, name: 'Tjenesten som API' })).toBeTruthy();
    const variants = screen.getByRole('region', { name: 'Varianter' });
    expect(within(variants).getByText('ka__retrieve-only')).toBeTruthy();
    expect(within(variants).getByText('ka')).toBeTruthy();
    expect(within(variants).getByText('ka-retrieve-only')).toBeTruthy();
    const example = screen.getByLabelText('Eksempel på å velge versjon');
    expect(example.textContent).toContain('uten versjon brukes siste publiserte');
    fireEvent.change(screen.getByLabelText('Versjon'), { target: { value: '6' } });
    expect(example.textContent).toContain('GenAI-Version: 6');
    expect(example.textContent).toContain('metadata.version = "6"');
    expect(screen.queryByText('ka__v7')).toBeNull();
    expect(screen.getByText(/med versjonen som kjørte/).textContent).toContain('GenAI-Version');
    await screen.findByRole('option', { name: /Klarspråk/ });
    expectAccessible();
  });

  it('documents metadata.version next to GenAI-Version for chat completions', async () => {
    await renderAt('#/api-reference?endpoint=oa-chat');
    const params = screen.getByRole('region', { name: 'Parametre' });
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
      '#/api-reference?view=service',
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
  it('shows the call behind a portal action', async () => {
    await renderAt('#/api-reference?view=actions');
    expect(screen.getByRole('heading', { level: 1, name: 'Vis API-kall' })).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getAllByRole('button', { name: 'Vis API-kall' })[1] as HTMLElement);
    const panel = await screen.findByRole('dialog');
    expect(within(panel).getByText('/tenants/999888777/settings/search.top_k')).toBeTruthy();
    expect(within(panel).getByText('Administrere tjenester')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText(/«Lagre» er utført i prototypen/)).toBeTruthy();
  });
});
