// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { Catalog } from './screens/Catalog';
import { Pipelines } from './screens/config/Pipelines';
import { Policies } from './screens/Policies';

document.getAnimations ??= () => [];
afterEach(cleanup);

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
  return { calls, api: createApiClient({ baseUrl: '/api', fetch, token: () => 'ops' }) };
};

const endpoint = {
  id: 'foundry-openai',
  kind: 'model-endpoint',
  scope: 'platform',
  origin: 'api',
  version: 3,
  spec: { adapter: 'openai-chat', baseURL: 'https://foundry.example', residency: 'eu' },
  by: 'operator:entra:lise',
  at: '2026-10-06T09:00:00Z',
};

describe('catalog in the console', () => {
  it('saves a new version of an entry with If-Match and a reason', async () => {
    const { api, calls } = platform({
      'GET /operator/catalog/entries?kind=model-endpoint': () => [200, { data: [endpoint] }],
      'GET /operator/catalog/model-endpoint/foundry-openai/versions': () => [200, { data: [] }],
      'PUT /operator/catalog/model-endpoint/foundry-openai': () => [
        200,
        { ...endpoint, version: 4 },
      ],
    });
    render(<Catalog api={api} tab="model-endpoint" />);

    fireEvent.click(await screen.findByRole('button', { name: /Åpne/ }));
    const json = screen.getByRole('textbox', { name: 'Innhold (JSON)' });
    fireEvent.change(json, {
      target: { value: JSON.stringify({ ...endpoint.spec, residency: 'norway' }) },
    });
    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Flyttet til Norge' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre ny versjon' }));

    expect(await screen.findByText(/foundry-openai er lagret/)).toBeTruthy();
    const put = calls.find((c) => c.method === 'PUT');
    expect(put?.headers.get('if-match')).toBe('"3"');
    expect(decodeURIComponent(put?.headers.get('change-reason') ?? '')).toBe('Flyttet til Norge');
    expect(put?.body).toMatchObject({ residency: 'norway' });
  });

  it('explains a version conflict instead of overwriting', async () => {
    const { api } = platform({
      'GET /operator/catalog/entries?kind=model-endpoint': () => [200, { data: [endpoint] }],
      'GET /operator/catalog/model-endpoint/foundry-openai/versions': () => [200, { data: [] }],
      'PUT /operator/catalog/model-endpoint/foundry-openai': () => [
        409,
        { title: 'Conflict', errors: [{ path: 'if-match', message: 'the entry is at version 4' }] },
      ],
    });
    render(<Catalog api={api} tab="model-endpoint" />);

    fireEvent.click(await screen.findByRole('button', { name: /Åpne/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Endring av oppføringen' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Lagre ny versjon' }));

    expect(await screen.findByText(/Noen andre har endret oppføringen/)).toBeTruthy();
  });
});

describe('quality gates and guardrail rules', () => {
  it('creates a mandatory guardrail rule for all tenants', async () => {
    const { api, calls } = platform({
      'GET /operator/guardrail-rules': () => [200, { data: [] }],
      'PUT /operator/guardrail-rules/fodselsnummer': (c) => [
        200,
        { id: 'fodselsnummer', scope: 'platform', version: 1, spec: c.body },
      ],
    });
    render(<Policies api={api} tab="guardrails" />);

    fireEvent.click(await screen.findByRole('button', { name: 'Ny' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Id' }), {
      target: { value: 'fodselsnummer' },
    });
    fireEvent.change(screen.getByRole('textbox', { name: 'Innhold (JSON)' }), {
      target: {
        value: JSON.stringify({ kind: 'regex', pattern: '\\b\\d{11}\\b', action: 'mask' }),
      },
    });
    fireEvent.click(screen.getByRole('checkbox', { name: /Påkrevd for alle tjenester/ }));
    fireEvent.change(screen.getByRole('textbox', { name: /Begrunnelse/ }), {
      target: { value: 'Personvern' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Opprett' }));

    expect(await screen.findByText(/fodselsnummer er lagret/)).toBeTruthy();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      kind: 'regex',
      pattern: '\\b\\d{11}\\b',
      action: 'mask',
      mandatory: true,
    });
  });
});

describe('ingestion pipelines', () => {
  it('shows that running needs a separate write key and a decision', async () => {
    const base = '/operator/datasets/digdir%2Fkudos/pipelines';
    const { api } = platform({
      [`GET ${base}`]: () => [
        200,
        {
          data: [{ id: 'nettsider', version: 1, spec: { name: 'Nettsider' } }],
          backend: { name: 'typesense', available: false, reason: 'no write key' },
        },
      ],
      [`GET ${base}/nettsider/versions`]: () => [200, { data: [] }],
      [`POST ${base}/nettsider/execute`]: () => [
        409,
        {
          title: 'Ingestion is not available',
          errors: [{ path: 'backend', message: 'no write key' }],
        },
      ],
    });
    render(<Pipelines api={api} base={base} />);

    fireEvent.click(await screen.findByRole('button', { name: /Åpne/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Kjør' }));

    expect(
      await screen.findByRole('heading', { name: 'Krever egen skrivenøkkel og en beslutning' }),
    ).toBeTruthy();
  });
});
