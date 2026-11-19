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
  properties: Record<string, unknown> & {
    template?: { resources: Resource[]; variables?: Record<string, unknown> };
    roleDefinitionId?: string;
    principalId?: string;
  };
}
interface Built {
  parameters: Record<string, { defaultValue?: unknown }>;
  variables?: Record<string, string>;
  resources: Resource[];
}

const acrPull = '7f951dda-4ed3-4680-a7ca-43fe172d538d';
const secretsUser = '4633458b-17de-408a-b874-0445c86b69e6';

describe.skipIf(!hasAz && !process.env.CI)('the assistant host in the template', () => {
  let built: Built | undefined;
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
  const module = (name: string, within = main().resources) => {
    const found = within.find((r) => r.name === name);
    if (!found?.properties.template) throw new Error(`no module ${name}`);
    return found;
  };
  const host = () => [
    ...(module('assistant-host-infra').properties.template?.resources ?? []),
    ...(module('assistant-host').properties.template?.resources ?? []),
  ];
  const roles = (resources: Resource[]) =>
    resources.filter((r) => r.type === 'Microsoft.Authorization/roleAssignments');

  it('is off unless an environment turns it on, and only test does', () => {
    expect(main().parameters.assistantHostEnabled?.defaultValue).toBe(false);
    expect(module('assistant-host').condition).toBe("[parameters('assistantHostEnabled')]");
    expect(module('assistant-host-infra').condition).toBe(
      "[and(parameters('assistantHostEnabled'), variables('infra'))]",
    );
    expect(read('infra/env/test.bicepparam')).toMatch(/^param assistantHostEnabled = true$/m);
    expect(read('infra/env/prod.bicepparam')).not.toMatch(/assistantHostEnabled/);
  });

  it('runs in an environment of its own, with one replica at least', () => {
    const environments = (
      module('assistant-host-infra').properties.template?.resources ?? []
    ).filter((r) => r.type === 'Microsoft.App/managedEnvironments');
    expect(environments.map((r) => r.name)).toEqual([
      "[format('{0}-hosted-env', parameters('name'))]",
    ]);
    const app = host().find((r) => r.type === 'Microsoft.App/containerApps');
    expect(JSON.stringify(app?.properties)).toContain(
      "createObject('name', 'APP', 'value', 'assistant')",
    );
    const template = module('assistant-host').properties.template as {
      parameters?: Record<string, { defaultValue?: unknown }>;
    };
    expect(template.parameters?.minReplicas?.defaultValue).toBe(1);
    expect(module('assistant-host').properties.parameters).not.toHaveProperty('minReplicas');
  });

  it('the host identity has no role on genki’s Key Vault or Postgres: only AcrPull, and Secrets User on its own vault', () => {
    const own = roles(host());
    expect(own).toHaveLength(1);
    expect(own[0]?.properties.roleDefinitionId).toContain("variables('acrPull')");
    expect(module('assistant-host-infra').properties.template?.variables?.acrPull).toBe(acrPull);
    const vault = module('assistant-host-vault', host());
    expect(JSON.stringify(vault.properties)).toContain("'{0}-hostkv'");
    const vaultRoles = roles(vault.properties.template?.resources ?? []);
    expect(vaultRoles.map((r) => r.properties.roleDefinitionId)).toEqual([
      expect.stringContaining("variables('secretsUser')"),
    ]);
    expect(vault.properties.template?.variables?.secretsUser).toBe(secretsUser);
    const text = JSON.stringify(host());
    expect(text).not.toMatch(/api-id|Microsoft\.DBforPostgreSQL|keyVaultUri|-kv-/);
  });

  it('binds genki’s own assistant hostname on the host app in stages of its own, which follow the other apps’ unless set', () => {
    expect(main().variables?.assistantNames).toContain(
      "createObject('hostname', toLower(parameters('hostnames').assistant), 'tenant', parameters('platformTenant'), 'stage', parameters('assistantHostnameStage'))",
    );
    expect(main().parameters.assistantHostnameStage?.defaultValue).toBe(
      "[parameters('customDomainsStage')]",
    );
    expect(main().variables?.servedNames).toBe(
      "[concat(variables('hostedNames'), variables('assistantNames'))]",
    );
    expect(module('assistant-host').properties.parameters?.hostedHostnames).toEqual({
      value: "[variables('servedNames')]",
    });
    expect(read('infra/env/test.bicepparam')).toMatch(
      /assistant: 'assistant\.genki-test\.digdir\.cloud'/,
    );
  });

  it('opens the assistant hostname on the API only while the host runs, and verifies it against the host’s own environment', () => {
    const api = JSON.stringify(module('containerapps').properties.parameters);
    expect(api).toContain(
      `"GENAI_ASSISTANT_HOSTNAME":"[if(parameters('assistantHostEnabled'), coalesce(tryGet(parameters('hostnames'), 'assistant'), ''), '')]"`,
    );
    expect(api).toContain("map(variables('servedNames')");
    const dns = JSON.stringify(module('dns').properties.parameters);
    expect(dns).toMatch(/'assistant-host'\), '[\d-]+'\)\.outputs\.verificationId\.value/);
  });

  it('the BFF proxy key is off by default and comes from each app’s own Key Vault', () => {
    expect(main().parameters.assistantBffEnabled?.defaultValue).toBe(false);
    const app = host().find((r) => r.type === 'Microsoft.App/containerApps');
    const hostText = JSON.stringify(app?.properties);
    expect(hostText).toContain("parameters('bffProxyKey')");
    expect(hostText).toContain("reference(resourceId('Microsoft.KeyVault/vaults'");
    expect(hostText).not.toContain('keyVaultUri');
    const apps = JSON.stringify(module('containerapps').properties);
    expect(apps).toMatch(/genai-proxy-key.*keyVaultUri|keyVaultUri.*genai-proxy-key/);
    expect(module('containerapps').properties.parameters).toHaveProperty('bffProxyKey');
  });
});
