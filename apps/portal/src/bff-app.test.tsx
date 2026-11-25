// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { bffLogin } from './bff-login';
import { mockFetch } from './mock';
import { kari } from './test-utils';

beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const signedIn = (expiresAt: number) => ({
  name: kari.name,
  organisation: null,
  organisations: kari.organisations.map(({ orgNumber, name }) => ({ orgNumber, name })),
  expiresAt: new Date(expiresAt).toISOString(),
});

const platform = (me: () => Response) => {
  const visited: string[] = [];
  const apiHeaders: Record<string, string>[] = [];
  const api = mockFetch();
  const send: typeof fetch = async (input, init) => {
    if (String(input) === '/auth/me') return me();
    apiHeaders.push({ ...(init?.headers as Record<string, string> | undefined) });
    return api(input, init);
  };
  const auth = bffLogin({
    fetch: send,
    navigate: (url) => visited.push(url),
    location: () => new URL(window.location.href),
  });
  return { auth, send, visited, apiHeaders };
};

const ok = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

describe('the portal on the platform login', () => {
  it('shows the signed-out page when /auth/me answers 401', async () => {
    const { auth, send, visited } = platform(
      () =>
        new Response(JSON.stringify({ code: 'signed-out' }), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    render(<App auth={auth} fetch={send} live />);

    expect((await screen.findAllByRole('button', { name: 'Logg inn' })).length).toBeGreaterThan(0);
    expect(screen.queryByRole('navigation', { name: 'Hovedmeny' })).toBeNull();
    expect(visited).toEqual([]);
  });

  it('shows a login error on the landing page when the platform login is not served', async () => {
    const { auth, send, visited } = platform(
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    );
    render(<App auth={auth} fetch={send} live />);

    expect(await screen.findByText('Innloggingen mislyktes. Prøv igjen.')).toBeTruthy();
    expect(visited).toEqual([]);
  });

  it('logs in through the platform login: sends the browser to /auth/login with the current page as next', async () => {
    window.location.hash = '#/datasets';
    const { auth, send, visited } = platform(
      () =>
        new Response(JSON.stringify({ code: 'signed-out' }), {
          status: 401,
          headers: { 'content-type': 'application/problem+json' },
        }),
    );
    render(<App auth={auth} fetch={send} live />);

    fireEvent.click((await screen.findAllByRole('button', { name: 'Logg inn' }))[0] as HTMLElement);

    await waitFor(() => expect(visited).toHaveLength(1));
    const next = new URL(visited[0] as string, 'https://portal.example').searchParams.get('next');
    expect(visited[0]?.startsWith('/auth/login?next=')).toBe(true);
    expect(next).toBe(
      `${window.location.pathname}${window.location.search}${window.location.hash}`,
    );
  });

  it('keeps no token in sessionStorage or localStorage once signed in', async () => {
    const { auth, send } = platform(() => ok(signedIn(Date.now() + 3_600_000)));
    render(<App auth={auth} fetch={send} live />);
    await screen.findByRole('navigation', { name: 'Hovedmeny' });

    const stored = [window.sessionStorage, window.localStorage].flatMap((store) =>
      Object.keys(store).map((key) => `${key}=${store.getItem(key) ?? ''}`),
    );
    expect(stored.filter((entry) => /token|bearer|eyJ/i.test(entry))).toEqual([]);
  });

  it('calls the API with the CSRF header and no Authorization header', async () => {
    const { auth, send, apiHeaders } = platform(() => ok(signedIn(Date.now() + 3_600_000)));
    render(<App auth={auth} fetch={send} live />);
    await screen.findByRole('navigation', { name: 'Hovedmeny' });

    await waitFor(() => expect(apiHeaders.length).toBeGreaterThan(0));
    for (const headers of apiHeaders) {
      expect(headers['genai-csrf']).toBe('1');
      expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
    }
  });

  it('logout sends the browser to /auth/logout', async () => {
    const { auth, send, visited } = platform(() => ok(signedIn(Date.now() + 3_600_000)));
    render(<App auth={auth} fetch={send} live />);
    const user = await screen.findByRole('button', { name: /^Brukermeny for Kari Nordmann/ });

    await waitFor(() => {
      if (!screen.queryByRole('menu', { name: 'Brukermeny' })) fireEvent.click(user);
      const menu = screen.getByRole('menu', { name: 'Brukermeny' });
      fireEvent.click(within(menu).getByRole('menuitem', { name: 'Logg ut' }));
    });

    await waitFor(() => expect(visited).toEqual(['/auth/logout']));
  });

  it('warns before the session ends and logs in again through the platform login with unsaved input kept', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const endsAt = Date.now() + 4 * 60_000;
    const { auth, send, visited } = platform(() => ok(signedIn(endsAt)));
    window.location.hash = '#/datasets';
    render(<App auth={auth} fetch={send} live />);
    fireEvent.change(await screen.findByLabelText('Søk i dokumentsamlinger'), {
      target: { value: 'tilsyn' },
    });

    vi.advanceTimersByTime(2 * 60_000);
    fireEvent.click(await screen.findByRole('button', { name: 'Logg inn på nytt' }));

    expect(visited).toHaveLength(1);
    expect(visited[0]?.startsWith('/auth/login?next=')).toBe(true);
    expect(window.sessionStorage.getItem('genai.unsaved-input')).toContain('tilsyn');
  });
});
