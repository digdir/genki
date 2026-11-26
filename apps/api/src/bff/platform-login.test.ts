import type { Principal } from '@genai/contracts';
import {
  clientDefinition,
  createMockAnsattporten,
  createSigningKey,
  createTokenVerifier,
  InMemoryClients,
} from '@genai/identity';
import { createKernel, type Capability } from '@genai/kernel';
import {
  createRemoteAgent,
  remoteAgentConfig,
  type RemoteCall,
  type RemoteReply,
} from '@genai/strategy-remote';
import { createLocalJWKSet, decodeJwt } from 'jose';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { clientRegistry } from '../frontends.js';
import { defaultReservedDomains } from '../hosts.js';
import { operatorDirectory } from '../operators.js';
import { actingClient } from './acting.js';
import {
  createBff,
  handoffCookie,
  loginCookie,
  organisationsOf,
  sessionCookie,
  type BffDeps,
} from './bff.js';
import { InMemoryBffSessions } from './sessions.js';

const ISSUER = 'https://login.test';
const KEY = 'k'.repeat(48);
const AUDIENCE = 'digdir:genai';
const RESOURCE = 'urn:altinn:resource:digdir-genai-platform';
const ORG_A = '991825827';
const ORG_B = '889640782';
const PID = '12345678901';
const PLATFORM_CLIENT = 'genki-platform-login';
const PLATFORM_SECRET = 'platform-secret-value';
const OWN_SECRET = 'own-secret-value';
const LOGIN_HOST = 'login.apps.genki-test.digdir.cloud';
const start = Date.parse('2026-11-19T10:00:00Z');
const SUBJECT_KEY = new Uint8Array(32).fill(7);
const MEMBER_GROUP = '789b5488-39ec-47b3-9217-840e5cd957fd';
const EMPLOYEE_GROUP = '30a76637-d1ff-4040-bc1f-fb9b8ccd749c';

let key: Awaited<ReturnType<typeof createSigningKey>>;
beforeAll(async () => {
  key = await createSigningKey('platform-login');
});

const hosted = (tenant: string, id: string, hostname: string, own = false) =>
  clientDefinition.parse({
    apiVersion: 'genai/v1',
    kind: 'Client',
    metadata: { tenant, id },
    spec: {
      service: 'kunnskapsassistenten',
      kind: 'browser',
      channels: ['openai', 'conversations'],
      ...(own
        ? {
            oidc: {
              clientId: id,
              redirectUris: [`https://${hostname}/auth/callback`],
              postLogoutRedirectUris: [`https://${hostname}/`],
              secret: 'own-login',
            },
          }
        : {}),
      hosted: true,
      hostnames: [{ hostname }],
    },
  });

const setup = async (
  options: {
    platformClients?: string[];
    inactive?: string[];
    tokenEndpoint?: string;
    noSecret?: boolean;
    entraGroups?: string[];
    issuer?: string;
    loginPage?: string;
    directory?: { orgNumber: string; name: string }[] | 'unreadable';
  } = {},
) => {
  const issuer = options.issuer ?? ISSUER;
  let clock = start;
  const now = () => clock;
  const mock = createMockAnsattporten({
    issuer,
    key,
    testData: {
      persons: [
        {
          pid: PID,
          name: 'Kari Nordmann',
          parties: [{ orgno: ORG_A, name: 'Digdir', resources: { [RESOURCE]: ['read'] } }],
          ...(options.entraGroups
            ? { entra: { groups: options.entraGroups, email: 'kari@digdir.no' } }
            : {}),
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
  mock.clients.register({
    clientId: 'own-host',
    redirectUris: ['https://own.example.no/auth/callback'],
    postLogoutRedirectUris: ['https://own.example.no/'],
    audience: 'own-host',
    audiences: [AUDIENCE],
    tokenEndpointAuthMethod: 'client_secret_basic',
    clientSecret: OWN_SECRET,
  });
  const clients = new InMemoryClients();
  for (const definition of [
    hosted(ORG_A, 'ka-host', 'ka.example.no'),
    hosted(ORG_A, 'nynorsk-host', 'nynorsk.example.no'),
    hosted(ORG_B, 'ola-host', 'ola.example.no'),
    hosted(ORG_A, 'own-host', 'own.example.no', true),
  ])
    await clients.save({ definition, version: 1, updatedAt: '', updatedBy: 'test' });
  const verifier = createTokenVerifier({
    issuers: [
      {
        kind: 'ansattporten',
        issuer,
        audience: AUDIENCE,
        keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        ...(options.platformClients ? { trustedClients: options.platformClients } : {}),
        registeredClients: clientRegistry(clients, {
          clientId: PLATFORM_CLIENT,
          audience: AUDIENCE,
          current: actingClient,
        }),
        platformLoginClients: [PLATFORM_CLIENT],
        platformLoginKey: SUBJECT_KEY,
        ...(options.entraGroups
          ? {
              trustedEntra: {
                groups: [],
                userGroups: [MEMBER_GROUP],
                serviceGroups: [EMPLOYEE_GROUP],
                clientIds: [],
                tenant: ORG_A,
                resource: RESOURCE,
              },
              entraOnly: true,
            }
          : {}),
      },
    ],
    now: () => new Date(clock),
  });
  const sent: { origin: string; authorization: string | null }[] = [];
  const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    sent.push({
      origin: url.origin,
      authorization: new Headers(init?.headers).get('authorization'),
    });
    const answer = await mock.app.request(`${url.pathname}${url.search}`, init);
    if (
      !(options.tokenEndpoint || options.loginPage) ||
      url.pathname !== '/.well-known/openid-configuration'
    )
      return answer;
    const discovery = (await answer.json()) as Record<string, string>;
    const onLoginPage = (endpoint: string | undefined) =>
      options.loginPage && endpoint
        ? `${options.loginPage}${new URL(endpoint).pathname}`
        : endpoint;
    return Response.json({
      ...discovery,
      authorization_endpoint: onLoginPage(discovery.authorization_endpoint),
      end_session_endpoint: onLoginPage(discovery.end_session_endpoint),
      ...(options.tokenEndpoint ? { token_endpoint: options.tokenEndpoint } : {}),
    });
  }) as typeof fetch;
  const sessions = new InMemoryBffSessions(now);
  const principals: (Principal | Error)[] = [];
  const api = async (request: Request) => {
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '');
    if (bearer)
      principals.push(
        await verifier.verify(bearer).then(
          (v) => v.principal,
          (e: Error) => e,
        ),
      );
    return new Response('{}', { headers: { 'content-type': 'application/json' } });
  };
  const deps: BffDeps = {
    proxyKey: KEY,
    sessions,
    clients,
    rules: {
      hostnames: new Map([
        ['ka.example.no', ORG_A],
        ['nynorsk.example.no', ORG_A],
        ['ola.example.no', ORG_B],
        ['own.example.no', ORG_A],
        ['opened.example.no', ORG_A],
      ]),
      reservedDomains: defaultReservedDomains,
    },
    hostActive: async (hostname) => !options.inactive?.includes(hostname),
    issuer,
    altinnResource: options.entraGroups ? undefined : RESOURCE,
    acrValues: options.entraGroups ? 'entraid' : undefined,
    platformLogin: {
      clientId: PLATFORM_CLIENT,
      secret: options.noSecret ? undefined : PLATFORM_SECRET,
      hostname: LOGIN_HOST,
      audience: AUDIENCE,
    },
    secrets: {
      value: async () => OWN_SECRET,
      hosts: async () => [issuer],
    },
    organisations: async (accessToken) =>
      organisationsOf((await verifier.verify(accessToken)).principal, {
        tenantDirectory: async () => {
          if (options.directory === 'unreadable') throw new Error('directory unavailable');
          return options.directory ?? [];
        },
      }),
    fetch: fetcher,
    now,
  };
  const bff = createBff(deps);
  const via = (path: string, host: string, cookie?: string, headers: Record<string, string> = {}) =>
    bff.handle(
      new Request(`http://api.internal${path}`, {
        headers: {
          'genai-proxy-key': KEY,
          'x-forwarded-host': host,
          ...(cookie ? { cookie } : {}),
          ...headers,
        },
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
  const ansattporten = async (authorize: URL) => {
    const page = await mock.app.request(`${authorize.pathname}${authorize.search}`);
    const loginId = /name="login" value="([^"]+)"/.exec(await page.text())?.[1] ?? '';
    const chosen = await mock.app.request('/authorize', {
      method: 'POST',
      body: new URLSearchParams({ login: loginId, pid: PID, step: 'organisation', org: ORG_A }),
    });
    return atLocation(chosen);
  };
  /** Runs the login on `host` up to the handoff, and answers the code and this browser's handoff cookie. */
  const toHandoff = async (host = 'ka.example.no', loginFor = host) => {
    const begin = await via('/bff/auth/login?next=%2Fthreads%2F1', host);
    const handoff = cookieValue(begin, handoffCookie) ?? '';
    const atLoginHost = atLocation(begin);
    atLoginHost.searchParams.set('host', loginFor);
    const started = await via(
      `/bff/auth/login${atLoginHost.search}`,
      atLoginHost.hostname,
      undefined,
    );
    const pending = cookieValue(started, loginCookie) ?? '';
    const back = await ansattporten(atLocation(started));
    const callback = await via(
      `/bff/auth/callback${back.search}`,
      back.hostname,
      `${loginCookie}=${pending}`,
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
  const signIn = async (host = 'ka.example.no') => {
    const steps = await toHandoff(host);
    const exchanged = await exchange(host, steps.code, steps.handoff);
    return { ...steps, exchanged, id: cookieValue(exchanged, sessionCookie) ?? '' };
  };
  return {
    bff,
    mock,
    via,
    api,
    verifier,
    principals,
    sent,
    cookieValue,
    atLocation,
    ansattporten,
    toHandoff,
    exchange,
    signIn,
    advance: (ms: number) => {
      clock += ms;
    },
  };
};

type Setup = Awaited<ReturnType<typeof setup>>;

const organisationsAt = async (s: Setup, id: string) =>
  (
    (await (await s.via('/bff/auth/me', 'ka.example.no', `${sessionCookie}=${id}`)).json()) as {
      organisations: unknown;
    }
  ).organisations;

describe('the platform login for hosted assistants', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  it('signs a hosted Client without its own oidc in through the login host and hands the session to its hostname', async () => {
    const { atLoginHost, started, target, exchanged, id } = await s.signIn();
    expect(atLoginHost.origin).toBe(`https://${LOGIN_HOST}`);
    expect(atLoginHost.searchParams.get('host')).toBe('ka.example.no');
    const authorize = s.atLocation(started).searchParams;
    expect(authorize.get('client_id')).toBe(PLATFORM_CLIENT);
    expect(authorize.get('redirect_uri')).toBe(`https://${LOGIN_HOST}/auth/callback`);
    expect(authorize.get('code_challenge_method')).toBe('S256');
    expect(authorize.get('resource')).toBe(AUDIENCE);
    expect(JSON.parse(authorize.get('authorization_details') ?? '[]')).toEqual([
      { type: 'ansattporten:altinn:resource', resource: RESOURCE },
    ]);
    expect(target.origin).toBe('https://ka.example.no');
    expect(target.pathname).toBe('/auth/handoff');
    expect(exchanged.headers.get('location')).toBe('/threads/1');
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const me = await s.via('/bff/auth/me', 'ka.example.no', `${sessionCookie}=${id}`);
    expect(me.status).toBe(200);
  });

  it('the token’s organisation name wins over the directory', async () => {
    const t = await setup({
      directory: [{ orgNumber: ORG_A, name: 'Digitaliseringsdirektoratet' }],
    });

    const { id } = await t.signIn();

    expect(await organisationsAt(t, id)).toEqual([{ orgNumber: ORG_A, name: 'Digdir' }]);
  });

  it.each(['nynorsk.example.no', 'ola.example.no'])(
    'a login for one hosted hostname cannot be handed to another (%s)',
    async (host) => {
      const forKa = await s.toHandoff(host, 'ka.example.no');
      expect(forKa.target.hostname).toBe('ka.example.no');
      const res = await s.exchange(host, forKa.code, forKa.handoff);
      expect(s.cookieValue(res, sessionCookie)).toBeUndefined();
      expect(res.headers.get('location')).toBe('/');
    },
  );

  it('a handoff cookie from another hostname does not bind a code on the hostname it was made for', async () => {
    const forKa = await s.toHandoff('nynorsk.example.no', 'ka.example.no');
    const res = await s.exchange('ka.example.no', forKa.code, forKa.handoff);
    expect(s.cookieValue(res, sessionCookie)).toBeUndefined();
  });

  it('the login host refuses a login cookie moved to another hostname than it was sealed for', async () => {
    const begin = await s.via('/bff/auth/login', 'ka.example.no');
    const started = await s.via(`/bff/auth/login${s.atLocation(begin).search}`, LOGIN_HOST);
    const pending = JSON.parse(
      Buffer.from(s.cookieValue(started, loginCookie) ?? '', 'base64url').toString(),
    ) as { h: string; s: string };
    const moved = Buffer.from(JSON.stringify({ ...pending, h: 'nynorsk.example.no' })).toString(
      'base64url',
    );
    const back = await s.ansattporten(s.atLocation(started));
    const callback = await s.via(
      `/bff/auth/callback${back.search}`,
      LOGIN_HOST,
      `${loginCookie}=${moved}`,
    );
    expect(callback.headers.get('location')).toBe('https://nynorsk.example.no/');
  });

  it.each([
    ['another state', (q: URLSearchParams) => q.set('state', 'x'.repeat(43))],
    ['an error from Ansattporten', (q: URLSearchParams) => q.set('error', 'access_denied')],
    ['another issuer', (q: URLSearchParams) => q.set('iss', 'https://evil.example')],
  ])('the login host refuses a callback with %s', async (_, change) => {
    const begin = await s.via('/bff/auth/login', 'ka.example.no');
    const started = await s.via(`/bff/auth/login${s.atLocation(begin).search}`, LOGIN_HOST);
    const back = await s.ansattporten(s.atLocation(started));
    change(back.searchParams);
    const before = s.sent.length;
    const callback = await s.via(
      `/bff/auth/callback${back.search}`,
      LOGIN_HOST,
      `${loginCookie}=${s.cookieValue(started, loginCookie) ?? ''}`,
    );
    expect(callback.headers.get('location')).toBe('https://ka.example.no/');
    expect(callback.headers.getSetCookie().join()).toContain(`${loginCookie}=;`);
    expect(s.sent.slice(before).filter((c) => c.authorization !== null)).toEqual([]);
  });

  it('the login host refuses a login that took longer than ten minutes', async () => {
    const begin = await s.via('/bff/auth/login', 'ka.example.no');
    const started = await s.via(`/bff/auth/login${s.atLocation(begin).search}`, LOGIN_HOST);
    const back = await s.ansattporten(s.atLocation(started));
    s.advance(11 * 60_000);
    const before = s.sent.length;
    const callback = await s.via(
      `/bff/auth/callback${back.search}`,
      LOGIN_HOST,
      `${loginCookie}=${s.cookieValue(started, loginCookie) ?? ''}`,
    );
    expect(callback.headers.get('location')).toBe('https://ka.example.no/');
    expect(s.sent.slice(before).filter((c) => c.authorization !== null)).toEqual([]);
  });

  it('a handoff code works once', async () => {
    const { code, handoff } = await s.toHandoff();
    const first = await s.exchange('ka.example.no', code, handoff);
    expect(s.cookieValue(first, sessionCookie)).toBeTruthy();
    const again = await s.exchange('ka.example.no', code, handoff);
    expect(s.cookieValue(again, sessionCookie)).toBeUndefined();
    expect(again.headers.get('location')).toBe('/');
  });

  it('an expired handoff code is refused', async () => {
    const { code, handoff } = await s.toHandoff();
    s.advance(61_000);
    const late = await s.exchange('ka.example.no', code, handoff);
    expect(s.cookieValue(late, sessionCookie)).toBeUndefined();
    expect(late.headers.get('location')).toBe('/');
  });

  it('a handoff code is refused in a browser other than the one that started the login', async () => {
    const other = await s.via('/bff/auth/login', 'ka.example.no');
    const otherHandoff = s.cookieValue(other, handoffCookie) ?? '';
    for (const cookie of [otherHandoff, undefined]) {
      const victim = await s.toHandoff();
      const res = await s.exchange('ka.example.no', victim.code, cookie);
      expect(s.cookieValue(res, sessionCookie)).toBeUndefined();
      const burnt = await s.exchange('ka.example.no', victim.code, victim.handoff);
      expect(s.cookieValue(burnt, sessionCookie)).toBeUndefined();
    }
  });

  it.each([
    ['an unknown hostname', 'evil.example.no'],
    ['a hostname opened to hosting with no Client', 'opened.example.no'],
    ['a hosted hostname whose Client has its own oidc', 'own.example.no'],
    ['the login host itself', LOGIN_HOST],
    ['a URL', 'https://ka.example.no/x'],
    ['a hostname with a path', 'ka.example.no/x'],
    ['a hosted hostname that is not active', 'nynorsk.example.no'],
  ])('the login host refuses %s as a target', async (_, target) => {
    const binding = 'b'.repeat(43);
    s = await setup({ inactive: ['nynorsk.example.no'] });
    const res = await s.via(
      `/bff/auth/login?host=${encodeURIComponent(target)}&binding=${binding}`,
      LOGIN_HOST,
    );
    expect(res.status).toBe(404);
    expect(res.headers.get('location')).toBeNull();
  });

  it('logout ends the Ansattporten session through the login host and returns only to the registered hostname', async () => {
    const { id } = await s.signIn();
    const out = await s.via('/bff/auth/logout', 'ka.example.no', `${sessionCookie}=${id}`, {
      'sec-fetch-dest': 'document',
      'sec-fetch-site': 'same-origin',
    });
    const end = s.atLocation(out);
    expect(end.pathname).toBe('/logout');
    expect(end.searchParams.get('id_token_hint')).toBeTruthy();
    expect(end.searchParams.get('client_id')).toBe(PLATFORM_CLIENT);
    expect(end.searchParams.get('post_logout_redirect_uri')).toBe(
      `https://${LOGIN_HOST}/auth/logged-out`,
    );
    const fromAnsattporten = s.atLocation(await s.mock.app.request(`${end.pathname}${end.search}`));
    expect(fromAnsattporten.origin).toBe(`https://${LOGIN_HOST}`);
    const back = await s.via(
      `/bff/auth/logged-out${fromAnsattporten.search}`,
      fromAnsattporten.hostname,
    );
    expect(back.headers.get('location')).toBe('https://ka.example.no/');
  });

  it.each(['evil.example.no', 'own.example.no', 'https://ka.example.no', ''])(
    'after logout the login host returns to no hostname it does not sign in for (%s)',
    async (state) => {
      const neutral = await s.via(
        `/bff/auth/logged-out?state=${encodeURIComponent(state)}`,
        LOGIN_HOST,
        undefined,
        { 'accept-language': 'en' },
      );
      expect(neutral.status).toBe(200);
      expect(neutral.headers.get('location')).toBeNull();
      expect(await neutral.text()).toContain('You are signed out');
    },
  );

  it('the signed-out page is in bokmål unless the browser asks for English', async () => {
    const page = await s.via('/bff/auth/logged-out', LOGIN_HOST);
    const text = await page.text();
    expect(text).toContain('Du er logget ut');
    expect(text).toContain('lang="nb"');
  });

  it('sends genki’s own client secret only to the issuer’s origin', async () => {
    const other = await setup({ tokenEndpoint: 'https://evil.example/token' });
    const { callback } = await other.toHandoff();
    expect(callback.headers.get('location')).toBeNull();
    expect(other.sent.filter((c) => c.authorization !== null)).toEqual([]);
  });

  it('a page on the platform login does not fall back to a browser login while genki’s secret is missing', async () => {
    const other = await setup({ noSecret: true });
    const me = await other.via('/bff/auth/me', 'ka.example.no');
    expect(me.status).toBe(404);
    expect(await me.json()).toMatchObject({ code: 'bff-not-configured' });
  });

  it('a hostname on the platform login has no callback of its own', async () => {
    const res = await s.via('/bff/auth/callback?code=x&state=y', 'ka.example.no');
    expect(res.status).toBe(404);
  });

  it('a platform login session is confined to the Client of its hostname', async () => {
    const { id } = await s.signIn();
    await s.via('/v1/models', 'ka.example.no', `${sessionCookie}=${id}`);
    expect(s.principals.at(-1)).toMatchObject({
      tenant: ORG_A,
      client: PLATFORM_CLIENT,
      confinedTo: { tenant: ORG_A, service: 'kunnskapsassistenten', client: 'ka-host' },
    });
    await s.via('/v1/models', 'nynorsk.example.no', `${sessionCookie}=${id}`);
    expect(s.principals).toHaveLength(1);
  });

  it('the platform login client is refused without a hosted Client to act for', async () => {
    const tokens = await s.mock.testTokens(PID, PLATFORM_CLIENT, [RESOURCE]);
    await expect(s.verifier.verify(tokens.access_token)).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('a hosted Client with its own oidc still logs in with it', async () => {
    const begin = await s.via('/bff/auth/login', 'own.example.no');
    const authorize = s.atLocation(begin);
    expect(authorize.searchParams.get('client_id')).toBe('own-host');
    expect(authorize.searchParams.get('redirect_uri')).toBe('https://own.example.no/auth/callback');
    const back = await s.ansattporten(authorize);
    const callback = await s.via(
      `/bff/auth/callback${back.search}`,
      'own.example.no',
      `${loginCookie}=${s.cookieValue(begin, loginCookie) ?? ''}`,
    );
    expect(s.cookieValue(callback, sessionCookie)).toBeTruthy();
    const handoff = await s.via('/bff/auth/handoff?code=x', 'own.example.no');
    expect(handoff.status).toBe(404);
  });
});

describe('the platform login as a platform client', () => {
  it('a hosted assistant session gets no operator or employee rights even when the shared client is a platform client', async () => {
    const s = await setup({ platformClients: [PLATFORM_CLIENT] });
    const { id } = await s.signIn();
    await s.via('/v1/models', 'ka.example.no', `${sessionCookie}=${id}`);
    const principal = s.principals.at(-1) as Principal;
    expect(principal.confinedTo).toEqual({
      tenant: ORG_A,
      service: 'kunnskapsassistenten',
      client: 'ka-host',
    });
    const operators = operatorDirectory({
      subjects: [`${ISSUER}|${principal.subject}`],
      clientIds: [PLATFORM_CLIENT],
    });
    expect(operators.isOperator(principal)).toBe(false);
    const direct = await s.mock.testTokens(PID, PLATFORM_CLIENT, [RESOURCE]);
    expect((await s.verifier.verify(direct.access_token)).principal.confinedTo).toBeUndefined();
  });
});

describe('the subject of a platform login', () => {
  let s: Setup;
  beforeEach(async () => {
    s = await setup();
  });

  const principalOn = async (host: string) => {
    const { id } = await s.signIn(host);
    await s.via('/v1/models', host, `${sessionCookie}=${id}`);
    return s.principals.at(-1) as Principal;
  };

  const ansattportenSubject = async () =>
    decodeJwt((await s.mock.testTokens(PID, PLATFORM_CLIENT, [RESOURCE])).access_token).sub;

  const remoteService = () => {
    const sent: RemoteCall[] = [];
    const capability: Capability = {
      descriptor: {
        id: `${ORG_A}/kunnskapsassistenten/default`,
        version: '1',
        tenant: ORG_A,
        title: 'Ekstern',
        description: 'Ekstern agent',
        input: {},
        interaction: ['unary'],
        accepts: ['text/plain'],
        produces: ['text/plain'],
        emits: [],
        oversight: { interrupts: false, riskClass: 'limited', aiDisclosure: 'KI' },
      },
      strategy: { id: 'remote-agent', version: '1' },
      config: {
        strategy: remoteAgentConfig.parse({
          endpoint: { residency: 'norway', url: 'https://agent.example.no' },
          send: { identity: 'subject', history: false },
        }),
        output: { kind: 'answer' },
      },
      grants: [],
    };
    const kernel = createKernel({
      strategies: [
        createRemoteAgent({
          transport: {
            call: async (call) => {
              sent.push(call);
              return { answer: 'ok' } as RemoteReply;
            },
          },
        }),
      ],
      capabilities: [capability],
      ports: {},
      policy: { decide: async () => ({ allow: true }) },
    });
    const run = async (principal: Principal) => {
      const started = await kernel.invoke(principal, capability.descriptor.id, {
        data: { query: 'hei' },
      });
      await started.result;
      return started.task;
    };
    return { kernel, run, sent };
  };

  it('a person gets a different subject on each hosted Client of the platform login', async () => {
    const onKa = await principalOn('ka.example.no');
    const onNynorsk = await principalOn('nynorsk.example.no');
    const raw = await ansattportenSubject();
    expect(onKa.subject).not.toBe(onNynorsk.subject);
    expect([onKa.subject, onNynorsk.subject]).not.toContain(raw);
  });

  it('the same person keeps their subject on a hosted Client across logins', async () => {
    const first = await principalOn('ka.example.no');
    const again = await principalOn('ka.example.no');
    expect(again.subject).toBe(first.subject);
  });

  it('a remote backend never receives the Ansattporten subject of a platform login', async () => {
    const principal = await principalOn('ka.example.no');
    const raw = await ansattportenSubject();
    const remote = remoteService();
    await remote.run(principal);
    const sent = JSON.stringify(remote.sent[0]?.request);
    expect(remote.sent[0]?.request.context.principal?.subject).toBe(principal.subject);
    expect(sent).not.toContain(String(raw));
  });

  it('a person cannot open their run from another hosted Client by its id', async () => {
    const onKa = await principalOn('ka.example.no');
    const onNynorsk = await principalOn('nynorsk.example.no');
    const remote = remoteService();
    const task = await remote.run(onKa);
    await expect(remote.kernel.task(onKa, task)).resolves.toBeTruthy();
    await expect(remote.kernel.task(onNynorsk, task)).rejects.toMatchObject({
      code: 'not_found',
    });
  });
});

describe('the platform login when Entra groups give the rights', () => {
  it('sends people straight to Entra ID and asks Altinn for nothing', async () => {
    const s = await setup({ entraGroups: [EMPLOYEE_GROUP] });

    const { started } = await s.toHandoff();

    const authorize = s.atLocation(started).searchParams;
    expect(authorize.get('acr_values')).toBe('entraid');
    expect(authorize.has('authorization_details')).toBe(false);
  });

  it('lets an employee in the service group into a hosted assistant', async () => {
    const s = await setup({ entraGroups: [EMPLOYEE_GROUP] });

    const { id } = await s.signIn();

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('an Entra login sees its organisation’s name from the directory', async () => {
    const s = await setup({
      entraGroups: [EMPLOYEE_GROUP],
      directory: [
        { orgNumber: ORG_A, name: 'Digitaliseringsdirektoratet' },
        { orgNumber: ORG_B, name: 'Brønnøysundregistrene' },
      ],
    });

    const { id } = await s.signIn();

    expect(await organisationsAt(s, id)).toEqual([
      { orgNumber: ORG_A, name: 'Digitaliseringsdirektoratet' },
    ]);
  });

  it('an Entra login whose organisation the directory names only by its number sees the number', async () => {
    const s = await setup({
      entraGroups: [EMPLOYEE_GROUP],
      directory: [{ orgNumber: ORG_A, name: ORG_A }],
    });

    const { id } = await s.signIn();

    expect(await organisationsAt(s, id)).toEqual([{ orgNumber: ORG_A }]);
  });

  it('an Entra login still signs in, named by its number, when the directory cannot be read', async () => {
    const s = await setup({ entraGroups: [EMPLOYEE_GROUP], directory: 'unreadable' });

    const { id } = await s.signIn();

    expect(await organisationsAt(s, id)).toEqual([{ orgNumber: ORG_A }]);
  });

  it('shows a person in no group a page that says they have no access, with no session', async () => {
    const s = await setup({ entraGroups: ['00000000-0000-4000-8000-000000000000'] });

    const { callback } = await s.toHandoff();

    expect(callback.status).toBe(403);
    expect(callback.headers.get('location')).toBeNull();
    expect(await callback.text()).toContain('Denne assistenten er bare åpen for ansatte i Digdir');
    expect(callback.headers.getSetCookie().some((c) => c.startsWith(`${handoffCookie}=`))).toBe(
      false,
    );
  });

  it('the no-access page speaks the language the app asked for at login, not the browser’s', async () => {
    const s = await setup({ entraGroups: ['00000000-0000-4000-8000-000000000000'] });
    const english = { 'accept-language': 'en-GB,en;q=0.9' };

    const begin = await s.via(
      '/bff/auth/login?next=%2F&lang=nb',
      'ka.example.no',
      undefined,
      english,
    );
    const atLoginHost = s.atLocation(begin);
    const started = await s.via(
      `/bff/auth/login${atLoginHost.search}`,
      atLoginHost.hostname,
      undefined,
      english,
    );
    const back = await s.ansattporten(s.atLocation(started));
    const callback = await s.via(
      `/bff/auth/callback${back.search}`,
      back.hostname,
      `${loginCookie}=${s.cookieValue(started, loginCookie) ?? ''}`,
      english,
    );

    expect(callback.status).toBe(403);
    const page = await callback.text();
    expect(page).toContain('lang="nb"');
    expect(page).toContain('Denne assistenten er bare åpen for ansatte i Digdir');
  });

  it('the no-access page of a Client with its own oidc speaks the language asked for at login', async () => {
    const s = await setup({ entraGroups: ['00000000-0000-4000-8000-000000000000'] });
    const english = { 'accept-language': 'en-GB,en;q=0.9' };

    const begin = await s.via(
      '/bff/auth/login?next=%2F&lang=nb',
      'own.example.no',
      undefined,
      english,
    );
    const back = await s.ansattporten(s.atLocation(begin));
    const callback = await s.via(
      `/bff/auth/callback${back.search}`,
      'own.example.no',
      `${loginCookie}=${s.cookieValue(begin, loginCookie) ?? ''}`,
      english,
    );

    expect(callback.status).toBe(403);
    expect(await callback.text()).toContain('lang="nb"');
  });
});

describe('the platform login on production Ansattporten', () => {
  const production = (options: { tokenEndpoint?: string } = {}) =>
    setup({
      issuer: 'https://ansattporten.no',
      loginPage: 'https://login.ansattporten.no',
      entraGroups: [EMPLOYEE_GROUP],
      ...options,
    });

  it('asks for the API audience as resource, since production puts no aud in a token without it', async () => {
    const s = await production();

    const { started } = await s.toHandoff();

    expect(s.atLocation(started).searchParams.get('resource')).toBe(AUDIENCE);
  });

  it('sends people to production’s login page straight to Entra ID, asking Altinn for nothing', async () => {
    const s = await production();

    const { started } = await s.toHandoff();

    const authorize = s.atLocation(started);
    expect(authorize.origin).toBe('https://login.ansattporten.no');
    expect(authorize.searchParams.get('acr_values')).toBe('entraid');
    expect(authorize.searchParams.has('authorization_details')).toBe(false);
  });

  it('signs in with genki’s secret sent to the issuer’s origin', async () => {
    const s = await production();

    const { id } = await s.signIn();

    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const withSecret = s.sent.filter((r) => r.authorization?.startsWith('Basic '));
    expect(withSecret.length).toBeGreaterThan(0);
    expect(new Set(withSecret.map((r) => r.origin))).toEqual(new Set(['https://ansattporten.no']));
  });

  it('never sends genki’s secret to the login page, even when discovery puts the token endpoint there', async () => {
    const s = await production({ tokenEndpoint: 'https://login.ansattporten.no/token' });

    await s.toHandoff();

    expect(s.sent.filter((r) => r.authorization?.startsWith('Basic '))).toEqual([]);
  });

  it('refuses a callback whose iss is test Ansattporten before any token call', async () => {
    const s = await production();
    const begin = await s.via('/bff/auth/login', 'ka.example.no');
    const atLoginHost = s.atLocation(begin);
    const started = await s.via(`/bff/auth/login${atLoginHost.search}`, atLoginHost.hostname);
    const back = await s.ansattporten(s.atLocation(started));
    back.searchParams.set('iss', 'https://test.ansattporten.no');
    const before = s.sent.length;

    const callback = await s.via(
      `/bff/auth/callback${back.search}`,
      back.hostname,
      `${loginCookie}=${s.cookieValue(started, loginCookie) ?? ''}`,
    );

    expect(callback.headers.get('location')).toBe('https://ka.example.no/');
    expect(s.sent.slice(before).filter((r) => r.authorization !== null)).toEqual([]);
  });
});
