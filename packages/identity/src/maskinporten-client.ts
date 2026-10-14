import { randomUUID } from 'node:crypto';
import { importJWK, SignJWT, type JWK } from 'jose';

export interface MaskinportenClientOptions {
  issuer: string;
  tokenEndpoint?: string;
  clientId: string;
  scope: string;
  privateKey: JWK;
  fetch?: typeof fetch;
  now?: () => number;
}

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

export const maskinportenTokens = (options: MaskinportenClientOptions) => {
  const now = options.now ?? Date.now;
  const endpoint = options.tokenEndpoint ?? new URL('token', options.issuer).toString();
  let cached: { token: string; until: number } | undefined;

  const grant = async () => {
    const key = await importJWK(options.privateKey, options.privateKey.alg ?? 'RS256');
    const issuedAt = Math.floor(Date.now() / 1000);
    return new SignJWT({ scope: options.scope })
      .setProtectedHeader({
        alg: options.privateKey.alg ?? 'RS256',
        ...(options.privateKey.kid ? { kid: options.privateKey.kid } : {}),
      })
      .setIssuer(options.clientId)
      .setAudience(options.issuer)
      .setIssuedAt(issuedAt)
      .setExpirationTime(issuedAt + 120)
      .setJti(randomUUID())
      .sign(key);
  };

  return {
    token: async (): Promise<string> => {
      if (cached && cached.until > now()) return cached.token;
      const response = await (options.fetch ?? fetch)(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: JWT_BEARER, assertion: await grant() }),
      });
      if (!response.ok) throw new Error(`Maskinporten answered ${response.status}`);
      const body = (await response.json()) as { access_token?: string; expires_in?: number };
      if (!body.access_token) throw new Error('Maskinporten sent no access token');
      const lifetime = Math.max(0, (body.expires_in ?? 60) - 30);
      cached = { token: body.access_token, until: now() + lifetime * 1000 };
      return body.access_token;
    },
  };
};

export interface AltinnTokenOptions {
  baseURL: string;
  maskinporten: { token(): Promise<string> };
  fetch?: typeof fetch;
  now?: () => number;
}

const expiryOf = (token: string): number | undefined => {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString()) as {
      exp?: unknown;
    };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};

export const altinnTokens = (options: AltinnTokenOptions) => {
  const now = options.now ?? Date.now;
  const endpoint = new URL(
    'authentication/api/v1/exchange/maskinporten',
    options.baseURL.endsWith('/') ? options.baseURL : `${options.baseURL}/`,
  ).toString();
  let cached: { token: string; until: number } | undefined;

  return {
    token: async (): Promise<string> => {
      if (cached && cached.until > now()) return cached.token;
      const response = await (options.fetch ?? fetch)(endpoint, {
        headers: { authorization: `Bearer ${await options.maskinporten.token()}` },
      });
      if (!response.ok) throw new Error(`Altinn token exchange answered ${response.status}`);
      const token = (await response.text()).trim().replace(/^"|"$/g, '');
      if (!token) throw new Error('Altinn token exchange sent no token');
      cached = { token, until: (expiryOf(token) ?? now() + 60_000) - 30_000 };
      return token;
    },
  };
};
