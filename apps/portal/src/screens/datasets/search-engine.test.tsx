// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../../mock';
import { exampleEndpoints, type SearchEnginesMockOptions } from '../../mock/search-engines';
import { expectAccessible, renderAt as render } from '../../test-utils';
import type { DatasetDetailView } from '../../api/datasets';
import { exampleLiveDatasets } from '../../mock/datasets';

const own = '999888777/veiledere';
const kudos = `#/datasets/${encodeURIComponent(own)}?tab=source`;
const sharedByOther: DatasetDetailView = {
  id: 'statsbudsjett-2026',
  fullId: '999666555/statsbudsjett-2026',
  name: 'Statsbudsjett 2026',
  scope: '999666555',
  editable: false,
  searchScope: 'all',
  source: 'none',
  documents: null,
  chunks: null,
  lastExecution: null,
  nextRunAt: null,
};
const shared = `#/datasets/${encodeURIComponent(sharedByOther.fullId)}?tab=source`;

const fetchWith = (searchEngines: SearchEnginesMockOptions = {}) =>
  mockFetch(undefined, undefined, undefined, undefined, {
    features: {
      searchEngines: { dataset: own, ...searchEngines },
      datasets: { datasets: [...exampleLiveDatasets, sharedByOther] },
    },
  });

const renderAt = async (hash: string, fetch?: typeof globalThis.fetch) => {
  await render(hash, fetch);
  await screen.findByRole('heading', { level: 1 });
  fireEvent.click(await screen.findByText('Tekniske detaljer'));
};

const openOwn = async (options: SearchEnginesMockOptions = {}) => {
  await renderAt(kudos, fetchWith(options));
  await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
};

const block = async () => {
  const heading = await screen.findByRole('heading', { level: 2, name: 'Søkemotor' });
  return heading.closest('section') as HTMLElement;
};

const switchSection = async () => {
  const heading = await screen.findByRole('heading', { level: 2, name: /^Bytt søkemotor for/ });
  return heading.closest('section') as HTMLElement;
};

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('Dokumentsamlinger: søkemotor', () => {
  it('shows the engine facts, what it can do and the services that search the dataset', async () => {
    await openOwn();
    const section = await block();
    expect(within(section).getByText('Innebygd søk')).toBeTruthy();
    expect(within(section).getByText('Plattformens egen database')).toBeTruthy();
    expect(within(section).getByText('NorBERT-embed-v3 (AIVAR)')).toBeTruthy();
    expect(within(section).getByText('0,18 s i snitt siste 7 dager')).toBeTruthy();
    expect(within(section).getByText('Søkemotoren kan alt plattformen bruker i dag.')).toBeTruthy();
    expect(within(section).getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expectAccessible();
  });

  it('the Kan ikke list explains the consequence for services', async () => {
    await openOwn({ scenario: 'no-facets' });
    const section = await block();
    expect(within(section).getByText('OpenSearch')).toBeTruthy();
    expect(
      within(section).getByText('Ingen. Søkemotoren bruker ikke vektorer.', { exact: false }),
    ).toBeTruthy();
    const cannot = within(section).getByRole('list', { name: 'Dette kan den ikke' });
    const items = within(cannot).getAllByRole('listitem');
    expect(items.map((li) => li.querySelector('strong')?.textContent)).toEqual([
      'Søk på betydning (vektorer)',
      'Kombinert søk',
      'Fasetter',
    ]);
    expect(within(cannot).getAllByText('Kan ikke')).toHaveLength(3);
    expect(
      within(cannot).getByText('Uten fasetter foreslår ikke tjenesten filtre automatisk.'),
    ).toBeTruthy();
    expect(
      within(cannot).getByText(
        'Tjenesten finner bare dokumenter som bruker de samme ordene som spørsmålet.',
      ),
    ).toBeTruthy();
    expectAccessible();
  });

  it('says there is nothing to switch to when the platform has one engine', async () => {
    await openOwn({ endpoints: exampleEndpoints.filter((e) => e.id === 'platform-pg') });
    const section = await block();
    expect(
      within(section).getByText(
        /^Det finnes ingen annen søkemotor å bytte til\. Testetaten har bare tilgang til/,
      ),
    ).toBeTruthy();
    expect(
      within(section)
        .getByRole('link', { name: 'Spør Digdir om flere søkemotorer' })
        .getAttribute('href'),
    ).toBe('#/contact');
    expect(within(section).queryByRole('button', { name: 'Bytt søkemotor' })).toBeNull();
    expectAccessible();
  });

  it('hides Bytt søkemotor on a dataset shared by another agency', async () => {
    await renderAt(shared, fetchWith());
    const section = await block();
    expect(within(section).queryByRole('button', { name: 'Bytt søkemotor' })).toBeNull();
  });

  it('compares engines and warns about what the dataset would lose', async () => {
    await openOwn();
    fireEvent.click(within(await block()).getByRole('button', { name: 'Bytt søkemotor' }));
    const flow = await switchSection();
    expect(
      within(flow).getByText(/Ingenting endres for tjenestene før du velger «Ta i bruk»/),
    ).toBeTruthy();
    expect(within(flow).queryByRole('radio', { name: /Innebygd søk/ })).toBeNull();
    expect(
      (within(flow).getByRole('radio', { name: /Typesense/ }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(within(flow).getByText('Krever egen skrivenøkkel')).toBeTruthy();
    const table = within(flow).getByRole('region', { name: 'Sammenligning av søkemotorer' });
    expect(within(table).getByRole('columnheader', { name: /Innebygd søk\s*Nå/ })).toBeTruthy();
    const warning = within(flow).getByRole('heading', {
      name: 'Med Typesense mister dokumentsamlingen 1 egenskap',
    });
    expect(warning.parentElement?.textContent).toMatch(
      /Lese avsnitt i rekkefølge:.*Tjenesten kan ikke lese avsnittene rundt et treff/,
    );
    expectAccessible();
  });

  it('copy is disabled when vector models differ', async () => {
    await openOwn();
    fireEvent.click(within(await block()).getByRole('button', { name: 'Bytt søkemotor' }));
    const flow = await switchSection();
    fireEvent.click(within(flow).getByRole('radio', { name: /Azure AI Search/ }));
    fireEvent.click(within(flow).getByRole('button', { name: 'Neste' }));
    const copy = within(flow).getByRole('radio', {
      name: /Kopier fra nåværende søkemotor/,
    }) as HTMLInputElement;
    expect(copy.disabled).toBe(true);
    expect(copy.checked).toBe(false);
    expect(
      within(flow).getByText(
        'Ikke mulig: Azure AI Search bruker en annen vektormodell, så tekstbitene må lages på nytt.',
      ),
    ).toBeTruthy();
    const reingest = within(flow).getByRole('radio', {
      name: /Les inn på nytt fra kilden/,
    }) as HTMLInputElement;
    expect(reingest.checked).toBe(true);
    expect(
      await within(flow).findByText(
        'Anslag: omtrent 2 000 til 2 400 kr og 3 til 4 timer for 6 dokumenter.',
      ),
    ).toBeTruthy();
    expectAccessible();
  });

  it('offers copy with its estimate when the vector model is the same', async () => {
    await openOwn();
    fireEvent.click(within(await block()).getByRole('button', { name: 'Bytt søkemotor' }));
    const flow = await switchSection();
    fireEvent.click(within(flow).getByRole('radio', { name: /OpenSearch/ }));
    fireEvent.click(within(flow).getByRole('button', { name: 'Neste' }));
    const copy = within(flow).getByRole('radio', {
      name: /Kopier fra nåværende søkemotor/,
    }) as HTMLInputElement;
    expect(copy.disabled).toBe(false);
    expect(copy.checked).toBe(true);
    expect(
      await within(flow).findByText(
        'Anslag: omtrent 30 til 50 kr og 25 minutter for 48 tekstbiter.',
        {
          exact: false,
        },
      ),
    ).toBeTruthy();
  });

  it('steps mark the current one with aria-current=step', async () => {
    await openOwn({ scenario: 'switching' });
    const flow = await switchSection();
    expect(within(flow).getByText('Steg 3 av 5')).toBeTruthy();
    const steps = within(flow).getByRole('list', { name: 'Steg' });
    const current = steps.querySelectorAll('[aria-current="step"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.textContent).toBe('3Overføring');
    const bar = within(flow).getByRole('progressbar', { name: 'Kopierer til OpenSearch' });
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    expect(
      within(flow).getByText('Kopierer tekstbiter: 40 prosent.').getAttribute('aria-live'),
    ).toBe('polite');
    expect(within(flow).getByText(/Du kan lukke siden\. Overføringen fortsetter/)).toBeTruthy();
    expect(
      within(flow).getByRole('button', { name: 'Avbryt byttet' }).getAttribute('aria-disabled'),
    ).toBe('true');
    expectAccessible();
  });

  it('moves on to the quality comparison when the transfer is done', async () => {
    await renderAt(kudos, fetchWith({ scenario: 'switching', progressStep: 60 }));
    const flow = await switchSection();
    await waitFor(() => expect(within(flow).getByText('Steg 4 av 5')).toBeTruthy(), {
      timeout: 4000,
    });
    expect(
      await within(flow).findByText('Tilsynsrapport 2023/4471', {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(within(flow).getByText('Bedre', { selector: 'td *' })).toBeTruthy();
  });

  it('keeps polling a running switch after a failed poll', async () => {
    let failures = 1;
    const base = fetchWith({ scenario: 'switching', progressStep: 60 });
    const fetch: typeof globalThis.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (failures > 0 && !init?.method && url.endsWith('/engine-switches/1')) {
        failures -= 1;
        return Promise.resolve(new Response('{}', { status: 503 }));
      }
      return base(input, init);
    };
    await renderAt(kudos, fetch);
    const flow = await switchSection();
    expect(
      await within(flow).findByText(
        'Fikk ikke hentet status akkurat nå. Vi prøver igjen av oss selv.',
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    await waitFor(() => expect(within(flow).getByText('Steg 4 av 5')).toBeTruthy(), {
      timeout: 6000,
    });
  }, 10000);

  it('activating a switch into the knowledge database shows the refresh, then the new engine', async () => {
    await renderAt(
      kudos,
      fetchWith({ scenario: 'switching', progressStep: 60, refresh: true, failedDocuments: 2 }),
    );
    const flow = await switchSection();
    await waitFor(() => expect(within(flow).getByText('Steg 4 av 5')).toBeTruthy(), {
      timeout: 4000,
    });
    expect(
      await within(flow).findByText(
        '2 dokumenter kunne ikke leses inn. De leses inn på nytt før byttet tas i bruk.',
        {},
        { timeout: 3000 },
      ),
    ).toBeTruthy();
    fireEvent.click(within(flow).getByRole('button', { name: 'Neste' }));
    fireEvent.change(within(flow).getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Flytter til kunnskapsdatabasen' },
    });
    fireEvent.click(within(flow).getByRole('button', { name: 'Ta i bruk' }));
    expect(
      await within(flow).findByText(/Leser inn det som er endret i kilden siden overføringen/),
    ).toBeTruthy();
    expect(within(flow).queryByRole('button', { name: 'Ta i bruk' })).toBeNull();
    expect(await screen.findByText(/søker nå i/, {}, { timeout: 4000 })).toBeTruthy();
  });

  it("the portal's engine switch screen shows when admission runs out, and admits the switch again", async () => {
    vi.useFakeTimers({ now: new Date('2026-11-15T05:00:00Z'), shouldAdvanceTime: true });
    await openOwn({
      scenario: 'switching',
      progressStep: 0,
      admissionRunsOutAt: '2026-11-15T07:56:00Z',
    });
    const flow = await switchSection();
    const warned = await within(flow).findByText(
      /sluppet inn bare til 15\. november 2026 kl\. 08:56/,
    );
    expect(warned.closest('[data-color="warning"]')).not.toBeNull();

    fireEvent.click(within(flow).getByRole('button', { name: 'Slipp inn igjen' }));

    const calm = await within(flow).findByText(/sluppet inn til 16\. november 2026 kl\. 06:00/);
    expect(calm.closest('[data-color="warning"]')).toBeNull();
  });

  it('a failed transfer offers Prøv igjen and Avbryt byttet, and the block explains it', async () => {
    await openOwn({ scenario: 'failed' });
    const flow = await switchSection();
    expect(
      within(flow).getByRole('heading', { name: 'Overføringen stoppet ved 60 prosent' }),
    ).toBeTruthy();
    expect(within(flow).getByText(/^OpenSearch svarte ikke\. Innebygd søk brukes/)).toBeTruthy();
    expect(
      within(flow).getByText('Teknisk melding: OpenSearch svarte ikke etter tre forsøk'),
    ).toBeTruthy();
    expect(within(flow).getByRole('button', { name: 'Prøv igjen' })).toBeTruthy();
    const cancels = within(flow).getAllByRole('button', { name: 'Avbryt byttet' });
    fireEvent.click(cancels[cancels.length - 1] as HTMLElement);
    const section = await block();
    expect(
      within(section).getByRole('heading', { name: 'Byttet til OpenSearch feilet' }),
    ).toBeTruthy();
    expect(
      within(section).getByText(/Dokumentsamlingen bruker fortsatt Innebygd søk/),
    ).toBeTruthy();
    expect(within(section).getByRole('button', { name: 'Prøv å bytte på nytt' })).toBeTruthy();
  });

  it('a worse comparison asks for a 20-character reason', async () => {
    await openOwn({ scenario: 'worse' });
    const flow = await switchSection();
    expect(within(flow).getByText('Steg 4 av 5')).toBeTruthy();
    expect(within(flow).getByText('Azure AI Search gir dårligere treff:')).toBeTruthy();
    expect(within(flow).getAllByText('Dårligere').length).toBeGreaterThan(1);
    expect(within(flow).getByText('Ikke funnet blant de 5 første')).toBeTruthy();
    fireEvent.click(within(flow).getByRole('button', { name: 'Neste' }));
    expect(within(flow).getByText(/Innebygd søk beholdes i 14 dager/)).toBeTruthy();
    expect(within(flow).getByText('Ikke bestemt')).toBeTruthy();
    expect(
      within(flow).getByText(/Rapportassistenten søker i Azure AI Search fra det øyeblikket/),
    ).toBeTruthy();
    const reason = within(flow).getByRole('textbox', { name: /Begrunnelse/ });
    fireEvent.change(reason, { target: { value: 'Billigere drift' } });
    fireEvent.click(within(flow).getByRole('button', { name: 'Ta i bruk' }));
    expect(within(flow).getByText('Skriv en begrunnelse på minst 20 tegn.')).toBeTruthy();
    expect(reason.getAttribute('aria-invalid')).toBe('true');
    fireEvent.change(reason, {
      target: { value: 'Avtalen med Digdir krever Azure fra nyttår' },
    });
    fireEvent.click(within(flow).getByRole('button', { name: 'Ta i bruk' }));
    expect(
      await screen.findByText(
        'Veiledere og rundskriv søker nå i Azure AI Search. Innebygd søk er beholdt, så du kan gå tilbake. Endringen er logget.',
      ),
    ).toBeTruthy();
    const section = await block();
    await waitFor(() => expect(within(section).getByText('Azure AI Search')).toBeTruthy());
    expect(
      within(section).getByText(/Den forrige søkemotoren, Innebygd søk, er beholdt i 14/),
    ).toBeTruthy();

    fireEvent.click(within(section).getByRole('button', { name: 'Gå tilbake til Innebygd søk' }));
    fireEvent.change(within(section).getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Treffene ble for dårlige' },
    });
    fireEvent.click(within(section).getByRole('button', { name: 'Gå tilbake' }));
    expect(
      await screen.findByText(
        'Veiledere og rundskriv søker igjen i Innebygd søk. Endringen er logget.',
      ),
    ).toBeTruthy();
  });

  it('runs engine, estimate, start, progress, compare and activate against the API shapes', async () => {
    const base = fetchWith({ progressStep: 50 });
    const calls: { method: string; path: string; body?: unknown; reason?: string | null }[] = [];
    const replies = new Map<string, unknown>();
    const recording: typeof fetch = async (input, init) => {
      const url = new URL(String(input), 'http://mock');
      const response = await base(input, init);
      if (url.pathname.includes('/engine')) {
        calls.push({
          method: init?.method ?? 'GET',
          path: `${url.pathname}${url.search}`,
          ...(init?.body ? { body: JSON.parse(String(init.body)) as unknown } : {}),
          reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
        });
        replies.set(`${init?.method ?? 'GET'} ${url.pathname}`, await response.clone().json());
      }
      return response;
    };
    await renderAt(kudos, recording);
    await screen.findByRole('heading', { level: 1, name: 'Veiledere og rundskriv' });
    fireEvent.click(within(await block()).getByRole('button', { name: 'Bytt søkemotor' }));
    const flow = await switchSection();
    fireEvent.click(within(flow).getByRole('radio', { name: /OpenSearch/ }));
    fireEvent.click(within(flow).getByRole('button', { name: 'Neste' }));
    await within(flow).findByText(/Anslag: omtrent 30 til 50 kr/);
    fireEvent.click(within(flow).getByRole('button', { name: 'Start overføringen' }));
    expect(await within(flow).findByText('Steg 3 av 5')).toBeTruthy();
    await waitFor(() => expect(within(flow).getByText('Steg 4 av 5')).toBeTruthy(), {
      timeout: 5000,
    });
    expect(
      await within(flow).findByText('Tilsynsrapport 2023/4471', {}, { timeout: 3000 }),
    ).toBeTruthy();
    expect(within(flow).getByText('92 %')).toBeTruthy();
    expect(within(flow).getByText('94 %')).toBeTruthy();
    fireEvent.click(within(flow).getByRole('button', { name: 'Neste' }));
    fireEvent.change(within(flow).getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Raskere søk i testsettet' },
    });
    fireEvent.click(within(flow).getByRole('button', { name: 'Ta i bruk' }));
    expect(
      await screen.findByText(
        'Veiledere og rundskriv søker nå i OpenSearch. Innebygd søk er beholdt, så du kan gå tilbake. Endringen er logget.',
      ),
    ).toBeTruthy();

    const path = `/api/tenants/999888777/datasets/${encodeURIComponent(own)}`;
    const estimate = calls.find((c) => c.path.includes('/estimate'));
    expect(estimate).toMatchObject({
      method: 'GET',
      path: `${path}/engine-switches/estimate?to=opensearch-sev`,
    });
    expect(estimate).not.toHaveProperty('body');
    const start = calls.find((c) => c.method === 'POST' && c.path === `${path}/engine-switches`);
    expect(start?.body).toEqual({ to: 'opensearch-sev', method: 'copy' });
    expect(start?.reason).toBe('Bytter søkemotor for dokumentsamlingen');
    const created = replies.get(`POST ${path}/engine-switches`) as { sid: string };
    expect(created).toMatchObject({ state: 'running', progress: { percent: 0 } });
    expect(
      calls.filter((c) => c.path === `${path}/engine-switches/${created.sid}`).length,
    ).toBeGreaterThan(1);
    expect(replies.get(`GET ${path}/engine-switches/${created.sid}`)).toMatchObject({
      state: 'ready',
      minimumReasonLength: 10,
      comparison: { verdict: 'better', hitAt5: [0.92, 0.94] },
    });
    expect(
      calls.find((c) => c.path === `${path}/engine-switches/${created.sid}/activate`),
    ).toMatchObject({
      method: 'POST',
      body: {},
      reason: 'Raskere søk i testsettet',
    });
    expect(replies.get(`GET ${path}/engine`)).toMatchObject({
      endpoint: 'opensearch-sev',
      previous: { endpoint: 'platform-pg', title: 'Innebygd søk' },
    });
  });

  it('a Typesense target is refused with the API message', async () => {
    await openOwn();
    fireEvent.click(within(await block()).getByRole('button', { name: 'Bytt søkemotor' }));
    const flow = await switchSection();
    fireEvent.click(within(flow).getByRole('button', { name: 'Neste' }));
    expect(await within(flow).findByText('Krever egen skrivenøkkel')).toBeTruthy();
    expect(within(flow).getAllByText('Fant ikke et anslag.')).toHaveLength(2);
  });

  it('without a test set the comparison step explains why and lets you continue', async () => {
    await renderAt(kudos, fetchWith({ scenario: 'no-test-set', progressStep: 100 }));
    fireEvent.click(within(await block()).getByRole('button', { name: 'Bytt søkemotor' }));
    const flow = await switchSection();
    fireEvent.click(within(flow).getByRole('radio', { name: /OpenSearch/ }));
    fireEvent.click(within(flow).getByRole('button', { name: 'Neste' }));
    await within(flow).findByText(/Anslag: omtrent 30 til 50 kr/);
    fireEvent.click(within(flow).getByRole('button', { name: 'Start overføringen' }));
    expect(
      await within(flow).findByText(
        'Datasettet har ikke noe testsett med forventede kilder.',
        {},
        { timeout: 5000 },
      ),
    ).toBeTruthy();
    const next = within(flow).getByRole('button', { name: 'Neste' });
    expect(next.getAttribute('aria-disabled')).toBeNull();
    fireEvent.click(next);
    expect(within(flow).getByText('Steg 5 av 5')).toBeTruthy();
  });
});
