import { describe, expect, it } from 'vitest';
import { exportJWK, generateKeyPair } from 'jose';
import { altinnPdpFrom } from './altinn-pdp.js';

const testData = {
  organisations: [{ orgno: '991825827', name: 'Digitaliseringsdirektoratet' }],
  persons: [
    {
      pid: '01017012345',
      name: 'Kari Testansatt',
      parties: [
        {
          orgno: '991825827',
          resources: { 'urn:altinn:resource:digdir-genai-platform': ['use-services'] },
        },
      ],
    },
  ],
};

const request = {
  subject: { personId: '01017012345' },
  action: 'use-services',
  resource: 'urn:altinn:resource:digdir-genai-platform',
  party: '991825827',
};

const realEnv = async () => {
  const { privateKey } = await generateKeyPair('RS256', { extractable: true });
  return {
    ALTINN_PDP_URL: 'https://platform.tt02.altinn.test/',
    ALTINN_SUBSCRIPTION_KEY: 'abonnement',
    ALTINN_PDP_MASKINPORTEN_CLIENT_ID: 'genai-pdp',
    ALTINN_PDP_MASKINPORTEN_KEY: JSON.stringify({ ...(await exportJWK(privateKey)), alg: 'RS256' }),
    MASKINPORTEN_ISSUER: 'https://test.maskinporten.test/',
  };
};

describe('Altinn PDP by configuration', () => {
  it('uses the mock Altinn rights only in dev mode', async () => {
    const noNetwork = async () => {
      throw new Error('no network in tests');
    };
    expect(() => altinnPdpFrom({}, testData, noNetwork)).toThrow(/ALTINN_PDP_URL/);
    expect(() => altinnPdpFrom({ GENAI_DEV_MODE: 'false' }, testData, noNetwork)).toThrow(
      /ALTINN_PDP_URL/,
    );

    const choice = altinnPdpFrom({ GENAI_DEV_MODE: 'true' }, testData, noNetwork);

    expect(choice.kind).toBe('mock');
    expect(await choice.authorization.decide(request)).toBe('Permit');
  });

  it('exchanges the Maskinporten token for an Altinn token and asks the PDP with it and the subscription key', async () => {
    const calls: { url: string; headers: Headers }[] = [];
    const choice = altinnPdpFrom(await realEnv(), testData, async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init?.headers) });
      if (String(url).endsWith('/token'))
        return Response.json({ access_token: 'mp-token', expires_in: 120 });
      if (String(url).endsWith('/exchange/maskinporten')) return new Response('"altinn-token"');
      return Response.json({
        Response: [{ Decision: 'Deny', Status: { StatusCode: { Value: 'ok' } } }],
      });
    });

    const decision = await choice.authorization.decide(request);

    expect(choice.kind).toBe('altinn');
    expect(decision).toBe('Deny');
    expect(calls.map((c) => c.url)).toEqual([
      'https://test.maskinporten.test/token',
      'https://platform.tt02.altinn.test/authentication/api/v1/exchange/maskinporten',
      'https://platform.tt02.altinn.test/authorization/api/v1/authorize',
    ]);
    expect(calls[1]?.headers.get('authorization')).toBe('Bearer mp-token');
    expect(calls[2]?.headers.get('authorization')).toBe('Bearer altinn-token');
    expect(calls[2]?.headers.get('ocp-apim-subscription-key')).toBe('abonnement');
  });

  it('reads the decision from the camel-case response Altinn tt02 sends', async () => {
    const choice = altinnPdpFrom(await realEnv(), testData, async (url) => {
      if (String(url).endsWith('/token'))
        return Response.json({ access_token: 'mp-token', expires_in: 120 });
      if (String(url).endsWith('/exchange/maskinporten')) return new Response('"altinn-token"');
      return Response.json({
        response: [
          {
            decision: 'Permit',
            status: { statusCode: { value: 'urn:oasis:names:tc:xacml:1.0:status:ok' } },
          },
        ],
      });
    });

    expect(await choice.authorization.decide(request)).toBe('Permit');
  });

  it('refuses to start with half the real PDP configuration', () => {
    expect(() =>
      altinnPdpFrom({ ALTINN_PDP_URL: 'https://platform.tt02.altinn.test' }, testData),
    ).toThrow(/ALTINN_SUBSCRIPTION_KEY/);
  });

  it('refuses a private key that is not a JWK without echoing it', async () => {
    const env = { ...(await realEnv()), ALTINN_PDP_MASKINPORTEN_KEY: 'hemmelig-verdi' };
    expect(() => altinnPdpFrom(env, testData)).toThrow(/must be a private JWK/);
    expect(() => altinnPdpFrom(env, testData)).not.toThrow(/hemmelig-verdi/);
  });
});
