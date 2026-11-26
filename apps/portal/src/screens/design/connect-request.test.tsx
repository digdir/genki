// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../../api';
import '../../test-utils';
import { ConnectRequest } from './ConnectRequest';

afterEach(cleanup);

const pending = {
  client: 'Claude',
  redirect: 'claude.ai',
  scope: 'design',
  startedAt: '2026-11-26T09:58:00Z',
};

const answering = (redirect: string, seen: { reason?: string | null; body?: unknown }[] = []) =>
  createApiClient({
    baseUrl: '/api',
    token: () => undefined,
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (init?.method === 'POST') {
        seen.push({
          reason: new Headers(init.headers).get('change-reason'),
          body: JSON.parse(String(init.body)),
        });
        return Response.json({ redirect });
      }
      if (url.endsWith('/requests/code'))
        return Response.json({ ...pending, client: 'Claude Code', redirect: 'loopback' });
      if (url.endsWith('/requests/gone'))
        return Response.json({ title: 'Borte', status: 404 }, { status: 404 });
      return Response.json(pending);
    },
  });

const screenFor = (api: ReturnType<typeof createApiClient>, pending: string, leave = vi.fn()) => {
  render(
    <ConnectRequest
      api={api}
      tenant="999888777"
      tenantName="Testetaten"
      route={{ path: `/design/connect/${pending}` } as never}
      live={false}
      pending={pending}
      leave={leave}
    />,
  );
  return leave;
};

describe('approving a Claude connection', () => {
  it('names the client, the organisation and where the answer goes before anything is granted', async () => {
    screenFor(answering('https://claude.ai/api/mcp/auth_callback?code=c'), 'r1');
    expect(
      await screen.findByText('Claude ber om å bruke Utforming i Testetaten som deg.'),
    ).toBeTruthy();
    expect(
      screen.getByText(/^Startet kl\. 10:58\. Svaret går til claude\.ai\. Godkjenn bare hvis/),
    ).toBeTruthy();
  });

  it('says a Claude Code connection answers to this machine', async () => {
    screenFor(answering('http://localhost:4100/callback?code=c'), 'code');
    expect(await screen.findByText(/Svaret går til denne maskinen \(Claude Code\)\./)).toBeTruthy();
  });

  it('sends the approval with a change reason and finishes it on the API in the same browser', async () => {
    const seen: { reason?: string | null; body?: unknown }[] = [];
    const finish = 'https://api.genki.test/oauth/design/finish/r1';
    const leave = screenFor(answering(finish, seen), 'r1');
    fireEvent.click(await screen.findByRole('button', { name: 'Tillat' }));
    await vi.waitFor(() => expect(leave).toHaveBeenCalledWith(finish));
    expect(seen[0]?.body).toEqual({ decision: 'allow' });
    expect(decodeURIComponent(seen[0]?.reason ?? '')).toBe('Koblet Claude til Utforming');
  });

  it('refuses to finish another connection than the one on screen', async () => {
    const leave = screenFor(answering('https://api.genki.test/oauth/design/finish/r2'), 'r1');
    fireEvent.click(await screen.findByRole('button', { name: 'Tillat' }));
    expect(
      await screen.findByText(
        'Svaret skulle gått et annet sted enn til Claude, så det ble stoppet.',
      ),
    ).toBeTruthy();
    expect(leave).not.toHaveBeenCalled();
  });

  it('refuses to send the browser anywhere but Claude, this machine or the API that finishes it', async () => {
    const leave = screenFor(answering('https://evil.example/cb?code=c'), 'r1');
    fireEvent.click(await screen.findByRole('button', { name: 'Avvis' }));
    expect(
      await screen.findByText(
        'Svaret skulle gått et annet sted enn til Claude, så det ble stoppet.',
      ),
    ).toBeTruthy();
    expect(leave).not.toHaveBeenCalled();
  });

  it('shows an error, not a grant, for a request that has expired', async () => {
    screenFor(answering('https://claude.ai/'), 'gone');
    expect(await screen.findByRole('button', { name: /Prøv igjen/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Tillat' })).toBeNull();
  });
});
