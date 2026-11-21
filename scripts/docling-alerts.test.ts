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

// Docling replicas run out of memory (exit 137) when work piles up on one (issue 922): two alerts say so.
describe.skipIf(!hasAz && !process.env.CI)('the Docling alerts', () => {
  let alerts: Template;
  let apps: Template;
  let main: Template;
  beforeAll(() => {
    alerts = bicep('infra/modules/alerts.bicep');
    apps = bicep('infra/modules/containerapps.bicep');
    main = bicep('infra/main.bicep');
  }, 240_000);

  const group =
    "[resourceId('Microsoft.Insights/actionGroups', format('{0}-alerts', parameters('name')))]";

  it('alerts the action group when a Docling container ends with exit code 137', () => {
    const rules = list(alerts.resources).find(
      (r) => r.type === 'Microsoft.Insights/scheduledQueryRules',
    );
    const rule = (
      alerts.variables.appLogAlerts as { key: string; query: string; threshold: unknown }[]
    ).find((r) => r.key === 'docling-out-of-memory');

    // ARM writes a quote inside format() twice.
    const query = (rule?.query ?? '').replaceAll("''", "'");
    expect(query).toContain('ContainerAppSystemLogs');
    expect(query).toContain("parameters('doclingAppName')");
    expect(query).toContain("Reason == 'ContainerTerminated'");
    expect(query).toContain("exit code '137'");
    expect(rule?.threshold).toBe(1);
    expect(text(rules?.properties.actions)).toContain(group);
  });

  it("alerts the action group when a Docling replica's 1-minute memory passes 85 % of its limit", () => {
    const alert = list(alerts.resources).find(
      (r) =>
        r.type === 'Microsoft.Insights/metricAlerts' && text(r.name).includes('docling-memory'),
    );
    const props = alert?.properties as {
      scopes: string[];
      evaluationFrequency: string;
      windowSize: string;
      criteria: { allOf: Record<string, unknown>[] };
      actions: { actionGroupId: string }[];
    };

    expect(text(props.scopes)).toContain("parameters('doclingAppName')");
    expect(props.evaluationFrequency).toBe('PT1M');
    expect(props.windowSize).toBe('PT1M');
    const criterion = props.criteria.allOf[0] as Record<string, unknown>;
    expect(criterion).toMatchObject({
      metricNamespace: 'Microsoft.App/containerApps',
      metricName: 'WorkingSetBytes',
      operator: 'GreaterThan',
      timeAggregation: 'Maximum',
      dimensions: [{ name: 'podName', operator: 'Include', values: ['*'] }],
    });
    expect(criterion.threshold).toBe(
      "[div(mul(mul(parameters('doclingMemoryGiB'), 1073741824), 85), 100)]",
    );
    expect(props.actions[0]?.actionGroupId).toBe(group);
  });

  it("sets the memory threshold from the replica's memory setting", () => {
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
