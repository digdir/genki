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

interface Resource {
  type: string;
  name: string;
  properties: Record<string, unknown> & {
    parameters?: Record<string, { value: unknown }>;
    template?: { resources: Resource[]; variables?: Record<string, unknown> };
  };
}
interface Built {
  parameters: Record<string, { defaultValue?: unknown }>;
  variables: Record<string, string>;
  resources: Resource[];
}

const testValues = (env: Record<string, string> = {}) => {
  const out = execFileSync(
    'az',
    ['bicep', 'build-params', '--file', join(root, 'infra/env/test.bicepparam'), '--stdout'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PG_ADMIN_GROUP_OBJECT_ID: '00000000-0000-0000-0000-000000000000',
        PG_ADMIN_GROUP_NAME: 'x',
        ANSATTPORTEN_ISSUER: '',
        ALTINN_PDP_URL: '',
        HOSTNAMES_STAGE: '',
        ...env,
      },
    },
  );
  const built = JSON.parse(out.slice(out.indexOf('{'))) as { parametersJson: string };
  const values = (
    JSON.parse(built.parametersJson) as { parameters: Record<string, { value: unknown }> }
  ).parameters;
  return (name: string) => values[name]?.value;
};

const appKeys = ['api', 'portal', 'console', 'assistant'] as const;

/** Every name test binds, as main.bicep derives them from the param file. */
const boundNames = (value: (name: string) => unknown) => {
  const zone = String(value('dnsZoneName'));
  const previous = String(value('previousDnsZoneName'));
  const hostnames = value('hostnames') as Record<string, string>;
  const subdomains = (value('hostedHostnames') as { subdomain?: string }[]).flatMap((h) =>
    h.subdomain ? [h.subdomain] : [],
  );
  const under = (z: string) => [
    ...appKeys.map((app) => hostnames[app]?.replace(`.${zone}`, `.${z}`) ?? ''),
    ...subdomains.map((s) => `${s}.apps.${z}`),
    `login.apps.${z}`,
  ];
  return { current: under(zone), previous: under(previous) };
};

describe.skipIf(!hasAz && !process.env.CI)('moving test to genki.digdir.cloud', () => {
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
  const module = (name: string) => {
    const found = main().resources.find((r) => r.name === name);
    if (!found?.properties.template) throw new Error(`no module ${name}`);
    return found;
  };
  const appsVariables = () =>
    (module('containerapps').properties.template?.variables ?? {}) as Record<string, string>;

  it('puts every name under genki.digdir.cloud and keeps the genki-test.digdir.cloud names bound', () => {
    const value = testValues();
    expect(value('dnsZoneName')).toBe('genki.digdir.cloud');
    expect(value('previousDnsZoneName')).toBe('genki-test.digdir.cloud');
    const { current, previous } = boundNames(value);
    expect(current).toEqual([
      'api.genki.digdir.cloud',
      'portal.genki.digdir.cloud',
      'console.genki.digdir.cloud',
      'assistant.genki.digdir.cloud',
      'kunnskap.apps.genki.digdir.cloud',
      'login.apps.genki.digdir.cloud',
    ]);
    expect(previous).toEqual(current.map((h) => h.replace('.genki.', '.genki-test.')));
  }, 120_000);

  it('binds no name twice', () => {
    const { current, previous } = boundNames(testValues());
    const all = [...current, ...previous];
    expect(new Set(all).size).toBe(all.length);
  }, 120_000);

  it('moves every new name through none, hostnames and certificates on HOSTNAMES_STAGE alone, none while unset', () => {
    const stages = (value: (name: string) => unknown) => [
      value('customDomainsStage'),
      value('assistantHostnameStage'),
      value('platformLoginStage'),
      ...(value('hostedHostnames') as { stage: string }[]).map((h) => h.stage),
    ];
    expect(new Set(stages(testValues()))).toEqual(new Set(['none']));
    for (const stage of ['hostnames', 'certificates'])
      expect(new Set(stages(testValues({ HOSTNAMES_STAGE: stage })))).toEqual(new Set([stage]));
  }, 120_000);

  it('gives each old name the managed certificate it already has, bound at every stage', () => {
    const domains = appsVariables().customDomains ?? '';
    expect(domains).toContain(
      "createObject('name', parameters('previousHostnames')[lambdaVariables('app')], 'bindingType', 'SniEnabled', 'certificateId', resourceId('Microsoft.App/managedEnvironments/managedCertificates', format('{0}-env', parameters('name')), replace(parameters('previousHostnames')[lambdaVariables('app')], '.', '-')))",
    );
    expect(main().variables.previousHosted).toContain("'stage', 'certificates'");
  });

  it('derives an old name by swapping the zone, and only when the zone changed', () => {
    expect(main().variables.previousOn).toBe(
      "[and(and(not(empty(parameters('previousDnsZoneName'))), not(empty(parameters('dnsZoneName')))), not(equals(parameters('previousDnsZoneName'), parameters('dnsZoneName'))))]",
    );
    expect(main().variables.previousHostnames).toContain(
      "endsWith(toLower(lambdaVariables('h').value), variables('zoneSuffix'))",
    );
    expect(main().parameters.previousDnsZoneName?.defaultValue).toBe('');
  });

  it('redirects an old web or hosted name only once its new name has a certificate, and never the API', () => {
    expect(appsVariables().redirects).toContain(
      "equals(parameters('customDomainsStage'), 'certificates')",
    );
    expect(main().variables.hostRedirects).toContain(
      "equals(lambdaVariables('h').nextStage, 'certificates')",
    );
    const api = JSON.stringify(
      module('containerapps').properties.template?.resources.find(
        (r) => r.type === 'Microsoft.App/containerApps' && !JSON.stringify(r).includes('webApps'),
      ),
    );
    expect(api).not.toContain('GENAI_REDIRECT_HOSTS');
    const web = JSON.stringify(
      module('containerapps').properties.template?.resources.find((r) =>
        JSON.stringify(r).includes("variables('webApps')"),
      ),
    );
    expect(web).toContain("'GENAI_REDIRECT_HOSTS', 'value', variables('redirects')");
    expect(module('assistant-host').properties.parameters?.redirectHosts).toEqual({
      value: "[variables('hostRedirects')]",
    });
  });

  it('signs in on the old login host and app origins until the new names have certificates', () => {
    expect(main().variables.liveLoginHostname).toBe(
      "[if(and(not(empty(variables('previousLogin'))), not(equals(parameters('platformLoginStage'), 'certificates'))), variables('previousLogin'), variables('platformLoginHostname'))]",
    );
    expect(main().variables.appOrigins).toContain("variables('liveHostnames')");
    expect(main().variables.liveHostnames).toContain(
      "not(equals(if(equals(lambdaVariables('h').key, 'assistant'), parameters('assistantHostnameStage'), parameters('customDomainsStage')), 'certificates'))",
    );
  });

  it('keeps the old hosted names open to their tenant in the API', () => {
    const env = module('containerapps').properties.parameters?.identityEnv?.value as Record<
      string,
      string
    >;
    expect(env.GENAI_HOSTED_HOSTNAMES).toContain("variables('allServedNames')");
    expect(main().variables.allServedNames).toContain("variables('previousServed')");
  });
});
