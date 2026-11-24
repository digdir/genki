import { describe, expect, it } from 'vitest';
import { browserLogin, samePath } from './login';

const memory = () => {
  const kept = new Map<string, string>();
  return {
    getItem: (key: string) => kept.get(key) ?? null,
    setItem: (key: string, value: string) => void kept.set(key, value),
    removeItem: (key: string) => void kept.delete(key),
  };
};

const json = (body: unknown) =>
  new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });

const login = (fetcher: typeof fetch, storage = memory(), now = () => 0) =>
  browserLogin({
    issuer: 'https://login.example.no',
    clientId: 'ka-host',
    audience: 'ka-host',
    altinnResource: null,
    fetch: fetcher,
    storage,
    location: () => new URL('https://ka.example.no/'),
    navigate: () => undefined,
    now,
  });

describe('the browser login', () => {
  it('returns after login only to a path on the same hostname', () => {
    expect(samePath('/om?x=1')).toBe('/om?x=1');
    for (const away of [
      '//evil.example',
      '/\\evil.example',
      'https://evil.example/',
      '',
      '/auth/callback',
    ])
      expect(samePath(away)).toBe('/');
  });

  it('forgets a session once its access token has expired', () => {
    const storage = memory();
    storage.setItem(
      'assistant.ka-host.session',
      JSON.stringify({ name: 'Kari', token: 't', expiresAt: 1000 }),
    );

    expect(login(fetch, storage, () => 999).current()).toEqual({ name: 'Kari', token: 't' });
    expect(login(fetch, storage, () => 1000).current()).toBeUndefined();
    expect(storage.getItem('assistant.ka-host.session')).toBeNull();
  });

  it('refuses an issuer whose metadata names another issuer', async () => {
    const other = login(async () =>
      json({
        issuer: 'https://evil.example',
        authorization_endpoint: 'https://evil.example/a',
        token_endpoint: 'https://evil.example/t',
      }),
    );

    await expect(other.start()).rejects.toThrow('discovery names another issuer');
  });
});
