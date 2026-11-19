import { describe, expect, it } from 'vitest';
import { bffSignIn } from './bff';

const answering = (status: number, body: unknown = {}) => {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, ...(init ? { init } : {}) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
};

describe('sign-in through the BFF', () => {
  it('reads who is signed in from the host, sending no token', async () => {
    const { calls, fetcher } = answering(200, { name: 'Kari', organisations: [] });
    expect((await bffSignIn(fetcher).current())?.name).toBe('Kari');
    expect(calls[0]?.url).toBe('/auth/me');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBeNull();
  });

  it('treats a 401 as signed out', async () => {
    expect(await bffSignIn(answering(401).fetcher).current()).toBeUndefined();
  });

  it('keeps the return address on the host and sends the CSRF header with API calls', () => {
    const signIn = bffSignIn(answering(200).fetcher);
    expect(signIn.signInUrl('/threads/1?a=b')).toBe('/auth/login?next=%2Fthreads%2F1%3Fa%3Db');
    expect(signIn.headers()).toEqual({ 'genai-csrf': '1' });
  });
});
