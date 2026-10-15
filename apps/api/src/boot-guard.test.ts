import { describe, expect, it } from 'vitest';
import { bootProblems } from './boot-guard.js';

const real = {
  ANSATTPORTEN_ISSUER: 'https://ansattporten.no',
  DATABASE_URL: 'postgres://db/genai',
  ALTINN_PDP_URL: 'https://platform.altinn.no',
};
const dev = { GENAI_DEV_MODE: 'true' };

describe('booting the API', () => {
  it('refuses to start without an identity provider unless dev mode is on', () => {
    const rest = { DATABASE_URL: real.DATABASE_URL, ALTINN_PDP_URL: real.ALTINN_PDP_URL };
    expect(bootProblems(rest)).toEqual([expect.stringContaining('ANSATTPORTEN_ISSUER')]);
    expect(bootProblems({ ...rest, GENAI_DEV_MODE: 'false' })).toEqual([
      expect.stringContaining('GENAI_DEV_MODE=true'),
    ]);
    expect(bootProblems({ ...dev, DATABASE_URL: real.DATABASE_URL })).toEqual([]);
  });

  it('uses the mock Altinn rights only in dev mode', () => {
    const rest = { ANSATTPORTEN_ISSUER: real.ANSATTPORTEN_ISSUER, DATABASE_URL: real.DATABASE_URL };
    expect(bootProblems(rest)).toEqual([expect.stringContaining('ALTINN_PDP_URL')]);
    expect(bootProblems({ ...dev, ...rest })).toEqual([]);
  });

  it('refuses to start without a database unless dev mode is on', () => {
    const rest = {
      ANSATTPORTEN_ISSUER: real.ANSATTPORTEN_ISSUER,
      ALTINN_PDP_URL: real.ALTINN_PDP_URL,
    };
    expect(bootProblems(rest)).toEqual([expect.stringContaining('DATABASE_URL')]);
    expect(bootProblems({ ...dev, ...rest })).toEqual([]);
  });

  it('refuses to start with a malformed PLATFORM_TENANT, also in dev mode', () => {
    expect(bootProblems({ ...real, PLATFORM_TENANT: '12345' })).toEqual([
      expect.stringContaining('PLATFORM_TENANT'),
    ]);
    expect(bootProblems({ ...dev, PLATFORM_TENANT: 'digdir' })).toEqual([
      expect.stringContaining('PLATFORM_TENANT'),
    ]);
    expect(bootProblems({ ...real, PLATFORM_TENANT: '213192752' })).toEqual([]);
  });

  it('refuses to start when LOCKDOWN_ENTRA_GROUPS lists something that is not a group id', () => {
    const groups = '0f0e0d0c-0b0a-4908-8706-050403020100, Digdir-ansatte';

    expect(bootProblems({ ...real, LOCKDOWN_ENTRA_GROUPS: groups })).toEqual([
      expect.stringContaining('Digdir-ansatte'),
    ]);
    expect(
      bootProblems({ ...real, LOCKDOWN_ENTRA_GROUPS: '0f0e0d0c-0b0a-4908-8706-050403020100' }),
    ).toEqual([]);
    expect(bootProblems({ ...real, LOCKDOWN_ENTRA_EMAIL_DOMAIN: 'not a domain' })).toEqual([
      expect.stringContaining('LOCKDOWN_ENTRA_EMAIL_DOMAIN'),
    ]);
  });

  it('names every missing setting when none is set', () => {
    const problems = bootProblems({});
    expect(problems).toHaveLength(3);
    expect(problems.join(' ')).toMatch(/ANSATTPORTEN_ISSUER.*DATABASE_URL.*ALTINN_PDP_URL/);
  });

  it('counts Maskinporten as an identity provider only with both the issuer and the key set', () => {
    const env = { DATABASE_URL: real.DATABASE_URL, ALTINN_PDP_URL: real.ALTINN_PDP_URL };
    expect(bootProblems({ ...env, MASKINPORTEN_ISSUER: 'https://maskinporten.no' })).toHaveLength(
      1,
    );
    expect(
      bootProblems({
        ...env,
        MASKINPORTEN_ISSUER: 'https://maskinporten.no',
        MASKINPORTEN_JWKS_URI: 'https://maskinporten.no/jwk',
      }),
    ).toEqual([]);
  });

  it('starts with real identity settings and a database', () => {
    expect(bootProblems(real)).toEqual([]);
    expect(bootProblems({ ...real, GENAI_ENV: 'production' })).toEqual([]);
  });

  it('refuses dev mode in production, under NODE_ENV or GENAI_ENV', () => {
    for (const flag of [{ NODE_ENV: 'production' }, { GENAI_ENV: 'production' }])
      expect(bootProblems({ ...flag, ...dev, ...real })).toEqual([
        expect.stringContaining('GENAI_DEV_MODE'),
      ]);
  });
});
