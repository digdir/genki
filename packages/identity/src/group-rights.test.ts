import { createLocalJWKSet, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createSigningKey,
  createTokenVerifier,
  memberEntraScope,
  PLATFORM_RIGHTS,
  platformRightsOf,
  serviceEntraScope,
  trustedEntraScope,
  type ClientRegistry,
  type SigningKey,
  type TrustedEntra,
} from './index.js';

const ISSUER = 'https://ansattporten.no';
const AUDIENCE = 'digdir:genai';
const RESOURCE = 'urn:altinn:resource:digdir-genai-platform';
const DIGDIR = '991825827';
const OTHER_ORG = '889640782';
const LOGIN_CLIENT = 'c0e4a5af-b2e1-4bba-9324-4caf55be8db5';
const KA_BACKEND = '797debdd-0000-4000-8000-000000000000';
const OPERATORS = '76d10637-d517-413c-a10b-84675a3ed64b';
const MEMBERS = '789b5488-39ec-47b3-9217-840e5cd957fd';
const EMPLOYEES = '30a76637-d1ff-4040-bc1f-fb9b8ccd749c';
const UNRELATED = Array.from(
  { length: 30 },
  (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
);

let key: SigningKey;

beforeAll(async () => {
  key = await createSigningKey('production-ansattporten');
});

const productionClaims = (groups: string[], overrides: Record<string, unknown> = {}) => ({
  acr: 'entraid',
  amr: ['entraid', 'entraid-mfa'],
  client_id: LOGIN_CLIENT,
  consumer: { authority: 'iso6523-actorid-upis', ID: `0192:${DIGDIR}` },
  email: 'kari.nordmann@digdir.no',
  given_name: 'Kari',
  family_name: 'Nordmann',
  groups: [...UNRELATED, ...groups],
  ...overrides,
});

const sign = (claims: Record<string, unknown>, audience: string | null = AUDIENCE) => {
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(ISSUER)
    .setSubject('pairwise-subject')
    .setIssuedAt()
    .setExpirationTime('2m');
  return (audience ? jwt.setAudience(audience) : jwt).sign(key.privateKey);
};

const groupRules: TrustedEntra = {
  groups: [OPERATORS],
  userGroups: [MEMBERS],
  serviceGroups: [EMPLOYEES],
  serviceClientIds: [KA_BACKEND],
  clientIds: [],
  emailDomain: 'digdir.no',
  tenant: DIGDIR,
  resource: RESOURCE,
};

const kaRegistered: ClientRegistry = {
  byClientId: async (clientId) =>
    clientId === KA_BACKEND
      ? {
          clientId,
          audience: AUDIENCE,
          tenant: DIGDIR,
          service: 'kunnskapsassistent',
          client: 'ka-backend',
        }
      : undefined,
};

const verifier = (entraOnly = true) =>
  createTokenVerifier({
    issuers: [
      {
        kind: 'ansattporten',
        issuer: ISSUER,
        audience: AUDIENCE,
        keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        trustedEntra: groupRules,
        entraOnly,
        registeredClients: kaRegistered,
        platformLoginClients: [LOGIN_CLIENT],
        platformLoginKey: new Uint8Array(32),
        platformAppSession: () => true,
      },
    ],
  });

const verify = async (claims: Record<string, unknown>, entraOnly = true) =>
  verifier(entraOnly).verify(await sign(claims));

describe('rights from Entra groups on production Ansattporten', () => {
  it('a member of genki-users gets every platform right in Digdir', async () => {
    const { principal } = await verify(productionClaims([MEMBERS, EMPLOYEES]));

    expect(principal).toMatchObject({
      kind: 'employee',
      tenant: DIGDIR,
      authorizedFor: [{ org: DIGDIR, resource: RESOURCE, actions: [...PLATFORM_RIGHTS] }],
      scopes: [memberEntraScope],
    });
    expect(platformRightsOf(principal, DIGDIR, RESOURCE)).toEqual([...PLATFORM_RIGHTS]);
  });

  it('a production login has no pid and needs none', async () => {
    const verified = await verify(productionClaims([MEMBERS]));

    expect(verified.personId).toBeUndefined();
    expect(verified.principal.subject).toBe('pairwise-subject');
  });

  it('an access token without aud is refused, so the login must ask for the API audience as resource', async () => {
    await expect(
      verifier().verify(await sign(productionClaims([OPERATORS]), null)),
    ).rejects.toMatchObject({ code: 'invalid_token' });
  });

  it('a member of the operator group is a trusted Entra login, which the API makes an operator', async () => {
    const { principal } = await verify(productionClaims([OPERATORS, MEMBERS]));

    expect(principal.scopes).toEqual([trustedEntraScope]);
    expect(platformRightsOf(principal, DIGDIR, RESOURCE)).toEqual([...PLATFORM_RIGHTS]);
  });

  it('a login in neither group is refused', async () => {
    await expect(verify(productionClaims([EMPLOYEES]))).rejects.toMatchObject({
      code: 'entra_not_trusted',
    });
    await expect(verify(productionClaims([]))).rejects.toMatchObject({
      code: 'entra_not_trusted',
    });
  });

  it('a groups claim from a login that is not entraid is ignored', async () => {
    const idPorten = productionClaims([OPERATORS, MEMBERS], {
      acr: 'idporten-loa-substantial',
      amr: ['TestID'],
      pid: '01017012345',
    });

    await expect(verify(idPorten)).rejects.toMatchObject({ code: 'entra_not_trusted' });
    const withAltinn = await verify(idPorten, false);
    expect(withAltinn.principal.scopes).toBeUndefined();
    expect(withAltinn.principal.authorizedFor).toEqual([]);
  });

  it('a group member gets nothing in another organisation', async () => {
    const { principal } = await verify(productionClaims([MEMBERS]));

    expect(principal.authorizedFor?.map((a) => a.org)).toEqual([DIGDIR]);
    expect(platformRightsOf(principal, OTHER_ORG, RESOURCE)).toEqual([]);
  });

  it('a member with an email outside digdir.no is refused', async () => {
    await expect(
      verify(productionClaims([MEMBERS], { email: 'kari@example.com' })),
    ).rejects.toMatchObject({ code: 'entra_not_trusted' });
  });

  it("KA's backend client still admits an employee to use its service only", async () => {
    const { principal } = await verify(productionClaims([EMPLOYEES], { client_id: KA_BACKEND }));

    expect(principal).toMatchObject({
      authorizedFor: [{ org: DIGDIR, resource: RESOURCE, actions: ['use-services'] }],
      scopes: [serviceEntraScope],
      confinedTo: { tenant: DIGDIR, service: 'kunnskapsassistent', client: 'ka-backend' },
    });
  });
});
