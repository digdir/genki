// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { ReactNode } from 'react';
import { createApiClient } from '../../api';
import type { ServiceDefinition } from '../../data/service-definition';
import { RightsProvider } from '../../Shell';
import type { TaskRow } from '../../types';
import { OverviewSection } from './OverviewSection';
import { LifecycleDialog } from './ServiceLifecycle';

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
  } = {},
) => {
  const calls: Call[] = [];
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
    if (path.endsWith('/lifecycle'))
      return reply(
        method === 'PUT' ? { state: 'active' } : (overrides.lifecycle ?? { state: 'active' }),
      );
    if (path.endsWith('/usage'))
      return reply({ byService: [{ service: 'rapport', usage: { costMicroNok: 237_000_000 } }] });
    if (path.endsWith('/timeline'))
      return reply({
        steps: [{ id: 'e1', type: 'error', summary: 'modellen svarte ikke innen 30 sekunder.' }],
      });
    if (path.endsWith('/tasks')) {
      const q = url.searchParams;
      if (q.get('limit') === '5') return reply({ data: overrides.recent ?? [], total: 0 });
      const total = overrides.totals?.(q) ?? 0;
      const data =
        q.get('status') === 'failed' && total ? [run('f1', 'failed', '2026-11-17T13:57:00Z')] : [];
      return reply({ data, total });
    }
    if (path.endsWith('/datasets'))
      return reply({
        data: [{ id: 'tilsyn', fullId: `${tenant}/tilsyn`, name: 'Tilsynsrapporter 2025' }],
      });
    if (path === '/models')
      return reply({
        data: [{ id: 'foundry-openai/gpt-5.6-terra', name: 'gpt-5.6-terra', residency: 'eu' }],
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
      within(section)
        .getByRole('link', { name: 'Se de feilede kjøringene i Logg' })
        .getAttribute('href'),
    ).toBe('#/log?service=rapport&status=failed');
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
