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

const day = (date: string, runs: number, failed = 0, cost = 1_000_000) => ({
  date,
  usage: { runs, requests: runs, costMicroNok: cost },
  byService: { rapport: { runs, requests: runs, failedRequests: failed, costMicroNok: cost } },
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
        daily: [day('2026-11-15', 90), day('2026-11-16', 110), day('2026-11-17', 120, 6)],
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
    if (path.endsWith('/tasks'))
      return reply({
        data: overrides.recent ?? [
          run('t1', 'completed', '2026-11-17T13:50:00Z', 'Hva sa tilsynet?'),
        ],
        total: overrides.total ?? 1,
        offset: 0,
        limit: 6,
      });
    if (path.endsWith('/api-keys')) return reply({ keys: overrides.keys ?? [] });
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

describe('the Oversikt tab of a published service', () => {
  it('shows the median and 95th percentile latency of the service today', async () => {
    const { api } = health();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() => expect(text(tile(/^Svartid, median/))).toContain('95 prosent under'));
    expect(text(tile(/^Svartid, median/))).toMatch(/1,8 s.*6,4 s/);
  });

  it('says there is no latency yet instead of inventing one when the service has no timed runs', async () => {
    const { api } = health({ latency: null });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() => expect(text(tile(/^Svartid, median/))).toContain('Ingen data'));
  });

  it('shows the failures of today with their most common cause', async () => {
    const { api, calls } = health();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const need = await screen.findByText('6 kjøringer feilet i dag');
    expect(text(need.parentElement)).toContain('Oftest: Modellen svarte ikke i tide (4 av 6).');
    expect(
      within(need.parentElement as HTMLElement)
        .getByRole('link', { name: 'Se de som feilet' })
        .getAttribute('href'),
    ).toBe('#/services/rapport/log?status=failed&period=today');
    await waitFor(() =>
      expect(text(tile(/^Andel med feil i dag/))).toContain(
        '6 av 120, oftest Modellen svarte ikke i tide',
      ),
    );
    const from = calls.find((c) => c.startsWith('/tenants/991825827/service-failures'));
    expect(decodeURIComponent(from ?? '')).toContain(
      `from=${new Date(2026, 10, 17).toISOString()}`,
    );
  });

  it('keeps a place for each source of Trenger deg nå while it loads and fills it as it arrives', async () => {
    const { api, release } = health({ hold: /service-failures$/ });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const heading = await screen.findByRole('heading', { name: 'Trenger deg nå' });
    const section = heading.closest('section') as HTMLElement;
    await waitFor(() => expect(section.querySelectorAll('.ov-need').length).toBe(1));
    expect(within(section).queryByText(/feilet i dag/)).toBeNull();
    release();
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
    expect(text(who)).toContain('Delt med én annen virksomhet.');
  });

  it('says a service is not reachable yet when nothing is shared with it', async () => {
    const { api } = health({ shared: { frontends: [], apiKeys: [], tenants: [] } });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const who = await screen.findByRole('region', { name: 'Hvem bruker den' });
    await waitFor(() => expect(within(who).getByText('Ingen brukerflater')).toBeTruthy());
    expect(within(who).getByText('Ingen API-nøkler')).toBeTruthy();
    expect(text(who)).toContain('Ikke delt med andre virksomheter.');
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
        name: 'Versjon 7 er publisert. Dette gjenstår før den er i bruk',
      }),
    ).toBeTruthy();
    expect(screen.getByText('Lag et testsett')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Trenger deg nå' })).toBeNull();
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
