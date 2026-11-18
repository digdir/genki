import { translator, type Locale } from './i18n';
import type { SilentAuthorize } from './silent-frame';
import type { OperatorSession } from './types';

export const operatorRole = 'GenAI.Operator';

export interface AuthClient {
  current(): OperatorSession | undefined;
  login(): Promise<OperatorSession>;
  logout(): Promise<void>;
  expire(): void;
  completeLogin?(url: URL): Promise<OperatorSession>;
  expiresAt?(): number | undefined;
  renew?(): Promise<OperatorSession | undefined>;
}

export const mockEntra = (person: { name: string; roles: string[] }, delayMs = 0): AuthClient => {
  let session: OperatorSession | undefined;
  return {
    current: () => session,
    login: async () => {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      session = { ...person, token: 'mock-entra-token' };
      return session;
    },
    logout: async () => {
      session = undefined;
    },
    expire: () => {
      session = undefined;
    },
  };
};

export interface AnsattportenOptions {
  issuer: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  tokenEndpoint: string;
  apiBaseUrl: string;
  audience: string;
  resource: string;
  fetch: typeof fetch;
  storage: Storage;
  navigate: (url: string) => void;
  locale?: () => Locale;
  silent?: SilentAuthorize;
}

export class LoginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LoginError';
  }
}

const pendingKey = 'console.login';
const sessionKey = 'console.session';
const detailType = 'ansattporten:altinn:resource';

interface StoredSession extends OperatorSession {
  expiresAt?: number;
  refreshToken?: string;
  subject?: string;
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
}

interface Pending {
  verifier: string;
  state: string;
  nonce?: string;
}

const visible = ({ name, roles, token, idToken }: StoredSession): OperatorSession => ({
  name,
  roles,
  token,
  ...(idToken ? { idToken } : {}),
});

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

const claimsOf = (jwt: string): Record<string, unknown> => {
  try {
    const part = (jwt.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/');
    const json = new TextDecoder().decode(Uint8Array.from(atob(part), (c) => c.charCodeAt(0)));
    return JSON.parse(json) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const nameOf = (...claims: Record<string, unknown>[]) => {
  for (const key of ['name', 'email'])
    for (const found of claims) if (typeof found[key] === 'string' && found[key]) return found[key];
  return undefined;
};

export const ansattportenLogin = (options: AnsattportenOptions): AuthClient => {
  const say = () => translator(options.locale?.() ?? 'nb');
  const read = <T>(key: string): T | undefined => {
    try {
      const raw = options.storage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : undefined;
    } catch {
      return undefined;
    }
  };
  const write = (key: string, value: unknown) => {
    try {
      options.storage.setItem(key, JSON.stringify(value));
    } catch {
      return;
    }
  };
  const forget = (key: string) => {
    try {
      options.storage.removeItem(key);
    } catch {
      return;
    }
  };

  const endpoints = async () => {
    const fallback: { authorize: string; logout: string; promptValues?: string[] } = {
      authorize: `${options.issuer}/authorize`,
      logout: `${options.issuer}/logout`,
    };
    try {
      const response = await options.fetch(`${options.issuer}/.well-known/openid-configuration`, {
        headers: { accept: 'application/json' },
      });
      if (!response.ok) return fallback;
      const metadata = (await response.json()) as {
        authorization_endpoint?: string;
        end_session_endpoint?: string;
        prompt_values_supported?: string[];
      };
      return {
        authorize: metadata.authorization_endpoint ?? fallback.authorize,
        logout: metadata.end_session_endpoint ?? fallback.logout,
        ...(Array.isArray(metadata.prompt_values_supported)
          ? { promptValues: metadata.prompt_values_supported }
          : {}),
      };
    } catch {
      return fallback;
    }
  };

  const rolesFor = async (token: string) => {
    const response = await options.fetch(`${options.apiBaseUrl}/operator/tenants`, {
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
    });
    if (response.ok) return [operatorRole];
    if (response.status === 403 || response.status === 404) return [];
    throw new LoginError(say()('api.accessCheckFailed'));
  };

  const authorizeUrl = async (pending: Pending, prompt?: 'none') => {
    const found = await endpoints();
    if (prompt && found.promptValues && !found.promptValues.includes(prompt)) return undefined;
    const url = new URL(found.authorize);
    url.search = new URLSearchParams({
      response_type: 'code',
      client_id: options.clientId,
      redirect_uri: options.redirectUri,
      scope: 'openid profile',
      ui_locales: options.locale?.() ?? 'nb',
      state: pending.state,
      ...(pending.nonce ? { nonce: pending.nonce } : {}),
      code_challenge: await codeChallenge(pending.verifier),
      code_challenge_method: 'S256',
      resource: options.audience,
      authorization_details: JSON.stringify([{ type: detailType, resource: options.resource }]),
      ...(prompt ? { prompt } : {}),
    }).toString();
    return url.toString();
  };

  const requestTokens = async (grant: Record<string, string>) => {
    const response = await options.fetch(options.tokenEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...grant, client_id: options.clientId }).toString(),
    });
    if (!response.ok) return undefined;
    const tokens = (await response.json().catch(() => undefined)) as TokenResponse | undefined;
    return tokens?.access_token ? tokens : undefined;
  };

  const exchange = async (url: URL, pending: Pending | undefined) => {
    const params = url.searchParams;
    if (params.get('error')) throw new LoginError(say()('api.loginCancelled'));
    const code = params.get('code');
    if (!pending || !code || params.get('state') !== pending.state)
      throw new LoginError(say()('api.loginIncomplete'));
    if (params.get('iss') && params.get('iss') !== options.issuer)
      throw new LoginError(say()('api.loginWrongIssuer'));
    const tokens = await requestTokens({
      grant_type: 'authorization_code',
      code,
      redirect_uri: options.redirectUri,
      code_verifier: pending.verifier,
    });
    if (!tokens) throw new LoginError(say()('api.loginIncomplete'));
    const claims = claimsOf(tokens.id_token ?? '');
    if (tokens.id_token && (!pending.nonce || claims.nonce !== pending.nonce))
      throw new LoginError(say()('api.loginIncomplete'));
    return { tokens, claims };
  };

  const keep = (
    tokens: TokenResponse,
    claims: Record<string, unknown>,
    roles: string[],
    previous?: StoredSession,
  ) => {
    const access = claimsOf(tokens.access_token);
    const refreshToken = tokens.refresh_token ?? previous?.refreshToken;
    const idToken = tokens.id_token ?? previous?.idToken;
    const subject = typeof access.sub === 'string' ? access.sub : previous?.subject;
    const session: StoredSession = {
      name: nameOf(claims, access) ?? previous?.name ?? say()('api.unknownUser'),
      roles,
      token: tokens.access_token,
      ...(idToken ? { idToken } : {}),
      ...(typeof access.exp === 'number' ? { expiresAt: access.exp * 1000 } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(subject ? { subject } : {}),
    };
    write(sessionKey, session);
    return visible(session);
  };

  const samePerson = (tokens: TokenResponse, previous: StoredSession) => {
    const sub = claimsOf(tokens.access_token).sub;
    return !previous.subject || sub === previous.subject;
  };

  const withRefreshToken = async (previous: StoredSession, refreshToken: string) => {
    const tokens = await requestTokens({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    if (!tokens || !samePerson(tokens, previous)) return undefined;
    return keep(tokens, claimsOf(tokens.id_token ?? ''), previous.roles, previous);
  };

  const withoutPrompt = async (previous: StoredSession) => {
    if (!options.silent) return undefined;
    const pending: Pending = {
      verifier: randomString(),
      state: randomString(),
      nonce: randomString(),
    };
    const url = await authorizeUrl(pending, 'none');
    if (!url) return undefined;
    const back = await options.silent(url);
    if (!back) return undefined;
    const { tokens, claims } = await exchange(back, pending);
    if (!samePerson(tokens, previous)) return undefined;
    return keep(tokens, claims, previous.roles, previous);
  };

  const renewOnce = async () => {
    const previous = read<StoredSession>(sessionKey);
    if (!previous) return undefined;
    try {
      if (previous.refreshToken) {
        const renewed = await withRefreshToken(previous, previous.refreshToken);
        if (renewed) return renewed;
        delete previous.refreshToken;
        write(sessionKey, previous);
      }
      return await withoutPrompt(previous);
    } catch {
      return undefined;
    }
  };

  let renewing: Promise<OperatorSession | undefined> | undefined;

  return {
    current: () => {
      const session = read<StoredSession>(sessionKey);
      return session ? visible(session) : undefined;
    },
    expiresAt: () => read<StoredSession>(sessionKey)?.expiresAt,
    renew: () =>
      (renewing ??= renewOnce().finally(() => {
        renewing = undefined;
      })),
    login: async () => {
      const pending: Pending = {
        verifier: randomString(),
        state: randomString(),
        nonce: randomString(),
      };
      write(pendingKey, pending);
      options.navigate((await authorizeUrl(pending)) ?? '');
      return new Promise<OperatorSession>(() => undefined);
    },
    completeLogin: async (url: URL) => {
      const pending = read<Pending>(pendingKey);
      forget(pendingKey);
      const { tokens, claims } = await exchange(url, pending);
      return keep(tokens, claims, await rolesFor(tokens.access_token));
    },
    logout: async () => {
      const session = read<StoredSession>(sessionKey);
      forget(sessionKey);
      forget(pendingKey);
      const url = new URL((await endpoints()).logout);
      url.search = new URLSearchParams({
        client_id: options.clientId,
        post_logout_redirect_uri: options.postLogoutRedirectUri,
        ...(session?.idToken ? { id_token_hint: session.idToken } : {}),
      }).toString();
      options.navigate(url.toString());
    },
    expire: () => forget(sessionKey),
  };
};
