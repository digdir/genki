import { describe, expect, it } from 'vitest';
import { altinnEnvironmentProblems } from './altinn-environment.js';

const production = {
  ALTINN_PDP_URL: 'https://platform.altinn.no',
  MASKINPORTEN_ISSUER: 'https://maskinporten.no/',
  ANSATTPORTEN_ISSUER: 'https://ansattporten.no',
};

describe('Altinn environment pairing', () => {
  it('accepts production Altinn with production Maskinporten and Ansattporten', () => {
    expect(altinnEnvironmentProblems(production)).toEqual([]);
  });

  it('accepts tt02 with test Maskinporten and test Ansattporten', () => {
    expect(
      altinnEnvironmentProblems({
        ALTINN_PDP_URL: 'https://platform.tt02.altinn.no/',
        MASKINPORTEN_ISSUER: 'https://test.maskinporten.no/',
        ANSATTPORTEN_ISSUER: 'https://test.ansattporten.no',
      }),
    ).toEqual([]);
  });

  it('refuses production Altinn with test Maskinporten', () => {
    expect(
      altinnEnvironmentProblems({
        ...production,
        MASKINPORTEN_ISSUER: 'https://test.maskinporten.no/',
      }),
    ).toEqual([expect.stringContaining('set MASKINPORTEN_ISSUER to https://maskinporten.no/')]);
  });

  it('refuses production Altinn with a token address left on test Maskinporten', () => {
    expect(
      altinnEnvironmentProblems({
        ...production,
        MASKINPORTEN_TOKEN_URL: 'https://test.maskinporten.no/token',
      }),
    ).toEqual([expect.stringContaining('MASKINPORTEN_TOKEN_URL is test Maskinporten')]);
  });

  it('refuses tt02 behind production Ansattporten', () => {
    expect(
      altinnEnvironmentProblems({
        ...production,
        ALTINN_PDP_URL: 'https://platform.tt02.altinn.no',
        MASKINPORTEN_ISSUER: 'https://test.maskinporten.no/',
      }),
    ).toEqual([expect.stringContaining('set ALTINN_PDP_URL to https://platform.altinn.no')]);
  });

  it('checks the people list address as it checks the decision point', () => {
    expect(
      altinnEnvironmentProblems({
        ...production,
        ALTINN_PEOPLE_URL: 'https://platform.tt02.altinn.no/',
      }),
    ).toEqual([
      expect.stringContaining('ALTINN_PEOPLE_URL is test Altinn but MASKINPORTEN_ISSUER'),
      expect.stringContaining('ALTINN_PEOPLE_URL is test Altinn but ANSATTPORTEN_ISSUER'),
    ]);
  });

  it('leaves addresses it does not know alone, such as a local mock', () => {
    expect(
      altinnEnvironmentProblems({
        ALTINN_PDP_URL: 'http://localhost:8080/mock/altinn',
        MASKINPORTEN_ISSUER: 'https://test.maskinporten.no/',
        ANSATTPORTEN_ISSUER: 'https://ansattporten.no',
      }),
    ).toEqual([]);
    expect(altinnEnvironmentProblems({ ALTINN_PDP_URL: 'https://platform.altinn.no' })).toEqual([]);
    expect(altinnEnvironmentProblems({ ...production, ALTINN_PDP_URL: 'not a url' })).toEqual([]);
  });
});
