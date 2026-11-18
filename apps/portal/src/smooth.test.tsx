// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockAnsattporten } from './auth';
import { mockFetch } from './mock';
import { go, heldFetch, kari, renderAt } from './test-utils';

interface Call {
  method: string;
  path: string;
}

const chunks = vi.hoisted(() => {
  const gate = () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    return { held, release: () => release() };
  };
  return { usage: gate(), access: gate() };
});

vi.mock('./screens/Usage', async (importOriginal) => {
  await chunks.usage.held;
  return importOriginal();
});

vi.mock('./screens/Access', async (importOriginal) => {
  await chunks.access.held;
  return importOriginal();
});

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

const renderLiveAt = async (
  path: string,
  fetch: typeof globalThis.fetch,
  organisations = kari.organisations,
) => {
  const auth = mockAnsattporten({ ...kari, organisations });
  await auth.login();
  window.location.hash = path;
  render(<App auth={auth} fetch={fetch} live />);
};

const hover = async (link: string) => {
  const nav = screen.getByRole('navigation', { name: 'Hovedmeny' });
  fireEvent.pointerOver(within(nav).getByRole('link', { name: new RegExp(`^${link}`) }));
  await settle();
  await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
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

    const services = await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });
    expect(within(services).getByRole('link', { name: 'Rapportassistenten' })).toBeTruthy();
    expect(screen.getByText('Henter bruken')).toBeTruthy();
    await held.release();
  });

  it('the overview checks everything that decides what needs you before listing it', async () => {
    const held = heldFetch(/\/settings\/effective$/);
    await renderAt('#/overview', held.fetch);
    await settle();

    const attention = await screen.findByRole('region', { name: 'Trenger deg nå' });
    expect(within(attention).getByLabelText('Sjekker hva som trenger deg')).toBeTruthy();
    await held.release();
    await waitFor(() =>
      expect(within(attention).queryByLabelText('Sjekker hva som trenger deg')).toBeNull(),
    );
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
    await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });
    await settle();

    const asked = api.calls.slice(before).map((c) => c.path);
    expect(asked.some((p) => p.includes('/tenants/999777666/'))).toBe(true);
    expect(asked.filter((p) => p.includes('/tenants/999888777/'))).toEqual([]);
  });

  it('resting the pointer on a link loads the next screen before the click', async () => {
    const api = recording();
    await renderAt('#/overview', api.fetch);
    await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });
    await settle();
    expect(api.gets(logRuns)).toBe(0);

    const nav = screen.getByRole('navigation', { name: 'Hovedmeny' });
    fireEvent.pointerOver(within(nav).getByRole('link', { name: 'Logg' }));
    await settle();
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

    expect(api.gets(logRuns)).toBe(1);
    await go('#/log');
    await screen.findByRole('heading', { level: 1, name: 'Logg' });
    await settle();
    expect(api.gets(logRuns)).toBe(1);
  });

  const logRuns = /\/tasks\?from=[^&]+&to=[^&]+$/;
  const logTestRuns = /\/tasks\?from=[^&]+&to=[^&]+&origin=playground$/;
  const prefetched: [string, string, string, RegExp[]][] = [
    [
      'Oversikt',
      '#/log',
      '#/overview',
      [
        /\/overview$/,
        /\/usage\?days=\d+$/,
        /\/settings\/effective$/,
        /\/datasets$/,
        /\/tasks\?status=failed&from=[^&]+&limit=500$/,
        /\/audit$/,
      ],
    ],
    ['Datasett', '#/developer', '#/datasets', [/\/datasets$/, /\/catalog\?kind=dataset$/]],
    ['Innstillinger', '#/developer', '#/settings', [/\/settings$/, /\/settings\/effective$/]],
    ['Logg', '#/developer', '#/log', [logRuns, logTestRuns, /\/services$/]],
  ];

  it.each(prefetched)(
    'resting the pointer on %s loads its requests before the click and the screen reuses them',
    async (link, from, to, requests) => {
      const api = recording();
      await renderLiveAt(from, api.fetch);
      await screen.findByRole('navigation', { name: 'Hovedmeny' });
      await settle();
      const before = requests.map((r) => api.gets(r));

      await hover(link);
      const hovered = requests.map((r) => api.gets(r));
      requests.forEach((_, i) => expect(hovered[i]).toBe((before[i] ?? 0) + 1));

      await go(to);
      await settle();
      await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
      expect(requests.map((r) => api.gets(r))).toEqual(hovered);
    },
  );

  it('resting the pointer on Oversikt does not load the change log for someone without manage-services', async () => {
    const api = recording();
    await renderLiveAt('#/log', api.fetch, [
      { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services'] },
    ] as typeof kari.organisations);
    await screen.findByRole('navigation', { name: 'Hovedmeny' });
    await settle();

    await hover('Oversikt');

    expect(api.gets(/\/tasks\?status=failed/)).toBe(1);
    expect(api.gets(/\/(audit|access)$/)).toBe(0);
  });

  it('opening the log runs or changes asks for no run with the id "runs" or "changes"', async () => {
    const api = recording();
    await renderLiveAt('#/log/runs', api.fetch);
    await screen.findByRole('heading', { level: 1, name: 'Logg' });
    await go('#/log/changes');
    await settle();

    expect(api.gets(/\/tasks\/(runs|changes)/)).toBe(0);
  });

  it('coming back to the overview within the hour shows what needs you without checking again', async () => {
    vi.useFakeTimers({ now: new Date('2026-11-18T10:00:00Z'), toFake: ['Date'] });
    try {
      const api = recording();
      await renderLiveAt('#/overview', api.fetch);
      await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });
      await settle();
      await go('#/log');
      await screen.findByRole('heading', { level: 1, name: 'Logg' });
      await settle();
      vi.setSystemTime(new Date('2026-11-18T10:00:01Z'));

      await go('#/overview');

      const attention = screen.getByRole('region', { name: 'Trenger deg nå' });
      expect(within(attention).queryByLabelText('Sjekker hva som trenger deg')).toBeNull();
      expect(api.gets(/\/tasks\?status=failed/)).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['2026-11-17T23:04:00Z', '2026-11-30T23:30:00Z'])(
    'the screen reuses the usage loaded on hover just after midnight in Oslo (%s)',
    async (at) => {
      vi.useFakeTimers({ now: new Date(at), toFake: ['Date'] });
      try {
        const api = recording();
        await renderLiveAt('#/log', api.fetch);
        await screen.findByRole('navigation', { name: 'Hovedmeny' });
        await settle();

        await hover('Oversikt');
        await go('#/overview');
        await settle();
        await act(() => new Promise((resolve) => setTimeout(resolve, 100)));

        expect(api.gets(/\/usage\?days=\d+$/)).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ['manage-services', true],
    ['view-usage', false],
  ])(
    'opening the settings requests the tenant export only with the right %s',
    async (right, exports) => {
      const api = recording();
      await renderLiveAt('#/settings', api.fetch, [
        { orgNumber: '999888777', name: 'Testetaten', actions: ['use-services', right] },
      ] as typeof kari.organisations);
      await screen.findByRole('heading', { level: 1, name: 'Innstillinger for Testetaten' });
      await settle();

      expect(api.gets(/\/export$/) > 0).toBe(exports);
    },
  );

  it('navigation keeps the previous screen while the next one is pending', async () => {
    await renderAt('#/overview');
    await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });

    await go('#/statistics');

    expect(screen.getByRole('region', { name: 'Mest brukt siste 7 dager' })).toBeTruthy();
    expect(screen.queryByRole('status', { name: 'Henter …' })).toBeNull();
    await act(async () => chunks.usage.release());
    expect(await screen.findByRole('heading', { level: 1, name: 'Statistikk' })).toBeTruthy();
    expect(screen.queryByRole('region', { name: 'Mest brukt siste 7 dager' })).toBeNull();
  });

  it('the progress bar appears only after 200 ms', async () => {
    const bar = () => screen.queryByRole('progressbar', { name: 'Henter …' });
    await renderAt('#/overview');
    await screen.findByRole('region', { name: 'Mest brukt siste 7 dager' });

    await go('#/access');

    expect(bar()).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 150)));
    expect(bar()).toBeNull();
    await act(() => new Promise((resolve) => setTimeout(resolve, 100)));
    expect(bar()).toBeTruthy();
    await act(async () => chunks.access.release());
    await waitFor(() => expect(bar()).toBeNull());
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
