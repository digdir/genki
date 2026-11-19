import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

const table = JSON.parse(readFileSync(join(root, 'infra/postgres-connections.json'), 'utf8')) as {
  reservedConnections: number;
  maxConnections: Record<string, number>;
};

interface Template {
  parameters: Record<string, { defaultValue?: unknown }>;
  resources: {
    name: string;
    properties: {
      template?: {
        resources: {
          type: string;
          name: string;
          properties: { template?: { scale?: { maxReplicas?: unknown } } };
        }[];
      };
    };
  }[];
}

const az = (args: string[]) =>
  execFileSync('az', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PG_ADMIN_GROUP_OBJECT_ID: 'x', PG_ADMIN_GROUP_NAME: 'x' },
  });

const poolsOfCreatePostgresStores = 2;
const oneOffConnections = 1;
const phases = {
  'between deploys': { api: ['live', 'previous'], replacesWorker: false },
  'the candidate deploy and its gate': { api: ['live', 'candidate'], replacesWorker: true },
  'the switch': { api: ['live', 'previous'], replacesWorker: true },
  'a rollback to a stopped previous revision': { api: ['live', 'previous'], replacesWorker: false },
};
type Phase = keyof typeof phases;

describe.skipIf(!hasAz && !process.env.CI)('connections to the platform database', () => {
  let template: Template | undefined;
  const settings: Record<string, Record<string, { value: unknown }>> = {};
  beforeAll(() => {
    template = JSON.parse(
      az(['bicep', 'build', '--file', join(root, 'infra/main.bicep'), '--stdout']),
    ) as Template;
    for (const environment of ['test', 'prod']) {
      const built = JSON.parse(
        az([
          'bicep',
          'build-params',
          '--file',
          join(root, `infra/env/${environment}.bicepparam`),
          '--stdout',
        ]),
      ) as { parametersJson: string };
      settings[environment] = (
        JSON.parse(built.parametersJson) as { parameters: Record<string, { value: unknown }> }
      ).parameters;
    }
  }, 240_000);

  const setting = (environment: string, name: string) =>
    settings[environment]?.[name]?.value ?? template?.parameters[name]?.defaultValue;

  const workerReplicas = () => {
    const apps = template?.resources.find((r) => r.name === 'containerapps')?.properties.template;
    const worker = apps?.resources.find(
      (r) => r.type === 'Microsoft.App/containerApps' && r.name.includes("'{0}-worker'"),
    );
    return Number(worker?.properties.template?.scale?.maxReplicas);
  };

  const workersDuring = (environment: string, phase: Phase) =>
    phases[phase].replacesWorker && setting(environment, 'workerRevisionsMode') !== 'Multiple'
      ? 2
      : 1;

  const worstCase = (environment: string, phase: Phase) =>
    Number(setting(environment, 'apiDatabasePoolMax')) *
      poolsOfCreatePostgresStores *
      Number(setting(environment, 'maxReplicas')) *
      phases[phase].api.length +
    Number(setting(environment, 'workerDatabasePoolMax')) *
      poolsOfCreatePostgresStores *
      workerReplicas() *
      workersDuring(environment, phase) +
    oneOffConnections;

  const userConnections = (environment: string) => {
    const sku = String(setting(environment, 'postgresSkuName'));
    const max = table.maxConnections[sku];
    if (max === undefined)
      throw new Error(`no connection limit for ${sku} in infra/postgres-connections.json`);
    return max - table.reservedConnections;
  };

  const fits = ([environment, phase]: [string, Phase]) => {
    expect(workerReplicas()).toBe(1);
    expect(worstCase(environment, phase)).toBeLessThanOrEqual(userConnections(environment));
  };
  const all = ['test', 'prod'].flatMap((environment) =>
    (Object.keys(phases) as Phase[]).map((phase): [string, Phase] => [environment, phase]),
  );
  it.each(all)(
    'keeps every pool full within the %s server’s user connections during %s',
    (environment, phase) => fits([environment, phase]),
  );

  it('counts at most 33 of the B1ms server’s 35 user connections in test, in every phase', () => {
    expect(userConnections('test')).toBe(35);
    for (const phase of Object.keys(phases) as Phase[])
      expect(worstCase('test', phase), phase).toBe(33);
  });
});
