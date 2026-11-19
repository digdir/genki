import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { isHostname } from '../packages/identity/src/clients.js';

const root = join(import.meta.dirname, '..');

const hasAz = (() => {
  try {
    execFileSync('az', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
})();

interface Entry {
  hostname?: unknown;
  subdomain?: unknown;
  tenant?: unknown;
  stage?: unknown;
  apex?: unknown;
}
interface Resource {
  type: string;
  name: string;
  copy?: { count: string };
  dependsOn?: string[];
  properties: Record<string, unknown> & {
    parameters?: Record<string, { value: unknown }>;
    template?: {
      resources: Resource[];
      variables?: Record<string, string>;
      outputs?: Record<string, { value: string }>;
    };
  };
}

const stages = ['none', 'hostnames', 'certificates'];

const reserved = ['genki.digdir.cloud', 'genki-test.digdir.cloud', 'azurecontainerapps.io'];

const label = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const nameOf = (e: Entry, zone: string) =>
  e.subdomain === undefined
    ? String(e.hostname).toLowerCase()
    : `${String(e.subdomain)}.apps.${zone}`;

const problems = (entries: Entry[], zone = 'genki-test.digdir.cloud'): string[] =>
  entries.flatMap((e, i) => {
    const host = nameOf(e, zone);
    const found: string[] = [];
    if ((e.hostname === undefined) === (e.subdomain === undefined))
      found.push(`${i}: hostname or subdomain`);
    if (e.subdomain !== undefined && !(typeof e.subdomain === 'string' && label.test(e.subdomain)))
      found.push(`${i}: subdomain`);
    if (!isHostname(host)) found.push(`${i}: hostname`);
    if (typeof e.tenant !== 'string' || !/^\d{9}$/.test(e.tenant)) found.push(`${i}: tenant`);
    if (e.subdomain === undefined && reserved.some((d) => host === d || host.endsWith(`.${d}`)))
      found.push(`${i}: reserved`);
    if (!stages.includes(String(e.stage))) found.push(`${i}: stage ${String(e.stage)}`);
    if (e.apex !== undefined && (typeof e.apex !== 'boolean' || e.subdomain !== undefined))
      found.push(`${i}: apex`);
    if (entries.findIndex((o) => nameOf(o, zone) === host) !== i) found.push(`${i}: twice`);
    return found;
  });

const paramValues = (file: string) => {
  const out = execFileSync(
    'az',
    ['bicep', 'build-params', '--file', join(root, `infra/env/${file}.bicepparam`), '--stdout'],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: {
        ...process.env,
        PG_ADMIN_GROUP_OBJECT_ID: '00000000-0000-0000-0000-000000000000',
        PG_ADMIN_GROUP_NAME: 'x',
      },
    },
  );
  const built = JSON.parse(out.slice(out.indexOf('{'))) as { parametersJson: string };
  return (JSON.parse(built.parametersJson) as { parameters: Record<string, { value: unknown }> })
    .parameters;
};

describe('a hosted hostname entry', () => {
  it('is refused with a stage the template does not know, a bad tenant, a reserved name or twice', () => {
    const kunnskap = { hostname: 'qa.kunnskap.digdir.cloud', tenant: '991825827' };
    expect(problems([{ ...kunnskap, stage: 'hostnames' }])).toEqual([]);
    expect(problems([{ ...kunnskap, stage: 'certificate' }])).toEqual(['0: stage certificate']);
    expect(problems([{ ...kunnskap, tenant: '99182582', stage: 'none' }])).toHaveLength(1);
    expect(
      problems([{ hostname: 'ka.genki-test.digdir.cloud', tenant: '991825827', stage: 'none' }]),
    ).toEqual(['0: reserved']);
    expect(
      problems([
        { ...kunnskap, stage: 'none' },
        { ...kunnskap, hostname: 'QA.kunnskap.digdir.cloud', stage: 'hostnames' },
      ]),
    ).toEqual(['1: twice']);
  });

  it('takes a subdomain only as one lowercase DNS label, which becomes <label>.apps.<genki zone>', () => {
    const entry = (subdomain: unknown) => ({ subdomain, tenant: '991825827', stage: 'none' });
    expect(problems([entry('kunnskap'), entry('klar-sprak2')])).toEqual([]);
    for (const bad of ['Kunnskap', 'a.b', '-ka', 'ka-', 'k_a', '', 'x'.repeat(64)])
      expect(problems([entry(bad)]), bad).toContain('0: subdomain');
    expect(problems([{ ...entry('kunnskap'), hostname: 'qa.kunnskap.digdir.cloud' }])).toContain(
      '0: hostname or subdomain',
    );
    expect(
      problems([
        entry('kunnskap'),
        { hostname: 'kunnskap.apps.genki-test.digdir.cloud', tenant: '991825827', stage: 'none' },
      ]),
    ).toEqual(['1: reserved', '1: twice']);
  });
});

describe.skipIf(!hasAz && !process.env.CI)('hosted hostnames in the template', () => {
  let built: { resources: Resource[]; variables?: Record<string, string> } | undefined;
  beforeAll(() => {
    built = JSON.parse(
      execFileSync('az', ['bicep', 'build', '--file', join(root, 'infra/main.bicep'), '--stdout'], {
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      }),
    ) as { resources: Resource[]; variables?: Record<string, string> };
  }, 120_000);
  const module = (name: string) => {
    const found = built?.resources.find((r) => r.name === name);
    if (!found?.properties.template) throw new Error(`no module ${name}`);
    return found;
  };
  const host = () => module('assistant-host').properties.template?.resources ?? [];

  it.each(['test', 'prod'])(
    'every hosted hostname in %s is one the API opens to its tenant',
    (file) => {
      const values = paramValues(file);
      const entries = values.hostedHostnames?.value;
      expect(Array.isArray(entries)).toBe(true);
      expect(problems(entries as Entry[], String(values.dnsZoneName?.value))).toEqual([]);
    },
    120_000,
  );

  it('turns a subdomain into <subdomain>.apps.<genki zone>, and keeps a full hostname as it is', () => {
    expect(built?.variables?.hostedNames).toBe(
      "[map(parameters('hostedHostnames'), lambda('h', union(lambdaVariables('h'), createObject('hostname', toLower(if(empty(coalesce(tryGet(lambdaVariables('h'), 'subdomain'), '')), lambdaVariables('h').hostname, format('{0}.apps.{1}', lambdaVariables('h').subdomain, parameters('dnsZoneName'))))))))]",
    );
  });

  it('writes the CNAME and asuid TXT of a name genki assigns in genki’s own zone, pointing at the assistant host', () => {
    const dns = module('dns');
    const params = dns.properties.parameters ?? {};
    expect(String(params.hostedLabels)).toContain(
      "map(variables('assignedNames'), lambda('h', format('{0}.apps', toLower(lambdaVariables('h').subdomain))))",
    );
    expect(String(params.hostedTarget)).toContain("'assistant-host'");
    expect(String(params.hostedTarget)).toContain('.outputs.fqdn.value');
    expect(String(params.hostedVerificationId)).toContain('.outputs.verificationId.value');
    const records = (dns.properties.template?.resources ?? []).filter((r) =>
      r.name.includes("parameters('hostedLabels')"),
    );
    expect(records.map((r) => r.type)).toEqual([
      'Microsoft.Network/dnsZones/CNAME',
      'Microsoft.Network/dnsZones/TXT',
    ]);
    expect(records[1]?.name).toContain(
      "format('asuid.{0}', parameters('hostedLabels')[copyIndex()])",
    );
  });

  it.each(['test', 'prod'])(
    'keeps the apps. level of %s’s zone for assigned names alone',
    (file) => {
      const values = paramValues(file);
      const zone = String(values.dnsZoneName?.value);
      const apps = Object.values(values.hostnames?.value as Record<string, string>);
      expect(apps.filter((h) => h.endsWith(`.apps.${zone}`) || h === `apps.${zone}`)).toEqual([]);
    },
    120_000,
  );

  it('gives the API the param file’s hostnames as host=tenant', () => {
    const env = module('containerapps').properties.parameters?.identityEnv?.value as Record<
      string,
      string
    >;
    expect(env.GENAI_HOSTED_HOSTNAMES).toBe(
      "[join(map(variables('servedNames'), lambda('h', format('{0}={1}', lambdaVariables('h').hostname, lambdaVariables('h').tenant))), ',')]",
    );
  });

  it('binds hosted hostnames to the assistant host only, and keeps the four app hostnames on their apps', () => {
    expect(module('assistant-host').properties.parameters?.hostedHostnames?.value).toBe(
      "[concat(variables('servedNames'), variables('loginNames'))]",
    );
    const apps = module('containerapps').properties.parameters ?? {};
    expect(apps).not.toHaveProperty('hostedHostnames');
    expect(apps.hostnames?.value).toBe("[parameters('hostnames')]");
    expect(apps.customDomainsStage?.value).toBe("[parameters('customDomainsStage')]");
    const app = host().find((r) => r.type === 'Microsoft.App/containerApps');
    expect(JSON.stringify(app?.properties)).toContain('"customDomains":"[map(variables(\'bound\')');
    expect(app?.dependsOn).toEqual(['certificates']);
  });

  it('serves the platform login host on the assistant host at its own stage, and opens it to no tenant', () => {
    expect(built?.variables?.platformLoginHostname).toBe(
      "[if(variables('platformLoginOn'), format('login.apps.{0}', parameters('dnsZoneName')), '')]",
    );
    expect(built?.variables?.loginNames).toContain("'stage', parameters('platformLoginStage')");
    expect(built?.variables?.servedNames).not.toContain('loginNames');
    const apps = module('containerapps').properties.parameters ?? {};
    expect(apps.platformLoginSecret?.value).toBe("[variables('platformLoginOn')]");
    const env = apps.identityEnv?.value as Record<string, string>;
    expect(env.PLATFORM_LOGIN_HOSTNAME).toBe("[variables('platformLoginHostname')]");
    expect(String(module('dns').properties.parameters?.hostedLabels)).toContain(
      "createArray('login.apps')",
    );
  });

  it('turns the platform login on in test with its client id, starting at stage none', () => {
    const values = paramValues('test');
    expect(values.platformLoginClientId?.value).toBe('dde98722-c952-4172-a5d6-10bdf721680f');
    expect(values.platformLoginStage?.value).toBe('none');
    expect(values.platformLoginClientId?.value).not.toBe(values.portalClientId?.value);
  }, 120_000);

  it('makes a certificate only at the certificates stage, in the host’s environment, over HTTP for an apex', () => {
    const variables = module('assistant-host').properties.template?.variables ?? {};
    expect(variables.bound).toContain("not(equals(lambdaVariables('h').stage, 'none'))");
    expect(variables.certified).toBe(
      "[filter(variables('bound'), lambda('h', equals(lambdaVariables('h').stage, 'certificates')))]",
    );
    const certificate = host().find(
      (r) => r.type === 'Microsoft.App/managedEnvironments/managedCertificates',
    );
    expect(certificate?.copy?.count).toBe("[length(variables('certified'))]");
    expect(certificate?.name).toContain("format('{0}-hosted-env', parameters('name'))");
    expect(certificate?.properties.domainControlValidation).toBe(
      "[if(coalesce(tryGet(variables('certified')[copyIndex()], 'apex'), false()), 'HTTP', 'CNAME')]",
    );
  });

  it('tells which DNS records each hostname needs: CNAME or apex A, and asuid TXT', () => {
    const records = module('assistant-host').properties.template?.outputs?.dnsRecords?.value ?? '';
    expect(records).toContain("'A', 'name', toLower(lambdaVariables('h').hostname)");
    expect(records).toContain('.staticIp');
    expect(records).toContain("'CNAME', 'name', toLower(lambdaVariables('h').hostname)");
    expect(records).toContain("format('asuid.{0}', toLower(lambdaVariables('h').hostname))");
    expect(records).toContain('customDomainVerificationId');
  });
});
