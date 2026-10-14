import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { exportJWK, generateKeyPair, SignJWT, createLocalJWKSet } from 'jose';
import {
  clientGrants,
  createMockMaskinporten,
  createSigningKey,
  createTokenVerifier,
  isUnregisteredClient,
  keyGrantPolicy,
  altinnTokens,
  maskinportenTokens,
  toOrgNo,
} from './index.js';

const MP = 'http://maskinporten.test/';
const DIGDIR = '991825827';

const system: Principal = {
  kind: 'agency-system',
  issuer: MP,
  subject: 'fagsystem',
  tenant: DIGDIR,
  client: 'fagsystem',
  scopes: ['digdir:genai.invoke'],
};

describe('Maskinporten token client', () => {
  it('gets a token with a signed JWT grant and reuses it until it expires', async () => {
    const issuerKey = await createSigningKey('mp');
    const client = await generateKeyPair('RS256', { extractable: true });
    const mock = createMockMaskinporten({
      issuer: MP,
      key: issuerKey,
      audience: 'https://platform.altinn.test',
      testData: {
        systems: [
          {
            clientId: 'genai-pdp',
            consumer: DIGDIR,
            scopes: ['altinn:authorization/authorize'],
            publicKey: await exportJWK(client.publicKey),
          },
        ],
      },
    });
    let calls = 0;
    let clock = Date.now();
    const tokens = maskinportenTokens({
      issuer: MP,
      clientId: 'genai-pdp',
      scope: 'altinn:authorization/authorize',
      privateKey: { ...(await exportJWK(client.privateKey)), alg: 'RS256' },
      now: () => clock,
      fetch: async (url, init) => {
        calls++;
        expect(String(url)).toBe(`${MP}token`);
        return mock.app.request('/token', init as RequestInit);
      },
    });

    const first = await tokens.token();
    const again = await tokens.token();
    clock += 120_000;
    await tokens.token();

    expect(first.split('.')).toHaveLength(3);
    expect(again).toBe(first);
    expect(calls).toBe(2);
  });

  it('fails clearly when Maskinporten refuses the grant', async () => {
    const client = await generateKeyPair('RS256', { extractable: true });
    const tokens = maskinportenTokens({
      issuer: MP,
      clientId: 'ukjent',
      scope: 'altinn:authorization/authorize',
      privateKey: { ...(await exportJWK(client.privateKey)), alg: 'RS256' },
      fetch: async () => new Response('{"error":"invalid_client"}', { status: 400 }),
    });
    await expect(tokens.token()).rejects.toThrow('Maskinporten answered 400');
  });
});

describe('registered Maskinporten clients', () => {
  const allowAll = keyGrantPolicy({ decide: async () => ({ allow: true }) }, (ref) => [
    ref.id.split('/')[1] ?? ref.id,
  ]);
  const capability = (service: string) => ({
    kind: 'capability',
    id: `${DIGDIR}/${service}/default`,
    tenant: DIGDIR,
  });

  it('reach only the services they are registered for', async () => {
    const granted = clientGrants(system, ['veileder']);

    expect((await allowAll.decide(granted, 'invoke', capability('veileder'))).allow).toBe(true);
    expect((await allowAll.decide(granted, 'invoke', capability('klarsprak'))).allow).toBe(false);
    expect(granted.scopes).toContain('legacy:query');
  });

  it('reach every service of the tenant when registered for all', async () => {
    const granted = clientGrants(system, ['*']);
    expect((await allowAll.decide(granted, 'invoke', capability('klarsprak'))).allow).toBe(true);
  });

  it('reach nothing when not registered', async () => {
    const refused = clientGrants({ ...system, scopes: ['legacy:query'] }, undefined);

    expect(isUnregisteredClient(refused)).toBe(true);
    expect(refused.scopes).not.toContain('legacy:query');
    expect((await allowAll.decide(refused, 'invoke', capability('veileder'))).allow).toBe(false);
  });

  it('never takes grants from the token itself', async () => {
    const key = await createSigningKey('mp');
    const verifier = createTokenVerifier({
      issuers: [
        {
          kind: 'maskinporten',
          issuer: MP,
          audience: 'digdir:genai',
          keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        },
      ],
    });
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      client_id: 'fagsystem',
      consumer: toOrgNo(DIGDIR),
      scope: 'digdir:genai.invoke grant:client grant:agent:*',
    })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(MP)
      .setAudience('digdir:genai')
      .setIssuedAt(now)
      .setExpirationTime(now + 60)
      .sign(key.privateKey);

    const { principal } = await verifier.verify(token);

    expect(principal.scopes).toEqual(['digdir:genai.invoke']);
  });
});

describe('Altinn token exchange', () => {
  const jwt = (exp: number) =>
    ['e30', Buffer.from(JSON.stringify({ exp })).toString('base64url'), 'sig'].join('.');

  it('exchanges the Maskinporten token once and reuses the Altinn token until it nearly expires', async () => {
    let clock = 1_000_000_000_000;
    const seen: string[] = [];
    const tokens = altinnTokens({
      baseURL: 'https://platform.tt02.altinn.test/',
      maskinporten: { token: async () => 'mp-token' },
      now: () => clock,
      fetch: async (url, init) => {
        seen.push(`${String(url)} ${new Headers(init?.headers).get('authorization')}`);
        return new Response(JSON.stringify(jwt(clock / 1000 + 600)));
      },
    });

    const first = await tokens.token();
    clock += 500_000;
    expect(await tokens.token()).toBe(first);
    clock += 80_000;
    await tokens.token();

    expect(seen).toEqual([
      'https://platform.tt02.altinn.test/authentication/api/v1/exchange/maskinporten Bearer mp-token',
      'https://platform.tt02.altinn.test/authentication/api/v1/exchange/maskinporten Bearer mp-token',
    ]);
  });

  it('fails when Altinn refuses the exchange', async () => {
    const tokens = altinnTokens({
      baseURL: 'https://platform.tt02.altinn.test',
      maskinporten: { token: async () => 'mp-token' },
      fetch: async () => new Response('', { status: 401 }),
    });

    await expect(tokens.token()).rejects.toThrow('Altinn token exchange answered 401');
  });
});
