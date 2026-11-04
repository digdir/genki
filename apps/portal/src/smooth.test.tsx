// @vitest-environment jsdom
import { act, cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockFetch } from './mock';
import { go, heldFetch, renderAt } from './test-utils';

interface Call {
  method: string;
  path: string;
}

const recording = (base: typeof fetch = mockFetch()) => {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({ method: init?.method ?? 'GET', path: url.replace(/^\/api/, '') });
    return base(input, init);
  };
  const gets = (pattern: RegExp) =>
    calls.filter((c) => c.method === 'GET' && pattern.test(c.path)).length;
  return { calls, fetch, gets };
};

const settle = () => act(() => new Promise((resolve) => setTimeout(resolve, 20)));

beforeEach(() => {
  window.location.hash = '';
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a smooth portal', () => {
  it('returning to a screen shows its last data at once and refreshes it in the background', async () => {
    const api = recording();
    await renderAt('#/services', api.fetch);
    expect(await screen.findByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    await go('#/log');
    await screen.findByRole('heading', { level: 1, name: 'Logg' });
    await settle();
    const before = api.gets(/\/definitions$/);
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 60_000);

    await go('#/services');

    expect(screen.getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Henter tjenester' })).toBeNull();
    await waitFor(() => expect(api.gets(/\/definitions$/)).toBe(before + 1));
  });

  it('coming straight back to a screen asks the API for nothing', async () => {
    const api = recording();
    await renderAt('#/services', api.fetch);
    await screen.findByRole('link', { name: 'Rapportassistenten' });
    await go('#/log');
    await screen.findByRole('heading', { level: 1, name: 'Logg' });
    await settle();
    const before = api.calls.length;

    await go('#/services');
    await settle();

    expect(screen.getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expect(api.calls.slice(before)).toEqual([]);
  });

  it('a service list fetches once for all its parts', async () => {
    const api = recording();
    await renderAt('#/services', api.fetch);
    await screen.findByRole('link', { name: 'Rapportassistenten' });
    await settle();

    expect(api.gets(/\/definitions\/strategies$/)).toBe(1);
    expect(api.gets(/\/definitions$/)).toBe(1);
  });

  it('opening a service asks for its activity together with the service, not after it', async () => {
    const held = heldFetch(/\/definitions\/services\/rapportassistenten$/);
    const api = recording(held.fetch);
    await renderAt('#/services/rapportassistenten', api.fetch);

    await waitFor(() => expect(api.gets(/\/usage\?days=30$/)).toBe(1));
    expect(api.gets(/\/tasks\?service=rapportassistenten$/)).toBe(1);
    await held.release();
    await settle();
    expect(api.gets(/\/usage\?days=30$/)).toBe(1);
    expect(api.gets(/\/tasks\?service=rapportassistenten$/)).toBe(1);
  });

  it('the overview renders before the usage card has loaded', async () => {
    const held = heldFetch(/\/usage\?days=\d+$/);
    await renderAt('#/overview', held.fetch);

    const services = await screen.findByRole('region', { name: 'Tjenester' });
    expect(within(services).getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expect(screen.getByText('Henter forbruk')).toBeTruthy();
    await held.release();
  });

  it('the overview waits for what decides its alerts, so they do not push the page down', async () => {
    const held = heldFetch(/\/settings\/effective$/);
    await renderAt('#/overview', held.fetch);
    await settle();

    expect(screen.queryByRole('region', { name: 'Tjenester' })).toBeNull();
    await held.release();
    expect(await screen.findByRole('region', { name: 'Tjenester' })).toBeTruthy();
  });

  it('a check that only reads, such as validating a definition, keeps the cached screens', async () => {
    const api = recording();
    const { auth } = await renderAt('#/services', api.fetch);
    await screen.findByRole('link', { name: 'Rapportassistenten' });
    await settle();
    const before = api.gets(/\/definitions$/);
    const { createApiClient } = await import('./api');
    const client = createApiClient({
      baseUrl: '/api',
      fetch: api.fetch,
      token: () => auth.current()?.token,
    });
    await client.validate({ kind: 'Service' });

    await go('#/log');
    await screen.findByRole('heading', { level: 1, name: 'Logg' });
    await go('#/services');

    expect(screen.getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expect(api.gets(/\/definitions$/)).toBe(before);
  });

  it('switching organisation in the address asks only for the new organisation', async () => {
    const api = recording();
    await renderAt('#/log', api.fetch);
    await screen.findByRole('heading', { level: 1, name: 'Logg' });
    await settle();
    const before = api.calls.length;

    await go('#/overview?org=999777666');
    await screen.findByRole('region', { name: 'Tjenester' });
    await settle();

    const asked = api.calls.slice(before).map((c) => c.path);
    expect(asked.some((p) => p.includes('/tenants/999777666/'))).toBe(true);
    expect(asked.filter((p) => p.includes('/tenants/999888777/'))).toEqual([]);
  });

  it('resting the pointer on a link loads the next screen before the click', async () => {
    const api = recording();
    await renderAt('#/overview', api.fetch);
    await screen.findByRole('region', { name: 'Tjenester' });
    await settle();
    expect(api.gets(/\/tasks$/)).toBe(0);

    const nav = screen.getByRole('navigation', { name: 'Hovedmeny' });
    fireEvent.pointerOver(within(nav).getByRole('link', { name: 'Logg' }));
    await settle();
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    expect(api.gets(/\/tasks$/)).toBe(1);
    await go('#/log');
    await screen.findByRole('heading', { level: 1, name: 'Logg' });
    await settle();
    expect(api.gets(/\/tasks$/)).toBe(1);
  });

  it('going back to a list puts it back where it was scrolled to', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    Object.defineProperty(document.documentElement, 'scrollHeight', {
      value: 5000,
      configurable: true,
    });
    await renderAt('#/services');
    await screen.findByRole('link', { name: 'Rapportassistenten' });
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(640);

    window.location.hash = '#/services/rapportassistenten';
    await waitFor(() =>
      expect(screen.queryByRole('link', { name: 'Rapportassistenten' })).toBeNull(),
    );
    vi.spyOn(window, 'scrollY', 'get').mockReturnValue(0);
    scrollTo.mockClear();
    window.history.back();

    expect(await screen.findByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expect(scrollTo).toHaveBeenLastCalledWith(0, 640);
    vi.unstubAllGlobals();
  });
});
