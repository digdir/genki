import { afterEach, describe, expect, it, vi } from 'vitest';
import { identityAuth, keyAuth, recorderAuthOf, signInKeyOf } from './demo-auth.ts';
import { vaultToken } from './demo-elevenlabs.ts';
import { aiToken } from './demo-film.ts';
import { managedIdentityTokenUrl } from './demo.ts';

const audience = 'api://genki-test-api';
const clientId = '6f1c2a4e-8d3b-4f5a-9e7c-1b2d3e4f5a6b';
const identity = {
  IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
  IDENTITY_HEADER: ['header', 'value'].join('-'),
  AZURE_CLIENT_ID: clientId,
};
const accessToken = () => ['eyJ', 'recorder', String(Date.now())].join('.');
const secret = 'https://genki-test-kv.vault.azure.net/secrets/demo-sign-in-key';

const identityEndpoint = (calls: URL[], token: string, expiresOn: number) =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(new URL(String(input)));
    expect(new Headers(init?.headers).get('x-identity-header')).toBe(identity.IDENTITY_HEADER);
    return Response.json({ access_token: token, expires_on: String(expiresOn) });
  }) as typeof fetch;

describe('how the recorder signs in to the API', () => {
  it('sends the recorder key in x-recorder-key', async () => {
    const key = ['opptaker', String(Date.now())].join('-');

    expect(await keyAuth(key)()).toEqual({ 'x-recorder-key': key });
  });

  it('asks its own managed identity, by client id, for a token for the API audience', async () => {
    const calls: URL[] = [];
    const token = accessToken();
    const auth = identityAuth(audience, identity, identityEndpoint(calls, token, 4_000_000_000));

    expect(await auth()).toEqual({ authorization: `Bearer ${token}` });
    expect(calls.map((u) => [u.origin + u.pathname, Object.fromEntries(u.searchParams)])).toEqual([
      [
        identity.IDENTITY_ENDPOINT,
        { resource: audience, 'api-version': '2019-08-01', client_id: clientId },
      ],
    ]);
  });

  it('keeps the token until five minutes before it expires, then asks again', async () => {
    const calls: URL[] = [];
    let clock = 1_000_000_000_000;
    const auth = identityAuth(
      audience,
      identity,
      identityEndpoint(calls, accessToken(), clock / 1000 + 3600),
      () => clock,
    );

    await auth();
    clock += 50 * 60_000;
    await auth();
    clock += 6 * 60_000;
    await auth();

    expect(calls).toHaveLength(2);
  });

  it('fails without the token when the managed identity refuses', async () => {
    const auth = identityAuth(
      audience,
      identity,
      (async () => new Response('no', { status: 400 })) as typeof fetch,
    );

    await expect(auth()).rejects.toThrow('The managed identity answered 400');
  });

  it('uses the key when one is set, the managed identity with an audience, and nothing otherwise', async () => {
    const key = ['opptaker', String(Date.now())].join('-');

    expect(await recorderAuthOf({ DEMO_RECORDER_KEY: key, ...identity })?.()).toEqual({
      'x-recorder-key': key,
    });
    expect(recorderAuthOf({ DEMO_RECORDER_AUDIENCE: audience, ...identity })).toBeDefined();
    expect(recorderAuthOf({ DEMO_RECORDER_AUDIENCE: audience })).toBeUndefined();
    expect(recorderAuthOf(identity)).toBeUndefined();
  });
});

describe('the sign-in key of a recording', () => {
  it('reads DEMO_API_KEY_SECRET from Key Vault once, when DEMO_API_KEY is not set', async () => {
    const value = ['genki', 'test', String(Date.now())].join('_');
    const calls: string[] = [];
    const keyOf = signInKeyOf(
      { DEMO_API_KEY_SECRET: secret },
      () => Promise.resolve(accessToken()),
      (async (input: string | URL | Request) => {
        calls.push(String(input));
        return Response.json({ value });
      }) as typeof fetch,
    );

    expect(await keyOf()).toBe(value);
    expect(await keyOf()).toBe(value);
    expect(calls).toEqual([`${secret}?api-version=7.4`]);
  });

  it('takes DEMO_API_KEY as it is, and has none without either setting', async () => {
    const value = ['genki', 'test', String(Date.now())].join('_');
    const never = (() => {
      throw new Error('Key Vault was called');
    }) as unknown as typeof fetch;

    expect(await signInKeyOf({ DEMO_API_KEY: value }, undefined, never)()).toBe(value);
    expect(await signInKeyOf({}, undefined, never)()).toBeUndefined();
  });

  it('names the setting and the key, never the value, when Key Vault refuses', async () => {
    const keyOf = signInKeyOf(
      { DEMO_API_KEY_SECRET: secret },
      () => Promise.resolve('t'),
      (async () => new Response('forbidden', { status: 403 })) as typeof fetch,
    );
    const wrong = signInKeyOf({ DEMO_API_KEY_SECRET: 'not a url' }, () => Promise.resolve('t'));

    await expect(keyOf()).rejects.toThrow('Key Vault answered 403 for the sign-in key');
    await expect(wrong()).rejects.toThrow('DEMO_API_KEY_SECRET must be a Key Vault secret URL');
  });
});

describe('the recorder identity for speech and Key Vault', () => {
  it('names its own identity by client id when it asks for a speech token', () => {
    expect(managedIdentityTokenUrl(identity.IDENTITY_ENDPOINT, clientId)).toBe(
      `${identity.IDENTITY_ENDPOINT}?resource=https%3A%2F%2Fcognitiveservices.azure.com&api-version=2019-08-01&client_id=${clientId}`,
    );
  });

  it('names its own identity by client id when it asks for a Key Vault token', async () => {
    const calls: URL[] = [];
    const token = accessToken();

    expect(await vaultToken(identity, identityEndpoint(calls, token, 4_000_000_000))).toBe(token);
    expect(calls[0]?.searchParams.get('client_id')).toBe(clientId);
    expect(calls[0]?.searchParams.get('resource')).toBe('https://vault.azure.net');
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names its own identity by client id when it asks for a director token', async () => {
    const calls: URL[] = [];
    const token = accessToken();
    vi.stubGlobal('fetch', identityEndpoint(calls, token, 4_000_000_000));

    expect(await aiToken(identity)).toBe(token);
    expect(calls[0]?.searchParams.get('client_id')).toBe(clientId);
    expect(calls[0]?.searchParams.get('resource')).toBe('https://cognitiveservices.azure.com');
  });
});
