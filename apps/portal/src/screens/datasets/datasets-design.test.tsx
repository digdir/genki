// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import type { DatasetDetailView, ExecutionView } from '../../api/datasets';
import { createApiClient } from '../../api';
import { mockAnsattporten } from '../../auth';
import { exampleOrganisations, mockFetch, type FeatureMockOptions } from '../../mock';
import { exampleDocuments, exampleLiveDatasets } from '../../mock/datasets';
import { RightsProvider } from '../../Shell';
import { expectAccessible } from '../../test-utils';
import { translator } from '../../i18n';
import { facetLabel } from './Content';
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

const renderDetail = (fetch: typeof globalThis.fetch, rights: string[]) =>
  render(
    <RightsProvider value={rights as never}>
      <LiveDatasetDetail
        api={createApiClient({ baseUrl: '/api', fetch, token: () => 'ingrid' })}
        tenant="999888777"
        tenantName="Testetaten"
        id="999888777/veiledere"
        tab="content"
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

const many = (count: number) =>
  Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(3, '0');
    return {
      id: `dok-${n}`,
      title: `Dokument ${n}`,
      fields: { type: i % 2 ? 'Veileder' : 'Rundskriv', year: '2025' },
      status: 'indexed' as const,
    };
  });

const searchable = (count = 120) =>
  recorded({
    datasets: exampleLiveDatasets.map((d) =>
      d.id === 'veiledere' ? { ...d, facets: ['type'] } : d,
    ),
    documents: { '999888777/veiledere': many(count) },
    listing: { '999888777/veiledere': { query: true, sort: ['title', 'year'] } },
  });

const listings = (calls: Call[]) =>
  calls.filter((c) => /\/documents\?/.test(c.url)).map((c) => decodeURIComponent(c.url));

const docsTable = () => screen.findByRole('table', { name: 'Dokumenter' }, { timeout: 4000 });

describe('dataset Innhold tab', () => {
  it('lists one page of documents with title, type, source, chunks and status, and no columns the API does not give', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    const table = await docsTable();
    const row = within(table).getByRole('button', { name: 'Rundskriv 3-2026' }).closest('tr');
    expect(row?.textContent).toContain('Fagavdelingen · 2026');
    expect(row?.textContent).toContain('Rundskriv');
    expect(row?.textContent).toContain('Opplastet fil');
    expect(row?.textContent).toContain('Lest inn');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['', 'Tittel', 'Type', 'Kilde', 'Biter', 'Status']);
    expect(screen.getByRole('status').textContent).toBe('1-5 av 5 dokumenter');
    expect(listings(calls)[0]).toMatch(
      /\/datasets\/veiledere\/documents\?limit=50&offset=0&status=all$/,
    );
    expectAccessible();
  });

  it('paging keeps the search, sort and filter and asks the API for the next page only', async () => {
    const { calls, fetch } = searchable();
    await renderLive(
      `${veiledere}/content?q=Dokument&sort=title&order=asc&filter.type=Veileder`,
      fetch,
    );
    await docsTable();
    expect(await screen.findByRole('button', { name: 'Dokument 002' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(await screen.findByRole('button', { name: 'Dokument 102' })).toBeTruthy();
    expect(listings(calls).at(-1)).toContain(
      'limit=50&offset=50&filters={"type":["Veileder"]}&query=Dokument&sort=title&order=asc',
    );
    expect(window.location.hash).toContain('page=2');
    expect(window.location.hash).toContain('q=Dokument');
    expect(window.location.hash).toContain('filter.type=Veileder');
    expect(screen.getByRole('status').textContent).toBe('51-60 av 60 som passer');
  });

  it('the address restores the page, page size, search, sort and status filter', async () => {
    const { calls, fetch } = searchable();
    await renderLive(`${veiledere}/content?page=2&size=25&q=Dokument&sort=title&order=asc`, fetch);
    await docsTable();
    expect(listings(calls)[0]).toContain('limit=25&offset=25&query=Dokument&sort=title&order=asc');
    expect(screen.getByRole('searchbox', { name: 'Søk i titler' })).toHaveProperty(
      'value',
      'Dokument',
    );
    expect(screen.getByRole('combobox', { name: 'Per side' })).toHaveProperty('value', '25');
    expect(screen.getByRole('combobox', { name: 'Sorter etter' })).toHaveProperty(
      'value',
      'title-asc',
    );
    expect(screen.getByRole('button', { name: 'Side 2' }).getAttribute('aria-current')).toBe(
      'true',
    );
    expect(screen.getByRole('status').textContent).toBe('26-50 av 120 som passer');
  });

  it('follows the address when it changes, as Back does', async () => {
    const { fetch } = searchable();
    await renderLive(`${veiledere}/content?page=3`, fetch);
    expect(await screen.findByRole('button', { name: 'Dokument 101' })).toBeTruthy();
    window.location.hash = `${veiledere}/content?page=2`;
    expect(await screen.findByRole('button', { name: 'Dokument 051' })).toBeTruthy();
  });

  it('a new page keeps the rows on screen, dimmed, until it comes', async () => {
    const { fetch: base } = searchable();
    let release = () => {};
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (urlOf(input).includes('offset=50'))
        await new Promise<void>((resolve) => (release = resolve));
      return base(input, init);
    };
    await renderLive(`${veiledere}/content`, fetch);
    const table = await docsTable();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    await waitFor(() => expect(table.getAttribute('aria-busy')).toBe('true'));
    expect(screen.getByRole('status').textContent).toBe('Henter side 2 …');
    expect(within(table).getByRole('button', { name: 'Dokument 001' })).toBeTruthy();
    release();
    expect(await screen.findByRole('button', { name: 'Dokument 051' })).toBeTruthy();
  });

  it('changes the page size from the pager and starts on the first page', async () => {
    const { calls, fetch } = searchable();
    await renderLive(`${veiledere}/content?page=2`, fetch);
    await docsTable();
    fireEvent.change(screen.getByRole('combobox', { name: 'Per side' }), {
      target: { value: '100' },
    });
    await waitFor(() => expect(listings(calls).at(-1)).toMatch(/limit=100&offset=0&status=all$/));
    expect(window.location.hash).toContain('size=100');
    expect(window.location.hash).not.toContain('page=');
  });

  it('goes to the page asked for in Gå til side', async () => {
    const { fetch } = searchable(300);
    await renderLive(`${veiledere}/content`, fetch);
    await docsTable();
    expect(screen.getByText('av 7')).toBeTruthy();
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Gå til side' }), {
      target: { value: '5' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Gå' }));
    expect(await screen.findByRole('button', { name: 'Dokument 201' })).toBeTruthy();
  });

  it('searches titles through the document listing and keeps the words in the address', async () => {
    const { calls, fetch } = searchable();
    await renderLive(`${veiledere}/content`, fetch);
    await docsTable();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i titler' }), {
      target: { value: 'Dokument 11' },
    });
    expect(await screen.findByText('1-10 av 10 som passer')).toBeTruthy();
    expect(listings(calls).at(-1)).toContain('query=Dokument 11');
    expect(calls.some((c) => c.url.endsWith('/search'))).toBe(false);
    expect(window.location.hash).toContain('q=Dokument+11');
  });

  it('hides the search and the sort when the engine cannot search or sort', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    await docsTable();
    expect(screen.queryByRole('searchbox', { name: 'Søk i titler' })).toBeNull();
    expect(screen.queryByRole('combobox', { name: 'Sorter etter' })).toBeNull();
  });

  it('offers only the sort keys the engine names', async () => {
    const { fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    await docsTable();
    const sort = screen.getByRole('combobox', { name: 'Sorter etter' });
    expect(
      within(sort)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Standard rekkefølge', 'Tittel A-Å', 'År, nyest først']);
  });

  it('drops a search from the address when the engine cannot search titles', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}/content?q=tilsyn`, fetch);
    expect(await docsTable()).toBeTruthy();
    expect(listings(calls).at(-1)).toMatch(/limit=50&offset=0&status=all$/);
    expect(window.location.hash).not.toContain('q=');
  });

  it('counts each status in the status filter and lists the failed documents with their reason', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    await docsTable();
    const status = screen.getByRole('combobox', { name: 'Status' });
    expect(
      within(status)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Alle (5)', 'Lest inn (3)', 'Feilet (2)', 'Venter (0)']);
    fireEvent.change(status, { target: { value: 'failed' } });
    const row = (await screen.findByRole('button', { name: 'Skannet vedtak 2019.pdf' })).closest(
      'tr',
    );
    expect(row?.textContent).toContain('Filen har ikke tekst vi kan lese');
    expect(row?.textContent).toContain('Feilet');
    expect(listings(calls).at(-1)).toMatch(/limit=50&offset=0&status=failed$/);
    expect(screen.getByRole('button', { name: 'Fjern filteret Status: Feilet' })).toBeTruthy();
    expect(window.location.hash).toContain('status=failed');
  });

  it('opens a failed document with its reason, without reading it from the index', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}/content?status=failed`, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Presentasjon.pages' }));
    const panel = await screen.findByRole('dialog', { name: 'Presentasjon.pages' });
    expect(within(panel).getByText(/Filtypen støttes ikke/)).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/documents/Presentasjon'))).toBe(false);
  });

  it('the chunk panel reads the first chunks, then the next range until the last chunk', async () => {
    const chunks = Array.from({ length: 15 }, (_, i) => ({
      id: `c${i}`,
      position: i,
      page: i + 1,
      text: `Tekst i bit ${i + 1}`,
    }));
    const { calls, fetch } = recorded({
      documents: {
        '999888777/veiledere': [
          {
            id: 'lang',
            title: 'Lang veileder',
            fields: {},
            status: 'indexed',
            chunkCount: 15,
            chunks,
          },
        ],
      },
    });
    await renderLive(veiledere, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Lang veileder' }));
    const panel = await screen.findByRole('dialog', { name: 'Lang veileder' });
    expect(await within(panel).findByText('Bit 1 av 15 · side 1')).toBeTruthy();
    expect(within(panel).getAllByRole('listitem')).toHaveLength(3);
    expect(within(panel).getByText('15 biter')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Vis flere biter' }));
    expect(await within(panel).findByText('Tekst i bit 13')).toBeTruthy();
    fireEvent.click(within(panel).getByRole('button', { name: 'Vis flere biter' }));
    expect(await within(panel).findByText('Tekst i bit 15')).toBeTruthy();
    expect(within(panel).queryByRole('button', { name: 'Vis flere biter' })).toBeNull();
    expect(
      calls.filter((c) => c.url.includes('/documents/lang')).map((c) => c.url.split('?')[1]),
    ).toEqual(['chunks=0-2', 'chunks=3-12', 'chunks=13-14']);
  });

  it('says about N when the total is an estimate', async () => {
    const page = {
      dataset: '999888777/veiledere',
      limit: 50,
      offset: 0,
      total: 100,
      totalExact: false,
      status: 'indexed',
      statusCounts: { indexed: null, failed: 0, pending: 0 },
      listing: { query: false, sort: [] },
      documents: many(50),
    };
    const { fetch } = answering(
      (url) => url.includes('/documents?'),
      () => new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } }),
    );
    await renderLive(veiledere, fetch);
    await docsTable();
    expect(screen.getByRole('status').textContent).toBe('1-50 av omtrent 100 dokumenter');
    expect(screen.getByText('av omtrent 2')).toBeTruthy();
    expect(
      within(screen.getByRole('combobox', { name: 'Status' }))
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['Alle', 'Lest inn', 'Feilet (0)', 'Venter (0)']);
  });

  it('shows the table skeleton with the real column headers while the first page loads', async () => {
    const { fetch: base } = recorded();
    let release = () => {};
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (urlOf(input).includes('/documents?'))
        await new Promise<void>((resolve) => (release = resolve));
      return base(input, init);
    };
    await renderLive(veiledere, fetch);
    await waitFor(
      () =>
        expect(
          screen.getAllByRole('columnheader', { hidden: true }).map((h) => h.textContent),
        ).toEqual(['Tittel', 'Type', 'Kilde', 'Biter', 'Status']),
      { timeout: 3000 },
    );
    release();
    expect(await docsTable()).toBeTruthy();
  });

  it('offers row selection only on uploaded files, and removal only to people who manage the dataset', async () => {
    const withPage = exampleDocuments['999888777/veiledere'] ?? [];
    const { fetch } = recorded({
      documents: {
        '999888777/veiledere': [
          ...withPage,
          { id: 'side', title: 'Side uten fil', fields: {}, status: 'indexed' },
        ],
      },
    });
    renderDetail(fetch, ['use-services']);
    const table = await docsTable();
    expect(within(table).queryByRole('checkbox', { name: 'Velg Side uten fil' })).toBeNull();
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Velg Rundskriv 3-2026' }));
    const bar = screen.getByRole('region', { name: 'Valgte dokumenter' });
    expect(within(bar).getByText('1 valgt')).toBeTruthy();
    expect(within(bar).getByRole('button', { name: 'Last ned originalfilene' })).toBeTruthy();
    expect(within(bar).queryByRole('button', { name: 'Fjern fra dokumentsamlingen' })).toBeNull();
  });

  it('downloads the original of each chosen file', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    const table = await docsTable();
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Velg Rundskriv 3-2026' }));
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Velg Veileder for tilsyn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Last ned originalfilene' }));
    await waitFor(() =>
      expect(
        calls.filter((c) => c.method === 'GET' && c.url.includes('/uploads/')).map((c) => c.url),
      ).toEqual([
        '/api/tenants/999888777/datasets/veiledere/uploads/Rundskriv%203-2026.pdf',
        '/api/tenants/999888777/datasets/veiledere/uploads/Veileder%20for%20tilsyn.pdf',
      ]),
    );
  });

  it('asks before removing, names the count, and removes each chosen file with a reason', async () => {
    const { calls, fetch } = recorded({
      uploads: {
        '999888777/veiledere': [
          { name: 'Rundskriv 3-2026.pdf', size: 634_880, type: 'pdf' },
          { name: 'Veileder for søkere.docx', size: 348_160, type: 'docx' },
          { name: 'Veileder for tilsyn.pdf', size: 512_000, type: 'pdf' },
        ],
      },
    });
    await renderLive(veiledere, fetch);
    const table = await docsTable();
    fireEvent.click(
      within(table).getByRole('checkbox', { name: 'Velg alle opplastede filer på siden' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Fjern fra dokumentsamlingen' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Fjerne 3 filer fra dokumentsamlingen?',
    });
    expect(writes(calls).filter((w) => w.startsWith('DELETE'))).toEqual([]);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fjern 3 filer' }));
    await waitFor(() => expect(calls.filter((c) => c.method === 'DELETE').length).toBe(3));
    expect(
      await screen.findByText(
        '3 filer er fjernet. Dokumentene forsvinner fra søket ved neste innlesing.',
      ),
    ).toBeTruthy();
    const removed = calls.filter((c) => c.method === 'DELETE');
    expect(removed.map((c) => decodeURIComponent(c.url.split('/uploads/')[1] ?? ''))).toEqual([
      'Rundskriv 3-2026.pdf',
      'Veileder for søkere.docx',
      'Veileder for tilsyn.pdf',
    ]);
    expect(removed[0]?.reason).toBe(
      'Fjernet Rundskriv 3-2026.pdf fra Veiledere og rundskriv i Innhold',
    );
    expect(screen.queryByRole('region', { name: 'Valgte dokumenter' })).toBeNull();
  });

  it('names the files it could not remove and keeps them chosen', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    const table = await docsTable();
    fireEvent.click(within(table).getByRole('checkbox', { name: 'Velg Veileder for tilsyn' }));
    fireEvent.click(screen.getByRole('button', { name: 'Fjern fra dokumentsamlingen' }));
    const dialog = await screen.findByRole('dialog', {
      name: 'Fjerne 1 fil fra dokumentsamlingen?',
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fjern 1 fil' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'Vi fikk ikke fjernet Veileder for tilsyn.pdf.',
    );
    expect(
      within(screen.getByRole('region', { name: 'Valgte dokumenter' })).getByText('1 valgt'),
    ).toBeTruthy();
  });

  it('opens a document in a side panel with its facts, excerpt and the original file', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    const title = await screen.findByRole('button', { name: 'Veileder for søkere' });
    title.focus();
    fireEvent.click(title);
    const panel = await screen.findByRole('dialog', { name: 'Veileder for søkere' });
    expect(panel.getAttribute('aria-modal')).toBe('false');
    expect(await within(panel).findByText(/Veilederen forklarer hvordan du søker/)).toBeTruthy();
    expect(within(panel).getByText(/^Veileder for søkere\.docx, /)).toBeTruthy();
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
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Veileder for søkere' }),
    );
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
      (url) => url.includes('/documents/veileder-tilsyn'),
      () => problem(404, { type: 'urn:genai:problem:dataset-document-not-found' }),
    );
    await renderLive(veiledere, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Veileder for tilsyn' }));
    const panel = await screen.findByRole('dialog', { name: 'Veileder for tilsyn' });
    expect(
      await within(panel).findByText('Dokumentsamlingen har ikke dette dokumentet lenger.'),
    ).toBeTruthy();
  });

  it('offers no download for a document without an original file', async () => {
    const { fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Årsrapport 2025 Testetaten' }));
    const panel = await screen.findByRole('dialog', { name: 'Årsrapport 2025 Testetaten' });
    expect(within(panel).queryByRole('button', { name: /Last ned originalfilen/ })).toBeNull();
  });

  it('filters across all documents through the API with the value chosen, counted per value', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    await docsTable();
    expect(screen.getByRole('status').textContent).toMatch(/^1-2 av 48\s312 dokumenter$/);
    const type = screen.getByRole('combobox', { name: 'Dokumenttype' });
    await waitFor(() =>
      expect(within(type).getByRole('option', { name: /^Årsrapport \(/ })).toBeTruthy(),
    );
    fireEvent.change(type, { target: { value: 'Årsrapport' } });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Tildelingsbrev 2026 Testetaten' })).toBeNull(),
    );
    expect(screen.getByRole('button', { name: 'Årsrapport 2025 Testetaten' })).toBeTruthy();
    expect(screen.getByRole('status').textContent).toBe('1-1 av 1 som passer');
    expect(listings(calls).at(-1)).toContain('limit=50&offset=0&filters={"type":["Årsrapport"]}');
    expect(
      screen.getByRole('button', { name: 'Fjern filteret Dokumenttype: Årsrapport' }),
    ).toBeTruthy();
  });

  it('names the field when the API refuses a filter the dataset does not declare', async () => {
    const { fetch } = answering(
      (url) => url.includes('filters='),
      () =>
        problem(422, {
          errors: [{ path: 'filters.type', message: 'The dataset has no filter type' }],
        }),
    );
    await renderLive(
      `#/datasets/${encodeURIComponent('digdir/kudos')}?filter.type=Årsrapport`,
      fetch,
    );
    expect((await screen.findByRole('alert')).textContent).toContain(
      'Dokumentsamlingen kan ikke filtreres på «type».',
    );
  });

  it('says no document matches and resets from there', async () => {
    const { fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    await docsTable();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i titler' }), {
      target: { value: 'finnes-ikke' },
    });
    expect(
      await screen.findByRole('heading', { name: 'Ingen dokumenter passer søket og filteret' }),
    ).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Neste' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill alt' }));
    expect(await docsTable()).toBeTruthy();
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
    expect(await docsTable()).toBeTruthy();
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
    expect(screen.getByRole('link', { name: 'Se innlesinger' }).getAttribute('href')).toBe(
      `#/datasets/${encodeURIComponent('999888777/veiledere')}/ingestions`,
    );
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
      screen.getByText('Filen har ikke tekst vi kan lese, for eksempel et skannet dokument.'),
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
    await screen.findByRole('heading', { level: 1, name: 'Ny dokumentsamling' });
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
    fireEvent.click(screen.getByRole('button', { name: 'Lag dokumentsamlingen og les inn' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Lag dokumentsamlingen og les inn' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Lag dokumentsamlingen og les inn' }));
    expect(await screen.findByText(/Vi kaller ikke denne adressen/)).toBeTruthy();
  });

  it.each([
    [409, 'Det finnes allerede en tilkobling eller en nøkkel for denne dokumentsamlingen.'],
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
    fireEvent.click(screen.getByRole('button', { name: 'Lag dokumentsamlingen og les inn' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Lag dokumentsamlingen og les inn' }));
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
    const table = await screen.findByRole('table', { name: 'Dokumentsamlinger' });
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
    const lead = document.querySelector('.page-head .meta')?.textContent ?? '';
    expect(lead).toBe('Delt med dere av en annen virksomhet · 40 dokumenter i søkemotoren');
    expect(screen.queryByRole('button', { name: 'Les inn på nytt' })).toBeNull();
  });
});

describe('dataset header and tabs', () => {
  it('keeps the back link and the tab row while the dataset loads', async () => {
    const fetch: typeof globalThis.fetch = () => new Promise<Response>(() => undefined);
    renderDetail(fetch, ['manage-datasets']);
    expect(screen.getByRole('link', { name: 'Dokumentsamlinger' })).toBeTruthy();
    expect(
      within(screen.getByRole('tablist', { name: 'Dokumentsamlingen' }))
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Innhold', 'Innlesinger', 'Innstillinger', 'Brukes av']);
  });

  it('orders the tabs Innhold, Innlesinger, Innstillinger, Brukes av', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    const tabs = await screen.findByRole('tablist', { name: 'Dokumentsamlingen' });
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent),
    ).toEqual(['Innhold', 'Innlesinger', 'Innstillinger', 'Brukes av']);
  });

  it('shows the dataset description under the title', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    const head = document.querySelector('.page-head') as HTMLElement;
    expect(
      within(head).getByText('Veiledere og rundskriv lastet opp av fagavdelingen.'),
    ).toBeTruthy();
  });
});

describe('dataset documents, design details', () => {
  it('lists all statuses by default and offers Alle in the status filter', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    const table = await docsTable();
    expect(screen.getByRole('combobox', { name: 'Status' })).toHaveProperty('value', 'all');
    expect(within(table).getByRole('button', { name: 'Skannet vedtak 2019.pdf' })).toBeTruthy();
    expect(within(table).getByRole('button', { name: 'Rundskriv 3-2026' })).toBeTruthy();
  });

  it('says how many documents match without the filter, and removes it from the no-match state', async () => {
    const { fetch } = searchable();
    await renderLive(`${veiledere}/content?status=failed&q=Dokument 00`, fetch);
    expect(
      await screen.findByText(
        'Uten filteret Status: Feilet er det 9 dokumenter som passer «Dokument 00».',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fjern filteret Status' }));
    expect(await screen.findByRole('button', { name: 'Dokument 001' })).toBeTruthy();
  });

  it('lets a keyboard user scroll the documents table', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    await docsTable();
    expect(screen.getByRole('region', { name: 'Dokumenttabell' }).tabIndex).toBe(0);
  });

  it('puts the open document in the address and opens it from there', async () => {
    const { fetch } = recorded();
    await renderLive(veiledere, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Rundskriv 3-2026' }));
    await screen.findByRole('dialog', { name: 'Rundskriv 3-2026' });
    const address = window.location.hash;
    expect(address).toContain('doc=');
    cleanup();
    await renderLive(address, fetch);
    expect(await screen.findByRole('dialog', { name: 'Rundskriv 3-2026' })).toBeTruthy();
  });

  it('shows the start of the text without markdown marks', async () => {
    const { fetch } = recorded({
      documents: {
        '999888777/veiledere': [
          {
            id: 'tabell',
            title: 'Budsjett',
            fields: {},
            status: 'indexed',
            excerpt: '# Budsjett 2026\n\n| Post | Beløp |\n|---|---|\n| Drift | 100 |',
          },
        ],
      },
    });
    await renderLive(veiledere, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Budsjett' }));
    const panel = await screen.findByRole('dialog', { name: 'Budsjett' });
    expect(await within(panel).findByText('Budsjett 2026')).toBeTruthy();
    expect(within(panel).getByText(/Drift · 100/, { selector: 'p' })).toBeTruthy();
    expect(panel.textContent).not.toMatch(/#|\|/);
  });

  it('asks for every filter of a dataset in one facets call', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    await docsTable();
    await screen.findByRole('combobox', { name: 'Dokumenttype' });
    expect(calls.filter((c) => c.url.includes('/facets?'))).toHaveLength(1);
  });

  it('labels the Kudos filters in words, never by their raw field names', () => {
    const t = translator('nb');
    expect(['owner_orgnr', 'doc_num', 'concerned_years'].map((f) => facetLabel(t, f))).toEqual([
      'Eier (org.nr.)',
      'Dokumentnummer',
      'Gjelder år',
    ]);
    expect(facetLabel(t, 'case_handler')).toBe('Case handler');
  });
});

describe('dataset list toolbar', () => {
  it('shows the filters as pressed buttons and the search with a placeholder', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets', fetch);
    await screen.findByRole('table', { name: 'Dokumentsamlinger' });
    expect(screen.getByRole('button', { name: 'Alle', pressed: true })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Testetatens egne' }));
    expect(screen.getByRole('button', { name: 'Testetatens egne', pressed: true })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Søk i dokumentsamlinger' })).toHaveProperty(
      'placeholder',
      'Søk i navn og kildetype',
    );
  });
});

describe('deleting an endpoint dataset', () => {
  it('says the connection to the endpoint goes with it, before and after', async () => {
    const { calls, fetch } = recorded({ datasets: [...exampleLiveDatasets, endpointDataset] });
    await renderLive(`#/datasets/${encodeURIComponent('999888777/saksarkivet')}/source`, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Slett dokumentsamlingen' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(
      'Tilkoblingen til endepunktet og API-nøkkelen slettes også.',
    );
    fireEvent.change(
      within(dialog).getByLabelText('Skriv navnet på dokumentsamlingen for å bekrefte'),
      {
        target: { value: 'Saksarkivet' },
      },
    );
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Trengs ikke lenger' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Slett dokumentsamlingen' }));
    expect(await screen.findByText(/Tilkoblingen endpoint-saksarkivet er fjernet\./)).toBeTruthy();
    expect(writes(calls)).toEqual(['DELETE /tenants/999888777/datasets/saksarkivet']);
  });
});
