import { createLocalJWKSet, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createSigningKey,
  createTokenVerifier,
  type RegisteredClient,
  type SigningKey,
} from './index.js';

const ISSUER = 'https://test.ansattporten.example';
const AUDIENCE = 'digdir:genai';
const RESOURCE = 'urn:altinn:resource:digdir-genai-platform-test';
const DIGDIR = '991825827';

let key: SigningKey;

beforeAll(async () => {
  key = await createSigningKey('test-employee-clients');
});

const sign = (claims: Record<string, unknown>, audience: string | string[] = AUDIENCE) =>
  new SignJWT({
    acr: 'idporten-loa-substantial',
    authorization_details: [
      {
        type: 'ansattporten:altinn:resource',
        resource: RESOURCE,
        authorized_parties: [
          { orgno: { authority: 'iso6523-actorid-upis', ID: `0192:${DIGDIR}` }, name: 'Digdir' },
        ],
      },
    ],
    ...claims,
  })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(audience)
    .setSubject('employee-subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);

const kaClient: RegisteredClient = {
  clientId: 'ka-web-client',
  audience: 'ka-web-client',
  tenant: DIGDIR,
  service: 'kunnskapsassistenten',
  client: 'ka-web',
};

const verifier = (trustedClients: readonly string[] = ['genki-portal', 'genki-console']) =>
  createTokenVerifier({
    issuers: [
      {
        kind: 'ansattporten',
        issuer: ISSUER,
        audience: AUDIENCE,
        keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        trustedClients,
        registeredClients: {
          byClientId: async (id) => (id === kaClient.clientId ? kaClient : undefined),
        },
      },
    ],
  });

describe('which clients an employee login may come through', () => {
  it('refuses an Ansattporten employee token from a client that is neither registered nor trusted', async () => {
    const token = await sign({ client_id: 'some-other-client' });
    await expect(verifier().verify(token)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('accepts an employee token from a trusted client', async () => {
    const token = await sign({ client_id: 'genki-console' });
    const { principal } = await verifier().verify(token);
    expect(principal).toMatchObject({ kind: 'employee', client: 'genki-console', tenant: DIGDIR });
    expect(principal.confinedTo).toBeUndefined();
  });

  it('refuses an employee token without client_id', async () => {
    const token = await sign({});
    await expect(verifier().verify(token)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('refuses an employee token whose client_id is an array', async () => {
    const token = await sign({ client_id: ['genki-console'] });
    await expect(verifier().verify(token)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('refuses an employee token whose client_id is a number', async () => {
    const token = await sign({ client_id: 42 });
    await expect(verifier().verify(token)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('refuses every employee login when no client is trusted', async () => {
    const token = await sign({ client_id: 'genki-console' });
    await expect(verifier([]).verify(token)).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('a tenant-registered client is still accepted and still confined', async () => {
    const token = await sign({ client_id: kaClient.clientId }, [kaClient.audience, AUDIENCE]);
    const { principal } = await verifier().verify(token);
    expect(principal).toMatchObject({
      client: kaClient.clientId,
      confinedTo: { tenant: DIGDIR, service: 'kunnskapsassistenten', client: 'ka-web' },
    });
  });
});
