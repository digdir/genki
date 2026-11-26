import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

const hasAz = (() => {
  try {
    execFileSync('az', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const TEST_ISSUER = 'https://test.ansattporten.no';
const PRODUCTION_ISSUER = 'https://ansattporten.no';

const testParams = (env: Record<string, string>) => {
  try {
    const out = execFileSync(
      'az',
      ['bicep', 'build-params', '--file', join(root, 'infra/env/test.bicepparam'), '--stdout'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env,
          PG_ADMIN_GROUP_OBJECT_ID: '00000000-0000-0000-0000-000000000000',
          PG_ADMIN_GROUP_NAME: 'x',
          HOSTNAMES_STAGE: '',
          ALTINN_PDP_URL: '',
          ...env,
        },
      },
    );
    const built = JSON.parse(out.slice(out.indexOf('{'))) as { parametersJson: string };
    const { parameters } = JSON.parse(built.parametersJson) as {
      parameters: Record<string, { value: unknown }>;
    };
    return { values: Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, v.value])) };
  } catch (error) {
    return { error: String((error as { stderr?: unknown }).stderr ?? error) };
  }
};

const login = (values: Record<string, unknown> | undefined) => ({
  issuer: values?.ansattportenIssuer,
  clientId: values?.platformLoginClientId,
  secretName: values?.platformLoginSecretName,
  lockdown: values?.lockdown,
  altinn: values?.altinnPdpUrl,
});

describe.skipIf(!hasAz && !process.env.CI)('genki-test on production Ansattporten', () => {
  it('keeps the test client, its secret, Altinn and lockdown while the issuer is test Ansattporten', () => {
    const { values } = testParams({
      ANSATTPORTEN_ISSUER: TEST_ISSUER,
      ALTINN_PDP_URL: 'https://platform.tt02.altinn.no',
    });

    expect(login(values)).toEqual({
      issuer: TEST_ISSUER,
      clientId: 'dde98722-c952-4172-a5d6-10bdf721680f',
      secretName: 'platform-login-client-secret',
      lockdown: true,
      altinn: 'https://platform.tt02.altinn.no',
    });
  }, 120_000);

  it('refuses the production issuer while the login host is still login.apps.genki-test.digdir.cloud', () => {
    for (const stage of ['', 'none', 'hostnames']) {
      const { values, error } = testParams({
        ANSATTPORTEN_ISSUER: PRODUCTION_ISSUER,
        HOSTNAMES_STAGE: stage,
      });

      expect(values).toBeUndefined();
      expect(error).toContain('set HOSTNAMES_STAGE=certificates first');
    }
  }, 360_000);

  it('signs in through the production client and its secret, without lockdown or Altinn, once the hostnames are at certificates', () => {
    const { values } = testParams({
      ANSATTPORTEN_ISSUER: PRODUCTION_ISSUER,
      HOSTNAMES_STAGE: 'certificates',
    });

    expect(login(values)).toEqual({
      issuer: PRODUCTION_ISSUER,
      clientId: 'c0e4a5af-b2e1-4bba-9324-4caf55be8db5',
      secretName: 'platform-login-client-secret-prod',
      lockdown: false,
      altinn: '',
    });
    expect(values?.platformLoginStage).toBe('certificates');
  }, 120_000);

  it('refuses the production issuer while ALTINN_PDP_URL is set', () => {
    const { values, error } = testParams({
      ANSATTPORTEN_ISSUER: PRODUCTION_ISSUER,
      HOSTNAMES_STAGE: 'certificates',
      ALTINN_PDP_URL: 'https://platform.tt02.altinn.no',
    });

    expect(values).toBeUndefined();
    expect(error).toContain('delete ALTINN_PDP_URL');
  }, 120_000);

  it('refuses an issuer that is neither test nor production Ansattporten, a trailing slash included', () => {
    const { values, error } = testParams({
      ANSATTPORTEN_ISSUER: `${PRODUCTION_ISSUER}/`,
      HOSTNAMES_STAGE: 'certificates',
    });

    expect(values).toBeUndefined();
    expect(error).toContain('ANSATTPORTEN_ISSUER must be');
  }, 120_000);
});
