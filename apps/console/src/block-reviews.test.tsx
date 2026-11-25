// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { App } from './App';
import { mockEntra, operatorRole } from './auth';
import { mockFetch } from './mock';

document.getAnimations ??= () => [];

const recording = (fetch = mockFetch()) => {
  const calls: { method: string; path: string; reason?: string }[] = [];
  const wrapped: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(String(input), 'http://mock');
    const raw = new Headers(init?.headers).get('change-reason');
    calls.push({
      method: init?.method ?? 'GET',
      path: url.pathname,
      ...(raw ? { reason: decodeURIComponent(raw) } : {}),
    });
    return fetch(input, init);
  };
  return { calls, fetch: wrapped };
};

let flagsAnswered = 0;

const withStudio =
  (fetch: typeof globalThis.fetch, on: boolean): typeof globalThis.fetch =>
  async (input, init) =>
    new URL(String(input), 'http://mock').pathname === '/api/me/flags'
      ? (flagsAnswered++,
        new Response(
          JSON.stringify({
            data: [
              {
                key: 'blockStudio',
                on,
                source: on ? 'tenant' : 'default',
                selfService: true,
                person: null,
                tenant: on ? true : null,
              },
            ],
          }),
          { headers: { 'content-type': 'application/json' } },
        ))
      : fetch(input, init);

const open = async (fetch: typeof globalThis.fetch, studio = true) => {
  const auth = mockEntra({ name: 'Lise Dahl', roles: [operatorRole] });
  await auth.login();
  window.location.hash = '#/block-reviews';
  render(<App auth={auth} fetch={withStudio(fetch, studio)} />);
};

const menu = () => screen.getByRole('navigation', { name: 'Konsollmeny' });

const review = async () => {
  fireEvent.click(await screen.findByRole('button', { name: 'Gjennomgå Figur' }));
  await screen.findByRole('heading', { name: 'Figur, utgave 2' });
};

const withReason = (text: string) =>
  fireEvent.change(screen.getByRole('textbox', { name: 'Begrunnelse' }), {
    target: { value: text },
  });

beforeEach(() => {
  window.location.hash = '';
});
afterEach(cleanup);

describe('designelementer til gjennomgang', () => {
  it('lists pending reviews and shows the source as plain text', async () => {
    await open(mockFetch());
    expect(await screen.findByRole('cell', { name: 'Figur' })).toBeTruthy();
    expect(screen.getByRole('cell', { name: /Brønnøysundregistrene/ })).toBeTruthy();
    await review();

    expect(screen.getByText('answer.text')).toBeTruthy();
    const bundle = await screen.findByLabelText('Pakke');
    expect(bundle.tagName).toBe('PRE');
    expect(bundle.textContent).toContain('<script>alert(1)</script>');
    expect(screen.getByText(/Det er pakken som godkjennes/)).toBeTruthy();
    expect(screen.getByLabelText('Kilde: block/source/figur.ts').textContent).toContain(
      '<script>alert(1)</script>',
    );
    expect(document.querySelector('script:not([src])')).toBeNull();
  });

  it('approves with a reason', async () => {
    const { calls, fetch } = recording();
    await open(fetch);
    await review();
    withReason('Kildekoden er gjennomgått');
    fireEvent.click(screen.getByRole('button', { name: 'Godkjenn' }));

    expect(await screen.findByText('Figur er delt med alle, som utgave 3.')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path).toBe(
      '/api/operator/block-share-requests/6f1c2b0e-8c1a-4a55-9d0c-2f7d3c1e9a10/approve',
    );
    expect(post?.reason).toBe('Kildekoden er gjennomgått');
    expect(screen.queryByRole('button', { name: 'Gjennomgå Figur' })).toBeNull();
  });

  it('declines with a reason', async () => {
    const { calls, fetch } = recording();
    await open(fetch);
    await review();
    withReason('Leser felt den ikke trenger');
    fireEvent.click(screen.getByRole('button', { name: 'Avvis' }));

    expect(await screen.findByText('Figur er avvist.')).toBeTruthy();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.path.endsWith('/decline')).toBe(true);
    expect(post?.reason).toBe('Leser felt den ikke trenger');
  });

  it('says so in one line when nothing waits', async () => {
    await open(mockFetch());
    await review();
    withReason('Kildekoden er gjennomgått');
    fireEvent.click(screen.getByRole('button', { name: 'Godkjenn' }));

    await waitFor(() =>
      expect(screen.getByText('Ingen designelementer venter på gjennomgang.')).toBeTruthy(),
    );
  });

  it('lets an operator decide only once the code is shown, and only once', async () => {
    const { calls, fetch } = recording();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const slow: typeof globalThis.fetch = async (input, init) => {
      if (String(input).endsWith('/6f1c2b0e-8c1a-4a55-9d0c-2f7d3c1e9a10')) await held;
      return fetch(input, init);
    };
    await open(slow);
    await review();
    withReason('Kildekoden er gjennomgått');
    const approve = screen.getByRole('button', { name: 'Godkjenn' }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    release();
    await screen.findByLabelText('Pakke');
    fireEvent.click(approve);
    fireEvent.click(approve);

    await screen.findByText('Figur er delt med alle, som utgave 3.');
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(1);
  });

  it('shows the menu item and the page only with the blockStudio flag', async () => {
    flagsAnswered = 0;
    await open(mockFetch(), false);
    await waitFor(() => expect(flagsAnswered).toBe(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(screen.getByRole('heading', { name: 'Fant ikke siden' })).toBeTruthy();
    expect(
      within(menu()).queryByRole('link', { name: 'Designelementer til gjennomgang' }),
    ).toBeNull();
    cleanup();

    await open(mockFetch());

    expect(
      await within(menu()).findByRole('link', { name: 'Designelementer til gjennomgang' }),
    ).toBeTruthy();
    expect(await screen.findByRole('cell', { name: 'Figur' })).toBeTruthy();
  });
});
