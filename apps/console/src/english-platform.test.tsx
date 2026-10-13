// @vitest-environment jsdom
import { inEnglish } from '@genai/i18n/react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from './api';
import { Catalog } from './screens/Catalog';
import { Policies } from './screens/Policies';
import { PlatformDefaults } from './screens/PlatformDefaults';
import { SharedServices } from './screens/SharedServices';

document.getAnimations ??= () => [];
afterEach(cleanup);

const apiFor = (routes: Record<string, unknown>) =>
  createApiClient({
    baseUrl: '/api',
    token: () => 'ops',
    fetch: async (input, init) => {
      const url = new URL(String(input), 'http://localhost');
      const key = `${init?.method ?? 'GET'} ${url.pathname.replace(/^\/api/, '')}${url.search}`;
      const body = routes[key];
      return new Response(JSON.stringify(body ?? { title: 'Not found' }), {
        status: body === undefined ? 404 : 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

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

describe('platform screens in English', () => {
  it('shows the catalogue registry and editor in English', async () => {
    const api = apiFor({
      'GET /operator/catalog/entries?kind=model-endpoint': { data: [endpoint] },
      'GET /operator/catalog/model-endpoint/foundry-openai/versions': { data: [] },
    });
    render(inEnglish(<Catalog api={api} tab="model-endpoint" />));

    expect(await screen.findByText('1 entry')).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Model endpoints' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Open/ }));
    expect(screen.getByRole('button', { name: 'Save new version' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save new version' }));
    expect(await screen.findByText('Write a reason of at least 10 characters.')).toBeTruthy();
  });

  it('shows policies and the retired defaults page in English', async () => {
    const api = apiFor({ 'GET /operator/gates': { data: [] } });
    render(inEnglish(<Policies api={api} tab="gates" />));
    expect(
      screen.getByRole('heading', { level: 1, name: 'Quality requirements and safeguards' }),
    ).toBeTruthy();
    expect(await screen.findByText('No quality requirements yet')).toBeTruthy();
    cleanup();
    render(inEnglish(<PlatformDefaults />));
    expect(screen.getByText('This page has been replaced')).toBeTruthy();
  });

  it('shows shared services with English sharing labels', async () => {
    const api = apiFor({
      'GET /operator/shared-services': {
        data: [
          {
            tenant: '974760673',
            id: 'summary',
            name: 'Summary',
            publicNames: ['summary'],
            version: 2,
            availableTo: ['a', 'b'],
          },
        ],
      },
    });
    render(inEnglish(<SharedServices api={api} />));
    expect(await screen.findByText('2 organisations')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'Share Summary with all organisations' }),
    ).toBeTruthy();
  });
});
