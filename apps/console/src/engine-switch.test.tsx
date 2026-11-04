// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { EngineSwitchSection } from './screens/config/EngineSwitch';

document.getAnimations ??= () => [];
afterEach(cleanup);

interface Call {
  method: string;
  path: string;
  body: unknown;
  reason: string;
  session: string | null;
}

type Handler = (call: Call) => [number, unknown];

const platform = (routes: Record<string, Handler>) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`;
    const method = init?.method ?? 'GET';
    const call = {
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      reason: decodeURIComponent(new Headers(init?.headers).get('change-reason') ?? ''),
      session: new Headers(init?.headers).get('support-session'),
    };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    const [status, body] = handler ? handler(call) : [404, { title: 'Not found' }];
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'ops' }) };
};

const dataset = 'digdir/genki-docs';
const base = `/operator/datasets/${encodeURIComponent(dataset)}`;
const embedding = { model: 'foundry/text-embedding-3-small', dimensions: 1536 };

const engineOn = (endpoint: string, extra: Record<string, unknown> = {}) => ({
  dataset,
  endpoint,
  engine: 'pgvector',
  title: 'Postgres med pgvector',
  builtin: true,
  runsAt: 'platform',
  embedding,
  capabilities: { supported: [], missing: [] },
  usedBy: [],
  canSwitch: true,
  retentionDays: 14,
  ...extra,
});

const entry = (id: string, spec: Record<string, unknown>) => ({
  id,
  kind: 'knowledge-endpoint',
  scope: 'platform',
  origin: 'api',
  version: 1,
  spec,
});

const endpoints = {
  data: [
    entry('platform-pg', {
      engine: 'pgvector',
      options: { connection: 'platform' },
      sharing: { tenants: '*' },
    }),
    entry('knowledge-pg', { engine: 'pgvector', options: { connection: 'knowledge' } }),
    entry('typesense-digdir', { engine: 'typesense', baseURL: 'https://ts.example' }),
  ],
};

const switchView = (state: string, extra: Record<string, unknown> = {}) => ({
  id: `engine-switch:platform:${dataset}:s1`,
  sid: 's1',
  version: 1,
  dataset,
  from: 'platform-pg',
  to: 'knowledge-pg',
  method: 'reingest',
  state,
  estimate: { costNok: { min: 0, max: 1 }, durationMinutes: { min: 1, max: 5 } },
  progress: { percent: state === 'running' ? 40 : 100, documents: 120, total: 300 },
  attempt: 1,
  startedAt: '2026-11-04T12:00:00Z',
  startedBy: 'operator:entra:ola',
  updatedAt: '2026-11-04T12:01:00Z',
  generation: 'g-20261104-3a9f1c',
  minimumReasonLength: 10,
  canRollback: false,
  ...extra,
});

/** A switch that moves through the given states, one per read. */
const sequence = (...states: [string, Record<string, unknown>?][]) => {
  let i = 0;
  return (): [number, unknown] => {
    const [state, extra] = states[Math.min(i++, states.length - 1)] ?? ['running'];
    return [200, switchView(state, extra)];
  };
};

const estimate = (reingest: Record<string, unknown> = {}) => ({
  dataset,
  from: 'platform-pg',
  to: 'knowledge-pg',
  estimate: true,
  basis: { documents: 301, counted: true },
  copy: { available: false, costNok: { min: 0, max: 0 }, durationMinutes: { min: 0, max: 0 } },
  reingest: {
    available: true,
    costNok: { min: 1, max: 3 },
    durationMinutes: { min: 2, max: 6 },
    ...reingest,
  },
});
const estimateRoute = `GET ${base}/engine-switches/estimate?to=knowledge-pg&method=reingest`;

const startMove = async (reason = 'Flytter dokumentasjonen til kunnskapsdatabasen') => {
  fireEvent.click(await screen.findByRole('button', { name: 'Flytt til kunnskapsdatabasen' }));
  await screen.findByText(/Innlesing på nytt/);
  fireEvent.change(screen.getByLabelText('Begrunnelse'), { target: { value: reason } });
  fireEvent.click(screen.getByRole('button', { name: 'Start flyttingen' }));
};

describe('engine switch of a platform dataset in the console', () => {
  it('a platform dataset moves to a knowledge endpoint and is followed to ready', async () => {
    const { api, calls } = platform({
      [`GET ${base}/engine`]: () => [200, engineOn('platform-pg')],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [estimateRoute]: () => [200, estimate()],
      [`POST ${base}/engine-switches`]: () => [202, switchView('running')],
      [`GET ${base}/engine-switches/s1`]: sequence(
        ['running'],
        ['comparing'],
        ['ready', { failedDocuments: 2 }],
      ),
    });
    render(<EngineSwitchSection api={api} base={base} pollMs={1} />);

    expect(await screen.findByText(/Søkemotor nå: platform-pg/)).toBeTruthy();
    await startMove();

    const start = calls.find((c) => c.method === 'POST');
    expect(start?.body).toEqual({ to: 'knowledge-pg', method: 'reingest', embedding });
    expect(start?.reason).toBe('Flytter dokumentasjonen til kunnskapsdatabasen');
    expect(await screen.findByText('Klar til å tas i bruk')).toBeTruthy();
    expect(screen.getByText(/g-20261104-3a9f1c/)).toBeTruthy();
    expect(screen.getByText('2 dokumenter kunne ikke leses inn')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Ta i bruk' })).toBeTruthy();
  });

  it('only knowledge endpoints are offered as the target', async () => {
    const { api } = platform({
      [`GET ${base}/engine`]: () => [200, engineOn('platform-pg')],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [estimateRoute]: () => [200, estimate()],
    });
    render(<EngineSwitchSection api={api} base={base} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Flytt til kunnskapsdatabasen' }));
    const target = screen.getByLabelText('Til søkemotor');
    expect(
      within(target)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['knowledge-pg']);
  });

  it('activating asks for a reason and then shows the knowledge endpoint as the engine', async () => {
    let engine = engineOn('platform-pg', { activeSwitch: switchView('ready') });
    const { api, calls } = platform({
      [`GET ${base}/engine`]: () => [200, engine],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [estimateRoute]: () => [200, estimate()],
      [`POST ${base}/engine-switches/s1/activate`]: () => [202, switchView('activating')],
      [`GET ${base}/engine-switches/s1`]: () => {
        engine = engineOn('knowledge-pg', {
          previous: {
            endpoint: 'platform-pg',
            title: 'Postgres med pgvector',
            keptUntil: '2026-11-18T12:00:00Z',
            switch: `engine-switch:platform:${dataset}:s1`,
          },
        });
        return [200, switchView('active', { canRollback: true })];
      },
    });
    render(<EngineSwitchSection api={api} base={base} pollMs={1} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ta i bruk' }));
    expect(calls.some((c) => c.path.endsWith('/activate'))).toBe(false);
    expect(await screen.findByText(/Skriv en begrunnelse på minst 10 tegn/)).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Søket svarer like godt fra kunnskapsdatabasen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ta i bruk' }));

    expect(await screen.findByText(/Søkemotor nå: knowledge-pg/)).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/activate'))?.reason).toBe(
      'Søket svarer like godt fra kunnskapsdatabasen',
    );
  });

  it('roll back is offered while the old engine is kept', async () => {
    let engine = engineOn('knowledge-pg', {
      previous: {
        endpoint: 'platform-pg',
        title: 'Postgres med pgvector',
        keptUntil: '2026-11-18T12:00:00Z',
        switch: `engine-switch:platform:${dataset}:s1`,
      },
    });
    const { api, calls } = platform({
      [`GET ${base}/engine`]: () => [200, engine],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [estimateRoute]: () => [200, estimate()],
      [`POST ${base}/engine-switches/s1/rollback`]: () => {
        engine = engineOn('platform-pg');
        return [200, switchView('rolled_back')];
      },
    });
    render(<EngineSwitchSection api={api} base={base} />);

    expect(await screen.findByText(/platform-pg beholdes til 18\.11\.2026/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Begrunnelse'), {
      target: { value: 'Søket ble dårligere etter flyttingen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Rull tilbake til platform-pg' }));

    expect(await screen.findByText(/Søkemotor nå: platform-pg/)).toBeTruthy();
    expect(calls.find((c) => c.path.endsWith('/rollback'))?.reason).toBe(
      'Søket ble dårligere etter flyttingen',
    );
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Rull tilbake til platform-pg' })).toBeNull(),
    );
  });

  it('a refused start shows its reason', async () => {
    const { api } = platform({
      [`GET ${base}/engine`]: () => [200, engineOn('platform-pg')],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [estimateRoute]: () => [200, estimate()],
      [`POST ${base}/engine-switches`]: () => [
        409,
        {
          title: 'Vektormodellen foundry/text-embedding-3-small er ikke satt opp på plattformen.',
          status: 409,
          errors: [
            {
              path: 'embedding',
              message:
                'Vektormodellen foundry/text-embedding-3-small er ikke satt opp på plattformen.',
            },
          ],
        },
      ],
    });
    render(<EngineSwitchSection api={api} base={base} />);

    await startMove();

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toBe(
      'Vektormodellen foundry/text-embedding-3-small er ikke satt opp på plattformen.',
    );
    expect(screen.getByText(/Søkemotor nå: platform-pg/)).toBeTruthy();
  });

  it('the estimate shows before a move starts', async () => {
    const { api } = platform({
      [`GET ${base}/engine`]: () => [200, engineOn('platform-pg')],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [estimateRoute]: () => [200, estimate()],
    });
    render(<EngineSwitchSection api={api} base={base} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Flytt til kunnskapsdatabasen' }));
    expect(
      await screen.findByText('Innlesing på nytt: 1–3 kr, 2–6 min (301 dokumenter)'),
    ).toBeTruthy();
  });

  it('a move the estimate refuses cannot start', async () => {
    const { api, calls } = platform({
      [`GET ${base}/engine`]: () => [200, engineOn('platform-pg')],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [estimateRoute]: () => [
        200,
        estimate({ available: false, reason: 'søkefraser kan ikke fylle et datasett her ennå' }),
      ],
    });
    render(<EngineSwitchSection api={api} base={base} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Flytt til kunnskapsdatabasen' }));
    expect(await screen.findByText(/søkefraser kan ikke fylle/)).toBeTruthy();
    const start = screen.getByRole('button', { name: 'Start flyttingen' }) as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    expect(calls.some((c) => c.method === 'POST')).toBe(false);
  });

  it('the comparison shows when the switch is ready', async () => {
    const comparison = {
      testSets: ['genki-docs-sporsmal'],
      cases: 10,
      k: 5,
      hitAt5: [90, 80],
      meanRank: [1.4, 1.3],
      latencyMs: [120, 80],
      errors: [0, 0],
      verdict: 'worse',
      examples: [],
    };
    const { api } = platform({
      [`GET ${base}/engine`]: () => [
        200,
        engineOn('platform-pg', {
          activeSwitch: switchView('ready', { comparison, minimumReasonLength: 20 }),
        }),
      ],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
    });
    render(<EngineSwitchSection api={api} base={base} />);

    expect(
      await screen.findByText(
        'Treff blant de fem første: platform-pg 90 %, knowledge-pg 80 % (10 spørsmål)',
      ),
    ).toBeTruthy();
    expect(screen.getByText(/Den nye søkemotoren treffer dårligere/)).toBeTruthy();
  });

  it("an agency's dataset is moved through its own routes under a support session", async () => {
    const agency = '/tenants/405003309/datasets/notater';
    const { api, calls } = platform({
      [`GET ${agency}/engine`]: () => [200, engineOn('platform-pg')],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [`GET ${agency}/engine-switches/estimate?to=knowledge-pg&method=reingest`]: () => [
        200,
        estimate(),
      ],
      [`POST ${agency}/engine-switches`]: () => [202, switchView('running')],
      [`GET ${agency}/engine-switches/s1`]: () => [200, switchView('ready')],
    });
    api.holdSupport('405003309', 'support-1');
    render(<EngineSwitchSection api={api} base={agency} pollMs={1} />);

    await startMove();

    expect(await screen.findByText('Klar til å tas i bruk')).toBeTruthy();
    const start = calls.find((c) => c.method === 'POST');
    expect(start?.path).toBe(`${agency}/engine-switches`);
    expect(start?.session).toBe('support-1');
  });

  it('a running move can be cancelled with a reason', async () => {
    const { api, calls } = platform({
      [`GET ${base}/engine`]: () => [
        200,
        engineOn('platform-pg', { activeSwitch: switchView('running') }),
      ],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
      [`GET ${base}/engine-switches/s1`]: () => [200, switchView('running')],
      [`POST ${base}/engine-switches/s1/cancel`]: () => [200, switchView('cancelled')],
    });
    render(<EngineSwitchSection api={api} base={base} pollMs={60_000} />);

    fireEvent.change(await screen.findByLabelText('Begrunnelse'), {
      target: { value: 'Startet mot feil søkemotor' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Avbryt flyttingen' }));
    await waitFor(() =>
      expect(calls.find((c) => c.path.endsWith('/cancel'))?.reason).toBe(
        'Startet mot feil søkemotor',
      ),
    );
  });

  it("a failed fill shows the worker's error under a Norwegian lead", async () => {
    const { api } = platform({
      [`GET ${base}/engine`]: () => [
        200,
        engineOn('platform-pg', {
          activeSwitch: switchView('failed', {
            error: { message: 'listing the source failed after its retries', percent: 0 },
          }),
        }),
      ],
      'GET /operator/catalog/entries?kind=knowledge-endpoint': () => [200, endpoints],
    });
    render(<EngineSwitchSection api={api} base={base} />);

    expect(
      await screen.findByText('Innlesingen stoppet. Feilmeldingen fra plattformen:'),
    ).toBeTruthy();
    expect(screen.getByText('listing the source failed after its retries')).toBeTruthy();
  });
});
