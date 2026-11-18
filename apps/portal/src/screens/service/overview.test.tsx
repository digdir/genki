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

const thirtyDays = (q: URLSearchParams) =>
  q.get('from') === new Date(now().getTime() - 30 * 86_400_000).toISOString();

describe('the Oversikt tab of a published service', () => {
  it('computes the share with errors from the failed runs among all runs in the last 30 days', async () => {
    const { api } = platform({
      totals: (q) => (thirtyDays(q) ? (q.get('status') === 'failed' ? 32 : 10_680) : 0),
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const share = await screen.findByText('Andel med feil');
    expect(text(share.nextElementSibling)).toBe('0,3 %');
    expect(text(screen.getByText('Kjøringer').nextElementSibling)).toBe('10 680');
    expect(screen.getByText('Anslått kostnad').nextElementSibling?.textContent).toMatch(/237/);
    expect(
      screen.getByRole('link', { name: 'Se bruk og kostnad i Statistikk' }).getAttribute('href'),
    ).toBe('#/statistics');
  });

  it('takes the share with errors from the same usage report as Kjøringer once it counts failures', async () => {
    const { api } = platform({
      usage: { requests: 10_680, runs: 10_680, failedRequests: 32 },
      totals: (q) => (thirtyDays(q) ? (q.get('status') === 'failed' ? 0 : 220) : 0),
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const share = screen.getByText('Andel med feil');
    await waitFor(() => expect(text(share.nextElementSibling)).toBe('0,3 %'));
    expect(text(screen.getByText('Kjøringer').nextElementSibling)).toBe('10 680');
  });

  it('counts the runs of the last 30 days from the usage report, as Oversikt and Statistikk do', async () => {
    const { api } = platform({ usageRuns: 285, totals: (q) => (thirtyDays(q) ? 220 : 0) });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const runs = screen.getByText('Kjøringer');
    await waitFor(() => expect(text(runs.nextElementSibling)).toBe('285'));
  });

  it('keeps the place of every number while it loads, so nothing below moves when they arrive', async () => {
    const { api } = platform({
      totals: (q) => (q.get('status') === 'failed' ? 3 : 248),
      recent: [run('r1', 'completed', '2026-11-17T13:21:00Z', 'Hvilke tilsyn ble gjort i Bergen?')],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    expect(screen.getByText('Kjøringer')).toBeTruthy();
    expect(screen.getByText('Andel med feil')).toBeTruthy();
    expect(screen.getByText('Anslått kostnad')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Siste kjøringer' })).toBeTruthy();
    expect(screen.queryByRole('table')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Trenger deg nå' })).toBeNull();

    const table = await screen.findByRole('table');
    const attention = screen.getByRole('heading', { name: 'Trenger deg nå' });
    expect(
      attention.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('names the model and where it runs only once the model list has answered, never the raw id first', async () => {
    const { api } = platform();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    expect(screen.queryByText(/foundry-openai\/gpt-5.6-terra/)).toBeNull();
    expect(screen.queryByText(/global region/)).toBeNull();
    expect(screen.queryByText(`${tenant}/tilsyn`)).toBeNull();
    expect(await screen.findByRole('link', { name: 'gpt-5.6-terra' })).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Tilsynsrapporter 2025' })).toBeTruthy();
    expect(screen.queryByText(/global region/)).toBeNull();
  });

  it('asks for the last 30 days from the start of the hour, so a second visit within the hour is served from the cache', async () => {
    const { calls, api } = platform();
    const later = () => new Date('2026-11-17T15:20:31.123+01:00');
    render(
      <OverviewSection
        api={api}
        tenant={tenant}
        id="rapport"
        definition={definition}
        now={later}
      />,
    );

    await waitFor(() =>
      expect(
        calls.some((c) => c.url.pathname.endsWith('/tasks') && c.url.searchParams.get('from')),
      ).toBe(true),
    );
    const windows = calls
      .filter((c) => c.url.pathname.endsWith('/tasks'))
      .map((c) => c.url.searchParams.get('from'))
      .filter((from) => from && !from.endsWith('T23:00:00.000Z'));
    expect(new Set(windows)).toEqual(new Set(['2026-10-18T14:00:00.000Z']));
  });

  it('says who can use the service: everyone in the organisation with Bruke tjenester', async () => {
    const { api } = platform();
    render(
      <OverviewSection
        api={api}
        tenant={tenant}
        tenantName="Testetaten"
        id="rapport"
        definition={definition}
        now={now}
      />,
    );

    const who = screen.getByText('Hvem kan bruke den');
    await waitFor(() =>
      expect(text(who.nextElementSibling)).toBe('Alle i Testetaten med «Bruke tjenester»'),
    );
  });

  it('names only the selected people as users of a service limited to them, with a link to Tilgang', async () => {
    const { api } = platform({
      limits: [
        {
          id: 'rapport',
          mode: 'selected',
          members: [
            { id: 'p-kari', name: 'Kari Nordmann' },
            { id: 'p-ola', name: 'Ola Nordmann' },
            { id: 'p-per', name: 'Per Hansen' },
          ],
        },
      ],
    });
    render(
      <OverviewSection
        api={api}
        tenant={tenant}
        tenantName="Testetaten"
        id="rapport"
        definition={definition}
        now={now}
      />,
    );

    const who = screen.getByText('Hvem kan bruke den').nextElementSibling;
    const link = await within(who as HTMLElement).findByRole('link', {
      name: 'Bare utvalgte: 3 personer',
    });
    expect(link.getAttribute('href')).toBe('#/access/services?open=rapport');
    expect(text(who)).not.toMatch(/Alle i/);
  });

  it('never claims everyone can use the service before the access list has answered', async () => {
    const { api } = platform();
    render(
      <OverviewSection
        api={api}
        tenant={tenant}
        tenantName="Testetaten"
        id="rapport"
        definition={definition}
        now={now}
      />,
    );

    expect(text(screen.getByText('Hvem kan bruke den').nextElementSibling)).not.toMatch(/Alle i/);
  });

  it('shows the cost as at least the priced part when a model in the period has no price', async () => {
    const { api } = platform({ usage: { costMicroNok: 63_450_000, priced: false } });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const cost = screen.getByText('Anslått kostnad');
    await waitFor(() => expect(text(cost.nextElementSibling)).toMatch(/^minst 63,45/));
  });

  it('offers Kjør på mange dokumenter at the end to someone who may run it', async () => {
    const { api } = platform();
    render(
      <OverviewSection
        api={api}
        tenant={tenant}
        id="rapport"
        definition={definition}
        now={now}
        canBatch
      />,
    );

    const offer = screen.getByRole('region', { name: 'Kjør på mange dokumenter' });
    expect(within(offer).getByRole('button', { name: 'Kjør på mange dokumenter' })).toBeTruthy();
  });

  it('opens Kjør på mange dokumenter as a dialog on the page, not as a page of its own', async () => {
    const { api, calls } = platform();
    render(
      asManager(
        <OverviewSection
          api={api}
          tenant={tenant}
          id="rapport"
          definition={definition}
          now={now}
          canBatch
        />,
      ),
    );

    fireEvent.click(screen.getByRole('button', { name: 'Kjør på mange dokumenter' }));

    const dialog = await screen.findByRole('dialog', { name: 'Kjør på mange dokumenter' });
    expect(dialog).toBeTruthy();
    await waitFor(() =>
      expect(calls.some((c) => c.url.pathname.endsWith('/batch-runs/sources'))).toBe(true),
    );
    expect(window.location.hash).not.toMatch(/\/batch/);
  });

  it('links each question in Siste kjøringer to its run in Logg', async () => {
    const { api } = platform({
      recent: [
        run('r1', 'completed', '2026-11-17T13:21:00Z', 'Hvilke tilsyn ble gjort i Bergen i 2025?'),
      ],
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const table = await screen.findByRole('region', { name: 'Siste kjøringer' });
    const link = within(table).getByRole('link', {
      name: 'Hvilke tilsyn ble gjort i Bergen i 2025?',
    });
    expect(link.getAttribute('href')).toBe('#/log/r1');
    expect(
      within(table)
        .getAllByRole('columnheader')
        .map((h) => h.textContent),
    ).toEqual(['Tid', 'Spørsmål', 'Status', 'Varighet']);
    expect(within(table).getByText('i dag kl. 14.21')).toBeTruthy();
    expect(within(table).getByText('4,2 s')).toBeTruthy();
  });

  it('takes the cause from the reason the run list gives, without opening the run', async () => {
    const since = new Date('2026-11-17T00:00:00+01:00').toISOString();
    const { api, calls } = platform({
      failedReason: 'Kjøringen tok for lang tid.',
      totals: (q) => (q.get('from') === since ? (q.get('status') === 'failed' ? 3 : 248) : 0),
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const section = await screen.findByRole('region', { name: 'Trenger deg nå' });
    expect(
      await within(section).findByText(
        '3 kjøringer feilet i dag: kjøringen tok for lang tid. De andre 245 kjøringene i dag gikk bra.',
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.url.pathname.endsWith('/timeline'))).toBe(false);
  });

  it('prefers the specific cause from the run timeline over the generic reason of a strategy error', async () => {
    const since = new Date('2026-11-17T00:00:00+01:00').toISOString();
    const { api } = platform({
      failure: { code: 'strategy_error', reason: 'Tjenesten feilet underveis.' },
      totals: (q) => (q.get('from') === since ? (q.get('status') === 'failed' ? 3 : 248) : 0),
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const section = await screen.findByRole('region', { name: 'Trenger deg nå' });
    expect(
      await within(section).findByText(
        '3 kjøringer feilet i dag: modellen svarte ikke innen 30 sekunder. De andre 245 kjøringene i dag gikk bra.',
      ),
    ).toBeTruthy();
  });

  it('takes the specific detail of a failure when the run list sends it, without opening the run', async () => {
    const since = new Date('2026-11-17T00:00:00+01:00').toISOString();
    const { api, calls } = platform({
      failure: {
        code: 'strategy_error',
        reason: 'Tjenesten feilet underveis.',
        detail: 'Søket i datasettet Kudos svarte ikke.',
      },
      totals: (q) => (q.get('from') === since ? (q.get('status') === 'failed' ? 3 : 248) : 0),
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const section = await screen.findByRole('region', { name: 'Trenger deg nå' });
    expect(
      await within(section).findByText(
        '3 kjøringer feilet i dag: søket i datasettet Kudos svarte ikke. De andre 245 kjøringene i dag gikk bra.',
      ),
    ).toBeTruthy();
    expect(calls.some((c) => c.url.pathname.endsWith('/timeline'))).toBe(false);
  });

  it('shows Trenger deg nå and Siste kjøringer together, so the runs never move down when the cause arrives', async () => {
    const since = new Date('2026-11-17T00:00:00+01:00').toISOString();
    let releaseTimeline = () => {};
    const timelineGate = new Promise<void>((r) => (releaseTimeline = r));
    const slow = platform({
      failure: { code: 'strategy_error', reason: 'Tjenesten feilet underveis.' },
      totals: (q) => (q.get('from') === since ? (q.get('status') === 'failed' ? 3 : 248) : 0),
      recent: [run('r1', 'completed', '2026-11-17T13:21:00Z', 'Hvilke tilsyn ble gjort?')],
    });
    const api = slow.api;
    const original = api.getTaskTimeline.bind(api);
    api.getTaskTimeline = async (...args: Parameters<typeof original>) => {
      await timelineGate;
      return original(...args);
    };
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    await waitFor(() =>
      expect(slow.calls.some((c) => c.url.searchParams.get('limit') === '5')).toBe(true),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByRole('table')).toBeNull();
    releaseTimeline();
    const table = await screen.findByRole('table');
    const attention = screen.getByRole('heading', { name: 'Trenger deg nå' });
    expect(
      attention.compareDocumentPosition(table) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it('shows the failures of today with the cause from the latest failed run', async () => {
    const since = new Date('2026-11-17T00:00:00+01:00').toISOString();
    const { api } = platform({
      totals: (q) => (q.get('from') === since ? (q.get('status') === 'failed' ? 3 : 248) : 0),
    });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const section = await screen.findByRole('region', { name: 'Trenger deg nå' });
    expect(
      within(section).getByText(
        '3 kjøringer feilet i dag: modellen svarte ikke innen 30 sekunder. De andre 245 kjøringene i dag gikk bra.',
      ),
    ).toBeTruthy();
    expect(
      within(section).getByRole('link', { name: 'Se de 3 kjøringene' }).getAttribute('href'),
    ).toBe('#/log?service=rapport&status=failed&period=today');
  });

  it('names the sources and the model and links them to their dataset and building block', async () => {
    const { api } = platform();
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const source = await screen.findByRole('link', { name: 'Tilsynsrapporter 2025' });
    expect(source.getAttribute('href')).toBe('#/datasets/tilsyn');
    const model = await screen.findByRole('link', { name: 'gpt-5.6-terra' });
    expect(model.getAttribute('href')).toBe(
      `#/building-blocks/model/${encodeURIComponent('foundry-openai/gpt-5.6-terra')}`,
    );
    expect(model.parentElement?.textContent).toBe('gpt-5.6-terra, data behandles i EU/EØS');
  });

  it('names where the model runs, with the operator and region, when the model list says', async () => {
    const { api } = platform({ operator: { name: 'Microsoft Azure', region: 'Sverige' } });
    render(
      <OverviewSection api={api} tenant={tenant} id="rapport" definition={definition} now={now} />,
    );

    const model = await screen.findByRole('link', { name: 'gpt-5.6-terra' });
    expect(model.parentElement?.textContent).toBe(
      'gpt-5.6-terra, data behandles i EU/EØS (Azure Sverige)',
    );
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
