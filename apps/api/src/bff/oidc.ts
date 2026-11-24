import { createHash, randomBytes } from 'node:crypto';
import { remoteJwks } from '@genai/identity';
import { decodeJwt, jwtVerify, type JWTPayload, type JWTVerifyGetKey } from 'jose';

export interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  revocation_endpoint?: string;
}

export interface TokenSet {
  accessToken: string;
  accessExpiresAt: number;
  refreshToken?: string;
  idToken?: string;
}

export interface ClientCredentials {
  clientId: string;
  secret: string;
}

export class TokenRefused extends Error {}

const discoveryMs = 10 * 60_000;
const timeoutMs = 10_000;

export const randomValue = () => randomBytes(32).toString('base64url');

export const codeChallenge = (verifier: string) =>
  createHash('sha256').update(verifier).digest('base64url');

/** https, or http only when the issuer itself is http, as the dev-mode mock is. */
const endpointAllowed = (issuer: string, value: unknown): value is string => {
  if (typeof value !== 'string' || !URL.canParse(value)) return false;
  const protocol = new URL(value).protocol;
  return protocol === 'https:' || (protocol === 'http:' && issuer.startsWith('http:'));
};

export const createOidc = (options: { fetch?: typeof fetch; now?: () => number } = {}) => {
  const send = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const discovered = new Map<string, { value: Discovery; until: number }>();
  const keySets = new Map<string, JWTVerifyGetKey>();

  const discover = async (issuer: string): Promise<Discovery> => {
    const cached = discovered.get(issuer);
    if (cached && cached.until > now()) return cached.value;
    const response = await send(`${issuer.replace(/\/$/, '')}/.well-known/openid-configuration`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`discovery answered ${response.status}`);
    const value = (await response.json()) as Partial<Discovery>;
    if (
      value.issuer !== issuer ||
      !endpointAllowed(issuer, value.authorization_endpoint) ||
      !endpointAllowed(issuer, value.token_endpoint) ||
      !endpointAllowed(issuer, value.jwks_uri)
    )
      throw new Error('discovery does not describe the issuer');
    const found: Discovery = {
      issuer,
      authorization_endpoint: value.authorization_endpoint,
      token_endpoint: value.token_endpoint,
      jwks_uri: value.jwks_uri,
      ...(endpointAllowed(issuer, value.end_session_endpoint)
        ? { end_session_endpoint: value.end_session_endpoint }
        : {}),
      ...(endpointAllowed(issuer, value.revocation_endpoint)
        ? { revocation_endpoint: value.revocation_endpoint }
        : {}),
    };
    discovered.set(issuer, { value: found, until: now() + discoveryMs });
    return found;
  };

  const basic = (client: ClientCredentials) =>
    `Basic ${Buffer.from(
      `${encodeURIComponent(client.clientId)}:${encodeURIComponent(client.secret)}`,
    ).toString('base64')}`;

  const post = (endpoint: string, client: ClientCredentials, form: Record<string, string>) =>
    send(endpoint, {
      method: 'POST',
      headers: {
        authorization: basic(client),
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: new URLSearchParams(form).toString(),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });

  /** Refused (4xx) throws `TokenRefused`; any other failure throws a plain error. */
  const token = async (
    discovery: Discovery,
    client: ClientCredentials,
    form: Record<string, string>,
  ): Promise<TokenSet> => {
    const response = await post(discovery.token_endpoint, client, form);
    if (response.status >= 400 && response.status < 500)
      throw new TokenRefused(`token endpoint answered ${response.status}`);
    if (!response.ok) throw new Error(`token endpoint answered ${response.status}`);
    const body = (await response.json()) as Record<string, unknown>;
    if (typeof body.access_token !== 'string') throw new TokenRefused('no access token');
    const exp = (() => {
      try {
        return decodeJwt(body.access_token).exp;
      } catch {
        return undefined;
      }
    })();
    const accessExpiresAt =
      typeof body.expires_in === 'number'
        ? now() + body.expires_in * 1000
        : exp
          ? exp * 1000
          : now() + 60_000;
    return {
      accessToken: body.access_token,
      accessExpiresAt,
      ...(typeof body.refresh_token === 'string' ? { refreshToken: body.refresh_token } : {}),
      ...(typeof body.id_token === 'string' ? { idToken: body.id_token } : {}),
    };
  };

  const revoke = async (discovery: Discovery, client: ClientCredentials, refreshToken: string) => {
    if (!discovery.revocation_endpoint) return false;
    const response = await post(discovery.revocation_endpoint, client, {
      token: refreshToken,
      token_type_hint: 'refresh_token',
    });
    return response.ok;
  };

  const verifyIdToken = async (
    discovery: Discovery,
    idToken: string,
    clientId: string,
    nonce: string,
  ): Promise<JWTPayload> => {
    let keys = keySets.get(discovery.jwks_uri);
    if (!keys) {
      keys = remoteJwks(discovery.jwks_uri, send);
      keySets.set(discovery.jwks_uri, keys);
    }
    const { payload } = await jwtVerify(idToken, keys, {
      issuer: discovery.issuer,
      audience: clientId,
      algorithms: ['RS256'],
      currentDate: new Date(now()),
      clockTolerance: 30,
    });
    if (payload.nonce !== nonce) throw new Error('the id token has another nonce');
    return payload;
  };

  return { discover, token, revoke, verifyIdToken };
};

export type Oidc = ReturnType<typeof createOidc>;
