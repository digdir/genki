// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockAnsattporten, type AuthClient } from './auth';
import { mockFetch } from './mock';
import { kari } from './test-utils';
import type { Session } from './types';

beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
});
afterEach(cleanup);

const minutes = (n: number) => n * 60_000;

const renewable = (
  lifetime: () => number,
  refresh: () => Session | undefined,
): AuthClient & { refreshed: number } => {
  const inner = mockAnsattporten(kari);
  let expiresAt = 0;
  const client = {
    refreshed: 0,
    current: () => inner.current(),
    login: async () => {
      const s = await inner.login();
      expiresAt = Date.now() + lifetime();
      return s;
    },
    logout: () => inner.logout(),
    expiresAt: () => (inner.current() ? expiresAt : undefined),
    refresh: async () => {
      client.refreshed++;
      const s = refresh();
      if (s) expiresAt = Date.now() + minutes(60);
      return s;
    },
  };
  return client;
};

describe('the 60 minute session', () => {
  it('renews silently with the identity provider when it allows a refresh', async () => {
    const auth = renewable(
      () => minutes(4),
      () => ({ ...kari, token: 'renewed-token' }),
    );
    await auth.login();
    window.location.hash = '#/datasets';
    render(<App auth={auth} fetch={mockFetch()} live />);
    await screen.findByLabelText('Søk i datasett');
    await waitFor(() => expect(auth.refreshed).toBe(1));
    expect(screen.queryByText(/Økten din utløper/)).toBeNull();
  });

  it('warns 5 minutes before expiry when the session cannot be renewed', async () => {
    const auth = renewable(
      () => minutes(4),
      () => undefined,
    );
    await auth.login();
    window.location.hash = '#/datasets';
    render(<App auth={auth} fetch={mockFetch()} live />);
    expect(await screen.findByText(/^Økten din utløper klokka \d\d[.:]\d\d\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Logg inn på nytt' })).toBeTruthy();
  });

  it('keeps unsaved input through a re-login after the session expires', async () => {
    let lifetime = 300;
    const auth = renewable(
      () => lifetime,
      () => undefined,
    );
    await auth.login();
    window.location.hash = '#/datasets';
    render(<App auth={auth} fetch={mockFetch()} live />);
    fireEvent.change(await screen.findByLabelText('Søk i datasett'), {
      target: { value: 'tilsyn' },
    });

    expect(await screen.findByText('Du er logget ut')).toBeTruthy();
    lifetime = minutes(60);
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));

    const search = (await screen.findByLabelText('Søk i datasett')) as HTMLInputElement;
    await waitFor(() => expect(search.value).toBe('tilsyn'));
    expect(window.sessionStorage.getItem('genai.unsaved-input')).toBeNull();
  });
});
