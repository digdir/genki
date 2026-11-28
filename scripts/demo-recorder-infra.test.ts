import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

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

interface Resource {
  type: string;
  name: string;
  condition?: unknown;
  scope?: string;
  copy?: { count: string };
  identity?: { type: string; userAssignedIdentities: Record<string, unknown> };
  properties: Record<string, unknown> & {
    parameters?: Record<string, { value: unknown }>;
    template?: Built;
  };
}
interface Built {
  parameters: Record<string, { defaultValue?: unknown }>;
  variables?: Record<string, unknown>;
  resources: Resource[];
}

const build = (file: string) =>
  JSON.parse(
    execFileSync('az', ['bicep', 'build', '--file', join(root, file), '--stdout'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Built;

const testParameters = (env: Record<string, string>) => {
  const output = execFileSync(
    'az',
    ['bicep', 'build-params', '--file', join(root, 'infra/env/test.bicepparam'), '--stdout'],
    {
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(([key]) => !key.startsWith('DEMO_')),
        ),
        PG_ADMIN_GROUP_OBJECT_ID: '00000000-0000-0000-0000-000000000000',
        PG_ADMIN_GROUP_NAME: 'pg-admins',
        ...env,
      },
    },
  );
  const params = JSON.parse((JSON.parse(output) as { parametersJson: string }).parametersJson) as {
    parameters: Record<string, { value: unknown }>;
  };
  return Object.fromEntries(Object.entries(params.parameters).map(([k, v]) => [k, v.value]));
};

describe.skipIf(!hasAz && !process.env.CI)('the demo recorder job in the template', () => {
  let main: Built | undefined;
  let access: Built | undefined;
  beforeAll(() => {
    main = build('infra/main.bicep');
    access = build('infra/demo-recorder-access.bicep');
  }, 120_000);
  const built = () => {
    if (!main || !access) throw new Error('the templates did not build');
    return { main, access };
  };
  const recorder = () => {
    const found = built().main.resources.find((r) => r.name === 'demo-recorder');
    if (!found?.properties.template) throw new Error('no demo-recorder module');
    return found;
  };
  const inner = () => recorder().properties.template?.resources ?? [];
  const job = () => inner().find((r) => r.type === 'Microsoft.App/jobs');
  const apiEnv = () =>
    JSON.stringify(
      built().main.resources.find((r) => r.name === 'containerapps')?.properties.parameters
        ?.identityEnv,
    );

  it('is off unless an environment turns it on, and prod sets nothing of it', () => {
    expect(built().main.parameters.demoRecorderEnabled?.defaultValue).toBe(false);
    expect(recorder().condition).toBe("[variables('recorderJobOn')]");
    expect(built().main.variables?.recorderJobOn).toBe(
      "[and(variables('recorderOn'), not(empty(parameters('demoRecorderAudience'))))]",
    );
    expect(read('infra/env/prod.bicepparam')).not.toMatch(/demoRecorder|DEMO_RECORDER/);
  });

  it('is on in test only with DEMO_RECORDER_JOB_ENABLED=true, and takes recordings only with DEMO_RECORDER_MODE=job', () => {
    const off = testParameters({});
    const on = testParameters({
      DEMO_RECORDER_JOB_ENABLED: 'true',
      DEMO_RECORDER_MODE: 'job',
      HOSTNAME_BINDER_AUDIENCE: 'api://genki-test-api',
    });

    expect(off.demoRecorderEnabled).toBe(false);
    expect((off.appEnv as Record<string, string>).GENAI_DEMO_RECORDER).toBe('scheduled');
    expect(on.demoRecorderEnabled).toBe(true);
    expect(on.demoRecorderAudience).toBe('api://genki-test-api');
    expect((on.appEnv as Record<string, string>).GENAI_DEMO_RECORDER).toBe('job');
    expect(
      (testParameters({ DEMO_RECORDER_MODE: 'jobb' }).appEnv as Record<string, string>)
        .GENAI_DEMO_RECORDER,
    ).toBe('scheduled');
  }, 120_000);

  it('runs by hand only, one replica, at most an hour, never retried, in genki’s environment', () => {
    const configuration = job()?.properties.configuration as Record<string, unknown>;

    expect(configuration.triggerType).toBe('Manual');
    expect(configuration.manualTriggerConfig).toEqual({
      parallelism: 1,
      replicaCompletionCount: 1,
    });
    expect(configuration.replicaTimeout).toBe(3600);
    expect(configuration.replicaRetryLimit).toBe(0);
    expect(JSON.stringify(job()?.properties.environmentId)).toContain("'{0}-env'");
    expect(configuration).not.toHaveProperty('ingress');
  });

  it('carries only the recorder identity, no secret and no key, and runs the image’s own command', () => {
    const configuration = job()?.properties.configuration as { secrets: unknown[] };
    const containers = (job()?.properties.template as { containers: Record<string, unknown>[] })
      .containers;
    const text = JSON.stringify(job());

    expect(Object.keys(job()?.identity?.userAssignedIdentities ?? {})).toEqual([
      "[format('{0}', parameters('identityId'))]",
    ]);
    expect(JSON.stringify(recorder().properties.parameters?.identityId)).toContain(
      "format('{0}-recorder-id', variables('baseName'))",
    );
    expect(configuration.secrets).toEqual([]);
    expect(text).not.toMatch(/secretRef|DEMO_RECORDER_KEY|DEMO_API_KEY"|PGHOST|DATABASE|api-id/);
    expect(containers).toHaveLength(1);
    expect(containers[0]).not.toHaveProperty('command');
    expect(containers[0]).not.toHaveProperty('args');
    expect(text).toContain('DEMO_RECORDER_AUDIENCE');
  });

  it('gives the recorder identity AcrPull and Key Vault Secrets User on each named secret only', () => {
    const roles = inner().filter((r) => r.type === 'Microsoft.Authorization/roleAssignments');
    const variables = recorder().properties.template?.variables ?? {};

    expect(roles).toHaveLength(2);
    expect(variables.acrPull).toBe('7f951dda-4ed3-4680-a7ca-43fe172d538d');
    expect(variables.secretsUser).toBe('4633458b-17de-408a-b874-0445c86b69e6');
    const reads = roles.find((r) => JSON.stringify(r.properties).includes('secretsUser'));
    expect(reads?.scope).toBe(
      "[resourceId('Microsoft.KeyVault/vaults/secrets', parameters('vaultName'), variables('secretNames')[copyIndex()])]",
    );
    expect(reads?.copy?.count).toBe("[length(variables('secretNames'))]");
    expect(variables.secretNames).toBe(
      "[filter(createArray(variables('elevenLabsSecret'), variables('signInSecret')), lambda('s', not(empty(lambdaVariables('s')))))]",
    );
  });

  it('tells the API the recorder’s identity and job only when the job is deployed', () => {
    for (const name of [
      'GENAI_DEMO_RECORDER_PRINCIPAL_ID',
      'GENAI_DEMO_RECORDER_AUDIENCE',
      'GENAI_DEMO_RECORDER_TENANT_ID',
      'GENAI_DEMO_RECORDER_JOB',
    ])
      expect(apiEnv()).toMatch(new RegExp(`"${name}":"\\[if\\(variables\\('recorderJobOn'\\)`));
  });

  it('leaves the start role to an owner: one action, on the one job, for the API identity', () => {
    const all = (resources: Resource[]): Resource[] =>
      resources.flatMap((r) => [r, ...all(r.properties?.template?.resources ?? [])]);
    const types = all(built().main.resources).map((r) => r.type);
    const role = built().access.resources.find(
      (r) => r.type === 'Microsoft.Authorization/roleDefinitions',
    );
    const grant = built().access.resources.find((r) => r.name === 'demo-recorder-access');
    const assignment = grant?.properties.template?.resources.find(
      (r) => r.type === 'Microsoft.Authorization/roleAssignments',
    );

    expect(types).not.toContain('Microsoft.Authorization/roleDefinitions');
    expect(built().access.variables?.starterActions).toEqual(['Microsoft.App/jobs/start/action']);
    expect(JSON.stringify(role?.properties.permissions)).toContain(
      '"dataActions":[],"notDataActions":[]',
    );
    expect(assignment?.scope).toBe(
      "[resourceId('Microsoft.App/jobs', format('{0}-demo-recorder', parameters('baseName')))]",
    );
    expect(JSON.stringify(assignment?.properties)).toContain("format('{0}-api-id'");
  });
});
