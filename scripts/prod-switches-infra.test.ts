import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '..');

const hasAz = (() => {
  try {
    execFileSync('az', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const bicep = (args: string[]) =>
  execFileSync('az', ['bicep', ...args, '--stdout'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: {
      ...process.env,
      PG_ADMIN_GROUP_OBJECT_ID: '00000000-0000-0000-0000-000000000000',
      PG_ADMIN_GROUP_NAME: 'x',
    },
  });

interface Template {
  parameters: Record<string, { defaultValue?: unknown }>;
  variables: Record<string, string>;
  resources: {
    name: string;
    properties?: {
      parameters?: Record<string, { value: unknown }>;
      template?: { variables: Record<string, string>; resources: { name: string }[] };
    };
  }[];
}

const parameters = (file: string) => {
  const out = bicep(['build-params', '--file', join(root, `infra/env/${file}.bicepparam`)]);
  const built = JSON.parse(out.slice(out.indexOf('{'))) as { parametersJson: string };
  const { parameters: values } = JSON.parse(built.parametersJson) as {
    parameters: Record<string, { value: unknown }>;
  };
  return Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]));
};

const switches = ['GENAI_ENV', 'GENAI_LOCKDOWN', 'TRACES_ENVIRONMENT', 'GENAI_TEST_RUNNER_KEYS'];

const appSettings = (values: Record<string, unknown>, template: Template) => {
  const setting = (name: string) => values[name] ?? template.parameters[name]?.defaultValue;
  const tier = values.platformTier ?? values.environmentName;
  const merged: Record<string, unknown> = {
    ...(values.appEnv as Record<string, unknown>),
    GENAI_LOCKDOWN: setting('lockdown') ? 'true' : '',
    TRACES_ENVIRONMENT: setting('tracesEnvironment'),
    GENAI_TEST_RUNNER_KEYS: setting('testRunnerKeys') ? 'true' : '',
  };
  return Object.fromEntries(
    [['GENAI_ENV', tier] as const, ...Object.entries(merged)].filter(
      ([name, value]) => switches.includes(name) && value !== '',
    ),
  );
};

describe.skipIf(!hasAz && !process.env.CI)('the production switches in the template', () => {
  let template: Template;
  let test: Record<string, unknown>;
  let prod: Record<string, unknown>;
  beforeAll(() => {
    template = JSON.parse(bicep(['build', '--file', join(root, 'infra/main.bicep')])) as Template;
    test = parameters('test');
    prod = parameters('prod');
  }, 240_000);

  const apps = () => {
    const found = template.resources.find((r) => r.name === 'containerapps');
    if (!found?.properties.template) throw new Error('no containerapps module');
    return found.properties;
  };

  it('keeps genki-test as today by default: test tier, locked, traces tagged test, test-runner keys on', () => {
    expect(appSettings(test, template)).toEqual({
      GENAI_ENV: 'test',
      GENAI_LOCKDOWN: 'true',
      TRACES_ENVIRONMENT: 'test',
      GENAI_TEST_RUNNER_KEYS: 'true',
    });
  });

  it('keeps prod as today by default: the environment name as tier and no other switch', () => {
    expect(appSettings(prod, template)).toEqual({ GENAI_ENV: 'prod' });
    expect(template.parameters.platformTier?.defaultValue).toBe("[parameters('environmentName')]");
    expect(template.parameters.lockdown?.defaultValue).toBe(false);
    expect(template.parameters.tracesEnvironment?.defaultValue).toBe('');
    expect(template.parameters.testRunnerKeys?.defaultValue).toBe(false);
  });

  it('sets the switches only through their parameters, never in appEnv', () => {
    for (const values of [test, prod])
      expect(Object.keys(values.appEnv as object).filter((k) => switches.includes(k))).toEqual([]);
  });

  it('turns the parameters into app settings that are left out when off', () => {
    expect(apps().parameters?.appEnv?.value).toBe(
      "[union(parameters('appEnv'), createObject('GENAI_LOCKDOWN', if(parameters('lockdown'), 'true', ''), 'TRACES_ENVIRONMENT', parameters('tracesEnvironment'), 'GENAI_TEST_RUNNER_KEYS', if(parameters('testRunnerKeys'), 'true', '')))]",
    );
    expect(apps().template?.variables.plainEnv).toContain(
      "lambda('pair', not(empty(lambdaVariables('pair').value)))",
    );
  });

  it('gives the apps the tier as GENAI_ENV and the console label, and names no resource after it', () => {
    const variables = apps().template?.variables ?? {};
    expect(variables.serverEnv).toContain(
      "createObject('name', 'GENAI_ENV', 'value', parameters('platformTier'))",
    );
    expect(JSON.stringify(variables.webApps)).toContain("parameters('platformTier')");
    expect(template.variables.baseName).toBe(
      "[format('{0}-{1}', parameters('namePrefix'), parameters('environmentName'))]",
    );
    const names = template.resources.flatMap((r) => [
      r.name,
      ...Object.values(r.properties?.template?.resources ?? {}).map((inner) => inner.name),
    ]);
    expect(names.filter((name) => name.includes('platformTier'))).toEqual([]);
  });
});
