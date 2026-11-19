// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { ansattportenLogin, mockEntra, operatorRole, type AuthClient } from './auth';
import { mockFetch } from './mock';
import { isSilentCallback } from './silent-frame';
import type { OperatorSession } from './types';

document.getAnimations ??= () => [];

const issuer = 'https://test.ansattporten.no';
const tokenEndpoint = '/api/ansattporten/token';
const start = new Date('2026-10-07T10:00:00Z').getTime();
const minutes = (n: number) => n * 60_000;

const encode = (value: unknown) =>
  btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
const jwt = (claims: Record<string, unknown>) => `${encode({ alg: 'none' })}.${encode(claims)}.sig`;
const accessToken = (name: string, sub = 'operator-1', exp = start / 1000 + 300) =>
  jwt({ sub, exp, name });

const memoryStorage = (): Storage => {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (key) => data.get(key) ?? null,
    key: (i) => [...data.keys()][i] ?? null,
    removeItem: (key) => void data.delete(key),
    setItem: (key, value) => void data.set(key, value),
  };
};

const bearerOf = (init?: RequestInit) => new Headers(init?.headers).get('authorization');

interface Provider {
  refreshTokens?: string[];
  promptValues?: string[];
  silentSubject?: string;
}

const ansattporten = (provider: Provider = {}) => {
  const requests: { url: string; init?: RequestInit }[] = [];
  const visited: string[] = [];
  const silentlyAuthorized: URL[] = [];
  let nonce: string | undefined;
  let issued = 0;
  let lastRefresh: string | undefined;
  const refreshTokens = [...(provider.refreshTokens ?? [])];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, ...(init ? { init } : {}) });
    if (url === `${issuer}/.well-known/openid-configuration`)
      return Response.json({
        authorization_endpoint: `${issuer}/authorize`,
        end_session_endpoint: `${issuer}/logout`,
        ...(provider.promptValues ? { prompt_values_supported: provider.promptValues } : {}),
      });
    if (url === tokenEndpoint) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'refresh_token' && form.get('refresh_token') !== lastRefresh)
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      issued++;
      const silent = form.get('code') === 'silent';
      const refresh = refreshTokens.shift();
      lastRefresh = refresh;
      return Response.json({
        access_token: accessToken(
          `Ola Drift ${issued}`,
          silent ? (provider.silentSubject ?? 'operator-1') : 'operator-1',
          start / 1000 + 300 * issued,
        ),
        id_token: jwt({ name: 'Ola Drift', nonce }),
        ...(refresh ? { refresh_token: refresh } : {}),
      });
    }
    if (url === '/api/operator/tenants') return Response.json({ data: [] });
    return new Response('not found', { status: 404 });
  };
  const auth = ansattportenLogin({
    issuer,
    clientId: 'genki-console',
    redirectUri: 'https://console.example/callback',
    postLogoutRedirectUri: 'https://console.example/',
    tokenEndpoint,
    apiBaseUrl: '/api',
    audience: 'digdir:genai',
    resource: 'urn:altinn:resource:digdir-genai-platform',
    fetch,
    storage: memoryStorage(),
    navigate: (url) => visited.push(url),
    silent: async (url) => {
      const sent = new URL(url);
      silentlyAuthorized.push(sent);
      nonce = sent.searchParams.get('nonce') ?? undefined;
      return new URL(
        `https://console.example/callback?code=silent&state=${sent.searchParams.get('state')}&iss=${issuer}`,
      );
    },
  });
  const signIn = async () => {
    void auth.login();
    await waitFor(() => expect(visited).toHaveLength(1));
    const sent = new URL(visited[0] ?? '');
    nonce = sent.searchParams.get('nonce') ?? undefined;
    return auth.completeLogin?.(
      new URL(`https://console.example/callback?code=abc&state=${sent.searchParams.get('state')}`),
    );
  };
  return { auth, requests, visited, silentlyAuthorized, signIn };
};

const renewable = (renew: () => OperatorSession | undefined) => {
  const inner = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  let expiresAt = 0;
  const client: AuthClient & { renewed: number } = {
    renewed: 0,
    current: () => inner.current(),
    login: async () => {
      const session = await inner.login();
      expiresAt = Date.now() + minutes(5);
      return session;
    },
    logout: () => inner.logout(),
    expire: () => inner.expire(),
    expiresAt: () => (inner.current() ? expiresAt : undefined),
    renew: async () => {
      client.renewed++;
      const session = renew();
      if (session) expiresAt = Date.now() + minutes(5);
      return session;
    },
  };
  return client;
};

beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('keeping the operator signed in', () => {
  it('renews the session before the token expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const auth = renewable(() => ({
      name: 'Lise Dahl',
      roles: [operatorRole],
      token: 'renewed-token',
    }));
    await auth.login();
    window.location.hash = '#/tenants';
    render(<App auth={auth} fetch={mockFetch()} />);
    await screen.findByRole('heading', { level: 1, name: 'Virksomheter' });

    await vi.advanceTimersByTimeAsync(minutes(4));
    await waitFor(() => expect(auth.renewed).toBe(1));
    await vi.advanceTimersByTimeAsync(minutes(2));

    expect(screen.queryByRole('heading', { name: 'Du er logget ut' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Virksomheter' })).toBeTruthy();
  });

  it('renews once on a 401 and retries the request with the new token', async () => {
    const auth = renewable(() => ({
      name: 'Lise Dahl',
      roles: [operatorRole],
      token: 'renewed-token',
    }));
    await auth.login();
    const base = mockFetch();
    const tenantCalls: (string | null)[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      if (!String(input).endsWith('/operator/tenants')) return base(input, init);
      tenantCalls.push(bearerOf(init));
      return bearerOf(init) === 'Bearer renewed-token'
        ? base(input, init)
        : Response.json({ title: 'Ikke logget inn' }, { status: 401 });
    };
    window.location.hash = '#/tenants';
    render(<App auth={auth} fetch={fetch} />);

    expect(await screen.findByText('Testby kommune')).toBeTruthy();
    expect(auth.renewed).toBe(1);
    expect(tenantCalls).toEqual(['Bearer mock-entra-token', 'Bearer renewed-token']);
    expect(screen.queryByRole('heading', { name: 'Du er logget ut' })).toBeNull();
  });

  it('returns to login when the renewal fails', async () => {
    const auth = renewable(() => undefined);
    await auth.login();
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) =>
      String(input).endsWith('/operator/tenants')
        ? Response.json({ title: 'Ikke logget inn' }, { status: 401 })
        : base(input, init);
    window.location.hash = '#/tenants';
    render(<App auth={auth} fetch={fetch} />);

    expect(await screen.findByRole('heading', { name: 'Du er logget ut' })).toBeTruthy();
    expect(auth.renewed).toBe(1);
    expect(screen.getByRole('button', { name: 'Logg inn' })).toBeTruthy();
  });

  it('keeps unsaved input through a re-login after the session expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const auth = renewable(() => undefined);
    await auth.login();
    window.location.hash = '#/tenants';
    render(<App auth={auth} fetch={mockFetch()} />);
    const search = await screen.findByLabelText('Søk etter navn eller org.nr.');
    fireEvent.change(search, { target: { value: 'Brønnøysund' } });

    await vi.advanceTimersByTimeAsync(minutes(6));
    expect(await screen.findByRole('heading', { name: 'Du er logget ut' })).toBeTruthy();
    window.location.hash = '#/settings';
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));

    await waitFor(() =>
      expect(
        (screen.getByLabelText('Søk etter navn eller org.nr.') as HTMLInputElement).value,
      ).toBe('Brønnøysund'),
    );
    expect(window.location.hash).toBe('#/tenants');
    expect(window.sessionStorage.getItem('genai.unsaved-input')).toBeNull();
  });
});

describe('renewing the Ansattporten token', () => {
  it('renews with the refresh token when Ansattporten issues one, and keeps the rotated one', async () => {
    const provider = ansattporten({
      refreshTokens: ['refresh-token-one', 'refresh-token-two', 'refresh-token-three'],
    });
    await provider.signIn();

    expect((await provider.auth.renew?.())?.name).toBe('Ola Drift');
    await provider.auth.renew?.();

    const grants = provider.requests
      .filter((r) => r.url === tokenEndpoint)
      .map((r) => new URLSearchParams(String(r.init?.body)));
    expect(grants.map((g) => [g.get('grant_type'), g.get('refresh_token')])).toEqual([
      ['authorization_code', null],
      ['refresh_token', 'refresh-token-one'],
      ['refresh_token', 'refresh-token-two'],
    ]);
    expect(provider.silentlyAuthorized).toHaveLength(0);
    expect(provider.auth.current()).not.toHaveProperty('refreshToken');
  });

  it('never sends the refresh token anywhere but the token endpoint', async () => {
    const provider = ansattporten({ refreshTokens: ['refresh-token-one', 'refresh-token-two'] });
    await provider.signIn();
    await provider.auth.renew?.();
    await provider.auth.logout();

    const elsewhere = [
      ...provider.requests
        .filter((r) => r.url !== tokenEndpoint)
        .map((r) => `${r.url} ${JSON.stringify(r.init ?? {})}`),
      ...provider.visited,
      ...provider.silentlyAuthorized.map(String),
    ];
    expect(elsewhere.length).toBeGreaterThan(0);
    for (const sent of elsewhere) {
      expect(sent).not.toContain('refresh-token-one');
      expect(sent).not.toContain('refresh-token-two');
    }
  });

  it('renews without a refresh token by a silent prompt=none authorization', async () => {
    const provider = ansattporten({ promptValues: ['login', 'none'] });
    await provider.signIn();
    const before = provider.auth.current()?.token;

    const renewed = await provider.auth.renew?.();

    const silent = provider.silentlyAuthorized[0];
    expect(silent?.searchParams.get('prompt')).toBe('none');
    expect(silent?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(silent?.searchParams.has('id_token_hint')).toBe(false);
    expect(renewed?.token).not.toBe(before);
    expect(provider.auth.current()?.token).toBe(renewed?.token);
    expect(provider.auth.expiresAt?.()).toBe(start + minutes(10));
  });

  it('does not try a silent authorization when Ansattporten does not offer prompt=none', async () => {
    const provider = ansattporten({ promptValues: ['login'] });
    await provider.signIn();

    expect(await provider.auth.renew?.()).toBeUndefined();
    expect(provider.silentlyAuthorized).toHaveLength(0);
  });

  it('refuses a silent renewal that comes back as another person', async () => {
    const provider = ansattporten({ silentSubject: 'someone-else' });
    const first = await provider.signIn();

    expect(await provider.auth.renew?.()).toBeUndefined();
    expect(provider.auth.current()?.token).toBe(first?.token);
  });

  it('does not start the console inside the silent renewal frame', () => {
    const page = (pathname: string, framed: boolean) => {
      const win: Record<string, unknown> = { location: { pathname } };
      win.self = win;
      win.top = framed ? {} : win;
      return win as unknown as Window;
    };

    expect(isSilentCallback(page('/callback', true))).toBe(true);
    expect(isSilentCallback(page('/callback', false))).toBe(false);
    expect(isSilentCallback(page('/', true))).toBe(false);
  });
});
