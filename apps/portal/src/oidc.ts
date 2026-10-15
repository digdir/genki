import { resolveLocale } from '@genai/i18n';
import { translator } from './i18n';
import type { Organisation, Session } from './types';

export interface OidcAuthClient {
  current(): Session | undefined;
  login(): Promise<Session>;
  logout(endSession?: boolean): Promise<void>;
  callbackPending(): boolean;
  expiresAt(): number | undefined;
  refresh(): Promise<Session | undefined>;
}

interface FallbackClient {
  current(): Session | undefined;
  login(): Promise<Session>;
  logout?(): Promise<void>;
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface AnsattportenOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  audience: string;
  altinnResource: string;
  fetch: typeof fetch;
  storage: KeyValueStore;
  location: () => URL;
  navigate: (url: string) => void;
  replace: (url: string) => void;
  endpoint?: (url: string) => string;
  fallback?: FallbackClient;
  now?: () => number;
  uiLocales?: () => string;
  organisations?: (token: string) => Promise<Organisation[]>;
}

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

interface PendingLogin {
  state: string;
  verifier: string;
  nonce: string;
  returnTo?: string;
}

type StoredSession = Session & { expiresAt?: number; refreshToken?: string; idToken?: string };

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
}

interface AuthorizedParty {
  orgno: { ID: string };
  name: string;
  actions: string[];
}

interface AuthorizationDetail {
  type: string;
  resource: string;
  authorized_parties?: AuthorizedParty[];
}

export class LoginError extends Error {
  override name = 'LoginError';
}

export const ALTINN_RESOURCE_DETAIL = 'ansattporten:altinn:resource';

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const randomString = (length = 32) => base64url(crypto.getRandomValues(new Uint8Array(length)));

export const codeChallenge = async (verifier: string) =>
  base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );

export const decodeJwt = (token: string): Record<string, unknown> => {
  const part = token.split('.')[1] ?? '';
  const binary = atob(part.replaceAll('-', '+').replaceAll('_', '/'));
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
};

export const organisationsFrom = (claims: Record<string, unknown>, resource: string) => {
  const details = Array.isArray(claims.authorization_details)
    ? (claims.authorization_details as AuthorizationDetail[])
    : [];
  const found = new Map<string, Organisation>();
  for (const detail of details) {
    if (detail.type !== ALTINN_RESOURCE_DETAIL || detail.resource !== resource) continue;
    for (const party of detail.authorized_parties ?? []) {
      const orgNumber = party.orgno.ID.replace(/^0192:/, '');
      if (!found.has(orgNumber))
        found.set(orgNumber, { orgNumber, name: party.name, actions: party.actions });
    }
  }
  return [...found.values()];
};

export const isEntraLogin = (token: string) => {
  try {
    return decodeJwt(token).acr === 'entraid';
  } catch {
    return false;
  }
};

interface MyOrganisations {
  organisations?: { orgNumber: string; name: string; rights: string[] }[];
  title?: string;
  detail?: string;
}

export const organisationsFromApi =
  (fetcher: typeof fetch, baseUrl: string) =>
  async (token: string): Promise<Organisation[]> => {
    const response = await fetcher(`${baseUrl}/me`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    const body = (await response.json().catch(() => ({}))) as MyOrganisations;
    if (!response.ok)
      throw new LoginError(body.detail ?? body.title ?? `GET /me answered ${response.status}`);
    return (body.organisations ?? []).map(({ orgNumber, name, rights }) => ({
      orgNumber,
      name,
      actions: rights,
    }));
  };

const textClaim = (...values: unknown[]) =>
  values.find((v) => typeof v === 'string' && v) as string | undefined;

export const ansattporten = (options: AnsattportenOptions): OidcAuthClient => {
  const sessionKey = `${options.clientId}.session`;
  const loginKey = `${options.clientId}.login`;
  const now = options.now ?? (() => Date.now());
  const endpoint = options.endpoint ?? ((url: string) => url);
  const callbackPath = new URL(options.redirectUri).pathname;
  let viaFallback = false;
  let completing: Promise<Session> | undefined;
  let redirecting: Promise<Session> | undefined;

  const read = <T>(key: string): T | undefined => {
    const raw = options.storage.getItem(key);
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  };

  const discover = async () => {
    const response = await options.fetch(
      endpoint(`${options.issuer}/.well-known/openid-configuration`),
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok) throw new Error(`discovery failed with status ${response.status}`);
    return (await response.json()) as Discovery;
  };

  const isCallback = (url: URL) =>
    url.pathname === callbackPath &&
    (url.searchParams.has('code') || url.searchParams.has('error'));

  const complete = async (url: URL): Promise<Session> => {
    const pending = read<PendingLogin>(loginKey);
    options.storage.removeItem(loginKey);
    options.replace(`/${pending?.returnTo ?? ''}`);
    const params = url.searchParams;
    if (params.get('error'))
      throw new LoginError(params.get('error_description') ?? params.get('error') ?? 'login');
    if (!pending || params.get('state') !== pending.state)
      throw new LoginError('state does not match');
    const iss = params.get('iss');
    if (iss && iss !== options.issuer) throw new LoginError('unexpected issuer');
    const discovery = await discover();
    const response = await options.fetch(endpoint(discovery.token_endpoint), {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: params.get('code') ?? '',
        redirect_uri: options.redirectUri,
        client_id: options.clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (!response.ok) throw new LoginError(`token exchange failed with status ${response.status}`);
    const tokens = (await response.json()) as TokenResponse;
    const id = tokens.id_token ? decodeJwt(tokens.id_token) : {};
    if (tokens.id_token && id.nonce !== pending.nonce) throw new LoginError('nonce does not match');
    return keep(tokens, id);
  };

  const keep = async (
    tokens: TokenResponse,
    id: Record<string, unknown>,
    previous?: StoredSession,
  ) => {
    const access = decodeJwt(tokens.access_token);
    const name = textClaim(id.name, access.name, previous?.name, id.email, access.email) ?? '';
    const listed = organisationsFrom(access, options.altinnResource);
    const organisations =
      listed.length === 0 && options.organisations
        ? await options.organisations(tokens.access_token)
        : listed;
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    const idToken = tokens.id_token ?? previous?.idToken;
    const session: StoredSession = {
      name: name || translator(resolveLocale(options.uiLocales?.()))('app.unknownUser'),
      organisations,
      token: tokens.access_token,
      ...(typeof access.exp === 'number' ? { expiresAt: access.exp * 1000 } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(idToken ? { idToken } : {}),
    };
    options.storage.setItem(sessionKey, JSON.stringify(session));
    return { name: session.name, organisations: session.organisations, token: session.token };
  };

  const stored = () => {
    const session = read<StoredSession>(sessionKey);
    if (!session) return undefined;
    if (session.expiresAt !== undefined && session.expiresAt <= now()) {
      options.storage.removeItem(sessionKey);
      return undefined;
    }
    return { name: session.name, organisations: session.organisations, token: session.token };
  };

  const redirect = async (): Promise<Session> => {
    let discovery: Discovery;
    try {
      discovery = await discover();
    } catch (error) {
      if (!options.fallback) throw error;
      viaFallback = true;
      return options.fallback.login();
    }
    const pending: PendingLogin = {
      state: randomString(),
      verifier: randomString(),
      nonce: randomString(),
    };
    const hash = options.location().hash;
    options.storage.setItem(
      loginKey,
      JSON.stringify(hash && hash !== '#' ? { ...pending, returnTo: hash } : pending),
    );
    const authorize = new URL(discovery.authorization_endpoint);
    const query = authorize.searchParams;
    query.set('response_type', 'code');
    query.set('client_id', options.clientId);
    query.set('redirect_uri', options.redirectUri);
    query.set('scope', 'openid profile');
    query.set('state', pending.state);
    query.set('nonce', pending.nonce);
    query.set('code_challenge', await codeChallenge(pending.verifier));
    query.set('code_challenge_method', 'S256');
    query.set('resource', options.audience);
    query.set('ui_locales', options.uiLocales?.() ?? 'nb');
    query.set(
      'authorization_details',
      JSON.stringify([{ type: ALTINN_RESOURCE_DETAIL, resource: options.altinnResource }]),
    );
    options.navigate(authorize.toString());
    return new Promise<Session>(() => undefined);
  };

  return {
    current: () => stored() ?? (viaFallback ? options.fallback?.current() : undefined),
    callbackPending: () => completing !== undefined || isCallback(options.location()),
    expiresAt: () => (stored() ? read<StoredSession>(sessionKey)?.expiresAt : undefined),
    refresh: async () => {
      const previous = read<StoredSession>(sessionKey);
      if (!previous?.refreshToken || stored() === undefined) return undefined;
      try {
        const discovery = await discover();
        const response = await options.fetch(endpoint(discovery.token_endpoint), {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/x-www-form-urlencoded',
          },
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: previous.refreshToken,
            client_id: options.clientId,
          }).toString(),
        });
        if (!response.ok) {
          options.storage.setItem(
            sessionKey,
            JSON.stringify({ ...previous, refreshToken: undefined }),
          );
          return undefined;
        }
        const tokens = (await response.json()) as TokenResponse;
        return keep(tokens, tokens.id_token ? decodeJwt(tokens.id_token) : {}, previous);
      } catch {
        return undefined;
      }
    },
    login: async () => {
      if (completing) return completing;
      const url = options.location();
      if (isCallback(url)) {
        completing = complete(url).finally(() => {
          completing = undefined;
        });
        return completing;
      }
      redirecting ??= redirect().finally(() => {
        redirecting = undefined;
      });
      return redirecting;
    },
    logout: async (endSession = false) => {
      const idToken = read<StoredSession>(sessionKey)?.idToken;
      options.storage.removeItem(sessionKey);
      options.storage.removeItem(loginKey);
      completing = undefined;
      if (viaFallback) await options.fallback?.logout?.();
      const signedInHere = !viaFallback;
      viaFallback = false;
      if (!endSession || !signedInHere || !idToken) return;
      const endSessionAt = await discover()
        .then((d) => d.end_session_endpoint)
        .catch(() => undefined);
      if (!endSessionAt) return;
      const url = new URL(endSessionAt);
      url.searchParams.set('id_token_hint', idToken);
      url.searchParams.set(
        'post_logout_redirect_uri',
        new URL('/', options.redirectUri).toString(),
      );
      url.searchParams.set('state', randomString());
      options.navigate(url.toString());
    },
  };
};
