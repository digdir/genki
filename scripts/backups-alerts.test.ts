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

const bicep = (args: string[]) =>
  execFileSync('az', ['bicep', ...args, '--stdout'], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, PG_ADMIN_GROUP_OBJECT_ID: 'group', PG_ADMIN_GROUP_NAME: 'group' },
  });

interface Resource {
  type: string;
  name: string;
  condition?: unknown;
  scope?: unknown;
  properties: Record<string, unknown> & {
    parameters?: Record<string, { value: unknown }>;
    template?: {
      variables?: Record<string, unknown>;
      resources: Resource[] | Record<string, Resource>;
    };
  };
}

const list = (resources: Resource[] | Record<string, Resource>) =>
  Array.isArray(resources) ? resources : Object.values(resources);

describe.skipIf(!hasAz && !process.env.CI)('backups and alerts in the template', () => {
  let main: {
    parameters: Record<string, { defaultValue?: unknown }>;
    variables: Record<string, unknown>;
    resources: Resource[];
  };
  let test: Record<string, unknown> = {};
  let prod: Record<string, unknown> = {};
  beforeAll(() => {
    main = JSON.parse(bicep(['build', '--file', join(root, 'infra/main.bicep')])) as typeof main;
    const params = (environment: string) => {
      const built = JSON.parse(
        bicep(['build-params', '--file', join(root, `infra/env/${environment}.bicepparam`)]),
      ) as { parametersJson: string };
      return Object.fromEntries(
        Object.entries(
          (JSON.parse(built.parametersJson) as { parameters: Record<string, { value: unknown }> })
            .parameters,
        ).map(([name, { value }]) => [name, value]),
      );
    };
    test = params('test');
    prod = params('prod');
  }, 240_000);

  const setting = (values: Record<string, unknown>, name: string) =>
    name in values ? values[name] : main.parameters[name]?.defaultValue;
  const module = (name: string) => {
    const found = main.resources.find(
      (r) => r.type === 'Microsoft.Resources/deployments' && r.name === name,
    );
    if (!found) throw new Error(`no ${name} module in the template`);
    return found;
  };
  const inner = (name: string) => list(module(name).properties.template?.resources ?? []);
  const text = (value: unknown) => JSON.stringify(value);

  it('runs test’s platform server on B2s with 35 days of restore and a Sunday 02:00 UTC window', () => {
    expect(setting(test, 'postgresSkuName')).toBe('Standard_B2s');
    expect(setting(test, 'postgresSkuTier')).toBe('Burstable');
    expect(setting(test, 'postgresBackupRetentionDays')).toBe(35);
    expect(setting(test, 'postgresMaintenanceWindow')).toEqual({
      customWindow: 'Enabled',
      dayOfWeek: 0,
      startHour: 2,
      startMinute: 0,
    });
  });

  it('leaves the maintenance window to Azure unless the environment sets one, and keeps the knowledge server on Azure’s choice', () => {
    const azureChoice = { customWindow: 'Disabled', dayOfWeek: 0, startHour: 0, startMinute: 0 };
    expect(main.parameters.postgresMaintenanceWindow?.defaultValue).toEqual(azureChoice);
    expect(setting(prod, 'postgresMaintenanceWindow')).toEqual(azureChoice);
    expect(module('postgres').properties.parameters?.maintenanceWindow).toEqual({
      value: "[parameters('postgresMaintenanceWindow')]",
    });
    expect(module('knowledge-postgres').properties.parameters?.maintenanceWindow).toBeUndefined();
    const template = module('knowledge-postgres').properties.template as unknown as {
      parameters: Record<string, { defaultValue?: unknown }>;
    };
    expect(template.parameters.maintenanceWindow?.defaultValue).toEqual(azureChoice);
  });

  it('writes no resource lock unless turned on, since the deploy identity cannot', () => {
    expect(main.parameters.resourceLocksEnabled?.defaultValue).toBe(false);
    expect(setting(test, 'resourceLocksEnabled')).toBe(false);
    const locks = main.resources.filter((r) => r.type === 'Microsoft.Authorization/locks');
    expect(locks).toHaveLength(4);
    expect(text(main.variables.lockOn)).toContain("parameters('resourceLocksEnabled')");
    for (const lock of locks) {
      expect(text(lock.condition)).toContain("variables('lockOn')");
      expect(lock.properties.level).toBe('CanNotDelete');
    }
  });

  it('backs up the file share daily for 30 days in a vault with soft delete', () => {
    expect(setting(test, 'backupsEnabled')).toBe(true);
    const resources = inner('files-backup');
    const vault = resources.find((r) => r.type === 'Microsoft.RecoveryServices/vaults');
    expect(text(vault?.properties)).toContain('"softDeleteState":"Enabled"');
    const policy = resources.find((r) => r.type.endsWith('/backupPolicies'));
    expect(text(policy?.properties)).toContain('"scheduleRunFrequency":"Daily"');
    expect(text(policy?.properties)).toContain("parameters('retentionDays')");
    expect(module('files-backup').properties.template?.variables).toBeDefined();
    expect(
      resources.find((r) => r.type.endsWith('/protectedItems'))?.properties.protectedItemType,
    ).toBe('AzureFileShareProtectedItem');
  });

  it('keeps the database copies immutable for 12 weeks, in an account without shared keys', () => {
    const resources = inner('platform-backup');
    const account = resources.find((r) => r.type === 'Microsoft.Storage/storageAccounts');
    expect(account?.properties.allowSharedKeyAccess).toBe(false);
    const worm = resources.find((r) => r.type.endsWith('/immutabilityPolicies'));
    expect(worm?.properties.immutabilityPeriodSinceCreationInDays).toBe(
      "[parameters('retentionDays')]",
    );
    const template = module('platform-backup').properties.template as unknown as {
      parameters: Record<string, { defaultValue?: unknown }>;
    };
    expect(template.parameters.retentionDays?.defaultValue).toBe(84);
  });

  it('takes no internet traffic to the copies, only through a private endpoint in the environment’s network', () => {
    const resources = inner('platform-backup');
    const account = resources.find((r) => r.type === 'Microsoft.Storage/storageAccounts');
    expect(account?.properties.publicNetworkAccess).toBe('Disabled');
    expect(account?.properties.networkAcls).toEqual({ defaultAction: 'Deny', bypass: 'None' });
    const endpoint = resources.find((r) => r.type === 'Microsoft.Network/privateEndpoints');
    expect(text(endpoint?.properties)).toContain('"groupIds":["blob"]');
    expect(resources.some((r) => r.type.endsWith('/privateDnsZoneGroups'))).toBe(true);
    expect(text(module('platform-backup').properties.parameters?.endpointsSubnetId)).toContain(
      'endpointsSubnetId',
    );
    expect(setting(test, 'endpointsSubnetPrefix')).toBe('10.40.3.0/27');
  });

  it('sends the immutability policy only until it is locked by hand, and never locks it itself', () => {
    expect(main.parameters.platformBackupImmutabilityLocked?.defaultValue).toBe(false);
    expect(setting(test, 'platformBackupImmutabilityLocked')).toBe(false);
    const worm = inner('platform-backup').find((r) => r.type.endsWith('/immutabilityPolicies'));
    expect(text(worm?.condition)).toContain("parameters('immutabilityLocked')");
    expect(text(inner('platform-backup'))).not.toContain('/lock');
  });

  it('runs the restore drill in test only, outside the deploy concurrency group', () => {
    const workflow = readFileSync(
      join(root, '.github/workflows/platform-restore-drill.yml'),
      'utf8',
    );
    expect(workflow).toContain('group: platform-restore-drill-test');
    expect(workflow).not.toContain('deploy-');
    expect(workflow).not.toMatch(/prod/);
    expect(workflow).not.toContain('inputs.');
  });

  it('gives only the backup identity a role on the copies, never the app identity', () => {
    const roles = inner('platform-backup').filter(
      (r) => r.type === 'Microsoft.Authorization/roleAssignments',
    );
    expect(roles).toHaveLength(1);
    const writer = text(module('platform-backup').properties.parameters?.writerPrincipalId);
    expect(writer).toContain("format('{0}-backup-id'");
    expect(text(module('platform-backup').properties.parameters)).not.toContain('-api-id');
  });

  it('dumps as the app identity and uploads as the backup identity, with the token never on a command line', () => {
    const job = inner('containerapps').find(
      (r) => r.type === 'Microsoft.App/jobs' && r.name.includes('-pg-backup'),
    );
    const template = job?.properties.template as unknown as {
      initContainers: { name: string; command: unknown; env: unknown }[];
      containers: { name: string; env: unknown }[];
    };
    const dump = template.initContainers.find((c) => c.name === 'dump');
    expect(text(dump?.command)).toContain('--enable-row-security');
    expect(text(dump?.env)).toContain('app.platform_access=backup');
    expect(text(dump?.command)).toContain('$(cat {0})');
    expect(text(dump?.command)).toMatch(/&& rm \{1\} && export PGPASSWORD/);
    expect(text(template.containers[0]?.env)).toContain(
      "parameters('platformBackup').writer.clientId",
    );
    expect(text(template.initContainers.find((c) => c.name === 'token')?.env)).toContain(
      "parameters('identityClientId')",
    );
  });

  it('gives no job init container more CPU than its app containers together', () => {
    const jobs = inner('containerapps').filter((r) => r.type === 'Microsoft.App/jobs');
    expect(jobs.length).toBeGreaterThan(0);
    const cpu = (c: { resources?: { cpu?: unknown } }) =>
      Number(/[\d.]+/.exec(String(c.resources?.cpu ?? 0))?.[0]);
    for (const job of jobs) {
      const template = job.properties.template as unknown as {
        initContainers?: { resources?: { cpu?: unknown } }[];
        containers: { resources?: { cpu?: unknown } }[];
      };
      const total = template.containers.reduce((sum, c) => sum + cpu(c), 0);
      for (const init of template.initContainers ?? [])
        expect(cpu(init)).toBeLessThanOrEqual(total);
    }
  });

  it('declares db-down, api-latency and worker-jobs, and no longer ingestion or state-register', () => {
    const alerts = inner('alerts');
    const names = text(alerts.map((r) => r.name));
    expect(names).toContain('-db-down');
    const dbDown = alerts.find((r) => text(r.name).includes('-db-down'));
    expect(text(dbDown?.properties)).toContain('"metricName":"is_db_alive"');
    expect(text(dbDown?.properties)).toContain('"operator":"LessThan"');
    const logRules = text((module('alerts').properties.template?.variables ?? {}).appLogAlerts);
    expect(logRules).toContain("'worker-jobs'".replaceAll("'", '"'));
    expect(logRules).toContain('"api-latency"');
    expect(logRules).not.toContain('"ingestion"');
    expect(logRules).not.toContain('"state-register"');
    expect(logRules).not.toContain('job queue error');
    expect(logRules).toContain('queue stats');
    expect(logRules).toContain('iff(failures >= {2} or stale > 0 or waiting > 0, 1, 0)');
    expect(text(main.parameters.alertThresholds?.defaultValue)).toContain('"workerFailures":3');
    const variables = module('alerts').properties.template?.variables ?? {};
    expect(logRules).toContain("Path != ''/health''");
    expect(logRules).toContain('not(Path has_any (');
    const slow = text(variables.slowByDesignPaths);
    for (const route of ['/chat/completions', '/uploads', '/playground/runs', '/a2a', '/api/mcp'])
      expect(slow).toContain(route);
    for (const route of ['/tasks', '/models', '/datasets', '/api/facets'])
      expect(slow).not.toContain(`"${route}"`);
  });

  it('alerts on any catalog entry skipped by the API or the worker within 15 minutes', () => {
    const rules = (module('alerts').properties.template?.variables ?? {}).appLogAlerts as Record<
      string,
      unknown
    >[];
    const rule = rules.find((r) => r.key === 'catalog-skipped');
    expect(rule).toMatchObject({ window: 'PT15M', aggregation: 'Count', threshold: 1 });
    expect(String(rule?.query)).toContain("Log has ''catalog entry skipped''");
    expect(String(rule?.query)).not.toMatch(/[,|]\s*(kind|id)\s*=/);
    expect(String(rule?.query)).toContain('{0}');
    expect(text((module('alerts').properties.template?.variables ?? {}).consoleLogs)).toContain(
      'workerAppName',
    );
  });

  it('the API slow alert still counts the conversation list, eval runs and batch runs', () => {
    const slow = text((module('alerts').properties.template?.variables ?? {}).slowByDesignPaths);
    for (const route of ['/api/conversations', '/eval-runs', '/batch-runs'])
      expect(slow).not.toContain(route);
  });

  it('switches Failure Anomalies off and tests /health every 5 minutes in test', () => {
    const detector = inner('alerts').find(
      (r) => r.type.toLowerCase() === 'microsoft.alertsmanagement/smartdetectoralertrules',
    );
    expect(detector?.properties.state).toBe('Disabled');
    expect(setting(test, 'healthCheckFrequencySeconds')).toBe(300);
  });

  it('sends every alert to the email group only, with no SMS or other receivers', () => {
    const group = inner('alerts').find((r) => r.type === 'Microsoft.Insights/actionGroups');
    expect(Object.keys(group?.properties ?? {}).filter((key) => key.endsWith('Receivers'))).toEqual(
      ['emailReceivers'],
    );
  });

  it('budgets 5,000 kr for infrastructure and 8,000 kr for models in test, each at 80 % and 100 % actual and 100 % forecast', () => {
    expect(setting(test, 'infraBudgetAmount')).toBe(5000);
    expect(setting(test, 'modelsBudgetAmount')).toBe(8000);
    expect(main.variables.budgetNotifications).toEqual([
      { threshold: 80, type: 'Actual' },
      { threshold: 100, type: 'Actual' },
      { threshold: 100, type: 'Forecasted' },
    ]);
    for (const budget of ['budget-infra', 'budget-models'])
      expect(module(budget).properties.parameters?.notifications).toEqual({
        value: "[variables('budgetNotifications')]",
      });
    expect(text(module('budget-models').condition)).toContain('modelsBudgetResourceGroup');
  });
});
