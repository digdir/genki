import type { Principal } from '@genai/contracts';
import {
  createMockAnsattporten,
  createSigningKey,
  createTokenVerifier,
  InMemoryClients,
} from '@genai/identity';
import { createLocalJWKSet, SignJWT } from 'jose';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientRegistry } from '../frontends.js';
import { defaultReservedDomains } from '../hosts.js';
import { operatorDirectory } from '../operators.js';
import { actingClient, platformAppActing, type PlatformApp } from './acting.js';
import { createBff, handoffCookie, loginCookie, sessionCookie } from './bff.js';
import { InMemoryBffSessions, parsePayload, sessionIdHash } from './sessions.js';

const ISSUER = 'https://login.test';
const KEY = 'k'.repeat(48);
const AUDIENCE = 'digdir:genai';
const RESOURCE = 'urn:altinn:resource:digdir-genai-platform';
const PLATFORM_TENANT = '991825827';
const ORG_B = '889640782';
const PID = '12345678901';
const OPERATOR_PID = '10987654321';
const PLATFORM_CLIENT = 'genki-platform-login';
const PLATFORM_SECRET = 'platform-secret-value';
const LOGIN_HOST = 'login.apps.genki-test.digdir.cloud';
const HOSTS: Record<PlatformApp, string> = {
  portal: 'portal.genki-test.digdir.cloud',
  workspace: 'workspace.genki-test.digdir.cloud',
  console: 'console.genki-test.digdir.cloud',
};
const start = Date.parse('2026-11-25T10:00:00Z');
const backchannelEvent = 'http://schemas.openid.net/event/backchannel-logout';

let key: Awaited<ReturnType<typeof createSigningKey>>;
let stranger: Awaited<ReturnType<typeof createSigningKey>>;
beforeAll(async () => {
  key = await createSigningKey('platform-apps');
  stranger = await createSigningKey('platform-apps');
});

const setup = async () => {
  let clock = start;
  const now = () => clock;
  const mock = createMockAnsattporten({
    issuer: ISSUER,
    key,
    testData: {
      persons: [
        {
          pid: PID,
          name: 'Kari Nordmann',
          parties: [
            { orgno: PLATFORM_TENANT, name: 'Digdir', resources: { [RESOURCE]: ['read'] } },
            { orgno: ORG_B, name: 'Brreg', resources: { [RESOURCE]: ['read'] } },
          ],
        },
        {
          pid: OPERATOR_PID,
          name: 'Ola Operatør',
          parties: [
            { orgno: PLATFORM_TENANT, name: 'Digdir', resources: { [RESOURCE]: ['read'] } },
          ],
        },
      ],
    },
    tokenLifetimeSeconds: 300,
    now,
  });
  mock.clients.register({
    clientId: PLATFORM_CLIENT,
    redirectUris: [`https://${LOGIN_HOST}/auth/callback`],
    postLogoutRedirectUris: [`https://${LOGIN_HOST}/auth/logged-out`],
    audience: AUDIENCE,
    tokenEndpointAuthMethod: 'client_secret_basic',
    clientSecret: PLATFORM_SECRET,
  });
  const clients = new InMemoryClients();
  const operators = operatorDirectory({
    pids: [OPERATOR_PID],
    clientIds: [PLATFORM_CLIENT],
    mockIssuer: ISSUER,
  });
  const verifier = operators.watch(
    createTokenVerifier({
      issuers: [
        {
          kind: 'ansattporten',
          issuer: ISSUER,
          audience: AUDIENCE,
          keys: createLocalJWKSet({ keys: [key.publicJwk] }),
          trustedClients: ['genki-admin-mcp'],
          registeredClients: clientRegistry(clients, {
            clientId: PLATFORM_CLIENT,
            audience: AUDIENCE,
            current: actingClient,
          }),
          platformLoginClients: [PLATFORM_CLIENT],
          platformLoginKey: new Uint8Array(32).fill(7),
          platformAppSession: () => platformAppActing() !== undefined,
        },
      ],
      now: () => new Date(clock),
    }),
  );
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== ISSUER) throw new Error(`no fetch to ${url.origin}`);
    return mock.app.request(`${url.pathname}${url.search}`, init);
  }) as typeof fetch;
  const sessions = new InMemoryBffSessions(now);
  const calls: { app: PlatformApp | undefined; bearer: string; principal: Principal | Error }[] =
    [];
  const api = async (request: Request) => {
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (bearer)
      calls.push({
        app: platformAppActing(),
        bearer,
        principal: await verifier.verify(bearer).then(
          (v) => v.principal,
          (e: Error) => e,
        ),
      });
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const bff = createBff({
    proxyKey: KEY,
    sessions,
    clients,
    rules: { hostnames: new Map(), reservedDomains: defaultReservedDomains },
    hostActive: async () => false,
    issuer: ISSUER,
    altinnResource: RESOURCE,
    platformLogin: {
      clientId: PLATFORM_CLIENT,
      secret: PLATFORM_SECRET,
      hostname: LOGIN_HOST,
      audience: AUDIENCE,
      apps: (Object.keys(HOSTS) as PlatformApp[]).map((app) => ({
        app,
        hostname: HOSTS[app],
        origin: `https://${HOSTS[app]}`,
      })),
    },
    platformTenant: PLATFORM_TENANT,
    isOperator: async (token) => operators.isOperator((await verifier.verify(token)).principal),
    secrets: { value: async () => undefined, hosts: async () => undefined },
    organisations: async (accessToken) => {
      const { principal } = await verifier.verify(accessToken);
      return [...new Set((principal.authorizedFor ?? []).map((a) => a.org))].map((orgNumber) => ({
        orgNumber,
      }));
    },
    fetch: fetcher,
    now,
  });
  const via = (
    path: string,
    host: string,
    cookie?: string,
    init: { method?: string; headers?: Record<string, string>; body?: string } = {},
  ) =>
    bff.handle(
      new Request(`http://api.internal${path}`, {
        method: init.method ?? 'GET',
        headers: {
          'genai-proxy-key': KEY,
          'x-forwarded-host': host,
          ...(cookie ? { cookie } : {}),
          ...init.headers,
        },
        ...(init.body !== undefined ? { body: init.body } : {}),
      }),
      api,
    );
  const cookieValue = (response: Response, name: string) =>
    response.headers
      .getSetCookie()
      .find((c) => c.startsWith(`${name}=`))
      ?.split(';')[0]
      ?.slice(name.length + 1);
  const atLocation = (response: Response) => new URL(response.headers.get('location') ?? '');
  const ansattporten = async (authorize: URL, pid: string) => {
    const page = await mock.app.request(`${authorize.pathname}${authorize.search}`);
    const loginId = /name="login" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
    const chosen = await mock.app.request('/authorize', {
      method: 'POST',
      body: new URLSearchParams({
        login: loginId,
        pid,
        step: 'organisation',
        org: PLATFORM_TENANT,
      }),
    });
    return atLocation(chosen);
  };
  const toHandoff = async (host: string, pid = PID, loginFor = host) => {
    const begin = await via('/bff/auth/login?next=%2Fservices', host);
    const handoff = cookieValue(begin, handoffCookie) ?? '';
    const atLoginHost = atLocation(begin);
    atLoginHost.searchParams.set('host', loginFor);
    const started = await via(`/bff/auth/login${atLoginHost.search}`, atLoginHost.hostname);
    const back = await ansattporten(atLocation(started), pid);
    const callback = await via(
      `/bff/auth/callback${back.search}`,
      back.hostname,
      `${loginCookie}=${cookieValue(started, loginCookie) ?? ''}`,
    );
    const target = new URL(callback.headers.get('location') ?? 'https://none.invalid/');
    return {
      begin,
      atLoginHost,
      started,
      callback,
      target,
      handoff,
      code: target.searchParams.get('code') ?? '',
    };
  };
  const exchange = (host: string, code: string, handoff?: string) =>
    via(
      `/bff/auth/handoff?code=${encodeURIComponent(code)}`,
      host,
      handoff ? `${handoffCookie}=${handoff}` : undefined,
    );
  const signIn = async (host: string, pid = PID) => {
    const steps = await toHandoff(host, pid);
    const exchanged = await exchange(host, steps.code, steps.handoff);
    return { ...steps, exchanged, id: cookieValue(exchanged, sessionCookie) ?? '' };
  };
  const logoutToken = async (
    claims: Record<string, unknown>,
    options: { signer?: typeof key; audience?: string; iat?: number } = {},
  ) =>
    new SignJWT({ events: { [backchannelEvent]: {} }, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: (options.signer ?? key).kid, typ: 'logout+jwt' })
      .setIssuer(ISSUER)
      .setAudience(options.audience ?? PLATFORM_CLIENT)
      .setIssuedAt(options.iat ?? Math.floor(clock / 1000))
      .setJti(crypto.randomUUID())
      .sign((options.signer ?? key).privateKey);
  const backchannel = (token: string) =>
    via('/bff/auth/backchannel-logout', LOGIN_HOST, undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ logout_token: token }).toString(),
    });
  return {
    mock,
    via,
    calls,
    cookieValue,
    atLocation,
    toHandoff,
    exchange,
    signIn,
    logoutToken,
    backchannel,
    verifier,
    sessions,
    /** The sid and sub of the ID token a session holds. */
    claimsOf: async (id: string) => {
      const row = await sessions.get(PLATFORM_TENANT, sessionIdHash(id));
      const idToken = (row && parsePayload(row.payload)?.idToken) ?? '';
      return JSON.parse(Buffer.from(idToken.split('.')[1] ?? '', 'base64url').toString()) as {
        sid: string;
        sub: string;
      };
    },
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

type Setup = Awaited<ReturnType<typeof setup>>;

describe('the portal, workspace and console sign in through the platform login', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it.each(['portal', 'workspace'] as const)(
    'the %s logs in through the platform login client and holds only a session cookie',
    async (app) => {
      const { atLoginHost, started, target, exchanged, id } = await s.signIn(HOSTS[app]);
      expect(atLoginHost.origin).toBe(`https://${LOGIN_HOST}`);
      expect(s.atLocation(started).searchParams.get('client_id')).toBe(PLATFORM_CLIENT);
      expect(target.origin).toBe(`https://${HOSTS[app]}`);
      expect(exchanged.headers.get('location')).toBe('/services');
      expect(exchanged.headers.getSetCookie().join()).toMatch(
        /__Host-genki_session=[A-Za-z0-9_-]{43}; Path=\/; Secure; HttpOnly; SameSite=Lax/,
      );
      const me = await s.via('/bff/auth/me', HOSTS[app], `${sessionCookie}=${id}`);
      const body = (await me.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        name: 'Kari Nordmann',
        organisations: [{ orgNumber: PLATFORM_TENANT }],
      });
      expect(JSON.stringify(body)).not.toMatch(/eyJ/);
    },
  );

  it('the console logs in an operator through the platform login client', async () => {
    const { started, id } = await s.signIn(HOSTS.console, OPERATOR_PID);
    expect(s.atLocation(started).searchParams.get('client_id')).toBe(PLATFORM_CLIENT);
    const me = await s.via('/bff/auth/me', HOSTS.console, `${sessionCookie}=${id}`);
    expect(await me.json()).toMatchObject({ name: 'Ola Operatør', operator: true });
  });

  it('the console refuses a person who is not an operator and gives no session', async () => {
    const steps = await s.toHandoff(HOSTS.console, PID);
    expect(steps.target.toString()).toBe(`https://${HOSTS.console}/?signin=not-operator`);
    expect(steps.code).toBe('');
    const exchanged = await s.exchange(HOSTS.console, steps.code, steps.handoff);
    expect(s.cookieValue(exchanged, sessionCookie)).toBeUndefined();
  });

  it('an API call from a platform app session carries the person’s own rights, not a Client’s', async () => {
    const { id } = await s.signIn(HOSTS.portal);
    const res = await s.via(
      `/tenants/${PLATFORM_TENANT}/services`,
      HOSTS.portal,
      `${sessionCookie}=${id}`,
    );
    expect(res.status).toBe(200);
    const call = s.calls.at(-1);
    expect(call?.app).toBe('portal');
    const principal = call?.principal as Principal;
    expect(principal.confinedTo).toBeUndefined();
    expect(principal.client).toBe(PLATFORM_CLIENT);
    expect(principal.authorizedFor?.map((a) => a.org)).toEqual([PLATFORM_TENANT]);
  });

  it('the platform login token sent straight to the API, outside a platform app session, is refused', async () => {
    const { id } = await s.signIn(HOSTS.portal);
    await s.via('/me', HOSTS.portal, `${sessionCookie}=${id}`);
    const sent = s.calls.at(-1);
    expect((sent?.principal as Principal).client).toBe(PLATFORM_CLIENT);
    await expect(s.verifier.verify(sent?.bearer ?? '')).rejects.toThrow(/hostname it was made for/);
  });

  it('a portal session is refused on the console and the workspace', async () => {
    const { id } = await s.signIn(HOSTS.portal);
    for (const host of [HOSTS.console, HOSTS.workspace]) {
      const me = await s.via('/bff/auth/me', host, `${sessionCookie}=${id}`);
      expect(me.status).toBe(401);
    }
  });

  it.each([
    ['the portal', HOSTS.portal, HOSTS.console],
    ['the workspace', HOSTS.workspace, HOSTS.portal],
  ])(
    'a handoff code made for %s cannot be replayed on another app’s hostname',
    async (_, made, other) => {
      const forMade = await s.toHandoff(made, OPERATOR_PID);
      expect(forMade.target.hostname).toBe(made);
      const otherBegin = await s.via('/bff/auth/login', other);
      const otherHandoff = s.cookieValue(otherBegin, handoffCookie) ?? '';
      for (const cookie of [forMade.handoff, otherHandoff]) {
        const res = await s.exchange(other, forMade.code, cookie);
        expect(s.cookieValue(res, sessionCookie)).toBeUndefined();
        expect(res.headers.get('location')).toBe('/');
      }
    },
  );

  it('a handoff code for one app, taken to another app’s login, is bound to the app that asked', async () => {
    const steps = await s.toHandoff(HOSTS.portal, OPERATOR_PID, HOSTS.console);
    expect(steps.target.hostname).toBe(HOSTS.console);
    const res = await s.exchange(HOSTS.console, steps.code, steps.handoff);
    expect(s.cookieValue(res, sessionCookie)).toBeUndefined();
  });

  it('a non-operator cannot get a console session from a console login finished for the portal', async () => {
    const steps = await s.toHandoff(HOSTS.console, PID, HOSTS.portal);
    expect(steps.target.hostname).toBe(HOSTS.portal);
    const res = await s.exchange(HOSTS.console, steps.code, steps.handoff);
    expect(s.cookieValue(res, sessionCookie)).toBeUndefined();
  });

  it('passes a caller’s own bearer token through the portal only without a session, and outside the app session', async () => {
    const before = s.calls.length;
    await s.via('/me', HOSTS.portal, undefined, { headers: { authorization: 'Bearer own-key' } });
    expect(s.calls.slice(before).map((c) => [c.bearer, c.app])).toEqual([['own-key', undefined]]);
    const { id } = await s.signIn(HOSTS.portal);
    const after = s.calls.length;
    await s.via('/me', HOSTS.portal, `${sessionCookie}=${id}`, {
      headers: { authorization: 'Bearer own-key' },
    });
    expect(s.calls.slice(after).map((c) => c.bearer)).not.toContain('own-key');
  });

  it('drops a caller’s own bearer token on the login host and with a session cookie that has ended', async () => {
    const before = s.calls.length;
    const own = { headers: { authorization: 'Bearer own-key' } };
    await s.via('/me', LOGIN_HOST, undefined, own);
    await s.via('/me', HOSTS.portal, `${sessionCookie}=ended-session`, own);
    expect(s.calls.slice(before).map((c) => c.bearer)).not.toContain('own-key');
  });

  it('a platform login token a page sends as its own bearer is refused', async () => {
    const { id } = await s.signIn(HOSTS.portal);
    await s.via('/me', HOSTS.portal, `${sessionCookie}=${id}`);
    const token = s.calls.at(-1)?.bearer ?? '';
    const before = s.calls.length;
    await s.via('/me', HOSTS.portal, undefined, { headers: { authorization: `Bearer ${token}` } });
    expect(s.calls.slice(before).map((c) => c.principal)).toEqual([expect.any(Error)]);
  });

  describe('CSRF protection on a state-changing call with the cookie session', () => {
    it.each([
      ['no Origin', {}],
      ['another app’s origin', { origin: `https://${HOSTS.console}` }],
      ['a sibling subdomain', { origin: 'https://evil.genki-test.digdir.cloud' }],
    ])('refuses a POST with %s', async (_, headers: Record<string, string>) => {
      const { id } = await s.signIn(HOSTS.portal);
      const before = s.calls.length;
      const res = await s.via(
        `/tenants/${PLATFORM_TENANT}/services`,
        HOSTS.portal,
        `${sessionCookie}=${id}`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: '{}',
        },
      );
      expect(res.status).toBe(403);
      expect(s.calls.length).toBe(before);
    });

    it('refuses a form-encoded POST from the app’s own origin without the CSRF header', async () => {
      const { id } = await s.signIn(HOSTS.portal);
      const res = await s.via(
        `/tenants/${PLATFORM_TENANT}/files`,
        HOSTS.portal,
        `${sessionCookie}=${id}`,
        {
          method: 'POST',
          headers: {
            origin: `https://${HOSTS.portal}`,
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: 'a=b',
        },
      );
      expect(res.status).toBe(403);
    });

    it('passes a JSON POST or one with the CSRF header from the app’s own origin', async () => {
      const { id } = await s.signIn(HOSTS.portal);
      for (const headers of [
        { 'content-type': 'application/json' },
        { 'content-type': 'multipart/form-data; boundary=x', 'genai-csrf': '1' },
      ]) {
        const res = await s.via(
          `/tenants/${PLATFORM_TENANT}/services`,
          HOSTS.portal,
          `${sessionCookie}=${id}`,
          {
            method: 'POST',
            headers: { origin: `https://${HOSTS.portal}`, ...headers },
            body: '{}',
          },
        );
        expect(res.status).toBe(200);
      }
    });
  });

  it('logout ends the session and the Ansattporten session through the login host', async () => {
    const { id } = await s.signIn(HOSTS.workspace);
    const out = await s.via('/bff/auth/logout', HOSTS.workspace, `${sessionCookie}=${id}`, {
      headers: { 'sec-fetch-dest': 'document', 'sec-fetch-site': 'same-origin' },
    });
    const end = s.atLocation(out);
    expect(end.searchParams.get('client_id')).toBe(PLATFORM_CLIENT);
    expect(end.searchParams.get('post_logout_redirect_uri')).toBe(
      `https://${LOGIN_HOST}/auth/logged-out`,
    );
    expect(end.searchParams.get('state')).toBe(HOSTS.workspace);
    expect(end.searchParams.get('id_token_hint')).toBeTruthy();
    expect(out.headers.getSetCookie().join()).toContain(`${sessionCookie}=;`);
    const me = await s.via('/bff/auth/me', HOSTS.workspace, `${sessionCookie}=${id}`);
    expect(me.status).toBe(401);
    const back = await s.via(`/bff/auth/logged-out?state=${HOSTS.workspace}`, LOGIN_HOST);
    expect(back.headers.get('location')).toBe(`https://${HOSTS.workspace}/`);
  });
});

describe('back-channel logout on the login host', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  const sessionsOf = async (pid = OPERATOR_PID) => {
    const portal = await s.signIn(HOSTS.portal, pid);
    const console = await s.signIn(HOSTS.console, pid);
    return { portal, console };
  };

  const signedIn = async (host: string, id: string) =>
    (await s.via('/bff/auth/me', host, `${sessionCookie}=${id}`)).status === 200;

  it('ends every session of the Ansattporten login by its sid', async () => {
    const { portal, console } = await sessionsOf();
    const { sid } = await s.claimsOf(portal.id);
    expect(sid).toBeTruthy();
    const res = await s.backchannel(await s.logoutToken({ sid }));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await signedIn(HOSTS.portal, portal.id)).toBe(false);
    const consoleSid = (await s.claimsOf(console.id)).sid;
    expect(consoleSid).not.toBe(sid);
    expect(await signedIn(HOSTS.console, console.id)).toBe(true);
  });

  it('ends every session of the person by sub when the token has no sid', async () => {
    const { portal, console } = await sessionsOf();
    const { sub } = await s.claimsOf(portal.id);
    const res = await s.backchannel(await s.logoutToken({ sub }));
    expect(res.status).toBe(200);
    expect(await signedIn(HOSTS.portal, portal.id)).toBe(false);
    expect(await signedIn(HOSTS.console, console.id)).toBe(false);
  });

  it('ends only the sid’s sessions when the token names both the sid and the person', async () => {
    const { portal, console } = await sessionsOf();
    const { sid, sub } = await s.claimsOf(portal.id);
    expect((await s.claimsOf(console.id)).sid).not.toBe(sid);
    await s.backchannel(await s.logoutToken({ sid, sub }));
    expect(await signedIn(HOSTS.portal, portal.id)).toBe(false);
    expect(await signedIn(HOSTS.console, console.id)).toBe(true);
  });

  it('ends a login still on its way to the app, so its handoff gives no session', async () => {
    const steps = await s.toHandoff(HOSTS.portal, OPERATOR_PID);
    const { sub } = await s.claimsOf((await s.signIn(HOSTS.workspace, OPERATOR_PID)).id);
    await s.backchannel(await s.logoutToken({ sub }));
    const res = await s.exchange(HOSTS.portal, steps.code, steps.handoff);
    expect(s.cookieValue(res, sessionCookie)).toBeUndefined();
  });

  it('answers 503 and keeps the token usable for a retry when the sessions cannot be ended', async () => {
    const { portal } = await sessionsOf();
    const { sid } = await s.claimsOf(portal.id);
    const token = await s.logoutToken({ sid });
    vi.spyOn(s.sessions, 'endByLogoutKeys').mockRejectedValueOnce(new Error('database down'));
    expect((await s.backchannel(token)).status).toBe(503);
    expect(await signedIn(HOSTS.portal, portal.id)).toBe(true);
    expect((await s.backchannel(token)).status).toBe(200);
    expect(await signedIn(HOSTS.portal, portal.id)).toBe(false);
  });

  it('leaves another person’s sessions alone', async () => {
    const mine = await s.signIn(HOSTS.portal, OPERATOR_PID);
    const theirs = await s.signIn(HOSTS.portal, PID);
    const { sub } = await s.claimsOf(mine.id);
    await s.backchannel(await s.logoutToken({ sub }));
    expect(await signedIn(HOSTS.portal, theirs.id)).toBe(true);
  });

  it.each([
    ['a bad signature', { signer: 'stranger' }],
    ['another audience', { audience: 'someone-else' }],
    ['an iat older than five minutes', { iat: Math.floor(start / 1000) - 600 }],
  ] as const)('refuses a logout token with %s', async (_, options) => {
    const { portal } = await sessionsOf();
    const { sub } = await s.claimsOf(portal.id);
    const token = await s.logoutToken(
      { sub },
      {
        ...('signer' in options ? { signer: stranger } : {}),
        ...('audience' in options ? { audience: options.audience } : {}),
        ...('iat' in options ? { iat: options.iat } : {}),
      },
    );
    const res = await s.backchannel(token);
    expect(res.status).toBe(400);
    expect(await signedIn(HOSTS.portal, portal.id)).toBe(true);
  });

  it.each([
    ['a nonce', { nonce: 'n' }],
    ['no back-channel logout event', { events: { other: {} } }],
    ['neither sid nor sub', {}],
  ])('refuses a logout token with %s', async (_, extra: Record<string, unknown>) => {
    const { portal } = await sessionsOf();
    const { sub } = await s.claimsOf(portal.id);
    const claims = 'nonce' in extra || 'events' in extra ? { sub, ...extra } : extra;
    const res = await s.backchannel(await s.logoutToken(claims));
    expect(res.status).toBe(400);
    expect(await signedIn(HOSTS.portal, portal.id)).toBe(true);
  });

  it('refuses a replayed logout token by its jti', async () => {
    const first = await s.signIn(HOSTS.portal, OPERATOR_PID);
    const { sub } = await s.claimsOf(first.id);
    const token = await s.logoutToken({ sub });
    expect((await s.backchannel(token)).status).toBe(200);
    const again = await s.signIn(HOSTS.portal, OPERATOR_PID);
    expect((await s.backchannel(token)).status).toBe(400);
    expect(await signedIn(HOSTS.portal, again.id)).toBe(true);
  });

  it('refuses a back-channel logout that is not a form POST', async () => {
    const res = await s.via('/bff/auth/backchannel-logout', LOGIN_HOST, undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ logout_token: await s.logoutToken({ sub: 'x' }) }),
    });
    expect(res.status).toBe(400);
    const get = await s.via('/bff/auth/backchannel-logout', LOGIN_HOST);
    expect(get.status).toBe(404);
  });

  it('answers back-channel logout only on the login host', async () => {
    const res = await s.via('/bff/auth/backchannel-logout', HOSTS.portal, undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: `logout_token=${await s.logoutToken({ sub: 'x' })}`,
    });
    expect(res.status).toBe(404);
  });
});
