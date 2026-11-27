import { describe, expect, it } from 'vitest';
import { bootProblems, knowledgeServerProblems } from './boot-guard.js';

const real = {
  ANSATTPORTEN_ISSUER: 'https://ansattporten.no',
  DATABASE_URL: 'postgres://db/genai',
  ALTINN_PDP_URL: 'https://platform.altinn.no',
  EMPLOYEE_CLIENT_IDS: 'genki-portal,genki-console',
};
const dev = { GENAI_DEV_MODE: 'true' };
const platformLogin = {
  PLATFORM_LOGIN_CLIENT_ID: 'c0e4a5af-b2e1-4bba-9324-4caf55be8db5',
  PLATFORM_APP_ORIGINS: 'https://portal.genki.digdir.cloud',
};

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
    const rest = {
      ANSATTPORTEN_ISSUER: real.ANSATTPORTEN_ISSUER,
      EMPLOYEE_CLIENT_IDS: real.EMPLOYEE_CLIENT_IDS,
      DATABASE_URL: real.DATABASE_URL,
    };
    expect(bootProblems(rest)).toEqual([expect.stringContaining('ALTINN_PDP_URL')]);
    expect(bootProblems({ ...dev, ...rest })).toEqual([]);
  });

  it('refuses Altinn from another environment than its Maskinporten, also in dev mode', () => {
    const mixed = { ...real, MASKINPORTEN_ISSUER: 'https://test.maskinporten.no/' };
    expect(bootProblems(mixed)).toEqual([expect.stringContaining('MASKINPORTEN_ISSUER')]);
    expect(bootProblems({ ...dev, ...mixed })).toEqual([
      expect.stringContaining('MASKINPORTEN_ISSUER'),
    ]);
  });

  it('startup refuses GENAI_MOCK_RIGHTS outside dev mode', () => {
    expect(bootProblems({ ...real, GENAI_MOCK_RIGHTS: 'true' })).toEqual([
      expect.stringContaining('GENAI_MOCK_RIGHTS'),
    ]);
    expect(bootProblems({ ...dev, ...real, GENAI_MOCK_RIGHTS: 'true' })).toEqual([]);
  });

  it('refuses GENAI_FLAGS outside dev mode, so no flag is on for everyone in a shared environment', () => {
    expect(bootProblems({ ...real, GENAI_FLAGS: 'blockStudio' })).toEqual([
      expect.stringContaining('GENAI_FLAGS'),
    ]);
    expect(bootProblems({ ...real, GENAI_ENV: 'test', GENAI_FLAGS: 'blockStudio' })).toEqual([
      expect.stringContaining('GENAI_FLAGS'),
    ]);
    expect(bootProblems({ ...dev, ...real, GENAI_FLAGS: 'blockStudio' })).toEqual([]);
  });

  it('refuses a GENAI_FLAGS key that is not registered, also in dev mode', () => {
    expect(bootProblems({ ...dev, ...real, GENAI_FLAGS: 'blockStudio,blokkStudio' })).toEqual([
      expect.stringContaining('blokkStudio'),
    ]);
  });

  it('refuses to start without a database unless dev mode is on', () => {
    const rest = {
      ANSATTPORTEN_ISSUER: real.ANSATTPORTEN_ISSUER,
      EMPLOYEE_CLIENT_IDS: real.EMPLOYEE_CLIENT_IDS,
      ALTINN_PDP_URL: real.ALTINN_PDP_URL,
    };
    expect(bootProblems(rest)).toEqual([expect.stringContaining('DATABASE_URL')]);
    expect(bootProblems({ ...dev, ...rest })).toEqual([]);
  });

  it('refuses to start outside dev mode with Ansattporten configured and no trusted employee clients', () => {
    const untrusted = { ...real, EMPLOYEE_CLIENT_IDS: undefined };
    expect(bootProblems(untrusted)).toEqual([expect.stringContaining('EMPLOYEE_CLIENT_IDS')]);
    expect(bootProblems({ ...untrusted, EMPLOYEE_CLIENT_IDS: ' , ' })).toEqual([
      expect.stringContaining('EMPLOYEE_CLIENT_IDS'),
    ]);
    expect(bootProblems(real)).toEqual([]);
    expect(bootProblems(dev)).toEqual([]);
  });

  it('starts without EMPLOYEE_CLIENT_IDS when the portal and console sign in through the platform login', () => {
    const untrusted = { ...real, EMPLOYEE_CLIENT_IDS: undefined };
    expect(
      bootProblems({
        ...untrusted,
        PLATFORM_LOGIN_CLIENT_ID: 'genki-platform-login',
        PLATFORM_APP_ORIGINS: 'portal=https://portal.example.no',
      }),
    ).toEqual([]);
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

  it('starts without Altinn when member or operator groups give the rights', () => {
    const withoutAltinn = { ...real, ...platformLogin, ALTINN_PDP_URL: '' };

    expect(
      bootProblems({
        ...withoutAltinn,
        MEMBER_ENTRA_GROUPS: '789b5488-39ec-47b3-9217-840e5cd957fd',
      }),
    ).toEqual([]);
    expect(
      bootProblems({
        ...withoutAltinn,
        OPERATOR_ENTRA_GROUPS: '76d10637-d517-413c-a10b-84675a3ed64b',
      }),
    ).toEqual([]);
  });

  it('refuses to start without Altinn when only the service group is set', () => {
    const withoutAltinn = { ...real, ALTINN_PDP_URL: '' };

    expect(
      bootProblems({
        ...withoutAltinn,
        SERVICE_ENTRA_GROUPS: '30a76637-d1ff-4040-bc1f-fb9b8ccd749c',
      }),
    ).toEqual([expect.stringContaining('MEMBER_ENTRA_GROUPS')]);
  });

  it('refuses to start with a LOCKDOWN_ group setting, naming the setting it became', () => {
    expect(
      bootProblems({ ...real, LOCKDOWN_ENTRA_GROUPS: '76d10637-d517-413c-a10b-84675a3ed64b' }),
    ).toEqual(['LOCKDOWN_ENTRA_GROUPS is now OPERATOR_ENTRA_GROUPS; rename it']);
  });

  it('refuses to start when a group setting lists something that is not a group id', () => {
    expect(
      bootProblems({
        ...real,
        ...platformLogin,
        MEMBER_ENTRA_GROUPS: '789b5488-39ec-47b3-9217-840e5cd957fd, genki-test-users',
      }),
    ).toEqual([expect.stringContaining('genki-test-users')]);
    expect(bootProblems({ ...real, ENTRA_EMAIL_DOMAIN: 'not a domain' })).toEqual([
      expect.stringContaining('ENTRA_EMAIL_DOMAIN'),
    ]);
  });

  it('starts with the service group and no service client list, since hosted clients admit them', () => {
    expect(
      bootProblems({ ...real, SERVICE_ENTRA_GROUPS: '2a2b2c2d-3e3f-4a4b-8c8d-9e9f0a0b0c0d' }),
    ).toEqual([]);
  });

  it('startup refuses a platform client in the service client list', () => {
    expect(
      bootProblems({
        ...real,
        OPERATOR_CLIENT_IDS: 'genki-console',
        SERVICE_ENTRA_CLIENT_IDS: 'ka-web,genki-portal,genki-console',
      }),
    ).toEqual([expect.stringContaining('genki-portal, genki-console')]);
  });

  it('startup refuses bare OPERATOR_SUBJECTS outside dev mode', () => {
    const pair = 'https://test.ansattporten.no|subject-1';

    expect(
      bootProblems({
        ...real,
        OPERATOR_SUBJECTS: `${pair},subject-2`,
        OPERATOR_CLIENT_IDS: 'genki-console',
      }),
    ).toEqual([expect.stringContaining('issuer|subject')]);
    expect(
      bootProblems({ ...real, OPERATOR_SUBJECTS: pair, OPERATOR_CLIENT_IDS: 'genki-console' }),
    ).toEqual([]);
    expect(bootProblems({ ...dev, OPERATOR_SUBJECTS: 'subject-2' })).toEqual([]);
    expect(bootProblems({ ...dev, OPERATOR_SUBJECTS: '|subject-2' })).toEqual([
      expect.stringContaining('OPERATOR_SUBJECTS'),
    ]);
  });

  it('startup refuses OPERATOR_SUBJECTS without OPERATOR_CLIENT_IDS outside dev mode', () => {
    const pair = 'https://test.ansattporten.no|subject-1';

    expect(bootProblems({ ...real, OPERATOR_SUBJECTS: pair })).toEqual([
      expect.stringContaining('OPERATOR_CLIENT_IDS'),
    ]);
  });

  it('sends prompt content to the trace sink only in dev mode', () => {
    expect(bootProblems({ ...real, TRACES_CONTENT: 'true' })).toEqual([
      expect.stringContaining('TRACES_CONTENT'),
    ]);
    expect(bootProblems({ ...real, TRACES_CONTENT: 'false' })).toEqual([]);
    expect(bootProblems({ ...dev, TRACES_CONTENT: 'true' })).toEqual([]);
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

  it('an endpoint set to `knowledge` without a knowledge server stops the API outside development mode', () => {
    const catalog = {
      endpoints: { 'knowledge-pg': { engine: 'pgvector', options: { connection: 'knowledge' } } },
      datasets: [],
    };
    expect(knowledgeServerProblems(real, catalog)).toEqual([
      expect.stringContaining('KNOWLEDGE_PGHOST'),
    ]);
    expect(
      knowledgeServerProblems({ ...real, KNOWLEDGE_PGHOST: 'knowledge.example' }, catalog),
    ).toEqual([]);
    expect(knowledgeServerProblems(real, { endpoints: {}, datasets: [] })).toEqual([]);
  });
});
