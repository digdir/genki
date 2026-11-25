import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const root = join(import.meta.dirname, '..');
const groupSettings = [
  'OPERATOR_ENTRA_GROUPS',
  'MEMBER_ENTRA_GROUPS',
  'SERVICE_ENTRA_GROUPS',
  'SERVICE_ENTRA_CLIENT_IDS',
  'ENTRA_EMAIL_DOMAIN',
];

const hasAz = (() => {
  try {
    execFileSync('az', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

const appEnv = (file: string, vars: Record<string, string>) => {
  const cleared = new Set([...groupSettings, ...Object.keys(vars)]);
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => !cleared.has(name)),
  );
  const out = execFileSync(
    'az',
    ['bicep', 'build-params', '--file', join(root, `infra/env/${file}.bicepparam`), '--stdout'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...env,
        PG_ADMIN_GROUP_OBJECT_ID: '00000000-0000-0000-0000-000000000000',
        PG_ADMIN_GROUP_NAME: 'x',
        ...vars,
      },
    },
  );
  const built = JSON.parse(out.slice(out.indexOf('{'))) as { parametersJson: string };
  const { parameters } = JSON.parse(built.parametersJson) as {
    parameters: { appEnv: { value: Record<string, string> } };
  };
  return Object.fromEntries(
    Object.entries(parameters.appEnv.value).filter(
      ([k]) => groupSettings.includes(k) || k.startsWith('LOCKDOWN_'),
    ),
  );
};

const noGroups = {
  OPERATOR_ENTRA_GROUPS: '',
  MEMBER_ENTRA_GROUPS: '',
  SERVICE_ENTRA_GROUPS: '',
  SERVICE_ENTRA_CLIENT_IDS: '',
  ENTRA_EMAIL_DOMAIN: 'digdir.no',
};

describe.skipIf(!hasAz && !process.env.CI)(
  'the Entra group settings in the parameter files',
  () => {
    it('gives no group rights when a group variable is empty, whatever the old LOCKDOWN_ variables hold', () => {
      const env = appEnv('test', {
        LOCKDOWN_ENTRA_GROUPS: '76d10637-d517-413c-a10b-84675a3ed64b',
        LOCKDOWN_USER_GROUPS: '789b5488-39ec-47b3-9217-840e5cd957fd',
        LOCKDOWN_SERVICE_GROUPS: '30a76637-d1ff-4040-bc1f-fb9b8ccd749c',
        LOCKDOWN_SERVICE_CLIENT_IDS: 'ka-backend',
        MEMBER_ENTRA_GROUPS: '',
      });
      expect(env).toEqual(noGroups);
    }, 240_000);

    it('passes the group variables through to genki-test as set', () => {
      expect(
        appEnv('test', {
          OPERATOR_ENTRA_GROUPS: 'operators',
          MEMBER_ENTRA_GROUPS: 'members',
          SERVICE_ENTRA_GROUPS: 'employees',
          SERVICE_ENTRA_CLIENT_IDS: 'ka-backend',
          ENTRA_EMAIL_DOMAIN: 'example.no',
        }),
      ).toEqual({
        OPERATOR_ENTRA_GROUPS: 'operators',
        MEMBER_ENTRA_GROUPS: 'members',
        SERVICE_ENTRA_GROUPS: 'employees',
        SERVICE_ENTRA_CLIENT_IDS: 'ka-backend',
        ENTRA_EMAIL_DOMAIN: 'example.no',
      });
    }, 240_000);

    it('gives prod no group rights until its own variables are set', () => {
      expect(appEnv('prod', {})).toEqual(noGroups);
    }, 240_000);
  },
);

describe('the Entra group variables in the workflows', () => {
  it('never passes an old LOCKDOWN_ variable to a deploy', () => {
    for (const name of ['deploy.yml', 'infra.yml'])
      expect(readFileSync(join(root, '.github/workflows', name), 'utf8')).not.toMatch(
        /vars\.LOCKDOWN_/,
      );
  });

  it('passes every group variable to each step that deploys a parameter file', () => {
    for (const name of ['deploy.yml', 'infra.yml']) {
      const text = readFileSync(join(root, '.github/workflows', name), 'utf8');
      const workflow = parse(text) as {
        jobs: Record<
          string,
          { env?: Record<string, string>; steps?: { env?: Record<string, string>; run?: string }[] }
        >;
      };
      const deploying = Object.values(workflow.jobs).flatMap((job) =>
        (job.steps ?? [])
          .filter(
            (step) => step.run?.includes('.bicepparam') && step.run.includes('az deployment group'),
          )
          .map((step) => ({ ...job.env, ...step.env })),
      );
      expect(deploying.length).toBeGreaterThan(0);
      for (const env of deploying)
        for (const setting of groupSettings) expect(env[setting]).toBe(`\${{ vars.${setting} }}`);
    }
  });
});
