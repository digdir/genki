/** Browser login with the authorization code flow and PKCE (ADR 0034); the BFF replaces this module. */
export interface Session {
  name: string;
  token: string;
}

export interface Login {
  current(): Session | undefined;
  isCallback(): boolean;
  start(): Promise<void>;
  /** Finishes a login on the callback address and answers the path to go back to. */
  complete(): Promise<{ session: Session; returnTo: string }>;
  signOut(): Promise<void>;
}

export interface HostLogin {
  issuer: string;
  clientId: string;
  audience: string;
  altinnResource: string | null;
}

type KeyValueStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

export interface BrowserLoginOptions extends HostLogin {
  fetch: typeof fetch;
  storage: KeyValueStore;
  location: () => URL;
  navigate: (url: string) => void;
  /** Where the browser fetches an issuer address, such as through a local proxy. */
  endpoint?: (url: string) => string;
  now?: () => number;
  uiLocales?: () => string;
}

export const callbackPath = '/auth/callback';

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

interface Pending {
  state: string;
  verifier: string;
  nonce: string;
  returnTo: string;
}

interface Stored extends Session {
  expiresAt?: number;
  idToken?: string;
}

export class LoginError extends Error {
  override name = 'LoginError';
}

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const codeChallenge = async (verifier: string) =>
  base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );

export const decodeJwt = (token: string): Record<string, unknown> => {
  const part = token.split('.')[1] ?? '';
  const binary = atob(part.replaceAll('-', '+').replaceAll('_', '/'));
  return JSON.parse(
    new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0))),
  ) as Record<string, unknown>;
};

/** A same-origin path, or `/`: never another host, `//host` or a scheme. */
export const samePath = (path: string | undefined) =>
  path && /^\/(?![/\\])/.test(path) && path !== callbackPath ? path : '/';

const text = (value: unknown) => (typeof value === 'string' && value ? value : undefined);

const nameOf = (claims: Record<string, unknown>) =>
  text(claims.name) ??
  ([text(claims.given_name), text(claims.family_name)].filter(Boolean).join(' ') ||
    text(claims.email) ||
    '');

export const browserLogin = (options: BrowserLoginOptions): Login => {
  const sessionKey = `assistant.${options.clientId}.session`;
  const pendingKey = `assistant.${options.clientId}.login`;
  const now = options.now ?? (() => Date.now());
  const endpoint = options.endpoint ?? ((url: string) => url);
  const redirectUri = () => new URL(callbackPath, options.location()).toString();

  const read = <T>(key: string): T | undefined => {
    try {
      return JSON.parse(options.storage.getItem(key) ?? 'null') ?? undefined;
    } catch {
      return undefined;
    }
  };

  const discover = async () => {
    const response = await options.fetch(
      endpoint(`${options.issuer}/.well-known/openid-configuration`),
      { headers: { accept: 'application/json' } },
    );
    if (!response.ok) throw new LoginError(`discovery answered ${response.status}`);
    const found = (await response.json()) as Discovery;
    if (found.issuer !== options.issuer) throw new LoginError('discovery names another issuer');
    return found;
  };

  const stored = () => {
    const session = read<Stored>(sessionKey);
    if (!session) return undefined;
    if (session.expiresAt !== undefined && session.expiresAt <= now()) {
      options.storage.removeItem(sessionKey);
      return undefined;
    }
    return session;
  };

  const finish = async () => {
    const params = options.location().searchParams;
    const pending = read<Pending>(pendingKey);
    options.storage.removeItem(pendingKey);
    if (params.get('error'))
      throw new LoginError(params.get('error_description') ?? params.get('error') ?? 'login');
    if (!pending || !params.get('state') || params.get('state') !== pending.state)
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
        redirect_uri: redirectUri(),
        client_id: options.clientId,
        code_verifier: pending.verifier,
      }).toString(),
    });
    if (!response.ok) throw new LoginError(`token exchange answered ${response.status}`);
    const tokens = (await response.json()) as { access_token: string; id_token?: string };
    const id = tokens.id_token ? decodeJwt(tokens.id_token) : {};
    if (tokens.id_token && id.nonce !== pending.nonce) throw new LoginError('nonce does not match');
    const access = decodeJwt(tokens.access_token);
    const session: Stored = {
      name: nameOf(id) || nameOf(access),
      token: tokens.access_token,
      ...(typeof access.exp === 'number' ? { expiresAt: access.exp * 1000 } : {}),
      ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    };
    options.storage.setItem(sessionKey, JSON.stringify(session));
    return { session: { name: session.name, token: session.token }, returnTo: pending.returnTo };
  };
  let completing: ReturnType<typeof finish> | undefined;

  return {
    current: () => {
      const session = stored();
      return session && { name: session.name, token: session.token };
    },
    isCallback: () => options.location().pathname === callbackPath,
    start: async () => {
      const discovery = await discover();
      const location = options.location();
      const pending: Pending = {
        state: randomString(),
        verifier: randomString(),
        nonce: randomString(),
        returnTo: samePath(`${location.pathname}${location.search}`),
      };
      options.storage.setItem(pendingKey, JSON.stringify(pending));
      const authorize = new URL(discovery.authorization_endpoint);
      const query = authorize.searchParams;
      query.set('response_type', 'code');
      query.set('client_id', options.clientId);
      query.set('redirect_uri', redirectUri());
      query.set('scope', 'openid profile');
      query.set('state', pending.state);
      query.set('nonce', pending.nonce);
      query.set('code_challenge', await codeChallenge(pending.verifier));
      query.set('code_challenge_method', 'S256');
      query.set('resource', options.audience);
      query.set('ui_locales', options.uiLocales?.() ?? 'nb');
      if (options.altinnResource)
        query.set(
          'authorization_details',
          JSON.stringify([
            { type: 'ansattporten:altinn:resource', resource: options.altinnResource },
          ]),
        );
      options.navigate(authorize.toString());
    },
    complete: () => (completing ??= finish()),
    signOut: async () => {
      const idToken = read<Stored>(sessionKey)?.idToken;
      options.storage.removeItem(sessionKey);
      options.storage.removeItem(pendingKey);
      if (!idToken) return;
      const endSession = await discover()
        .then((d) => d.end_session_endpoint)
        .catch(() => undefined);
      if (!endSession) return;
      const url = new URL(endSession);
      url.searchParams.set('id_token_hint', idToken);
      url.searchParams.set('post_logout_redirect_uri', new URL('/', options.location()).toString());
      url.searchParams.set('state', randomString());
      options.navigate(url.toString());
    },
  };
};
