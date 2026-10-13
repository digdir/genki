import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import { importJWK, jwtVerify, SignJWT, type JWK } from 'jose';
import { toOrgNo, type SystemUserDetail } from './claims.js';
import type { SigningKey } from './keys.js';
import { identityTestData, type IdentityTestDataInput } from './testdata.js';

export interface MockMaskinportenOptions {
  issuer: string;
  key: SigningKey;
  testData: IdentityTestDataInput;
  audience: string;
  tokenLifetimeSeconds?: number;
}

const JWT_BEARER = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

export const createMockMaskinporten = (options: MockMaskinportenOptions) => {
  const data = identityTestData.parse(options.testData);
  const lifetime = options.tokenLifetimeSeconds ?? 120;
  const app = new Hono();

  app.get('/.well-known/oauth-authorization-server', (c) =>
    c.json({
      issuer: options.issuer,
      token_endpoint: `${options.issuer}/token`,
      jwks_uri: `${options.issuer}/jwks`,
      grant_types_supported: [JWT_BEARER],
      token_endpoint_auth_signing_alg_values_supported: ['RS256'],
    }),
  );

  app.get('/jwks', (c) => c.json({ keys: [options.key.publicJwk] }));

  app.post('/token', async (c) => {
    const form = await c.req.parseBody();
    if (form.grant_type !== JWT_BEARER || typeof form.assertion !== 'string')
      return c.json({ error: 'unsupported_grant_type' }, 400);
    const unverified = JSON.parse(
      Buffer.from(form.assertion.split('.')[1] ?? '', 'base64url').toString() || '{}',
    ) as {
      iss?: string;
    };
    const client = data.systems.find((s) => s.clientId === unverified.iss);
    if (!client) return c.json({ error: 'invalid_client' }, 400);

    let claims: { scope?: unknown; authorization_details?: unknown };
    try {
      const key = await importJWK(client.publicKey as JWK, 'RS256');
      ({ payload: claims } = await jwtVerify(form.assertion, key, {
        issuer: client.clientId,
        audience: options.issuer,
        maxTokenAge: 120,
      }));
    } catch {
      return c.json(
        { error: 'invalid_grant', error_description: 'assertion could not be verified' },
        400,
      );
    }

    const requested =
      typeof claims.scope === 'string' ? claims.scope.split(' ').filter(Boolean) : [];
    if (requested.length === 0 || !requested.every((s) => client.scopes.includes(s)))
      return c.json({ error: 'invalid_scope' }, 400);
    const wantsSystemUser =
      Array.isArray(claims.authorization_details) &&
      claims.authorization_details.some(
        (d: { type?: string }) => d.type === 'urn:altinn:systemuser',
      );
    if (wantsSystemUser && !client.systemUser)
      return c.json({ error: 'invalid_authorization_details' }, 400);
    const systemUser: SystemUserDetail[] =
      wantsSystemUser && client.systemUser
        ? [
            {
              type: 'urn:altinn:systemuser',
              systemuser_org: toOrgNo(client.systemUser.org),
              systemuser_id: [client.systemUser.id],
              system_id: client.systemUser.systemId,
            },
          ]
        : [];

    const nowSeconds = Math.floor(Date.now() / 1000);
    const accessToken = await new SignJWT({
      client_id: client.clientId,
      scope: requested.join(' '),
      consumer: toOrgNo(client.consumer),
      ...(client.supplier ? { supplier: toOrgNo(client.supplier) } : {}),
      ...(systemUser.length ? { authorization_details: systemUser } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: options.key.kid, typ: 'at+jwt' })
      .setIssuer(options.issuer)
      .setAudience(options.audience)
      .setIssuedAt(nowSeconds)
      .setExpirationTime(nowSeconds + lifetime)
      .setJti(randomUUID())
      .sign(options.key.privateKey);
    return c.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: lifetime,
      scope: requested.join(' '),
    });
  });

  return { app };
};
