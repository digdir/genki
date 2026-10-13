// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockLogin, type AuthClient } from './auth';
import { caseworker, exampleDraft, mockApprovalsApi, mockWorkspaceApi } from './mock';
import { mockProjectsApi } from './projects-mock';
import { fixedNow } from './testing';
import type { Session } from './types';

document.getAnimations ??= () => [];
beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
});
afterEach(cleanup);

const minutes = (n: number) => n * 60_000;

const renewable = (lifetime: () => number, refresh: () => Session | undefined) => {
  const inner = mockLogin(caseworker);
  let expiresAt = 0;
  const client: AuthClient & { refreshed: number } = {
    refreshed: 0,
    current: () => inner.current(),
    login: async () => {
      const s = await inner.login();
      expiresAt = Date.now() + lifetime();
      return s;
    },
    logout: () => inner.logout?.() ?? Promise.resolve(),
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

const show = async (auth: AuthClient) => {
  await auth.login();
  window.location.hash = '#/';
  render(
    <App
      auth={auth}
      api={mockWorkspaceApi()}
      approvals={mockApprovalsApi()}
      draft={exampleDraft}
      projects={mockProjectsApi()}
      now={fixedNow}
    />,
  );
};

describe('the 60 minute workspace session', () => {
  it('renews silently with the identity provider when it allows a refresh', async () => {
    const auth = renewable(
      () => minutes(4),
      () => ({ ...caseworker, token: 'renewed-token' }),
    );
    await show(auth);
    await screen.findByLabelText(/Still et spørsmål/);
    await waitFor(() => expect(auth.refreshed).toBe(1));
    expect(screen.queryByText(/Økten din utløper/)).toBeNull();
  });

  it('warns 5 minutes before expiry when the session cannot be renewed', async () => {
    await show(
      renewable(
        () => minutes(4),
        () => undefined,
      ),
    );
    expect(await screen.findByText(/^Økten din utløper klokka \d\d[.:]\d\d\./)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Logg inn på nytt' })).toBeTruthy();
  });

  it('keeps the unsent question through a re-login after the session expires', async () => {
    let lifetime = 300;
    await show(
      renewable(
        () => lifetime,
        () => undefined,
      ),
    );
    fireEvent.change(await screen.findByLabelText(/Still et spørsmål/), {
      target: { value: 'Hva sier tildelingsbrevet?' },
    });

    expect(
      await screen.findByText('Økten din er utløpt. Logg inn igjen for å fortsette.'),
    ).toBeTruthy();
    lifetime = minutes(60);
    fireEvent.click(screen.getByRole('button', { name: 'Logg inn' }));

    const box = (await screen.findByLabelText(/Still et spørsmål/)) as HTMLTextAreaElement;
    await waitFor(() => expect(box.value).toBe('Hva sier tildelingsbrevet?'));
  });
});
