import { beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { createLocalJWKSet, SignJWT, type JWTPayload } from 'jose';
import {
  apiKeyDigest,
  cachedAltinnAuthorization,
  createAuthenticator,
  createSigningKey,
  createTokenVerifier,
  InMemoryApiKeys,
  InMemoryIdentities,
  keyAllows,
  keyReaches,
  LEGACY_KEY_ISSUER,
  type AltinnAuthorization,
  type AltinnDecision,
  type AltinnDecisionRequest,
  type SigningKey,
  type StoredApiKey,
  type TrustedIssuer,
} from './index.js';

const TID = '00000000-0000-4000-8000-0000000d1d17';
const ENTRA = `https://login.microsoftonline.com/${TID}/v2.0`;
const AP = 'http://ansattporten.test';
const API = 'api://genai-platform';
const DIGDIR = '991825827';
const NAV = '889640782';
const anonymous: Principal = { kind: 'citizen', issuer: 'none', subject: 'none' };
const KA_KEY = 'rag_' + 'a'.repeat(64);

let key: SigningKey;
let other: SigningKey;
let issuers: TrustedIssuer[];

const sign = async (
  payload: JWTPayload,
  opts: { iss?: string; aud?: string; with?: SigningKey; exp?: string } = {},
) =>
  new SignJWT(payload)
    .setProtectedHeader({ alg: 'RS256', kid: (opts.with ?? key).kid })
    .setIssuer(opts.iss ?? ENTRA)
    .setAudience(opts.aud ?? API)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign((opts.with ?? key).privateKey);

const operatorClaims = (extra: JWTPayload = {}): JWTPayload => ({
  tid: TID,
  oid: 'oid-operator-1',
  sub: 'pairwise-sub',
  scp: 'access_as_user',
  roles: ['GenAI.Operator'],
  ...extra,
});

beforeAll(async () => {
  key = await createSigningKey('k1');
  other = await createSigningKey('k1');
  const keys = createLocalJWKSet({ keys: [key.publicJwk] });
  issuers = [
    {
      kind: 'entra',
      issuer: ENTRA,
      tenantId: TID,
      audience: API,
      keys,
      roles: { 'GenAI.Operator': 'operator', 'GenAI.Support': 'support' },
    },
    { kind: 'ansattporten', issuer: AP, audience: API, keys },
  ];
});

const verifier = () => createTokenVerifier({ issuers });

describe('Entra ID operators', () => {
  it('maps app roles to an operator principal without a tenant', async () => {
    const { principal } = await verifier().verify(
      await sign(operatorClaims({ roles: ['GenAI.Operator', 'GenAI.Support', 'Other.Role'] })),
    );

    expect(principal).toMatchObject({
      kind: 'operator',
      issuer: ENTRA,
      subject: 'oid-operator-1',
      assurance: 'entraid',
      roles: ['operator', 'support'],
    });
    expect(principal.tenant).toBeUndefined();
  });

  it.each([
    [
      'another Entra tenant',
      operatorClaims({ tid: '11111111-1111-4111-8111-111111111111' }),
      /another Entra tenant/,
    ],
    ['no platform role', operatorClaims({ roles: ['Other.Role'] }), /no platform role/],
    [
      'a prototype key as role',
      operatorClaims({ roles: ['toString', '__proto__'] }),
      /no platform role/,
    ],
    ['an application token', operatorClaims({ scp: undefined }), /application tokens/],
    ['no oid', operatorClaims({ oid: undefined }), /missing oid/],
  ])('refuses a token with %s', async (_name, claims, message) => {
    await expect(verifier().verify(await sign(claims))).rejects.toThrow(message);
  });

  it('refuses a wrong audience, a foreign signature and a token from an untrusted Entra tenant', async () => {
    await expect(
      verifier().verify(await sign(operatorClaims(), { aud: 'api://someone-else' })),
    ).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(
      verifier().verify(await sign(operatorClaims(), { with: other })),
    ).rejects.toMatchObject({ code: 'invalid_token' });
    await expect(
      verifier().verify(
        await sign(operatorClaims(), {
          iss: 'https://login.microsoftonline.com/11111111-1111-4111-8111-111111111111/v2.0',
        }),
      ),
    ).rejects.toMatchObject({ code: 'unknown_issuer' });
  });
});

describe('Altinn decision cache', () => {
  const request = (personId = '45840375084', party = DIGDIR): AltinnDecisionRequest => ({
    subject: { personId },
    action: 'read',
    resource: 'urn:altinn:resource:digdir-kunnskapsassistent',
    party,
  });

  const counting = (answers: (AltinnDecision | Error)[]) => {
    let calls = 0;
    const inner: AltinnAuthorization = {
      decide: async () => {
        const answer = answers[Math.min(calls, answers.length - 1)] as AltinnDecision | Error;
        calls += 1;
        if (answer instanceof Error) throw answer;
        return answer;
      },
    };
    return { inner, calls: () => calls };
  };

  it('keeps a Permit for the configured time and asks again after it', async () => {
    let t = 0;
    const { inner, calls } = counting(['Permit', 'Deny']);
    const cache = cachedAltinnAuthorization(inner, { permitSeconds: 60, now: () => t });

    expect(await cache.decide(request())).toBe('Permit');
    t = 59_000;
    expect(await cache.decide(request())).toBe('Permit');
    t = 60_001;
    expect(await cache.decide(request())).toBe('Deny');
    expect(calls()).toBe(2);
  });

  it('keeps a Deny only briefly, never caches Indeterminate or errors', async () => {
    let t = 0;
    const deny = counting(['Deny', 'Permit']);
    const cache = cachedAltinnAuthorization(deny.inner, { denySeconds: 5, now: () => t });
    await cache.decide(request());
    t = 5_001;
    expect(await cache.decide(request())).toBe('Permit');

    const flaky = counting(['Indeterminate', new Error('down'), 'Permit']);
    const second = cachedAltinnAuthorization(flaky.inner, { now: () => 0 });
    expect(await second.decide(request())).toBe('Indeterminate');
    await expect(second.decide(request())).rejects.toThrow('down');
    expect(await second.decide(request())).toBe('Permit');
  });

  it('never answers one subject, party or action with another one’s decision', async () => {
    const { inner, calls } = counting(['Permit', 'Deny', 'Deny', 'Deny']);
    const cache = cachedAltinnAuthorization(inner, { now: () => 0 });

    await cache.decide(request());
    expect(await cache.decide(request('12345678901'))).toBe('Deny');
    expect(await cache.decide(request('45840375084', NAV))).toBe('Deny');
    expect(await cache.decide({ ...request(), action: 'write' })).toBe('Deny');
    expect(calls()).toBe(4);
  });

  it('refuses a Permit time outside 60 to 300 seconds and a long Deny time', () => {
    const { inner } = counting(['Permit']);
    expect(() => cachedAltinnAuthorization(inner, { permitSeconds: 30 })).toThrow(RangeError);
    expect(() => cachedAltinnAuthorization(inner, { permitSeconds: 301 })).toThrow(RangeError);
    expect(() => cachedAltinnAuthorization(inner, { denySeconds: 60 })).toThrow(RangeError);
  });
});

const stored = (extra: Partial<StoredApiKey> = {}): StoredApiKey => ({
  id: 'key-ka',
  name: 'Kunnskapsassistenten',
  digest: apiKeyDigest(KA_KEY),
  tenant: DIGDIR,
  scopes: ['query'],
  datasets: [],
  agents: [],
  ...extra,
});

const keys = (...entries: StoredApiKey[]) => {
  const store = new InMemoryApiKeys();
  for (const e of entries) store.add(e);
  return store;
};

describe('API keys', () => {
  it('uses the same SHA-256 hex digest as headless-rag', () => {
    expect(apiKeyDigest('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('turns a valid key into a tenant principal with its grants, from X-API-Key or Bearer', async () => {
    const auth = createAuthenticator({
      apiKeys: keys(stored({ clientId: 'ka', agents: ['*'], datasets: ['*'] })),
    });

    const viaHeader = await auth.authenticate(
      new Request('https://api.test', { headers: { 'x-api-key': KA_KEY } }),
    );
    const viaBearer = await auth.authenticate(
      new Request('https://api.test', { headers: { authorization: `Bearer ${KA_KEY}` } }),
    );

    expect(viaHeader).toMatchObject({
      method: 'api-key',
      principal: {
        kind: 'agency-system',
        issuer: LEGACY_KEY_ISSUER,
        subject: 'key-ka',
        tenant: DIGDIR,
        client: 'ka',
        scopes: ['legacy:query', 'grant:agent:*', 'grant:dataset:*'],
      },
      grants: { keyId: 'key-ka' },
    });
    expect(viaBearer?.principal).toEqual(viaHeader?.principal);
  });

  it.each([
    ['an unknown key', [stored()], 'rag_' + 'b'.repeat(64)],
    ['a revoked key', [stored({ revokedAt: '2026-01-01T00:00:00Z' })], KA_KEY],
    ['an expired key', [stored({ expiresAt: '2026-01-01T00:00:00Z' })], KA_KEY],
    [
      'a key without a tenant',
      [{ ...stored(), tenant: undefined } as unknown as StoredApiKey],
      KA_KEY,
    ],
    ['a key with a malformed tenant', [stored({ tenant: 'digdir' })], KA_KEY],
  ])('rejects %s', async (_name, entries, presented) => {
    const auth = createAuthenticator({
      apiKeys: keys(...entries),
      now: () => new Date('2026-10-06T12:00:00Z'),
    });

    const result = await auth.check(
      new Request('https://api.test', { headers: { 'x-api-key': presented } }),
    );

    expect(result).toMatchObject({ ok: false, status: 401 });
  });

  it('treats grants as a ceiling, and an empty grant list as nothing', () => {
    const scoped = {
      keyId: 'b',
      scopes: ['query' as const],
      datasets: ['digdir/kudos'],
      agents: ['ka-agent'],
      skillGraphs: [],
      allowedConfigKeys: [],
    };
    const empty = {
      keyId: 'c',
      scopes: ['query' as const],
      datasets: [],
      agents: [],
      skillGraphs: [],
      allowedConfigKeys: [],
    };

    expect(keyAllows(scoped, { scope: 'query', dataset: 'digdir/kudos', agent: 'ka-agent' })).toBe(
      true,
    );
    expect(keyAllows(scoped, { scope: 'query', dataset: 'nav/internal' })).toBe(false);
    expect(keyAllows(scoped, { scope: 'query', agent: 'other' })).toBe(false);
    expect(keyAllows(scoped, { scope: 'query' })).toBe(false);
    expect(keyAllows(empty, { scope: 'query', dataset: 'digdir/kudos' })).toBe(false);
  });

  it('gives a key with no grants nothing', async () => {
    const auth = createAuthenticator({ apiKeys: keys(stored()) });
    const identity = await auth.authenticate(
      new Request('https://api.test', { headers: { 'x-api-key': KA_KEY } }),
    );
    expect(identity?.principal.scopes).toEqual(['legacy:query']);
    expect(keyReaches(identity?.principal ?? anonymous, 'query', { agents: ['ka-agent'] })).toBe(
      false,
    );
  });

  it('confines a key bound to a service to that service and tenant', async () => {
    const auth = createAuthenticator({
      apiKeys: keys(stored({ service: 'kunnskapsassistenten' })),
    });
    const found = await auth.authenticate(
      new Request('https://api.test', { headers: { 'x-api-key': KA_KEY } }),
    );
    expect(found?.principal.confinedTo).toEqual({
      tenant: DIGDIR,
      service: 'kunnskapsassistenten',
    });
  });

  it('carries the grants on the principal, so a copy of the principal keeps the ceiling', async () => {
    const auth = createAuthenticator({
      apiKeys: keys(stored({ agents: ['ki-veilederen__default'] })),
    });
    const found = await auth.authenticate(
      new Request('https://api.test', { headers: { 'x-api-key': KA_KEY } }),
    );
    const copy = { ...(found?.principal ?? anonymous), tenant: DIGDIR };

    expect(keyReaches(copy, 'query', { agents: ['ki-veilederen__default'] })).toBe(true);
    expect(keyReaches(copy, 'query', { agents: ['klarsprak__default'] })).toBe(false);
    expect(keyReaches(copy, 'query', { datasets: ['digdir/kudos'] })).toBe(false);
    expect(keyReaches(copy, 'admin', { agents: ['ki-veilederen__default'] })).toBe(false);
  });

  it('lets a key with the all grant reach every service and dataset', async () => {
    const auth = createAuthenticator({
      apiKeys: keys(stored({ agents: ['*'], datasets: ['*'] })),
    });
    const found = await auth.authenticate(
      new Request('https://api.test', { headers: { 'x-api-key': KA_KEY } }),
    );

    expect(
      keyReaches(found?.principal ?? anonymous, 'query', { agents: ['klarsprak__default'] }),
    ).toBe(true);
    expect(keyReaches(found?.principal ?? anonymous, 'query', { datasets: ['digdir/kudos'] })).toBe(
      true,
    );
  });
});

describe('authenticate', () => {
  const employeeToken = (orgs: string[]) =>
    sign(
      {
        sub: 'pairwise-kari',
        pid: '45840375084',
        acr: 'substantial',
        authorization_details: [
          {
            type: 'ansattporten:altinn:resource',
            resource: 'urn:altinn:resource:digdir-kunnskapsassistent',
            authorized_parties: orgs.map((o) => ({
              orgno: { authority: 'iso6523-actorid-upis', ID: `0192:${o}` },
              actions: ['read'],
            })),
          },
        ],
      },
      { iss: AP },
    );

  it('verifies bearer tokens, remembers the person id, and picks the organisation from the acting-for header', async () => {
    const identities = new InMemoryIdentities();
    const auth = createAuthenticator({
      verifier: verifier(),
      onVerified: (v) => identities.remember(v),
    });
    const token = await employeeToken([DIGDIR, NAV]);

    const chosen = await auth.authenticate(
      new Request('https://api.test', {
        headers: { authorization: `Bearer ${token}`, 'genai-acting-for': NAV },
      }),
    );
    const unchosen = await auth.authenticate(
      new Request('https://api.test', { headers: { authorization: `Bearer ${token}` } }),
    );

    expect(chosen?.principal.tenant).toBe(NAV);
    expect(chosen?.personId).toBe('45840375084');
    expect(unchosen?.principal.tenant).toBeUndefined();
    expect(await identities.personId(AP, 'pairwise-kari')).toBe('45840375084');
  });

  it('answers 403 when acting for an organisation the login does not cover', async () => {
    const auth = createAuthenticator({ verifier: verifier(), apiKeys: keys(stored()) });
    const token = await employeeToken([DIGDIR]);

    const employee = await auth.check(
      new Request('https://api.test', {
        headers: { authorization: `Bearer ${token}`, 'genai-acting-for': NAV },
      }),
    );
    const key = await auth.check(
      new Request('https://api.test', {
        headers: { 'x-api-key': KA_KEY, 'genai-acting-for': NAV },
      }),
    );

    expect(employee).toEqual({ ok: false, status: 403, code: 'not_authorized_for_org' });
    expect(key).toEqual({ ok: false, status: 403, code: 'not_authorized_for_org' });
  });

  it('never falls back to the key store when a token fails, and refuses mixed credentials', async () => {
    const store = keys(stored());
    const auth = createAuthenticator({ verifier: verifier(), apiKeys: store });
    const forged = await sign(operatorClaims(), { with: other });

    expect(
      await auth.check(
        new Request('https://api.test', { headers: { authorization: `Bearer ${forged}` } }),
      ),
    ).toMatchObject({ ok: false, status: 401 });
    expect(
      await auth.check(
        new Request('https://api.test', {
          headers: { authorization: `Bearer ${await sign(operatorClaims())}`, 'x-api-key': KA_KEY },
        }),
      ),
    ).toEqual({ ok: false, status: 401, code: 'ambiguous_credentials' });
    expect(await auth.check(new Request('https://api.test'))).toEqual({
      ok: false,
      status: 401,
      code: 'missing_credentials',
    });
  });

  it('gives operators their roles and no tenant', async () => {
    const auth = createAuthenticator({ verifier: verifier() });
    const principal = await auth.principalOf(
      new Request('https://api.test', {
        headers: { authorization: `Bearer ${await sign(operatorClaims())}` },
      }),
    );
    expect(principal).toMatchObject({ kind: 'operator', roles: ['operator'] });
    expect(principal?.tenant).toBeUndefined();
  });
});
