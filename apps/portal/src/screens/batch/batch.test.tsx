// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { App } from '../../App';
import { mockAnsattporten } from '../../auth';
import { mockFetch, type MockExtras } from '../../mock';
import type { BatchRunsMockOptions } from '../../mock/batch-runs';
import type { Organisation, UsageReport } from '../../types';
import { expectAccessible, kari } from '../../test-utils';

interface Call {
  method: string;
  path: string;
  body: unknown;
  reason: string | null;
}

const base = '#/services/rapportassistenten/batch';

const usageOf = (tokens: number): UsageReport => ({
  from: '2026-10-01',
  to: '2026-10-09',
  priced: true,
  totals: { inputTokens: tokens, outputTokens: 0, requests: 1, costMicroNok: 0 },
  daily: [],
  byService: [],
  byModel: [],
});

const open = async (
  options: BatchRunsMockOptions = {},
  who: { name: string; organisations: Organisation[] } = kari,
  more: Omit<MockExtras, 'features'> = {},
) => {
  const calls: Call[] = [];
  const extras: MockExtras = {
    usage: usageOf(1_000_000),
    ...more,
    features: { batchRuns: options },
  };
  const inner = mockFetch(undefined, undefined, undefined, undefined, extras);
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const reason = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.replace(/^\/api/, ''),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      reason: reason === null ? null : decodeURIComponent(reason),
    });
    return inner(input, init);
  };
  const auth = mockAnsattporten(who);
  await auth.login();
  window.location.hash = base;
  render(<App auth={auth} fetch={fetch} live />);
  await screen.findByRole('heading', { name: 'Samlet jobb' });
  return {
    writes: () => calls.filter((c) => c.method !== 'GET'),
    starts: () => calls.filter((c) => c.method === 'POST' && /\/batch-runs$/.test(c.path)),
  };
};

const chooseAnnualReports = async () => {
  fireEvent.click(
    (await screen.findAllByRole('button', { name: 'Ny samlet jobb' }))[0] as HTMLElement,
  );
  fireEvent.click(await screen.findByRole('checkbox', { name: 'Årsrapport' }));
  fireEvent.click(await screen.findByRole('checkbox', { name: '2024' }));
  expect(await screen.findByText('12 dokumenter passer')).toBeTruthy();
};

const toCost = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
  await screen.findByRole('heading', { name: 'Inndata' });
  fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
  await screen.findByRole('heading', { name: 'Kostnad og kontroll' });
  await screen.findByTestId('estimate-basis');
};

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
afterEach(cleanup);

describe('Samlet jobb', () => {
  it('is reachable from the service navigation and explains an empty list', async () => {
    await open();
    const nav = screen.getByRole('navigation', { name: 'Tjenesten' });
    expect(
      within(nav).getByRole('link', { name: 'Samlet jobb' }).getAttribute('aria-current'),
    ).toBe('page');
    expect(await screen.findByRole('heading', { name: 'Ingen samlede jobber ennå' })).toBeTruthy();
    expectAccessible();
  });

  it('chooses documents, takes the inputs, measures the cost and starts with a stop limit', async () => {
    const { writes, starts } = await open({ truncating: ['ar-2024-2'] });
    await chooseAnnualReports();
    expect(writes().at(-1)).toMatchObject({
      path: '/tenants/999888777/services/rapportassistenten/batch-runs/estimate',
      body: {
        dataset: 'digdir/kudos',
        filters: { type: ['Årsrapport'], concerned_years: ['2024'] },
        sample: false,
      },
    });
    expectAccessible();

    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.change(await screen.findByLabelText('Noe mer tjenesten bør vite? (valgfritt)'), {
      target: { value: 'Hva sier rapporten om digitalisering?' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));

    expect((await screen.findByTestId('estimate-basis')).textContent).toMatch(/^Antatt:/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Mål med en prøvekjøring på 3 dokumenter' }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('estimate-basis').textContent).toMatch(
        /^Målt: laget ved å kjøre tjenesten på 3 dokumenter/,
      ),
    );
    expect(writes().at(-1)).toMatchObject({
      body: { prompt: 'Hva sier rapporten om digitalisering?' },
      reason: 'Målte kostnad for samlet jobb med prøvekjøring',
    });
    expect(screen.getByText('høyst 1 800 tokens')).toBeTruthy();
    expect(screen.getByText('Lengre svar blir avkortet')).toBeTruthy();
    const cap = screen.getByLabelText('Stopp jobben hvis kostnaden går over');
    expect((cap as HTMLInputElement).value).toBe('1');
    fireEvent.change(cap, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByText('Skriv en grense i kroner.')).toBeTruthy();
    fireEvent.change(cap, { target: { value: '2,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));

    expect(await screen.findByRole('heading', { name: 'Start' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Start jobben' }));

    const progress = await screen.findByRole('progressbar', { name: 'Fremdrift' });
    expect(progress.getAttribute('aria-valuetext')).toBe('100 prosent ferdig, 12 av 12');
    expect(starts().at(-1)).toMatchObject({
      body: { estimate: 'est-3', maxCostNok: 2.5 },
      reason: 'Startet samlet jobb over 12 dokumenter',
    });
    expect(
      await screen.findByText(/^Jobben er ferdig\. 11 av 12 dokumenter er kjørt, 1 feilet\./),
    ).toBeTruthy();
    const truncated = screen.getAllByText('Avkortet');
    expect(truncated).toHaveLength(1);
    expect(truncated[0]?.closest('tr')?.textContent).toContain('Årsrapport 2024 Brreg 2');
    expect(
      screen.getByRole('link', { name: 'Se kjøringen for Årsrapport 2024 Digdir 1' }),
    ).toBeTruthy();
    expectAccessible();
  });

  it('says when no documents match', async () => {
    await open({ documents: [] });
    fireEvent.click(
      (await screen.findAllByRole('button', { name: 'Ny samlet jobb' }))[0] as HTMLElement,
    );
    expect(await screen.findByText('Ingen dokumenter passer')).toBeTruthy();
    expect(screen.getByText(/^Ingen dokumenter passer filtrene\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neste' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('lets a small selection drop documents and estimates only the rest', async () => {
    const { writes } = await open();
    await chooseAnnualReports();
    fireEvent.click(screen.getByRole('button', { name: 'Ta ut Årsrapport 2024 Digdir 1' }));
    expect(await screen.findByText('11 dokumenter passer')).toBeTruthy();
    await toCost();
    expect((writes().at(-1)?.body as { documents: string[] }).documents).not.toContain('ar-2024-1');
    expect((writes().at(-1)?.body as { documents: string[] }).documents).toHaveLength(11);
  });

  it('needs approval with a reason when the estimate is above the per-job limit', async () => {
    const { starts } = await open({ perItemMicro: { low: 5_000_000, high: 20_000_000 } });
    await chooseAnnualReports();
    await toCost();

    expect(
      screen.getByRole('heading', { name: 'Jobben må godkjennes før den starter' }),
    ).toBeTruthy();
    expect(screen.getByText(/over grensen på 150 kr per jobb/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn. Nå er det 0.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse for godkjenning'), {
      target: { value: 'Avtalt med avdelingsdirektøren' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Godkjenn og start jobben' }));

    expect(await screen.findByText(/^Godkjent over grensen på 150 kr/)).toBeTruthy();
    expect(starts().at(-1)?.body).toMatchObject({ approval: 'Avtalt med avdelingsdirektøren' });
  });

  it('asks for a reason and a token limit when the model has no price', async () => {
    const { starts } = await open({ priced: false });
    await chooseAnnualReports();
    await toCost();

    expect(screen.getByText('Kostnaden kan ikke beregnes: modellen er ikke priset.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    expect(screen.getByText('Skriv en begrunnelse på minst 10 tegn. Nå er det 0.')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse for å starte uten pris'), {
      target: { value: 'Prismodellen kommer neste uke' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start jobben' }));

    await screen.findByRole('progressbar', { name: 'Fremdrift' });
    expect(starts().at(-1)).toMatchObject({
      body: { maxTokens: expect.any(Number) },
      reason: 'Startet samlet jobb over 12 dokumenter uten pris: Prismodellen kommer neste uke',
    });
  });

  it('stops before starting when the monthly quota is too small', async () => {
    await open({}, kari, { usage: usageOf(49_999_000) });
    await chooseAnnualReports();
    await toCost();

    expect(
      screen.getByRole('heading', { name: 'Ikke nok kvote igjen denne måneden' }),
    ).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Neste' }).getAttribute('aria-disabled')).toBe(
      'true',
    );
  });

  it('continues a job paused at its limit with a new limit and a reason', async () => {
    const { writes } = await open({ stopAfter: 8 });
    await chooseAnnualReports();
    await toCost();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start jobben' }));

    expect(
      await screen.findByRole('heading', {
        name: 'Jobben er satt på pause: kostnadsgrensen er nådd',
      }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Fortsett med ny grense' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Ny grense i kroner'), {
      target: { value: '5' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fortsett jobben' }));
    expect(
      within(dialog).getByText('Skriv en begrunnelse på minst 10 tegn. Nå er det 0.'),
    ).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText('Begrunnelse'), {
      target: { value: 'Resten av rapportene trengs til fredag' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fortsett jobben' }));

    await waitFor(() =>
      expect(writes().at(-1)).toMatchObject({
        path: expect.stringMatching(/\/retry$/),
        reason: 'Resten av rapportene trengs til fredag',
      }),
    );
    expect((writes().at(-1)?.body as { maxCostNok: number }).maxCostNok).toBeGreaterThan(0);
  });

  it('groups the failed documents and runs only them again', async () => {
    const { writes } = await open({ failing: ['ar-2024-3', 'ar-2024-5'] });
    await chooseAnnualReports();
    await toCost();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start jobben' }));

    expect(await screen.findByRole('heading', { name: '2 dokumenter feilet' })).toBeTruthy();
    expect(screen.getByText('2: Modellen svarte ikke')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Kjør de feilede på nytt (2)' }));

    await waitFor(() =>
      expect(writes().at(-1)).toMatchObject({
        path: expect.stringMatching(/\/retry$/),
        body: { items: [2, 4] },
        reason: 'Kjørte 2 feilede dokumenter på nytt',
      }),
    );
    expect(await screen.findByText('2 dokumenter kjøres på nytt.')).toBeTruthy();
  });

  it('cancels a running job and lists it', async () => {
    const { writes } = await open({ stayRunning: true });
    await chooseAnnualReports();
    await toCost();
    fireEvent.click(screen.getByRole('button', { name: 'Neste' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Start jobben' }));

    expect(await screen.findByText('Du kan gå fra siden. Jobben fortsetter.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt jobben' }));
    await waitFor(() =>
      expect(writes().at(-1)).toMatchObject({
        path: expect.stringMatching(/\/cancel$/),
        reason: 'Avbrøt samlet jobb',
      }),
    );
    expect(await screen.findByText(/^Jobben ble avbrutt/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Tilbake til jobbene' }));
    await screen.findByRole('heading', { name: 'Tidligere jobber' });
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Kudos: Årsrapport, 2024')).toBeTruthy();
    expect(within(table).getByText('Kari Nordmann')).toBeTruthy();
    expect(within(table).getByText('Avbrutt')).toBeTruthy();
  });

  it('shows jobs but not the setup to someone who cannot manage services', async () => {
    await open(
      {},
      {
        name: 'Erik Larsen',
        organisations: [{ orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] }],
      },
    );
    const section = screen
      .getByRole('heading', { name: 'Samlet jobb' })
      .closest('.batch') as HTMLElement;
    expect(
      within(section).getByText('Du trenger rettigheten «Administrere tjenester».'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ny samlet jobb' })).toBeNull();
  });
});
