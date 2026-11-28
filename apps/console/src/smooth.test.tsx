// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from './api';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';
import { prefetchSignal } from './response-cache';

document.getAnimations ??= () => [];

const chunk = vi.hoisted(() => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((resolve) => (release = resolve));
  return { held, release: () => release() };
});

vi.mock('./screens/StateRegister', async (importOriginal) => {
  await chunk.held;
  return importOriginal();
});

const recording = (base: typeof fetch = mockFetch()) => {
  const calls: { method: string; path: string }[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ method: init?.method ?? 'GET', path: url.replace(/^\/api/, '') });
    return base(input, init);
  };
  const gets = (path: string) => calls.filter((c) => c.method === 'GET' && c.path === path).length;
  return { fetch, gets };
};

const signedIn = async (path: string, fetch: typeof globalThis.fetch) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} />);
};

const go = (path: string) =>
  act(() => {
    window.location.hash = path;
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  });

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

const menuLink = (name: string) =>
  within(screen.getByRole('navigation', { name: 'Konsollmeny' })).getByRole('link', {
    name: new RegExp(`^${name}`),
  });

const sharedList = async () => screen.findByRole('heading', { level: 1, name: 'Delte tjenester' });

beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a smooth console', () => {
  it('coming straight back to a screen asks the API for nothing new', async () => {
    const api = recording();
    await signedIn('#/shared-services', api.fetch);
    await sharedList();
    await settle();
    await go('#/tenants');
    await screen.findByRole('table');
    await settle();

    await go('#/shared-services');
    await settle();

    expect(screen.getByRole('heading', { level: 1, name: 'Delte tjenester' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Henter tjenester' })).toBeNull();
    expect(api.gets('/operator/shared-services')).toBe(1);
  });

  it('returning later shows the last data at once and refreshes it in the background', async () => {
    const api = recording();
    await signedIn('#/shared-services', api.fetch);
    await sharedList();
    await settle();
    await go('#/tenants');
    await screen.findByRole('table');
    await settle();
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);

    await go('#/shared-services');

    expect(screen.queryByRole('status', { name: 'Henter tjenester' })).toBeNull();
    await waitFor(() => expect(api.gets('/operator/shared-services')).toBe(2));
  });

  it('resting the pointer on a menu link loads its screen before the click, and the screen reuses it', async () => {
    const api = recording();
    await signedIn('#/tenants', api.fetch);
    await screen.findByRole('table');
    await settle();
    expect(api.gets('/operator/shared-services')).toBe(0);

    fireEvent.pointerOver(menuLink('Delte tjenester'));
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(api.gets('/operator/shared-services')).toBe(1);

    await go('#/shared-services');
    await sharedList();
    await settle();
    expect(api.gets('/operator/shared-services')).toBe(1);
  });

  it('signing out forgets the cached answers', async () => {
    const api = recording();
    await signedIn('#/shared-services', api.fetch);
    await sharedList();
    await settle();

    fireEvent.click(screen.getByRole('button', { name: 'Brukermeny for Lise Dahl' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Logg ut' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Logg inn med Digdir-konto' }));
    await sharedList();
    await settle();

    await waitFor(() => expect(api.gets('/operator/shared-services')).toBe(2));
  });

  it('loads no data ahead for someone who is not an operator', async () => {
    const api = recording();
    const auth = mockEntra({ name: 'Ola Nordmann', roles: [] });
    await auth.login();
    window.location.hash = '#/shared-services';
    render(<App auth={auth} fetch={api.fetch} />);
    await settle();
    await settle();

    expect(api.gets('/operator/shared-services')).toBe(0);
  });

  it('keeps the current screen on view while the next screen is loading', async () => {
    await signedIn('#/tenants', mockFetch());
    await screen.findByRole('table');

    await go('#/state-register');

    expect(screen.getByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
    expect(screen.queryByRole('progressbar', { name: 'Henter …' })).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(screen.getByRole('progressbar', { name: 'Henter …' })).toBeTruthy();
    await act(async () => chunk.release());
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Statens organisering' }),
    ).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('progressbar')).toBeNull());
  });
});

describe('the response cache in the API client', () => {
  const client = () => {
    const api = recording();
    return {
      ...api,
      client: createApiClient({ baseUrl: '/api', fetch: api.fetch, token: () => undefined }),
    };
  };

  it('answers a second page load from the cache', async () => {
    const { client: api, gets } = client();

    await api.sharedServices(prefetchSignal());
    await api.sharedServices(prefetchSignal());

    expect(gets('/operator/shared-services')).toBe(1);
  });

  it('asks again after any change, so no screen shows what the change replaced', async () => {
    const { client: api, gets } = client();
    await api.sharedServices(prefetchSignal());

    await api
      .saveDemoSettings(
        {
          voice: 'v',
          viewport: [1280, 720],
          tenant: null,
          login: 'l',
          retentionDays: 1,
          writerDailyTokens: 1,
        },
        'Endrer innstillingene for test',
        1,
      )
      .catch(() => undefined);
    await api.sharedServices(prefetchSignal());

    expect(gets('/operator/shared-services')).toBe(2);
  });

  it("asks the API again for an organisation's data on every visit, so the content reason and the read log apply", async () => {
    const { client: api, gets } = client();

    await api.tenantFlags('991825827', prefetchSignal());
    await api.tenantFlags('991825827', prefetchSignal());

    expect(gets('/operator/tenants/991825827/flags')).toBe(2);
  });

  it('asks for live status on every visit, so an outage shows at once', async () => {
    const { client: api, gets } = client();

    await api.health(prefetchSignal());
    await api.health(prefetchSignal());
    await api.operations(prefetchSignal());
    await api.operations(prefetchSignal());

    expect(gets('/health')).toBe(2);
    expect(gets('/operator/operations')).toBe(2);
  });

  it('keeps a separate answer per person and per language', async () => {
    const api = recording();
    let actor = 'Lise Dahl';
    let language: 'nb' | 'en' = 'nb';
    const client = createApiClient({
      baseUrl: '/api',
      fetch: api.fetch,
      token: () => undefined,
      actorName: () => actor,
      locale: () => language,
    });

    await client.sharedServices(prefetchSignal());
    actor = 'Kari Nordmann';
    await client.sharedServices(prefetchSignal());
    language = 'en';
    await client.sharedServices(prefetchSignal());

    expect(api.gets('/operator/shared-services')).toBe(3);
  });

  it('always asks the API when the caller is not a page load', async () => {
    const { client: api, gets } = client();

    await api.sharedServices(prefetchSignal());
    await api.sharedServices(new AbortController().signal);

    expect(gets('/operator/shared-services')).toBe(2);
  });
});
