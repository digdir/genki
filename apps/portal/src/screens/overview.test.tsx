// @vitest-environment jsdom
import { cleanup, fireEvent, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleServices, exampleTimeline, mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';
import type { UsageReport, UsageTotals } from '../types';

const totals = (tokens: number, requests: number): UsageTotals => ({
  inputTokens: Math.round(tokens * 0.9),
  outputTokens: tokens - Math.round(tokens * 0.9),
  requests,
  costMicroNok: 4_180_000_000,
});

const report = (tokens: number): UsageReport => ({
  from: '2026-10-01T00:00:00Z',
  to: '2026-10-07T00:00:00Z',
  priced: true,
  totals: totals(tokens, 5216),
  daily: [],
  byService: [
    { service: 'rapportassistenten', usage: totals(3_700_000, 2000) },
    { service: 'postsortering', usage: totals(2_900_000, 3000) },
  ],
  byModel: [],
});

const withUsage = (tokens: number) =>
  mockFetch(exampleServices, [exampleTimeline], undefined, undefined, { usage: report(tokens) });

const withSettings =
  (settings: Record<string, unknown>, base: typeof fetch): typeof fetch =>
  async (input, init) =>
    String(input).endsWith('/settings/effective') ? Response.json(settings) : base(input, init);

const quotaSetting = (value: number) => ({
  'usage.monthlyTokens': {
    key: 'usage.monthlyTokens',
    value,
    source: 'tenant',
    defaultVersion: 1,
    overridden: [],
    rejected: [],
  },
});

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Oversikt', () => {
  it('lands on Oversikt with services, what they do and how they start', async () => {
    await renderAt('#/', withUsage(9_400_000));

    expect(await screen.findByRole('heading', { level: 1, name: 'Oversikt' })).toBeTruthy();
    expect(screen.getByText('Testetaten · org.nr. 999 888 777')).toBeTruthy();
    const services = screen.getByRole('region', { name: 'Tjenester' });
    expect(
      within(services).getByRole('link', { name: 'Rapportassistenten' }).getAttribute('href'),
    ).toBe('#/services/rapportassistenten');
    expect(within(services).getByText('Melding i kø')).toBeTruthy();
    expect(
      within(services).getByRole('list', { name: 'Antall tjenester per status' }),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ny tjeneste' }).getAttribute('href')).toBe(
      '#/services/new',
    );
    expectAccessible();
  });

  it('names a shared service in the usage by its title, or a readable name, never its raw id', async () => {
    const usage = {
      ...report(9_400_000),
      byService: [
        {
          service: '991825827/klarsprak/default',
          title: 'Klarspråk',
          usage: totals(3_000_000, 10),
        },
        { service: '991825827/brev-hjelp/default', usage: totals(2_000_000, 10) },
      ],
    };
    await renderAt(
      '#/overview',
      mockFetch(exampleServices, [exampleTimeline], undefined, undefined, { usage }),
    );

    expect(await screen.findByText('Klarspråk')).toBeTruthy();
    expect(screen.getByText('Brev hjelp')).toBeTruthy();
    expect(screen.queryByText(/991825827\//)).toBeNull();
  });

  it('shows the quota as a progress bar against 50 million tokens', async () => {
    await renderAt('#/overview', withUsage(9_400_000));

    const bar = await screen.findByRole('progressbar', { name: 'Brukt av månedens kvote' });
    expect(bar.getAttribute('aria-valuenow')).toBe('19');
    expect(bar.getAttribute('aria-valuetext')).toBe('19 prosent brukt');
    expect(screen.getByText('9,4 mill.')).toBeTruthy();
    expect(screen.getByText('av 50 mill. tokens')).toBeTruthy();
    expect(screen.queryByText('Kvoten er nesten brukt opp')).toBeNull();
  });

  it('measures the quota against the tenant setting usage.monthlyTokens', async () => {
    await renderAt('#/overview', withSettings(quotaSetting(20_000_000), withUsage(19_000_000)));

    const bar = await screen.findByRole('progressbar', { name: 'Brukt av månedens kvote' });
    expect(bar.getAttribute('aria-valuenow')).toBe('95');
    expect(screen.getByText('av 20 mill. tokens')).toBeTruthy();
    expect(
      screen.getByText(/brukt 95 prosent av månedens kvote på 20 millioner tokens/),
    ).toBeTruthy();
  });

  it('says the quota is not set instead of inventing one', async () => {
    await renderAt('#/overview', withSettings({}, withUsage(9_400_000)));

    expect(await screen.findByText('tokens. Kvoten er ikke oppgitt.')).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Brukt av månedens kvote' })).toBeNull();
  });

  it('shows Ikke priset, never 0 kr, when the usage is not priced', async () => {
    const unpriced = {
      ...report(9_400_000),
      priced: false,
      totals: { ...totals(9_400_000, 5216), costMicroNok: null },
    };
    await renderAt(
      '#/overview',
      mockFetch(exampleServices, [exampleTimeline], undefined, undefined, { usage: unpriced }),
    );

    const cost = await screen.findByText('Anslått kostnad hittil');
    expect(cost.nextElementSibling?.textContent).toBe('Ikke priset');
    expect(
      screen.getByText(/Assistenten har sitt eget daglige budsjett og er ikke med/),
    ).toBeTruthy();
  });

  it('warns when more than 90 percent of the quota is used', async () => {
    await renderAt('#/overview', withUsage(47_000_000));

    expect(await screen.findByText('Kvoten er nesten brukt opp')).toBeTruthy();
    expect(
      screen.getByText(/brukt 94 prosent av månedens kvote på 50 millioner tokens/),
    ).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Se forbruk og kostnad per tjeneste' })).toBeTruthy();
  });

  it('keeps the page usable when usage cannot be fetched and retries', async () => {
    await renderAt('#/overview', failingFetch(/\/usage/));

    expect(await screen.findByText('Vi fikk ikke hentet forbruket')).toBeTruthy();
    expect(screen.getByRole('region', { name: 'Tjenester' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen' }));
    expect(await screen.findByText('Vi fikk ikke hentet forbruket')).toBeTruthy();
  });

  it('lists ingestions that need follow-up and queues a retry', async () => {
    await renderAt('#/overview', withUsage(9_400_000));

    expect(await screen.findByText('2 innlesinger trenger oppfølging.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen: Nettsidene til Testetaten' }));
    expect(screen.getByText('Satt i kø')).toBeTruthy();
    expect(screen.getByText('1 innlesing trenger oppfølging.')).toBeTruthy();
  });

  it('shows Kom i gang for a tenant without services', async () => {
    await renderAt('#/overview', mockFetch([]));

    expect(await screen.findByRole('heading', { name: 'Kom i gang' })).toBeTruthy();
    expect(screen.getByText('Ingen tjenester ennå')).toBeTruthy();
    expect(screen.getByText('Ingen datasett ennå')).toBeTruthy();
    expect(screen.getByText('Ingen endringer ennå')).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Ny tjeneste' })).toBeNull();
    expectAccessible();
  });

  it('marks the Datasett menu item with the number of ingestions to follow up', async () => {
    await renderAt('#/overview', withUsage(9_400_000));

    const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
    expect(within(menu).getByLabelText('2 innlesinger trenger oppfølging')).toBeTruthy();
  });

  it('counts the Datasett badge down as ingestions are retried', async () => {
    await renderAt('#/overview', withUsage(9_400_000));

    const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
    await within(menu).findByLabelText('2 innlesinger trenger oppfølging');
    fireEvent.click(screen.getByRole('button', { name: 'Prøv igjen: Nettsidene til Testetaten' }));
    expect(within(menu).getByLabelText('1 innlesing trenger oppfølging')).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Last opp på nytt: Tilsynsrapporter 2025' }),
    );
    expect(within(menu).getByRole('link', { name: 'Datasett' }).textContent).toBe('Datasett');
  });

  it('shows no Datasett badge for a tenant without datasets', async () => {
    await renderAt(
      '#/overview',
      mockFetch(exampleServices, [exampleTimeline], undefined, undefined, {
        usage: report(9_400_000),
        features: { datasets: { datasets: [] } },
      }),
    );

    expect(await screen.findByText('Ingen datasett ennå')).toBeTruthy();
    expect(screen.queryByText(/innlesinger? trenger oppfølging/)).toBeNull();
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(within(menu).getByRole('link', { name: 'Datasett' }).textContent).toBe('Datasett');
  });
});
