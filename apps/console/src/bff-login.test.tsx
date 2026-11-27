// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { bffLogin } from './bff-login';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];

const signedIn = (extra: Record<string, unknown> = {}) =>
  Response.json({
    name: 'Ola Drift',
    organisation: null,
    organisations: [],
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    ...extra,
  });
const signedOut = () =>
  Response.json({ type: 'urn:genai:problem:signed-out', status: 401 }, { status: 401 });

const platform = (me: () => Response, api: typeof fetch = mockFetch()) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const visited: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({ url, ...(init ? { init } : {}) });
    if (url === '/auth/me') return me();
    return api(input, init);
  };
  const auth = bffLogin({
    fetch,
    navigate: (url) => visited.push(url),
    here: () => `${window.location.pathname}${window.location.search}${window.location.hash}`,
  });
  return { auth, fetch, calls, visited };
};

const open = (p: ReturnType<typeof platform>) => render(<App auth={p.auth} fetch={p.fetch} />);

beforeEach(() => {
  window.history.replaceState(null, '', '/');
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('signing in through the platform login', () => {
  it('logs in through the platform login: sends the browser to /auth/login with the current page as next', async () => {
    window.history.replaceState(null, '', '/?view=1#/queue');
    const p = platform(signedOut);
    open(p);

    fireEvent.click(await screen.findByRole('button', { name: 'Logg inn med Digdir-konto' }));

    expect(p.visited).toEqual([`/auth/login?next=${encodeURIComponent('/?view=1#/queue')}`]);
  });

  it('shows the signed-out page when /auth/me answers 401', async () => {
    open(platform(signedOut));

    expect(await screen.findByRole('button', { name: 'Logg inn med Digdir-konto' })).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says sign-in is not available when the platform login is not configured here', async () => {
    open(
      platform(() =>
        Response.json(
          { type: 'urn:genai:problem:bff-not-configured', code: 'bff-not-configured' },
          { status: 404 },
        ),
      ),
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Innlogging er ikke tilgjengelig her.',
    );
  });

  it('treats a /auth/me that is not JSON as signed out with a login error', async () => {
    open(platform(() => new Response('<!doctype html>', { status: 200 })));

    expect((await screen.findByRole('alert')).textContent).toContain('Innloggingen mislyktes.');
    expect(screen.getByRole('button', { name: 'Logg inn med Digdir-konto' })).toBeTruthy();
  });

  it('lets an operator in', async () => {
    window.location.hash = '#/tenants';
    open(platform(() => signedIn({ operator: true })));

    expect(await screen.findByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
    expect(screen.getByText('Ola Drift')).toBeTruthy();
  });

  it('refuses a signed-in person who is not an operator', async () => {
    const p = platform(() => signedIn());
    open(p);

    expect(
      await screen.findByRole('heading', { name: 'Du har ikke tilgang til driftskonsollet' }),
    ).toBeTruthy();
    expect(screen.getByText(/Du er logget inn som Ola Drift/)).toBeTruthy();
    expect(screen.queryByRole('navigation')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Logg ut' }));
    expect(p.visited).toEqual(['/auth/logout']);
  });

  it('refuses a signed-in person who is not an operator when the login returns with signin=not-operator', async () => {
    window.history.replaceState(null, '', '/?signin=not-operator');
    const p = platform(signedOut);
    open(p);

    expect(
      await screen.findByRole('heading', { name: 'Du har ikke tilgang til driftskonsollet' }),
    ).toBeTruthy();
    expect(screen.getByText(/Kontoen du logget inn med, mangler driftsrollen/)).toBeTruthy();
    expect(window.location.search).toBe('');
    fireEvent.click(screen.getByRole('button', { name: 'Logg ut' }));
    expect(p.visited).toEqual(['/auth/logout']);
  });

  it('keeps no token in sessionStorage or localStorage once signed in', async () => {
    const p = platform(() => signedIn({ operator: true }));
    open(p);
    await screen.findByRole('heading', { level: 1, name: 'Virksomheter' });

    expect(p.auth.current()?.token).toBeUndefined();
    for (const store of [window.sessionStorage, window.localStorage])
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) ?? '';
        expect(`${key}=${store.getItem(key)}`).not.toMatch(/token|bearer|session/i);
      }
  });

  it('calls the API with the CSRF header and no Authorization header', async () => {
    const p = platform(() => signedIn({ operator: true }));
    open(p);
    await screen.findByRole('heading', { level: 1, name: 'Virksomheter' });

    const apiCalls = await waitFor(() => {
      const calls = p.calls.filter((call) => call.url.startsWith('/api/'));
      expect(calls.length).toBeGreaterThan(0);
      return calls;
    });
    for (const call of apiCalls) {
      const headers = new Headers(call.init?.headers);
      expect(headers.get('genai-csrf')).toBe('1');
      expect(headers.get('authorization')).toBeNull();
    }
  });

  it('logout sends the browser to /auth/logout', async () => {
    const p = platform(() => signedIn({ operator: true }));
    open(p);
    await screen.findByRole('heading', { level: 1, name: 'Virksomheter' });

    fireEvent.click(screen.getByRole('button', { name: 'Logg ut' }));

    expect(p.visited).toEqual(['/auth/logout']);
  });

  it('ends the session when an API call answers 401 and logs in again to the same page', async () => {
    const base = mockFetch();
    const api: typeof fetch = async (input, init) =>
      new URL(String(input), 'http://console.test').pathname === '/api/operator/tenants'
        ? signedOut()
        : base(input, init);
    window.location.hash = '#/tenants';
    const p = platform(() => signedIn({ operator: true }), api);
    open(p);
    expect(await screen.findByRole('heading', { name: 'Du er logget ut' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));

    expect(p.visited).toEqual([`/auth/login?next=${encodeURIComponent('/#/tenants')}`]);
  });

  it('keeps unsaved input when the session reaches expiresAt and /auth/me answers 401', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let active = true;
    const ends = new Date(Date.now() + 5 * 60_000).toISOString();
    window.location.hash = '#/tenants';
    const p = platform(() =>
      active ? signedIn({ operator: true, expiresAt: ends }) : signedOut(),
    );
    open(p);
    const search = await screen.findByLabelText('Søk etter navn eller org.nr.');
    fireEvent.change(search, { target: { value: 'Brønnøysund' } });
    active = false;

    await vi.advanceTimersByTimeAsync(6 * 60_000);

    expect(await screen.findByRole('heading', { name: 'Du er logget ut' })).toBeTruthy();
    expect(window.sessionStorage.getItem('genai.unsaved-input')).toContain('Brønnøysund');
  });
});

describe('the platform login session', () => {
  it('takes its end from expiresAt and re-reads /auth/me to renew', async () => {
    let ends = '2099-01-01T10:00:00.000Z';
    const p = platform(() => signedIn({ operator: true, expiresAt: ends }));

    await p.auth.restore?.();
    expect(p.auth.expiresAt?.()).toBe(Date.parse('2099-01-01T10:00:00.000Z'));
    ends = '2099-01-01T11:00:00.000Z';
    const renewed = await p.auth.renew?.();

    expect(renewed).toEqual({ name: 'Ola Drift', roles: ['GenAI.Operator'] });
    expect(p.auth.expiresAt?.()).toBe(Date.parse('2099-01-01T11:00:00.000Z'));
    const me = p.calls.filter((call) => call.url === '/auth/me');
    expect(me).toHaveLength(2);
    expect(me[0]?.init?.credentials).toBe('same-origin');
  });

  it('has no session once /auth/me answers 401 on renewal', async () => {
    let active = true;
    const p = platform(() => (active ? signedIn({ operator: true }) : signedOut()));
    await p.auth.restore?.();
    active = false;

    expect(await p.auth.renew?.()).toBeUndefined();
    expect(p.auth.current()).toBeUndefined();
    expect(p.auth.expiresAt?.()).toBeUndefined();
  });
});
