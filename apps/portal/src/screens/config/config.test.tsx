// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { RightsProvider } from '../../Shell';
import { GuardrailRules } from '../service/GuardrailRules';
import { TenantCatalog } from './TenantCatalog';
import { TenantGates } from './TenantGates';
import { TestSetEditor } from './TestSetEditor';

document.getAnimations ??= () => [];
afterEach(cleanup);

const tenant = '991825827';

interface Call {
  method: string;
  path: string;
  body: unknown;
  headers: Headers;
}

const platform = (routes: Record<string, (call: Call) => [number, unknown]>) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const path = `${url.pathname.replace(/^\/api/, '')}${url.search}`;
    const method = init?.method ?? 'GET';
    const call = {
      method,
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: new Headers(init?.headers),
    };
    calls.push(call);
    const handler = routes[`${method} ${path}`];
    const [status, body] = handler ? handler(call) : [404, { title: 'Not found' }];
    return new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' }) };
};

const fill = (name: RegExp | string, value: string) =>
  fireEvent.change(screen.getByRole('textbox', { name }), { target: { value } });

describe("the tenant's own datasets and endpoints", () => {
  it('registers a dataset in the tenant catalog with a reason', async () => {
    const { api, calls } = platform({
      [`GET /tenants/${tenant}/catalog?kind=dataset`]: () => [
        200,
        {
          data: [
            {
              kind: 'dataset',
              id: 'digdir/kudos',
              scope: 'platform',
              version: 1,
              spec: { name: 'Kudos' },
            },
          ],
        },
      ],
      [`PUT /tenants/${tenant}/catalog/dataset/handboker`]: (c) => [
        200,
        { kind: 'dataset', id: `${tenant}/handboker`, scope: tenant, version: 1, spec: c.body },
      ],
    });
    render(
      <RightsProvider value={['manage-datasets']}>
        <TenantCatalog api={api} tenant={tenant} />
      </RightsProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Ny' }));
    fill('Id', 'handboker');
    fill('Innhold (JSON)', JSON.stringify({ name: 'Håndbøker', endpoint: 'egen-typesense' }));
    fill(/Begrunnelse/, 'Egne håndbøker');
    fireEvent.click(screen.getByRole('button', { name: 'Opprett' }));

    expect(await screen.findByText(/handboker er lagret/)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.body).toEqual({ name: 'Håndbøker', endpoint: 'egen-typesense' });
    expect(decodeURIComponent(put?.headers.get('change-reason') ?? '')).toBe('Egne håndbøker');
  });

  it('shows platform datasets as read only', async () => {
    const { api } = platform({
      [`GET /tenants/${tenant}/catalog?kind=dataset`]: () => [
        200,
        {
          data: [
            {
              kind: 'dataset',
              id: 'digdir/kudos',
              scope: 'platform',
              version: 1,
              spec: { name: 'Kudos' },
            },
          ],
        },
      ],
    });
    render(<TenantCatalog api={api} tenant={tenant} />);

    fireEvent.click(await screen.findByRole('button', { name: /Åpne/ }));

    expect(
      screen.getByText('Denne kommer fra plattformen og kan bare endres av Digdir.'),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Lagre ny versjon' })).toBeNull();
  });

  it('explains that running ingestion needs a separate write key and a decision', async () => {
    const pipelines = `/tenants/${tenant}/datasets/handboker/pipelines`;
    const { api } = platform({
      [`GET /tenants/${tenant}/catalog?kind=dataset`]: () => [
        200,
        {
          data: [
            {
              kind: 'dataset',
              id: `${tenant}/handboker`,
              scope: tenant,
              version: 1,
              spec: { name: 'Håndbøker' },
            },
          ],
        },
      ],
      [`GET /tenants/${tenant}/catalog/dataset/handboker/versions`]: () => [200, { data: [] }],
      [`GET ${pipelines}`]: () => [
        200,
        {
          data: [{ id: 'nettsider', version: 1, spec: { name: 'Nettsider' } }],
          backend: { name: 'typesense', available: false, reason: 'no write key' },
        },
      ],
      [`GET ${pipelines}/nettsider/versions`]: () => [200, { data: [] }],
      [`POST ${pipelines}/nettsider/execute`]: () => [
        409,
        {
          title: 'Ingestion is not available',
          errors: [{ path: 'backend', message: 'no write key' }],
        },
      ],
    });
    render(<TenantCatalog api={api} tenant={tenant} />);

    fireEvent.click(await screen.findByRole('button', { name: /Åpne/ }));
    await screen.findByText('Nettsider');
    const opens = screen.getAllByRole('button', { name: /Åpne/ });
    fireEvent.click(opens[opens.length - 1] as HTMLElement);
    fireEvent.click(await screen.findByRole('button', { name: 'Kjør' }));

    expect(
      await screen.findByRole('heading', { name: 'Krever egen skrivenøkkel og en beslutning' }),
    ).toBeTruthy();
  });
});

describe('quality gates and test sets for a service', () => {
  it('saves a tenant gate as mandatory', async () => {
    const { api, calls } = platform({
      [`GET /tenants/${tenant}/gates`]: () => [200, { data: [] }],
      [`PUT /tenants/${tenant}/gates/kildetreff`]: () => [
        200,
        { id: 'kildetreff', version: 1, spec: {} },
      ],
    });
    render(<TenantGates api={api} tenant={tenant} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ny' }));
    fill('Id', 'kildetreff');
    fill(
      'Innhold (JSON)',
      JSON.stringify({ metric: 'recall@10', kind: 'threshold', threshold: 0.8 }),
    );
    fireEvent.click(screen.getByRole('checkbox', { name: /Påkrevd/ }));
    fill(/Begrunnelse/, 'Krav til kildetreff');
    fireEvent.click(screen.getByRole('button', { name: 'Opprett' }));

    expect(await screen.findByText(/kildetreff er lagret/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      metric: 'recall@10',
      kind: 'threshold',
      threshold: 0.8,
      mandatory: true,
    });
  });

  it('adds a case to a test set', async () => {
    const set = {
      metadata: { tenant, id: 'kudos', name: 'Kudos-spørsmål', version: 1 },
      spec: {
        service: 'ka',
        cases: [
          {
            id: 'q1',
            split: 'validation',
            input: 'Hva er Kudos?',
            tags: [],
            needsReview: false,
            expected: {},
          },
        ],
      },
    };
    const { api, calls } = platform({
      [`GET /tenants/${tenant}/test-sets?service=ka`]: () => [200, { data: [set] }],
      [`PUT /tenants/${tenant}/test-sets/kudos/cases/q2`]: () => [200, set],
    });
    render(<TestSetEditor api={api} tenant={tenant} serviceId="ka" />);

    fireEvent.click(await screen.findByRole('button', { name: /Rediger/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Nytt tilfelle' }));
    fill('Id for tilfellet', 'q2');
    fill('Spørsmål eller tekst', 'Hvem eier Kudos?');
    fill('Forventet svar', 'DFØ');
    fill('Begrunnelse', 'Nytt spørsmål fra brukerne');
    fireEvent.click(screen.getByRole('button', { name: 'Legg til' }));

    expect(await screen.findByText('Tilfellet q2 er lagret i Kudos-spørsmål.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      split: 'validation',
      input: 'Hvem eier Kudos?',
      expected: { referenceAnswer: 'DFØ' },
    });
  });

  it('keeps what the form does not edit when it saves a case: the reference answer beside the criteria, its type and tags', async () => {
    const stored = {
      id: 'q1',
      split: 'validation',
      input: 'Hvem eier Kudos?',
      type: 'criteria',
      grounding: 'answer-only',
      tags: ['eierskap'],
      needsReview: false,
      expected: {
        referenceAnswer: 'DFØ eier Kudos.',
        criteria: { criteria: 'Svaret nevner DFØ', supporting_quotes: 'Kudos driftes av DFØ' },
      },
    };
    const set = {
      metadata: { tenant, id: 'kudos', name: 'Kudos-spørsmål', version: 1 },
      spec: { service: 'ka', cases: [stored] },
    };
    const { api, calls } = platform({
      [`GET /tenants/${tenant}/test-sets?service=ka`]: () => [200, { data: [set] }],
      [`PUT /tenants/${tenant}/test-sets/kudos/cases/q1`]: () => [200, set],
    });
    render(<TestSetEditor api={api} tenant={tenant} serviceId="ka" />);

    fireEvent.click(await screen.findByRole('button', { name: /Rediger/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Endre/ }));
    fill('Forventet svar', 'Svaret nevner DFØ og Kudos');
    fill('Begrunnelse', 'Skarpere kriterium');
    fireEvent.click(screen.getByRole('button', { name: 'Lagre tilfellet' }));

    expect(await screen.findByText('Tilfellet q1 er lagret i Kudos-spørsmål.')).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      split: 'validation',
      input: 'Hvem eier Kudos?',
      type: 'criteria',
      grounding: 'answer-only',
      tags: ['eierskap'],
      needsReview: false,
      expected: {
        referenceAnswer: 'DFØ eier Kudos.',
        criteria: {
          criteria: 'Svaret nevner DFØ og Kudos',
          supporting_quotes: 'Kudos driftes av DFØ',
        },
      },
    });
  });
});

describe('guardrail rules in the service setup', () => {
  it('creates a denylist rule for the tenant', async () => {
    const { api, calls } = platform({
      [`GET /tenants/${tenant}/guardrail-rules`]: () => [200, { data: [] }],
      [`PUT /tenants/${tenant}/guardrail-rules/interne-navn`]: () => [
        200,
        { id: 'interne-navn', version: 1, spec: {} },
      ],
    });
    render(<GuardrailRules api={api} tenant={tenant} />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ny' }));
    fill('Id', 'interne-navn');
    fill('Innhold (JSON)', JSON.stringify({ kind: 'denylist', terms: ['Prosjekt Ugle'] }));
    fill(/Begrunnelse/, 'Interne kodenavn');
    fireEvent.click(screen.getByRole('button', { name: 'Opprett' }));

    expect(await screen.findByText(/interne-navn er lagret/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      kind: 'denylist',
      terms: ['Prosjekt Ugle'],
      mandatory: false,
    });
  });
});
