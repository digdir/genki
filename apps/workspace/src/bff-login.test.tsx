// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorkspaceApi } from './api';
import { App } from './App';
import { bffLogin } from './bff-login';
import { exampleDraft, mockApprovalsApi, mockWorkspaceApi } from './mock';
import { createProjectsApi } from './projects-api';
import { mockProjectsApi } from './projects-mock';

document.getAnimations ??= () => [];
beforeEach(() => {
  window.location.hash = '';
  window.sessionStorage.clear();
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const minutes = (n: number) => n * 60_000;

const me = (overrides: Record<string, unknown> = {}) => ({
  name: 'Per Hansen',
  organisation: '999888777',
  organisations: [{ orgNumber: '999888777', name: 'Testetaten' }],
  expiresAt: new Date(Date.now() + minutes(60)).toISOString(),
  ...overrides,
});

const platform = (answer: () => Response, page = 'https://workspace.test/') => {
  const navigated: string[] = [];
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return answer();
  }) as typeof fetch;
  const auth = bffLogin({
    fetch: fetcher,
    navigate: (url) => navigated.push(url),
    location: () => new URL(page),
  });
  return { auth, navigated, calls };
};

const signedOutAnswer = () =>
  Response.json(
    { type: 'urn:genai:problem:signed-out', title: 'Signed out', status: 401 },
    { status: 401 },
  );

const show = (auth: ReturnType<typeof bffLogin>) =>
  render(
    <App
      auth={auth}
      api={mockWorkspaceApi()}
      approvals={mockApprovalsApi()}
      draft={exampleDraft}
      projects={mockProjectsApi()}
    />,
  );

describe('the platform login', () => {
  it('shows the signed-out page when /auth/me answers 401', async () => {
    const { auth, navigated } = platform(signedOutAnswer);
    show(auth);
    expect(await screen.findByText('Du er ikke logget inn.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Logg inn' })).toBeTruthy();
    expect(navigated).toEqual([]);
  });

  it('logs in through the platform login: sends the browser to /auth/login with the current page as next', async () => {
    const { auth, navigated } = platform(
      signedOutAnswer,
      'https://workspace.test/start?from=mail#/projects',
    );
    show(auth);
    fireEvent.click(await screen.findByRole('button', { name: 'Logg inn' }));
    expect(navigated).toEqual([
      `/auth/login?next=${encodeURIComponent('/start?from=mail#/projects')}`,
    ]);
  });

  it('reads the session from /auth/me on the same origin', async () => {
    const { auth, calls } = platform(() => Response.json(me()));
    show(auth);
    expect(await screen.findByText('Testetaten')).toBeTruthy();
    expect(calls[0]?.url).toBe('/auth/me');
    expect(calls[0]?.init?.credentials).toBe('same-origin');
    expect(new Headers(calls[0]?.init?.headers).get('accept')).toBe('application/json');
  });

  it('keeps no token in sessionStorage or localStorage once signed in', async () => {
    const { auth } = platform(() => Response.json(me()));
    show(auth);
    await screen.findByText('Testetaten');
    expect(auth.current()).not.toHaveProperty('token');
    for (const store of [window.sessionStorage, window.localStorage])
      for (let i = 0; i < store.length; i++) {
        const key = store.key(i) ?? '';
        expect(`${key} ${store.getItem(key)}`).not.toMatch(/token|bearer|eyJ/i);
      }
  });

  it('calls the API with the CSRF header and no Authorization header', async () => {
    const { auth } = platform(() => Response.json(me()));
    await auth.restore?.();
    const sent: Headers[] = [];
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      sent.push(new Headers(init?.headers));
      return Response.json({ data: [] });
    }) as typeof fetch;
    const token = () => auth.current()?.token;
    await createWorkspaceApi({ baseUrl: '/api', fetch: fetcher, token }).lockdown?.();
    await createWorkspaceApi({ baseUrl: '/api', fetch: fetcher, token }).rights?.('999888777');
    await createProjectsApi({ baseUrl: '/api', fetch: fetcher, token }).list('999888777');
    expect(sent).toHaveLength(3);
    for (const headers of sent) {
      expect(headers.get('genai-csrf')).toBe('1');
      expect(headers.has('authorization')).toBe(false);
    }
  });

  it('logout sends the browser to /auth/logout', async () => {
    const { auth, navigated } = platform(() => Response.json(me()));
    show(auth);
    fireEvent.click(await screen.findByRole('button', { name: 'Per Hansen, åpne brukermeny' }));
    fireEvent.click(screen.getByRole('button', { name: 'Logg ut' }));
    expect(navigated).toEqual(['/auth/logout']);
  });

  it('shows a login error when login is not configured on this hostname', async () => {
    const { auth, navigated } = platform(() =>
      Response.json(
        { type: 'urn:genai:problem:bff-not-configured', code: 'bff-not-configured', status: 404 },
        { status: 404 },
      ),
    );
    show(auth);
    expect(await screen.findByText('Innloggingen mislyktes')).toBeTruthy();
    expect(navigated).toEqual([]);
  });

  it('shows a login error when /auth/me is not served as JSON', async () => {
    const { auth } = platform(() => new Response('<!doctype html><title>app</title>'));
    show(auth);
    expect(await screen.findByText('Innloggingen mislyktes')).toBeTruthy();
  });

  it('works in the organisation the platform login chose', async () => {
    const { auth } = platform(() =>
      Response.json(
        me({
          organisation: '111222333',
          organisations: [
            { orgNumber: '999888777', name: 'Testetaten' },
            { orgNumber: '111222333', name: 'Andreetaten' },
          ],
        }),
      ),
    );
    const session = await auth.restore?.();
    expect(session?.organisations.map((o) => o.orgNumber)).toEqual(['111222333', '999888777']);
  });

  it('names an unnamed organisation by its number and an unnamed person as unknown', async () => {
    const { auth } = platform(() =>
      Response.json(me({ name: null, organisations: [{ orgNumber: '999888777' }] })),
    );
    const session = await auth.restore?.();
    expect(session).toEqual({
      name: 'Ukjent bruker',
      organisations: [{ orgNumber: '999888777', name: '999888777' }],
    });
  });

  it('renews the session by reading /auth/me again', async () => {
    let until = Date.now() + minutes(4);
    const { auth, calls } = platform(() =>
      Response.json(me({ expiresAt: new Date(until).toISOString() })),
    );
    await auth.restore?.();
    until += minutes(60);
    expect(await auth.refresh?.()).toBeTruthy();
    expect(auth.expiresAt?.()).toBe(until);
    expect(calls.map((c) => c.url)).toEqual(['/auth/me', '/auth/me']);
  });

  it('warns before the session ends and logs in again through /auth/login with the unsent question kept', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const until = new Date(Date.now() + minutes(4)).toISOString();
    const { auth, navigated } = platform(
      () => Response.json(me({ expiresAt: until })),
      'https://workspace.test/#/chat',
    );
    window.location.hash = '#/chat';
    show(auth);
    fireEvent.change(await screen.findByLabelText(/Still et spørsmål/), {
      target: { value: 'Hva sier tildelingsbrevet?' },
    });
    vi.advanceTimersByTime(minutes(2));
    expect(await screen.findByText(/^Økten din utløper klokka/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Logg inn på nytt' }));

    expect(navigated).toEqual([`/auth/login?next=${encodeURIComponent('/#/chat')}`]);
    expect(window.sessionStorage.getItem('genai.unsaved-input')).toContain(
      'Hva sier tildelingsbrevet?',
    );
  });
});
