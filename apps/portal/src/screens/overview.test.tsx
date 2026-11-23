// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exampleServices, exampleTimeline, mockFetch } from '../mock';
import { expectAccessible, failingFetch, heldFetch, renderAt } from '../test-utils';
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
const nothingFailed = { ...noFailedDatasets, tasks: [] };

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

    expect(await screen.findByText(/Vi fikk ikke sjekket dokumentsamlingene/)).toBeTruthy();
    expect(screen.queryByText(/Ingenting trenger deg nå/)).toBeNull();
    expect(screen.getAllByRole('button', { name: 'Prøv igjen' }).length).toBeGreaterThan(0);
  });

  it('holds the shape of the page while it loads, with no lone spinner under the heading', async () => {
    const held = heldFetch(/\/overview$/);
    const { container } = await renderAt('#/overview', held.fetch);

    const loading = await screen.findByRole('status', { name: 'Henter oversikten' });
    expect(within(loading).getByRole('heading', { level: 2, name: 'Trenger deg nå' })).toBeTruthy();
    expect(container.querySelector('main .ds-spinner')).toBeNull();
    await held.release();
  });

  it('says nothing needs you only when every check worked and found nothing', async () => {
    await renderAt(
      '#/overview',
      replacing(/\/overview$/, calm, withUsage(normalUsage, nothingFailed)),
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

  it('lists a quota of 80 percent or more as needing you, with a button to ask for more', async () => {
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
    expect(await screen.findByRole('button', { name: 'Be om mer kvote' })).toBeTruthy();
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

  const today = '2026-10-07T10:00:00Z';
  const threeDaysAgo = '2026-10-04T10:00:00Z';
  const onFixedDay = () => vi.useFakeTimers({ now: new Date(today), toFake: ['Date'] });
  afterEach(() => vi.useRealTimers());

  const failedRun = (id: string, service: string, serviceName: string, createdAt: string) => ({
    id,
    status: 'failed',
    service,
    serviceName,
    capability: service,
    version: 1,
    environment: null,
    createdAt,
    endedAt: null,
  });

  const withFailedRuns = (
    rows: (ReturnType<typeof failedRun> & { failure?: unknown })[],
    total = rows.length,
  ) => {
    const asked: string[] = [];
    const base = replacing(
      /\/overview$/,
      {
        ...calm,
        services: [
          ...calm.services,
          { id: 'klarsprak', name: 'Klarspråk', latestVersion: 2, runsThisWeek: 8 },
        ],
      },
      withUsage(normalUsage, noFailedDatasets),
    );
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (/\/tasks\?/.test(url) && url.includes('status=failed')) {
        asked.push(url);
        return Response.json({ data: rows, total });
      }
      return base(input, init);
    };
    return { fetch, asked };
  };

  it('lists each service with runs that failed today as its own row, linked to the service and its runs today', async () => {
    onFixedDay();
    const now = today;
    const { fetch, asked } = withFailedRuns([
      failedRun('r1', 'klarsprak', 'Klarspråk', now),
      failedRun('r2', 'rapportassistenten', 'Rapportassistenten', now),
      failedRun('r3', 'klarsprak', 'Klarspråk', now),
    ]);
    await renderAt('#/overview', fetch);

    const attention = await screen.findByRole('region', { name: 'Trenger deg nå' });
    const rows = await within(attention).findAllByText('Feil i dag');
    expect(rows).toHaveLength(2);
    expect(within(attention).getByRole('link', { name: 'Klarspråk' }).getAttribute('href')).toBe(
      '#/services/klarsprak',
    );
    expect(within(attention).getByText(/2 kjøringer feilet i dag/)).toBeTruthy();
    const runs = within(attention).getByRole('link', { name: 'Se kjøringene: Klarspråk' });
    expect(runs.getAttribute('href')).toBe(
      '#/log/runs?status=failed&service=klarsprak&date=2026-10-07',
    );
    expect(asked.some((u) => /limit=500/.test(u))).toBe(true);
  });

  it('names the most common reason today next to the failed-run count', async () => {
    onFixedDay();
    const timeout = { code: 'deadline_exceeded', reason: 'Kjøringen tok for lang tid.' };
    const noModel = { code: 'model_error', reason: 'Vi fikk ikke svar fra modellen.' };
    const { fetch } = withFailedRuns([
      { ...failedRun('r1', 'klarsprak', 'Klarspråk', today), failure: noModel },
      { ...failedRun('r2', 'klarsprak', 'Klarspråk', today), failure: timeout },
      { ...failedRun('r3', 'klarsprak', 'Klarspråk', today), failure: timeout },
      { ...failedRun('r4', 'klarsprak', 'Klarspråk', threeDaysAgo), failure: noModel },
      { ...failedRun('r5', 'klarsprak', 'Klarspråk', threeDaysAgo), failure: noModel },
    ]);
    await renderAt('#/overview', fetch);

    const attention = await screen.findByRole('region', { name: 'Trenger deg nå' });
    expect(
      await within(attention).findByText(/3 kjøringer feilet i dag\. Kjøringen tok for lang tid\./),
    ).toBeTruthy();
  });

  it('never lists playground try runs as a service', async () => {
    onFixedDay();
    const now = today;
    const { fetch } = withFailedRuns([
      failedRun('r1', 'platform/operation-try/1b3570db', 'platform/operation-try/1b3570db', now),
    ]);
    await renderAt('#/overview', fetch);

    expect(await screen.findByText(/Ingenting trenger deg nå/)).toBeTruthy();
    expect(screen.queryByText(/operation-try/)).toBeNull();
  });

  it('never names a service Hjem does not list, such as an archived one, among the failed runs', async () => {
    onFixedDay();
    const { fetch } = withFailedRuns([failedRun('r1', 'smoke-throwaway', 'Røyktest', today)]);
    await renderAt('#/overview', fetch);

    expect(await screen.findByText(/Ingenting trenger deg nå/)).toBeTruthy();
    expect(screen.queryByText(/Røyktest/)).toBeNull();
  });

  it('counts the failed runs of the last 7 days per service in Mest brukt', async () => {
    onFixedDay();
    const weekAgo = threeDaysAgo;
    const { fetch } = withFailedRuns([
      failedRun('r1', 'klarsprak', 'Klarspråk', weekAgo),
      failedRun('r2', 'klarsprak', 'Klarspråk', weekAgo),
    ]);
    await renderAt('#/overview', fetch);

    const top = await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });
    expect(within(top).getByRole('columnheader', { name: 'Feil' })).toBeTruthy();
    const row = within(top).getByRole('link', { name: 'Klarspråk' }).closest('tr') as HTMLElement;
    await waitFor(() => expect(row.lastElementChild?.textContent).toBe('2'));
    expect(screen.queryByText('Feil i dag')).toBeNull();
  });

  it('says the failed-run count is a lower bound when more runs failed than one page holds', async () => {
    onFixedDay();
    const weekAgo = threeDaysAgo;
    const { fetch } = withFailedRuns([failedRun('r1', 'klarsprak', 'Klarspråk', weekAgo)], 900);
    await renderAt('#/overview', fetch);

    expect(await screen.findByText('minst 1')).toBeTruthy();
  });

  it('says the runs could not be checked instead of that nothing failed', async () => {
    await renderAt(
      '#/overview',
      failingFetch(/\/tasks\?status=failed/, 503, withUsage(normalUsage, noFailedDatasets)),
    );

    expect(await screen.findByText(/Vi fikk ikke sjekket kjøringene/)).toBeTruthy();
    expect(screen.queryByText(/Ingenting trenger deg nå/)).toBeNull();
  });

  it('shows a partly read ingestion with how many documents failed and a link to the files', async () => {
    await renderAt('#/overview', withUsage(normalUsage));

    const attention = await screen.findByRole('region', { name: 'Trenger deg nå' });
    expect(await within(attention).findByText('Delvis')).toBeTruthy();
    expect(
      within(attention).getByText(
        /2 av 8 dokumenter kunne ikke leses. Tjenestene bruker de 6 andre./,
      ),
    ).toBeTruthy();
    expect(
      within(attention)
        .getByRole('link', { name: 'Se filene: Veiledere og rundskriv' })
        .getAttribute('href'),
    ).toBe('#/datasets/veiledere/ingestions');
  });

  it('colours the usage bar amber from 80 percent of the quota', async () => {
    await renderAt(
      '#/overview',
      replacing(
        /\/settings\/effective$/,
        quotaSetting(10_000_000),
        withUsage(report({ rapportassistenten: 8_500_000 })),
      ),
    );

    const bar = await screen.findByRole('progressbar', { name: 'Brukt av månedens kvote' });
    expect(bar.firstElementChild?.className).toBe('quota-fill high');
  });

  it('shows the Utkast and På pause tags in Mest brukt', async () => {
    await renderAt(
      '#/overview',
      replacing(
        /\/overview$/,
        {
          ...calm,
          services: [
            { id: 'a', name: 'Vedtaksutkast', latestVersion: null, runsThisWeek: 3 },
            { id: 'b', name: 'Nettsider', latestVersion: 2, status: 'paused', runsThisWeek: 0 },
          ],
        },
        withUsage(normalUsage, noFailedDatasets),
      ),
    );

    const top = await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });
    expect(within(top).getByText('Utkast')).toBeTruthy();
    expect(within(top).getByText('På pause')).toBeTruthy();
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

  it('marks the Dokumentsamlinger menu item with the number of document collections to follow up', async () => {
    await renderAt('#/overview', withUsage(normalUsage));

    const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
    expect(
      await within(menu).findByLabelText('2 dokumentsamlinger trenger oppfølging'),
    ).toBeTruthy();
  });

  it('lists a dataset without a source as needing you, as the Dokumentsamlinger filter counts it', async () => {
    const withoutSource = {
      features: {
        datasets: {
          datasets: [
            {
              id: 'arkiv',
              fullId: '999888777/arkiv',
              name: 'Arkivet',
              description: '',
              scope: '999888777',
              editable: true,
              residency: 'norway',
              effectiveResidency: 'norway',
              index: { endpoint: 'platform-pg' },
              facets: [],
              searchScope: 'tenant',
              source: 'none',
              documents: 0,
              chunks: 0,
              usedBy: [],
              lastExecution: null,
              nextRunAt: null,
              skipped: [],
            },
          ],
        },
      },
    } as Parameters<typeof mockFetch>[4];
    await renderAt('#/overview', withUsage(normalUsage, withoutSource));

    const attention = await screen.findByRole('region', { name: 'Trenger deg nå' });
    expect(await within(attention).findByText('Ingen kilde')).toBeTruthy();
    expect(
      within(attention)
        .getByRole('link', { name: 'Se dokumentsamlingen: Arkivet' })
        .getAttribute('href'),
    ).toBe('#/datasets/999888777%2Farkiv');
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(await within(menu).findByLabelText('1 dokumentsamling trenger oppfølging')).toBeTruthy();
  });

  it('lists a Digdir dataset that needs follow-up, since the Dokumentsamlinger badge counts it', async () => {
    const sharedDegraded = {
      features: {
        datasets: {
          datasets: [
            {
              id: 'kudos',
              fullId: 'digdir/kudos',
              name: 'Kudos',
              description: '',
              scope: 'platform',
              editable: false,
              residency: 'norway',
              effectiveResidency: 'norway',
              index: { endpoint: 'platform-pg' },
              facets: [],
              searchScope: 'tenant',
              source: 'kudos',
              documents: 10,
              chunks: 10,
              usedBy: [],
              lastExecution: {
                status: 'cancelled',
                startedAt: '2026-10-01T01:00:00Z',
                endedAt: '2026-10-01T01:10:00Z',
                stored: 0,
                skipped: 0,
              },
              nextRunAt: null,
              skipped: [],
            },
          ],
        },
      },
    } as Parameters<typeof mockFetch>[4];
    await renderAt('#/overview', withUsage(normalUsage, sharedDegraded));

    const menu = await screen.findByRole('navigation', { name: 'Hovedmeny' });
    expect(await within(menu).findByLabelText('1 dokumentsamling trenger oppfølging')).toBeTruthy();
    const attention = screen.getByRole('region', { name: 'Trenger deg nå' });
    expect(
      within(attention).getByRole('link', { name: 'Se dokumentsamlingen: Kudos' }),
    ).toBeTruthy();
    expect(within(attention).queryByText(/Ingenting trenger deg nå/)).toBeNull();
  });

  it('shows no Dokumentsamlinger badge for a tenant without document collections', async () => {
    await renderAt('#/overview', withUsage(normalUsage, noFailedDatasets));

    await screen.findByRole('heading', { name: 'Trenger deg nå' });
    const menu = screen.getByRole('navigation', { name: 'Hovedmeny' });
    expect(within(menu).getByRole('link', { name: 'Dokumentsamlinger' }).textContent).toBe(
      'Dokumentsamlinger',
    );
  });
});

describe('Oversikt: the usage card and the service count', () => {
  const lowerBound = (): UsageReport => {
    const base = report({ rapportassistenten: 3_000_000 });
    const partly = (u: UsageTotals): UsageTotals => ({ ...u, priced: false });
    return {
      ...base,
      priced: false,
      totals: { ...partly(base.totals), unpricedModels: ['ai-gateway/borealis-27b'] },
      daily: base.daily.map((d) => ({ ...d, usage: partly(d.usage) })),
    } as UsageReport;
  };

  it('shows the cost as at least the priced part and names the model without a price, as Statistikk does', async () => {
    const models = { data: [{ id: 'ai-gateway/borealis-27b', name: 'Borealis 27B' }] };
    await renderAt('#/overview', replacing(/\/models$/, models, withUsage(lowerBound())));

    const usage = await screen.findByRole('region', { name: /Bruk i/ });
    expect(
      (await within(usage).findByText('Anslått kostnad')).nextElementSibling?.textContent,
    ).toBe('minst 1,00 kr');
    expect(
      await within(usage).findByText(
        'Prisen mangler for modellen Borealis 27B, så kostnaden er minst dette.',
      ),
    ).toBeTruthy();
    expect(within(usage).queryByText('Ikke priset')).toBeNull();
  });

  it('names a model without a price even when the policy holds it back, since it asks for all models', async () => {
    const held = [
      {
        id: 'ai-gateway/borealis-27b',
        name: 'Borealis 27B',
        residency: 'norway' as const,
        capabilities: [],
        available: false,
      },
    ];
    await renderAt(
      '#/overview',
      mockFetch(exampleServices, [exampleTimeline], held, undefined, { usage: lowerBound() }),
    );

    const usage = await screen.findByRole('region', { name: /Bruk i/ });
    expect(
      await within(usage).findByText(
        'Prisen mangler for modellen Borealis 27B, så kostnaden er minst dette.',
      ),
    ).toBeTruthy();
  });

  it('counts the same services as the Tjenester list: unpublished drafts and every service not archived', async () => {
    const summary = (id: string, lifecycle: 'active' | 'paused' | 'archived') => ({
      id,
      name: id,
      purpose: '',
      outputKind: 'answer',
      channels: [],
      latestVersion: 1,
      status: lifecycle === 'paused' ? 'paused' : 'active',
      statusReason: null,
      lifecycle,
      runsThisWeek: 0,
    });
    const draft = (id: string, latestVersion: number | null) => ({
      id,
      name: id,
      purpose: '',
      outputKind: 'answer',
      latestVersion,
      revision: 1,
      at: '2026-10-07T10:00:00Z',
      by: 'kari',
    });
    const fetch = replacing(
      /\/service-drafts$/,
      { data: [draft('ny', null), draft('a', 1)] },
      replacing(
        /\/services$/,
        { data: [summary('a', 'active'), summary('b', 'paused'), summary('c', 'archived')] },
        withUsage(normalUsage),
      ),
    );
    await renderAt('#/overview', fetch);

    const top = await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });
    expect(await within(top).findByRole('link', { name: 'Alle 3 tjenester' })).toBeTruthy();
  });

  it('writes the month in lower case in Norwegian, as in running text', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T10:00:00Z'), toFake: ['Date'] });
    try {
      await renderAt('#/overview', withUsage(normalUsage));
      expect(await screen.findByText(/· november 2026$/)).toBeTruthy();
    } finally {
      vi.useRealTimers();
    }
  });
});
