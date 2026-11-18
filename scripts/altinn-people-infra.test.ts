import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

// The Tilgang people list on genki-test (ADR 0060): its settings and Key Vault secrets in the template.

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

const hasAz = (() => {
  try {
    execFileSync('az', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const bicep = (args: string[], env: Record<string, string> = {}) =>
  execFileSync('az', ['bicep', ...args, '--stdout'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PG_ADMIN_GROUP_OBJECT_ID: 'group',
      PG_ADMIN_GROUP_NAME: 'group',
      ALTINN_PEOPLE_URL: '',
      ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID: '',
      ALTINN_PEOPLE_MASKINPORTEN_SCOPE: '',
      ...env,
    },
  });

const testParameters = (env: Record<string, string> = {}) => {
  const built = JSON.parse(
    bicep(['build-params', '--file', join(root, 'infra/env/test.bicepparam')], env),
  ) as { parametersJson: string };
  const { parameters } = JSON.parse(built.parametersJson) as {
    parameters: Record<string, { value: unknown }>;
  };
  return Object.fromEntries(Object.entries(parameters).map(([k, v]) => [k, v.value]));
};

const peopleUrl = 'https://platform.tt02.altinn.no';

describe.skipIf(!hasAz && !process.env.CI)("the people source's settings on genki-test", () => {
  let off: Record<string, unknown> = {};
  let on: Record<string, unknown> = {};
  let ownClient: Record<string, unknown> = {};
  let identityEnv: Record<string, string> = {};
  beforeAll(() => {
    off = testParameters();
    on = testParameters({ ALTINN_PEOPLE_URL: peopleUrl });
    ownClient = testParameters({
      ALTINN_PEOPLE_URL: peopleUrl,
      ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID: 'people-client',
      ALTINN_PEOPLE_MASKINPORTEN_SCOPE: 'altinn:example.read',
    });
    const template = JSON.parse(bicep(['build', '--file', join(root, 'infra/main.bicep')])) as {
      resources: { name: string; properties: { parameters: Record<string, { value: unknown }> } }[];
    };
    identityEnv = template.resources.find((r) => r.name === 'containerapps')?.properties.parameters
      .identityEnv?.value as Record<string, string>;
  }, 180_000);

  it('names no people secret in Key Vault while ALTINN_PEOPLE_URL is unset', () => {
    expect(off.keyVaultSecretNames).not.toContain('access-person-key-secret');
    expect(off.keyVaultSecretNames).not.toContain('altinn-people-maskinporten-key');
    expect(off.altinnPeopleUrl).toBe('');
  });

  it('reads the person key secret from Key Vault once ALTINN_PEOPLE_URL is set', () => {
    expect(on.keyVaultSecretNames).toContain('access-person-key-secret');
    expect(on.keyVaultSecretNames).not.toContain('altinn-people-maskinporten-key');
    expect(on.altinnPeopleUrl).toBe(peopleUrl);
  });

  it("reads the people client's own key from Key Vault only when it has its own client", () => {
    expect(ownClient.keyVaultSecretNames).toContain('altinn-people-maskinporten-key');
    expect(ownClient.altinnPeopleMaskinportenClientId).toBe('people-client');
    expect(ownClient.altinnPeopleMaskinportenScope).toBe('altinn:example.read');
  });

  it('passes the people settings to the API and worker as plain settings, never a secret value', () => {
    expect(identityEnv).toMatchObject({
      ALTINN_PEOPLE_URL: "[parameters('altinnPeopleUrl')]",
      ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID: "[parameters('altinnPeopleMaskinportenClientId')]",
      ALTINN_PEOPLE_MASKINPORTEN_SCOPE: "[parameters('altinnPeopleMaskinportenScope')]",
    });
    expect(read('infra/env/test.bicepparam')).not.toMatch(/ACCESS_PERSON_KEY_SECRET|_KEY'\)/);
  });
});

describe("the workflows that deploy genki-test's template", () => {
  const variables = [
    'ALTINN_PEOPLE_URL',
    'ALTINN_PEOPLE_MASKINPORTEN_CLIENT_ID',
    'ALTINN_PEOPLE_MASKINPORTEN_SCOPE',
  ];
  const envBlocks = (file: string) => {
    const workflow = parse(read(`.github/workflows/${file}`)) as {
      jobs: Record<
        string,
        { env?: Record<string, string>; steps?: { env?: Record<string, string>; run?: string }[] }
      >;
    };
    return Object.values(workflow.jobs).flatMap((job) => [
      ...(job.env && job.steps?.some((s) => s.run?.includes('bicepparam')) ? [job.env] : []),
      ...(job.steps ?? [])
        .filter((s) => s.run?.includes('test.bicepparam') && s.env?.PG_ADMIN_GROUP_NAME)
        .map((s) => s.env as Record<string, string>),
    ]);
  };

  it.each(['deploy.yml', 'infra.yml'])('%s passes the people variables to the template', (file) => {
    const blocks = envBlocks(file).filter((env) => env.ALTINN_PDP_MASKINPORTEN_CLIENT_ID);
    expect(blocks.length).toBeGreaterThan(0);
    for (const env of blocks)
      for (const name of variables) expect(env[name]).toBe(`\${{ vars.${name} }}`);
  });
});
