import { createHash, timingSafeEqual } from 'node:crypto';
import { negotiate } from '@genai/i18n';
import {
  AuthenticationError,
  isHostname,
  oidcAudienceOf,
  usesPlatformLogin,
  type ClientDefinition,
  type ClientStore,
} from '@genai/identity';
import { openingOf, type HostingRules } from '../hosts.js';
import { t, translatorFor } from '../i18n/index.js';
import { actAsPlatformApp, actFor, type PlatformApp } from './acting.js';
import {
  codeChallenge,
  createOidc,
  randomValue,
  TokenRefused,
  type ClientCredentials,
  type LogoutClaims,
  type Oidc,
} from './oidc.js';
import {
  newSessionId,
  parsePayload,
  sessionIdHash,
  type BffSessionRow,
  type BffSessionStore,
  type Organisation,
  type SessionPayload,
} from './sessions.js';

export const proxyKeyHeader = 'genai-proxy-key';
export const csrfHeader = 'genai-csrf';
export const sessionCookie = '__Host-genki_session';
export const loginCookie = '__Host-genki_login';
export const handoffCookie = '__Host-genki_handoff';

const sessionMs = 8 * 3600_000;
const loginMs = 10 * 60_000;
const handoffMs = 60_000;
const logoutTokenMs = 10 * 60_000;
const logoutBodyLimit = 16_384;
const refreshAheadMs = 60_000;
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
const strippedHeaders = [
  'cookie',
  'authorization',
  'x-api-key',
  proxyKeyHeader,
  'genai-acting-for',
];

export interface ClientSecrets {
  value(tenant: string, name: string): Promise<string | undefined>;
  hosts(tenant: string, name: string): Promise<readonly string[] | undefined>;
}

export interface BffDeps {
  /** The key the host's proxy sends; without it the BFF trusts no forwarded host. */
  proxyKey: string | undefined;
  sessions: BffSessionStore;
  clients: ClientStore;
  rules: HostingRules;
  /** Whether the hostname draws a service now, as `GET /v1/hosts/{hostname}` answers. */
  hostActive: (hostname: string) => Promise<boolean>;
  issuer: string | undefined;
  altinnResource?: string | undefined;
  /** Sent as `acr_values`, so a login goes straight to that method. */
  acrValues?: string | undefined;
  /** genki's own Ansattporten client, which a hosted Client without `oidc` and the platform apps log in through. */
  platformLogin?: PlatformLogin | undefined;
  /** The tenant a platform app's sessions and back-channel logouts are kept under. */
  platformTenant?: string;
  /** Whether the access token is a platform operator's, as the API sees it from the console. */
  isOperator?: (accessToken: string) => Promise<boolean>;
  secrets: ClientSecrets;
  /** The organisations the API lets the access token act for; throws when it refuses the token. */
  organisations: (accessToken: string) => Promise<Organisation[]>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

export interface PlatformLogin {
  clientId: string;
  secret: string | undefined;
  /** The login host, `login.apps.<zone>`, with the client's one redirect URI. */
  hostname: string;
  /** The login host's origin, `https://<hostname>` unless dev mode serves it elsewhere. */
  origin?: string;
  /** The portal, workspace and console, each on a hostname of its own. */
  apps?: readonly { app: PlatformApp; hostname: string; origin: string }[];
  /** The resource the login asks for, the API's audience as the portal asks. */
  audience: string;
}

interface Host {
  hostname: string;
  origin: string;
  tenant: string;
  /** The Client's registration id, or `platform-app:<app>` for a platform app. */
  clientId: string;
  client?: ClientDefinition;
  platform: boolean;
  app?: PlatformApp;
}

interface Login {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  at: number;
}

interface PlatformPending {
  state: string;
  nonce: string;
  verifier: string;
  binding: string;
  at: number;
}

interface HandoffPending {
  bind: string;
  next: string;
  at: number;
}

interface Handoff {
  handoff: { binding: string; session: SessionPayload };
}

const handoffHash = (code: string) => sessionIdHash(`handoff:${code}`);

const logoutJtiHash = (jti: string) => sessionIdHash(`logout-jti:${jti}`);

/** Keys that find a person's sessions from a back-channel logout: by the issuer's session id and by subject. */
export const logoutKeysOf = (
  issuer: string,
  clientId: string,
  claims: { sid?: unknown; sub?: unknown },
) => ({
  ...(typeof claims.sid === 'string' && claims.sid
    ? { sid: sessionIdHash(`sid\u0000${issuer}\u0000${clientId}\u0000${claims.sid}`) }
    : {}),
  ...(typeof claims.sub === 'string' && claims.sub
    ? { sub: sessionIdHash(`sub\u0000${issuer}\u0000${clientId}\u0000${claims.sub}`) }
    : {}),
});

const bindingOf = (bind: string) => createHash('sha256').update(bind).digest('base64url');

const opaque = /^[A-Za-z0-9_-]{43}$/;

const sameSecret = (a: string, b: string) => {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(a), digest(b));
};

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;

/** The person's name: `name`, else the given and family names. */
export const personName = (claims: Record<string, unknown>) =>
  text(claims.name) ??
  ([text(claims.given_name), text(claims.family_name)].filter(Boolean).join(' ') || undefined);

/** The organisations a login may act for, each by its name where Altinn gave one. */
export const organisationsOf = (principal: {
  authorizedFor?: readonly { org: string }[] | undefined;
  orgNames?: Readonly<Record<string, string>> | undefined;
}): Organisation[] =>
  [...new Set((principal.authorizedFor ?? []).map((a) => a.org))].map((orgNumber) => {
    const name = principal.orgNames?.[orgNumber];
    return { orgNumber, ...(name ? { name } : {}) };
  });

const cookie = (name: string, value: string, maxAgeSeconds: number) =>
  `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${Math.max(0, Math.floor(maxAgeSeconds))}`;

export const clearedCookie = (name: string) => cookie(name, '', 0);

export const cookieOf = (request: Request, name: string) => {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at > 0 && part.slice(0, at).trim() === name) {
      const value = part.slice(at + 1).trim();
      return /^[A-Za-z0-9_-]{1,4096}$/.test(value) ? value : undefined;
    }
  }
  return undefined;
};

/** A path on the same hostname, starting with a single `/`; anything else returns to `/`. */
export const safeReturn = (value: string | null | undefined) => {
  if (
    !value ||
    value.length > 2048 ||
    !value.startsWith('/') ||
    value.startsWith('//') ||
    [...value].some((ch) => ch === '\\' || ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) === 0x7f)
  )
    return '/';
  const base = 'https://host.invalid';
  const url = new URL(value, base);
  if (
    url.origin !== base ||
    url.pathname.startsWith('//') ||
    url.pathname.startsWith('/auth/') ||
    url.pathname.includes('\\')
  )
    return '/';
  return `${url.pathname}${url.search}${url.hash}`;
};

const noStore = { 'cache-control': 'no-store' };

const problem = (
  status: number,
  code: string,
  title: string,
  headers: Record<string, string> = {},
) => {
  const response = new Response(
    JSON.stringify({ type: `urn:genai:problem:${code}`, title, status, code }),
    { status, headers: { 'content-type': 'application/problem+json', ...noStore } },
  );
  new Headers(headers).forEach((value, name) => response.headers.append(name, value));
  return response;
};

const redirect = (location: string, cookies: string[] = [], status = 302) => {
  const headers = new Headers({ location, ...noStore });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status, headers });
};

const json = (body: unknown, status = 200, cookies: string[] = []) => {
  const headers = new Headers({ 'content-type': 'application/json', ...noStore });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
};

const notFound = () => problem(404, 'host-not-found', t('problems.hostNotFoundTitle'));

type Say = ReturnType<typeof translatorFor>;

const page = (
  request: Request,
  words: (say: Say) => { title: string; text: string },
  cookies: string[] = [],
  status = 200,
) => {
  const lang = negotiate(request.headers.get('accept-language')) ?? 'nb';
  const { title, text } = words(translatorFor(lang));
  const body = `<!doctype html><html lang="${lang}"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><h1>${title}</h1><p>${text}</p></html>`;
  const headers = new Headers({ 'content-type': 'text/html; charset=utf-8', ...noStore });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(body, { status, headers });
};

const signedOutPage = (request: Request, cookies: string[] = []) =>
  page(
    request,
    (say) => ({ title: say('problems.bffLoggedOutTitle'), text: say('problems.bffLoggedOutBody') }),
    cookies,
  );

const noAccessPage = (request: Request, host: Host, cookies: string[]) =>
  page(
    request,
    (say) =>
      host.app
        ? { title: say('problems.entraNotTrusted'), text: say('problems.entraNotTrustedDetail') }
        : { title: say('problems.serviceLocked'), text: say('problems.serviceLockedDetail') },
    cookies,
    403,
  );

const refusedLogin = (error: unknown) =>
  error instanceof AuthenticationError && error.code === 'entra_not_trusted';

const encodeHostCookie = (hostname: string, sealed: string) =>
  Buffer.from(JSON.stringify({ h: hostname, s: sealed })).toString('base64url');

const decodeHostCookie = (value: string | undefined) => {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString()) as {
      h?: unknown;
      s?: unknown;
    };
    return typeof parsed.h === 'string' && typeof parsed.s === 'string'
      ? { hostname: parsed.h, sealed: parsed.s }
      : undefined;
  } catch {
    return undefined;
  }
};

const isJson = (request: Request) =>
  /^application\/([a-z0-9.+-]*\+)?json\s*(;|$)/i.test(request.headers.get('content-type') ?? '');

const withSetCookie = (response: Response, value: string) => {
  const copy = new Response(response.body, response);
  copy.headers.append('set-cookie', value);
  return copy;
};

/** The BFF of ADR 0061 in front of the API: auth routes, and a session swapped for a bearer token. */
export const createBff = (deps: BffDeps) => {
  const now = deps.now ?? Date.now;
  const oidc: Oidc = createOidc({ ...(deps.fetch ? { fetch: deps.fetch } : {}), now });
  const log = deps.log ?? (() => undefined);

  const platformLogin = deps.platformLogin;
  const platformTenant = deps.platformTenant ?? '';
  const appOf = (hostname: string) =>
    platformLogin?.secret !== undefined && platformTenant
      ? platformLogin.apps?.find((a) => a.hostname === hostname)
      : undefined;

  const hostOf = async (hostname: string): Promise<Host | undefined> => {
    const app = appOf(hostname);
    if (app)
      return {
        hostname,
        origin: app.origin,
        tenant: platformTenant,
        clientId: `platform-app:${app.app}`,
        platform: true,
        app: app.app,
      };
    const opening = await openingOf(deps.rules, hostname);
    if (!opening || opening.redirectTo) return undefined;
    const { tenant } = opening;
    const candidates = opening.client
      ? [await deps.clients.get(tenant, opening.client)].flatMap((c) => (c ? [c] : []))
      : (await deps.clients.list(tenant)).filter((c) =>
          (c.definition.spec.hostnames ?? []).some((n) => n.hostname === hostname),
        );
    const client = candidates.find(
      (c) =>
        c.definition.metadata.tenant === tenant &&
        c.definition.spec.hosted === true &&
        (c.definition.spec.oidc !== undefined ||
          (platformLogin !== undefined && usesPlatformLogin(c.definition))),
    )?.definition;
    return (
      client && {
        hostname,
        origin: `https://${hostname}`,
        tenant,
        clientId: client.metadata.id,
        client,
        platform: usesPlatformLogin(client),
      }
    );
  };

  const origin = (host: Host) => host.origin;
  const redirectUri = (host: Host) => `${origin(host)}/auth/callback`;
  const loginOrigin = () => platformLogin?.origin ?? `https://${platformLogin?.hostname ?? ''}`;
  const platformRedirectUri = () => `${loginOrigin()}/auth/callback`;
  const active = async (host: Host) =>
    host.app !== undefined || (await deps.hostActive(host.hostname));
  /** Runs an API call as the session's hosted Client or platform app, inside this process only. */
  const within = <T>(host: Host, work: () => T): T =>
    host.app
      ? actAsPlatformApp(host.app, work)
      : host.platform
        ? actFor({ tenant: host.tenant, client: host.clientId }, work)
        : work();

  /** genki's own secret goes only to an endpoint on the issuer's origin. */
  const platformCredentials = (endpoint: string): ClientCredentials | undefined => {
    if (!platformLogin?.secret || !deps.issuer) return undefined;
    if (new URL(endpoint).origin !== new URL(deps.issuer).origin) {
      log('bff platform login secret not sent off the issuer', {
        endpoint: new URL(endpoint).origin,
      });
      return undefined;
    }
    return { clientId: platformLogin.clientId, secret: platformLogin.secret };
  };

  /** The client's secret, only for an endpoint whose origin the tenant secret is bound to. */
  const credentialsFor = async (host: Host, endpoint: string) => {
    if (host.platform) return platformCredentials(endpoint);
    const oidc = host.client?.spec.oidc;
    if (!oidc?.secret) return undefined;
    const hosts = await deps.secrets.hosts(host.tenant, oidc.secret);
    if (!hosts?.includes(new URL(endpoint).origin)) {
      log('bff client secret not bound to the endpoint', {
        hostname: host.hostname,
        endpoint: new URL(endpoint).origin,
      });
      return undefined;
    }
    const secret = await deps.secrets.value(host.tenant, oidc.secret);
    return secret ? { clientId: oidc.clientId, secret } : undefined;
  };

  const ready = (host: Host) =>
    deps.issuer !== undefined &&
    (host.platform
      ? platformLogin?.secret !== undefined
      : host.client?.spec.oidc?.secret !== undefined &&
        host.client.spec.oidc.redirectUris.includes(redirectUri(host)));

  const sessionOf = async (request: Request, host: Host) => {
    const id = cookieOf(request, sessionCookie);
    if (!id) return undefined;
    const idHash = sessionIdHash(id);
    const row = await deps.sessions.get(host.tenant, idHash);
    if (
      !row ||
      row.hostname !== host.hostname ||
      row.client !== host.clientId ||
      row.expiresAt <= now()
    )
      return { idHash, row: undefined, payload: undefined };
    return { idHash, row, payload: parsePayload(row.payload) };
  };

  const fresh = async (host: Host, idHash: string, payload: SessionPayload) => {
    if (payload.accessExpiresAt - refreshAheadMs > now()) return payload;
    const updated = await deps.sessions.update(host.tenant, idHash, async (current) => {
      const seen = parsePayload(current.payload);
      if (!seen) return undefined;
      if (seen.accessExpiresAt - refreshAheadMs > now()) return current;
      if (!seen.refreshToken || !deps.issuer) return undefined;
      const discovery = await oidc.discover(deps.issuer);
      const credentials = await credentialsFor(host, discovery.token_endpoint);
      if (!credentials) return undefined;
      try {
        const tokens = await oidc.token(discovery, credentials, {
          grant_type: 'refresh_token',
          refresh_token: seen.refreshToken,
        });
        const next: SessionPayload = {
          ...seen,
          accessToken: tokens.accessToken,
          accessExpiresAt: tokens.accessExpiresAt,
          refreshToken: tokens.refreshToken ?? seen.refreshToken,
          ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
        };
        return { ...current, payload: JSON.stringify(next) };
      } catch (error) {
        if (error instanceof TokenRefused) {
          log('bff refresh refused', { hostname: host.hostname });
          return undefined;
        }
        throw error;
      }
    });
    return updated && parsePayload(updated.payload);
  };

  const authorizeUrl = async (
    clientId: string,
    redirect: string,
    pending: { state: string; nonce: string; verifier: string },
    audience: string | undefined,
  ) => {
    const discovery = await oidc.discover(deps.issuer ?? '');
    const authorize = new URL(discovery.authorization_endpoint);
    const query = authorize.searchParams;
    query.set('response_type', 'code');
    query.set('client_id', clientId);
    query.set('redirect_uri', redirect);
    query.set('scope', 'openid profile');
    query.set('state', pending.state);
    query.set('nonce', pending.nonce);
    query.set('code_challenge', codeChallenge(pending.verifier));
    query.set('code_challenge_method', 'S256');
    if (audience) query.set('resource', audience);
    if (deps.acrValues) query.set('acr_values', deps.acrValues);
    if (deps.altinnResource)
      query.set(
        'authorization_details',
        JSON.stringify([{ type: 'ansattporten:altinn:resource', resource: deps.altinnResource }]),
      );
    return authorize.toString();
  };

  /** On the service's hostname: binds the coming code to this browser, then goes to the login host. */
  const handoffLogin = async (request: Request, host: Host) => {
    const bind = randomValue();
    const pending: HandoffPending = {
      bind,
      next: safeReturn(new URL(request.url).searchParams.get('next')),
      at: now(),
    };
    const sealed = await deps.sessions.seal(
      host.tenant,
      `handoff:${host.hostname}`,
      JSON.stringify(pending),
    );
    const start = new URL(`${loginOrigin()}/auth/login`);
    start.searchParams.set('host', host.hostname);
    start.searchParams.set('binding', bindingOf(bind));
    return redirect(start.toString(), [cookie(handoffCookie, sealed, loginMs / 1000)]);
  };

  const login = async (request: Request, host: Host) => {
    if (!deps.issuer || !(await active(host))) return notFound();
    if (!ready(host)) return problem(404, 'bff-not-configured', t('problems.bffNotConfigured'));
    if (host.platform) return handoffLogin(request, host);
    const oidcSettings = host.client?.spec.oidc;
    if (!host.client || !oidcSettings) return notFound();
    const pending: Login = {
      state: randomValue(),
      nonce: randomValue(),
      verifier: randomValue(),
      next: safeReturn(new URL(request.url).searchParams.get('next')),
      at: now(),
    };
    const sealed = await deps.sessions.seal(
      host.tenant,
      `login:${host.hostname}`,
      JSON.stringify(pending),
    );
    const location = await authorizeUrl(
      oidcSettings.clientId,
      redirectUri(host),
      pending,
      oidcAudienceOf(host.client),
    );
    return redirect(location, [cookie(loginCookie, sealed, loginMs / 1000)]);
  };

  /** Swaps an authorization code for the person's tokens, `refused` when the person has no access, or undefined when anything else fails. */
  const signedIn = async (
    host: Host,
    credentials: ClientCredentials,
    code: string,
    redirect: string,
    verifier: string,
    nonce: string,
  ): Promise<SessionPayload | 'refused' | undefined> => {
    const discovery = await oidc.discover(deps.issuer ?? '');
    try {
      const tokens = await oidc.token(discovery, credentials, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirect,
        code_verifier: verifier,
      });
      if (!tokens.idToken) throw new TokenRefused('no id token');
      const claims = await oidc.verifyIdToken(
        discovery,
        tokens.idToken,
        credentials.clientId,
        nonce,
      );
      const name = personName(claims);
      // Which claims came, never their values, so a login without a name can be traced.
      if (!name)
        log('bff login without a name', {
          hostname: host.hostname,
          claims: Object.keys(claims).sort(),
        });
      const organisations = await within(host, () => deps.organisations(tokens.accessToken));
      const operator =
        host.app === 'console'
          ? await within(host, () => deps.isOperator?.(tokens.accessToken) ?? false)
          : undefined;
      const keys = logoutKeysOf(deps.issuer ?? '', credentials.clientId, claims);
      return {
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.accessExpiresAt,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        idToken: tokens.idToken,
        ...(name ? { name } : {}),
        organisations,
        ...(organisations.length === 1 && organisations[0]
          ? { organisation: organisations[0].orgNumber }
          : {}),
        ...(operator === undefined ? {} : { operator }),
        logoutKeys: Object.values(keys),
      };
    } catch (error) {
      if (refusedLogin(error)) {
        log('bff login refused', { hostname: host.hostname, reason: 'no-access' });
        return 'refused';
      }
      log('bff login failed', {
        hostname: host.hostname,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return undefined;
    }
  };

  const startSession = async (request: Request, host: Host, payload: SessionPayload) => {
    const previous = cookieOf(request, sessionCookie);
    if (previous) await deps.sessions.delete(host.tenant, sessionIdHash(previous));
    const id = newSessionId();
    await deps.sessions.create(host.tenant, sessionIdHash(id), {
      hostname: host.hostname,
      client: host.clientId,
      expiresAt: now() + sessionMs,
      payload: JSON.stringify(payload),
      logoutKeys: payload.logoutKeys ?? [],
    });
    log('bff signed in', {
      hostname: host.hostname,
      client: host.clientId,
      platformLogin: host.platform,
    });
    return cookie(sessionCookie, id, sessionMs / 1000);
  };

  const callback = async (request: Request, host: Host) => {
    if (!deps.issuer || host.platform || !ready(host)) return notFound();
    const clear = clearedCookie(loginCookie);
    const back = () => redirect('/', [clear]);
    const sealed = cookieOf(request, loginCookie);
    const opened =
      sealed && (await deps.sessions.open(host.tenant, `login:${host.hostname}`, sealed));
    if (!opened) return back();
    const pending = JSON.parse(opened) as Partial<Login>;
    if (
      typeof pending.state !== 'string' ||
      typeof pending.nonce !== 'string' ||
      typeof pending.verifier !== 'string' ||
      typeof pending.next !== 'string' ||
      typeof pending.at !== 'number'
    )
      return back();
    const query = new URL(request.url).searchParams;
    const state = query.get('state') ?? '';
    const code = query.get('code');
    if (
      pending.at + loginMs < now() ||
      !sameSecret(state, pending.state) ||
      !code ||
      query.has('error') ||
      (query.has('iss') && query.get('iss') !== deps.issuer)
    ) {
      log('bff login refused', { hostname: host.hostname, reason: query.get('error') ?? 'state' });
      return back();
    }
    const discovery = await oidc.discover(deps.issuer);
    const credentials = await credentialsFor(host, discovery.token_endpoint);
    if (!credentials) return problem(404, 'bff-not-configured', t('problems.bffNotConfigured'));
    const payload = await signedIn(
      host,
      credentials,
      code,
      redirectUri(host),
      pending.verifier,
      pending.nonce,
    );
    if (payload === 'refused') return noAccessPage(request, host, [clear]);
    if (!payload) return back();
    return redirect(pending.next, [await startSession(request, host, payload), clear]);
  };

  /** A hostname the platform login may sign in for: active, hosted, and on the platform login. */
  const platformTarget = async (asked: string | null) => {
    const hostname = (asked ?? '').toLowerCase();
    if (!isHostname(hostname) || hostname === platformLogin?.hostname) return undefined;
    const host = await hostOf(hostname);
    if (!host?.platform || !(await active(host))) return undefined;
    return host;
  };

  /** On the login host: the authorization code flow with genki's own client, for one target hostname. */
  const platformStart = async (request: Request) => {
    const query = new URL(request.url).searchParams;
    const host = await platformTarget(query.get('host'));
    const binding = query.get('binding') ?? '';
    if (!host || !deps.issuer || !platformLogin) return notFound();
    if (!opaque.test(binding) || !ready(host))
      return problem(404, 'bff-not-configured', t('problems.bffNotConfigured'));
    const pending: PlatformPending = {
      state: randomValue(),
      nonce: randomValue(),
      verifier: randomValue(),
      binding,
      at: now(),
    };
    const sealed = await deps.sessions.seal(
      host.tenant,
      `platform-login:${host.hostname}`,
      JSON.stringify(pending),
    );
    const location = await authorizeUrl(
      platformLogin.clientId,
      platformRedirectUri(),
      pending,
      platformLogin.audience,
    );
    return redirect(location, [
      cookie(loginCookie, encodeHostCookie(host.hostname, sealed), loginMs / 1000),
    ]);
  };

  /** On the login host: finishes the login and hands it to the target hostname with a one-time code. */
  const platformCallback = async (request: Request) => {
    const clear = clearedCookie(loginCookie);
    const refused = (reason: string, host?: Host) => {
      log('bff platform login refused', { reason, ...(host ? { hostname: host.hostname } : {}) });
      return host ? redirect(`${origin(host)}/`, [clear]) : signedOutPage(request, [clear]);
    };
    const stored = decodeHostCookie(cookieOf(request, loginCookie));
    const host = stored && (await platformTarget(stored.hostname));
    if (!stored || !host || !deps.issuer) return refused('target');
    const opened = await deps.sessions.open(
      host.tenant,
      `platform-login:${host.hostname}`,
      stored.sealed,
    );
    const pending = opened ? (JSON.parse(opened) as Partial<PlatformPending>) : undefined;
    const query = new URL(request.url).searchParams;
    const code = query.get('code');
    if (
      !pending ||
      typeof pending.state !== 'string' ||
      typeof pending.nonce !== 'string' ||
      typeof pending.verifier !== 'string' ||
      typeof pending.binding !== 'string' ||
      typeof pending.at !== 'number' ||
      pending.at + loginMs < now() ||
      !sameSecret(query.get('state') ?? '', pending.state) ||
      !code ||
      query.has('error') ||
      (query.has('iss') && query.get('iss') !== deps.issuer)
    )
      return refused(query.has('error') ? 'provider-error' : 'state', host);
    const discovery = await oidc.discover(deps.issuer);
    const credentials = platformCredentials(discovery.token_endpoint);
    if (!credentials) return problem(404, 'bff-not-configured', t('problems.bffNotConfigured'));
    const session = await signedIn(
      host,
      credentials,
      code,
      platformRedirectUri(),
      pending.verifier,
      pending.nonce,
    );
    if (session === 'refused') return noAccessPage(request, host, [clear]);
    if (!session) return refused('login', host);
    if (host.app === 'console' && session.operator !== true) {
      log('bff platform login refused', { reason: 'not-operator', hostname: host.hostname });
      return redirect(`${origin(host)}/?signin=not-operator`, [clear]);
    }
    const handoff = randomValue();
    const row: Handoff = { handoff: { binding: pending.binding, session } };
    await deps.sessions.create(host.tenant, handoffHash(handoff), {
      hostname: host.hostname,
      client: host.clientId,
      expiresAt: now() + handoffMs,
      payload: JSON.stringify(row),
      ...(session.logoutKeys ? { logoutKeys: session.logoutKeys } : {}),
    });
    const target = new URL(`${origin(host)}/auth/handoff`);
    target.searchParams.set('code', handoff);
    return redirect(target.toString(), [clear]);
  };

  /** On the service's hostname: swaps a one-time code for the session cookie, in the browser that asked. */
  const handoff = async (request: Request, host: Host) => {
    if (!host.platform || !ready(host) || !(await active(host))) return notFound();
    const clear = clearedCookie(handoffCookie);
    const refused = (reason: string) => {
      log('bff handoff refused', { hostname: host.hostname, reason });
      return redirect('/', [clear]);
    };
    const code = new URL(request.url).searchParams.get('code') ?? '';
    if (!opaque.test(code)) return refused('code');
    const idHash = handoffHash(code);
    const row = await deps.sessions.get(host.tenant, idHash);
    if (!row || !(await deps.sessions.delete(host.tenant, idHash))) return refused('code');
    const sealed = cookieOf(request, handoffCookie);
    const opened =
      sealed && (await deps.sessions.open(host.tenant, `handoff:${host.hostname}`, sealed));
    const pending = opened ? (JSON.parse(opened) as Partial<HandoffPending>) : undefined;
    const stored = (() => {
      try {
        return (JSON.parse(row.payload) as Partial<Handoff>).handoff;
      } catch {
        return undefined;
      }
    })();
    if (
      row.hostname !== host.hostname ||
      row.client !== host.clientId ||
      row.expiresAt <= now() ||
      !stored ||
      typeof stored.binding !== 'string' ||
      !pending ||
      typeof pending.bind !== 'string' ||
      typeof pending.next !== 'string' ||
      typeof pending.at !== 'number' ||
      pending.at + loginMs < now() ||
      !sameSecret(bindingOf(pending.bind), stored.binding)
    )
      return refused('binding');
    const session = parsePayload(JSON.stringify(stored.session));
    if (!session) return refused('session');
    return redirect(pending.next, [await startSession(request, host, session), clear]);
  };

  /** On the login host after Ansattporten's logout: back to the hostname it started on, if it is one. */
  const loggedOut = async (request: Request) => {
    const host = await platformTarget(new URL(request.url).searchParams.get('state'));
    return host ? redirect(`${origin(host)}/`) : signedOutPage(request);
  };

  const describe = (payload: SessionPayload, row: BffSessionRow) => ({
    name: payload.name ?? null,
    organisation: payload.organisation ?? null,
    organisations: payload.organisations,
    expiresAt: new Date(row.expiresAt).toISOString(),
    ...(payload.operator === undefined ? {} : { operator: payload.operator }),
  });

  const me = async (request: Request, host: Host) => {
    if (!(await active(host))) return notFound();
    if (!ready(host))
      return host.platform
        ? problem(404, 'bff-not-configured', t('problems.bffNotConfigured'))
        : notFound();
    const found = await sessionOf(request, host);
    if (!found?.row || !found.payload)
      return problem(
        401,
        'signed-out',
        t('problems.bffSignedOut'),
        found ? { 'set-cookie': clearedCookie(sessionCookie) } : {},
      );
    return json(describe(found.payload, found.row));
  };

  const chooseOrganisation = async (request: Request, host: Host) => {
    if (request.headers.get('origin') !== origin(host))
      return problem(403, 'csrf-refused', t('problems.bffCsrfRefused'));
    const found = await sessionOf(request, host);
    if (!found?.row || !found.payload)
      return problem(401, 'signed-out', t('problems.bffSignedOut'));
    const form = !isJson(request);
    const body = form
      ? Object.fromEntries(new URLSearchParams(await request.text()))
      : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
    const wanted = typeof body.organisation === 'string' ? body.organisation : '';
    if (!found.payload.organisations.some((o) => o.orgNumber === wanted))
      return problem(403, 'organisation-refused', t('problems.bffOrganisationRefused'));
    const updated = await deps.sessions.update(host.tenant, found.idHash, async (current) => {
      const seen = parsePayload(current.payload);
      return seen && { ...current, payload: JSON.stringify({ ...seen, organisation: wanted }) };
    });
    const payload = updated && parsePayload(updated.payload);
    if (!updated || !payload) return problem(401, 'signed-out', t('problems.bffSignedOut'));
    return form
      ? redirect(safeReturn(typeof body.next === 'string' ? body.next : '/'), [], 303)
      : json(describe(payload, updated));
  };

  const logout = async (request: Request, host: Host) => {
    const dest = request.headers.get('sec-fetch-dest');
    const site = request.headers.get('sec-fetch-site');
    if ((dest && dest !== 'document') || (site && site !== 'same-origin' && site !== 'none'))
      return problem(403, 'csrf-refused', t('problems.bffCsrfRefused'));
    const cleared = [clearedCookie(sessionCookie)];
    const found = await sessionOf(request, host);
    if (!found) return redirect('/', cleared);
    await deps.sessions.delete(host.tenant, found.idHash);
    if (!found.payload || !deps.issuer) return redirect('/', cleared);
    try {
      const discovery = await oidc.discover(deps.issuer);
      if (found.payload.refreshToken && discovery.revocation_endpoint) {
        const credentials = await credentialsFor(host, discovery.revocation_endpoint);
        const revoked =
          credentials &&
          (await oidc
            .revoke(discovery, credentials, found.payload.refreshToken)
            .catch(() => false));
        if (!revoked) log('bff refresh token not revoked', { hostname: host.hostname });
      }
      if (!discovery.end_session_endpoint) return redirect('/', cleared);
      const end = new URL(discovery.end_session_endpoint);
      if (found.payload.idToken) end.searchParams.set('id_token_hint', found.payload.idToken);
      if (host.platform) {
        end.searchParams.set('post_logout_redirect_uri', `${loginOrigin()}/auth/logged-out`);
        end.searchParams.set('state', host.hostname);
        end.searchParams.set('client_id', platformLogin?.clientId ?? '');
      } else {
        end.searchParams.set('post_logout_redirect_uri', `${origin(host)}/`);
        end.searchParams.set('client_id', host.client?.spec.oidc?.clientId ?? '');
      }
      return redirect(end.toString(), cleared);
    } catch {
      return redirect('/', cleared);
    }
  };

  /** On the login host: Ansattporten's back-channel logout ends every session of that login. */
  const backchannelLogout = async (request: Request) => {
    const refused = (reason: string) => {
      log('bff back-channel logout refused', { reason });
      return new Response(JSON.stringify({ error: 'invalid_request' }), {
        status: 400,
        headers: { 'content-type': 'application/json', ...noStore },
      });
    };
    if (!platformLogin || !deps.issuer || !platformTenant) return notFound();
    if (
      !/^application\/x-www-form-urlencoded\s*(;|$)/i.test(
        request.headers.get('content-type') ?? '',
      )
    )
      return refused('content-type');
    const body = await request.text();
    if (body.length > logoutBodyLimit) return refused('size');
    const token = new URLSearchParams(body).get('logout_token');
    if (!token) return refused('token');
    let claims: LogoutClaims;
    try {
      claims = await oidc.verifyLogoutToken(
        await oidc.discover(deps.issuer),
        token,
        platformLogin.clientId,
      );
    } catch (error) {
      if (!(error instanceof TokenRefused)) throw error;
      return refused(error.message);
    }
    const jti = logoutJtiHash(claims.jti);
    const fresh = await deps.sessions.claim(platformTenant, jti, {
      hostname: platformLogin.hostname,
      client: 'back-channel-logout',
      expiresAt: now() + logoutTokenMs,
      payload: '{}',
    });
    if (!fresh) return refused('replayed');
    const keys = logoutKeysOf(deps.issuer, platformLogin.clientId, claims);
    const ended = await deps.sessions
      .endByLogoutKeys(keys.sid ? [keys.sid] : keys.sub ? [keys.sub] : [])
      .catch(async (error: unknown) => {
        await deps.sessions.delete(platformTenant, jti);
        throw error;
      });
    log('bff back-channel logout', { ended, by: keys.sid ? 'sid' : 'sub' });
    return new Response(null, { status: 200, headers: noStore });
  };

  const loginHostAuth = (request: Request, path: string) => {
    if (path === '/bff/auth/backchannel-logout' && request.method === 'POST')
      return backchannelLogout(request);
    if (request.method !== 'GET') return notFound();
    if (path === '/bff/auth/login') return platformStart(request);
    if (path === '/bff/auth/callback') return platformCallback(request);
    if (path === '/bff/auth/logged-out') return loggedOut(request);
    return notFound();
  };

  const auth = async (request: Request, host: Host | undefined, path: string) => {
    if (!host) return notFound();
    const method = request.method;
    if (path === '/bff/auth/login' && method === 'GET') return login(request, host);
    if (path === '/bff/auth/callback' && method === 'GET') return callback(request, host);
    if (path === '/bff/auth/handoff' && method === 'GET') return handoff(request, host);
    if (path === '/bff/auth/me' && method === 'GET') return me(request, host);
    if (path === '/bff/auth/org' && method === 'GET') return me(request, host);
    if (path === '/bff/auth/org' && method === 'POST') return chooseOrganisation(request, host);
    if (path === '/bff/auth/logout' && method === 'GET') return logout(request, host);
    return notFound();
  };

  const csrfRefused = (request: Request, host: Host) =>
    !safeMethods.has(request.method) &&
    (request.headers.get('origin') !== origin(host) ||
      (!isJson(request) && request.headers.get(csrfHeader) === null));

  const forward = async (
    request: Request,
    host: Host | undefined,
    next: (request: Request) => Response | Promise<Response>,
  ) => {
    const headers = new Headers(request.headers);
    for (const name of strippedHeaders) headers.delete(name);
    let clear = cookieOf(request, sessionCookie) !== undefined;
    let swapped = false;
    const own = request.headers.get('authorization');
    if (host?.app && !clear && own) headers.set('authorization', own);
    const found = host && (await sessionOf(request, host));
    if (host && found?.row && found.payload) {
      if (csrfRefused(request, host))
        return problem(403, 'csrf-refused', t('problems.bffCsrfRefused'));
      let payload: SessionPayload | undefined;
      try {
        payload = await fresh(host, found.idHash, found.payload);
      } catch {
        return problem(503, 'login-unavailable', t('problems.bffLoginUnavailable'));
      }
      if (!payload)
        return problem(401, 'signed-out', t('problems.bffSignedOut'), {
          'set-cookie': clearedCookie(sessionCookie),
        });
      headers.set('authorization', `Bearer ${payload.accessToken}`);
      if (payload.organisation && !host.app) headers.set('genai-acting-for', payload.organisation);
      clear = false;
      swapped = true;
    }
    const hasBody = !safeMethods.has(request.method);
    const outgoing = new Request(request.url, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
      signal: request.signal,
    } as RequestInit);
    const response =
      host && swapped ? await within(host, () => next(outgoing)) : await next(outgoing);
    return clear ? withSetCookie(response, clearedCookie(sessionCookie)) : response;
  };

  /** Runs in front of the API: a request without the proxy key passes through untouched. */
  const handle = async (
    request: Request,
    next: (request: Request) => Response | Promise<Response>,
  ): Promise<Response> => {
    const key = request.headers.get(proxyKeyHeader);
    if (key === null) return next(request);
    if (!deps.proxyKey || !sameSecret(key, deps.proxyKey))
      return problem(403, 'proxy-refused', t('problems.bffProxyRefused'));
    const hostname = (request.headers.get('x-forwarded-host') ?? '').trim().toLowerCase();
    if (!isHostname(hostname) && hostname !== platformLogin?.hostname) return notFound();
    const onLoginHost = platformLogin !== undefined && hostname === platformLogin.hostname;
    const host = onLoginHost ? undefined : await hostOf(hostname);
    const path = new URL(request.url).pathname;
    if (path === '/bff/auth' || path.startsWith('/bff/auth/')) {
      try {
        return await (onLoginHost ? loginHostAuth(request, path) : auth(request, host, path));
      } catch (error) {
        log('bff auth failed', {
          hostname,
          path,
          error: error instanceof Error ? error.name : 'unknown',
        });
        return problem(503, 'login-unavailable', t('problems.bffLoginUnavailable'));
      }
    }
    return forward(request, host, next);
  };

  return { handle };
};

export type Bff = ReturnType<typeof createBff>;
