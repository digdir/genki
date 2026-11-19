import {
  clientDefinition,
  createMockAnsattporten,
  createSigningKey,
  InMemoryClients,
} from '@genai/identity';
import { decodeJwt } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { defaultReservedDomains } from '../hosts.js';
import {
  createBff,
  loginCookie,
  safeReturn,
  sessionCookie,
  type BffDeps,
  type ClientSecrets,
} from './bff.js';
import { InMemoryBffSessions, type BffSessionStore } from './sessions.js';

const ISSUER = 'https://login.test';
const KEY = 'k'.repeat(48);
const ORG_A = '991825827';
const ORG_B = '889640782';
const PID = '12345678901';
const SECRET = 'client-secret-value';
const start = Date.parse('2026-11-19T10:00:00Z');

let key: Awaited<ReturnType<typeof createSigningKey>>;
beforeAll(async () => {
  key = await createSigningKey('test');
});

const hosted = (tenant: string, id: string, hostname: string, also: string[] = []) =>
  clientDefinition.parse({
    apiVersion: 'genai/v1',
    kind: 'Client',
    metadata: { tenant, id },
    spec: {
      service: 'kunnskapsassistenten',
      kind: 'browser',
      channels: ['openai'],
      oidc: {
        clientId: id,
        redirectUris: [`https://${hostname}/auth/callback`],
        postLogoutRedirectUris: [`https://${hostname}/`],
        secret: 'ka-login',
      },
      hosted: true,
      hostnames: [hostname, ...also].map((name) => ({ hostname: name })),
    },
  });

const setup = async (options: { secretHosts?: string[] } = {}) => {
  let clock = start;
  const now = () => clock;
  const mock = createMockAnsattporten({
    issuer: ISSUER,
    key,
    testData: { persons: [{ pid: PID, name: 'Kari Nordmann' }] },
    tokenLifetimeSeconds: 300,
    now,
  });
  for (const [id, hostname] of [
    ['ka-host', 'ka.example.no'],
    ['nynorsk-host', 'nynorsk.example.no'],
    ['ola-host', 'ola.example.no'],
    ['twin-host', 'twin-a.example.no'],
    ['apps-host', 'kunnskap.apps.genki-test.digdir.cloud'],
    ['zone-host', 'annen.genki-test.digdir.cloud'],
  ] as const)
    mock.clients.register({
      clientId: id,
      redirectUris: [`https://${hostname}/auth/callback`],
      postLogoutRedirectUris: [`https://${hostname}/`],
      audience: id,
      tokenEndpointAuthMethod: 'client_secret_basic',
      clientSecret: SECRET,
    });
  const clients = new InMemoryClients();
  for (const definition of [
    hosted(ORG_A, 'ka-host', 'ka.example.no'),
    hosted(ORG_A, 'nynorsk-host', 'nynorsk.example.no'),
    hosted(ORG_B, 'ola-host', 'ola.example.no'),
    hosted(ORG_A, 'twin-host', 'twin-a.example.no', ['twin-b.example.no']),
    hosted(ORG_A, 'apps-host', 'kunnskap.apps.genki-test.digdir.cloud'),
    hosted(ORG_A, 'zone-host', 'annen.genki-test.digdir.cloud'),
  ])
    await clients.save({ definition, version: 1, updatedAt: '', updatedBy: 'test' });
  const secrets: ClientSecrets = {
    value: async () => SECRET,
    hosts: async () => options.secretHosts ?? [ISSUER],
  };
  const calls: { url: URL; authorization: string | null; body: string }[] = [];
  const issued: { refresh_token?: string; access_token?: string }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    calls.push({
      url,
      authorization: new Headers(init?.headers).get('authorization'),
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const response = await mock.app.request(`${url.pathname}${url.search}`, init);
    if (url.pathname === '/token' && response.ok) issued.push(await response.clone().json());
    return response;
  }) as typeof fetch;
  const sessions = new InMemoryBffSessions(now);
  const seen: Request[] = [];
  const api = (request: Request) => {
    seen.push(request);
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  const deps = (store: BffSessionStore = sessions): BffDeps => ({
    proxyKey: KEY,
    sessions: store,
    clients,
    rules: {
      hostnames: new Map([
        ['ka.example.no', ORG_A],
        ['nynorsk.example.no', ORG_A],
        ['ola.example.no', ORG_B],
        ['twin-a.example.no', ORG_A],
        ['twin-b.example.no', ORG_A],
        ['kunnskap.apps.genki-test.digdir.cloud', ORG_A],
        ['annen.genki-test.digdir.cloud', ORG_A],
      ]),
      reservedDomains: defaultReservedDomains,
    },
    hostActive: async () => true,
    issuer: ISSUER,
    secrets,
    organisations: async () => [{ orgNumber: ORG_A }, { orgNumber: '310000001' }],
    fetch: fetcher,
    now,
  });
  const bff = createBff(deps());
  const via = (
    path: string,
    init: {
      method?: string;
      host?: string;
      cookie?: string;
      headers?: Record<string, string>;
      body?: string;
      proxyKey?: string | null;
    } = {},
  ) =>
    new Request(`http://api.internal${path}`, {
      method: init.method ?? 'GET',
      headers: {
        ...(init.proxyKey === null ? {} : { 'genai-proxy-key': init.proxyKey ?? KEY }),
        'x-forwarded-host': init.host ?? 'ka.example.no',
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: init.body }),
    });
  const setCookies = (response: Response) => response.headers.getSetCookie();
  const cookieValue = (response: Response, name: string) =>
    setCookies(response)
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0]
      ?.slice(name.length + 1);
  const signIn = async (on = bff, host = 'ka.example.no') => {
    const begin = await on.handle(via('/bff/auth/login?next=%2Fthreads%2F1', { host }), api);
    const pending = cookieValue(begin, loginCookie);
    const authorize = new URL(begin.headers.get('location') ?? '');
    const page = await mock.app.request(`${authorize.pathname}${authorize.search}`);
    const loginId = /name="login" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
    const chosen = await mock.app.request('/authorize', {
      method: 'POST',
      body: new URLSearchParams({ login: loginId, pid: PID }),
    });
    const back = new URL(chosen.headers.get('location') ?? '');
    const callback = await on.handle(
      via(`/bff/auth/callback${back.search}`, { host, cookie: `${loginCookie}=${pending}` }),
      api,
    );
    return { begin, callback, id: cookieValue(callback, sessionCookie) ?? '', authorize };
  };
  return {
    bff,
    deps,
    mock,
    via,
    api,
    seen,
    calls,
    issued,
    sessions,
    signIn,
    setCookies,
    cookieValue,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

type Setup = Awaited<ReturnType<typeof setup>>;

const session = (id: string) => `${sessionCookie}=${id}`;

describe('the BFF login', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('keeps every token on the server and gives the browser only an opaque session id', async () => {
    const { callback, id } = await s.signIn();
    expect(callback.status).toBe(302);
    expect(callback.headers.get('location')).toBe('/threads/1');
    expect(await callback.text()).toBe('');
    const tokens = s.issued.flatMap((t) => [t.access_token, t.refresh_token]).filter(Boolean);
    expect(tokens.length).toBeGreaterThan(0);
    const me = await s.bff.handle(s.via('/bff/auth/me', { cookie: session(id) }), s.api);
    const shown = `${JSON.stringify(s.setCookies(callback))}${await me.text()}`;
    for (const token of tokens) expect(shown).not.toContain(token);
    expect(shown).not.toMatch(/eyJ[A-Za-z0-9_-]+\./);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('sets host-only, Secure, HttpOnly, SameSite=Lax cookies with the __Host- prefix', async () => {
    const { begin, callback } = await s.signIn();
    const cookies = [...s.setCookies(begin), ...s.setCookies(callback)];
    expect(cookies.length).toBeGreaterThanOrEqual(2);
    for (const c of cookies) {
      expect(c).toMatch(/^__Host-genki_(session|login)=/);
      expect(c).toContain('; Path=/;');
      expect(c).toContain('; Secure;');
      expect(c).toContain('; HttpOnly;');
      expect(c).toContain('; SameSite=Lax;');
      expect(c.toLowerCase()).not.toContain('domain=');
    }
  });

  it('runs the code flow with PKCE, state and nonce as a confidential client', async () => {
    const { authorize } = await s.signIn();
    const query = authorize.searchParams;
    expect(query.get('code_challenge_method')).toBe('S256');
    expect(query.get('state')).toBeTruthy();
    expect(query.get('nonce')).toBeTruthy();
    expect(query.get('redirect_uri')).toBe('https://ka.example.no/auth/callback');
    const exchange = s.calls.find((c) => c.url.pathname === '/token');
    expect(exchange?.authorization).toMatch(/^Basic /);
    expect(new URLSearchParams(exchange?.body).get('code_verifier')).toBeTruthy();
  });

  it('refuses a callback whose state does not match the login cookie', async () => {
    const begin = await s.bff.handle(s.via('/bff/auth/login'), s.api);
    const pending = s.cookieValue(begin, loginCookie);
    const callback = await s.bff.handle(
      s.via('/bff/auth/callback?code=x&state=forged', { cookie: `${loginCookie}=${pending}` }),
      s.api,
    );
    expect(callback.headers.get('location')).toBe('/');
    expect(s.cookieValue(callback, sessionCookie)).toBeUndefined();
    expect(s.calls.some((c) => c.url.pathname === '/token')).toBe(false);
  });

  it('gives a new session id at every login', async () => {
    const first = await s.signIn();
    const second = await s.signIn();
    expect(second.id).not.toBe(first.id);
  });

  it('sends the client secret only to an endpoint the tenant secret is bound to', async () => {
    const other = await setup({ secretHosts: ['https://elsewhere.test'] });
    const { callback } = await other.signIn();
    expect(other.cookieValue(callback, sessionCookie)).toBeUndefined();
    expect(other.calls.filter((c) => c.authorization !== null)).toEqual([]);
  });
});

describe('the BFF in front of the API', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('attaches the access token and never forwards the cookie or the proxy key', async () => {
    const { id } = await s.signIn();
    const res = await s.bff.handle(
      s.via('/v1/models', { cookie: `${session(id)}; other=1`, headers: { authorization: 'x' } }),
      s.api,
    );
    expect(res.status).toBe(200);
    const sent = s.seen.at(-1);
    expect(sent?.headers.get('authorization')).toMatch(/^Bearer eyJ/);
    expect(sent?.headers.get('cookie')).toBeNull();
    expect(sent?.headers.get('genai-proxy-key')).toBeNull();
  });

  it('keeps the issuer and sub a browser token from the same client gives', async () => {
    const { id } = await s.signIn();
    await s.bff.handle(s.via('/v1/models', { cookie: session(id) }), s.api);
    const viaBff = decodeJwt(
      s.seen.at(-1)?.headers.get('authorization')?.replace('Bearer ', '') ?? '',
    );
    const browser = decodeJwt((await s.mock.testTokens(PID, 'ka-host')).access_token);
    expect([viaBff.iss, viaBff.sub]).toEqual([browser.iss, browser.sub]);
  });

  it('keeps a person signed in across a restart, since the session is in the shared store', async () => {
    const { id } = await s.signIn();
    const restarted = createBff(s.deps());
    const res = await restarted.handle(s.via('/v1/models', { cookie: session(id) }), s.api);
    expect(res.status).toBe(200);
    expect(s.seen.at(-1)?.headers.get('authorization')).toMatch(/^Bearer /);
  });

  it('refuses a state-changing call from another origin or without JSON or the CSRF header', async () => {
    const { id } = await s.signIn();
    const cases = [
      { origin: 'https://evil.example.no', 'content-type': 'application/json' },
      { origin: 'https://nynorsk.example.no', 'content-type': 'application/json' },
      { 'content-type': 'application/json' },
      { origin: 'https://ka.example.no', 'content-type': 'text/plain' },
    ];
    for (const headers of cases) {
      const res = await s.bff.handle(
        s.via('/v1/chat/completions', { method: 'POST', cookie: session(id), headers, body: '{}' }),
        s.api,
      );
      expect(res.status, JSON.stringify(headers)).toBe(403);
    }
    expect(s.seen).toEqual([]);
    const allowed = await s.bff.handle(
      s.via('/v1/chat/completions', {
        method: 'POST',
        cookie: session(id),
        headers: { origin: 'https://ka.example.no', 'content-type': 'application/json' },
        body: '{}',
      }),
      s.api,
    );
    expect(allowed.status).toBe(200);
    const deleted = await s.bff.handle(
      s.via('/api/conversations/1', {
        method: 'DELETE',
        cookie: session(id),
        headers: { origin: 'https://ka.example.no', 'genai-csrf': '1' },
      }),
      s.api,
    );
    expect(deleted.status).toBe(200);
  });

  it('refuses a session on another hostname of the same tenant or of another tenant', async () => {
    const { id } = await s.signIn();
    for (const host of ['nynorsk.example.no', 'ola.example.no']) {
      const res = await s.bff.handle(s.via('/v1/models', { host, cookie: session(id) }), s.api);
      expect(s.seen.at(-1)?.headers.get('authorization')).toBeNull();
      expect(s.setCookies(res).join()).toContain(`${sessionCookie}=;`);
    }
  });

  it('refuses a session on another hostname of the same client', async () => {
    const { id } = await s.signIn(s.bff, 'twin-a.example.no');
    await s.bff.handle(
      s.via('/v1/models', { host: 'twin-a.example.no', cookie: session(id) }),
      s.api,
    );
    expect(s.seen.at(-1)?.headers.get('authorization')).toMatch(/^Bearer /);
    await s.bff.handle(
      s.via('/v1/models', { host: 'twin-b.example.no', cookie: session(id) }),
      s.api,
    );
    expect(s.seen.at(-1)?.headers.get('authorization')).toBeNull();
  });

  it('signs in on a hostname by the same rule the host lookup uses: an assigned apps. name, never another name in genki’s zones', async () => {
    const assigned = await s.bff.handle(
      s.via('/bff/auth/login', { host: 'kunnskap.apps.genki-test.digdir.cloud' }),
      s.api,
    );
    expect(assigned.status).toBe(302);
    expect(assigned.headers.get('location')).toMatch(/^https?:\/\/[^/]+\/authorize\?/);
    const reserved = await s.bff.handle(
      s.via('/bff/auth/login', { host: 'annen.genki-test.digdir.cloud' }),
      s.api,
    );
    expect(reserved.status).not.toBe(302);
  });

  it('trusts no forwarded host without the proxy key', async () => {
    const { id } = await s.signIn();
    const wrong = await s.bff.handle(
      s.via('/v1/models', { cookie: session(id), proxyKey: 'w'.repeat(48) }),
      s.api,
    );
    expect(wrong.status).toBe(403);
    await s.bff.handle(s.via('/v1/models', { cookie: session(id), proxyKey: null }), s.api);
    expect(s.seen.at(-1)?.headers.get('authorization')).toBeNull();
    const unset = createBff({ ...s.deps(), proxyKey: undefined });
    expect((await unset.handle(s.via('/bff/auth/login'), s.api)).status).toBe(403);
  });

  it('refreshes an access token that is about to expire', async () => {
    const { id } = await s.signIn();
    await s.bff.handle(s.via('/v1/models', { cookie: session(id) }), s.api);
    const before = s.seen.at(-1)?.headers.get('authorization');
    s.advance(300_000);
    const res = await s.bff.handle(s.via('/v1/models', { cookie: session(id) }), s.api);
    expect(res.status).toBe(200);
    expect(s.seen.at(-1)?.headers.get('authorization')).not.toBe(before);
    const refresh = s.calls.filter(
      (c) => new URLSearchParams(c.body).get('grant_type') === 'refresh_token',
    );
    expect(refresh).toHaveLength(1);
  });

  it('logs out cleanly when the refresh token is refused', async () => {
    const { id } = await s.signIn();
    const refreshToken = s.issued.at(-1)?.refresh_token ?? '';
    await s.mock.app.request('/revoke', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`ka-host:${SECRET}`).toString('base64')}` },
      body: new URLSearchParams({ token: refreshToken }),
    });
    s.advance(300_000);
    const res = await s.bff.handle(s.via('/v1/models', { cookie: session(id) }), s.api);
    expect(res.status).toBe(401);
    expect(s.setCookies(res).join()).toContain(`${sessionCookie}=;`);
    expect(s.seen).toEqual([]);
    const me = await s.bff.handle(s.via('/bff/auth/me', { cookie: session(id) }), s.api);
    expect(me.status).toBe(401);
  });
});

describe('the BFF logout and organisation', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('logout deletes the session, revokes the refresh token and ends the login session', async () => {
    const { id } = await s.signIn();
    const refreshToken = s.issued.at(-1)?.refresh_token ?? '';
    const res = await s.bff.handle(
      s.via('/bff/auth/logout', {
        cookie: session(id),
        headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' },
      }),
      s.api,
    );
    const end = new URL(res.headers.get('location') ?? '');
    expect(end.pathname).toBe('/logout');
    expect(end.searchParams.get('id_token_hint')).toBeTruthy();
    expect(end.searchParams.get('post_logout_redirect_uri')).toBe('https://ka.example.no/');
    expect(s.setCookies(res).join()).toContain(`${sessionCookie}=;`);
    expect(s.calls.some((c) => c.url.pathname === '/revoke')).toBe(true);
    const reuse = await s.mock.app.request('/token', {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`ka-host:${SECRET}`).toString('base64')}` },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
    });
    expect(reuse.status).toBe(400);
    await s.bff.handle(s.via('/v1/models', { cookie: session(id) }), s.api);
    expect(s.seen.at(-1)?.headers.get('authorization')).toBeNull();
  });

  it('refuses a logout that an image, a fetch or another site starts', async () => {
    const { id } = await s.signIn();
    for (const headers of [
      { 'sec-fetch-dest': 'image' },
      { 'sec-fetch-dest': 'empty' },
      { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'cross-site' },
    ]) {
      const res = await s.bff.handle(
        s.via('/bff/auth/logout', { cookie: session(id), headers }),
        s.api,
      );
      expect(res.status).toBe(403);
    }
    const me = await s.bff.handle(s.via('/bff/auth/me', { cookie: session(id) }), s.api);
    expect(me.status).toBe(200);
  });

  it('changes the organisation only by POST from the hostname, and only to one the person has', async () => {
    const { id } = await s.signIn();
    const choose = (headers: Record<string, string>, organisation: string, method = 'POST') =>
      s.bff.handle(
        s.via('/bff/auth/org', {
          method,
          cookie: session(id),
          headers: { 'content-type': 'application/json', ...headers },
          ...(method === 'POST' ? { body: JSON.stringify({ organisation }) } : {}),
        }),
        s.api,
      );
    expect((await choose({ origin: 'https://evil.example.no' }, ORG_A)).status).toBe(403);
    expect((await choose({ origin: 'https://ka.example.no' }, ORG_B)).status).toBe(403);
    const shown = await choose({}, ORG_A, 'GET');
    expect(((await shown.json()) as { organisation: unknown }).organisation).toBeNull();
    expect((await choose({ origin: 'https://ka.example.no' }, ORG_A)).status).toBe(200);
    await s.bff.handle(s.via('/v1/models', { cookie: session(id) }), s.api);
    expect(s.seen.at(-1)?.headers.get('genai-acting-for')).toBe(ORG_A);
  });
});

describe('a return address after login', () => {
  it.each([
    ['https://evil.example.no/x', '/'],
    ['//evil.example.no/x', '/'],
    ['/\\evil.example.no', '/'],
    ['/auth/logout', '/'],
    ['/.//evil.example.no', '/'],
    ['/..//evil.example.no', '/'],
    ['/a/..//evil.example.no', '/'],
    ['/%2e//evil.example.no', '/'],
    ['/./\t/evil.example.no', '/'],
    ['threads', '/'],
    ['/threads/1?q=a#b', '/threads/1?q=a#b'],
  ])('returns %s as %s, since only a same-origin path is kept', (value, expected) => {
    expect(safeReturn(value)).toBe(expected);
  });

  it('decides in linear time on a long adversarial address', () => {
    const started = performance.now();
    safeReturn(`/${'/a'.repeat(1000)}${'\\'.repeat(1000)}`);
    expect(performance.now() - started).toBeLessThan(50);
  });
});
