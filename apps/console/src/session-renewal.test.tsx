// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole, type AuthClient } from './auth';
import { mockFetch } from './mock';
import type { OperatorSession } from './types';

document.getAnimations ??= () => [];

const minutes = (n: number) => n * 60_000;

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
  it('renews the session before it expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const auth = renewable(() => ({
      name: 'Lise Dahl',
      roles: [operatorRole],
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

  it('ends the session on a 401 without trying to renew it', async () => {
    const auth = renewable(() => ({ name: 'Lise Dahl', roles: [operatorRole] }));
    await auth.login();
    const base = mockFetch();
    const fetch: typeof globalThis.fetch = async (input, init) =>
      String(input).endsWith('/operator/tenants')
        ? Response.json({ type: 'urn:genai:problem:signed-out' }, { status: 401 })
        : base(input, init);
    window.location.hash = '#/tenants';
    render(<App auth={auth} fetch={fetch} />);

    expect(await screen.findByRole('heading', { name: 'Du er logget ut' })).toBeTruthy();
    expect(auth.renewed).toBe(0);
    expect(screen.getByRole('button', { name: 'Logg inn' })).toBeTruthy();
  });

  it('keeps unsaved input through a re-login after the session expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const auth = renewable(() => undefined);
    await auth.login();
    window.location.hash = '#/tenants';
    render(<App auth={auth} fetch={mockFetch()} />);
    const search = await screen.findByRole('searchbox', { name: 'Søk' });
    fireEvent.change(search, { target: { value: 'Brønnøysund' } });

    await vi.advanceTimersByTimeAsync(minutes(6));
    expect(await screen.findByRole('heading', { name: 'Du er logget ut' })).toBeTruthy();
    window.location.hash = '#/settings';
    vi.useRealTimers();
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));

    await waitFor(() =>
      expect((screen.getByRole('searchbox', { name: 'Søk' }) as HTMLInputElement).value).toBe(
        'Brønnøysund',
      ),
    );
    expect(window.location.hash).toBe('#/tenants');
    expect(window.sessionStorage.getItem('genai.unsaved-input')).toBeNull();
  });
});
