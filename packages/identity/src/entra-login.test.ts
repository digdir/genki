import { createLocalJWKSet, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  altinnPolicy,
  createSigningKey,
  createTokenVerifier,
  lockdownServiceScope,
  lockdownUserScope,
  PLATFORM_RIGHTS,
  platformRightsOf,
  trustedEntraScope,
  withAltinnActions,
  type AltinnAuthorization,
  type ClientRegistry,
  type SigningKey,
  type TrustedEntra,
} from './index.js';

const ISSUER = 'https://test.ansattporten.example';
const AUDIENCE = 'digdir:genai';
const RESOURCE = 'urn:altinn:resource:digdir-genai-platform-test';
const PLATFORM = '312521172';
const TRUSTED_GROUP = '0f0e0d0c-0b0a-4908-8706-050403020100';
const OTHER_GROUP = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const USER_GROUP = '11111111-2222-4333-8444-555555555555';
const SERVICE_GROUP = '2a2b2c2d-3e3f-4a4b-8c8d-9e9f0a0b0c0d';

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
  clientIds: ['genki-test-portal', 'genki-test-console'],
  emailDomain: 'digdir.example',
  tenant: PLATFORM,
  resource: RESOURCE,
};

const verifier = (
  trustedEntra: TrustedEntra | null = trusted,
  registeredClients?: ClientRegistry,
) =>
  createTokenVerifier({
    issuers: [
      {
        kind: 'ansattporten',
        issuer: ISSUER,
        audience: AUDIENCE,
        keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        ...(trustedEntra ? { trustedEntra } : {}),
        ...(registeredClients ? { registeredClients } : {}),
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

  it('names a trusted Entra login by its name claim, or by its email when the token has none', async () => {
    const named = await verifier().verify(await sign(entraClaims({ name: 'Kari Tester' })));
    const unnamed = await verifier().verify(await sign(entraClaims()));

    expect(named.principal.name).toBe('Kari Tester');
    expect(unnamed.principal.name).toBe('Kari.Tester@Digdir.example');
  });

  it('keeps the email claim of a trusted Entra login, in lower case', async () => {
    const { principal } = await verifier().verify(await sign(entraClaims()));

    expect(principal.email).toBe('kari.tester@digdir.example');
  });

  it('matches group ids without regard to case', async () => {
    const token = await sign(entraClaims({ groups: [TRUSTED_GROUP.toUpperCase()] }));

    await expect(verifier().verify(token)).resolves.toBeDefined();
  });

  it('an Entra login from a client not in the allowlist gets no operator mark and no lockdown access', async () => {
    const cases = [
      entraClaims({ client_id: 'some-other-ansattporten-client' }),
      entraClaims({ client_id: undefined }),
    ];

    for (const claims of cases)
      await expect(verifier().verify(await sign(claims))).rejects.toMatchObject({
        code: 'entra_not_trusted',
      });
  });

  it('lets a trusted Entra login in through a registered tenant client, confined to that client', async () => {
    const registered: ClientRegistry = {
      byClientId: async (clientId) =>
        clientId === 'genki-test-portal'
          ? {
              clientId,
              audience: 'genki-test-portal',
              tenant: PLATFORM,
              service: 'klarsprak',
              client: 'tenant-app',
            }
          : undefined,
    };

    const identity = await verifier(trusted, registered).verify(await sign(entraClaims()));
    expect(identity.principal.confinedTo).toEqual({
      tenant: PLATFORM,
      service: 'klarsprak',
      client: 'tenant-app',
    });
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
      clientIds: trusted.clientIds,
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

describe('user groups in lockdown', () => {
  const withUsers: TrustedEntra = { ...trusted, userGroups: [USER_GROUP] };
  const userClaims = (overrides: Record<string, unknown> = {}) =>
    entraClaims({ groups: [OTHER_GROUP, USER_GROUP], ...overrides });

  it('gives a user-group login every platform right in the platform organisation, with the lockdown-user scope and not the trusted one', async () => {
    const { principal } = await verifier(withUsers).verify(await sign(userClaims()));

    expect(principal).toMatchObject({
      kind: 'employee',
      assurance: 'entraid',
      tenant: PLATFORM,
      authorizedFor: [{ org: PLATFORM, resource: RESOURCE, actions: [...PLATFORM_RIGHTS] }],
      scopes: [lockdownUserScope],
    });
    expect(platformRightsOf(principal, PLATFORM, RESOURCE)).toEqual([...PLATFORM_RIGHTS]);
  });

  it('a login in both settings is a trusted Entra login', async () => {
    const token = await sign(entraClaims({ groups: [USER_GROUP, TRUSTED_GROUP] }));

    const { principal } = await verifier(withUsers).verify(token);

    expect(principal.scopes).toEqual([trustedEntraScope]);
    expect(principal.authorizedFor?.[0]?.actions).toEqual([...PLATFORM_RIGHTS]);
  });

  it('trusts user groups when no operator groups are configured', async () => {
    const usersOnly: TrustedEntra = { ...withUsers, groups: [] };

    const { principal } = await verifier(usersOnly).verify(await sign(userClaims()));

    expect(principal.scopes).toEqual([lockdownUserScope]);
  });

  it('refuses a user-group login from a client outside the allowlist, with the wrong email or through a registered tenant client', async () => {
    const registered: ClientRegistry = {
      byClientId: async (clientId) =>
        clientId === 'genki-test-portal'
          ? {
              clientId,
              audience: 'genki-test-portal',
              tenant: PLATFORM,
              service: 'klarsprak',
              client: 'tenant-app',
            }
          : undefined,
    };
    const cases = [
      { claims: userClaims({ client_id: 'some-other-client' }) },
      { claims: userClaims({ email: 'kari@example.com' }) },
      { claims: userClaims(), registered },
    ];

    for (const { claims, registered: clients } of cases)
      await expect(verifier(withUsers, clients).verify(await sign(claims))).rejects.toMatchObject({
        code: 'entra_not_trusted',
      });
  });

  it('still refuses an Entra login in neither group', async () => {
    const token = await sign(entraClaims({ groups: [OTHER_GROUP] }));

    await expect(verifier(withUsers).verify(token)).rejects.toMatchObject({
      code: 'entra_not_trusted',
    });
  });

  it('ignores a lockdown-user scope the caller supplies', async () => {
    const scope = `openid profile ${lockdownUserScope}`;
    const testId = await sign({ acr: 'idporten-loa-substantial', pid: '01017012345', scope });
    const outside = await sign(entraClaims({ groups: [OTHER_GROUP], scope }));
    const machine = await new SignJWT({
      scope: `legacy:query ${lockdownUserScope}`,
      client_id: 'mp-client',
      consumer: { authority: 'iso6523-actorid-upis', ID: `0192:${PLATFORM}` },
    })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer('https://test.maskinporten.example')
      .setAudience(AUDIENCE)
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(key.privateKey);
    const maskinporten = createTokenVerifier({
      issuers: [
        {
          kind: 'maskinporten',
          issuer: 'https://test.maskinporten.example',
          audience: AUDIENCE,
          keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        },
      ],
    });

    expect((await verifier(withUsers).verify(testId)).principal.scopes).toBeUndefined();
    await expect(verifier(withUsers).verify(outside)).rejects.toMatchObject({
      code: 'entra_not_trusted',
    });
    expect((await maskinporten.verify(machine)).principal.scopes).toEqual(['legacy:query']);
  });

  it('lets a user-group login invoke services in the platform organisation without a pid', async () => {
    const policy = altinnPolicy({
      altinn: { decide: async () => 'Deny' },
      identities: { personId: async () => undefined },
      requirementFor: () => ({ resource: RESOURCE, action: 'use-services', scope: 'legacy:query' }),
    });
    const { principal } = await verifier(withUsers).verify(await sign(userClaims()));
    const service = { kind: 'capability' as const, id: `${PLATFORM}/klarsprak` };

    expect(await policy.decide(principal, 'invoke', service)).toEqual({ allow: true });
    expect(
      (await policy.decide({ ...principal, tenant: '999999999' }, 'invoke', service)).allow,
    ).toBe(false);
  });
});

describe('service groups in lockdown', () => {
  const withServices: TrustedEntra = {
    ...trusted,
    userGroups: [USER_GROUP],
    serviceGroups: [SERVICE_GROUP],
    serviceClientIds: ['ka-web'],
  };
  const registeredAt = (tenant: string): ClientRegistry => ({
    byClientId: async (clientId) =>
      clientId === 'ka-web' || clientId === 'other-web'
        ? { clientId, audience: AUDIENCE, tenant, service: 'kunnskapsassistent', client: clientId }
        : undefined,
  });
  const registered = registeredAt(PLATFORM);
  const serviceClaims = (overrides: Record<string, unknown> = {}) =>
    entraClaims({ client_id: 'ka-web', groups: [OTHER_GROUP, SERVICE_GROUP], ...overrides });
  const verify = async (claims: Record<string, unknown>, clients = registered) =>
    verifier(withServices, clients).verify(await sign(claims));

  it('a service-group member through a listed service client may only use services, confined to that client', async () => {
    const { principal } = await verify(serviceClaims());

    expect(principal).toMatchObject({
      kind: 'employee',
      assurance: 'entraid',
      tenant: PLATFORM,
      authorizedFor: [{ org: PLATFORM, resource: RESOURCE, actions: ['use-services'] }],
      scopes: [lockdownServiceScope],
      confinedTo: { tenant: PLATFORM, service: 'kunnskapsassistent', client: 'ka-web' },
    });
    expect(platformRightsOf(principal, PLATFORM, RESOURCE)).toEqual(['use-services']);
  });

  it('a service-group member is refused through a platform client, an unlisted registered client or no client', async () => {
    const cases = [
      serviceClaims({ client_id: 'genki-test-portal' }),
      serviceClaims({ client_id: 'other-web' }),
      serviceClaims({ client_id: 'unregistered-web' }),
      serviceClaims({ client_id: undefined }),
    ];

    for (const claims of cases)
      await expect(verify(claims)).rejects.toMatchObject({ code: 'entra_not_trusted' });
  });

  it('a service client registered by another organisation admits no service-group member', async () => {
    await expect(verify(serviceClaims(), registeredAt('999999999'))).rejects.toMatchObject({
      code: 'not_authorized_for_org',
    });
  });

  const hostedAt = (tenant: string, hosted = true): ClientRegistry => ({
    byClientId: async (clientId) =>
      clientId === 'hosted-web'
        ? {
            clientId,
            audience: AUDIENCE,
            tenant,
            service: 'kunnskapsassistent',
            client: clientId,
            hosted,
          }
        : undefined,
  });

  it('in lockdown a hosted client passes without being listed', async () => {
    const { principal } = await verify(
      serviceClaims({ client_id: 'hosted-web' }),
      hostedAt(PLATFORM),
    );

    expect(principal).toMatchObject({
      authorizedFor: [{ org: PLATFORM, resource: RESOURCE, actions: ['use-services'] }],
      scopes: [lockdownServiceScope],
      confinedTo: { tenant: PLATFORM, service: 'kunnskapsassistent', client: 'hosted-web' },
    });
  });

  it('a client that is not hosted and not listed admits no service-group member', async () => {
    await expect(
      verify(serviceClaims({ client_id: 'hosted-web' }), hostedAt(PLATFORM, false)),
    ).rejects.toMatchObject({ code: 'entra_not_trusted' });
  });

  it('a hosted client outside the platform tenant does not pass lockdown', async () => {
    await expect(
      verify(serviceClaims({ client_id: 'hosted-web' }), hostedAt('999999999')),
    ).rejects.toMatchObject({ code: 'entra_not_trusted' });
  });

  it('a service-group member with an email outside the domain is refused', async () => {
    for (const email of ['kari@example.com', 'kari@digdir.example.evil.example', undefined])
      await expect(verify(serviceClaims({ email }))).rejects.toMatchObject({
        code: 'entra_not_trusted',
      });
  });

  it('a login in no configured group is still refused through a service client', async () => {
    await expect(verify(serviceClaims({ groups: [OTHER_GROUP] }))).rejects.toMatchObject({
      code: 'entra_not_trusted',
    });
  });

  it('the operator and user groups win where they apply, and a user-group member on a service client is a service user', async () => {
    const operator = await verify(serviceClaims({ groups: [SERVICE_GROUP, TRUSTED_GROUP] }));
    const userOnPortal = await verify(
      serviceClaims({ client_id: 'genki-test-portal', groups: [SERVICE_GROUP, USER_GROUP] }),
    );
    const userOnService = await verify(serviceClaims({ groups: [SERVICE_GROUP, USER_GROUP] }));

    expect(operator.principal.scopes).toEqual([trustedEntraScope]);
    expect(userOnPortal.principal.scopes).toEqual([lockdownUserScope]);
    expect(userOnService.principal).toMatchObject({
      scopes: [lockdownServiceScope],
      authorizedFor: [{ actions: ['use-services'] }],
    });
  });

  it('ignores a service scope the caller supplies', async () => {
    const scope = `openid profile ${lockdownServiceScope}`;
    const testId = await sign({ acr: 'idporten-loa-substantial', pid: '01017012345', scope });

    expect((await verifier(withServices).verify(testId)).principal.scopes).toBeUndefined();
    await expect(verify(serviceClaims({ groups: [OTHER_GROUP], scope }))).rejects.toMatchObject({
      code: 'entra_not_trusted',
    });
  });

  it('lets a service-group member invoke a service in the platform organisation without a pid', async () => {
    const policy = altinnPolicy({
      altinn: { decide: async () => 'Deny' },
      identities: { personId: async () => undefined },
      requirementFor: () => ({ resource: RESOURCE, action: 'use-services', scope: 'legacy:query' }),
    });
    const { principal } = await verify(serviceClaims());
    const service = { kind: 'capability' as const, id: `${PLATFORM}/kunnskapsassistent` };

    expect(await policy.decide(principal, 'invoke', service)).toEqual({ allow: true });
  });
});
