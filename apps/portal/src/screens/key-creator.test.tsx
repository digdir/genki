// @vitest-environment jsdom
import { LocaleProvider } from '@genai/i18n/react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient } from '../api';
import type { ServiceKeyView } from '../types';
import { Keys } from './integrations/Keys';
import { ServiceKeys } from './service/ServiceKeys';

document.getAnimations ??= () => [];
afterEach(cleanup);

const key = (patch: Partial<ServiceKeyView>): ServiceKeyView => ({
  id: 'k',
  name: 'Nøkkel',
  prefix: 'gp_abcd',
  lastFour: 'wxyz',
  scopes: ['query'],
  datasets: [],
  agents: [],
  callsPerMinute: 60,
  service: 'klarsprak',
  policy: null,
  client: null,
  lastUsedAt: null,
  rotatedFrom: null,
  allowedOverrides: [],
  createdAt: '2026-11-03T10:00:00Z',
  expiresAt: null,
  revokedAt: null,
  ...patch,
});

const keys = [
  key({
    id: 'a',
    name: 'Med skaper',
    createdBy: 'employee:ansattporten:abc',
    createdByName: 'Kari Nordmann',
    modelsInLockdown: true,
  }),
  key({ id: 'b', name: 'Uten skaper', createdBy: null, modelsInLockdown: false }),
];

const apiWith = (list: ServiceKeyView[]) =>
  createApiClient({
    baseUrl: '/api',
    token: () => 'test',
    fetch: async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url, 'http://test').pathname;
      const body = path.endsWith('/api-keys')
        ? { keys: list }
        : path.endsWith('/access')
          ? { services: [], keys: list }
          : path.endsWith('/datasets')
            ? { datasets: [] }
            : { data: [] };
      return Response.json(body);
    },
  });

const itemOf = async (name: string) => {
  const found = (await screen.findByText(name)).closest('li');
  if (!found) throw new Error(`no list item for ${name}`);
  return found.textContent ?? '';
};

describe('who created a key, and whether it may use models in lockdown', () => {
  it('shows on a service channel key who created it and when, and only the date for an old key', async () => {
    render(
      <ServiceKeys
        api={apiWith(keys)}
        tenant="991825827"
        service="klarsprak"
        clients={[]}
        onFlash={() => undefined}
      />,
    );

    expect(await itemOf('Med skaper')).toMatch(/laget 3\. nov\. 2026 av Kari Nordmann/);
    expect(await itemOf('Uten skaper')).toMatch(/laget 3\. nov\. 2026(?! av)/);
  });

  it('says on a service channel key whether it may use models in the locked environment', async () => {
    render(
      <ServiceKeys
        api={apiWith(keys)}
        tenant="991825827"
        service="klarsprak"
        clients={[]}
        onFlash={() => undefined}
      />,
    );

    expect(await itemOf('Med skaper')).toContain('Kan bruke modeller i det låste miljøet');
    expect(await itemOf('Uten skaper')).toContain(
      'Kan ikke bruke modeller i det låste miljøet: laget av en innlogging som ikke er sluppet inn',
    );
  });

  it('shows only the date when the creator has no known name', async () => {
    render(
      <ServiceKeys
        api={apiWith([key({ name: 'Uten navn', createdBy: 'agency-system:legacy-key:k1' })])}
        tenant="991825827"
        service="klarsprak"
        clients={[]}
        onFlash={() => undefined}
      />,
    );

    expect(await itemOf('Uten navn')).toMatch(/laget 3\. nov\. 2026(?! av)/);
  });

  it('says nothing about models on a revoked key', async () => {
    render(
      <ServiceKeys
        api={apiWith([
          key({ name: 'Trukket', revokedAt: '2026-11-04T10:00:00Z', modelsInLockdown: false }),
        ])}
        tenant="991825827"
        service="klarsprak"
        clients={[]}
        onFlash={() => undefined}
      />,
    );

    expect(await itemOf('Trukket')).not.toMatch(/modeller/);
  });

  it('says nothing about models when the environment is not locked', async () => {
    render(
      <ServiceKeys
        api={apiWith([key({ name: 'Åpen' })])}
        tenant="991825827"
        service="klarsprak"
        clients={[]}
        onFlash={() => undefined}
      />,
    );

    expect(await itemOf('Åpen')).not.toMatch(/modeller/);
  });

  it('shows on an integrations key who created it, in English too', async () => {
    render(
      <LocaleProvider preference="en">
        <Keys api={apiWith(keys)} tenant="991825827" onFlash={() => undefined} live />
      </LocaleProvider>,
    );

    expect(await itemOf('Med skaper')).toMatch(/created 3 Nov 2026 by Kari Nordmann/);
    expect(await itemOf('Med skaper')).toContain('Can use models in the locked environment');
    expect(await itemOf('Uten skaper')).toContain(
      'Cannot use models in the locked environment: created by a login that is not admitted',
    );
  });
});
