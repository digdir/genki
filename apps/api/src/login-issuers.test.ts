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
});
