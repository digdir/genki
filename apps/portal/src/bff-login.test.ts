import { describe, expect, it } from 'vitest';
import { bffLogin } from './bff-login';

const json = (status: number, body: unknown, type = 'application/json') =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': type } });

const me = (expiresAt = '2026-10-07T18:00:00.000Z') => ({
  name: 'Ingrid Berg',
  organisation: '405003309',
  organisations: [
    { orgNumber: '405003309', name: 'Testdepartementet' },
    { orgNumber: '991825827' },
  ],
  expiresAt,
});

const client = (answer: () => Response, at = 'https://portal.example/datasets?x=1#/datasets') => {
  const visited: string[] = [];
  const asked: RequestInit[] = [];
  const auth = bffLogin({
    fetch: async (input, init) => {
      expect(String(input)).toBe('/auth/me');
      asked.push(init ?? {});
      return answer();
    },
    navigate: (url) => visited.push(url),
    location: () => new URL(at),
    uiLocale: () => 'nb',
  });
  return { auth, visited, asked };
};

describe('the platform login', () => {
  it('logs in through the platform login: sends the browser to /auth/login with the current page as next and its language', () => {
    const { auth, visited } = client(() => json(401, {}));
    void auth.login();
    expect(visited).toEqual([
      `/auth/login?next=${encodeURIComponent('/datasets?x=1#/datasets')}&lang=nb`,
    ]);
  });

  it('logout sends the browser to /auth/logout', async () => {
    const { auth, visited } = client(() => json(200, me()));
    await auth.restore?.();
    await auth.logout(true);
    expect(visited).toEqual(['/auth/logout']);
    expect(auth.current()).toBeUndefined();
  });

  it('forgets the session without leaving the page when only the local session ends', async () => {
    const { auth, visited } = client(() => json(200, me()));
    await auth.restore?.();
    await auth.logout();
    expect(visited).toEqual([]);
    expect(auth.current()).toBeUndefined();
  });

  it('reads the person, organisations and expiry from /auth/me with the session cookie', async () => {
    const { auth, asked } = client(() => json(200, me()));
    const session = await auth.restore?.();
    expect(session).toEqual({
      name: 'Ingrid Berg',
      organisations: [
        { orgNumber: '405003309', name: 'Testdepartementet' },
        { orgNumber: '991825827', name: '991825827' },
      ],
    });
    expect(session?.token).toBeUndefined();
    expect(auth.expiresAt?.()).toBe(Date.parse('2026-10-07T18:00:00.000Z'));
    expect(asked[0]).toMatchObject({
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
  });

  it('names a person /auth/me has no name for as an unknown user', async () => {
    const { auth } = client(() => json(200, { ...me(), name: null }));
    expect((await auth.restore?.())?.name).toBe('Ukjent bruker');
  });

  it('is signed out when /auth/me answers 401', async () => {
    const { auth, visited } = client(() =>
      json(401, { code: 'signed-out' }, 'application/problem+json'),
    );
    expect(await auth.restore?.()).toBeUndefined();
    expect(auth.current()).toBeUndefined();
    expect(visited).toEqual([]);
  });

  it.each([
    [
      'the platform login is not configured here',
      () => json(404, { code: 'bff-not-configured' }, 'application/problem+json'),
    ],
    [
      'the BFF is not served',
      () =>
        new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ],
  ])(
    'reports a login error and does not send the browser to a login when %s',
    async (_, answer) => {
      const { auth, visited } = client(answer);
      await expect(auth.restore?.()).rejects.toThrow();
      await expect(auth.login()).rejects.toThrow();
      expect(visited).toEqual([]);
    },
  );

  it('still sends the browser to a login after /auth/me was briefly unavailable', async () => {
    const { auth, visited } = client(() =>
      json(503, { type: 'urn:genai:problem:login-unavailable' }),
    );
    await expect(auth.restore?.()).rejects.toThrow();
    void auth.login();
    expect(visited).toHaveLength(1);
  });

  it('asks /auth/me once on start however often the app restores', async () => {
    const { auth, asked } = client(() => json(200, me()));
    await Promise.all([auth.restore?.(), auth.restore?.()]);
    expect(asked).toHaveLength(1);
  });

  it('renews only when /auth/me reports a later expiry', async () => {
    let expiresAt = '2026-10-07T18:00:00.000Z';
    const { auth } = client(() => json(200, me(expiresAt)));
    await auth.restore?.();
    expect(await auth.refresh?.()).toBeUndefined();
    expiresAt = '2026-10-08T02:00:00.000Z';
    expect((await auth.refresh?.())?.name).toBe('Ingrid Berg');
    expect(auth.expiresAt?.()).toBe(Date.parse(expiresAt));
  });
});
