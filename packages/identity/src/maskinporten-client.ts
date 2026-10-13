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
