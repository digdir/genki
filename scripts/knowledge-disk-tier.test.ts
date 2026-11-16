import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// The knowledge server's disk performance tier (issue 599): test's was raised to P30 by hand for the Kudos fill.

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

// Checked as Azure gets it, as in worker-resources.test.ts: GitHub's runners have the Azure CLI.
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
    // The parameter files read these without a default.
    env: { ...process.env, PG_ADMIN_GROUP_OBJECT_ID: 'group', PG_ADMIN_GROUP_NAME: 'group' },
  });

interface Module {
  name: string;
  properties: {
    parameters: Record<string, { value: unknown }>;
    template: { resources: { type: string; properties: { storage?: unknown } }[] };
  };
}

describe.skipIf(!hasAz && !process.env.CI)("the knowledge server's disk tier", () => {
  let modules: Module[] | undefined;
  let testTier: unknown;
  // `az bicep build` takes several seconds, so once, outside any test's timeout
  beforeAll(() => {
    modules = (
      JSON.parse(bicep(['build', '--file', join(root, 'infra/main.bicep')])) as {
        resources: Module[];
      }
    ).resources;
    const built = JSON.parse(
      bicep(['build-params', '--file', join(root, 'infra/env/test.bicepparam')]),
    ) as { parametersJson: string };
    const { parameters } = JSON.parse(built.parametersJson) as {
      parameters: Record<string, { value: unknown }>;
    };
    testTier = parameters.knowledgePostgresPerformanceTier?.value;
  }, 120_000);
  const postgres = (name: string) => {
    const found = modules?.find((m) => m.name === name);
    if (!found) throw new Error(`no ${name} module in the template`);
    return found;
  };
  const storage = (name: string) =>
    JSON.stringify(
      postgres(name).properties.template.resources.find(
        (r) => r.type === 'Microsoft.DBforPostgreSQL/flexibleServers',
      )?.properties.storage,
    );

  it("the knowledge server's performance tier comes from the environment's parameters", () => {
    expect(postgres('knowledge-postgres').properties.parameters.performanceTier).toEqual({
      value: "[parameters('knowledgePostgresPerformanceTier')]",
    });
    expect(storage('knowledge-postgres')).toContain(
      "createObject('tier', parameters('performanceTier'))",
    );
    // Test stays at the tier it was raised to until a week of Kudos searches picks one (issue 599).
    expect(testTier).toBe('P30');
  });

  it("leaving the tier out keeps the server's current tier", () => {
    // An empty tier sends no `tier` at all, as the template did before it took one.
    expect(storage('knowledge-postgres')).toContain(
      "if(empty(parameters('performanceTier')), createObject(), createObject('tier', parameters('performanceTier')))",
    );
    expect(postgres('postgres').properties.parameters).not.toHaveProperty('performanceTier');
    expect(read('infra/env/prod.bicepparam')).not.toContain('knowledgePostgresPerformanceTier');
  });
});
