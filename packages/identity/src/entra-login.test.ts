import { createLocalJWKSet, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  altinnPolicy,
  createSigningKey,
  createTokenVerifier,
  PLATFORM_RIGHTS,
  platformRightsOf,
  trustedEntraScope,
  withAltinnActions,
  type AltinnAuthorization,
  type SigningKey,
  type TrustedEntra,
} from './index.js';

const ISSUER = 'https://test.ansattporten.example';
const AUDIENCE = 'digdir:genai';
const RESOURCE = 'urn:altinn:resource:digdir-genai-platform-test';
const PLATFORM = '312521172';
const TRUSTED_GROUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER_GROUP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

let key: SigningKey;

beforeAll(async () => {
  key = await createSigningKey('test-entra');
});

const entraClaims = (overrides: Record<string, unknown> = {}) => ({
  acr: 'entraid',
  client_amr: 'private_key_jwt',
  client_id: 'genki-test-portal',
  groups: [OTHER_GROUP, TRUSTED_GROUP],
  sik: 'fake-sik',
  scope: 'openid profile',
  consumer: { authority: 'iso6523-actorid-upis', ID: '0192:999999999' },
  email: 'Kari.Tester@Digdir.example',
  ...overrides,
});

const sign = (claims: Record<string, unknown>) =>
  new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(ISSUER)
    .setAudience(['genki-test-portal', AUDIENCE])
    .setSubject('entra-subject-1')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(key.privateKey);

const trusted: TrustedEntra = {
  groups: [TRUSTED_GROUP],
  emailDomain: 'digdir.example',
  tenant: PLATFORM,
  resource: RESOURCE,
};

const verifier = (trustedEntra: TrustedEntra | null = trusted) =>
  createTokenVerifier({
    issuers: [
      {
        kind: 'ansattporten',
        issuer: ISSUER,
        audience: AUDIENCE,
        keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        ...(trustedEntra ? { trustedEntra } : {}),
      },
    ],
  });

describe('Entra logins through Ansattporten in lockdown', () => {
  it('gives a trusted Entra login every platform right in the platform organisation in lockdown', async () => {
    const { principal, personId } = await verifier().verify(await sign(entraClaims()));

    expect(principal).toMatchObject({
      kind: 'employee',
      subject: 'entra-subject-1',
      assurance: 'entraid',
      tenant: PLATFORM,
      authorizedFor: [{ org: PLATFORM, resource: RESOURCE, actions: [...PLATFORM_RIGHTS] }],
      scopes: [trustedEntraScope],
    });
    expect(personId).toBeUndefined();
    expect(platformRightsOf(principal, PLATFORM, RESOURCE)).toEqual([...PLATFORM_RIGHTS]);
    expect(platformRightsOf(principal, '999999999', RESOURCE)).toEqual([]);
  });

  it('matches group ids without regard to case', async () => {
    const token = await sign(entraClaims({ groups: [TRUSTED_GROUP.toUpperCase()] }));

    await expect(verifier().verify(token)).resolves.toBeDefined();
  });

  it('refuses an Entra login outside the configured groups', async () => {
    const token = await sign(entraClaims({ groups: [OTHER_GROUP] }));

    await expect(verifier().verify(token)).rejects.toMatchObject({ code: 'entra_not_trusted' });
  });

  it('refuses an Entra login whose email is outside the configured domain', async () => {
    const cases = [
      entraClaims({ email: 'kari@example.com' }),
      entraClaims({ email: 'kari@digdir.example.evil.example' }),
      entraClaims({ email: undefined }),
    ];

    for (const claims of cases)
      await expect(verifier().verify(await sign(claims))).rejects.toMatchObject({
        code: 'entra_not_trusted',
      });
  });

  it('trusts the groups alone when no email domain is configured', async () => {
    const groupsOnly: TrustedEntra = {
      groups: trusted.groups,
      tenant: PLATFORM,
      resource: RESOURCE,
    };
    const token = await sign(entraClaims({ email: 'kari@example.com' }));

    expect((await verifier(groupsOnly).verify(token)).principal.tenant).toBe(PLATFORM);
  });

  it('refuses Entra logins when lockdown is off', async () => {
    await expect(verifier(null).verify(await sign(entraClaims()))).rejects.toMatchObject({
      code: 'insufficient_assurance',
    });
  });

  it('does not trust a model scope an Entra token brings itself', async () => {
    const scope = `openid profile ${trustedEntraScope} grant:configured-credential`;
    const outside = await sign(entraClaims({ groups: [OTHER_GROUP], scope }));
    const testId = await sign({ acr: 'idporten-loa-substantial', pid: '01017012345', scope });

    await expect(verifier().verify(outside)).rejects.toMatchObject({ code: 'entra_not_trusted' });
    expect((await verifier().verify(testId)).principal.scopes).toBeUndefined();
  });

  it('keeps the rights of a trusted Entra login when Altinn actions are looked up', async () => {
    const lookups: string[] = [];
    const withActions = withAltinnActions(verifier(), {
      resource: RESOURCE,
      lookup: async (personId) => {
        lookups.push(personId);
        return [];
      },
    });

    const { principal } = await withActions.verify(await sign(entraClaims()));

    expect(lookups).toEqual([]);
    expect(principal.authorizedFor?.[0]?.actions).toEqual([...PLATFORM_RIGHTS]);
  });

  it('lets a trusted Entra login invoke services in the platform organisation without a pid', async () => {
    const asked: unknown[] = [];
    const altinn: AltinnAuthorization = {
      decide: async (request) => {
        asked.push(request);
        return 'Deny';
      },
    };
    const policy = altinnPolicy({
      altinn,
      identities: { personId: async () => undefined },
      requirementFor: () => ({ resource: RESOURCE, action: 'use-services', scope: 'legacy:query' }),
    });
    const { principal } = await verifier().verify(await sign(entraClaims()));
    const service = { kind: 'capability' as const, id: `${PLATFORM}/klarsprak` };

    expect(await policy.decide(principal, 'invoke', service)).toEqual({ allow: true });
    expect(
      (await policy.decide({ ...principal, tenant: '999999999' }, 'invoke', service)).allow,
    ).toBe(false);
    expect(asked).toEqual([]);
  });
});
