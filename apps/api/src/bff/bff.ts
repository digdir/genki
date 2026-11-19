import { createHash, timingSafeEqual } from 'node:crypto';
import {
  isHostname,
  oidcAudienceOf,
  type ClientDefinition,
  type ClientStore,
} from '@genai/identity';
import { openedTo, type HostingRules } from '../hosts.js';
import { t } from '../i18n/index.js';
import { codeChallenge, createOidc, randomValue, TokenRefused, type Oidc } from './oidc.js';
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

const sessionMs = 8 * 3600_000;
const loginMs = 10 * 60_000;
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
  secrets: ClientSecrets;
  /** The organisations the API lets the access token act for; throws when it refuses the token. */
  organisations: (accessToken: string) => Promise<Organisation[]>;
  fetch?: typeof fetch;
  now?: () => number;
  log?: (message: string, fields: Record<string, unknown>) => void;
}

interface Host {
  hostname: string;
  tenant: string;
  client: ClientDefinition;
}

interface Login {
  state: string;
  nonce: string;
  verifier: string;
  next: string;
  at: number;
}

const sameSecret = (a: string, b: string) => {
  const digest = (v: string) => createHash('sha256').update(v).digest();
  return timingSafeEqual(digest(a), digest(b));
};

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

  const hostOf = async (hostname: string): Promise<Host | undefined> => {
    const tenant = openedTo(deps.rules, hostname);
    if (!tenant) return undefined;
    const client = (await deps.clients.list(tenant)).find(
      (c) =>
        c.definition.metadata.tenant === tenant &&
        c.definition.spec.hosted === true &&
        c.definition.spec.oidc !== undefined &&
        (c.definition.spec.hostnames ?? []).some((n) => n.hostname === hostname),
    )?.definition;
    return client && { hostname, tenant, client };
  };

  const origin = (host: Host) => `https://${host.hostname}`;
  const redirectUri = (host: Host) => `${origin(host)}/auth/callback`;

  /** The client's secret, only for an endpoint whose origin the tenant secret is bound to. */
  const credentialsFor = async (host: Host, endpoint: string) => {
    const oidc = host.client.spec.oidc;
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
    host.client.spec.oidc?.secret !== undefined &&
    host.client.spec.oidc.redirectUris.includes(redirectUri(host));

  const sessionOf = async (request: Request, host: Host) => {
    const id = cookieOf(request, sessionCookie);
    if (!id) return undefined;
    const idHash = sessionIdHash(id);
    const row = await deps.sessions.get(host.tenant, idHash);
    if (
      !row ||
      row.hostname !== host.hostname ||
      row.client !== host.client.metadata.id ||
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

  const login = async (request: Request, host: Host) => {
    if (!deps.issuer || !(await deps.hostActive(host.hostname))) return notFound();
    if (!ready(host)) return problem(404, 'bff-not-configured', t('problems.bffNotConfigured'));
    const oidcSettings = host.client.spec.oidc;
    if (!oidcSettings) return notFound();
    const discovery = await oidc.discover(deps.issuer);
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
    const authorize = new URL(discovery.authorization_endpoint);
    const query = authorize.searchParams;
    query.set('response_type', 'code');
    query.set('client_id', oidcSettings.clientId);
    query.set('redirect_uri', redirectUri(host));
    query.set('scope', 'openid profile');
    query.set('state', pending.state);
    query.set('nonce', pending.nonce);
    query.set('code_challenge', codeChallenge(pending.verifier));
    query.set('code_challenge_method', 'S256');
    const audience = oidcAudienceOf(host.client);
    if (audience) query.set('resource', audience);
    if (deps.altinnResource)
      query.set(
        'authorization_details',
        JSON.stringify([{ type: 'ansattporten:altinn:resource', resource: deps.altinnResource }]),
      );
    return redirect(authorize.toString(), [cookie(loginCookie, sealed, loginMs / 1000)]);
  };

  const callback = async (request: Request, host: Host) => {
    if (!deps.issuer || !ready(host)) return notFound();
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
    let payload: SessionPayload;
    try {
      const tokens = await oidc.token(discovery, credentials, {
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri(host),
        code_verifier: pending.verifier,
      });
      if (!tokens.idToken) throw new TokenRefused('no id token');
      const claims = await oidc.verifyIdToken(
        discovery,
        tokens.idToken,
        credentials.clientId,
        pending.nonce,
      );
      const organisations = await deps.organisations(tokens.accessToken);
      payload = {
        accessToken: tokens.accessToken,
        accessExpiresAt: tokens.accessExpiresAt,
        ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
        idToken: tokens.idToken,
        ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
        organisations,
        ...(organisations.length === 1 && organisations[0]
          ? { organisation: organisations[0].orgNumber }
          : {}),
      };
    } catch (error) {
      log('bff login failed', {
        hostname: host.hostname,
        error: error instanceof Error ? error.name : 'unknown',
      });
      return back();
    }
    const previous = cookieOf(request, sessionCookie);
    if (previous) await deps.sessions.delete(host.tenant, sessionIdHash(previous));
    const id = newSessionId();
    const expiresAt = now() + sessionMs;
    await deps.sessions.create(host.tenant, sessionIdHash(id), {
      hostname: host.hostname,
      client: host.client.metadata.id,
      expiresAt,
      payload: JSON.stringify(payload),
    });
    log('bff signed in', { hostname: host.hostname, client: host.client.metadata.id });
    return redirect(pending.next, [cookie(sessionCookie, id, sessionMs / 1000), clear]);
  };

  const describe = (payload: SessionPayload, row: BffSessionRow) => ({
    name: payload.name ?? null,
    organisation: payload.organisation ?? null,
    organisations: payload.organisations,
    expiresAt: new Date(row.expiresAt).toISOString(),
  });

  const me = async (request: Request, host: Host) => {
    if (!(await deps.hostActive(host.hostname)) || !ready(host)) return notFound();
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
      end.searchParams.set('post_logout_redirect_uri', `${origin(host)}/`);
      end.searchParams.set('client_id', host.client.spec.oidc?.clientId ?? '');
      return redirect(end.toString(), cleared);
    } catch {
      return redirect('/', cleared);
    }
  };

  const auth = async (request: Request, host: Host | undefined, path: string) => {
    if (!host) return notFound();
    const method = request.method;
    if (path === '/bff/auth/login' && method === 'GET') return login(request, host);
    if (path === '/bff/auth/callback' && method === 'GET') return callback(request, host);
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
      if (payload.organisation) headers.set('genai-acting-for', payload.organisation);
      clear = false;
    }
    const hasBody = !safeMethods.has(request.method);
    const swapped = new Request(request.url, {
      method: request.method,
      headers,
      ...(hasBody ? { body: request.body, duplex: 'half' } : {}),
      signal: request.signal,
    } as RequestInit);
    const response = await next(swapped);
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
    if (!isHostname(hostname)) return notFound();
    const host = await hostOf(hostname);
    const path = new URL(request.url).pathname;
    if (path === '/bff/auth' || path.startsWith('/bff/auth/')) {
      try {
        return await auth(request, host, path);
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
