// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exampleServices, exampleTimeline, mockFetch } from '../mock';
import { expectAccessible, failingFetch, renderAt } from '../test-utils';
import type { Overview, UsageReport, UsageTotals } from '../types';

const totals = (
  tokens: number,
  runs: number,
  costMicroNok: number | null = 1_000_000,
): UsageTotals => ({
  inputTokens: Math.round(tokens * 0.9),
  outputTokens: tokens - Math.round(tokens * 0.9),
  requests: runs,
  runs,
  costMicroNok,
});

const report = (byService: Record<string, number>, extra = 0, priced = true): UsageReport => {
  const cost = priced ? 1_000_000 : null;
  const services = Object.fromEntries(
    Object.entries(byService).map(([id, tokens]) => [id, totals(tokens, 10, cost)]),
  );
  const all = Object.values(byService).reduce((n, v) => n + v, 0) + extra;
  return {
    from: '2026-10-01T00:00:00Z',
    to: '2026-10-07T10:00:00Z',
    priced,
    totals: totals(all, 30, cost),
    daily: [{ date: '2026-10-07', usage: totals(all, 30, cost), byService: services }],
    byService: Object.entries(services).map(([service, usage]) => ({ service, usage })),
    byModel: [],
  };
};

const withUsage = (usage: UsageReport, base?: Parameters<typeof mockFetch>[4]) =>
  mockFetch(exampleServices, [exampleTimeline], undefined, undefined, { usage, ...base });

const replacing =
  (pattern: RegExp, body: unknown, base: typeof fetch): typeof fetch =>
  async (input, init) =>
    pattern.test(String(input)) && (init?.method ?? 'GET') === 'GET'
      ? Response.json(body)
      : base(input, init);

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

const calm: Overview = {
  services: [
    { id: 'rapportassistenten', name: 'Rapportassistenten', latestVersion: 3, runsThisWeek: 12 },
  ],
  recentTasks: [],
  qualityWarnings: [],
  review: { pendingToolChanges: 0, failedTasksLastDay: 0 },
};

const noFailedDatasets = { features: { datasets: { datasets: [] } } };

const normalUsage = report({ rapportassistenten: 3_000_000, postsortering: 2_000_000 });

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('Oversikt', () => {
  it('leads with what needs you now, before the most used services and the usage', async () => {
    await renderAt('#/overview', withUsage(normalUsage));

    const attention = await screen.findByRole('heading', { level: 2, name: 'Trenger deg nå' });
    const top = screen.getByRole('heading', { level: 2, name: 'Mest brukt siste 7 dager' });
    expect(attention.compareDocumentPosition(top) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Ny tjeneste' }).getAttribute('href')).toBe(
      '#/services/new',
    );
    expectAccessible();
  });

  it('starts a failed ingestion again through the ingestion endpoint and shows it running', async () => {
    const calls: string[] = [];
    const base = withUsage(normalUsage);
    await renderAt('#/overview', async (input, init) => {
      if (init?.method === 'POST') calls.push(String(input));
      return base(input, init);
    });

    fireEvent.click(
      await screen.findByRole('button', { name: 'Prøv igjen: Nettsidene til Testetaten' }),
    );

    expect(await screen.findByText('Leser inn')).toBeTruthy();
    expect(calls.some((url) => /datasets\/nettsider\/pipelines\/website\/execute$/.test(url))).toBe(
      true,
    );
  });

  it('says the datasets could not be checked instead of that nothing needs you', async () => {
    await renderAt(
      '#/overview',
      replacing(
        /\/overview$/,
        calm,
        failingFetch(/\/tenants\/[^/]+\/datasets$/, 503, withUsage(normalUsage)),
      ),
    );

    expect(await screen.findByText(/Vi fikk ikke sjekket datasettene/)).toBeTruthy();
    expect(screen.queryByText(/Ingenting trenger deg nå/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Prøv igjen' }).length).toBeGreaterThan(0);
  });

  it('says nothing needs you only when every check worked and found nothing', async () => {
    await renderAt(
      '#/overview',
      replacing(/\/overview$/, calm, withUsage(normalUsage, noFailedDatasets)),
    );

    expect(await screen.findByText(/Ingenting trenger deg nå. Sist sjekket kl./)).toBeTruthy();
  });

  it('shows trial runs as their own part, so the parts add up to the month total', async () => {
    await renderAt(
      '#/overview',
      withUsage(
        report(
          { rapportassistenten: 6_000_000, 'platform/operation-try/abc': 1_000_000 },
          2_000_000,
        ),
      ),
    );

    const usage = await screen.findByRole('region', { name: /Bruk i/ });
    expect(await within(usage).findByText('9 mill.')).toBeTruthy();
    expect(within(usage).getByText('Tjenestene').nextElementSibling?.textContent).toBe('6 mill.');
    expect(within(usage).getByText('Prøvekjøringer').nextElementSibling?.textContent).toBe(
      '3 mill.',
    );
    expect(screen.queryByText(/Operation try/)).toBeNull();
  });

  it('shows Ikke priset, never 0 kr, when the usage is not priced', async () => {
    await renderAt('#/overview', withUsage(report({ rapportassistenten: 3_000_000 }, 0, false)));

    const usage = await screen.findByRole('region', { name: /Bruk i/ });
    expect(
      (await within(usage).findByText('Anslått kostnad')).nextElementSibling?.textContent,
    ).toBe('Ikke priset');
  });

  it('says the quota is not set instead of inventing one', async () => {
    const base = withUsage(normalUsage);
    await renderAt('#/overview', replacing(/\/settings\/effective$/, {}, base));

    expect(await screen.findByText('tokens. Kvoten er ikke oppgitt.')).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Brukt av månedens kvote' })).toBeNull();
  });

  it('lists a quota of 80 percent or more as needing you, without a request button it cannot send', async () => {
    await renderAt(
      '#/overview',
      replacing(
        /\/settings\/effective$/,
        quotaSetting(10_000_000),
        withUsage(report({ rapportassistenten: 9_000_000 })),
      ),
    );

    expect(await screen.findByText('Kvote 90 %')).toBeTruthy();
    expect(screen.getByText(/9 av 10 mill. tokens er brukt i/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /kvote/i })).toBeNull();
  });

  it('says the quota is used up when usage is past it, never that it is nearly used', async () => {
    await renderAt(
      '#/overview',
      replacing(
        /\/settings\/effective$/,
        quotaSetting(1_000_000),
        withUsage(report({ rapportassistenten: 3_000_000 })),
      ),
    );

    expect(await screen.findByText('Kvote 300 %')).toBeTruthy();
    expect(screen.getByText(/er brukt opp/)).toBeTruthy();
  });

  it('keeps the page usable when usage cannot be fetched and offers a retry', async () => {
    await renderAt('#/overview', failingFetch(/\/usage/));

    expect(await screen.findByText(/Vi fikk ikke hentet bruken/)).toBeTruthy();
    expect(screen.getByText(/Vi fikk ikke sjekket kvoten/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Mest brukt siste 7 dager' })).toBeTruthy();
  });

  it('names the services whose runs failed in the last day and links each to its failed runs', async () => {
    const failed = (id: string, service: string, serviceName: string) => ({
      id,
      status: 'failed',
      service,
      serviceName,
      capability: service,
      version: 1,
      environment: null,
      createdAt: new Date().toISOString(),
      endedAt: null,
    });
    const asked: string[] = [];
    const base = replacing(
      /\/overview$/,
      { ...calm, review: { pendingToolChanges: 0, failedTasksLastDay: 3 } },
      withUsage(normalUsage, noFailedDatasets),
    );
    await renderAt('#/overview', async (input, init) => {
      const url = String(input);
      if (/\/tasks\?/.test(url)) {
        asked.push(url);
        if (url.includes('status=failed') && url.includes('from='))
          return Response.json({
            data: [
              failed('r1', 'klarsprak', 'Klarspråk'),
              failed('r2', 'postsortering', 'Postsortering'),
              failed('r3', 'klarsprak', 'Klarspråk'),
            ],
            total: 3,
          });
      }
      return base(input, init);
    });

    const link = await screen.findByRole('link', { name: '2 feilede kjøringer i Klarspråk' });
    expect(link.getAttribute('href')).toBe('#/log?status=failed&service=klarsprak');
    expect(
      screen.getByRole('link', { name: '1 feilet kjøring i Postsortering' }).getAttribute('href'),
    ).toBe('#/log?status=failed&service=postsortering');
    expect(screen.getByText(/3 kjøringer feilet det siste døgnet/)).toBeTruthy();
    expect(asked.some((u) => /status=failed/.test(u) && /limit=500/.test(u))).toBe(true);
  });

  it('opens Logg filtered on the service and status named in the address', async () => {
    const asked: string[] = [];
    const base = mockFetch();
    await renderAt('#/log?status=failed&service=rapportassistenten', async (input, init) => {
      if (/\/tasks(\?|$)/.test(String(input))) asked.push(String(input));
      return base(input, init);
    });

    await waitFor(() =>
      expect(
        asked.some((u) => u.includes('status=failed') && u.includes('service=rapportassistenten')),
      ).toBe(true),
    );
    await waitFor(() =>
      expect((screen.getByLabelText('Tjeneste') as HTMLSelectElement).value).toBe(
        'rapportassistenten',
      ),
    );
  });

  it('shows a checklist that ticks itself off for a tenant without services', async () => {
    await renderAt('#/overview', mockFetch([]));

    expect(await screen.findByRole('heading', { name: 'Kom i gang med Testetaten' })).toBeTruthy();
    expect(await screen.findByText('1 av 4 steg er gjort')).toBeTruthy();
    expect(screen.getByRole('heading', { name: /1. Legg til en kilde \(gjort\)/ })).toBeTruthy();
    expect(screen.getByRole('heading', { name: /2. Lag tjenesten \(ikke gjort\)/ })).toBeTruthy();
    expectAccessible();
  });

  it('marks the Datasett menu item with the number of ingestions to follow up', async () => {
    await renderAt('#/overview', withUsage(normalUsage));

    const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
    expect(await within(menu).findByLabelText('1 innlesing trenger oppfølging')).toBeTruthy();
  });

  it('shows no Datasett badge for a tenant without datasets', async () => {
    await renderAt('#/overview', withUsage(normalUsage, noFailedDatasets));

    await screen.findByRole('heading', { name: 'Trenger deg nå' });
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(within(menu).getByRole('link', { name: 'Datasett' }).textContent).toBe('Datasett');
  });
});
