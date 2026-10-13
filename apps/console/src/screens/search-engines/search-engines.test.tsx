// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { mockFetch } from '../../mock';
import { SearchEngines } from '../SearchEngines';

document.getAnimations ??= () => [];
HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
  this.setAttribute('open', '');
};
HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
  this.removeAttribute('open');
};

const recording = () => {
  const base = mockFetch();
  const calls: { method: string; path: string; body?: unknown; reason?: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const reason = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
      ...(reason ? { reason } : {}),
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const open = async (hash = '#/search-engines', fetch: typeof globalThis.fetch = mockFetch()) => {
  window.location.hash = hash;
  const api = createApiClient({ baseUrl: '/api', fetch, token: () => 'token' });
  render(<SearchEngines api={api} />);
};

const openEndpoint = async (name: string, fetch?: typeof globalThis.fetch) => {
  await open('#/search-engines', fetch);
  fireEvent.click(await screen.findByRole('link', { name }));
  await screen.findByRole('heading', { level: 1, name });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Søkemotorer', () => {
  it('lists endpoints with engine, location, what the search can do and status', async () => {
    await open();
    expect(await screen.findByRole('heading', { level: 1, name: 'Søkemotorer' })).toBeTruthy();
    const table = screen.getByRole('region', { name: 'Endepunkter' });
    const row = within(table).getByRole('link', { name: 'typesense-digdir' }).closest('tr');
    expect(row?.textContent).toContain('6 av 7: ikke lese avsnitt i rekkefølge');
    expect(row?.textContent).toContain('Data i Norge');
    expect(row?.textContent).toContain('23 datasett');
    expect(within(row as HTMLElement).getByText('I drift')).toBeTruthy();
    const builtin = within(table).getByRole('link', { name: 'innebygd-sok' }).closest('tr');
    expect(builtin?.textContent).toContain('Alt (7 av 7)');
    const azure = within(table).getByRole('link', { name: 'azure-sverige' }).closest('tr');
    expect(within(azure as HTMLElement).getByText('Ikke i bruk')).toBeTruthy();
    expect(builtin?.textContent).toContain('Plattformens egen database');
    expect(row?.textContent).toContain('typesense.ki.digdir.example.no');
    expect(azure?.textContent).toContain('Data i EU/EØS');

    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
    const panel = screen.getByRole('dialog');
    expect(within(panel).getByText('/operator/knowledge/engines')).toBeTruthy();
  });

  it('a secret field offers stored secrets and never a value', async () => {
    await openEndpoint('typesense-digdir');
    const select = screen.getByRole('combobox', { name: 'API-nøkkel' }) as HTMLSelectElement;
    const options = Array.from(select.options);
    expect(options.map((o) => o.textContent)).toEqual([
      'Velg en hemmelighet',
      'typesense-api-key (oppdatert 2. oktober)',
      'azure-search-key (oppdatert 14. september)',
      'opensearch-passord (oppdatert 1. august)',
    ]);
    expect(options.slice(1).every((o) => o.value.startsWith('secret://'))).toBe(true);
    expect(select.value).toBe('secret://platform/typesense-api-key');
    expect(screen.getByText('auth.secret · string · påkrevd · hemmelighet')).toBeTruthy();
    expect(document.querySelector('input[type="password"]')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
    const curl = within(screen.getByRole('dialog')).getByLabelText('Forespørsel').textContent ?? '';
    expect(curl).toContain('"secret": "secret://platform/typesense-api-key"');
    expect(curl).toContain('PUT');
  });

  it('an http URL fails format uri with an error-summary link', async () => {
    await open('#/search-engines?new=1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Nytt endepunkt' })).toBeTruthy();
    expect((screen.getByRole('radio', { name: /Typesense/ }) as HTMLInputElement).checked).toBe(
      true,
    );
    fireEvent.change(screen.getByRole('textbox', { name: 'Navn på endepunktet' }), {
      target: { value: 'Typesense, ny klynge' },
    });
    const url = screen.getByRole('textbox', { name: 'Adresse' });
    expect(url.getAttribute('type')).toBe('url');
    expect(screen.getByText('baseURL · string (uri) · påkrevd')).toBeTruthy();
    fireEvent.change(url, { target: { value: 'http://typesense.ki.example.no' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Prefiks for samlinger' }), {
      target: { value: 'KI-Prod' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Tidsavbrudd i sekunder (valgfritt)' }), {
      target: { value: '90' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endepunktet' }));

    const summary = await screen.findByRole('heading', {
      name: 'Rett disse feltene før du lagrer',
    });
    const box = summary.closest('ds-error-summary, .ds-error-summary, [class*="error-summary"]');
    const scope = (box ?? summary.parentElement) as HTMLElement;
    const link = within(scope).getByRole('link', {
      name: 'Adresse: Må være en https-adresse (format: uri).',
    });
    expect(link.getAttribute('href')).toBe('#f-baseURL');
    expect(
      within(scope).getByRole('link', {
        name: 'Prefiks for samlinger: Må følge mønsteret ^[a-z0-9_]+$ (pattern).',
      }),
    ).toBeTruthy();
    expect(
      within(scope).getByRole('link', {
        name: 'Tidsavbrudd i sekunder: Må være mellom 1 og 60 (minimum, maximum).',
      }),
    ).toBeTruthy();
    expect(
      within(scope).getByRole('link', { name: 'API-nøkkel: Feltet er påkrevd (required).' }),
    ).toBeTruthy();
    expect(url.getAttribute('aria-invalid')).toBe('true');
    expect(url.id).toBe('f-baseURL');
    fireEvent.click(link);
    expect(document.activeElement).toBe(url);
    expect(window.location.hash).toBe('#/search-engines?new=1');
  });

  it('the builtin engine shows no address or key fields', async () => {
    await openEndpoint('innebygd-sok');
    expect(
      screen.getByText('Kjører i plattformens database. Ingen adresse eller nøkkel trengs.'),
    ).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: /Adresse/ })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /nøkkel|hemmelighet/i })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Test tilkoblingen' })).toBeNull();
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByText('Søkemotor:', { exact: false }).textContent).toContain('Innebygd søk');
    expect(
      (
        screen.getByRole('textbox', {
          name: 'Koblinger per node (HNSW m) (valgfritt)',
        }) as HTMLInputElement
      ).value,
    ).toBe('16');
    expect(screen.getByText('options.hnswM · integer · valgfri · 4–64')).toBeTruthy();
    const language = screen.getByRole('combobox', {
      name: 'Språk for ordsøk (valgfritt)',
    }) as HTMLSelectElement;
    expect(Array.from(language.options).map((o) => o.textContent)).toEqual([
      'Norsk',
      'Uten språkregler',
    ]);
    expect(screen.getByText('Skjemaet fra API-et')).toBeTruthy();
    expect(screen.getByText(/184 datasett bruker endepunktet/)).toBeTruthy();
  });

  it('switches booleans with a switch and tests the connection', async () => {
    await openEndpoint('typesense-digdir');
    const toggle = screen.getByRole('switch', { name: 'Vektorsøk' }) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Test tilkoblingen' }));
    expect(await screen.findByText('Typesense svarte på 84 ms. Tilkoblingen virker.')).toBeTruthy();
    expect(screen.getByText('Virker')).toBeTruthy();
  });

  it('keeps a display name next to the endpoint id', async () => {
    const { calls, fetch } = recording();
    await openEndpoint('innebygd-sok', fetch);
    fireEvent.change(screen.getByRole('textbox', { name: 'Navn på endepunktet' }), {
      target: { value: 'Innebygd søk i plattformen' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Tydeligere navn i listen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endepunktet' }));

    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/operator/catalog/knowledge-endpoint/innebygd-sok');
    expect(put?.body).toMatchObject({ name: 'Innebygd søk i plattformen' });
    expect(await screen.findByRole('link', { name: 'Innebygd søk i plattformen' })).toBeTruthy();
  });

  it('saves an endpoint with a reason through the catalog route', async () => {
    const { calls, fetch } = recording();
    await openEndpoint('typesense-digdir', fetch);
    fireEvent.change(screen.getByRole('textbox', { name: 'Prefiks for samlinger' }), {
      target: { value: 'ki_test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endepunktet' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
      target: { value: 'Eget prefiks for testmiljøet' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endepunktet' }));
    expect(
      await screen.findByText(
        'Endepunktet «typesense-digdir» er lagret. Endringen er logget i Revisjon.',
      ),
    ).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.path).toBe('/api/operator/catalog/knowledge-endpoint/typesense-digdir');
    expect(put?.reason).toBe(encodeURIComponent('Eget prefiks for testmiljøet'));
    expect(put?.body).toEqual({
      engine: 'typesense',
      baseURL: 'https://typesense.ki.digdir.example.no',
      auth: { kind: 'api-key', secret: 'secret://platform/typesense-api-key' },
      options: { collectionPrefix: 'ki_test', connectionTimeoutSeconds: 5, vectorSearch: true },
      sharing: { tenants: '*' },
    });
    expect(
      calls.some(
        (c) =>
          c.path === '/api/operator/catalog/knowledge-endpoint/typesense-digdir' &&
          c.method === 'GET',
      ),
    ).toBe(true);
    await waitFor(() => expect(screen.getByRole('region', { name: 'Endepunkter' })).toBeTruthy());
  });

  it('removes an unused endpoint after a confirm step with a reason', async () => {
    const { calls, fetch } = recording();
    await open('#/search-engines', fetch);

    const table = await screen.findByRole('region', { name: 'Endepunkter' });
    expect(within(table).queryByRole('button', { name: 'Fjern innebygd-sok' })).toBeNull();
    fireEvent.click(within(table).getByRole('button', { name: 'Fjern azure-sverige' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fjern azure-sverige' });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Ble aldri tatt i bruk' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fjern' }));

    expect(await screen.findByText(/«azure-sverige» er fjernet/)).toBeTruthy();
    expect(within(table).queryByRole('link', { name: 'azure-sverige' })).toBeNull();
    expect(calls.find((c) => c.method === 'DELETE')).toMatchObject({
      path: '/api/operator/knowledge/endpoints/azure-sverige',
      reason: 'Ble%20aldri%20tatt%20i%20bruk',
    });
  });

  it('shows which datasets still use an endpoint when the platform refuses to remove it', async () => {
    await open();

    const table = await screen.findByRole('region', { name: 'Endepunkter' });
    fireEvent.click(within(table).getByRole('button', { name: 'Fjern typesense-digdir' }));
    const dialog = await screen.findByRole('dialog', { name: 'Fjern typesense-digdir' });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Flytter alt til pgvector' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fjern' }));

    expect(await within(dialog).findByText(/fortsatt i bruk/)).toBeTruthy();
    const kudos = within(dialog).getByText('Kudos').closest('li');
    expect(kudos?.textContent).toBe('Kudos · Digdir');
    expect(within(dialog).getByText('Regelverk').closest('li')?.textContent).toBe(
      'Regelverk · Testetaten',
    );
    expect(within(table).getByRole('link', { name: 'typesense-digdir' })).toBeTruthy();
  });
});
