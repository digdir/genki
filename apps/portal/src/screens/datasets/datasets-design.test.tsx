// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { createApiClient } from '../../api';
import type { DatasetDetailView, ExecutionView } from '../../api/datasets';
import { mockAnsattporten } from '../../auth';
import { exampleOrganisations, mockFetch, type FeatureMockOptions } from '../../mock';
import { exampleLiveDatasets } from '../../mock/datasets';
import { RightsProvider } from '../../Shell';
import { expectAccessible } from '../../test-utils';
import { LiveDatasetDetail } from './LiveDatasetDetail';

document.getAnimations ??= () => [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  URL.createObjectURL ??= () => 'blob:original';
  URL.revokeObjectURL ??= () => undefined;
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

interface Call {
  url: string;
  method: string;
  body: unknown;
  reason: string | null;
}

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const recorded = (datasets: FeatureMockOptions['datasets'] = {}) => {
  const calls: Call[] = [];
  const base = mockFetch(undefined, undefined, undefined, undefined, { features: { datasets } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = init?.body;
    const reason = new Headers(init?.headers).get('change-reason');
    calls.push({
      url: urlOf(input),
      method: init?.method ?? 'GET',
      body:
        raw instanceof FormData
          ? (raw.getAll('files') as File[]).map((f) => f.name)
          : raw
            ? (JSON.parse(String(raw)) as unknown)
            : undefined,
      reason: reason && decodeURIComponent(reason),
    });
    return base(input, init);
  };
  return { calls, fetch };
};

const renderLive = async (path: string, fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = path;
  return render(<App auth={auth} fetch={fetch} live />);
};

const renderDetail = (
  fetch: typeof globalThis.fetch,
  rights: string[],
  tab: 'content' | 'ingestions' = 'content',
) =>
  render(
    <RightsProvider value={rights as never}>
      <LiveDatasetDetail
        api={createApiClient({ baseUrl: '/api', fetch, token: () => 'ingrid' })}
        tenant="999888777"
        tenantName="Testetaten"
        id="999888777/veiledere"
        tab={tab}
      />
    </RightsProvider>,
  );

const veiledere = `#/datasets/${encodeURIComponent('999888777/veiledere')}`;
const nettsider = `#/datasets/${encodeURIComponent('999888777/nettsider')}`;
const writes = (calls: Call[]) =>
  calls.filter((c) => c.method !== 'GET').map((c) => `${c.method} ${c.url.replace(/^\/api/, '')}`);

const problem = (status: number, body: Record<string, unknown>) =>
  new Response(JSON.stringify({ title: 'Feil', status, ...body }), {
    status,
    headers: { 'content-type': 'application/problem+json' },
  });

const answering = (match: (url: string, method: string) => boolean, answer: () => Response) => {
  const { calls, fetch: base } = recorded();
  const fetch: typeof globalThis.fetch = async (input, init) =>
    match(urlOf(input), init?.method ?? 'GET') ? answer() : base(input, init);
  return { calls, fetch };
};

const scannedRun: ExecutionView = {
  id: 'ex-scanned',
  status: 'succeeded',
  startedAt: '2026-11-18T05:00:00Z',
  endedAt: '2026-11-18T05:01:00Z',
  report: {
    stored: 6,
    skipped: 1,
    skippedDocuments: [{ document: 'Skannet vedtak 2019.pdf', reason: 'no_text' }],
    failed: [],
  },
};

describe('dataset Innhold tab', () => {
  it('lists the first page of documents with unit, type and year, and no columns the API does not give', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    const table = await screen.findByRole('table', { name: 'Innhold' }, { timeout: 4000 });
    const row = within(table).getByRole('button', { name: 'Rundskriv 3-2026' }).closest('tr');
    expect(row?.textContent).toContain('Fagavdelingen');
    expect(row?.textContent).toContain('Rundskriv');
    expect(row?.textContent).toContain('2026');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Tittel', 'Type', 'År']);
    expect(screen.getByRole('status').textContent).toBe('3 dokumenter');
    const listing = calls.find((c) => c.url.includes('/documents?'));
    expect(listing?.url).toMatch(/\/datasets\/veiledere\/documents\?limit=50&offset=0$/);
    expectAccessible();
  });

  it('says how many files could not be read and links to the ingestions', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    await screen.findByRole('table', { name: 'Innhold' });
    expect(screen.getByText(/2 av 8 filer kunne ikke leses, og er ikke med her\./)).toBeTruthy();
    expect(
      screen.getByRole('link', { name: 'Se filene og hvordan du retter det' }).getAttribute('href'),
    ).toBe(`#/datasets/${encodeURIComponent('999888777/veiledere')}/ingestions`);
  });

  it('opens a document in a side panel with its facts, excerpt and the original file', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Veileder for søkere' }));
    const panel = await screen.findByRole('dialog', { name: 'Veileder for søkere' });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(await within(panel).findByText(/Veilederen forklarer hvordan du søker/)).toBeTruthy();
    expect(within(panel).getByText('Veileder for søkere.docx')).toBeTruthy();
    fireEvent.click(
      within(panel).getByRole('button', {
        name: 'Last ned originalfilen (Veileder for søkere.docx)',
      }),
    );
    await waitFor(() =>
      expect(
        calls.some((c) =>
          c.url.endsWith('/datasets/veiledere/uploads/Veileder%20for%20s%C3%B8kere.docx'),
        ),
      ).toBe(true),
    );
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('says the original file is no longer kept when the download answers original-not-kept', async () => {
    const { fetch } = answering(
      (url) => url.includes('/uploads/Veileder%20for%20s'),
      () => problem(404, { type: 'urn:genai:problem:original-not-kept' }),
    );
    await renderLive(veiledere, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Veileder for søkere' }));
    const panel = await screen.findByRole('dialog', { name: 'Veileder for søkere' });
    fireEvent.click(await within(panel).findByRole('button', { name: /Last ned originalfilen/ }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(
      'Originalfilen er ikke lagret lenger.',
    );
  });

  it('says only people can download originals when the download answers upload-people-only', async () => {
    const { fetch } = answering(
      (url) => url.includes('/uploads/Veileder%20for%20s'),
      () => problem(403, { type: 'urn:genai:problem:upload-people-only' }),
    );
    await renderLive(veiledere, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Veileder for søkere' }));
    const panel = await screen.findByRole('dialog', { name: 'Veileder for søkere' });
    fireEvent.click(await within(panel).findByRole('button', { name: /Last ned originalfilen/ }));
    expect((await within(panel).findByRole('alert')).textContent).toBe(
      'Bare personer kan laste ned originalfiler.',
    );
  });

  it('says the document is gone when the document read answers dataset-document-not-found', async () => {
    const { fetch } = answering(
      (url) => url.endsWith('/documents/veileder-tilsyn'),
      () => problem(404, { type: 'urn:genai:problem:dataset-document-not-found' }),
    );
    await renderLive(veiledere, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Veileder for tilsyn' }));
    const panel = await screen.findByRole('dialog', { name: 'Veileder for tilsyn' });
    expect(
      await within(panel).findByText('Datasettet har ikke dette dokumentet lenger.'),
    ).toBeTruthy();
  });

  it('offers no download for a document without an original file', async () => {
    const { fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Årsrapport 2025 Testetaten' }));
    const panel = await screen.findByRole('dialog', { name: 'Årsrapport 2025 Testetaten' });
    expect(within(panel).queryByRole('button', { name: /Last ned originalfilen/ })).toBeNull();
  });

  it('searches the documents through the dataset search with the chosen filters', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    await screen.findByRole('table', { name: 'Innhold' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i dokumentene' }), {
      target: { value: 'tilsyn' },
    });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rundskriv 3-2026' })).toBeNull(),
    );
    expect(await screen.findByRole('button', { name: 'Veileder for tilsyn' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('1 av 3 dokumenter passer');
    const search = calls.find((c) => c.url.endsWith('/datasets/veiledere/search'));
    expect(search?.method).toBe('POST');
    expect(search?.body).toEqual({ query: 'tilsyn', limit: 100 });
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(await screen.findByRole('button', { name: 'Rundskriv 3-2026' })).toBeTruthy();
  });

  it('filters across all documents through the API with the facet values that are ticked', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    await screen.findByRole('table', { name: 'Innhold' });
    expect(screen.getByRole('status').textContent).toMatch(/^48\s312 dokumenter$/);
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Årsrapport' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Tildelingsbrev 2026 Testetaten' })).toBeNull(),
    );
    expect(await screen.findByRole('button', { name: 'Årsrapport 2025 Testetaten' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toMatch(/^1 av 48\s312 dokumenter passer$/);
    const filtered = calls.find((c) => c.url.includes('filters='));
    expect(filtered?.url).toContain(
      `/documents?limit=50&offset=0&filters=${encodeURIComponent('{"type":["Årsrapport"]}')}`,
    );
  });

  it('names the field when the API refuses a filter the dataset does not declare', async () => {
    const { fetch } = answering(
      (url) => url.includes('filters='),
      () =>
        problem(422, {
          errors: [{ path: 'filters.type', message: 'The dataset has no filter type' }],
        }),
    );
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    await screen.findByRole('table', { name: 'Innhold' });
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Årsrapport' }));
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Datasettet kan ikke filtreres på «type».',
    );
  });

  it('offers the search only to people who may search a dataset directly', async () => {
    const { fetch } = recorded();
    renderDetail(fetch, ['use-services']);
    await screen.findByRole('table', { name: 'Innhold' });
    expect(screen.queryByRole('searchbox', { name: 'Søk i dokumentene' })).toBeNull();
  });

  it('says no document matches and resets from there', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    await screen.findByRole('table', { name: 'Innhold' });
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i dokumentene' }), {
      target: { value: 'finnes-ikke' },
    });
    expect(await screen.findByRole('heading', { name: 'Ingen dokumenter passer' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(await screen.findByRole('table', { name: 'Innhold' })).toBeTruthy();
  });

  it('says the list is missing, not the documents, when the listing fails', async () => {
    const base = recorded().fetch;
    let fail = true;
    const fetch: typeof globalThis.fetch = async (input, init) =>
      fail && urlOf(input).includes('/documents?')
        ? new Response(JSON.stringify({ title: 'Feil', status: 502 }), { status: 502 })
        : base(input, init);
    await renderLive(veiledere, fetch);
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText('Vi fikk ikke hentet dokumentene')).toBeTruthy();
    expect(alert.textContent).toContain('Tjenestene finner fortsatt dokumentene');
    fail = false;
    fireEvent.click(within(alert).getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByRole('table', { name: 'Innhold' })).toBeTruthy();
  });

  it('shows the empty state with an upload button for an upload dataset without documents', async () => {
    const { fetch } = recorded({
      datasets: exampleLiveDatasets.map((d) =>
        d.id === 'veiledere' ? { ...d, documents: 0, lastExecution: null, skipped: [] } : d,
      ),
      documents: {},
    });
    await renderLive(veiledere, fetch);
    expect(await screen.findByRole('heading', { name: 'Ingen dokumenter ennå' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Last opp filer' }).length).toBeGreaterThan(0);
  });
});

describe('dataset header', () => {
  it('has Les inn på nytt and Last opp filer, and no Prøv or API call', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    expect(screen.getByRole('button', { name: 'Les inn på nytt' })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Last opp filer' }).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Prøv' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vis API-kall' })).toBeNull();
  });

  it('uploads the chosen files from the header and then reads the dataset in again', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    fireEvent.change(screen.getByLabelText('Velg filer å laste opp'), {
      target: { files: [new File(['a'], 'Ny veileder.pdf', { type: 'application/pdf' })] },
    });
    await waitFor(() =>
      expect(writes(calls)).toEqual([
        'POST /tenants/999888777/datasets/veiledere/uploads',
        'POST /tenants/999888777/datasets/veiledere/pipelines/upload/execute',
      ]),
    );
    expect(calls.every((c) => c.method === 'GET' || c.reason)).toBe(true);
  });

  it('fetches the uploaded files as the dataset opens, before Innstillinger is chosen', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/datasets/veiledere/uploads'))).toBe(true),
    );
  });
});

describe('dataset ingestions', () => {
  it('lists a skipped scanned file without a text recognition control, which the API does not have', async () => {
    const { fetch } = recorded({ executions: { '999888777/veiledere/upload': [scannedRun] } });
    await renderLive(`${veiledere}/ingestions`, fetch);
    fireEvent.click(await screen.findByRole('button', { name: /18\. november 2026/ }));
    expect(
      screen.getByText('Skannet PDF uten tekst. Tekstgjenkjenning er ikke slått på.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /tekstgjenkjenning/i })).toBeNull();
  });

  it('shows a failed website ingestion as the design does: cause, fallback content and a run table', async () => {
    const { fetch } = recorded();
    await renderLive(`${nettsider}/ingestions`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nettsidene til Testetaten' });
    const alert = (await screen.findByText(/Innlesingen .* feilet/)).closest(
      '.ds-alert',
    ) as HTMLElement;
    expect(alert.textContent).toContain('Årsak: sitemap returned 503');
    expect(alert.textContent).toMatch(/Tjenestene bruker innholdet fra 7\. oktober 2026\./);
    expect(alert.textContent).toContain('Hvis adressen er flyttet, endre den.');
    expect(within(alert).getByRole('link', { name: 'Endre adressen' })).toBeTruthy();
    expect(screen.getByText(/Siste vellykkede innlesing 7\. oktober 2026/)).toBeTruthy();
    const table = await screen.findByRole('table', { name: 'Innlesinger' });
    const headers = within(table)
      .getAllByRole('columnheader')
      .map((h) => h.textContent);
    expect(headers).toEqual(['Startet', 'Status', 'Hva skjedde', 'Startet av']);
    expect(table.textContent).toContain('sitemap returned 503. Ingen sider ble endret.');
    expect(table.textContent).toContain('1 240 sider'.replace(' ', ' '));
  });
});

describe('dataset Brukes av', () => {
  it('says when and by whom the dataset was added to each service', async () => {
    const { fetch } = recorded();
    await renderLive(`${nettsider}/used-by`, fetch);
    const table = await screen.findByRole('table', { name: 'Brukes av' });
    expect(within(table).getByRole('columnheader', { name: 'Lagt til' })).toBeTruthy();
    expect(table.textContent).toMatch(/1\. oktober 2026 av Kari Nordmann/);
  });
});

describe('dataset Innstillinger', () => {
  it('saves who can search through the dataset, with the reason', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}/source`, fetch);
    const tenantOnly = await screen.findByRole('radio', { name: 'Tjenestene i Testetaten' });
    expect((tenantOnly as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByRole('radio', { name: 'Alle virksomheter på genki' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Andre etater trenger veilederne' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));
    await waitFor(() =>
      expect(writes(calls)).toContain('PUT /tenants/999888777/datasets/veiledere'),
    );
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toMatchObject({ searchScope: 'all' });
    expect(put?.reason).toBe('Andre etater trenger veilederne');
  });

  it('offers no text recognition or linked PDF switch, which the API does not have', async () => {
    const { fetch } = recorded();
    await renderLive(`${nettsider}/source`, fetch);
    await screen.findByLabelText('Navn');
    expect(screen.queryByRole('checkbox', { name: /tekstgjenkjenning/i })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /PDF/ })).toBeNull();
  });

  it('saves a name change without the search scope when that is unchanged', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${nettsider}/source`, fetch);
    fireEvent.change(await screen.findByLabelText('Navn'), { target: { value: 'Nettsidene' } });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), { target: { value: 'Kortere navn' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre endringene' }));
    await waitFor(() =>
      expect(writes(calls)).toContain('PUT /tenants/999888777/datasets/nettsider'),
    );
    expect(calls.find((c) => c.method === 'PUT')?.body).not.toHaveProperty('searchScope');
  });

  it('offers how often to read in for an upload dataset too', async () => {
    const { fetch } = recorded();
    await renderLive(`${veiledere}/source`, fetch);
    expect(await screen.findByRole('radio', { name: /Hver natt/ })).toBeTruthy();
    expect(
      (screen.getByRole('radio', { name: /Bare når jeg ber om det/ }) as HTMLInputElement).checked,
    ).toBe(true);
  });
});

describe('new dataset from the design', () => {
  const fillName = async (name: string) => {
    await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' });
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: name } });
  };

  const toEndpoint = async (url: string) => {
    await fillName('Saksarkivet');
    fireEvent.click(screen.getByRole('radio', { name: /Eksternt endepunkt/ }));
    fireEvent.change(screen.getByLabelText('Adressen til endepunktet', { exact: false }), {
      target: { value: url },
    });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Saksarkivet skal kunne søkes i' },
    });
  };

  it('creates an endpoint dataset with its API key, header and search scope, and no pipeline', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    await toEndpoint('https://sak.testetaten.example.no/api/sok');
    expect(screen.queryByRole('radio', { name: 'Hver uke' })).toBeNull();
    fireEvent.change(screen.getByLabelText('API-nøkkel', { exact: false }), {
      target: { value: 'hemmelig-nokkel' },
    });
    fireEvent.change(screen.getByLabelText('Header for nøkkelen', { exact: false }), {
      target: { value: 'x-api-key' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Alle virksomheter på genki' }));
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Saksarkivet' })).toBeTruthy();
    expect(writes(calls)).toEqual(['POST /tenants/999888777/datasets']);
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      name: 'Saksarkivet',
      residency: 'global',
      searchScope: 'all',
      endpointSource: {
        url: 'https://sak.testetaten.example.no/api/sok',
        auth: { kind: 'api-key', apiKey: 'hemmelig-nokkel', header: 'x-api-key' },
      },
    });
    expect(post?.reason).toBe('Saksarkivet skal kunne søkes i');
  });

  it('offers no Maskinporten sign-in for an endpoint, which the API does not have', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    await toEndpoint('https://sak.testetaten.example.no/api/sok');
    const options = within(screen.getByLabelText('Hvordan logger vi inn?'))
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(options).toEqual(['API-nøkkel', 'Ingen innlogging (åpent endepunkt)']);
  });

  it('refuses a key header the API would refuse before anything is sent', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    await toEndpoint('https://sak.testetaten.example.no/api/sok');
    fireEvent.change(screen.getByLabelText('API-nøkkel', { exact: false }), {
      target: { value: 'hemmelig-nokkel' },
    });
    fireEvent.change(screen.getByLabelText('Header for nøkkelen', { exact: false }), {
      target: { value: 'x api key' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    expect(
      await screen.findByRole('link', {
        name: 'Bruk bare bokstaver, tall og bindestrek, høyst 64 tegn.',
      }),
    ).toBeTruthy();
    expect(writes(calls)).toEqual([]);
  });

  it('says genki does not call the address when the API answers endpoint-not-allowed', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    await toEndpoint('https://sok.localhost/api');
    fireEvent.change(screen.getByLabelText('Hvordan logger vi inn?'), {
      target: { value: 'none' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    expect(await screen.findByText(/Vi kaller ikke denne adressen/)).toBeTruthy();
  });

  it.each([
    [409, 'Det finnes allerede en tilkobling eller en nøkkel for dette datasettet.'],
    [403, 'Du kan ikke lagre en API-nøkkel.'],
  ])('explains a %i from the endpoint create in words', async (status, text) => {
    const { fetch } = answering(
      (url, method) => method === 'POST' && url.endsWith('/tenants/999888777/datasets'),
      () => problem(status, {}),
    );
    await renderLive('#/datasets/new', fetch);
    await toEndpoint('https://sak.testetaten.example.no/api/sok');
    fireEvent.change(screen.getByLabelText('API-nøkkel', { exact: false }), {
      target: { value: 'hemmelig-nokkel' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    expect(await screen.findByText(new RegExp(text))).toBeTruthy();
  });

  it('sends the search scope with the new dataset itself, with no extra write', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    await fillName('Nettsidene våre');
    fireEvent.click(screen.getByRole('radio', { name: /Nettsted/ }));
    expect(screen.queryByRole('checkbox', { name: /PDF/ })).toBeNull();
    fireEvent.change(screen.getByLabelText('Adresse til nettstedskartet', { exact: false }), {
      target: { value: 'https://testetaten.example.no/sitemap.xml' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Alle virksomheter på genki' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Nettsidene skal kunne søkes i' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    await screen.findByRole('heading', { level: 1, name: 'Nettsidene våre' });
    expect(writes(calls)).toEqual([
      'PUT /tenants/999888777/catalog/dataset/nettsidene-vare',
      'POST /tenants/999888777/datasets/nettsidene-vare/pipelines',
      'POST /tenants/999888777/datasets/nettsidene-vare/pipelines/website/execute',
    ]);
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({ searchScope: 'all' });
  });
});

const theirs: DatasetDetailView = {
  id: 'interne-sider',
  fullId: '111222333/interne-sider',
  name: 'Interne sider hos Annenetaten',
  scope: '111222333',
  editable: true,
  residency: 'global',
  index: { endpoint: 'platform-pg' },
  facets: [],
  searchScope: 'all',
  source: 'website',
  state: 'ready',
  documents: 40,
  chunks: 400,
  lastExecution: {
    status: 'succeeded',
    startedAt: '2026-11-17T03:00:00Z',
    endedAt: '2026-11-17T03:05:00Z',
    stored: 40,
    skipped: 0,
  },
  nextRunAt: '2026-11-19T03:00:00Z',
  usedBy: [],
};

const endpointDataset: DatasetDetailView = {
  id: 'saksarkivet',
  fullId: '999888777/saksarkivet',
  name: 'Saksarkivet',
  scope: '999888777',
  editable: true,
  residency: 'global',
  index: { endpoint: 'endpoint-saksarkivet' },
  facets: [],
  searchScope: 'tenant',
  source: 'endpoint',
  state: 'external',
  documents: null,
  chunks: null,
  lastExecution: null,
  nextRunAt: null,
  usedBy: [],
};

describe("another organisation's dataset", () => {
  it('shows its source and last run as unknown in the list, never as no source or never run', async () => {
    const { fetch } = recorded({ datasets: [...exampleLiveDatasets, theirs] });
    await renderLive('#/datasets', fetch);
    const table = await screen.findByRole('table', { name: 'Datasett' });
    const row = within(table)
      .getByText('Interne sider hos Annenetaten')
      .closest('tr') as HTMLElement;
    expect(row.textContent).toContain('Delt med dere av en annen virksomhet');
    expect(row.textContent).toContain('Ukjent');
    expect(row.textContent).toContain('Klar');
    expect(row.textContent).not.toMatch(/Ikke ennå|Ingen kilde|Ikke lest inn|Nettsted/);
  });

  it('leaves the source and last run out of the detail header', async () => {
    const { fetch } = recorded({ datasets: [...exampleLiveDatasets, theirs] });
    await renderLive(
      `#/datasets/${encodeURIComponent('111222333/interne-sider')}/ingestions`,
      fetch,
    );
    await screen.findByRole('heading', { level: 1, name: 'Interne sider hos Annenetaten' });
    const lead = document.querySelector('.page-head .lead')?.textContent ?? '';
    expect(lead).toBe('Delt med dere av en annen virksomhet · 40 dokumenter lest inn');
    expect(screen.queryByRole('button', { name: 'Les inn på nytt' })).toBeNull();
  });
});

describe('deleting an endpoint dataset', () => {
  it('says the connection to the endpoint goes with it, before and after', async () => {
    const { calls, fetch } = recorded({ datasets: [...exampleLiveDatasets, endpointDataset] });
    await renderLive(`#/datasets/${encodeURIComponent('999888777/saksarkivet')}/source`, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Slett datasettet' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(
      'Tilkoblingen til endepunktet og API-nøkkelen slettes også.',
    );
    fireEvent.change(within(dialog).getByLabelText('Skriv navnet på datasettet for å bekrefte'), {
      target: { value: 'Saksarkivet' },
    });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Trengs ikke lenger' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Slett datasettet' }));
    expect(await screen.findByText(/Tilkoblingen endpoint-saksarkivet er fjernet\./)).toBeTruthy();
    expect(writes(calls)).toEqual(['DELETE /tenants/999888777/datasets/saksarkivet']);
  });
});
