import { translator, type Locale } from './i18n';
import type { OperatorSession } from './types';

export const operatorRole = 'GenAI.Operator';

export interface AuthClient {
  current(): OperatorSession | undefined;
  login(): Promise<OperatorSession>;
  logout(): Promise<void>;
  expire(): void;
  completeLogin?(url: URL): Promise<OperatorSession>;
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

export const isEntraLogin = (token: string) => claimsOf(token).acr === 'entraid';

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
    const fallback = {
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
      };
      return {
        authorize: metadata.authorization_endpoint ?? fallback.authorize,
        logout: metadata.end_session_endpoint ?? fallback.logout,
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

  return {
    current: () => read<OperatorSession>(sessionKey),
    login: async () => {
      const verifier = randomString();
      const state = randomString();
      const nonce = randomString();
      write(pendingKey, { verifier, state, nonce });
      const url = new URL((await endpoints()).authorize);
      url.search = new URLSearchParams({
        response_type: 'code',
        client_id: options.clientId,
        redirect_uri: options.redirectUri,
        scope: 'openid profile',
        ui_locales: options.locale?.() ?? 'nb',
        state,
        nonce,
        code_challenge: await codeChallenge(verifier),
        code_challenge_method: 'S256',
        resource: options.audience,
        authorization_details: JSON.stringify([{ type: detailType, resource: options.resource }]),
      }).toString();
      options.navigate(url.toString());
      return new Promise<OperatorSession>(() => undefined);
    },
    completeLogin: async (url: URL) => {
      const pending = read<{ verifier: string; state: string }>(pendingKey);
      forget(pendingKey);
      const params = url.searchParams;
      if (params.get('error')) throw new LoginError(say()('api.loginCancelled'));
      const code = params.get('code');
      if (!pending || !code || params.get('state') !== pending.state)
        throw new LoginError(say()('api.loginIncomplete'));
      if (params.get('iss') && params.get('iss') !== options.issuer)
        throw new LoginError(say()('api.loginWrongIssuer'));
      const response = await options.fetch(options.tokenEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: options.redirectUri,
          client_id: options.clientId,
          code_verifier: pending.verifier,
        }).toString(),
      });
      if (!response.ok) throw new LoginError(say()('api.loginIncomplete'));
      const tokens = (await response.json()) as { access_token: string; id_token?: string };
      const claims = claimsOf(tokens.id_token ?? '');
      const session: OperatorSession = {
        name: nameOf(claims, claimsOf(tokens.access_token)) ?? say()('api.unknownUser'),
        roles: await rolesFor(tokens.access_token),
        token: tokens.access_token,
        ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
      };
      write(sessionKey, session);
      return session;
    },
    logout: async () => {
      const session = read<OperatorSession>(sessionKey);
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
