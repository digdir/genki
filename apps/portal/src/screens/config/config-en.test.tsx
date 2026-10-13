// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../../api';
import { TenantGates } from './TenantGates';
import { TestSetEditor } from './TestSetEditor';

document.getAnimations ??= () => [];
afterEach(cleanup);

const tenant = '991825827';

const platform = (routes: Record<string, unknown>) => {
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://localhost');
    const key = `${init?.method ?? 'GET'} ${url.pathname.replace(/^\/api/, '')}${url.search}`;
    const body = routes[key];
    return new Response(JSON.stringify(body ?? { title: 'Not found' }), {
      status: body === undefined ? 404 : 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  return createApiClient({ baseUrl: '/api', fetch, token: () => 'kari' });
};

describe('config screens in English', () => {
  it('lists quality requirements with English chrome', async () => {
    const api = platform({
      [`GET /tenants/${tenant}/gates`]: {
        data: [
          {
            kind: 'gate',
            id: `${tenant}/answers`,
            scope: tenant,
            version: 2,
            mandatory: true,
            at: '2026-10-01T08:00:00Z',
            by: 'operator:kari',
            spec: { metric: 'faithfulness', kind: 'threshold', threshold: 0.7 },
          },
        ],
      },
    });
    render(inEnglish(<TenantGates api={api} tenant={tenant} />));
    expect(await screen.findByText('1 entry')).toBeTruthy();
    expect(screen.getByText('Required')).toBeTruthy();
    expect(screen.getByText('faithfulness · at least 0.7')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Last changed' })).toBeTruthy();
    expect(screen.getByText(/2026.*Digdir/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open/ }));
    expect(screen.getByLabelText('Content (JSON)')).toBeTruthy();
    expect(screen.getByText('Save new version')).toBeTruthy();
  });

  it('asks for a longer reason in English when a case is saved', async () => {
    const api = platform({
      [`GET /tenants/${tenant}/test-sets?service=svc`]: { data: [] },
    });
    render(inEnglish(<TestSetEditor api={api} tenant={tenant} serviceId="svc" />));
    fireEvent.click(await screen.findByRole('button', { name: 'New test set' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create the test set' }));
    expect(await screen.findByText('Write the question or text.')).toBeTruthy();
    expect(screen.getByText('Write a reason of at least 10 characters.')).toBeTruthy();
  });
});
