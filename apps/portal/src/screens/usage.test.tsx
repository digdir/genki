// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';
import type { UsageReport } from '../types';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
  URL.createObjectURL ??= () => 'blob:usage';
});
beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

const zero = { inputTokens: 0, outputTokens: 0, requests: 0, costMicroNok: 0 };
const emptyReport: UsageReport = {
  from: '2026-10-01T00:00:00.000Z',
  to: '2026-10-06T10:00:00.000Z',
  priced: true,
  totals: zero,
  daily: [],
  byService: [],
  byModel: [],
};

const recording = (base = mockFetch()) => {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push(String(input));
    return base(input, init);
  };
  return { calls, fetch };
};

const table = async (name = 'Fordelt på tjeneste') => {
  const regions = await screen.findAllByRole('region', { name });
  return regions[regions.length - 1] as HTMLElement;
};

describe('Forbruk', () => {
  it('shows quota, KPIs, chart and the service table from the usage API', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/statistics', fetch);

    expect(await screen.findByRole('heading', { level: 1, name: 'Statistikk' })).toBeTruthy();
    expect(screen.getByText('Henter forbruk')).toBeTruthy();
    const region = await table();
    expect(calls.some((c) => /\/tenants\/[^/]+\/usage\?days=190$/.test(c))).toBe(true);

    expect(screen.getByRole('heading', { level: 2, name: 'Kvote i oktober' })).toBeTruthy();
    expect(screen.getByText(/Sist oppdatert i dag kl\. \d\d\.\d\d\./)).toBeTruthy();
    const meter = screen.getByRole('meter', { name: 'Brukt av kvoten i oktober' });
    expect(meter.getAttribute('aria-valuetext')).toMatch(/av 50 mill\. tokens brukt/);
    expect(screen.getByText('Beregnet kostnad i oktober')).toBeTruthy();
    expect(screen.getByText('Kjøringer i oktober')).toBeTruthy();
    expect(screen.getByText('Behandlet i Norge')).toBeTruthy();

    const bars = screen.getByRole('list', { name: /^Tokens per dag, 1\.–6\. oktober 2026/ });
    expect(
      within(bars)
        .getByRole('button', { name: /^i dag, 6\. oktober/ })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(within(bars).getAllByRole('img', { name: /ikke kommet ennå/ })).toHaveLength(25);

    expect(within(region).getByRole('rowheader', { name: /Rapportassistenten/ })).toBeTruthy();
    expect(within(region).getByRole('rowheader', { name: 'Sum' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Eksporter' })).toBeTruthy();
    expectAccessible();
  });

  it('warns when a service is near its limit and changes the limit with validation', async () => {
    await renderAt('#/statistics');
    await table();

    const alert = screen.getByRole('heading', {
      name: /Høringsoppsummering har brukt \d+ % av grensen sin/,
    });
    expect(alert).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se jobben som kjører' }).getAttribute('href')).toBe(
      '#/log',
    );
    expect(screen.getAllByText('Nær grensen').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole('button', { name: 'Endre grense for Høringsoppsummering' }));
    expect(
      await screen.findByRole('heading', { name: 'Grense for Høringsoppsummering' }),
    ).toBeTruthy();
    const input = screen.getByLabelText('Millioner tokens per måned');
    expect((input as HTMLInputElement).value).toBe('1');

    fireEvent.change(input, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(screen.getByText('Skriv et tall større enn 0, for eksempel 2 eller 1,5.')).toBeTruthy();
    expect(input.getAttribute('aria-invalid')).toBe('true');

    fireEvent.change(input, { target: { value: '60' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(
      screen.getByText(/Grensen kan ikke være høyere enn kvoten til .+, som er 50 millioner\./),
    ).toBeTruthy();

    fireEvent.change(input, { target: { value: '2,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(
      await screen.findByText('Grensen for Høringsoppsummering er nå 2,5 mill. tokens per måned.'),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { name: /Høringsoppsummering har brukt/ })).toBeNull();
    expectAccessible();
  });

  it('removes a limit and offers to set one again', async () => {
    await renderAt('#/statistics');
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'Endre grense for Vedtaksutkast' }));
    fireEvent.click(await screen.findByLabelText('Ingen egen grense (bare virksomhetens kvote)'));
    expect(screen.queryByLabelText('Millioner tokens per måned')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Lagre' }));
    expect(await screen.findByText('Vedtaksutkast har ikke lenger egen grense.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Sett grense for Vedtaksutkast' })).toBeTruthy();
  });

  it('switches period and grouping, and sorts the table', async () => {
    await renderAt('#/statistics');
    await table();

    fireEvent.change(screen.getByLabelText('Periode'), { target: { value: 'six' } });
    expect(screen.getByRole('list', { name: /^Tokens per måned, Mai–oktober 2026/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Periode'), { target: { value: 'previous' } });
    expect(
      screen.getByRole('list', { name: /^Tokens per dag, 1\.–30\. september 2026/ }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole('radio', { name: 'Modell' }));
    const models = await table('Fordelt på modell');
    expect(within(models).getByRole('columnheader', { name: 'Data behandlet i' })).toBeTruthy();
    expect(within(models).getAllByText('Norge').length).toBeGreaterThan(0);

    const nameHeader = within(models).getByRole('columnheader', { name: /^Modell/ });
    fireEvent.click(within(nameHeader).getByRole('button'));
    expect(nameHeader.getAttribute('aria-sort')).toBe('ascending');
    const names = within(models)
      .getAllByRole('rowheader')
      .map((r) => r.textContent ?? '')
      .filter((n) => n !== 'Sum');
    expect(names[0]).toMatch(/^Borealis-27B/);
    expectAccessible();
  });

  it('exports the report as a file', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await renderAt('#/statistics');
    await table();
    fireEvent.click(screen.getByRole('button', { name: 'Eksporter' }));
    expect(await screen.findByRole('heading', { name: 'Eksporter forbruk' })).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/^JSON/));
    fireEvent.click(screen.getByLabelText('Bare summer for perioden'));
    fireEvent.click(screen.getByRole('button', { name: 'Last ned' }));
    expect(await screen.findByText(/^Filen forbruk-.+\.json er lastet ned\.$/)).toBeTruthy();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it('shows the empty state when nothing has run yet', async () => {
    await renderAt(
      '#/statistics',
      mockFetch(undefined, undefined, undefined, undefined, { usage: emptyReport }),
    );
    expect(
      await screen.findByRole('heading', { level: 2, name: 'Ingen forbruk ennå' }),
    ).toBeTruthy();
    expect(screen.getByText(/Kvoten for .+ er 50 millioner tokens per måned\./)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Lag en tjeneste' }).getAttribute('href')).toBe(
      '#/services/new',
    );
    expect(screen.queryByRole('button', { name: 'Eksporter' })).toBeNull();
    expectAccessible();
  });

  it('points to the Kontakt Digdir page for a higher quota', async () => {
    await renderAt('#/statistics');
    await screen.findByText(/Digdir kan øke kvoten/);
    const links = screen.getAllByRole('link', { name: 'Kontakt Digdir' });
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) expect(link.getAttribute('href')).toBe('#/contact');
    expect(screen.queryByText('kundeservice')).toBeNull();
  });

  it('says what is counted: tests are not shown but count toward the quota', async () => {
    await renderAt(
      '#/statistics',
      mockFetch(undefined, undefined, undefined, undefined, { usage: emptyReport }),
    );
    const empty = await screen.findByRole('heading', { level: 2, name: 'Ingen forbruk ennå' });
    const text = empty.parentElement?.textContent ?? '';
    expect(text).toContain('Assistenten har sitt eget daglige budsjett og er ikke med.');
    expect(text).not.toContain('også når dere tester i byggeren');
  });

  it('uses the tenant quota, the model residency and display names, and says Ikke priset', async () => {
    const usage = (tokens: number) => ({
      inputTokens: tokens * 0.8,
      outputTokens: tokens * 0.2,
      requests: tokens / 1000,
      costMicroNok: null,
      priced: false,
    });
    const report: UsageReport = {
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-10-06T10:00:00.000Z',
      priced: false,
      totals: usage(1_000_000),
      daily: [
        {
          date: '2026-10-05',
          usage: usage(1_000_000),
          byService: { rapportassistenten: usage(1_000_000) },
          byModel: {
            'foundry-openai/gpt-4.1-mini': usage(750_000),
            'tenant/norsk-7b': usage(250_000),
          },
        },
      ],
      byService: [{ service: 'rapportassistenten', usage: usage(1_000_000) }],
      byModel: [
        { model: 'foundry-openai/gpt-4.1-mini', usage: usage(750_000) },
        { model: 'tenant/norsk-7b', usage: usage(250_000) },
      ],
    };
    const models = [
      {
        id: 'foundry-openai/gpt-4.1-mini',
        name: 'GPT-4.1 mini',
        residency: 'global' as const,
        capabilities: [],
      },
      { id: 'tenant/norsk-7b', residency: 'norway' as const, capabilities: [] },
    ];
    const base = mockFetch(undefined, undefined, models, undefined, { usage: report });
    await renderAt('#/statistics', async (input, init) =>
      String(input).endsWith('/settings/effective')
        ? Response.json({ 'usage.monthlyTokens': { key: 'usage.monthlyTokens', value: 4_000_000 } })
        : base(input, init),
    );

    await table();
    const meter = screen.getByRole('meter', { name: 'Brukt av kvoten i oktober' });
    expect(meter.getAttribute('aria-valuetext')).toMatch(/^1,0 mill\. av 4,0 mill\. tokens brukt/);
    const cost = screen.getByText('Beregnet kostnad i oktober').parentElement as HTMLElement;
    expect(cost.textContent).toContain('Ikke priset');
    expect(cost.textContent).not.toMatch(/0,00 kr|0 kr/);
    const norway = screen.getByText('Behandlet i Norge').parentElement as HTMLElement;
    expect(norway.textContent).toContain('25 %');
    expect(norway.textContent).not.toContain('Sverige');

    fireEvent.click(screen.getByRole('radio', { name: 'Modell' }));
    const models_ = await table('Fordelt på modell');
    expect(within(models_).getByRole('rowheader', { name: /GPT-4\.1 mini/ })).toBeTruthy();
    expect(within(models_).getByRole('rowheader', { name: /^norsk-7b/ })).toBeTruthy();
    expect(within(models_).queryByText(/foundry-openai\//)).toBeNull();
    expect(within(models_).getByText('I Norge')).toBeTruthy();
    expect(within(models_).getByText('Globalt, også utenfor EU/EØS')).toBeTruthy();
    expect(within(models_).getAllByText('Ikke priset').length).toBeGreaterThan(0);
  });

  it('shows usage per project and filters the page to one project', async () => {
    const { calls, fetch } = recording();
    await renderAt('#/statistics', fetch);

    const region = await table('Fordelt på prosjekt');
    expect(within(region).getByRole('rowheader', { name: 'Høringsrunde 2026' })).toBeTruthy();
    expect(screen.getByText(/så det kommer ikke i tillegg/)).toBeTruthy();

    fireEvent.click(within(region).getByRole('button', { name: 'Vis bare Høringsrunde 2026' }));

    await waitFor(() =>
      expect(calls.some((c) => c.endsWith('/usage?days=190&project=horinger-2026'))).toBe(true),
    );
    expect(
      await screen.findByText(/Viser bare forbruket fra kjøringene i prosjektet Høringsrunde 2026/),
    ).toBeTruthy();
    const services = await table();
    expect(
      within(services)
        .getAllByRole('rowheader')
        .map((r) => r.textContent),
    ).toEqual([expect.stringContaining('Høringsoppsummering'), 'Sum']);
    expect(screen.queryByRole('region', { name: 'Fordelt på prosjekt' })).toBeNull();
    expect((screen.getByLabelText('Prosjekt') as HTMLSelectElement).value).toBe('horinger-2026');

    fireEvent.change(screen.getByLabelText('Prosjekt'), { target: { value: '' } });
    expect(await table('Fordelt på prosjekt')).toBeTruthy();
    await expectAccessible();
  });

  it('shows an error with retry when the usage API fails', async () => {
    let fail = true;
    const ok = mockFetch();
    const broken = failingFetch(/\/usage/);
    let usageCalls = 0;
    await renderAt('#/statistics', async (input, init) => {
      if (String(input).includes('/usage')) usageCalls += 1;
      return fail ? broken(input, init) : ok(input, init);
    });

    expect(await screen.findByRole('heading', { name: 'Fikk ikke hentet forbruket' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Eksporter' })).toBeNull();
    expectAccessible();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    await table();
    await waitFor(() => expect(usageCalls).toBe(2));
    expect(screen.queryByRole('heading', { name: 'Fikk ikke hentet forbruket' })).toBeNull();
  });
});
