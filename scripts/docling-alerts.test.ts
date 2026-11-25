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

const bicep = (file: string) =>
  JSON.parse(
    execFileSync('az', ['bicep', 'build', '--file', join(root, file), '--stdout'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Template;

interface Resource {
  type: string;
  name: string;
  properties: Record<string, unknown>;
}

interface Template {
  parameters: Record<string, { defaultValue?: unknown }>;
  variables: Record<string, unknown>;
  resources: Resource[] | Record<string, Resource>;
  outputs?: Record<string, { value: unknown }>;
}

const list = (resources: Template['resources']) =>
  Array.isArray(resources) ? resources : Object.values(resources);
const text = (value: unknown) => JSON.stringify(value);

describe.skipIf(!hasAz && !process.env.CI)('the Docling alerts', () => {
  let alerts: Template;
  let apps: Template;
  let main: Template;
  beforeAll(() => {
    alerts = bicep('infra/modules/alerts.bicep');
    apps = bicep('infra/modules/containerapps.bicep');
    main = bicep('infra/main.bicep');
  }, 240_000);

  it('raises a Sev3 alert when at least 3 Docling containers end with exit code 137 within 15 minutes', () => {
    const rule = (
      alerts.variables.appLogAlerts as {
        key: string;
        query: string;
        severity: number;
        window: string;
        threshold: unknown;
      }[]
    ).find((r) => r.key === 'docling-out-of-memory');

    const query = (rule?.query ?? '').replaceAll("''", "'");
    expect(query).toContain('ContainerAppSystemLogs');
    expect(query).toContain("parameters('doclingAppName')");
    expect(query).toContain("Reason == 'ContainerTerminated'");
    expect(query).toContain("exit code '137'");
    expect(rule).toMatchObject({ severity: 3, window: 'PT15M' });
    expect(rule?.threshold).toBe("[parameters('thresholds').doclingKills]");
    expect(text(main.parameters.alertThresholds?.defaultValue)).toContain('"doclingKills":3');
  });

  it('has no per-replica memory alert, whose podName dimension kept alerts open after pods were gone', () => {
    const names = text(list(alerts.resources).map((r) => r.name));
    expect(names).not.toContain('docling-memory');
    expect(text(alerts.resources)).not.toContain('WorkingSetBytes');
  });

  it("passes the replica's memory setting to the idle restart and the alerts", () => {
    const docling = list(apps.resources).find(
      (r) => r.type === 'Microsoft.App/containerApps' && text(r.name).includes('-docling'),
    );
    expect(text(docling?.properties)).toContain(
      `"memory":"[format('{0}Gi', parameters('doclingMemoryGiB'))]"`,
    );
    expect(apps.outputs?.doclingMemoryGiB?.value).toBe("[parameters('doclingMemoryGiB')]");
    // The idle restart limit is half the memory, also for an odd size: 7 GiB gives 3.5.
    expect(text(docling?.properties)).toContain(
      `"name":"GENKI_DOCLING_RESTART_IDLE_GIB","value":"[format('{0}{1}', div(parameters('doclingMemoryGiB'), 2), if(equals(mod(parameters('doclingMemoryGiB'), 2), 1), '.5', ''))]"`,
    );
    const module = list(main.resources).find(
      (r) => r.type === 'Microsoft.Resources/deployments' && r.name === 'alerts',
    );
    const params = (module?.properties as { parameters: Record<string, unknown> }).parameters;
    expect(text(params.doclingMemoryGiB)).toContain('outputs.doclingMemoryGiB.value');
    expect(text(params.doclingAppName)).toContain('outputs.doclingName.value');
  });
});
