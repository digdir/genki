import { createHash, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { beforeAll, describe, expect, it } from 'vitest';
import { textPart, type Principal, type Ref } from '@genai/contracts';
import { createKernel, KernelError } from '@genai/kernel';
import { decodeJwt, exportJWK, generateKeyPair, SignJWT, type JWTVerifyGetKey } from 'jose';
import {
  actingFor,
  altinnPolicy,
  createMockAltinnPdp,
  createMockAnsattporten,
  createMockMaskinporten,
  createSigningKey,
  createTokenVerifier,
  httpAltinnAuthorization,
  InMemoryIdentities,
  remoteJwks,
  type IdentityTestDataInput,
  type SigningKey,
} from './index.js';

const ISSUER = 'http://ansattporten.test';
const MP_ISSUER = 'http://maskinporten.test';
const API = 'https://genai.test/api';
const KA = 'urn:altinn:resource:digdir-kunnskapsassistent';
const KLARSPRAK = 'urn:altinn:resource:digdir-klarsprak';
const DIGDIR = '991825827';
const NAV = '889640782';
const FITNESS_OSLO = '897069651';
const OTHER_API = 'https://other.test/api';

let key: SigningKey;
let vendorKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let clientKeys: Awaited<ReturnType<typeof generateKeyPair>>;
let data: IdentityTestDataInput;

beforeAll(async () => {
  key = await createSigningKey('mock-1');
  vendorKeys = await generateKeyPair('RS256', { extractable: true });
  clientKeys = await generateKeyPair('RS256', { extractable: true });
  data = {
    persons: [
      {
        pid: '45840375084',
        name: 'Kari Nordmann',
        parties: [
          { orgno: DIGDIR, name: 'DIGITALISERINGSDIREKTORATET', resources: { [KA]: ['read'] } },
        ],
      },
      {
        pid: '12345678901',
        name: 'Ola Begge',
        parties: [
          { orgno: DIGDIR, name: 'DIGITALISERINGSDIREKTORATET', resources: { [KA]: ['read'] } },
          {
            orgno: NAV,
            name: 'NAV',
            accessPackages: ['urn:altinn:accesspackage:skriving'],
            resources: { [KA]: ['read'] },
          },
          { orgno: FITNESS_OSLO, roles: ['DAGL'] },
        ],
      },
      { pid: '05057012345', name: 'Hensynsløs Måke', parties: [] },
    ],
    organisations: [{ orgno: FITNESS_OSLO, name: 'DDG Fitness Oslo', unitType: 'BEDR' }],
    clients: [
      {
        clientId: 'genai-portal',
        redirectUris: ['https://portal.test/callback'],
        postLogoutRedirectUris: ['https://portal.test/'],
        audience: API,
        audiences: [OTHER_API],
      },
      {
        clientId: 'genai-backend',
        redirectUris: ['https://backend.test/callback'],
        audience: API,
        tokenEndpointAuthMethod: 'private_key_jwt',
        jwks: { keys: [{ ...(await exportJWK(clientKeys.publicKey)), kid: 'backend-1' }] },
      },
      {
        clientId: 'genai-secret',
        redirectUris: ['https://secret.test/callback'],
        audience: API,
        tokenEndpointAuthMethod: 'client_secret_basic',
        clientSecret: 'local-test-secret',
      },
    ],
    resourceNames: { [KA]: 'Kunnskapsassistenten' },
    systems: [
      {
        clientId: 'nav-batch',
        consumer: NAV,
        scopes: ['digdir:genai.invoke'],
        publicKey: await exportJWK(vendorKeys.publicKey),
      },
      {
        clientId: 'vendor-x',
        consumer: '310000001',
        scopes: ['digdir:genai.invoke'],
        publicKey: await exportJWK(vendorKeys.publicKey),
        systemUser: {
          id: 'f0a1b2c3-0000-4000-8000-000000000001',
          org: NAV,
          systemId: 'vendor-x_saksbehandling',
          resources: { [KLARSPRAK]: ['read'] },
        },
      },
    ],
    resourcePolicies: {
      [KLARSPRAK]: { accessPackages: ['urn:altinn:accesspackage:skriving'], actions: ['read'] },
      [KA]: { rules: [{ roles: ['DAGL'], actions: ['read', 'write'] }] },
    },
  };
});

const keysFrom = (
  app: { request: (path: string) => Response | Promise<Response> },
  path: string,
): JWTVerifyGetKey =>
  remoteJwks(`http://mock${path}`, async (url) => app.request(new URL(String(url)).pathname));

const setup = () => {
  const ansattporten = createMockAnsattporten({ issuer: ISSUER, key, testData: data });
  const maskinporten = createMockMaskinporten({
    issuer: MP_ISSUER,
    key,
    testData: data,
    audience: API,
  });
  const verifier = createTokenVerifier({
    issuers: [
      {
        kind: 'ansattporten',
        issuer: ISSUER,
        audience: API,
        keys: keysFrom(ansattporten.app, '/jwks'),
      },
      {
        kind: 'maskinporten',
        issuer: MP_ISSUER,
        audience: API,
        keys: keysFrom(maskinporten.app, '/jwks'),
        requiredScopes: ['digdir:genai.invoke'],
      },
    ],
  });
  return { ansattporten, maskinporten, verifier };
};

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') };
};

type App = { request: (path: string, init?: RequestInit) => Response | Promise<Response> };

const formPost = (app: App, path: string, fields: [string, string][]) =>
  app.request(path, { method: 'POST', body: new URLSearchParams(fields) });

const hidden = (page: string, name: string) =>
  new RegExp(`name="${name}" value="([^"]*)"`).exec(page)?.[1] ?? '';

const authorizeParams = (overrides: Record<string, string> = {}) => {
  const { verifier, challenge } = pkce();
  const params = new URLSearchParams({
    client_id: 'genai-portal',
    redirect_uri: 'https://portal.test/callback',
    response_type: 'code',
    scope: 'openid profile',
    state: 'st-1',
    nonce: 'n-1',
    code_challenge: challenge,
    code_challenge_method: 'S256',
    acr_values: 'high',
    authorization_details: JSON.stringify([{ type: 'ansattporten:altinn:resource', resource: KA }]),
    ...overrides,
  });
  return { params, verifier };
};

const login = async (
  app: App,
  pid: string,
  opts: {
    verifier?: string;
    redirect?: string;
    orgs?: string[];
    params?: Record<string, string>;
    base?: string;
  } = {},
) => {
  const base = opts.base ?? '';
  const { params, verifier } = authorizeParams(opts.params);
  const page = await app.request(`${base}/authorize?${params}`);
  const html = await page.text();
  const persons = [...html.matchAll(/name="pid" value="(\d+)"/g)].map((m) => m[1]);
  const action = /<form method="post" action="([^"]+)"/.exec(html)?.[1] ?? '';
  const target = new URL(action, `http://mock${base}/authorize`).pathname;
  let response = await formPost(app, target, [
    ['login', hidden(html, 'login')],
    ['pid', pid],
  ]);
  let organisationPage: string | undefined;
  if (response.status === 200) {
    organisationPage = await response.text();
    const offered = [...organisationPage.matchAll(/name="org" value="(\d+)"/g)].map((m) => m[1]);
    const chosen = opts.orgs ?? offered.slice(0, 1);
    response = await formPost(app, target, [
      ['login', hidden(organisationPage, 'login')],
      ['pid', pid],
      ['step', 'organisation'],
      ...chosen.map((o): [string, string] => ['org', o ?? '']),
    ]);
  }
  const location = new URL(response.headers.get('location') ?? 'http://none');
  const exchange = (
    code: string | null,
    init: RequestInit = {},
    fields: Record<string, string> = {},
  ) =>
    app.request(`${base}/token`, {
      method: 'POST',
      ...init,
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code ?? '',
        client_id: params.get('client_id') ?? '',
        redirect_uri: opts.redirect ?? params.get('redirect_uri') ?? '',
        code_verifier: opts.verifier ?? verifier,
        ...fields,
      }),
    });
  return { page: html, persons, action, organisationPage, response, location, exchange };
};

const signWithOtherKey = async (
  claims: Record<string, unknown>,
  kid = 'mock-1',
  iss = ISSUER,
  aud = API,
) => {
  const other = await generateKeyPair('RS256');
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(iss)
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(other.privateKey);
};

describe('mock Ansattporten', () => {
  it('publishes discovery metadata and its signing key', async () => {
    const { ansattporten } = setup();

    const discovery = await (
      await ansattporten.app.request('/.well-known/openid-configuration')
    ).json();
    const jwks = (await (await ansattporten.app.request('/jwks')).json()) as {
      keys: { kid: string; d?: string }[];
    };

    expect(discovery).toMatchObject({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/jwks.json`,
      code_challenge_methods_supported: ['S256'],
    });
    expect(jwks.keys.map((k) => k.kid)).toEqual(['mock-1']);
    expect(jwks.keys[0]).not.toHaveProperty('d');
  });

  it('logs a test person in with code flow and PKCE and returns Ansattporten-shaped tokens', async () => {
    const { ansattporten, verifier } = setup();

    const { persons, location, exchange } = await login(ansattporten.app, '45840375084');
    const tokens = (await (await exchange(location.searchParams.get('code'))).json()) as Record<
      string,
      string
    >;
    const identity = await verifier.verify(tokens.access_token ?? '');

    expect(persons).toEqual(['45840375084', '12345678901', '05057012345']);
    expect(location.origin + location.pathname).toBe('https://portal.test/callback');
    expect(location.searchParams.get('state')).toBe('st-1');
    expect(identity).toEqual({
      principal: {
        kind: 'employee',
        issuer: ISSUER,
        subject: expect.stringMatching(/^[\w-]{43}$/),
        client: 'genai-portal',
        assurance: 'high',
        authorizedFor: [{ org: DIGDIR, resource: KA, actions: [] }],
        tenant: DIGDIR,
        orgNames: { [DIGDIR]: 'DIGITALISERINGSDIREKTORATET' },
        expiresAt: expect.any(String),
      },
      personId: '45840375084',
      partiesWithoutActions: [{ org: DIGDIR, resource: KA }],
    });
    expect(JSON.stringify(identity.principal)).not.toContain('45840375084');
  });

  it('lists the authorized parties in the id token without actions, the way Ansattporten does', async () => {
    const { ansattporten } = setup();
    const { location, exchange } = await login(ansattporten.app, '45840375084');
    const tokens = (await (await exchange(location.searchParams.get('code'))).json()) as Record<
      string,
      string
    >;
    const claims = JSON.parse(
      Buffer.from((tokens.id_token ?? '').split('.')[1] ?? '', 'base64url').toString(),
    );

    expect(claims).toMatchObject({
      iss: ISSUER,
      aud: 'genai-portal',
      pid: '45840375084',
      acr: 'high',
      nonce: 'n-1',
      authorization_details: [
        {
          type: 'ansattporten:altinn:resource',
          resource: KA,
          authorized_parties: [
            {
              orgno: { authority: 'iso6523-actorid-upis', ID: `0192:${DIGDIR}` },
              resource: 'digdir-kunnskapsassistent',
              name: 'DIGITALISERINGSDIREKTORATET',
            },
          ],
        },
      ],
    });
    expect(claims.authorization_details[0].authorized_parties[0]).not.toHaveProperty('actions');
  });

  it('refuses a wrong code verifier, a reused code and a different redirect uri', async () => {
    const { ansattporten } = setup();
    const wrongVerifier = await login(ansattporten.app, '45840375084', {
      verifier: 'not-the-verifier',
    });
    const wrongRedirect = await login(ansattporten.app, '45840375084', {
      redirect: 'https://evil.test/cb',
    });
    const reused = await login(ansattporten.app, '45840375084');

    const first = await reused.exchange(reused.location.searchParams.get('code'));
    const second = await reused.exchange(reused.location.searchParams.get('code'));

    expect(
      (await wrongVerifier.exchange(wrongVerifier.location.searchParams.get('code'))).status,
    ).toBe(400);
    expect(
      (await wrongRedirect.exchange(wrongRedirect.location.searchParams.get('code'))).status,
    ).toBe(400);
    expect(first.status).toBe(200);
    expect(await second.json()).toEqual({ error: 'invalid_grant' });
  });

  it('refuses an unknown redirect uri and a flow without PKCE at the authorize step', async () => {
    const { ansattporten } = setup();
    const base = {
      client_id: 'genai-portal',
      response_type: 'code',
      code_challenge: 'x',
      code_challenge_method: 'S256',
    };

    const evil = await ansattporten.app.request(
      `/authorize?${new URLSearchParams({ ...base, redirect_uri: 'https://evil.test/cb' })}`,
    );
    const plain = await ansattporten.app.request(
      `/authorize?${new URLSearchParams({ ...base, redirect_uri: 'https://portal.test/callback', code_challenge_method: 'plain' })}`,
    );

    expect(evil.status).toBe(400);
    expect(plain.status).toBe(400);
  });
});

describe('mock Ansattporten subjects', () => {
  const subjectOf = async (client: string, pid = '12345678901', issuer = ISSUER) =>
    decodeJwt(
      (await createMockAnsattporten({ issuer, key, testData: data }).testTokens(pid, client))
        .access_token,
    ).sub;

  it('gives a person the same subject after a restart, so stored names keep resolving', async () => {
    expect(await subjectOf('genai-portal')).toBe(await subjectOf('genai-portal'));
  });

  it('keeps subjects pairwise per client and distinct per person', async () => {
    expect(await subjectOf('genai-portal')).not.toBe(await subjectOf('genai-backend'));
    expect(await subjectOf('genai-portal')).not.toBe(
      await subjectOf('genai-portal', '45840375084'),
    );
  });

  it('keeps subjects apart between issuers', async () => {
    expect(await subjectOf('genai-portal')).not.toBe(
      await subjectOf('genai-portal', '12345678901', 'https://other.test'),
    );
  });
});

describe('token verification', () => {
  it('leaves the tenant open for a person with rights in several organisations until they choose', async () => {
    const { ansattporten, verifier } = setup();
    const tokens = await ansattporten.testTokens('12345678901', 'genai-portal', [KA]);

    const { principal } = await verifier.verify(tokens.access_token);

    expect(principal.tenant).toBeUndefined();
    expect(actingFor(principal, NAV).tenant).toBe(NAV);
    expect(() => actingFor(principal, '999999999')).toThrow(/not authorized to act for 999999999/);
  });

  it('rejects an untrusted issuer, the wrong audience, an expired token and a forged signature', async () => {
    const { ansattporten, verifier } = setup();
    const expired = createMockAnsattporten({
      issuer: ISSUER,
      key,
      testData: data,
      now: () => Date.now() - 7_200_000,
    });
    const idToken = (await ansattporten.testTokens('45840375084', 'genai-portal', [KA])).id_token;

    const cases = [
      await signWithOtherKey({ sub: 's', acr: 'high' }, 'mock-1', 'https://evil.test'),
      idToken,
      (await expired.testTokens('45840375084', 'genai-portal', [KA])).access_token,
      await signWithOtherKey({ sub: 's', acr: 'high' }),
      'not-a-jwt',
    ];
    const codes = [];
    for (const token of cases)
      codes.push(await verifier.verify(token).catch((e: { code: string }) => e.code));

    expect(codes).toEqual([
      'unknown_issuer',
      'invalid_token',
      'invalid_token',
      'invalid_token',
      'invalid_token',
    ]);
  });

  it('enforces the minimum assurance level', async () => {
    const ansattporten = createMockAnsattporten({ issuer: ISSUER, key, testData: data });
    const strict = createTokenVerifier({
      issuers: [
        {
          kind: 'ansattporten',
          issuer: ISSUER,
          audience: API,
          keys: keysFrom(ansattporten.app, '/jwks'),
          minAssurance: 'high',
        },
      ],
    });
    const substantial = await ansattporten.testTokens(
      '45840375084',
      'genai-portal',
      [KA],
      'substantial',
    );
    const high = await ansattporten.testTokens('45840375084', 'genai-portal', [KA], 'high');

    await expect(strict.verify(substantial.access_token)).rejects.toMatchObject({
      code: 'insufficient_assurance',
    });
    expect((await strict.verify(high.access_token)).principal.assurance).toBe('high');
  });
});

describe('mock Maskinporten', () => {
  const assertion = (
    clientId: string,
    extra: Record<string, unknown> = {},
    signer = vendorKeys.privateKey,
  ) =>
    new SignJWT({ scope: 'digdir:genai.invoke', ...extra })
      .setProtectedHeader({ alg: 'RS256' })
      .setIssuer(clientId)
      .setAudience(MP_ISSUER)
      .setIssuedAt()
      .setExpirationTime('1m')
      .setJti(randomBytes(8).toString('hex'))
      .sign(signer);

  const grant = async (app: ReturnType<typeof createMockMaskinporten>['app'], jwt: string) =>
    app.request('/token', {
      method: 'POST',
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }),
    });

  it('issues an agency system token for a signed client assertion', async () => {
    const { maskinporten, verifier } = setup();

    const response = await grant(maskinporten.app, await assertion('nav-batch'));
    const { access_token } = (await response.json()) as { access_token: string };

    expect((await verifier.verify(access_token)).principal).toEqual({
      kind: 'agency-system',
      issuer: MP_ISSUER,
      subject: 'nav-batch',
      tenant: NAV,
      client: 'nav-batch',
      scopes: ['digdir:genai.invoke'],
      expiresAt: expect.any(String),
    });
  });

  it('maps a system user token to the customer organisation', async () => {
    const { maskinporten, verifier } = setup();

    const response = await grant(
      maskinporten.app,
      await assertion('vendor-x', {
        authorization_details: [
          { type: 'urn:altinn:systemuser', systemuser_org: { ID: `0192:${NAV}` } },
        ],
      }),
    );
    const { access_token } = (await response.json()) as { access_token: string };

    expect((await verifier.verify(access_token)).principal).toMatchObject({
      kind: 'vendor-system',
      subject: 'f0a1b2c3-0000-4000-8000-000000000001',
      tenant: NAV,
      supplier: '310000001',
      systemUser: 'f0a1b2c3-0000-4000-8000-000000000001',
    });
  });

  it('refuses an assertion signed with the wrong key and a scope the client does not have', async () => {
    const { maskinporten } = setup();
    const stranger = await generateKeyPair('RS256');

    expect(
      (await grant(maskinporten.app, await assertion('nav-batch', {}, stranger.privateKey))).status,
    ).toBe(400);
    expect(
      (await grant(maskinporten.app, await assertion('nav-batch', { scope: 'digdir:genai.admin' })))
        .status,
    ).toBe(400);
  });
});

describe('Altinn policy', () => {
  const capability = (id: string): Ref => ({ kind: 'capability', id, tenant: DIGDIR });
  const requirements: Record<string, { resource: string; action: string; scope?: string }> = {
    ka: { resource: KA, action: 'read' },
    klarsprak: { resource: KLARSPRAK, action: 'read', scope: 'digdir:genai.invoke' },
  };

  const policyOver = (fetchFn: typeof fetch) => {
    const identities = new InMemoryIdentities();
    const policy = altinnPolicy({
      altinn: httpAltinnAuthorization({ baseURL: 'http://altinn.test', fetch: fetchFn }),
      identities,
      requirementFor: (ref) => requirements[ref.id],
    });
    return { identities, policy };
  };

  const throughMock = () => {
    const pdp = createMockAltinnPdp(data);
    return policyOver(async (url, init) => pdp.app.request(new URL(String(url)).pathname, init));
  };

  const employee = async (pid: string, org?: string) => {
    const { ansattporten, verifier } = setup();
    const identity = await verifier.verify(
      (await ansattporten.testTokens(pid, 'genai-portal', [KA])).access_token,
    );
    return { identity, principal: org ? actingFor(identity.principal, org) : identity.principal };
  };

  it('lets a person invoke a service when Altinn grants the resource for the organisation they act for', async () => {
    const { identities, policy } = throughMock();
    const { identity, principal } = await employee('45840375084');
    identities.remember(identity);

    expect(await policy.decide(principal, 'invoke', capability('ka'))).toEqual({ allow: true });
  });

  it('grants through an access package on the resource policy', async () => {
    const { identities, policy } = throughMock();
    const { identity, principal } = await employee('12345678901', NAV);
    identities.remember(identity);

    expect(await policy.decide(principal, 'invoke', capability('klarsprak'))).toEqual({
      allow: true,
    });
    expect(
      await policy.decide(actingFor(identity.principal, DIGDIR), 'invoke', capability('klarsprak')),
    ).toMatchObject({
      allow: false,
      reason: 'Altinn answered NotApplicable',
    });
  });

  it('denies without a chosen organisation, for an organisation outside the login, and for a service with no requirement', async () => {
    const { identities, policy } = throughMock();
    const { identity, principal } = await employee('12345678901');
    identities.remember(identity);

    expect(await policy.decide(principal, 'invoke', capability('ka'))).toMatchObject({
      allow: false,
    });
    expect(
      await policy.decide({ ...principal, tenant: '999999999' }, 'invoke', capability('ka')),
    ).toMatchObject({
      allow: false,
    });
    expect(
      await policy.decide(actingFor(principal, NAV), 'invoke', capability('unknown')),
    ).toMatchObject({
      allow: false,
      reason: 'no Altinn requirement is configured for this service',
    });
  });

  it('denies when the person is not known or Altinn cannot be reached', async () => {
    const { policy } = throughMock();
    const down = policyOver(async () => new Response('', { status: 503 }));
    const { identity, principal } = await employee('45840375084');
    down.identities.remember(identity);

    expect(await policy.decide(principal, 'invoke', capability('ka'))).toMatchObject({
      reason: 'unknown person',
    });
    expect(await down.policy.decide(principal, 'invoke', capability('ka'))).toMatchObject({
      reason: 'the authorization service is unavailable',
    });
  });

  it('checks a system user against its own rights and an agency system against its scope', async () => {
    const { policy } = throughMock();
    const systemUser: Principal = {
      kind: 'vendor-system',
      issuer: MP_ISSUER,
      subject: 'f0a1b2c3-0000-4000-8000-000000000001',
      tenant: NAV,
      systemUser: 'f0a1b2c3-0000-4000-8000-000000000001',
      scopes: ['digdir:genai.invoke'],
    };
    const agency: Principal = {
      kind: 'agency-system',
      issuer: MP_ISSUER,
      subject: 'nav-batch',
      tenant: NAV,
      scopes: [],
    };

    expect(await policy.decide(systemUser, 'invoke', capability('klarsprak'))).toEqual({
      allow: true,
    });
    expect(await policy.decide(systemUser, 'invoke', capability('ka'))).toMatchObject({
      allow: false,
    });
    expect(
      await policy.decide({ ...systemUser, tenant: DIGDIR }, 'invoke', capability('klarsprak')),
    ).toMatchObject({
      reason: 'Altinn answered NotApplicable',
    });
    expect(await policy.decide(agency, 'invoke', capability('klarsprak'))).toMatchObject({
      reason: 'missing scope digdir:genai.invoke',
    });
  });

  it('gates kernel invocations', async () => {
    const { identities, policy } = throughMock();
    const kari = await employee('45840375084');
    const ola = await employee('12345678901', NAV);
    identities.remember(kari.identity);
    identities.remember(ola.identity);
    const kernel = createKernel({
      strategies: [
        {
          id: 'echo',
          version: '1',
          requires: { kernel: 1, ports: [], features: [] },
          run: async function* () {
            yield { type: 'kernel.result', data: [textPart('ok')] };
          },
        },
      ],
      capabilities: [
        {
          descriptor: {
            id: 'ka',
            version: '1',
            tenant: DIGDIR,
            availableTo: '*',
            title: 'KA',
            description: 'KA',
            input: {},
            interaction: ['unary'],
            accepts: [],
            produces: [],
            emits: [],
            oversight: { interrupts: false, riskClass: 'limited', aiDisclosure: 'KI' },
          },
          strategy: { id: 'echo', version: '1' },
          config: {},
          grants: [],
        },
      ],
      ports: {},
      policy,
    });

    const run = await kernel.invoke(kari.principal, 'ka', {});
    const refused = await kernel
      .invoke({ ...ola.principal, tenant: DIGDIR, authorizedFor: [] }, 'ka', {})
      .catch((e) => e);

    expect(await run.result).toEqual([textPart('ok')]);
    expect(refused).toBeInstanceOf(KernelError);
  });
});

const payloadOf = (jwt: string | undefined) =>
  JSON.parse(Buffer.from((jwt ?? '').split('.')[1] ?? '', 'base64url').toString()) as Record<
    string,
    unknown
  >;

const tokensFrom = async (response: Response) => (await response.json()) as Record<string, string>;

describe('mock Ansattporten login through the test-person picker', () => {
  it('shows a Norwegian picker, then only the organisations the person can represent', async () => {
    const { ansattporten } = setup();

    const flow = await login(ansattporten.app, '12345678901', { orgs: [NAV] });
    const tokens = await tokensFrom(await flow.exchange(flow.location.searchParams.get('code')));

    expect(flow.page).toContain('<html lang="nb">');
    expect(flow.page).toContain('Velg testperson');
    expect(flow.page).toContain('Fødselsnummer 05057012345');
    expect(flow.action).toBe('authorize');
    expect(flow.organisationPage).toContain('Velg virksomhet du ønsker å representere');
    expect(flow.organisationPage).toContain('Meg selv');
    expect(
      [...(flow.organisationPage ?? '').matchAll(/name="org" value="(\d+)"/g)].map((m) => m[1]),
    ).toEqual([DIGDIR, NAV, FITNESS_OSLO]);
    expect(flow.location.searchParams.get('iss')).toBe(ISSUER);
    expect(
      (
        payloadOf(tokens.access_token).authorization_details as { authorized_parties: unknown[] }[]
      )[0]?.authorized_parties,
    ).toEqual([
      {
        orgno: { authority: 'iso6523-actorid-upis', ID: `0192:${NAV}` },
        resource: 'digdir-kunnskapsassistent',
        name: 'NAV',
        unit_type: 'ORGL',
      },
    ]);
  });

  it('follows ui_locales in the picker and the id token', async () => {
    const { ansattporten } = setup();

    const flow = await login(ansattporten.app, '12345678901', {
      orgs: [NAV],
      params: { ui_locales: 'en' },
    });
    const tokens = await tokensFrom(await flow.exchange(flow.location.searchParams.get('code')));

    expect(flow.page).toContain('<html lang="en">');
    expect(flow.page).toContain('Choose a test person');
    expect(flow.page).toContain('National identity number 05057012345');
    expect(flow.organisationPage).toContain('Choose the organisation you want to represent');
    expect(flow.organisationPage).toContain('Myself');
    expect(payloadOf(tokens.id_token).locale).toBe('en');
    const loggedOut = await (await ansattporten.app.request('/logout?ui_locales=en')).text();
    expect(loggedOut).toContain('You are signed out');
  });

  it('works when mounted under /mock/ansattporten, because the forms post to a relative path', async () => {
    const issuer = 'http://localhost:8080/mock/ansattporten';
    const mounted = new Hono().route(
      '/mock/ansattporten',
      createMockAnsattporten({ issuer, key, testData: data }).app,
    );

    const flow = await login(mounted, '45840375084', { base: '/mock/ansattporten' });
    const exchanged = await flow.exchange(flow.location.searchParams.get('code'));

    expect(flow.location.origin + flow.location.pathname).toBe('https://portal.test/callback');
    expect(exchanged.status).toBe(200);
    expect(payloadOf((await tokensFrom(exchanged)).id_token).iss).toBe(issuer);
  });

  it('lets a person choose several organisations only when the client allows it', async () => {
    const { ansattporten } = setup();
    const details = (extra: Record<string, unknown>) => ({
      authorization_details: JSON.stringify([
        { type: 'ansattporten:altinn:resource', resource: KA, ...extra },
      ]),
    });

    const multiple = await login(ansattporten.app, '12345678901', {
      orgs: [DIGDIR, NAV],
      params: details({ allow_multiple_organizations: true }),
    });
    const single = await login(ansattporten.app, '12345678901', { orgs: [DIGDIR, NAV] });
    const tokens = await tokensFrom(
      await multiple.exchange(multiple.location.searchParams.get('code')),
    );

    expect(multiple.organisationPage).toContain('type="checkbox"');
    expect(
      (
        payloadOf(tokens.access_token).authorization_details as {
          authorized_parties: { name: string }[];
        }[]
      )[0]?.authorized_parties.map((p) => p.name),
    ).toEqual(['DIGITALISERINGSDIREKTORATET', 'NAV']);
    expect(single.response.status).toBe(400);
  });

  it('filters by organisation form and by the requested actions', async () => {
    const { ansattporten } = setup();

    const flow = await login(ansattporten.app, '12345678901', {
      params: {
        authorization_details: JSON.stringify([
          {
            type: 'ansattporten:altinn:resource',
            resource: KA,
            organizationform: 'business',
            actions: 'write',
          },
        ]),
      },
    });
    const tokens = await tokensFrom(await flow.exchange(flow.location.searchParams.get('code')));

    expect(
      (payloadOf(tokens.id_token).authorization_details as { authorized_parties: unknown[] }[])[0]
        ?.authorized_parties,
    ).toEqual([
      {
        orgno: { authority: 'iso6523-actorid-upis', ID: `0192:${FITNESS_OSLO}` },
        resource: 'digdir-kunnskapsassistent',
        name: 'DDG Fitness Oslo',
        unit_type: 'BEDR',
      },
    ]);
  });

  it('lets a person without access log in with an empty list, or refuses when representation is required', async () => {
    const { ansattporten } = setup();

    const open = await login(ansattporten.app, '05057012345');
    const required = await login(ansattporten.app, '05057012345', {
      params: {
        authorization_details: JSON.stringify([
          { type: 'ansattporten:altinn:resource', resource: KA, representation_is_required: true },
        ]),
      },
    });
    const tokens = await tokensFrom(await open.exchange(open.location.searchParams.get('code')));

    expect(open.organisationPage).toBeUndefined();
    expect(payloadOf(tokens.access_token).authorization_details).toEqual([
      {
        type: 'ansattporten:altinn:resource',
        resource: KA,
        resource_name: 'Kunnskapsassistenten',
        authorized_parties: [],
      },
    ]);
    expect(required.location.searchParams.get('error')).toBe('access_denied');
    expect(required.location.searchParams.get('state')).toBe('st-1');
  });
});

describe('mock Ansattporten tokens have the real shape', () => {
  it('publishes discovery like the real issuer', async () => {
    const { ansattporten } = setup();

    const discovery = (await (
      await ansattporten.app.request('/.well-known/openid-configuration')
    ).json()) as Record<string, unknown>;

    expect(discovery).toMatchObject({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/authorize`,
      token_endpoint: `${ISSUER}/token`,
      userinfo_endpoint: `${ISSUER}/userinfo`,
      end_session_endpoint: `${ISSUER}/logout`,
      jwks_uri: `${ISSUER}/jwks.json`,
      scopes_supported: ['openid', 'profile'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      token_endpoint_auth_methods_supported: expect.arrayContaining(['private_key_jwt']),
      authorization_details_types_supported: ['ansattporten:altinn:resource'],
      authorization_response_iss_parameter_supported: true,
    });
  });

  it('issues id and access tokens with the claims real Ansattporten sets', async () => {
    const { ansattporten } = setup();
    const flow = await login(ansattporten.app, '45840375084');
    const tokens = await tokensFrom(await flow.exchange(flow.location.searchParams.get('code')));

    const id = payloadOf(tokens.id_token);
    const access = payloadOf(tokens.access_token);

    expect(Object.keys(tokens).sort()).toEqual([
      'access_token',
      'expires_in',
      'id_token',
      'refresh_token',
      'scope',
      'token_type',
    ]);
    expect(Object.keys(id).sort()).toEqual(
      [
        'iss',
        'aud',
        'sub',
        'iat',
        'exp',
        'jti',
        'sid',
        'auth_time',
        'acr',
        'amr',
        'pid',
        'locale',
        'nonce',
        'name',
        'given_name',
        'family_name',
        'authorization_details',
      ].sort(),
    );
    expect(id).toMatchObject({
      aud: 'genai-portal',
      acr: 'high',
      amr: ['TestID'],
      locale: 'nb',
      given_name: 'Kari',
      family_name: 'Nordmann',
    });
    expect(access).toMatchObject({
      aud: API,
      client_id: 'genai-portal',
      client_amr: 'none',
      scope: 'openid profile',
      pid: '45840375084',
      sub: id.sub,
    });
    expect(access).not.toHaveProperty('nonce');
  });

  it('sets the access token audience from the resource parameter, only to an allowed one', async () => {
    const { ansattporten, verifier } = setup();

    const other = await login(ansattporten.app, '45840375084', { params: { resource: OTHER_API } });
    const tokens = await tokensFrom(await other.exchange(other.location.searchParams.get('code')));
    const unknown = await ansattporten.app.request(
      `/authorize?${authorizeParams({ resource: 'https://evil.test' }).params}`,
    );

    expect(payloadOf(tokens.access_token).aud).toBe(OTHER_API);
    await expect(verifier.verify(tokens.access_token ?? '')).rejects.toMatchObject({
      code: 'invalid_token',
    });
    expect(unknown.status).toBe(400);
  });

  it('rotates refresh tokens and serves userinfo for its own access tokens', async () => {
    const { ansattporten } = setup();
    const flow = await login(ansattporten.app, '45840375084');
    const first = await tokensFrom(await flow.exchange(flow.location.searchParams.get('code')));
    const refresh = (token: string | undefined) =>
      ansattporten.app.request('/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: token ?? '',
          client_id: 'genai-portal',
        }),
      });

    const second = await refresh(first.refresh_token);
    const reused = await refresh(first.refresh_token);
    const userinfo = await ansattporten.app.request('/userinfo', {
      headers: { authorization: `Bearer ${first.access_token}` },
    });

    expect(second.status).toBe(200);
    expect(payloadOf((await tokensFrom(second)).id_token)).not.toHaveProperty('nonce');
    expect(reused.status).toBe(400);
    expect(await userinfo.json()).toMatchObject({
      pid: '45840375084',
      name: 'Kari Nordmann',
      locale: 'nb',
    });
  });

  it('redirects after logout only to a registered address', async () => {
    const { ansattporten } = setup();

    const registered = await ansattporten.app.request(
      `/logout?client_id=genai-portal&post_logout_redirect_uri=${encodeURIComponent('https://portal.test/')}&state=s`,
    );
    const foreign = await ansattporten.app.request(
      `/logout?client_id=genai-portal&post_logout_redirect_uri=${encodeURIComponent('https://evil.test/')}`,
    );

    expect(registered.headers.get('location')).toBe('https://portal.test/?state=s');
    expect(foreign.status).toBe(200);
    expect(await foreign.text()).toContain('Du er logget ut');
  });
});

describe('mock Ansattporten client authentication', () => {
  const assertion = async (
    claims: { iss?: string; sub?: string; aud?: string; jti?: string } = {},
    signer = clientKeys.privateKey,
  ) =>
    new SignJWT({})
      .setProtectedHeader({ alg: 'RS256', kid: 'backend-1' })
      .setIssuer(claims.iss ?? 'genai-backend')
      .setSubject(claims.sub ?? 'genai-backend')
      .setAudience(claims.aud ?? ISSUER)
      .setJti(claims.jti ?? randomBytes(8).toString('hex'))
      .setIssuedAt()
      .setExpirationTime('1m')
      .sign(signer);

  const backendLogin = (app: App) =>
    login(app, '45840375084', {
      params: { client_id: 'genai-backend', redirect_uri: 'https://backend.test/callback' },
    });

  const withAssertion = async (app: App, token: string) => {
    const flow = await backendLogin(app);
    return flow.exchange(
      flow.location.searchParams.get('code'),
      {},
      {
        client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
        client_assertion: token,
      },
    );
  };

  it('accepts a private_key_jwt client assertion and records the method in client_amr', async () => {
    const { app } = setup().ansattporten;
    const response = await withAssertion(app, await assertion());

    expect(response.status).toBe(200);
    expect(payloadOf((await tokensFrom(response)).access_token)).toMatchObject({
      client_id: 'genai-backend',
      client_amr: 'private_key_jwt',
    });
  });

  it('refuses an assertion with the wrong key, audience or subject, a replayed one, and none at all', async () => {
    const { app } = setup().ansattporten;
    const other = await generateKeyPair('RS256');
    const replayed = await assertion({ jti: 'once' });
    await withAssertion(app, replayed);

    const statuses = [
      (await withAssertion(app, await assertion({}, other.privateKey))).status,
      (await withAssertion(app, await assertion({ aud: `${ISSUER}/token` }))).status,
      (await withAssertion(app, await assertion({ sub: 'someone-else' }))).status,
      (await withAssertion(app, replayed)).status,
    ];
    const flow = await backendLogin(app);
    const without = await flow.exchange(flow.location.searchParams.get('code'));

    expect(statuses).toEqual([401, 401, 401, 401]);
    expect(await without.json()).toEqual({ error: 'invalid_client' });
  });

  it('checks client_secret_basic and refuses the secret in the body for a basic client', async () => {
    const { ansattporten } = setup();
    const flowFor = () =>
      login(ansattporten.app, '45840375084', {
        params: { client_id: 'genai-secret', redirect_uri: 'https://secret.test/callback' },
      });
    const basic = (secret: string) => ({
      headers: {
        authorization: `Basic ${Buffer.from(`genai-secret:${secret}`).toString('base64')}`,
      },
    });

    const good = await flowFor();
    const wrong = await flowFor();
    const posted = await flowFor();

    expect(
      (await good.exchange(good.location.searchParams.get('code'), basic('local-test-secret')))
        .status,
    ).toBe(200);
    expect(
      (await wrong.exchange(wrong.location.searchParams.get('code'), basic('nope'))).status,
    ).toBe(401);
    expect(
      (
        await posted.exchange(
          posted.location.searchParams.get('code'),
          {},
          { client_secret: 'local-test-secret' },
        )
      ).status,
    ).toBe(401);
  });
});

describe('mock Altinn PDP decisions per test person', () => {
  const xacml = (subject: [string, string], action: string, resource: [string, string][]) => ({
    Request: {
      AccessSubject: [{ Attribute: [{ AttributeId: subject[0], Value: subject[1] }] }],
      Action: [
        {
          Attribute: [
            { AttributeId: 'urn:oasis:names:tc:xacml:1.0:action:action-id', Value: action },
          ],
        },
      ],
      Resource: [{ Attribute: resource.map(([AttributeId, Value]) => ({ AttributeId, Value })) }],
    },
  });
  const ask = async (body: unknown, path = '/authorization/api/v1/authorize') => {
    const pdp = createMockAltinnPdp({
      ...data,
      persons: [
        ...(data.persons ?? []),
        {
          pid: '03037012345',
          name: 'Ingrid Berg',
          userId: 20003,
          parties: [{ orgno: DIGDIR, name: 'Digdir', roles: ['dagl'] }],
        },
      ],
      organisations: [...(data.organisations ?? []), { orgno: NAV, name: 'NAV', partyId: 500010 }],
    });
    const response = await pdp.app.request(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await response.json()) as {
      Response: { Decision: string; Status: { StatusCode: { Value: string } } }[];
    };
  };
  const PERSON = 'urn:altinn:person:identifier-no';
  const ORG = 'urn:altinn:organization:identifier-no';
  const decision = async (pid: string, action: string, resource: string, org: string) =>
    (
      await ask(
        xacml([PERSON, pid], action, [
          ['urn:altinn:resource', resource],
          [ORG, org],
        ]),
      )
    ).Response[0]?.Decision;

  it.each([
    [
      'Kari, direct delegation in Digdir',
      '45840375084',
      'read',
      'digdir-kunnskapsassistent',
      DIGDIR,
      'Permit',
    ],
    [
      'Kari, an action she was not given',
      '45840375084',
      'write',
      'digdir-kunnskapsassistent',
      DIGDIR,
      'NotApplicable',
    ],
    [
      'Kari, an organisation she does not belong to',
      '45840375084',
      'read',
      'digdir-kunnskapsassistent',
      NAV,
      'NotApplicable',
    ],
    ['Ola, access package in NAV', '12345678901', 'read', 'digdir-klarsprak', NAV, 'Permit'],
    [
      'Ola, no access package in Digdir',
      '12345678901',
      'read',
      'digdir-klarsprak',
      DIGDIR,
      'NotApplicable',
    ],
    [
      'Ola, DAGL role in the sub-unit',
      '12345678901',
      'write',
      'digdir-kunnskapsassistent',
      FITNESS_OSLO,
      'Permit',
    ],
    [
      'Ingrid, role codes match regardless of case',
      '03037012345',
      'write',
      'digdir-kunnskapsassistent',
      DIGDIR,
      'Permit',
    ],
    [
      'Måke, no parties at all',
      '05057012345',
      'read',
      'digdir-kunnskapsassistent',
      DIGDIR,
      'NotApplicable',
    ],
    [
      'an unknown person',
      '99999999999',
      'read',
      'digdir-kunnskapsassistent',
      DIGDIR,
      'Indeterminate',
    ],
    ['an unknown resource', '45840375084', 'read', 'digdir-finnes-ikke', DIGDIR, 'Indeterminate'],
  ])('%s', async (_name, pid, action, resource, org, expected) => {
    expect(await decision(pid, action, resource, org)).toBe(expected);
  });

  it('resolves localtest-style userid and partyid attributes and answers on the decision path too', async () => {
    const answer = await ask(
      xacml(['urn:altinn:userid', '20003'], 'read', [
        ['urn:altinn:resource', 'digdir-kunnskapsassistent'],
        ['urn:altinn:partyid', '500010'],
      ]),
      '/authorization/api/v1/decision',
    );

    expect(answer.Response).toEqual([
      {
        Decision: 'NotApplicable',
        Status: { StatusCode: { Value: 'urn:oasis:names:tc:xacml:1.0:status:ok' } },
      },
    ]);
  });

  it('answers Indeterminate with a syntax-error status for a request it cannot read', async () => {
    const answer = await ask({ Request: { AccessSubject: [], Action: [], Resource: [] } });

    expect(answer.Response[0]).toEqual({
      Decision: 'Indeterminate',
      Status: { StatusCode: { Value: 'urn:oasis:names:tc:xacml:1.0:status:syntax-error' } },
    });
  });
});

describe('token verifier with mock tokens', () => {
  it('accepts a token from the picker flow and rejects one from another issuer or for another audience', async () => {
    const { ansattporten, verifier } = setup();
    const flow = await login(ansattporten.app, '45840375084');
    const tokens = await tokensFrom(await flow.exchange(flow.location.searchParams.get('code')));
    const foreign = createMockAnsattporten({ issuer: 'https://evil.test', key, testData: data });
    const otherAudience = createMockAnsattporten({
      issuer: ISSUER,
      key,
      testData: {
        ...data,
        clients: [
          {
            clientId: 'genai-portal',
            redirectUris: ['https://portal.test/callback'],
            audience: OTHER_API,
          },
        ],
      },
    });

    const accepted = await verifier.verify(tokens.access_token ?? '');
    const codes = await Promise.all(
      [
        (await foreign.testTokens('45840375084', 'genai-portal', [KA])).access_token,
        (await otherAudience.testTokens('45840375084', 'genai-portal', [KA])).access_token,
      ].map((t) => verifier.verify(t).catch((e: { code: string }) => e.code)),
    );

    expect(accepted.principal).toMatchObject({
      kind: 'employee',
      tenant: DIGDIR,
      assurance: 'high',
    });
    expect(codes).toEqual(['unknown_issuer', 'invalid_token']);
  });
});
