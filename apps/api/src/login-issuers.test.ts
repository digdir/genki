import { describe, expect, it } from 'vitest';
import { InMemoryClients, type IdentityTestDataInput } from '@genai/identity';
import { clientRegistry } from './frontends.js';
import { loginIssuers } from './login-issuers.js';

const options = (env: Record<string, string | undefined>) => ({
  env,
  port: 8123,
  audience: 'digdir:genai',
  testData: { organisations: [], persons: [] } as unknown as IdentityTestDataInput,
  registeredClients: clientRegistry(new InMemoryClients()),
});

describe('login issuers', () => {
  it('dev mode mounts the mock login', async () => {
    const { trusted, mock } = await loginIssuers(options({ GENAI_DEV_MODE: 'true' }));
    expect(mock).toBeDefined();
    expect(trusted).toEqual([
      expect.objectContaining({
        kind: 'ansattporten',
        issuer: 'http://localhost:8123/mock/ansattporten',
      }),
    ]);
  });

  it('never mounts the mock login without dev mode', async () => {
    const { trusted, mock } = await loginIssuers(options({}));
    expect(mock).toBeUndefined();
    expect(trusted).toEqual([]);
  });

  it('trusts the real Ansattporten instead of the mock when its issuer is set, even in dev mode', async () => {
    const { trusted, mock } = await loginIssuers(
      options({ GENAI_DEV_MODE: 'true', ANSATTPORTEN_ISSUER: 'https://ansattporten.no' }),
    );
    expect(mock).toBeUndefined();
    expect(trusted).toEqual([
      expect.objectContaining({ kind: 'ansattporten', issuer: 'https://ansattporten.no' }),
    ]);
  });

  it('reports the login keys it cannot fetch, with the issuer and the answer', async () => {
    const reported: Record<string, unknown>[] = [];
    const { trusted } = await loginIssuers({
      ...options({ ANSATTPORTEN_ISSUER: 'https://ansattporten.no' }),
      fetch: async () => new Response('down', { status: 503 }),
      onKeysNotFetched: (fields) => reported.push(fields),
    });
    const keys = trusted[0]?.keys as (header: object, token: object) => Promise<unknown>;
    await expect(keys({ alg: 'RS256' }, {})).rejects.toThrow('503');
    expect(reported).toEqual([
      { issuer: 'https://ansattporten.no', uri: 'https://ansattporten.no/jwks.json', status: 503 },
    ]);
  });

  it('reports login keys that cannot be reached at all', async () => {
    const reported: Record<string, unknown>[] = [];
    const { trusted } = await loginIssuers({
      ...options({ ANSATTPORTEN_ISSUER: 'https://ansattporten.no' }),
      fetch: async () => {
        throw new TypeError('fetch failed');
      },
      onKeysNotFetched: (fields) => reported.push(fields),
    });
    const keys = trusted[0]?.keys as (header: object, token: object) => Promise<unknown>;
    await expect(keys({ alg: 'RS256' }, {})).rejects.toThrow('fetch failed');
    expect(reported).toEqual([
      {
        issuer: 'https://ansattporten.no',
        uri: 'https://ansattporten.no/jwks.json',
        error: 'TypeError: fetch failed',
      },
    ]);
  });
});
