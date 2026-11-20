// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { createApiClient } from '../api';
import { RightsProvider } from '../Shell';
import { LiveDatasetDetail, pollMs } from './datasets/LiveDatasetDetail';
import { mockAnsattporten } from '../auth';
import { exampleOrganisations, mockFetch, type FeatureMockOptions } from '../mock';
import { exampleLiveDatasets } from '../mock/datasets';
import { exampleEndpoints } from '../mock/search-engines';
import { expectAccessible } from '../test-utils';

document.getAnimations ??= () => [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

interface Call {
  url: string;
  method: string;
  body: unknown;
  reason: string | null;
}

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const recorded = (
  datasets: FeatureMockOptions['datasets'] = {},
  override?: (url: string, method: string) => Response | undefined,
) => {
  const calls: Call[] = [];
  const base = mockFetch(undefined, undefined, undefined, undefined, { features: { datasets } });
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = urlOf(input);
    const method = init?.method ?? 'GET';
    const raw = init?.body;
    const body =
      raw instanceof FormData
        ? (raw.getAll('files') as File[]).map((f) => f.name)
        : raw
          ? (JSON.parse(String(raw)) as unknown)
          : undefined;
    const reason = new Headers(init?.headers).get('change-reason');
    calls.push({ url, method, body, reason: reason && decodeURIComponent(reason) });
    return override?.(url, method) ?? base(input, init);
  };
  return { calls, fetch };
};

const renderLive = async (path: string, fetch: typeof globalThis.fetch) => {
  const auth = mockAnsattporten({ name: 'Ingrid Berg', organisations: exampleOrganisations });
  await auth.login();
  window.location.hash = path;
  return render(<App auth={auth} fetch={fetch} live />);
};

const veiledere = `#/datasets/${encodeURIComponent('999888777/veiledere')}`;
const nettsider = `#/datasets/${encodeURIComponent('999888777/nettsider')}`;

describe('live datasets list', () => {
  it('reads the tenant dataset API for source, documents and last ingestion', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets', fetch);
    const list = await screen.findByRole('table', { name: 'Datasett' });
    expect(calls.some((c) => c.url.endsWith('/tenants/999888777/datasets'))).toBe(true);
    expect(calls.some((c) => /\/api\/datasets(\/|$)/.test(c.url))).toBe(false);
    const row = within(list).getByRole('link', { name: 'Veiledere og rundskriv' }).closest('tr');
    expect(within(row as HTMLElement).getByText('Opplastede filer · Egne')).toBeTruthy();
    expect(within(row as HTMLElement).getByText('6')).toBeTruthy();
    expect(screen.queryByText('Ukjent kilde')).toBeNull();
    expect(within(list).getByRole('link', { name: 'Kudos-rapporter' }).getAttribute('href')).toBe(
      `#/datasets/${encodeURIComponent('digdir/kudos')}`,
    );
    expect(screen.getByRole('button', { name: /Nytt datasett/ })).toBeTruthy();
  });
});

describe('live new dataset', () => {
  it('creates a website dataset, its pipeline and runs it, then shows the result', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    expect(await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' })).toBeTruthy();
    expect(screen.queryByText(/kan ikke legges til fra portalen/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Nettsted/ }));
    fireEvent.change(screen.getByLabelText('Navn'), {
      target: { value: 'Nettsidene våre' },
    });
    fireEvent.change(screen.getByLabelText('Adresse til nettstedskartet', { exact: false }), {
      target: { value: 'https://testetaten.example.no/sitemap.xml' },
    });
    fireEvent.change(screen.getByLabelText('Utelat disse stiene'), {
      target: { value: '/sok\n/logg-inn' },
    });
    fireEvent.click(screen.getByRole('radio', { name: 'Hver uke' }));
    const storage = screen.getByRole('region', { name: 'Hvor dataene lagres' });
    await within(storage).findByText(/Innebygd søk \(Postgres med pgvector\), i Norge/);
    expect(storage.textContent).toContain(
      'text-embedding-3-small, som kjører globalt, også utenfor EU/EØS',
    );
    expect(storage.textContent).toContain(
      'bare brukes av tjenester som tillater global behandling',
    );
    expect(storage.textContent).not.toContain('EU/EØS eller strengere');
    expect(storage.textContent).not.toMatch(/[{}]|platform-pg/);
    expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    expect(screen.getByRole('link', { name: /begrunnelse på minst 10 tegn/ })).toBeTruthy();
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Nettsidene skal kunne søkes i' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));

    expect(await screen.findByRole('heading', { level: 1, name: 'Nettsidene våre' })).toBeTruthy();
    expect(window.location.hash).toBe(
      `#/datasets/${encodeURIComponent('999888777/nettsidene-vare')}`,
    );
    const writes = calls.filter((c) => c.method !== 'GET');
    expect(writes.map((c) => `${c.method} ${c.url.replace(/^\/api/, '')}`)).toEqual([
      'PUT /tenants/999888777/catalog/dataset/nettsidene-vare',
      'POST /tenants/999888777/datasets/nettsidene-vare/pipelines',
      'POST /tenants/999888777/datasets/nettsidene-vare/pipelines/website/execute',
    ]);
    expect(writes.every((c) => c.reason === 'Nettsidene skal kunne søkes i')).toBe(true);
    expect(writes[0]?.body).toEqual({
      name: 'Nettsidene våre',
      endpoint: 'platform-pg',
      residency: 'global',
      searchScope: 'tenant',
      embedding: { model: 'foundry/text-embedding-3-small', dimensions: 1536 },
    });
    expect(writes[1]?.body).toEqual({
      id: 'website',
      name: 'Nettsidene våre',
      source: {
        kind: 'website',
        sitemap: 'https://testetaten.example.no/sitemap.xml',
        include: [],
        exclude: ['/sok', '/sok/**', '/logg-inn', '/logg-inn/**'],
      },
      schedule: 'weekly',
    });

    const result = await screen.findByRole('heading', { name: 'Innlesingen er ferdig' });
    const alert = result.closest('.ds-alert') as HTMLElement;
    expect(alert.textContent).toContain('6 dokumenter er lest inn. 1 ble hoppet over:');
    expect(
      within(alert).getByText(
        'Filen har ikke tekst vi kan lese, for eksempel et skannet dokument.',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/ · 6 dokumenter i søkemotoren$/)).toBeTruthy();
  });

  it('uploads the chosen files before the first ingestion and leaves out unreadable ones', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' });
    fireEvent.click(screen.getByRole('radio', { name: /Last opp filer/ }));
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Høring' } });
    expect(
      (screen.getByRole('radio', { name: 'Bare når jeg ber om det' }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(screen.queryByRole('button', { name: 'Bruk eksempelfiler' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Velg filer'), {
      target: {
        files: [
          new File(['tekst'], 'Svar.pdf', { type: 'application/pdf' }),
          new File(['x'], 'Notat.pages'),
        ],
      },
    });
    const chosen = screen.getByRole('list', { name: 'Valgte filer' });
    expect(within(chosen).getByText('Kan ikke leses')).toBeTruthy();
    expect(within(chosen).getByText(/Filtypen støttes ikke/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Høringssvarene skal kunne søkes i' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    await screen.findByRole('heading', { level: 1, name: 'Høring' });
    const upload = calls.find((c) => c.url.endsWith('/datasets/horing/uploads'));
    expect(upload?.method).toBe('POST');
    expect(upload?.body).toEqual(['Svar.pdf']);
    const pipeline = calls.find((c) => c.method === 'POST' && c.url.endsWith('/pipelines'));
    expect(pipeline?.body).toMatchObject({
      id: 'upload',
      source: { kind: 'upload' },
      schedule: 'none',
    });
    expect(
      await screen.findByText(/1 dokumenter er lest inn\. Ingen ble hoppet over\./),
    ).toBeTruthy();
  });

  it('explains a refused Kudos pipeline and keeps the dataset id when trying again', async () => {
    let refuse = true;
    const { calls, fetch } = recorded({}, (url, method) =>
      refuse && method === 'POST' && url.endsWith('/pipelines')
        ? Response.json(
            {
              title: 'Invalid pipeline',
              status: 422,
              errors: [{ path: 'spec.source', message: 'Kudos needs document types or a year.' }],
            },
            { status: 422 },
          )
        : undefined,
    );
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' });
    fireEvent.click(screen.getByRole('radio', { name: /Kudos/ }));
    fireEvent.change(screen.getByLabelText('Navn'), {
      target: { value: 'Evalueringer' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Evaluering' }));
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Evalueringene skal brukes i rapportassistenten' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    expect(
      await screen.findByText(/må avgrenses med dokumenttyper eller en startdato/),
    ).toBeTruthy();
    expect(screen.queryByText(/needs document types/)).toBeNull();
    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    await screen.findByRole('heading', { level: 1, name: 'Evalueringer' });
    expect(calls.filter((c) => c.url.includes('/catalog/dataset/'))).toHaveLength(1);
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pipelines')).at(-1)?.body,
    ).toMatchObject({
      source: { kind: 'kudos', types: ['Evaluering'], since: '2020-01-01' },
      schedule: 'daily',
    });
  });

  it('refuses a name another dataset already has', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' });
    fireEvent.change(screen.getByLabelText('Navn'), {
      target: { value: 'nettsidene til testetaten' },
    });
    fireEvent.change(screen.getByLabelText('Adresse til nettstedskartet', { exact: false }), {
      target: { value: 'https://testetaten.example.no/sitemap.xml' },
    });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Nettsidene skal kunne søkes i' },
    });
    await waitFor(() =>
      expect(
        screen
          .getByRole('button', { name: 'Lag datasettet og les inn' })
          .getAttribute('aria-disabled'),
      ).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    expect(
      screen.getByRole('link', {
        name: 'Det finnes allerede et datasett som heter «nettsidene til testetaten». Velg et annet navn.',
      }),
    ).toBeTruthy();
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('offers only document types that exist in Kudos', async () => {
    const { fetch } = recorded({});
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' });
    fireEvent.click(screen.getByRole('radio', { name: /Kudos/ }));

    expect(screen.getByRole('checkbox', { name: 'Statusrapport' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Utredning' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Veileder' })).toBeNull();
  });

  const reviewWebsite = async (fetch: typeof globalThis.fetch) => {
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' });
    fireEvent.click(screen.getByRole('radio', { name: /Nettsted/ }));
    fireEvent.change(screen.getByLabelText('Navn'), { target: { value: 'Sider' } });
    fireEvent.change(screen.getByLabelText('Adresse til nettstedskartet', { exact: false }), {
      target: { value: 'https://testetaten.example.no/sitemap.xml' },
    });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Nettsidene skal kunne søkes i' },
    });
  };

  it('takes the embedding model and its residency from the API, not a fixed value', async () => {
    const endpoints = (body: unknown) => (url: string, method: string) =>
      method === 'GET' && url.endsWith('/knowledge/endpoints') ? Response.json(body) : undefined;
    const { calls, fetch } = recorded(
      {},
      endpoints({
        data: exampleEndpoints,
        defaultEmbedding: { model: 'tenant/norsk-embed', dimensions: 768, residency: 'norway' },
      }),
    );
    await reviewWebsite(fetch);
    const storage = screen.getByRole('region', { name: 'Hvor dataene lagres' });
    await within(storage).findByText(/norsk-embed, som kjører i Norge/);
    expect(storage.textContent).toContain('kan brukes av alle tjenester');
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    await screen.findByRole('heading', { level: 1, name: 'Sider' });
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      residency: 'norway',
      embedding: { model: 'tenant/norsk-embed', dimensions: 768 },
    });
  });

  it('says so and sends no embedding when the platform has no embedding model', async () => {
    const { calls, fetch } = recorded({}, (url, method) =>
      method === 'GET' && url.endsWith('/knowledge/endpoints')
        ? Response.json({ data: exampleEndpoints, defaultEmbedding: null })
        : undefined,
    );
    await reviewWebsite(fetch);
    const storage = screen.getByRole('region', { name: 'Hvor dataene lagres' });
    await within(storage).findByText(/ingen vektormodell satt opp/);
    expect(storage.textContent).not.toMatch(/EU\/EØS eller|text-embedding/);
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    await screen.findByRole('heading', { level: 1, name: 'Sider' });
    const created = calls.find((c) => c.method === 'PUT')?.body as Record<string, unknown>;
    expect(created.embedding).toBeUndefined();
    expect(created.residency).toBe('global');
  });

  it('leads here from Kom i gang and marks the step done once there is a dataset', async () => {
    const services = mockFetch([]);
    const empty = recorded({ datasets: [] });
    const fresh: typeof fetch = (input, init) =>
      /\/overview$/.test(urlOf(input)) ? services(input, init) : empty.fetch(input, init);
    await renderLive('#/overview', fresh);
    const start = await screen.findByRole('region', { name: 'Kom i gang med Testetaten' });
    expect(
      (await within(start).findByRole('link', { name: 'Nytt datasett' })).getAttribute('href'),
    ).toBe('#/datasets/new');
    cleanup();

    const withData = recorded();
    const later: typeof fetch = (input, init) =>
      /\/overview$/.test(urlOf(input)) ? services(input, init) : withData.fetch(input, init);
    await renderLive('#/overview', later);
    const done = await screen.findByRole('region', { name: 'Kom i gang med Testetaten' });
    await within(done).findByRole('heading', { name: /1. Legg til en kilde \(gjort\)/ });
    expect(within(done).queryByRole('link', { name: 'Nytt datasett' })).toBeNull();
  });
});

describe('live dataset detail', () => {
  it('shows real facts and executions with skipped documents in Norwegian', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    expect(
      screen.getByText(/^Opplastede filer · Siste innlesing .+ · 6 dokumenter i søkemotoren$/),
    ).toBeTruthy();
    const runs = await screen.findByRole('list', { name: 'Innlesinger' });
    expect(within(runs).getByText('6 lest inn')).toBeTruthy();
    expect(within(runs).getByText('2 hoppet over')).toBeTruthy();
    fireEvent.click(within(runs).getByRole('button', { expanded: false }));
    const skipped = within(runs).getByRole('table', { name: 'Hoppet over' });
    expect(within(runs).getByRole('heading', { name: '2 filer kunne ikke leses' })).toBeTruthy();
    expect(
      within(skipped).getByRole('row', {
        name: 'Skannet vedtak 2019.pdf Filen har ikke tekst vi kan lese, for eksempel et skannet dokument.',
      }),
    ).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/api/datasets'))).toBe(false);
    expect(screen.queryByText('Ukjent kilde')).toBeNull();
    expectAccessible();
  });

  it('the portal says a document was skipped because its file could not be fetched', async () => {
    const { fetch } = recorded({
      executions: {
        '999888777/veiledere/upload': [
          {
            id: 'ex-veiledere-1',
            status: 'succeeded',
            startedAt: '2026-10-07T09:12:00Z',
            endedAt: '2026-10-07T09:13:10Z',
            report: {
              stored: 6,
              skipped: 1,
              skippedDocuments: [{ document: 'Årsrapport 2019', reason: 'unreachable' }],
              failed: [],
            },
          },
        ],
      },
    });
    await renderLive(`${veiledere}/ingestions`, fetch);
    const runs = await screen.findByRole('list', { name: 'Innlesinger' });
    fireEvent.click(within(runs).getByRole('button', { expanded: false }));
    const skipped = within(runs).getByRole('table', { name: 'Hoppet over' });

    expect(within(skipped).getByText('Filen kunne ikke hentes fra kilden.')).toBeTruthy();
  });

  it('says "Ikke oppgitt" when the API gives no effective residency', async () => {
    const { fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Kudos-rapporter' });
    fireEvent.click(screen.getByRole('tab', { name: 'Innstillinger' }));
    fireEvent.click(screen.getByText('Teknisk'));
    expect(screen.getByText('Data behandles').nextElementSibling?.textContent).toBe('Ikke oppgitt');
  });

  it('runs "Les inn på nytt" against the pipeline and polls until it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls, fetch } = recorded({ pollsUntilDone: 3 });
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    fireEvent.click(screen.getByRole('button', { name: 'Les inn på nytt' }));
    expect(await screen.findByText(/Innlesingen pågår\. Siden oppdateres/)).toBeTruthy();
    const execute = calls.find((c) => c.url.endsWith('/pipelines/upload/execute'));
    expect(execute?.method).toBe('POST');
    expect(execute?.reason).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Les inn på nytt' }).getAttribute('aria-disabled'),
    ).toBe('true');
    // act() holds React updates until it ends, so each poll gets its own act to re-arm the next.
    for (let poll = 0; poll < 3; poll += 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(pollMs);
      });
    expect(await screen.findByRole('heading', { name: 'Innlesingen er ferdig' })).toBeTruthy();
    expect(screen.queryByText(/Innlesingen pågår\. Siden oppdateres/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Vis API-kall' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Prøv' })).toBeNull();
  });

  it('asks before it cancels a running ingestion, then cancels it with a reason', async () => {
    const { calls, fetch } = recorded({ pollsUntilDone: 100 });
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    expect(screen.queryByRole('button', { name: 'Avbryt innlesingen' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Les inn på nytt' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Avbryt innlesingen' }));
    const dialog = screen.getByRole('dialog', { name: 'Avbryte innlesingen?' });
    expect(within(dialog).getByText(/blir ikke tatt i bruk/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fortsett innlesingen' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => /\/cancel$/.test(c.url))).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt innlesingen' }));
    fireEvent.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Avbryt innlesingen' }),
    );

    expect(await screen.findByText('Innlesingen er avbrutt.')).toBeTruthy();
    const cancel = calls.find((c) => /\/executions\/[^/]+\/cancel$/.test(c.url));
    expect(cancel?.method).toBe('POST');
    expect(cancel?.reason).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Innlesinger' })).getByText('Avbrutt'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Avbryt innlesingen' })).toBeNull();
  });

  it("the portal shows when a running run's admission runs out, and admits it again with a reason", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T05:00:00Z'), shouldAdvanceTime: true });
    let runsOut = '2026-11-15T07:56:00Z';
    const running = () => ({
      id: 'r1',
      status: 'running',
      startedAt: '2026-11-14T07:56:00Z',
      admittedAt: runsOut,
      admissionRunsOutAt: runsOut,
    });
    const json = (body: unknown) =>
      new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const { calls, fetch } = recorded({}, (url, method) => {
      if (method === 'GET' && url.endsWith('/pipelines/upload/executions'))
        return json({ data: [running()], nextRunAt: null });
      if (method === 'POST' && url.endsWith('/pipelines/upload/executions/r1/readmit')) {
        runsOut = '2026-11-16T05:00:00Z';
        return json(running());
      }
      return undefined;
    });
    await renderLive(`${veiledere}/ingestions`, fetch);
    const warned = await screen.findByText(/sluppet inn bare til 15\. november 2026 kl\. 08:56/);
    expect(warned.closest('[data-color="warning"]')).not.toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Slipp inn igjen' }));

    expect(await screen.findByText(/sluppet inn til 16\. november 2026 kl\. 06:00/)).toBeTruthy();
    const readmit = calls.find((c) => c.url.endsWith('/executions/r1/readmit'));
    expect(readmit?.method).toBe('POST');
    expect(readmit?.reason).toBeTruthy();
  });

  /** Open runs as the API lists them, newest start first, with how readmits answer. */
  const openRuns = (runs: Record<string, unknown>[], readmit?: () => Response) => {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    return recorded({}, (url, method) => {
      if (method === 'GET' && url.endsWith('/pipelines/upload/executions'))
        return json({ data: runs, nextRunAt: null });
      if (method === 'POST' && url.endsWith('/readmit'))
        return readmit?.() ?? json(runs.find((r) => url.includes(`/${String(r.id)}/`)));
      return undefined;
    });
  };
  const queued = {
    id: 'q1',
    status: 'queued',
    startedAt: '2026-11-15T04:00:00Z',
    admissionRunsOutAt: '2026-11-16T04:00:00Z',
  };
  const runningSoon = {
    id: 'r1',
    status: 'running',
    startedAt: '2026-11-14T07:56:00Z',
    admissionRunsOutAt: '2026-11-15T07:56:00Z',
  };

  it('the portal shows the open run whose admission runs out first, whichever the list shows first', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T05:00:00Z'), shouldAdvanceTime: true });
    const { calls, fetch } = openRuns([queued, runningSoon]);
    await renderLive(`${veiledere}/ingestions`, fetch);

    expect(
      await screen.findByText(/sluppet inn bare til 15\. november 2026 kl\. 08:56/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Slipp inn igjen' }));
    await waitFor(() =>
      expect(calls.some((c) => c.url.endsWith('/executions/r1/readmit'))).toBe(true),
    );
  });

  it('a refused readmit says why, with the detail from the platform', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T05:00:00Z'), shouldAdvanceTime: true });
    const { fetch } = openRuns(
      [runningSoon],
      () =>
        new Response(
          JSON.stringify({
            type: 'urn:genai:problem:locked-environment',
            title: 'Innlesing er låst i dette miljøet',
            detail: 'Bare innlogginger fra Entra ID kan lese inn i det låste miljøet.',
            status: 403,
          }),
          { status: 403, headers: { 'content-type': 'application/problem+json' } },
        ),
    );
    await renderLive(`${veiledere}/ingestions`, fetch);
    fireEvent.click(await screen.findByRole('button', { name: 'Slipp inn igjen' }));

    expect(
      await screen.findByText(
        /Innlesingen kunne ikke slippes inn igjen\..*Bare innlogginger fra Entra ID kan lese inn/,
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Vi fikk ikke startet innlesingen/)).toBeNull();
  });

  it('the portal offers Admit again only with the dataset right', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T05:00:00Z'), shouldAdvanceTime: true });
    const { fetch } = openRuns([runningSoon]);
    const api = createApiClient({ baseUrl: '/api', fetch, token: () => 'ingrid' });
    render(
      <RightsProvider value={['use-services']}>
        <LiveDatasetDetail
          api={api}
          tenant="999888777"
          tenantName="Testdepartementet"
          id="999888777/veiledere"
          tab="ingestions"
        />
      </RightsProvider>,
    );

    expect(
      await screen.findByText(/sluppet inn bare til 15\. november 2026 kl\. 08:56/),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Slipp inn igjen' })).toBeNull();
  });

  it('shows the refusal text when a second ingestion is started for the same dataset', async () => {
    const { fetch } = recorded({}, (url, method) =>
      method === 'POST' && url.endsWith('/pipelines/upload/execute')
        ? Response.json(
            {
              title: 'Conflict',
              status: 409,
              errors: [
                {
                  path: 'dataset',
                  message:
                    'the dataset veiledere is already being ingested by run ex-1; wait for it to finish or cancel it',
                },
              ],
            },
            { status: 409 },
          )
        : undefined,
    );
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    fireEvent.click(screen.getByRole('button', { name: 'Les inn på nytt' }));

    expect(await screen.findByText(/Datasettet leses allerede inn/)).toBeTruthy();
    expect(screen.queryByText(/already being ingested/)).toBeNull();
    expect(screen.queryByText(/skrivenøkkel/)).toBeNull();
  });

  it('saves source and schedule through the pipeline API and only then says saved', async () => {
    let fail = true;
    const { calls, fetch } = recorded({}, (url, method) =>
      fail && method === 'PUT' && url.endsWith('/pipelines/website')
        ? Response.json({ title: 'Conflict', status: 409, errors: [] }, { status: 409 })
        : undefined,
    );
    await renderLive(`${nettsider}?tab=source`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nettsidene til Testetaten' });
    const about = await screen.findByRole('region', { name: 'Om datasettet' });
    expect((within(about).getByLabelText('Utelat disse stiene') as HTMLTextAreaElement).value).toBe(
      '/sok',
    );
    expect(screen.queryByRole('switch', { name: /Tekstgjenkjenning/ })).toBeNull();
    fireEvent.click(await screen.findByRole('radio', { name: 'Hver uke' }));
    const bar = screen.getByRole('region', { name: 'Du har endringer som ikke er lagret' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.change(within(bar).getByLabelText('Begrunnelse'), {
      target: { value: 'Holder med en gang i uken' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));
    expect(await within(bar).findByText(/Endringene ble ikke lagret/)).toBeTruthy();
    expect(screen.queryByText(/Lagret kl\./)).toBeNull();

    fail = false;
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));
    expect(
      await screen.findByText(/Lagret kl\. .+\. Endringen står i Logg, Endringer\./),
    ).toBeTruthy();
    const put = calls.filter((c) => c.method === 'PUT').at(-1);
    expect(put?.url).toMatch(/\/datasets\/nettsider\/pipelines\/website$/);
    expect(put?.body).toMatchObject({
      schedule: 'weekly',
      source: { kind: 'website', exclude: ['/sok', '/sok/**'] },
    });
    expect(put?.reason).toBe('Holder med en gang i uken');
  });

  it('keeps the unsaved changes bar until the changes are saved or discarded', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${nettsider}?tab=source`, fetch);
    const about = await screen.findByRole('region', { name: 'Om datasettet' });
    const name = within(about).getByLabelText('Navn') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Nettsidene våre' } });
    const bar = screen.getByRole('region', { name: 'Du har endringer som ikke er lagret' });
    fireEvent.click(screen.getByRole('tab', { name: 'Innstillinger' }));
    expect(screen.getByRole('region', { name: 'Du har endringer som ikke er lagret' })).toBe(bar);
    fireEvent.click(within(bar).getByRole('button', { name: 'Forkast' }));

    expect(
      screen.queryByRole('region', { name: 'Du har endringer som ikke er lagret' }),
    ).toBeNull();
    expect(name.value).toBe('Nettsidene til Testetaten');
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
  });

  it('asks before leaving the settings with unsaved changes', async () => {
    const { fetch } = recorded();
    await renderLive(`${nettsider}?tab=source`, fetch);
    const about = await screen.findByRole('region', { name: 'Om datasettet' });
    const name = within(about).getByLabelText('Navn') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Nettsidene våre' } });

    fireEvent.click(screen.getByRole('tab', { name: 'Innlesinger' }));
    const ask = screen.getByRole('dialog', { name: 'Forlate siden uten å lagre?' });
    fireEvent.click(within(ask).getByRole('button', { name: 'Bli på siden' }));
    expect(screen.getByRole('tab', { name: 'Innstillinger' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(name.value).toBe('Nettsidene våre');

    for (const link of screen.getAllByRole('link', { name: 'Datasett' })) {
      fireEvent.click(link);
      expect(window.location.hash).not.toBe('#/datasets');
      fireEvent.click(
        within(screen.getByRole('dialog', { name: 'Forlate siden uten å lagre?' })).getByRole(
          'button',
          { name: 'Bli på siden' },
        ),
      );
    }
    fireEvent.click(screen.getAllByRole('link', { name: 'Datasett' })[0] as HTMLElement);
    expect(window.location.hash).not.toBe('#/datasets');
    fireEvent.click(
      within(screen.getByRole('dialog', { name: 'Forlate siden uten å lagre?' })).getByRole(
        'button',
        { name: 'Forlat uten å lagre' },
      ),
    );
    await waitFor(() => expect(window.location.hash).toBe('#/datasets'));
  });

  it('saving a Kudos dataset without a start date leaves its source without one', async () => {
    const own = exampleLiveDatasets.find((d) => d.id === 'nettsider');
    if (!own) throw new Error('the example datasets changed');
    const evalueringer = {
      ...own,
      id: 'evalueringer',
      fullId: '999888777/evalueringer',
      name: 'Evalueringer',
      source: 'kudos' as const,
    };
    const { calls, fetch } = recorded({
      datasets: [evalueringer],
      pipelines: {
        '999888777/evalueringer': [
          {
            id: 'kudos',
            version: 1,
            spec: {
              name: 'Evalueringer',
              source: { kind: 'kudos', types: ['Evaluering'] },
              schedule: 'none',
            },
          },
        ],
      },
    });
    await renderLive(
      `#/datasets/${encodeURIComponent('999888777/evalueringer')}?tab=source`,
      fetch,
    );
    // The form mounts again once the pipeline has loaded.
    fireEvent.click(await screen.findByRole('radio', { name: 'Hver uke' }));
    const bar = screen.getByRole('region', { name: 'Du har endringer som ikke er lagret' });
    fireEvent.change(within(bar).getByLabelText('Begrunnelse'), {
      target: { value: 'Holder med en gang i uken' },
    });
    fireEvent.click(within(bar).getByRole('button', { name: 'Lagre endringene' }));
    expect(await screen.findByText(/Lagret kl\./)).toBeTruthy();

    const put = calls.filter((c) => c.method === 'PUT').at(-1);
    expect(put?.body).toMatchObject({ schedule: 'weekly', source: { kind: 'kudos' } });
    expect((put?.body as { source: Record<string, unknown> }).source).not.toHaveProperty('since');
  });

  it('uploads dropped files one by one with a result per file, and deletes a file', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}?tab=source`, fetch);
    const files = await screen.findByRole('list', { name: 'Opplastede filer' });
    expect(within(files).getAllByRole('listitem')).toHaveLength(2);
    const zone = screen.getByLabelText('Last opp filer').closest('.drop-zone') as HTMLElement;
    fireEvent.drop(zone, {
      dataTransfer: {
        files: [
          new File(['a'], 'Ny veileder.pdf'),
          new File(['b'], 'Bilde.png'),
          new File(['c'], 'Rundskriv 4.docx'),
        ],
      },
    });
    const progress = screen.getByRole('list', { name: 'Opplastinger' });
    expect(within(progress).getByText('Bilde.png').closest('li')?.textContent).toContain(
      'Ikke lastet opp',
    );
    await waitFor(() => expect(within(progress).getAllByText('Lastet opp')).toHaveLength(2));
    expect(calls.filter((c) => c.url.endsWith('/uploads') && c.method === 'POST')).toHaveLength(2);
    await waitFor(() =>
      expect(
        within(screen.getByRole('list', { name: 'Opplastede filer' })).getAllByRole('listitem'),
      ).toHaveLength(4),
    );
    expect(screen.getByText(/Filene er lastet opp\. Trykk «Les inn på nytt»/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Slett Rundskriv 3-2026.pdf' }));
    expect(await screen.findByText(/Rundskriv 3-2026\.pdf er slettet/)).toBeTruthy();
    const removed = calls.find((c) => c.method === 'DELETE');
    expect(removed?.url).toMatch(/\/uploads\/Rundskriv%203-2026\.pdf$/);
    expect(removed?.reason).toBeTruthy();
    expectAccessible();
  });

  it('shows a shared dataset read only and without filter switches that save nothing', async () => {
    const { fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}?tab=filters`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Kudos-rapporter' });
    expect(screen.queryByRole('button', { name: 'Les inn på nytt' })).toBeNull();
    expect(screen.getByText(/^Kudos, delt med dere · /)).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Kan brukes som filter' })).toBeNull();
    const type = await screen.findByRole('combobox', { name: 'Dokumenttype' });
    await waitFor(() =>
      expect(within(type).getByRole('option', { name: /^Årsrapport \(/ })).toBeTruthy(),
    );
  });
});

describe('deleting a live dataset', () => {
  it('asks for the dataset name and a reason before deleting, and says what stays', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}?tab=source`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    const card = await screen.findByRole('region', { name: 'Slett datasettet' });
    fireEvent.click(within(card).getByRole('button', { name: 'Slett datasettet' }));
    const dialog = screen.getByRole('dialog', { name: 'Slette Veiledere og rundskriv?' });
    const confirm = within(dialog).getByRole('button', { name: 'Slett datasettet' });
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Feil modell, lager det på nytt' },
    });
    expect(confirm.getAttribute('aria-disabled')).toBe('true');
    fireEvent.change(within(dialog).getByLabelText('Skriv navnet på datasettet for å bekrefte'), {
      target: { value: 'Veiledere' },
    });
    fireEvent.click(confirm);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    fireEvent.change(within(dialog).getByLabelText('Skriv navnet på datasettet for å bekrefte'), {
      target: { value: 'Veiledere og rundskriv' },
    });
    expect(confirm.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(confirm);

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv er slettet' }),
    ).toBeTruthy();
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([
      expect.objectContaining({
        url: expect.stringMatching(/\/tenants\/999888777\/datasets\/veiledere$/),
        reason: 'Feil modell, lager det på nytt',
      }),
    ]);
    expect(
      screen.getByText(
        'Katalogoppføringen, 1 kilder, 2 opplastede filer og 1 generasjoner i søkemotoren er fjernet.',
      ),
    ).toBeTruthy();
    expect(screen.getByText('Ingenting ble igjen i søkemotoren.')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Datasett' })).toBeTruthy();
  });

  it('asks for a reason before deleting', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}?tab=source`, fetch);
    const card = await screen.findByRole('region', { name: 'Slett datasettet' });
    fireEvent.click(within(card).getByRole('button', { name: 'Slett datasettet' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Skriv navnet på datasettet for å bekrefte'), {
      target: { value: 'Veiledere og rundskriv' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Slett datasettet' }));
    expect(within(dialog).getByText('Skriv en begrunnelse på minst 10 tegn.')).toBeTruthy();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('the delete is disabled while a service reads the dataset', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${nettsider}?tab=source`, fetch);
    const card = await screen.findByRole('region', { name: 'Slett datasettet' });
    expect(
      within(card).getByText(/kan ikke slettes mens tjenester bruker det: Rapportassistenten/),
    ).toBeTruthy();
    const remove = within(card).getByRole('button', { name: 'Slett datasettet' });
    expect(remove.getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(remove);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});

describe('live dataset tabs and polling', () => {
  it('opens a dataset tab from its own address', async () => {
    const { fetch } = recorded();
    await renderLive(`${nettsider}/used-by`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nettsidene til Testetaten' });
    expect(screen.getByRole('tab', { name: 'Brukes av' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('puts the chosen tab in the address', async () => {
    const { fetch } = recorded();
    await renderLive(nettsider, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nettsidene til Testetaten' });
    fireEvent.click(screen.getByRole('tab', { name: 'Brukes av' }));
    await waitFor(() =>
      expect(window.location.hash).toBe(
        `#/datasets/${encodeURIComponent('999888777/nettsider')}/used-by`,
      ),
    );
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Brukes av' }).getAttribute('aria-selected')).toBe(
        'true',
      ),
    );
  });

  it('opens a dataset on its Innhold tab, as the design does', async () => {
    const { fetch } = recorded();
    await renderLive(nettsider, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nettsidene til Testetaten' });
    expect(screen.getByRole('tab', { name: 'Innhold' }).getAttribute('aria-selected')).toBe('true');
    expect(screen.queryByRole('tab', { name: 'Filtre i søket' })).toBeNull();
  });

  it('opens the old filters address on the Innhold tab', async () => {
    const { fetch } = recorded();
    await renderLive(`${nettsider}/filters`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nettsidene til Testetaten' });
    expect(screen.getByRole('tab', { name: 'Innhold' }).getAttribute('aria-selected')).toBe('true');
  });

  it('opens the tab named by the old tab query', async () => {
    const { fetch } = recorded();
    await renderLive(`${nettsider}?tab=source`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Nettsidene til Testetaten' });
    expect(screen.getByRole('tab', { name: 'Innstillinger' }).getAttribute('aria-selected')).toBe(
      'true',
    );
  });

  it('lists each service that uses the dataset with its status, last run and runs this week', async () => {
    const { fetch } = recorded();
    await renderLive(`${nettsider}/used-by`, fetch);
    expect(
      await screen.findByRole('heading', { level: 2, name: '1 tjeneste bruker datasettet' }),
    ).toBeTruthy();
    const table = screen.getByRole('table', { name: 'Brukes av' });
    const row = within(table)
      .getByRole('link', { name: 'Rapportassistenten' })
      .closest('tr') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Rapportassistenten' }).getAttribute('href')).toBe(
      '#/services/rapportassistenten',
    );
    expect(await within(row).findByText('I bruk')).toBeTruthy();
    const cells = within(row).getAllByRole('cell');
    expect(cells[2]?.textContent).toMatch(/\d/);
    expect(cells[3]?.textContent).toMatch(/^\d+$/);
    expect(screen.getByRole('link', { name: 'Se kjøringene i Logg' }).getAttribute('href')).toBe(
      '#/log?service=rapportassistenten',
    );
    expect(screen.getByRole('link', { name: 'Bruk i en tjeneste til' })).toBeTruthy();
  });

  it('says no service uses a dataset that has no readers', async () => {
    const { fetch } = recorded();
    await renderLive(`${veiledere}/used-by`, fetch);
    expect(
      await screen.findByRole('heading', { name: 'Ingen tjenester bruker datasettet ennå' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Bruk i en tjeneste' }).getAttribute('href')).toBe(
      '#/services',
    );
  });

  it('shows an ingestion list error with retry instead of saying there are no ingestions', async () => {
    let fail = true;
    const { fetch } = recorded({}, (url, method) =>
      fail && method === 'GET' && url.endsWith('/executions')
        ? new Response(JSON.stringify({ title: 'Feil' }), { status: 500 })
        : undefined,
    );
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    expect(await screen.findByText('Kunne ikke hente dataene')).toBeTruthy();
    expect(screen.queryByText('Ingen innlesinger ennå.')).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByRole('list', { name: 'Innlesinger' })).toBeTruthy();
  });

  it('keeps polling a running ingestion after a failed poll', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let failNext = false;
    const { fetch } = recorded({ pollsUntilDone: 2 }, (url, method) => {
      if (failNext && method === 'GET' && url.endsWith('/executions')) {
        failNext = false;
        return new Response(JSON.stringify({ title: 'Feil' }), { status: 503 });
      }
      return undefined;
    });
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    fireEvent.click(screen.getByRole('button', { name: 'Les inn på nytt' }));
    expect(await screen.findByText(/Innlesingen pågår\. Siden oppdateres/)).toBeTruthy();
    failNext = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });
    expect(
      await screen.findByText('Fikk ikke oppdatert innlesingene. Vi prøver igjen av oss selv.'),
    ).toBeTruthy();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });
    expect(await screen.findByRole('heading', { name: 'Innlesingen er ferdig' })).toBeTruthy();
  });

  it('sends the ingestion audit reason in the language the person uses', async () => {
    const { calls, fetch } = recorded();
    await renderLive(`${veiledere}/ingestions`, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    fireEvent.click(screen.getByRole('button', { name: 'Les inn på nytt' }));
    await waitFor(() =>
      expect(calls.find((c) => c.url.endsWith('/execute'))?.reason).toBe(
        'Manuell innlesing fra portalen',
      ),
    );
  });
});

describe('live dataset list', () => {
  it('resets the filter when the address has none', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets', fetch);
    await screen.findByRole('table', { name: 'Datasett' });
    fireEvent.click(screen.getByRole('button', { name: /Trenger oppfølging/ }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i datasett' }), {
      target: { value: 'nett' },
    });
    expect(window.location.hash).toBe('#/datasets?filter=attention&q=nett');
    act(() => {
      window.location.hash = '#/datasets';
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    });
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Alle', pressed: true })).toBeTruthy(),
    );
    expect(screen.getByRole('searchbox', { name: 'Søk i datasett' })).toHaveProperty('value', '');
    expect(screen.getByText('3 datasett')).toBeTruthy();
  });

  it('counts the failed and partly ingested datasets as needing follow-up', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets', fetch);
    await screen.findByRole('table', { name: 'Datasett' });
    fireEvent.click(screen.getByRole('button', { name: 'Trenger oppfølging (2)' }));
    const table = screen.getByRole('table', { name: 'Datasett' });
    expect(within(table).getByRole('link', { name: 'Nettsidene til Testetaten' })).toBeTruthy();
    expect(within(table).getByRole('link', { name: 'Veiledere og rundskriv' })).toBeTruthy();
    expect(within(table).getByText('2 dokumenter ble ikke lest')).toBeTruthy();
    expect(within(table).queryByRole('link', { name: 'Kudos-rapporter' })).toBeNull();
  });

  it('names the count and the filter when nothing matches', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets?filter=shared&q=nett', fetch);
    expect(await screen.findByRole('heading', { name: 'Ingen datasett passer' })).toBeTruthy();
    expect(
      screen.getByText(
        'Ingen av de 3 datasettene passer søket «nett» med filteret «Delt med dere».',
      ),
    ).toBeTruthy();
  });

  it('tries a failed ingestion again from the list', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets', fetch);
    const table = await screen.findByRole('table', { name: 'Datasett' });
    fireEvent.click(
      within(table).getByRole('button', {
        name: 'Prøv igjen å lese inn Nettsidene til Testetaten',
      }),
    );
    await waitFor(() =>
      expect(
        calls.find((c) => c.method === 'POST' && c.url.endsWith('/pipelines/website/execute')),
      ).toBeTruthy(),
    );
    const row = (await within(table).findByText('Innlesing pågår')).closest('tr') as HTMLElement;
    expect(within(row).getByRole('link', { name: 'Nettsidene til Testetaten' })).toBeTruthy();
  });

  it('keeps the search and filter in the address', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Datasett' });
    fireEvent.click(screen.getByRole('button', { name: 'Testetatens egne' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i datasett' }), {
      target: { value: 'nett' },
    });
    expect(window.location.hash).toBe('#/datasets?filter=own&q=nett');
  });

  it('restores the search and filter from the address', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets?filter=own&q=nett', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Datasett' });
    expect(screen.getByRole('button', { name: 'Testetatens egne', pressed: true })).toBeTruthy();
    expect(screen.getByRole('searchbox', { name: 'Søk i datasett' })).toHaveProperty(
      'value',
      'nett',
    );
  });

  it('shows one dataset table and no raw catalogue section, as the design does', async () => {
    const { fetch } = recorded();
    await renderLive('#/datasets', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Datasett' });
    expect(screen.getAllByRole('table', { name: 'Datasett' })).toHaveLength(1);
    expect(screen.queryByRole('heading', { name: 'Egne datasett og endepunkter' })).toBeNull();
    expect(
      screen.queryByText('Teknisk: katalogoppføringer for datasett, søkemotorer og modeller'),
    ).toBeNull();
  });

  it('counts the documents of a shared dataset from the list, with no call per dataset', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets', fetch);
    const table = await screen.findByRole('table', { name: 'Datasett' });
    const kudos = within(table).getByRole('link', { name: 'Kudos-rapporter' }).closest('tr');
    await waitFor(() => expect(kudos?.textContent).toMatch(/48\s312/));
    expect(calls.some((c) => c.url.includes('/documents'))).toBe(false);
  });
});

describe('live new dataset prerequisites', () => {
  const toReview = async () => {
    expect(await screen.findByRole('heading', { level: 1, name: 'Nytt datasett' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: /Nettsted/ }));
    fireEvent.change(screen.getByLabelText('Navn'), {
      target: { value: 'Nettsidene våre' },
    });
    fireEvent.change(screen.getByLabelText('Adresse til nettstedskartet', { exact: false }), {
      target: { value: 'https://testetaten.example.no/sitemap.xml' },
    });
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Nettsidene skal kunne søkes i' },
    });
  };

  it('does not create a dataset while the existing datasets cannot be fetched', async () => {
    const { calls, fetch } = recorded({}, (url, method) =>
      method === 'GET' && /\/tenants\/999888777\/datasets$/.test(url)
        ? new Response(JSON.stringify({ title: 'Feil' }), { status: 503 })
        : undefined,
    );
    await renderLive('#/datasets/new', fetch);
    await toReview();
    expect(
      await screen.findByText(/Vi fikk ikke sjekket hvilke datasett dere har fra før/),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Lag datasettet og les inn' }));
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
  });

  it('shows a search engine error with retry instead of claiming built-in search', async () => {
    const { fetch } = recorded({}, (url, method) =>
      method === 'GET' && url.includes('/knowledge/endpoints')
        ? new Response(JSON.stringify({ title: 'Feil' }), { status: 503 })
        : undefined,
    );
    await renderLive('#/datasets/new', fetch);
    await toReview();
    const storage = screen.getByRole('region', { name: 'Hvor dataene lagres' });
    expect(await within(storage).findByText('Kunne ikke hente dataene')).toBeTruthy();
    expect(storage.textContent).not.toContain('Innebygd søk');
  });
});
