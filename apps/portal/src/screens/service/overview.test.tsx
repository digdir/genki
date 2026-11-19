// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { createApiClient } from '../../api';
import type { ServiceDefinition } from '../../data/service-definition';
import { RightsProvider } from '../../Shell';
import type { TaskRow } from '../../types';
import { OverviewSection } from './OverviewSection';
import { ArchivedBanner, LifecycleDialog } from './ServiceLifecycle';

document.getAnimations ??= () => [];
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ');
afterEach(cleanup);

const tenant = '991825827';
const now = () => new Date('2026-11-17T15:00:00+01:00');

const definition = {
  apiVersion: 'genai/v1',
  kind: 'Service',
  metadata: { tenant, id: 'rapport', name: 'Rapportassistenten', version: 7 },
  spec: {
    purpose: 'Svarer på spørsmål om tidligere tilsyn.',
    input: { accepts: ['text/plain'] },
    output: { kind: 'answer' },
    strategy: { id: 'single-call', version: 1, config: { instructions: 'Svar kort.' } },
    model: { primary: 'foundry-openai/gpt-5.6-terra', residency: 'global' },
    knowledge: { datasets: [{ dataset: `${tenant}/tilsyn` }] },
  },
} as unknown as ServiceDefinition;

const run = (id: string, status: string, createdAt: string, excerpt?: string): TaskRow => ({
  id,
  status,
  service: 'rapport',
  capability: `${tenant}/rapport/default`,
  createdAt,
  endedAt: new Date(Date.parse(createdAt) + 4200).toISOString(),
  ...(excerpt ? { excerpt } : {}),
});

interface Call {
  method: string;
  url: URL;
  headers: Headers;
  body: unknown;
}

const platform = (
  overrides: {
    lifecycle?: unknown;
    totals?: (q: URLSearchParams) => number;
    recent?: TaskRow[];
    usageRuns?: number;
    failedReason?: string;
    usage?: Record<string, unknown>;
    lastExecution?: unknown;
    limits?: unknown[];
    operator?: { name: string; region?: string };
    failure?: Record<string, unknown>;
  } = {},
) => {
  const calls: Call[] = [];
  let lifecycle: unknown = overrides.lifecycle ?? { state: 'active' };
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw.replace(/^\/api/, ''), 'http://portal');
    const method = init?.method ?? 'GET';
    calls.push({
      method,
      url,
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const path = url.pathname;
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (path.endsWith('/access/services')) return reply({ services: overrides.limits ?? [] });
    if (path.endsWith('/lifecycle')) {
      if (method === 'PUT') lifecycle = JSON.parse(String(init?.body)) as unknown;
      return reply(lifecycle);
    }
    if (path.endsWith('/usage'))
      return reply({
        byService: [
          {
            service: 'rapport',
            usage: {
              costMicroNok: 237_000_000,
              requests: overrides.usageRuns ?? 10_680,
              runs: overrides.usageRuns ?? 10_680,
              ...overrides.usage,
            },
          },
        ],
      });
    if (path.endsWith('/timeline'))
      return reply({
        steps: [{ id: 'e1', type: 'error', summary: 'modellen svarte ikke innen 30 sekunder.' }],
      });
    if (path.endsWith('/tasks')) {
      const q = url.searchParams;
      if (q.get('limit') === '5') return reply({ data: overrides.recent ?? [], total: 0 });
      const total = overrides.totals?.(q) ?? 0;
      const data =
        q.get('status') === 'failed' && total
          ? [
              {
                ...run('f1', 'failed', '2026-11-17T13:57:00Z'),
                ...(overrides.failedReason
                  ? { failure: { code: 'deadline_exceeded', reason: overrides.failedReason } }
                  : {}),
                ...(overrides.failure ? { failure: overrides.failure } : {}),
              },
            ]
          : [];
      return reply({ data, total });
    }
    if (path.endsWith('/datasets'))
      return reply({
        data: [
          {
            id: 'tilsyn',
            fullId: `${tenant}/tilsyn`,
            name: 'Tilsynsrapporter 2025',
            lastExecution: overrides.lastExecution ?? null,
          },
        ],
      });
    if (path === '/models')
      return reply({
        data: [
          {
            id: 'foundry-openai/gpt-5.6-terra',
            name: 'gpt-5.6-terra',
            residency: 'eu',
            ...(overrides.operator ? { operator: overrides.operator } : {}),
          },
        ],
      });
    return new Response(JSON.stringify({ title: 'Not found', status: 404 }), { status: 404 });
  };
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' }) };
};

const asManager = (ui: ReactNode) => (
  <RightsProvider value={['manage-services']}>{ui}</RightsProvider>
);

const day = (
  date: string,
  runs: number,
  failed = 0,
  cost = 1_000_000,
  latency: { p50Ms: number; p95Ms: number; runs: number } | null = {
    p50Ms: 1800,
    p95Ms: 6400,
    runs,
  },
) => ({
  date,
  usage: { runs, requests: runs, costMicroNok: cost },
  byService: {
    rapport: { runs, requests: runs, failedRequests: failed, costMicroNok: cost, latency },
  },
});

const serviceKey = (
  id: string,
  name: string,
  extra: { client?: string; revokedAt?: string; lastUsedAt?: string } = {},
) => ({
  id,
  name,
  service: 'rapport',
  client: extra.client ?? null,
  revokedAt: extra.revokedAt ?? null,
  createdAt: '2026-11-01T09:00:00Z',
  lastUsedAt: extra.lastUsedAt ?? '2026-11-17T09:00:00Z',
});

const health = (
  overrides: {
    latency?: { p50Ms: number; p95Ms: number; runs: number } | null;
    failures?: unknown[];
    shared?: unknown;
    recent?: TaskRow[];
    total?: number;
    keys?: unknown[];
    hold?: RegExp;
    daily?: unknown[];
    runs?: unknown[];
    drafts?: unknown[];
    keyTotals?: Record<string, number>;
    checks?: unknown;
    gates?: unknown[];
    sets?: unknown[];
    datasets?: unknown[];
  } = {},
) => {
  const calls: string[] = [];
  const waiting: (() => void)[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw.replace(/^\/api/, ''), 'http://portal');
    const path = url.pathname;
    calls.push(`${path}${url.search}`);
    if (overrides.hold?.test(path)) await new Promise<void>((done) => waiting.push(done));
    const reply = (body: unknown) =>
      new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    if (path.endsWith('/usage'))
      return reply({
        from: '2026-10-17',
        to: '2026-11-17',
        priced: true,
        totals: { runs: 0 },
        daily: overrides.daily ?? [
          day('2026-11-15', 90, 0, 1_000_000, { p50Ms: 2400, p95Ms: 7000, runs: 90 }),
          day('2026-11-16', 110, 0, 1_000_000, { p50Ms: 1200, p95Ms: 5000, runs: 110 }),
          day(
            '2026-11-17',
            120,
            6,
            1_000_000,
            overrides.latency === undefined
              ? { p50Ms: 1800, p95Ms: 6400, runs: 120 }
              : overrides.latency,
          ),
        ],
        byService: [
          {
            service: 'rapport',
            usage: { runs: 120, requests: 120, costMicroNok: 3_000_000 },
            latency:
              overrides.latency === undefined
                ? { p50Ms: 1800, p95Ms: 6400, runs: 120 }
                : overrides.latency,
          },
        ],
        byModel: [],
      });
    if (path.endsWith('/service-failures'))
      return reply({
        from: url.searchParams.get('from'),
        data: overrides.failures ?? [
          {
            service: 'rapport',
            failed: 6,
            causes: [
              { code: 'deadline_exceeded', reason: 'Modellen svarte ikke i tide', count: 4 },
              { code: 'guardrail', reason: 'Stoppet av vern', count: 2 },
            ],
          },
        ],
      });
    if (path.endsWith('/shared-with'))
      return reply(
        overrides.shared ?? {
          frontends: [
            { id: 'innsyn', name: 'Innsynsportalen', kind: 'browser', channels: ['web'] },
          ],
          apiKeys: [{ id: 'k1', name: 'Saksbehandling', bound: true }],
          tenants: ['974760673'],
        },
      );
    if (path.endsWith('/eval-runs')) return reply({ data: overrides.runs ?? [] });
    if (path.endsWith('/test-sets')) return reply({ data: overrides.sets ?? [] });
    if (path.endsWith('/datasets') && overrides.datasets)
      return reply({ data: overrides.datasets });
    if (path.endsWith('/service-drafts')) return reply({ data: overrides.drafts ?? [] });
    if (path.endsWith('/draft/checks') && overrides.checks) return reply(overrides.checks);
    if (path.endsWith('/gates')) return reply({ data: overrides.gates ?? [] });
    if (path.endsWith('/tasks') && url.searchParams.get('limit') === '1')
      return reply({
        data: [],
        total:
          overrides.keyTotals?.[
            url.searchParams.get('actor') ??
              (url.searchParams.get('frontend')
                ? `frontend:${url.searchParams.get('frontend')}`
                : '')
          ] ??
          overrides.total ??
          1,
        offset: 0,
        limit: 1,
      });
    if (path.endsWith('/tasks'))
      return reply({
        data: overrides.recent ?? [
          run('t1', 'completed', '2026-11-17T13:50:00Z', 'Hva sa tilsynet?'),
        ],
        total: overrides.total ?? 1,
        offset: 0,
        limit: 6,
      });
    if (path.endsWith('/api-keys'))
      return reply({ keys: overrides.keys ?? [serviceKey('k1', 'Saksbehandling')] });
    if (path.endsWith('/access/services')) return reply({ services: [] });
    if (path.endsWith('/lifecycle')) return reply({ state: 'active' });
    if (path.endsWith('/definitions/services/rapport'))
      return reply({
        latest: {
          kind: 'Service',
          tenant,
          id: 'rapport',
          version: 7,
          publishedBy: 'employee:ansattporten:kari',
          publishedByName: 'Kari Nordmann',
          publishedAt: '2026-11-10T09:00:00Z',
          definition,
        },
        versions: [],
      });
    if (path === '/models')
      return reply({
        data: [{ id: 'foundry-openai/gpt-5.6-terra', name: 'gpt-5.6-terra', residency: 'eu' }],
      });
    return new Response(JSON.stringify({ title: 'Not found', status: 404 }), { status: 404 });
  };
  return {
    calls,
    release: () => waiting.splice(0).forEach((done) => done()),
    api: createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' }),
  };
};

const tile = (name: RegExp) => screen.getByRole('link', { name });

const draftSummary = {
  id: 'rapport',
  name: 'Rapportassistenten',
  purpose: '',
  outputKind: 'answer',
  latestVersion: 7,
  revision: 4,
  at: '2026-11-17T09:00:00Z',
  by: 'employee:x:kari',
};

describe('the Oversikt tab of a published service', () => {
  it('shows the median and 95th percentile latency of the service today', async () => {
    const { api } = health();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() => expect(text(tile(/^Svartid/))).toContain('Median i dag. 95 % under'));
    expect(text(tile(/^Svartid/))).toMatch(/1,8 s.*6,4 s/);
  });

  it('says there is no latency yet instead of inventing one when the service has no timed runs', async () => {
    const { api } = health({ latency: null });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() => expect(text(tile(/^Svartid/))).toContain('Ingen data'));
  });

  it('shows the failures of today with their most common cause', async () => {
    const { api, calls } = health();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const need = await screen.findByText('6 kjøringer feilet i dag');
    expect(text(need.parentElement)).toContain(
      'Vanligste årsak: Modellen svarte ikke i tide (4 av 6).',
    );
    expect(
      within(need.parentElement as HTMLElement)
        .getByRole('link', { name: 'Se de feilede kjøringene' })
        .getAttribute('href'),
    ).toBe('#/services/rapport/log?status=failed&period=today');
    await waitFor(() =>
      expect(text(tile(/^Andel med feil i dag/))).toContain(
        '6 av 120. Vanligste: Modellen svarte ikke i tide',
      ),
    );
    const from = calls.find((c) => c.startsWith('/tenants/991825827/service-failures'));
    expect(decodeURIComponent(from ?? '')).toContain(
      `from=${new Date(2026, 10, 17).toISOString()}`,
    );
  });

  it('shows Trenger deg only once every source of it has arrived', async () => {
    const { api, release } = health({ hold: /service-failures$/ });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await screen.findByRole('heading', { name: 'Siste endringer' });
    expect(screen.queryByRole('heading', { name: 'Trenger deg' })).toBeNull();
    release();
    const heading = await screen.findByRole('heading', { name: 'Trenger deg' });
    const section = heading.closest('section') as HTMLElement;
    expect(await within(section).findByText('6 kjøringer feilet i dag')).toBeTruthy();
  });

  it('lists who the service is shared with: frontends, API keys and other organisations', async () => {
    const { api } = health();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const who = await screen.findByRole('region', { name: 'Hvem bruker den' });
    await waitFor(() => expect(within(who).getByText('Innsynsportalen')).toBeTruthy());
    expect(within(who).getByText('Én API-nøkkel')).toBeTruthy();
    expect(text(who)).toContain('Delt med én annen virksomhet');
  });

  it('says a service is not reachable yet when nothing is shared with it', async () => {
    const { api } = health({ shared: { frontends: [], apiKeys: [], tenants: [] }, keys: [] });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const who = await screen.findByRole('region', { name: 'Hvem bruker den' });
    await waitFor(() => expect(within(who).getByText('Ingen brukerflater')).toBeTruthy());
    expect(within(who).getByText('Ingen API-nøkler')).toBeTruthy();
    expect(text(who)).toContain('Ikke delt med andre virksomheter');
  });

  it('links each question in Siste kjøringer to its run in Logg', async () => {
    const { api } = health();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const link = await screen.findByRole('link', { name: 'Hva sa tilsynet?' });
    expect(link.getAttribute('href')).toBe('#/services/rapport/log/t1');
  });

  it('shows the steps that are left instead of empty figures when a published service has no runs', async () => {
    const { api } = health({ recent: [], total: 0 });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    expect(
      await screen.findByRole('heading', {
        name: 'Versjon 7 er publisert. Dette gjenstår før folk tar den i bruk',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Lag et testsett')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Trenger deg' })).toBeNull();
  });

  it('shows a daily bar per day of the median latency', async () => {
    const { api } = health();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() => expect(text(tile(/^Svartid/))).toContain('1,8 s'));
    const bars = [...tile(/^Svartid/).querySelectorAll('.ov-bars > span')] as HTMLElement[];
    expect(bars.map((b) => b.style.height)).toEqual(['100%', '50%', '75%']);
  });

  it('labels the channel of each recent run, not who started it', async () => {
    const person = { kind: 'person' as const, id: 'employee:x:ola', name: 'Ola Hansen' };
    const key = { kind: 'api-key' as const, id: 'api-key:k1', name: 'Saksbehandling' };
    const bot = { kind: 'api-key' as const, id: 'api-key:k2', name: 'Teams-bot' };
    const at = (m: number) => `2026-11-17T13:${String(10 + m).padStart(2, '0')}:00Z`;
    const { api } = health({
      recent: [
        {
          ...run('r0', 'completed', at(7), 'Spørsmål 0'),
          channel: 'interface',
          frontend: 'innsyn',
          actor: person,
        },
        { ...run('r1', 'completed', at(6), 'Spørsmål 1'), channel: 'interface', actor: bot },
        { ...run('r2', 'completed', at(5), 'Spørsmål 2'), channel: 'api-key', actor: key },
        { ...run('r3', 'completed', at(4), 'Spørsmål 3'), channel: 'api', actor: person },
        { ...run('r4', 'completed', at(3), 'Spørsmål 4'), channel: 'playground', actor: person },
        { ...run('r5', 'completed', at(2), 'Spørsmål 5'), channel: 'batch', actor: person },
        { ...run('r6', 'completed', at(1), 'Spørsmål 6'), channel: null },
      ],
      total: 7,
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const table = await screen.findByRole('region', { name: 'Siste kjøringer' });
    await within(table).findByText('Innsynsportalen');
    const channels = within(table)
      .getAllByRole('row')
      .slice(1)
      .map((row) => text(within(row).getAllByRole('cell')[2]));
    expect(channels).toEqual([
      'Innsynsportalen',
      'Teams-bot',
      'API: Saksbehandling',
      'API',
      'Prøveområdet',
      'Samlet jobb',
      'Utløser',
    ]);
    expect(within(table).queryByText('Ola Hansen')).toBeNull();
  });

  it('decides the draft is untested from the revision the last test run tested', async () => {
    const draftRun = (revision: number) => ({
      id: `d${revision}`,
      status: 'completed',
      testSet: 'kjerne',
      version: 'draft',
      draftRevision: revision,
      startedAt: '2026-11-17T10:30:00Z',
      endedAt: '2026-11-17T10:40:00Z',
      score: 0.9,
      passed: 9,
      total: 10,
    });
    const summary = {
      id: 'rapport',
      name: 'Rapportassistenten',
      purpose: '',
      outputKind: 'answer',
      latestVersion: 7,
      revision: 4,
      at: '2026-11-17T09:00:00Z',
      by: 'employee:x:kari',
      byName: 'Kari Nordmann',
    };
    const { api } = health({ runs: [draftRun(3)], drafts: [summary] });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const need = await screen.findByText('Utkastet er endret etter siste test');
    expect(text(need.parentElement)).toContain('Testet 11:40, endret 10:00.');
    cleanup();

    const tested = health({ runs: [draftRun(4)], drafts: [summary] });
    render(
      <OverviewSection
        api={tested.api}
        tenant={tenant}
        id="rapport"
        definition={definition}
        now={now}
      />,
    );
    const section = (await screen.findByRole('heading', { name: 'Trenger deg' })).closest(
      'section',
    ) as HTMLElement;
    await waitFor(() => expect(section.getAttribute('aria-busy')).toBeNull());
    expect(within(section).queryByText(/Utkastet er/)).toBeNull();
  });

  it('names the gate that stops publishing in its own words, not the API message', async () => {
    const summary = {
      id: 'rapport',
      name: 'Rapportassistenten',
      purpose: '',
      outputKind: 'answer',
      latestVersion: 7,
      revision: 4,
      at: '2026-11-17T09:00:00Z',
      by: 'employee:x:kari',
    };
    const draftRun = {
      id: 'd4',
      status: 'completed',
      testSet: 'kjerne',
      version: 'draft',
      draftRevision: 4,
      startedAt: '2026-11-17T10:30:00Z',
      endedAt: '2026-11-17T10:40:00Z',
      score: 0.9,
      passed: 9,
      total: 10,
      metrics: { refusal: { mean: 0.89, n: 9 } },
    };
    const { api } = health({
      runs: [draftRun],
      drafts: [summary],
      checks: {
        service: 'rapport',
        revision: 4,
        ready: false,
        problems: [
          {
            path: 'spec.evaluation.gates',
            message: 'refused by evaluation gates (avslag-uten-kilde)',
          },
        ],
      },
      gates: [
        {
          id: 'avslag-uten-kilde',
          version: 1,
          spec: { kind: 'threshold', metric: 'refusal', threshold: 0.9 },
        },
      ],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const need = await screen.findByText('Utkastet stoppes av en sperre');
    await waitFor(() =>
      expect(text(need.parentElement)).toContain(
        'Én sperre stopper publisering: Avslag uten kilde er 89 %, kravet er 90 %.',
      ),
    );
    expect(text(need.parentElement)).not.toContain('refused by');
  });

  it('names only a refused gate that the draft run fails, not the first gate the API lists', async () => {
    const { api } = health({
      runs: [
        {
          id: 'd4',
          status: 'completed',
          testSet: 'kjerne',
          version: 'draft',
          draftRevision: 4,
          startedAt: '2026-11-17T10:30:00Z',
          endedAt: '2026-11-17T10:40:00Z',
          score: 0.9,
          passed: 9,
          total: 10,
          metrics: { 'judge.criteria': { mean: 0.9, n: 10 }, refusal: { mean: 0.89, n: 9 } },
        },
      ],
      drafts: [draftSummary],
      checks: {
        service: 'rapport',
        revision: 4,
        ready: false,
        problems: [
          {
            path: 'spec.evaluation',
            message:
              'refused by evaluation gates (andel-bestatt, avslag-uten-kilde); run the test sets with subject x first',
          },
        ],
      },
      gates: [
        {
          id: 'andel-bestatt',
          version: 1,
          spec: { kind: 'threshold', metric: 'judge.criteria', threshold: 0.8 },
        },
        {
          id: 'avslag-uten-kilde',
          version: 1,
          spec: { kind: 'threshold', metric: 'refusal', threshold: 0.9 },
        },
      ],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const need = await screen.findByText('Utkastet stoppes av en sperre');
    await waitFor(() =>
      expect(text(need.parentElement)).toContain('Avslag uten kilde er 89 %, kravet er 90 %.'),
    );
    expect(text(need.parentElement)).not.toContain('kravet er 80 %');
  });

  it('counts the draft as tested only from a test run that completed', async () => {
    const { api } = health({
      runs: [
        {
          id: 'd4',
          status: 'failed',
          testSet: 'kjerne',
          version: 'draft',
          draftRevision: 4,
          startedAt: '2026-11-13T10:50:00Z',
          endedAt: '2026-11-13T10:59:00Z',
          score: null,
        },
      ],
      drafts: [draftSummary],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const need = await screen.findByText('Utkastet er ikke testet');
    expect(text(need.parentElement)).not.toContain('Testet');
  });

  it('writes i går in lower case inside the sentence about when the draft was tested and changed', async () => {
    const { api } = health({
      runs: [
        {
          id: 'd3',
          status: 'completed',
          testSet: 'kjerne',
          version: 'draft',
          draftRevision: 3,
          startedAt: '2026-11-13T10:50:00Z',
          endedAt: '2026-11-13T10:59:00Z',
          score: 0.9,
          passed: 9,
          total: 10,
        },
      ],
      drafts: [{ ...draftSummary, at: '2026-11-16T14:26:00Z' }],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const need = await screen.findByText('Utkastet er endret etter siste test');
    expect(text(need.parentElement)).toContain('Testet 13. nov 11:59, endret i går 15:26.');
  });

  it('shows the last day with runs in Andel med feil and Svartid when the service has not run today', async () => {
    const { api } = health({
      daily: [
        day('2026-11-15', 90, 0, 1_000_000, { p50Ms: 2400, p95Ms: 7000, runs: 90 }),
        day('2026-11-16', 110, 2, 1_000_000, { p50Ms: 1200, p95Ms: 5000, runs: 110 }),
        day('2026-11-17', 0, 0, 0, null),
      ],
      failures: [],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() =>
      expect(text(tile(/^Andel med feil/))).toContain('Ingen kjøringer i dag. 16. nov: 2 av 110'),
    );
    expect(text(tile(/^Andel med feil/))).toContain('1,8 %');
    expect(text(tile(/^Svartid/))).toContain('1,2 s');
    expect(text(tile(/^Svartid/))).toContain('Ingen kjøringer i dag. Median 16. nov');
    expect(screen.queryByText('Kommer med første kjøring')).toBeNull();
  });

  it('says the test sets have not run instead of asking for a test set when the service has some', async () => {
    const { api } = health({ sets: [{ id: 'kjerne', name: 'Kjerne', cases: 23 }] });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() => expect(text(tile(/^Kvalitet/))).toContain('Testsettet er ikke kjørt ennå'));
    expect(text(tile(/^Kvalitet/))).not.toContain('Lag et testsett');
  });

  it('lists the API keys of the service from the same source as Nøkler og kanaler', async () => {
    const { api } = health({
      shared: {
        frontends: [],
        apiKeys: [{ id: 'org', name: 'Organisasjonsnøkkel', bound: false }],
        tenants: [],
      },
      keys: [
        serviceKey('k1', 'Saksbehandling'),
        serviceKey('k9', 'Gammel nøkkel', { revokedAt: '2026-11-02T09:00:00Z' }),
      ],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const who = await screen.findByRole('region', { name: 'Hvem bruker den' });
    await waitFor(() => expect(within(who).getByText('Én API-nøkkel')).toBeTruthy());
    expect(text(who)).toContain('Saksbehandling');
    expect(text(who)).not.toContain('Organisasjonsnøkkel');
    expect(text(who)).not.toContain('Gammel nøkkel');
  });

  it('opens Hele loggen on a period that covers the runs shown above it', async () => {
    const { api } = health({
      recent: [
        run('t1', 'completed', '2026-11-17T13:50:00Z', 'Hva sa tilsynet?'),
        run('t2', 'completed', '2026-11-16T09:00:00Z', 'Og i fjor?'),
      ],
      total: 2,
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await screen.findByRole('link', { name: 'Og i fjor?' });
    expect(screen.getByRole('link', { name: 'Hele loggen' }).getAttribute('href')).toBe(
      '#/services/rapport/log?period=week',
    );
  });

  it('links a source by its alias and calls a source it cannot find an unknown dataset', async () => {
    const withSources = {
      ...definition,
      spec: {
        ...definition.spec,
        knowledge: { datasets: [{ dataset: 'kudos-rapporter' }, { dataset: 'borte' }] },
      },
    } as unknown as ServiceDefinition;
    const { api } = health({
      datasets: [
        {
          id: 'digdir/kudos',
          fullId: 'digdir/kudos',
          name: 'Kudos-rapporter',
          aliases: ['kudos-rapporter'],
          residency: 'norway',
        },
      ],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={withSources} now={now} />,
    );

    const live = await screen.findByRole('region', { name: 'I drift' });
    await waitFor(() =>
      expect(within(live).getByRole('link', { name: 'Kudos-rapporter' })).toBeTruthy(),
    );
    expect(text(live)).toContain('ukjent datasett «borte»');
  });

  it('says where data is processed from the widest of the model and its sources', async () => {
    const { api } = health({
      datasets: [
        {
          id: 'tilsyn',
          fullId: `${tenant}/tilsyn`,
          name: 'Tilsynsrapporter 2025',
          aliases: [],
          residency: 'eu',
          effectiveResidency: 'global',
        },
      ],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const live = await screen.findByRole('region', { name: 'I drift' });
    await waitFor(() => expect(text(live)).toContain('data behandles i hele verden'));
  });

  it('says the quality is the same as the version before when the score did not change', async () => {
    const versionRun = (version: number, endedAt: string) => ({
      id: `v${version}`,
      status: 'completed',
      testSet: 'kjerne',
      version,
      startedAt: endedAt,
      endedAt,
      score: 0.86,
      passed: 43,
      total: 50,
    });
    const { api } = health({
      runs: [versionRun(7, '2026-11-17T10:00:00Z'), versionRun(6, '2026-11-10T10:00:00Z')],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() => expect(text(tile(/^Kvalitet/))).toContain('Samme som 86 % i versjon 6'));
    expect(text(tile(/^Kvalitet/))).not.toContain('Opp fra');
  });

  it('shows the share of runs per key in Hvem bruker den, a frontend key under its frontend only', async () => {
    const { api } = health({
      shared: {
        frontends: [{ id: 'teams', name: 'Teams-bot', kind: 'server', channels: ['openai'] }],
        apiKeys: [],
        tenants: [],
      },
      keys: [
        serviceKey('k1', 'Saksbehandling'),
        serviceKey('k2', 'Teams', { client: 'teams' }),
        serviceKey('k3', 'Intranett-server, gammel'),
      ],
      total: 200,
      keyTotals: { 'api-key:k1': 24, 'api-key:k2': 54, 'api-key:k3': 0 },
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const who = await screen.findByRole('region', { name: 'Hvem bruker den' });
    await waitFor(() =>
      expect(text(who)).toContain(
        '2 API-nøklerSaksbehandling (12 %), Intranett-server, gammel (ikke brukt)',
      ),
    );
    expect(text(who)).toContain('Brukerflate · 27 % av kjøringene');
    expect(text(who)).not.toContain('Teams (27 %)');
  });

  it('shows the share of runs a browser frontend brought, from the runs that recorded it', async () => {
    const { api } = health({
      shared: {
        frontends: [{ id: 'intranettet', name: 'Intranettet', kind: 'browser', channels: [] }],
        apiKeys: [],
        tenants: [],
      },
      total: 200,
      keyTotals: { 'frontend:intranettet': 122 },
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const who = await screen.findByRole('region', { name: 'Hvem bruker den' });
    await waitFor(() => expect(text(who)).toContain('Brukerflate · 61 % av kjøringene'));
  });

  it('shows who paused the service, when and why, in a banner', async () => {
    const { api } = platform({
      lifecycle: {
        state: 'paused',
        by: 'employee:ansattporten:ola',
        at: '2026-11-02T09:00:00Z',
        reason: 'Venter på at innlesingen virker igjen',
      },
    });
    render(
      asManager(
        <OverviewSection
          api={api}
          tenant={tenant}
          id="rapport"
          definition={definition}
          now={now}
          published={{
            kind: 'Service',
            tenant,
            id: 'rapport',
            version: 7,
            publishedBy: 'employee:ansattporten:ola',
            publishedByName: 'Ola Nordmann',
            publishedAt: '2026-10-01T10:00:00Z',
            reason: 'Ny versjon',
            definition: definition as unknown as Record<string, unknown>,
          }}
        />,
      ),
    );

    const banner = await screen.findByText('Tjenesten er på pause.');
    expect(banner.parentElement?.textContent).toBe(
      'Tjenesten er på pause. Ola Nordmann satte den på pause 2. november 2026: «Venter på at innlesingen virker igjen». Brukerne får beskjed om at tjenesten er midlertidig stengt.',
    );
  });

  it('starts a paused service again through the lifecycle route', async () => {
    const { api, calls } = platform({
      lifecycle: {
        state: 'paused',
        by: 'employee:ansattporten:ola',
        at: '2026-11-02T09:00:00Z',
        reason: 'Venter på data',
      },
    });
    render(
      asManager(
        <OverviewSection
          api={api}
          tenant={tenant}
          id="rapport"
          definition={definition}
          now={now}
        />,
      ),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start igjen' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Innlesingen virker igjen' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start igjen' }));

    await waitFor(() =>
      expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({ state: 'active' }),
    );
  });
});

describe('the pause banner', () => {
  const paused = {
    state: 'paused',
    by: 'employee:ansattporten:ola',
    at: '2026-11-02T09:00:00Z',
    reason: 'Venter på data',
  };

  it('names who paused from the lifecycle when the API sends the name', async () => {
    const { api } = platform({ lifecycle: { ...paused, byName: 'Ola Nordmann' } });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const banner = await screen.findByText('Tjenesten er på pause.');
    expect(text(banner.parentElement)).toMatch(/Ola Nordmann satte den på pause 2\. november/);
  });

  it('points to the dataset whose ingest failed, with the time it failed', async () => {
    const { api } = platform({
      lifecycle: paused,
      lastExecution: {
        status: 'failed',
        startedAt: '2026-11-17T05:00:00Z',
        endedAt: '2026-11-17T05:00:00Z',
        stored: 0,
        skipped: 0,
      },
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const line = (await screen.findByText(/^Innlesingen av/)).closest('p') as HTMLElement;
    expect(text(line)).toMatch(/^Innlesingen av Tilsynsrapporter 2025 feilet .*06[.:]00\.$/);
    expect(
      within(line).getByRole('link', { name: 'Tilsynsrapporter 2025' }).getAttribute('href'),
    ).toBe('#/datasets/tilsyn');
  });

  it('can undo starting the service again, which pauses it again with the old reason', async () => {
    const { api, calls } = platform({ lifecycle: paused });
    render(
      asManager(
        <OverviewSection
          api={api}
          tenant={tenant}
          id="rapport"
          definition={definition}
          now={now}
        />,
      ),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Start igjen' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox'), {
      target: { value: 'Innlesingen virker igjen' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start igjen' }));

    expect(await screen.findByText('Rapportassistenten er i bruk igjen.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /^Angre \(\d+ s\)$/ }));
    await waitFor(() =>
      expect(calls.filter((c) => c.method === 'PUT').map((c) => c.body)).toEqual([
        { state: 'active' },
        { state: 'paused' },
      ]),
    );
    expect(
      calls
        .filter((c) => c.method === 'PUT')
        .map((c) => decodeURIComponent(c.headers.get('change-reason') ?? '')),
    ).toEqual(['Innlesingen virker igjen', 'Venter på data']);
  });
});

describe('the archived banner', () => {
  it('says who archived the service, when and why, when the API sends the name', () => {
    const { api } = platform();
    render(
      <ArchivedBanner
        api={api}
        tenant={tenant}
        id="rapport"
        name="Rapportassistenten"
        canRestore={false}
        lifecycle={{
          state: 'archived',
          by: 'employee:ansattporten:kari',
          byName: 'Kari Nordmann',
          at: '2026-10-03T09:00:00Z',
          reason: 'Erstattet av Rapportassistenten',
        }}
      />,
    );

    expect(text(screen.getByText(/^Kari Nordmann arkiverte/))).toBe(
      'Kari Nordmann arkiverte den 3. oktober 2026: «Erstattet av Rapportassistenten». Den svarer ikke, og ingen kan endre den.',
    );
  });
});

describe('the pause dialog', () => {
  it('states the impact from the runs of the last 7 days', async () => {
    const sevenDays = new Date(now().getTime() - 7 * 86_400_000).toISOString();
    const { api } = platform({ totals: (q) => (q.get('from') === sevenDays ? 1284 : 0) });
    render(
      <LifecycleDialog
        api={api}
        tenant={tenant}
        id="rapport"
        name="Rapportassistenten"
        change="pause"
        now={now}
        onClose={() => undefined}
      />,
    );

    expect(
      await screen.findByText(
        'Tjenesten svarer ikke mens den er på pause. 1 284 kjøringer de siste 7 dagene kommer fra folk som bruker den nå. De får beskjed om at tjenesten er midlertidig stengt.',
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole('heading', { name: 'Sette Rapportassistenten på pause?' }),
    ).toBeTruthy();
  });

  it('asks before it discards a reason the user has written', async () => {
    const { api } = platform();
    let closed = 0;
    render(
      <LifecycleDialog
        api={api}
        tenant={tenant}
        id="rapport"
        name="Rapportassistenten"
        change="pause"
        now={now}
        onClose={() => (closed += 1)}
      />,
    );
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(
      within(dialog).getByRole('textbox', { name: /Hvorfor setter du den på pause/ }),
      {
        target: { value: 'Venter på ny modell' },
      },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: 'Avbryt' }));

    expect(closed).toBe(0);
    expect(within(dialog).getByText('Forkaste det du har skrevet?')).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Forkast' }));
    expect(closed).toBe(1);
  });

  it('closes at once when nothing is written', async () => {
    const { api } = platform();
    let closed = 0;
    render(
      <LifecycleDialog
        api={api}
        tenant={tenant}
        id="rapport"
        name="Rapportassistenten"
        change="pause"
        now={now}
        onClose={() => (closed += 1)}
      />,
    );
    fireEvent.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Avbryt' }),
    );
    expect(closed).toBe(1);
  });
});
