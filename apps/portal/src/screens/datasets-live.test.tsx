// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { exampleOrganisations, mockFetch, type FeatureMockOptions } from '../mock';
import { exampleEndpoints } from '../mock/search-engines';
import { expectAccessible } from '../test-utils';

document.getAnimations ??= () => [];
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

const next = () => fireEvent.click(screen.getByRole('button', { name: 'Neste' }));

describe('live datasets list', () => {
  it('reads the tenant dataset API for source, documents and last ingestion', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets', fetch);
    const list = await screen.findByRole('list', { name: 'Datasett' });
    expect(calls.some((c) => c.url.endsWith('/tenants/999888777/datasets'))).toBe(true);
    expect(calls.some((c) => /\/api\/datasets(\/|$)/.test(c.url))).toBe(false);
    const row = within(list).getByRole('link', { name: 'Veiledere og rundskriv' }).closest('li');
    expect(within(row as HTMLElement).getByText('Opplastede filer')).toBeTruthy();
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
    expect(await screen.findByRole('heading', { level: 1, name: 'Velg kilde' })).toBeTruthy();
    expect(screen.queryByText(/kan ikke legges til fra portalen/)).toBeNull();
    fireEvent.click(screen.getByRole('radio', { name: /Nettsted/ }));
    next();
    fireEvent.change(screen.getByLabelText('Navn på datasettet'), {
      target: { value: 'Nettsidene våre' },
    });
    fireEvent.change(screen.getByLabelText('Adresse til nettstedskartet', { exact: false }), {
      target: { value: 'https://testetaten.example.no/sitemap.xml' },
    });
    fireEvent.change(screen.getByLabelText('Utelat disse stiene'), {
      target: { value: '/sok\n/logg-inn' },
    });
    fireEvent.change(screen.getByLabelText('Oppdater'), { target: { value: 'weekly' } });
    next();
    expect(screen.getByRole('heading', { level: 1, name: 'Se over og start' })).toBeTruthy();
    expect(screen.getByText('Ukentlig')).toBeTruthy();
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

    fireEvent.click(screen.getByRole('button', { name: 'Start innlesing' }));
    expect(screen.getByRole('link', { name: /begrunnelse på minst 10 tegn/ })).toBeTruthy();
    expect(calls.some((c) => c.method !== 'GET')).toBe(false);
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Nettsidene skal kunne søkes i' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start innlesing' }));

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
      within(alert).getByText('Skannet PDF uten tekst. Tekstgjenkjenning er ikke slått på.'),
    ).toBeTruthy();
    expect(screen.getByText('Dokumenter').nextElementSibling?.textContent).toBe('6');
  });

  it('uploads the chosen files before the first ingestion and leaves out unreadable ones', async () => {
    const { calls, fetch } = recorded();
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Velg kilde' });
    fireEvent.click(screen.getByRole('radio', { name: /Last opp filer/ }));
    next();
    fireEvent.change(screen.getByLabelText('Navn på datasettet'), { target: { value: 'Høring' } });
    expect(screen.queryByLabelText('Oppdater')).toBeNull();
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
    next();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Høringssvarene skal kunne søkes i' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start innlesing' }));
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
              errors: [{ path: 'source', message: 'Kudos trenger dokumenttyper eller et år.' }],
            },
            { status: 422 },
          )
        : undefined,
    );
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Velg kilde' });
    fireEvent.click(screen.getByRole('radio', { name: /Kudos/ }));
    next();
    fireEvent.change(screen.getByLabelText('Navn på datasettet'), {
      target: { value: 'Evalueringer' },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: 'Evaluering' }));
    next();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Evalueringene skal brukes i rapportassistenten' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Start innlesing' }));
    expect(await screen.findByText('Kudos trenger dokumenttyper eller et år.')).toBeTruthy();
    refuse = false;
    fireEvent.click(screen.getByRole('button', { name: 'Start innlesing' }));
    await screen.findByRole('heading', { level: 1, name: 'Evalueringer' });
    expect(calls.filter((c) => c.url.includes('/catalog/dataset/'))).toHaveLength(1);
    expect(
      calls.filter((c) => c.method === 'POST' && c.url.endsWith('/pipelines')).at(-1)?.body,
    ).toMatchObject({
      source: { kind: 'kudos', types: ['Evaluering'], since: '2020-01-01' },
      schedule: 'daily',
    });
  });

  it('offers only document types that exist in Kudos', async () => {
    const { fetch } = recorded({});
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Velg kilde' });
    fireEvent.click(screen.getByRole('radio', { name: /Kudos/ }));
    next();

    expect(screen.getByRole('checkbox', { name: 'Statusrapport' })).toBeTruthy();
    expect(screen.queryByRole('checkbox', { name: 'Utredning' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Veileder' })).toBeNull();
  });

  const reviewWebsite = async (fetch: typeof globalThis.fetch) => {
    await renderLive('#/datasets/new', fetch);
    await screen.findByRole('heading', { level: 1, name: 'Velg kilde' });
    fireEvent.click(screen.getByRole('radio', { name: /Nettsted/ }));
    next();
    fireEvent.change(screen.getByLabelText('Navn på datasettet'), { target: { value: 'Sider' } });
    fireEvent.change(screen.getByLabelText('Adresse til nettstedskartet', { exact: false }), {
      target: { value: 'https://testetaten.example.no/sitemap.xml' },
    });
    next();
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
    fireEvent.click(screen.getByRole('button', { name: 'Start innlesing' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Start innlesing' }));
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
    const start = await screen.findByRole('region', { name: 'Kom i gang' });
    expect(
      within(start).getByRole('link', { name: 'Legg til datasett' }).getAttribute('href'),
    ).toBe('#/datasets/new');
    cleanup();

    const withData = recorded();
    const later: typeof fetch = (input, init) =>
      /\/overview$/.test(urlOf(input)) ? services(input, init) : withData.fetch(input, init);
    await renderLive('#/overview', later);
    const done = await screen.findByRole('region', { name: 'Kom i gang' });
    await within(done).findByText('Ferdig');
    expect(within(done).queryByRole('link', { name: 'Legg til datasett' })).toBeNull();
  });
});

describe('live dataset detail', () => {
  it('shows real facts and executions with skipped documents in Norwegian', async () => {
    const { calls, fetch } = recorded();
    await renderLive(veiledere, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    expect(screen.getByText('Tekstbiter').nextElementSibling?.textContent).toBe('48');
    expect(screen.getByText('Neste innlesing').nextElementSibling?.textContent).toBe(
      'Ikke planlagt',
    );
    expect(screen.getByText('Data behandles').nextElementSibling?.textContent).toBe(
      'Globalt, også utenfor EU/EØS',
    );
    const runs = await screen.findByRole('list', { name: 'Innlesinger' });
    expect(within(runs).getByText('6 lest inn')).toBeTruthy();
    expect(within(runs).getByText('2 hoppet over')).toBeTruthy();
    fireEvent.click(within(runs).getByRole('button', { expanded: false }));
    expect(
      within(runs).getByText('Skannet PDF uten tekst. Tekstgjenkjenning er ikke slått på.'),
    ).toBeTruthy();
    expect(calls.some((c) => c.url.includes('/api/datasets'))).toBe(false);
    expect(screen.queryByText('Ukjent kilde')).toBeNull();
    expectAccessible();
  });

  it('says "Ikke oppgitt" when the API gives no effective residency', async () => {
    const { fetch } = recorded();
    await renderLive(`#/datasets/${encodeURIComponent('digdir/kudos')}`, fetch);
    await screen.findByRole('heading', { level: 1, name: 'Kudos-rapporter' });
    expect(screen.getByText('Data behandles').nextElementSibling?.textContent).toBe('Ikke oppgitt');
  });

  it('runs "Les inn nå" against the pipeline and polls until it is done', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { calls, fetch } = recorded({ pollsUntilDone: 3 });
    await renderLive(veiledere, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    fireEvent.click(screen.getByRole('button', { name: 'Les inn nå' }));
    expect(await screen.findByText(/Innlesingen pågår\. Siden oppdateres/)).toBeTruthy();
    const execute = calls.find((c) => c.url.endsWith('/pipelines/upload/execute'));
    expect(execute?.method).toBe('POST');
    expect(execute?.reason).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Les inn nå' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(await screen.findByRole('heading', { name: 'Innlesingen er ferdig' })).toBeTruthy();
    expect(screen.queryByText(/Innlesingen pågår\. Siden oppdateres/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
    expect(
      (
        await screen.findAllByText(
          /\/tenants\/999888777\/datasets\/veiledere\/pipelines\/upload\/execute/,
        )
      ).length,
    ).toBeGreaterThan(0);
  });

  it('cancels a running ingestion with a reason and shows it as cancelled', async () => {
    const { calls, fetch } = recorded({ pollsUntilDone: 100 });
    await renderLive(veiledere, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    expect(screen.queryByRole('button', { name: 'Avbryt innlesing' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Les inn nå' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Avbryt innlesing' }));

    expect(await screen.findByText('Innlesingen er avbrutt.')).toBeTruthy();
    const cancel = calls.find((c) => /\/executions\/[^/]+\/cancel$/.test(c.url));
    expect(cancel?.method).toBe('POST');
    expect(cancel?.reason).toBeTruthy();
    expect(
      within(screen.getByRole('list', { name: 'Innlesinger' })).getByText('Avbrutt'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Avbryt innlesing' })).toBeNull();
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
                    'Datasettet veiledere leses allerede inn av kjøringen ex-1. Vent til den er ferdig, eller avbryt den.',
                },
              ],
            },
            { status: 409 },
          )
        : undefined,
    );
    await renderLive(veiledere, fetch);
    await screen.findByRole('list', { name: 'Innlesinger' });
    fireEvent.click(screen.getByRole('button', { name: 'Les inn nå' }));

    expect(await screen.findByText(/leses allerede inn av kjøringen ex-1/)).toBeTruthy();
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
    const card = await screen.findByRole('region', { name: 'Kilde og innstillinger' });
    expect((within(card).getByLabelText('Utelat disse stiene') as HTMLTextAreaElement).value).toBe(
      '/sok',
    );
    expect(screen.queryByRole('switch', { name: /Tekstgjenkjenning/ })).toBeNull();
    fireEvent.change(within(card).getByLabelText('Oppdater'), { target: { value: 'weekly' } });
    fireEvent.click(within(card).getByRole('button', { name: 'Lagre' }));
    expect(calls.some((c) => c.method === 'PUT')).toBe(false);
    fireEvent.change(within(card).getByLabelText('Begrunnelse'), {
      target: { value: 'Holder med en gang i uken' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Lagre' }));
    expect(await within(card).findByText(/Endringene ble ikke lagret/)).toBeTruthy();
    expect(screen.queryByText(/Endringene er lagret/)).toBeNull();

    fail = false;
    fireEvent.click(within(card).getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText(/Endringene er lagret/)).toBeTruthy();
    const put = calls.filter((c) => c.method === 'PUT').at(-1);
    expect(put?.url).toMatch(/\/datasets\/nettsider\/pipelines\/website$/);
    expect(put?.body).toMatchObject({
      schedule: 'weekly',
      source: { kind: 'website', exclude: ['/sok', '/sok/**'] },
    });
    expect(put?.reason).toBe('Holder med en gang i uken');
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
    expect(screen.getByText(/Filene er lastet opp\. Trykk «Les inn nå»/)).toBeTruthy();

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
    expect(screen.queryByRole('button', { name: 'Les inn nå' })).toBeNull();
    expect(screen.getByText('Kudos, delt med dere')).toBeTruthy();
    expect(screen.queryByRole('switch', { name: 'Kan brukes som filter' })).toBeNull();
    expect(await screen.findByText('Årsrapport')).toBeTruthy();
  });
});
