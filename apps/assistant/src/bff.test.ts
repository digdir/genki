import { describe, expect, it } from 'vitest';
import { bffSignIn } from './bff';

const answering = (status: number, body: unknown = {}, type = 'application/json') => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status,
      headers: { 'content-type': type },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

const signedIn = {
  name: 'Kari',
  organisation: '991825827',
  organisations: [{ orgNumber: '991825827' }],
  expiresAt: '2026-11-19T18:00:00.000Z',
};

describe('sign-in through the BFF', () => {
  it('reads who is signed in from the host, sending no token', async () => {
    const { calls, fetcher } = answering(200, signedIn);
    expect(await bffSignIn(fetcher).session()).toEqual({ kind: 'signed-in', who: signedIn });
    expect(calls[0]?.url).toBe('/auth/me');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBeNull();
  });

  it('treats a 401 as signed out', async () => {
    const { fetcher } = answering(401, { code: 'signed-out' }, 'application/problem+json');
    expect(await bffSignIn(fetcher).session()).toEqual({ kind: 'signed-out' });
  });

  it('takes a host that answers its page for /auth/me as one without the BFF', async () => {
    const { fetcher } = answering(200, '<!doctype html><div id="root"></div>', 'text/html');
    expect(await bffSignIn(fetcher).session()).toEqual({ kind: 'off' });
  });

  it('says sign-in is unavailable when the BFF has no login set up for the hostname', async () => {
    const { fetcher } = answering(404, { code: 'bff-not-configured' }, 'application/problem+json');
    expect(await bffSignIn(fetcher).session()).toEqual({ kind: 'unavailable' });
  });

  it('takes JSON that does not describe a session as no BFF', async () => {
    expect(await bffSignIn(answering(200, { data: [] }).fetcher).session()).toEqual({
      kind: 'off',
    });
  });

  it('keeps the return address and the page language on the host and sends the CSRF header with API calls', () => {
    const signIn = bffSignIn(answering(200).fetcher);
    expect(signIn.signInUrl('/threads/1?a=b')).toBe('/auth/login?next=%2Fthreads%2F1%3Fa%3Db');
    expect(signIn.signInUrl('/', 'nb')).toBe('/auth/login?next=%2F&lang=nb');
    expect(signIn.headers()).toEqual({ 'genai-csrf': '1' });
  });
});
