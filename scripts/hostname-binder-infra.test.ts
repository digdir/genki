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
  identity?: { type: string; userAssignedIdentities: Record<string, unknown> };
  scope?: string;
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

type Condition = Record<string, unknown>;
type Summary = unknown[];

const operatorOf = (c: Condition) => {
  const key = Object.keys(c).find((k) => k !== 'field' && k !== 'count');
  return key ? [key, c[key]] : [];
};

const summary = (c: Condition): Summary => {
  if (Array.isArray(c.anyOf)) return ['anyOf', (c.anyOf as Condition[]).map(summary)];
  if (Array.isArray(c.allOf)) return ['allOf', (c.allOf as Condition[]).map(summary)];
  if (c.count) {
    const count = c.count as { field: string; where?: Condition };
    return ['count', count.field, count.where ? summary(count.where) : null, operatorOf(c)];
  }
  return [c.field, operatorOf(c)];
};

const env = "[variables('env')]";
const envField = (name: string) => `[format('{0}.${name}', variables('env'))]`;
const app = (path: string) => `Microsoft.App/containerApps/${path}`;
const counted = (field: string) => ['count', field, null, ['greater', 0]];
const envWhere = (name: string, operator: unknown[]) => [
  'count',
  env,
  ['allOf', [[envField('name'), ['equals', name]], operator]],
  ['greater', 0],
];

const build = (file: string) =>
  JSON.parse(
    execFileSync('az', ['bicep', 'build', '--file', join(root, file), '--stdout'], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
  ) as Built;

const adrActions = [
  'Microsoft.App/containerApps/read',
  'Microsoft.App/containerApps/write',
  'Microsoft.App/containerApps/listCustomHostNameAnalysis/action',
  'Microsoft.App/managedEnvironments/read',
  'Microsoft.App/managedEnvironments/join/action',
  'Microsoft.App/managedEnvironments/managedCertificates/read',
  'Microsoft.App/managedEnvironments/managedCertificates/write',
  'Microsoft.App/managedEnvironments/managedCertificates/delete',
  'Microsoft.ManagedIdentity/userAssignedIdentities/assign/action',
  'Microsoft.Network/dnsZones/CNAME/read',
  'Microsoft.Network/dnsZones/CNAME/write',
  'Microsoft.Network/dnsZones/CNAME/delete',
  'Microsoft.Network/dnsZones/TXT/read',
  'Microsoft.Network/dnsZones/TXT/write',
  'Microsoft.Network/dnsZones/TXT/delete',
];

describe.skipIf(!hasAz && !process.env.CI)('the hostname binder in the template', () => {
  let main: Built | undefined;
  let access: Built | undefined;
  beforeAll(() => {
    main = build('infra/main.bicep');
    access = build('infra/hostname-binder-access.bicep');
  }, 120_000);
  const built = () => {
    if (!main || !access) throw new Error('the templates did not build');
    return { main, access };
  };
  const module = (name: string, within: Resource[]) => {
    const found = within.find((r) => r.name === name);
    if (!found?.properties.template) throw new Error(`no module ${name}`);
    return found;
  };
  const binder = () => module('hostname-binder', built().main.resources);
  const binderResources = () => binder().properties.template?.resources ?? [];
  const grants = () => module('hostname-binder-access', built().access.resources);
  const policy = (name: string) =>
    built().access.resources.find(
      (r) => r.type === 'Microsoft.Authorization/policyDefinitions' && r.name.includes(name),
    )?.properties.policyRule as { if: Condition; then: unknown };
  const grantResources = (type: string) =>
    (grants().properties.template?.resources ?? []).filter((r) => r.type === type);
  const allResources = (resources: Resource[]): Resource[] =>
    resources.flatMap((r) => [r, ...allResources(r.properties?.template?.resources ?? [])]);

  it('is off unless an environment turns it on, and only test does', () => {
    expect(built().main.parameters.hostnameBinderEnabled?.defaultValue).toBe(false);
    expect(built().main.variables?.binderOn).toBe(
      "[and(parameters('assistantHostEnabled'), parameters('hostnameBinderEnabled'))]",
    );
    expect(binder().condition).toBe("[variables('binderJobOn')]");
    expect(built().main.variables?.binderJobOn).toBe(
      "[and(variables('binderOn'), not(empty(parameters('hostnameBinderAudience'))))]",
    );
    expect(read('infra/env/prod.bicepparam')).not.toMatch(/hostnameBinder/);
  });

  it('is on in test unless a bootstrap deploy sets HOSTNAME_BINDER_ENABLED=false', () => {
    const withoutFlag = Object.fromEntries(
      Object.entries(process.env).filter(([key]) => key !== 'HOSTNAME_BINDER_ENABLED'),
    );
    const enabled = (value: string | undefined) => {
      const output = execFileSync(
        'az',
        ['bicep', 'build-params', '--file', join(root, 'infra/env/test.bicepparam'), '--stdout'],
        {
          encoding: 'utf8',
          env: {
            ...withoutFlag,
            PG_ADMIN_GROUP_OBJECT_ID: '00000000-0000-0000-0000-000000000000',
            PG_ADMIN_GROUP_NAME: 'pg-admins',
            ...(value === undefined ? {} : { HOSTNAME_BINDER_ENABLED: value }),
          },
        },
      );
      const params = JSON.parse(
        (JSON.parse(output) as { parametersJson: string }).parametersJson,
      ) as { parameters: { hostnameBinderEnabled: { value: boolean } } };
      return params.parameters.hostnameBinderEnabled.value;
    };
    expect(enabled(undefined)).toBe(true);
    expect(enabled('')).toBe(true);
    expect(enabled('false')).toBe(false);
  }, 120_000);

  it('runs as a job every minute, one run at a time, ended before the next one starts', () => {
    const job = binderResources().find((r) => r.type === 'Microsoft.App/jobs');
    const configuration = job?.properties.configuration as Record<string, unknown>;
    expect(configuration.triggerType).toBe('Schedule');
    expect(configuration.scheduleTriggerConfig).toEqual({
      cronExpression: '* * * * *',
      parallelism: 1,
      replicaCompletionCount: 1,
    });
    expect(configuration.replicaTimeout).toBeLessThan(60);
    expect(configuration.replicaRetryLimit).toBe(0);
    expect(JSON.stringify(job?.properties.environmentId)).toContain('-hosted-env');
  });

  it('the job carries only the binder identity and no secret, Key Vault or database setting', () => {
    const job = binderResources().find((r) => r.type === 'Microsoft.App/jobs');
    expect(Object.keys(job?.identity?.userAssignedIdentities ?? {})).toEqual([
      "[format('{0}', parameters('identityId'))]",
    ]);
    expect((job?.properties.configuration as { secrets: unknown[] }).secrets).toEqual([]);
    const text = JSON.stringify(job);
    expect(text).not.toMatch(/secretRef|keyVault|PGHOST|DATABASE|-kv-|hostkv|api-id/i);
    expect(JSON.stringify(binder().properties.parameters?.identityId)).toContain(
      "format('{0}-binder-id', variables('baseName'))",
    );
  });

  it('the template gives the binder identity AcrPull only; its custom role is applied by an owner', () => {
    const roles = binderResources().filter(
      (r) => r.type === 'Microsoft.Authorization/roleAssignments',
    );
    expect(roles).toHaveLength(1);
    expect(JSON.stringify(roles[0]?.properties.roleDefinitionId)).toContain("variables('acrPull')");
    expect(binder().properties.template?.variables?.acrPull).toBe(
      '7f951dda-4ed3-4680-a7ca-43fe172d538d',
    );
    const types = allResources(built().main.resources).map((r) => r.type);
    expect(types).not.toContain('Microsoft.Authorization/roleDefinitions');
    expect(types).not.toContain('Microsoft.Authorization/policyDefinitions');
    expect(types).not.toContain('Microsoft.Authorization/policyAssignments');
  });

  it('the custom role has exactly the actions ADR 0062 lists, and no data action', () => {
    const role = built().access.resources.find(
      (r) => r.type === 'Microsoft.Authorization/roleDefinitions',
    );
    const permissions = (role?.properties.permissions as Record<string, unknown>[])[0];
    expect(permissions?.actions).toBe("[variables('binderActions')]");
    expect(built().access.variables?.binderActions).toEqual(adrActions);
    expect(permissions).toMatchObject({ notActions: [], dataActions: [], notDataActions: [] });
    for (const action of adrActions)
      expect(read('docs/adr/0062-a-service-owner-adds-a-hostname.md')).toContain(`\`${action}\``);
  });

  it('the custom role is assigned only on the host app, its environment, its identity and the apps zone', () => {
    const assignments = (grants().properties.template?.resources ?? []).filter(
      (r) => r.type === 'Microsoft.Authorization/roleAssignments',
    );
    expect(assignments.map((r) => r.scope).sort()).toEqual(
      [
        "[resourceId('Microsoft.App/containerApps', format('{0}-assistant', parameters('baseName')))]",
        "[resourceId('Microsoft.App/managedEnvironments', format('{0}-hosted-env', parameters('baseName')))]",
        "[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', format('{0}-assistant-id', parameters('baseName')))]",
        "[resourceId('Microsoft.Network/dnsZones', format('apps.{0}', parameters('dnsZoneName')))]",
      ].sort(),
    );
    for (const assignment of assignments)
      expect(assignment.properties).toEqual({
        principalId:
          "[reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', format('{0}-binder-id', parameters('baseName'))), '2023-01-31').principalId]",
        principalType: 'ServicePrincipal',
        roleDefinitionId: "[parameters('roleDefinitionId')]",
      });
    expect(JSON.stringify(built().access.resources)).toContain(
      '"assignableScopes":["[variables(\'groupScope\')]"]',
    );
  });

  it('the policy on the host app denies every change the binder does not need', () => {
    const rule = policy('assistant-host-fence');
    expect(rule.then).toEqual({ effect: "[[parameters('effect')]" });
    expect(summary(rule.if)).toEqual([
      'allOf',
      [
        ['type', ['equals', 'Microsoft.App/containerApps']],
        ['name', ['equals', "[[parameters('appName')]"]],
        [
          'anyOf',
          [
            ['count', app('template.containers[*]'), null, ['notEquals', 1]],
            [
              'count',
              app('template.containers[*]'),
              [app('template.containers[*].name'), ['notEquals', 'assistant']],
              ['greater', 0],
            ],
            [
              'count',
              app('template.containers[*]'),
              [
                app('template.containers[*].image'),
                ['notLike', "[[concat(parameters('loginServer'), '/genai-apps@sha256:*')]"],
              ],
              ['greater', 0],
            ],
            counted(app('template.containers[*].command[*]')),
            counted(app('template.containers[*].args[*]')),
            counted(app('template.containers[*].volumeMounts[*]')),
            [
              'count',
              env,
              [
                envField('name'),
                ['notIn', ['APP', 'API_UPSTREAM', 'ANSATTPORTEN_ISSUER', 'GENAI_PROXY_KEY']],
              ],
              ['greater', 0],
            ],
            envWhere('APP', [envField('value'), ['notEquals', 'assistant']]),
            envWhere('API_UPSTREAM', [
              envField('value'),
              ['notEquals', "[[parameters('apiUpstream')]"],
            ]),
            envWhere('ANSATTPORTEN_ISSUER', [
              envField('value'),
              ['notEquals', "[[parameters('issuer')]"],
            ]),
            envWhere('GENAI_PROXY_KEY', [envField('secretRef'), ['notEquals', 'genai-proxy-key']]),
            [
              'count',
              env,
              [
                'allOf',
                [
                  [envField('name'), ['notEquals', 'GENAI_PROXY_KEY']],
                  [envField('secretRef'), ['exists', true]],
                ],
              ],
              ['greater', 0],
            ],
            counted(app('template.initContainers[*]')),
            counted(app('template.volumes[*]')),
            counted(app('template.scale.rules[*]')),
            counted(app('template.serviceBinds[*]')),
            [app('configuration.dapr.enabled'), ['equals', true]],
            [app('configuration.ingress.allowInsecure'), ['equals', true]],
            [app('configuration.ingress.external'), ['notEquals', true]],
            [app('configuration.ingress.targetPort'), ['notEquals', 8080]],
            [
              'count',
              app('configuration.secrets[*]'),
              [
                'anyOf',
                [
                  [app('configuration.secrets[*].name'), ['notEquals', 'genai-proxy-key']],
                  [
                    app('configuration.secrets[*].keyVaultUrl'),
                    ['notEquals', "[[parameters('proxyKeyUrl')]"],
                  ],
                  [
                    app('configuration.secrets[*].identity'),
                    ['notEquals', "[[parameters('identityId')]"],
                  ],
                ],
              ],
              ['greater', 0],
            ],
            [
              'count',
              app('configuration.registries[*]'),
              [
                'anyOf',
                [
                  [
                    app('configuration.registries[*].server'),
                    ['notEquals', "[[parameters('loginServer')]"],
                  ],
                  [
                    app('configuration.registries[*].identity'),
                    ['notEquals', "[[parameters('identityId')]"],
                  ],
                ],
              ],
              ['greater', 0],
            ],
            ['identity.type', ['notEquals', 'UserAssigned']],
          ],
        ],
      ],
    ]);
    expect(built().access.parameters.policyEffect?.defaultValue).toBe('Deny');
  });

  it('the policy on the apps zone denies records that do not point at the host', () => {
    const rule = policy('apps-zone-fence');
    const dns = (path: string) => `Microsoft.Network/dnszones/${path}`;
    expect(rule.then).toEqual({ effect: "[[parameters('effect')]" });
    expect(summary(rule.if)).toEqual([
      'allOf',
      [
        ['fullName', ['like', "[[concat(parameters('zoneName'), '/*')]"]],
        [
          'anyOf',
          [
            [
              'allOf',
              [
                ['type', ['equals', dns('CNAME')]],
                [
                  'anyOf',
                  [
                    [dns('CNAME/CNAMERecord.cname'), ['notEquals', "[[parameters('target')]"]],
                    ['name', ['contains', '.']],
                  ],
                ],
              ],
            ],
            [
              'allOf',
              [
                ['type', ['equals', dns('TXT')]],
                [
                  'anyOf',
                  [
                    ['name', ['notLike', 'asuid.*']],
                    [
                      'count',
                      dns('TXT/TXTRecords[*].value[*]'),
                      [
                        dns('TXT/TXTRecords[*].value[*]'),
                        ['notEquals', "[[parameters('verificationId')]"],
                      ],
                      ['greater', 0],
                    ],
                  ],
                ],
              ],
            ],
            ['type', ['notIn', [dns('CNAME'), dns('TXT'), dns('NS'), dns('SOA')]]],
          ],
        ],
      ],
    ]);
  });

  it('assigns both fences in the resource group with the chosen effect and the host’s own values', () => {
    const assignments = grantResources('Microsoft.Authorization/policyAssignments');
    const parameters = (definition: string) =>
      assignments.find((a) => a.properties.policyDefinitionId === `[parameters('${definition}')]`)
        ?.properties.parameters as Record<string, { value: string }> | undefined;
    const host = parameters('hostFenceId');
    expect(host?.effect?.value).toBe("[parameters('policyEffect')]");
    expect(host?.appName?.value).toBe("[format('{0}-assistant', parameters('baseName'))]");
    expect(host?.identityId?.value).toBe(
      "[resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', format('{0}-assistant-id', parameters('baseName')))]",
    );
    expect(host?.proxyKeyUrl?.value).toContain('hostkv');
    expect(host?.apiUpstream?.value).toContain("equals(lambdaVariables('e').name, 'API_UPSTREAM')");
    expect(host?.issuer?.value).toContain(
      "equals(lambdaVariables('e').name, 'ANSATTPORTEN_ISSUER')",
    );
    const records = parameters('recordFenceId');
    expect(records?.effect?.value).toBe("[parameters('policyEffect')]");
    expect(records?.zoneName?.value).toBe("[format('apps.{0}', parameters('dnsZoneName'))]");
    expect(records?.target?.value).toContain('.configuration.ingress.fqdn');
    expect(records?.verificationId?.value).toContain('customDomainVerificationId');
  });

  it('sets the binder’s principal, audience, tenant and genki’s zone on the API while the binder is on', () => {
    const api = JSON.stringify(
      module('containerapps', built().main.resources).properties.parameters?.identityEnv,
    );
    expect(api).toContain(
      `"GENAI_HOSTNAME_BINDER_PRINCIPAL_ID":"[if(variables('binderOn'), reference(resourceId('Microsoft.ManagedIdentity/userAssignedIdentities', format('{0}-binder-id', variables('baseName'))), '2023-01-31').principalId, '')]"`,
    );
    expect(api).toContain(
      `"GENAI_HOSTNAME_BINDER_AUDIENCE":"[if(variables('binderOn'), parameters('hostnameBinderAudience'), '')]"`,
    );
    expect(api).toContain(
      `"GENAI_HOSTNAME_BINDER_TENANT_ID":"[if(variables('binderOn'), tenant().tenantId, '')]"`,
    );
    expect(api).toContain(
      `"GENAI_DNS_ZONE":"[if(and(variables('binderOn'), parameters('createDnsZone')), parameters('dnsZoneName'), '')]"`,
    );
  });

  it('gives the API and the worker the host app’s address and verification id for the DNS check', () => {
    const containerApps = module('containerapps', built().main.resources);
    const identityEnv = JSON.stringify(containerApps.properties.parameters?.identityEnv);
    const existing = (type: string, name: string) =>
      `reference(resourceId('${type}', format('${name}', variables('baseName'))), '2025-02-02-preview')`;
    const hostApp = existing('Microsoft.App/containerApps', '{0}-assistant');
    const hostedEnv = existing('Microsoft.App/managedEnvironments', '{0}-hosted-env');
    expect(identityEnv).toContain(
      `"GENAI_ASSISTANT_HOST_FQDN":"[if(variables('binderOn'), ${hostApp}.configuration.ingress.fqdn, '')]"`,
    );
    expect(identityEnv).toContain(
      `"GENAI_ASSISTANT_HOST_VERIFICATION_ID":"[if(variables('binderOn'), ${hostedEnv}.customDomainConfiguration.customDomainVerificationId, '')]"`,
    );
    expect(identityEnv).toContain(
      `"GENAI_ASSISTANT_HOST_STATIC_IP":"[if(variables('binderOn'), ${hostedEnv}.staticIp, '')]"`,
    );
    expect(identityEnv).toContain(
      `"GENAI_HOSTNAME_LIMIT":"[if(and(variables('binderOn'), greater(parameters('hostnameLimit'), 0)), string(parameters('hostnameLimit')), '')]"`,
    );
    expect(built().main.parameters.hostnameLimit?.defaultValue).toBe(0);
    const template = containerApps.properties.template;
    expect(JSON.stringify(template?.variables?.serverEnv)).toContain(
      "variables('identityPlainEnv')",
    );
    const envOf = (name: string) =>
      JSON.stringify(
        allResources(template?.resources ?? []).find((r) => JSON.stringify(r.name).includes(name))
          ?.properties,
      );
    expect(envOf("'{0}-api'")).toContain("variables('serverEnv')");
    expect(envOf("'{0}-worker'")).toContain("variables('serverEnv')");
  });

  it('mails hostname-binder-writes only from severity 2 up, and hostname-fence always', () => {
    const template = binder().properties.template;
    const alert = (suffix: string) =>
      template?.resources.find((r) => r.name === `[format('{0}-${suffix}', parameters('name'))]`)
        ?.properties.actions;
    expect(binder().properties.parameters?.mailWrites).toEqual({
      value: "[lessOrEquals(2, parameters('alertMailMaxSeverity'))]",
    });
    expect(alert('hostname-binder-writes')).toEqual({
      actionGroups:
        "[if(parameters('mailWrites'), createArray(createObject('actionGroupId', parameters('actionGroupId'))), createArray())]",
    });
    expect(alert('hostname-fence')).toEqual({
      actionGroups: [{ actionGroupId: "[parameters('actionGroupId')]" }],
    });
  });

  it('the infrastructure template passes the host app’s domains through', () => {
    expect(
      module('assistant-host', built().main.resources).properties.parameters?.keptDomains,
    ).toBe(
      "[if(variables('keptOn'), createObject('value', coalesce(tryGet(reference(resourceId('Microsoft.App/containerApps', format('{0}-assistant', variables('baseName'))), '2025-02-02-preview').configuration.ingress, 'customDomains'), createArray())), createObject('value', createArray()))]",
    );
    expect(built().main.parameters.keepBoundDomains?.defaultValue).toBe(
      "[parameters('hostnameBinderEnabled')]",
    );
  });

  it('tells the binder every name the template binds', () => {
    expect(binder().properties.parameters?.reservedHostnames).toEqual({
      value:
        "[map(concat(variables('servedNames'), variables('loginNames')), lambda('h', lambdaVariables('h').hostname))]",
    });
  });

  it('the job sets every setting the binder reads', () => {
    const job = binderResources().find((r) => r.type === 'Microsoft.App/jobs');
    const container = (
      job?.properties.template as unknown as {
        containers: { env: { name: string }[]; command: string[] }[];
      }
    ).containers[0];
    expect(container?.command).toEqual(['node', 'scripts/hostname-binder.ts']);
    const settings = [
      ...readFileSync(join(root, 'scripts/hostname-binder.ts'), 'utf8').matchAll(
        /(?:required\('|env\.)([A-Z_]+)/g,
      ),
    ]
      .map((m) => m[1])
      .filter((name) => !name?.startsWith('IDENTITY_'));
    expect(new Set(container?.env.map((e) => e.name))).toEqual(new Set(settings));
    expect(read('Dockerfile')).toContain('scripts/hostname-binder.ts');
  });

  it('puts the hosted names in a delegated apps zone of their own while the binder runs', () => {
    expect(module('dns', built().main.resources).properties.parameters?.appsZone).toEqual({
      value: "[variables('binderOn')]",
    });
    const dns = module('dns', built().main.resources).properties.template;
    const delegation = dns?.resources.find((r) => r.type === 'Microsoft.Network/dnsZones/NS');
    expect(delegation?.name).toBe("[format('{0}/{1}', parameters('zoneName'), 'apps')]");
    expect(delegation?.condition).toBe("[parameters('appsZone')]");
    expect(dns?.variables?.childLabels).toBe(
      "[if(parameters('appsZone'), map(parameters('hostedLabels'), lambda('label', substring(lambdaVariables('label'), 0, sub(length(lambdaVariables('label')), length(variables('appsSuffix')))))), createArray())]",
    );
    const child = dns?.resources.find(
      (r) => r.type === 'Microsoft.Network/dnsZones/CNAME' && r.name.includes('childLabels'),
    );
    expect(child?.name).toContain("format('apps.{0}', parameters('zoneName'))");
  });
});
