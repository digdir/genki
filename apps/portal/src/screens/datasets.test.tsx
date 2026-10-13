// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DatasetDetailView } from '../api/datasets';
import { App } from '../App';
import { mockAnsattporten } from '../auth';
import { exampleDatasets, mockFetch } from '../mock';
import { expectAccessible, failingFetch, go, kari, renderAt } from '../test-utils';

const kudos = `#/datasets/${encodeURIComponent('digdir/kudos')}`;
const web = `#/datasets/${encodeURIComponent('999888777/nettsider')}`;
const tilsyn = `#/datasets/${encodeURIComponent('999888777/tilsynsrapporter-2025')}`;
const shared = `#/datasets/${encodeURIComponent('999666555/statsbudsjett-2026')}`;

const urlOf = (input: RequestInfo | URL) =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

const recording = (base: typeof fetch = mockFetch()) => {
  const urls: string[] = [];
  const fetch: typeof globalThis.fetch = (input, init) => {
    urls.push(urlOf(input));
    return base(input, init);
  };
  return { urls, fetch };
};

const openList = async (fetch?: typeof globalThis.fetch) => {
  await renderAt('#/datasets', fetch);
  await screen.findByRole('heading', { level: 1, name: 'Datasett' });
};

const openDetail = async (hash: string, name: string, fetch?: typeof globalThis.fetch) => {
  await renderAt(hash, fetch);
  await screen.findByRole('heading', { level: 1, name });
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const sharedExternal: DatasetDetailView = {
  id: 'kudos',
  fullId: 'digdir/kudos',
  name: 'Kudos',
  scope: 'platform',
  editable: false,
  source: 'kudos',
  state: 'external',
  documents: 10064,
  chunks: null,
  lastExecution: null,
  nextRunAt: null,
};

const renderLive = async (path: string) => {
  const auth = mockAnsattporten(kari);
  await auth.login();
  window.location.hash = path;
  render(
    <App
      auth={auth}
      fetch={mockFetch(undefined, undefined, undefined, undefined, {
        features: { datasets: { datasets: [sharedExternal] } },
      })}
      live
    />,
  );
};

describe('Datasett: delte datasett lest inn utenfor plattformen', () => {
  it('lists a shared dataset read in outside the platform under the Klar filter', async () => {
    await renderLive('#/datasets');
    await screen.findByRole('link', { name: 'Kudos' });
    fireEvent.click(screen.getByRole('radio', { name: 'Klar' }));
    expect(screen.getByText('Viser 1 av 1 datasett')).toBeTruthy();
  });

  it('does not tell the overview there are no datasets when only shared ones exist', async () => {
    await renderLive('#/overview');
    await screen.findByRole('heading', { level: 1, name: 'Oversikt' });
    expect(await screen.findByText('Alt er i orden')).toBeTruthy();
    expect(screen.queryByText('Ingen datasett ennå')).toBeNull();
  });
});

describe('Datasett: liste', () => {
  it('lists datasets from the live API with source, documents and last ingestion', async () => {
    const { urls, fetch } = recording();
    await openList(fetch);
    expect(urls.some((u) => u.endsWith('/api/datasets'))).toBe(true);
    expect(
      screen.getByText(/Dokumentsamlinger tjenestene kan søke i\. Hvert datasett leses inn/),
    ).toBeTruthy();
    const list = screen.getByRole('list', { name: 'Datasett' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(6);
    const kudosRow = within(list)
      .getByRole('link', { name: 'Kudos-rapporter' })
      .closest('li') as HTMLElement;
    expect(within(kudosRow).getByText('Klar')).toBeTruthy();
    expect(within(kudosRow).getByText('Kudos')).toBeTruthy();
    expect(within(kudosRow).getByText('48 312')).toBeTruthy();
    expect(screen.getByText('Viser 6 av 6 datasett').getAttribute('aria-live')).toBe('polite');
    expectAccessible();
  });

  it('links to detail pages with the slash in the id encoded', async () => {
    await openList();
    expect(screen.getByRole('link', { name: 'Kudos-rapporter' }).getAttribute('href')).toBe(
      '#/datasets/digdir%2Fkudos',
    );
    expect(
      screen.getByRole('link', { name: 'Nettsidene til Testetaten' }).getAttribute('href'),
    ).toBe('#/datasets/999888777%2Fnettsider');
  });

  it('warns about datasets that need follow-up and explains the failed one', async () => {
    await openList();
    expect(
      screen.getByText(
        '2 datasett trenger oppfølging: Tilsynsrapporter 2025 og Nettsidene til Testetaten.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('I dag kl. 06.00 (feilet). Sist vellykket 4. oktober kl. 06.00'),
    ).toBeTruthy();
    expect(screen.getByText('Delt av Eksempeldirektoratet', { selector: 'dd' })).toBeTruthy();
  });

  it('filters by status and search, and resets when nothing matches', async () => {
    await openList();
    fireEvent.click(screen.getByRole('radio', { name: 'Feilet' }));
    expect(screen.getByText('Viser 1 av 6 datasett')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nettsidene til Testetaten' })).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Alle' }));
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i datasett' }), {
      target: { value: 'høring' },
    });
    expect(screen.getByText('Viser 1 av 6 datasett')).toBeTruthy();
    fireEvent.change(screen.getByRole('searchbox', { name: 'Søk i datasett' }), {
      target: { value: 'finnes ikke' },
    });
    expect(screen.getByText('Ingen datasett passer søket')).toBeTruthy();
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Nullstill søk og filter' }));
    expect(screen.getByText('Viser 6 av 6 datasett')).toBeTruthy();
  });

  it('shows an empty state when there are no datasets', async () => {
    await openList(mockFetch(undefined, undefined, undefined, []));
    expect(screen.getByText('Ingen datasett ennå')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Nytt datasett' }));
    expect(window.location.hash).toBe('#/datasets/new');
  });

  it('shows an error with retry when the list cannot be loaded', async () => {
    await renderAt('#/datasets', failingFetch(/\/api\/datasets$/));
    expect(await screen.findByText('Kunne ikke hente dataene')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'Datasett' })).toBeTruthy();
  });
});

describe('Datasett: detalj', () => {
  it('nettsted-feilet: shows the failed alert, facts, used-by and the open failed run', async () => {
    await openDetail(`${web}?run=w1`, 'Nettsidene til Testetaten');
    expect(screen.getByRole('heading', { level: 2, name: 'Siste innlesing feilet' })).toBeTruthy();
    expect(screen.getAllByText(/Nettstedet svarte «utilgjengelig» tre ganger på rad/)).toHaveLength(
      2,
    );
    expect(screen.getByText('Sist vellykket')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Nettsider på nynorsk' })).toBeTruthy();
    const run = document.getElementById('run-w1') as HTMLElement;
    expect(within(run).getByRole('button', { expanded: true })).toBeTruthy();
    expect(within(run).getByText('Stoppet innlesingen')).toBeTruthy();
    expect(within(run).getByText('Teknisk kode: HTTP 503')).toBeTruthy();
    expect(within(run).getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
    expectAccessible();
  });

  it('expands an older run with skipped pages and no retry', async () => {
    await openDetail(web, 'Nettsidene til Testetaten');
    const run = document.getElementById('run-w3') as HTMLElement;
    const toggle = within(run).getByRole('button', { expanded: false });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(within(run).getAllByText('Hoppet over')).toHaveLength(2);
    expect(within(run).queryByRole('button', { name: 'Prøv igjen' })).toBeNull();
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows "Vis API-kall" next to "Les inn nå" with the pipeline execute route the API has', async () => {
    await openDetail(kudos, 'Kudos-rapporter');
    fireEvent.click(screen.getByRole('button', { name: 'Vis API-kall' }));
    const panel = await screen.findByRole('dialog', {
      name: 'Start en innlesing av Kudos-rapporter',
    });
    expect(
      within(panel).getByText(
        '/tenants/999888777/datasets/digdir%2Fkudos/pipelines/{pipeline}/execute',
      ),
    ).toBeTruthy();
    expect(within(panel).getByText('Administrere datasett')).toBeTruthy();
    expectAccessible();
  });

  it('runs an ingestion with progress, then announces the result', async () => {
    await openDetail(web, 'Nettsidene til Testetaten');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Les inn nå' }));
    const bar = screen.getByRole('progressbar', { name: 'Fremdrift' });
    expect(bar.getAttribute('aria-valuenow')).toBe('0');
    expect(screen.getByText('Omtrent 0 av 2 104 dokumenter behandlet')).toBeTruthy();
    const runNow = screen.getByRole('button', { name: 'Les inn nå' });
    expect(runNow.getAttribute('aria-disabled')).toBe('true');
    expect(runNow.hasAttribute('disabled')).toBe(false);
    expectAccessible();
    act(() => {
      vi.advanceTimersByTime(800);
    });
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('20');
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(
      screen.getByText('Nettstedet svarte igjen. 9 nye, 41 endrede og 2 fjernede sider.'),
    ).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('Siste innlesing feilet')).toBeNull();
  });

  it('stops a running ingestion after confirmation and keeps documents already read', async () => {
    await openDetail(tilsyn, 'Tilsynsrapporter 2025');
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Les inn nå' }));
    act(() => {
      vi.advanceTimersByTime(1500);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Stopp innlesingen' }));
    expect(screen.getByText(/Vil du stoppe innlesingen\?/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fortsett innlesingen' }));
    expect(screen.getByRole('progressbar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Stopp innlesingen' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ja, stopp innlesingen' }));
    expect(
      screen.getByText(
        'Innlesingen er stoppet. Dokumenter som allerede er lest inn, beholdes og kan brukes. Du kan starte en ny innlesing når du vil.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.getAllByText('Stoppet').length).toBeGreaterThan(0);
    expect(screen.getByText('+5 nye')).toBeTruthy();
    expect(screen.getByText('141')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Les inn nå' }).getAttribute('aria-disabled')).toBe(
      null,
    );
    expectAccessible();
  });

  it('kudos-filtre: shows facet cards with value bars and a filter switch', async () => {
    await openDetail(`${kudos}?tab=filters`, 'Kudos-rapporter');
    expect(screen.getByRole('tab', { name: 'Filtre i søket' }).getAttribute('aria-selected')).toBe(
      'true',
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Dokumenttype' })).toBeTruthy();
    const values = screen.getByRole('list', { name: 'Verdier for Virksomhet' });
    expect(within(values).getByText('Testetaten')).toBeTruthy();
    expect(screen.getByText(/og 212 verdier til med til sammen 40 598 dokumenter/)).toBeTruthy();
    const switches = screen.getAllByRole('switch', { name: 'Kan brukes som filter' });
    expect(switches).toHaveLength(4);
    fireEvent.click(switches[0] as HTMLElement);
    expect((switches[0] as HTMLInputElement).checked).toBe(false);
    expectAccessible();
  });

  it('loads live facet counts from the API using tenant and dataset config key', async () => {
    const base = mockFetch();
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = urlOf(input);
      if (url.includes('/api/facets')) {
        urls.push(url);
        return new Response(
          JSON.stringify({
            fields: [
              { field: 'type', options: [{ value: 'Direktiv', count: 7, selected: false }] },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        );
      }
      return base(input, init);
    };
    await openDetail(`${kudos}?tab=filters`, 'Kudos-rapporter', fetch);
    expect(await screen.findByText('Direktiv')).toBeTruthy();
    const query = new URL(urls[0] ?? '', 'http://localhost').searchParams;
    expect(query.get('tenant')).toBe('digdir');
    expect(query.get('dataset-config-key')).toBe('kudos');
    expect(query.get('fields')).toBe('type,aar,virksomhet,departement');
  });

  it('shows source settings and saves ingestion and sharing settings', async () => {
    await openDetail(`${kudos}?tab=source`, 'Kudos-rapporter');
    expect(screen.getByRole('heading', { level: 2, name: 'Kilde' })).toBeTruthy();
    expect(screen.getByText('Kudos rapportarkiv')).toBeTruthy();
    expect(
      screen
        .getByRole('link', { name: 'Se alle innstillinger for datasettet' })
        .getAttribute('href'),
    ).toBe('#/datasets/digdir%2Fkudos/settings');
    const ocr = screen.getByRole('switch', { name: /Tekstgjenkjenning/ }) as HTMLInputElement;
    expect(ocr.checked).toBe(true);
    fireEvent.click(ocr);
    fireEvent.click(
      screen.getByRole('radio', { name: 'Alle offentlige virksomheter på plattformen' }),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(
      screen.getByText('Innstillingene er lagret. De brukes fra neste innlesing.'),
    ).toBeTruthy();
    expect(screen.getByRole('radio', { name: /Bare tjenestene til/ })).toBeTruthy();
    expectAccessible();
  });

  it('shows a shared dataset as read only', async () => {
    await openDetail(`${shared}?tab=source`, 'Statsbudsjettet 2026');
    expect(screen.queryByRole('button', { name: 'Les inn nå' })).toBeNull();
    expect(
      within(document.querySelector('.page-head') as HTMLElement).queryByRole('button', {
        name: 'Vis API-kall',
      }),
    ).toBeNull();
    expect(await screen.findByRole('heading', { level: 2, name: 'Søkemotor' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Bytt søkemotor' })).toBeNull();
    expect(
      screen.getByText(
        'Datasettet eies av Eksempeldirektoratet. Dere kan søke i det, men ikke endre kilden.',
      ),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Innlesing og deling' })).toBeNull();
    fireEvent.click(screen.getByRole('tab', { name: 'Filtre i søket' }));
    const toggle = screen.getAllByRole('switch', {
      name: 'Kan brukes som filter',
    })[0] as HTMLElement;
    expect(toggle.getAttribute('aria-disabled')).toBe('true');
    expectAccessible();
  });

  it('retries a partial ingestion from the alert and reaches the new document count', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await openDetail(tilsyn, 'Tilsynsrapporter 2025');
    const alert = screen.getByRole('heading', {
      name: 'Noen filer ble ikke lest inn',
    }).parentElement as HTMLElement;
    fireEvent.click(within(alert).getByRole('button', { name: 'Se innlesingen' }));
    fireEvent.click(within(alert).getAllByRole('button')[0] as HTMLElement);
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(
      screen.getByText('De 12 skannede filene er lest inn. Datasettet har nå 148 dokumenter.'),
    ).toBeTruthy();
  });

  it('fetches an unlisted dataset with getDataset using the full id', async () => {
    const extra = {
      id: '999888777/arkiv/2026',
      name: 'Arkivuttrekk 2026',
      description: 'Uttrekk fra arkivet.',
      'enabled?': true,
      status: 'ready',
    };
    const base = mockFetch(undefined, undefined, undefined, exampleDatasets);
    const urls: string[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = urlOf(input);
      urls.push(url);
      if (url.includes('/api/datasets/999888777'))
        return new Response(JSON.stringify({ dataset: extra }), {
          headers: { 'content-type': 'application/json' },
        });
      return base(input, init);
    };
    await openDetail(`#/datasets/${encodeURIComponent(extra.id)}`, 'Arkivuttrekk 2026', fetch);
    expect(urls.some((u) => u.includes('/api/datasets/999888777/arkiv/2026'))).toBe(true);
    expect(screen.getByText('Uttrekk fra arkivet.')).toBeTruthy();
    expect(screen.getByText('Ingen innlesinger ennå.')).toBeTruthy();
    expectAccessible();
  });

  it('says the dataset was not found when getDataset fails', async () => {
    await renderAt(`#/datasets/${encodeURIComponent('999888777/ukjent')}`);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Fant ikke datasettet' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Gå til Datasett' })).toBeTruthy();
  });
});

describe('Datasett: nytt datasett', () => {
  it('ny-kilde: offers the three sources with examples in a fieldset', async () => {
    await renderAt('#/datasets/new');
    expect(await screen.findByRole('heading', { level: 1, name: 'Velg kilde' })).toBeTruthy();
    expect(screen.getByText('Steg 1 av 3')).toBeTruthy();
    const group = screen.getByRole('group', { name: 'Hvor kommer dokumentene fra?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(3);
    expect((screen.getByRole('radio', { name: /Kudos/ }) as HTMLInputElement).checked).toBe(true);
    expect(within(group).getByRole('link', { name: 'Integrasjoner' }).getAttribute('href')).toBe(
      '#/integrations',
    );
    expect(screen.queryByRole('button', { name: 'Forrige' })).toBeNull();
    expectAccessible();
  });

  it('ny-nettsted: validates name and address with an error summary that gets focus', async () => {
    await renderAt('#/datasets/new?example=web');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Sett opp nettsted' }),
    ).toBeTruthy();
    expect((screen.getByLabelText('Navn på datasettet') as HTMLInputElement).value).toBe(
      'Nettsidene til Prøvetilsynet',
    );
    fireEvent.change(screen.getByLabelText('Navn på datasettet'), { target: { value: '' } });
    fireEvent.change(screen.getByLabelText(/Startadresse/), { target: { value: 'http://x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByText('Før du går videre, må du rette opp i dette:')).toBeTruthy();
    const nameLink = screen.getByRole('link', { name: 'Skriv et navn på datasettet.' });
    expect(nameLink.getAttribute('href')).toBe('#felt-navn');
    expect(screen.getAllByText(/Skriv en adresse som begynner med https:\/\//)).toHaveLength(2);
    expect(screen.getByLabelText(/Startadresse/).getAttribute('aria-invalid')).toBe('true');
    await waitFor(() => expect(document.activeElement?.textContent).toContain('Før du går videre'));
    expectAccessible();
  });

  it('checks the web address and walks to the summary', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderAt('#/datasets/new?example=web');
    await screen.findByRole('heading', { level: 1, name: 'Sett opp nettsted' });
    fireEvent.click(screen.getByRole('button', { name: 'Sjekk adressen' }));
    expect(screen.getByRole('status').textContent).toContain('Sjekker nettstedet');
    expect(
      screen.getByRole('button', { name: 'Sjekk adressen' }).getAttribute('aria-disabled'),
    ).toBe('true');
    act(() => {
      vi.advanceTimersByTime(1200);
    });
    expect(screen.getByText(/Nettstedet svarer\. Vi fant omtrent 1 240 sider/)).toBeTruthy();
    const scrollTo = vi.spyOn(window, 'scrollTo').mockImplementation(() => undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    const summary = screen.getByRole('heading', { level: 1, name: 'Se over og start' });
    expect(document.activeElement).toBe(summary);
    expect(scrollTo).toHaveBeenCalledWith({ top: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Forrige' }));
    expect(document.activeElement).toBe(
      screen.getByRole('heading', { level: 1, name: 'Sett opp nettsted' }),
    );
    scrollTo.mockRestore();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByText('https://provetilsynet.example.no')).toBeTruthy();
    expect(screen.getByText('/sok, /logg-inn')).toBeTruthy();
    expect(screen.getByText('Omtrent 1 240')).toBeTruthy();
    expectAccessible();
  });

  it('estimates Kudos documents from the selection and starts the first ingestion', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await renderAt('#/datasets/new');
    await screen.findByRole('heading', { level: 1, name: 'Velg kilde' });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByRole('heading', { level: 1, name: 'Sett opp kudos' })).toBeTruthy();
    expect(screen.getByText('Omtrent 5 866 dokumenter passer utvalget.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Fra år'), { target: { value: '2010' } });
    expect(screen.getByText('Omtrent 12 480 dokumenter passer utvalget.')).toBeTruthy();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Årsrapport' }));
    expect(screen.getByText('Omtrent 22 392 dokumenter passer utvalget.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Navn på datasettet'), {
      target: { value: 'Evalueringer' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.click(screen.getByRole('button', { name: 'Start innlesing' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Evalueringer' })).toBeTruthy();
    expect(window.location.hash).toMatch(/^#\/datasets\/[^/]+%2Fny-\d+$/);
    expect(screen.getByRole('progressbar')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(4000);
    });
    expect(
      screen.getByText('Evalueringer er klart. Du kan nå velge det i en tjeneste.'),
    ).toBeTruthy();
  });

  it('validates uploaded files and lists sample files with unsupported ones flagged', async () => {
    await renderAt('#/datasets/new');
    await screen.findByRole('heading', { level: 1, name: 'Velg kilde' });
    fireEvent.click(screen.getByRole('radio', { name: /Last opp filer/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.change(screen.getByLabelText('Navn på datasettet'), { target: { value: 'Filer' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByRole('link', { name: 'Velg minst én fil som kan leses.' })).toBeTruthy();
    expect(screen.queryByLabelText('Oppdater')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Bruk eksempelfiler' }));
    const files = screen.getByRole('list', { name: 'Valgte filer' });
    expect(within(files).getAllByRole('listitem')).toHaveLength(5);
    expect(within(files).getByText('Formatet støttes ikke')).toBeTruthy();
    expect(
      screen.getByText(/4 av 5 filer kan leses inn\. Filer som ikke støttes, hoppes over\./),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fjern Presentasjon fra møtet.pages' }));
    expect(within(files).getAllByRole('listitem')).toHaveLength(4);
    expectAccessible();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByText('Når filer lastes opp')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Forrige' }));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Sett opp opplastede filer' }),
    ).toBeTruthy();
  });

  it('cancels back to the list', async () => {
    await renderAt('#/datasets/new');
    await screen.findByRole('heading', { level: 1, name: 'Velg kilde' });
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt' }));
    expect(window.location.hash).toBe('#/datasets');
    go('#/datasets/new');
    expect(await screen.findByRole('heading', { level: 1, name: 'Velg kilde' })).toBeTruthy();
  });
});
