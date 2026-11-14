import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

// The worker's size in the template, apart from the API's (issue 338): a Kudos listing ran out of 1 GiB.

const root = join(import.meta.dirname, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

// Checked as Azure gets it, as in docling-server.test.ts: GitHub's runners have the Azure CLI.
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
  properties: { template?: { containers?: unknown } } & Record<string, unknown>;
}
interface Built {
  parameters: Record<string, { defaultValue?: unknown }>;
  resources: {
    name: string;
    properties: { template?: { variables: Record<string, unknown>; resources: Resource[] } };
  }[];
}

describe.skipIf(!hasAz && !process.env.CI)('the worker in the template', () => {
  let built: Built | undefined;
  // `az bicep build` takes several seconds, so once, outside any test's timeout
  beforeAll(() => {
    built = JSON.parse(
      execFileSync('az', ['bicep', 'build', '--file', join(root, 'infra/main.bicep'), '--stdout'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as Built;
  }, 120_000);
  const main = (): Built => {
    if (!built) throw new Error('the template did not build');
    return built;
  };
  const apps = () => {
    const template = main().resources.find((r) => r.name === 'containerapps')?.properties.template;
    if (!template) throw new Error('no containerapps module in the template');
    return template;
  };
  const container = (suffix: string) => {
    const app = apps().resources.find(
      (r) => r.type === 'Microsoft.App/containerApps' && r.name.includes(`'{0}-${suffix}'`),
    );
    if (!app) throw new Error(`no container app ${suffix} in the template`);
    return JSON.stringify(app.properties.template?.containers);
  };

  it('gives the worker its own cores and memory, 2 vCPU and 4 GiB in test and prod, and leaves the API at 0.5 and 1 GiB', () => {
    const defaults = Object.fromEntries(
      ['cpu', 'memory', 'workerCpu', 'workerMemory'].map((p) => [
        p,
        main().parameters[p]?.defaultValue,
      ]),
    );
    expect(defaults).toEqual({ cpu: '0.5', memory: '1Gi', workerCpu: '2', workerMemory: '4Gi' });
    // Neither environment overrides them.
    for (const file of ['test', 'prod'])
      expect(read(`infra/env/${file}.bicepparam`), file).not.toMatch(
        /param (cpu|memory|workerCpu|workerMemory)\b/,
      );
    expect(container('worker')).toContain(
      "'resources', createObject('cpu', json(parameters('workerCpu')), 'memory', parameters('workerMemory'))",
    );
    expect(container('api')).toContain(
      `"resources":{"cpu":"[json(parameters('cpu'))]","memory":"[parameters('memory')]"}`,
    );
  });

  it("gives the worker's Node heap three quarters of its memory, and the API no heap setting", () => {
    expect(apps().variables.workerHeapMb).toBe(
      "[mul(int(replace(parameters('workerMemory'), 'Gi', '')), 768)]",
    );
    expect(container('worker')).toContain(
      "createObject('name', 'NODE_OPTIONS', 'value', format('--max-old-space-size={0}', variables('workerHeapMb')))",
    );
    expect(container('api')).not.toContain('NODE_OPTIONS');
  });
});
