import { describe, expect, it } from 'vitest';
import {
  armResource,
  certificateName,
  managedIdentityToken,
  runBinder,
  type BinderConfig,
  type StepResult,
  type WorkItem,
} from './hostname-binder.ts';

const config: BinderConfig = {
  apiUrl: 'https://api.example.test',
  subscriptionId: 'sub',
  resourceGroup: 'rg',
  appName: 'genai-test-assistant',
  environmentName: 'genai-test-hosted-env',
  dnsZone: 'genki-test.digdir.cloud',
  reserved: ['kunnskap.apps.genki-test.digdir.cloud', 'login.apps.genki-test.digdir.cloud'],
};

const providers = '/subscriptions/sub/resourceGroups/rg/providers';
const appPath = `${providers}/Microsoft.App/containerApps/genai-test-assistant`;
const certPath = (hostname: string) =>
  `${providers}/Microsoft.App/managedEnvironments/genai-test-hosted-env/managedCertificates/${certificateName(hostname)}`;
const environmentPath = `${providers}/Microsoft.App/managedEnvironments/genai-test-hosted-env`;
const zonePath = `${providers}/Microsoft.Network/dnsZones/apps.genki-test.digdir.cloud`;

const hostApp = () => ({
  id: appPath,
  location: 'westeurope',
  identity: { type: 'UserAssigned', userAssignedIdentities: { '/identities/assistant-id': {} } },
  properties: {
    provisioningState: 'Succeeded',
    configuration: {
      activeRevisionsMode: 'Single',
      secrets: [{ name: 'genai-proxy-key', keyVaultUrl: 'https://kv/secrets/genai-proxy-key' }],
      ingress: {
        fqdn: 'genai-test-assistant.example.azurecontainerapps.io',
        external: true,
        allowInsecure: false,
        customDomains: [
          {
            name: 'kunnskap.apps.genki-test.digdir.cloud',
            bindingType: 'SniEnabled',
            certificateId: '/c/k',
          },
        ],
      },
    },
    template: { containers: [{ name: 'assistant', image: 'acr.io/genai-apps@sha256:abc' }] },
  },
});

interface Call {
  method: string;
  path: string;
  body?: unknown;
}

const mergePatch = (target: unknown, patch: unknown): unknown => {
  if (typeof patch !== 'object' || patch === null || Array.isArray(patch)) return patch;
  const merged: Record<string, unknown> =
    typeof target === 'object' && target !== null && !Array.isArray(target)
      ? structuredClone(target as Record<string, unknown>)
      : {};
  for (const [key, value] of Object.entries(patch)) merged[key] = mergePatch(merged[key], value);
  return merged;
};

const world = (
  items: WorkItem[],
  options: {
    failFirst?: number;
    failStatus?: number;
    retryAfter?: string;
    certificateState?: string;
    settlesAs?: string;
    clock?: () => number;
    afterAppRead?: (app: ReturnType<typeof hostApp>) => void;
  } = {},
) => {
  const resources = new Map<string, unknown>([
    [appPath, hostApp()],
    [
      environmentPath,
      { properties: { customDomainConfiguration: { customDomainVerificationId: 'VERIFY' } } },
    ],
  ]);
  const calls: Call[] = [];
  const results: { id: string; result: StepResult }[] = [];
  const tokens: string[] = [];
  const sleeps: number[] = [];
  let failures = options.failFirst ?? 0;
  const fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const auth = (init.headers as Record<string, string>).authorization ?? '';
    const body = init.body === undefined ? undefined : (JSON.parse(String(init.body)) as unknown);
    if (url.host === 'api.example.test') {
      tokens.push(`api:${auth}`);
      if (url.pathname === '/internal/hostnames/work') return Response.json({ items });
      const id = /^\/internal\/hostnames\/([^/]+)\/result$/.exec(url.pathname)?.[1];
      if (id && method === 'POST') {
        results.push({ id: decodeURIComponent(id), result: body as StepResult });
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    }
    tokens.push(`arm:${auth}`);
    const path = url.pathname;
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    if (failures > 0) {
      failures--;
      return new Response('busy', {
        status: options.failStatus ?? 429,
        headers: { 'retry-after': options.retryAfter ?? '1' },
      });
    }
    if (method === 'GET') {
      const found = resources.get(path) as
        { properties?: { provisioningState?: string } } | undefined;
      if (!found) return new Response(null, { status: 404 });
      const copy = structuredClone(found);
      if (path === appPath && options.afterAppRead) {
        options.afterAppRead(found as ReturnType<typeof hostApp>);
        delete options.afterAppRead;
      }
      if (path === appPath && found.properties?.provisioningState === 'InProgress')
        found.properties.provisioningState = options.settlesAs ?? 'Succeeded';
      return Response.json(copy);
    }
    if (method === 'PATCH') {
      const stored = mergePatch(resources.get(path), body) as {
        properties: Record<string, unknown>;
      };
      stored.properties.provisioningState = 'InProgress';
      resources.set(path, stored);
      return new Response(null, { status: 202 });
    }
    if (method === 'PUT') {
      const stored = structuredClone(body) as { properties: Record<string, unknown> };
      if (path === appPath) stored.properties.provisioningState = 'InProgress';
      if (path.includes('/managedCertificates/'))
        stored.properties.provisioningState = options.certificateState ?? 'Pending';
      resources.set(path, stored);
      return Response.json(stored, { status: 201 });
    }
    const existed = resources.delete(path);
    return new Response(null, { status: existed ? 200 : 204 });
  }) as unknown as typeof globalThis.fetch;
  const run = () =>
    runBinder({
      config,
      apiToken: async () => 'api-token',
      armToken: async () => 'arm-token',
      fetch,
      log: () => undefined,
      sleep: async (ms: number) => {
        sleeps.push(ms);
      },
      now: options.clock ?? (() => 0),
    });
  const app = () =>
    resources.get(appPath) as ReturnType<typeof hostApp> & {
      properties: { configuration: { ingress: { customDomains: Record<string, unknown>[] } } };
    };
  return { resources, calls, results, tokens, sleeps, run, app };
};

const bind = (step: WorkItem['step'], extra: Partial<WorkItem> = {}): WorkItem => ({
  id: 'claim-1',
  hostname: 'qa.kunnskap.example.no',
  apex: false,
  action: 'bind',
  step,
  ...extra,
});

describe('the hostname binder', () => {
  it('adds a hostname disabled and changes nothing on the host app but its custom domains', async () => {
    const w = world([bind('add')]);
    const before = hostApp();
    await w.run();
    const patch = w.calls.find((c) => c.method === 'PATCH' && c.path === appPath);
    const domains = [
      ...before.properties.configuration.ingress.customDomains,
      { name: 'qa.kunnskap.example.no', bindingType: 'Disabled' },
    ];
    expect(patch?.body).toEqual({
      properties: { configuration: { ingress: { customDomains: domains } } },
    });
    expect(w.app().properties.template).toEqual(before.properties.template);
    expect(w.results).toEqual([{ id: 'claim-1', result: { step: 'add', ok: true } }]);
  });

  it('does not roll back a deploy that lands between its read and its write', async () => {
    const w = world([bind('add')], {
      afterAppRead: (app) => {
        app.properties.template.containers = [
          { name: 'assistant', image: 'registry.example/genai-apps@sha256:new' },
        ];
      },
    });
    await w.run();
    expect(w.app().properties.template.containers[0]?.image).toBe(
      'registry.example/genai-apps@sha256:new',
    );
    expect(w.app().properties.configuration.ingress.customDomains).toContainEqual({
      name: 'qa.kunnskap.example.no',
      bindingType: 'Disabled',
    });
  });

  it('writes nothing when a step is already done, and reports it done again', async () => {
    const w = world([bind('add')]);
    await w.run();
    const writes = w.calls.filter((c) => ['PUT', 'PATCH'].includes(c.method)).length;
    await w.run();
    expect(w.calls.filter((c) => ['PUT', 'PATCH'].includes(c.method))).toHaveLength(writes);
    expect(w.results.map((r) => r.result)).toEqual([
      { step: 'add', ok: true },
      { step: 'add', ok: true },
    ]);
  });

  it('asks for a managed certificate with CNAME validation and reports it only once issued', async () => {
    const w = world([bind('certificate')]);
    await w.run();
    const cert = w.calls.find(
      (c) => c.method === 'PUT' && c.path.includes('/managedCertificates/'),
    );
    expect(cert?.body).toEqual({
      location: 'westeurope',
      properties: { subjectName: 'qa.kunnskap.example.no', domainControlValidation: 'CNAME' },
    });
    expect(w.results).toEqual([]);
    (
      w.resources.get(certPath('qa.kunnskap.example.no')) as { properties: Record<string, unknown> }
    ).properties.provisioningState = 'Succeeded';
    await w.run();
    expect(w.results).toEqual([
      {
        id: 'claim-1',
        result: {
          step: 'certificate',
          ok: true,
          certificateId: certPath('qa.kunnskap.example.no'),
        },
      },
    ]);
  });

  it('validates an apex name’s certificate over HTTP', async () => {
    const w = world([bind('certificate', { hostname: 'kunnskap.example.no', apex: true })]);
    await w.run();
    const cert = w.calls.find(
      (c) => c.method === 'PUT' && c.path.includes('/managedCertificates/'),
    );
    expect(cert?.body).toMatchObject({ properties: { domainControlValidation: 'HTTP' } });
  });

  it('deletes a failed certificate and reports the failure, so the next run asks again', async () => {
    const w = world([bind('certificate')], { certificateState: 'Failed' });
    await w.run();
    await w.run();
    await w.run();
    expect(
      w.calls.filter((c) => c.method === 'PUT' && c.path.includes('/managedCertificates/')),
    ).toHaveLength(2);
    expect(w.results.at(-1)?.result).toEqual({
      step: 'certificate',
      ok: false,
      message: 'the certificate ended Failed',
    });
    expect(
      w.calls.some((c) => c.method === 'DELETE' && c.path.includes('/managedCertificates/')),
    ).toBe(true);
  });

  it('switches the binding to SNI with its certificate only once the certificate is issued', async () => {
    const w = world([bind('enable')]);
    await w.run();
    expect(w.results.at(-1)?.result).toEqual({
      step: 'enable',
      ok: false,
      message: 'the certificate is not issued',
    });
    w.resources.set(certPath('qa.kunnskap.example.no'), {
      properties: { provisioningState: 'Succeeded', subjectName: 'qa.kunnskap.example.no' },
    });
    await w.run();
    expect(w.app().properties.configuration.ingress.customDomains).toContainEqual({
      name: 'qa.kunnskap.example.no',
      bindingType: 'SniEnabled',
      certificateId: certPath('qa.kunnskap.example.no'),
    });
    expect(w.results.at(-1)?.result).toMatchObject({ step: 'enable', ok: true });
  });

  it('retries Azure when it answers 429 and goes on', async () => {
    const w = world([bind('add')], { failFirst: 2 });
    await w.run();
    expect(w.sleeps.slice(0, 2)).toEqual([1000, 1000]);
    expect(w.results).toEqual([{ id: 'claim-1', result: { step: 'add', ok: true } }]);
  });

  it('retries Azure on a 5xx and waits as long as retry-after says, at most 10 seconds', async () => {
    const w = world([bind('add')], { failFirst: 1, failStatus: 503, retryAfter: '60' });
    await w.run();
    expect(w.sleeps[0]).toBe(10_000);
    expect(w.results).toEqual([{ id: 'claim-1', result: { step: 'add', ok: true } }]);
  });

  it('reports only Azure’s status and code to the API, and keeps the resource path in the log', async () => {
    const w = world([bind('add')], { failFirst: 3, failStatus: 500 });
    await w.run();
    expect(w.results[0]?.result).toEqual({
      step: 'add',
      ok: false,
      message: 'Azure answered 500',
    });
  });

  it('writes nothing when the hostname is already bound to its certificate', async () => {
    const w = world([bind('enable')]);
    w.resources.set(certPath('qa.kunnskap.example.no'), {
      properties: { provisioningState: 'Succeeded', subjectName: 'qa.kunnskap.example.no' },
    });
    await w.run();
    const writes = w.calls.filter((c) => ['PUT', 'PATCH'].includes(c.method)).length;
    await w.run();
    expect(w.calls.filter((c) => ['PUT', 'PATCH'].includes(c.method))).toHaveLength(writes);
    expect(w.results.map((r) => r.result.ok)).toEqual([true, true]);
  });

  it('enable replaces the disabled entry with the SNI binding', async () => {
    const w = world([bind('enable')]);
    w.app().properties.configuration.ingress.customDomains.push({
      name: 'qa.kunnskap.example.no',
      bindingType: 'Disabled',
    });
    w.resources.set(certPath('qa.kunnskap.example.no'), {
      properties: { provisioningState: 'Succeeded', subjectName: 'qa.kunnskap.example.no' },
    });
    await w.run();
    expect(w.app().properties.configuration.ingress.customDomains).toEqual([
      ...hostApp().properties.configuration.ingress.customDomains,
      {
        name: 'qa.kunnskap.example.no',
        bindingType: 'SniEnabled',
        certificateId: certPath('qa.kunnskap.example.no'),
      },
    ]);
  });

  it('asks for a certificate once while it is pending', async () => {
    const w = world([bind('certificate')]);
    await w.run();
    await w.run();
    expect(
      w.calls.filter((c) => c.method === 'PUT' && c.path.includes('/managedCertificates/')),
    ).toHaveLength(1);
    expect(w.results).toEqual([]);
  });

  it('refuses a certificate that already exists for another name', async () => {
    const w = world([bind('certificate')]);
    w.resources.set(certPath('qa.kunnskap.example.no'), {
      properties: { provisioningState: 'Succeeded', subjectName: 'other.example.no' },
    });
    await w.run();
    expect(w.results[0]?.result).toMatchObject({ step: 'certificate', ok: false });
    expect(
      w.calls.filter((c) => c.method !== 'GET' && c.path.includes('/managedCertificates/')),
    ).toEqual([]);
  });

  it('reports a failure when the host app ends Failed after the write', async () => {
    const w = world([bind('add')], { settlesAs: 'Failed' });
    await w.run();
    expect(w.results[0]?.result).toEqual({
      step: 'add',
      ok: false,
      message: 'the host app did not provision the change',
    });
  });

  it('reports nothing for a done item and refuses unbind on a bind item', async () => {
    const w = world([bind('done'), bind('unbind', { id: 'claim-2' })]);
    await w.run();
    expect(w.results).toEqual([
      {
        id: 'claim-2',
        result: { step: 'unbind', ok: false, message: 'unbind is a step of remove' },
      },
    ]);
    expect(w.calls.filter((c) => c.method !== 'GET')).toEqual([]);
  });

  it('skips the remaining items once the time budget is spent and reports nothing for them', async () => {
    const w = world([bind('add'), bind('add', { id: 'claim-2', hostname: 'b.example.no' })], {
      clock: () => (w.results.length > 0 ? 60_000 : 0),
    });
    const summary = await w.run();
    expect(summary.skipped).toBe(1);
    expect(w.results.map((r) => r.id)).toEqual(['claim-1']);
  });

  it('fails the run when a result cannot be reported', async () => {
    const w = world([bind('add', { id: 'unknown/id' })]);
    w.results.length = 0;
    const summary = await runBinder({
      config,
      apiToken: async () => 'api-token',
      armToken: async () => 'arm-token',
      fetch: (async (input: string | URL) =>
        String(input).includes('/internal/hostnames/work')
          ? Response.json({ items: [bind('done'), bind('unbind')] })
          : new Response(null, { status: 503 })) as unknown as typeof fetch,
      log: () => undefined,
      sleep: async () => undefined,
      now: () => 0,
    });
    expect(summary.failed).toBe(1);
  });

  it('reports a failure when Azure keeps refusing, without stopping the other items', async () => {
    const w = world([bind('add'), bind('add', { id: 'claim-2', hostname: 'b.example.no' })], {
      failFirst: 3,
    });
    await w.run();
    expect(w.results[0]?.result).toMatchObject({ step: 'add', ok: false });
    expect(w.results[1]).toEqual({ id: 'claim-2', result: { step: 'add', ok: true } });
  });

  it('waits without reporting while the host app is still provisioning another change', async () => {
    const w = world([bind('add')]);
    (w.app().properties as { provisioningState: string }).provisioningState = 'InProgress';
    await w.run();
    expect(w.results).toEqual([]);
    expect(w.calls.filter((c) => ['PUT', 'PATCH'].includes(c.method))).toEqual([]);
  });

  it('removing waits while the host app is provisioning and deletes no certificate', async () => {
    const w = world([{ ...bind('unbind'), action: 'remove' }]);
    (w.app().properties as { provisioningState: string }).provisioningState = 'InProgress';
    await w.run();
    expect(w.calls.filter((c) => c.method !== 'GET')).toEqual([]);
    expect(w.results).toEqual([]);
  });

  it('removes a hostname: unbinds it, deletes its certificate and touches no other domain', async () => {
    const w = world([{ ...bind('unbind'), action: 'remove' }]);
    w.app().properties.configuration.ingress.customDomains.push({
      name: 'qa.kunnskap.example.no',
      bindingType: 'SniEnabled',
      certificateId: certPath('qa.kunnskap.example.no'),
    });
    w.resources.set(certPath('qa.kunnskap.example.no'), { properties: {} });
    await w.run();
    expect(w.app().properties.configuration.ingress.customDomains).toEqual(
      hostApp().properties.configuration.ingress.customDomains,
    );
    expect(w.resources.has(certPath('qa.kunnskap.example.no'))).toBe(false);
    const unbound = w.calls.findIndex((c) => c.method === 'PATCH' && c.path === appPath);
    const deleted = w.calls.findIndex((c) => c.method === 'DELETE');
    expect(unbound).toBeGreaterThanOrEqual(0);
    expect(deleted).toBeGreaterThan(unbound);
    expect(w.results).toEqual([{ id: 'claim-1', result: { step: 'unbind', ok: true } }]);
    expect(w.calls.some((c) => c.path.includes('dnsZones'))).toBe(false);
  });

  it('removing a hostname that is already gone succeeds without a write', async () => {
    const w = world([{ ...bind('unbind'), action: 'remove' }]);
    await w.run();
    expect(w.calls.filter((c) => ['PUT', 'PATCH'].includes(c.method))).toEqual([]);
    expect(w.results).toEqual([{ id: 'claim-1', result: { step: 'unbind', ok: true } }]);
  });

  it('writes the CNAME and asuid records in genki’s apps zone for a platform-assigned name', async () => {
    const w = world([
      bind('add', {
        hostname: 'skatt.apps.genki-test.digdir.cloud',
        zone: 'genki-test.digdir.cloud',
        recordName: 'skatt.apps',
      }),
    ]);
    await w.run();
    const dns = w.calls.filter((c) => c.method === 'PUT' && c.path.includes('dnsZones'));
    expect(w.calls.filter((c) => c.method !== 'GET' && !c.path.includes('dnsZones'))).toEqual([
      expect.objectContaining({ method: 'PATCH', path: appPath }),
    ]);
    expect(dns).toEqual([
      {
        method: 'PUT',
        path: `${zonePath}/CNAME/skatt`,
        body: {
          properties: {
            TTL: 300,
            CNAMERecord: { cname: 'genai-test-assistant.example.azurecontainerapps.io' },
          },
        },
      },
      {
        method: 'PUT',
        path: `${zonePath}/TXT/asuid.skatt`,
        body: { properties: { TTL: 300, TXTRecords: [{ value: ['VERIFY'] }] } },
      },
    ]);
    expect(w.results[0]?.result).toEqual({ step: 'add', ok: true });
  });

  it('does not write a platform-assigned name’s records again once they are right', async () => {
    const w = world([
      bind('certificate', {
        hostname: 'skatt.apps.genki-test.digdir.cloud',
        zone: 'genki-test.digdir.cloud',
        recordName: 'skatt.apps',
      }),
    ]);
    await w.run();
    const records = () =>
      w.calls.filter((c) => c.method === 'PUT' && c.path.includes('dnsZones')).length;
    expect(records()).toBe(2);
    await w.run();
    expect(records()).toBe(2);
  });

  it('removes a platform-assigned name’s records when it is removed', async () => {
    const w = world([
      {
        ...bind('unbind', {
          hostname: 'skatt.apps.genki-test.digdir.cloud',
          zone: 'genki-test.digdir.cloud',
          recordName: 'skatt.apps',
        }),
        action: 'remove',
      },
    ]);
    await w.run();
    expect(w.calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([
      certPath('skatt.apps.genki-test.digdir.cloud'),
      `${zonePath}/CNAME/skatt`,
      `${zonePath}/TXT/asuid.skatt`,
    ]);
  });

  it('writes no DNS record for a custom domain', async () => {
    const w = world([bind('add')]);
    await w.run();
    expect(w.calls.some((c) => c.path.includes('dnsZones'))).toBe(false);
  });

  it.each([
    [
      'another zone',
      { zone: 'example.no', recordName: 'skatt.apps', hostname: 'skatt.apps.example.no' },
    ],
    [
      'two labels under apps',
      {
        zone: 'genki-test.digdir.cloud',
        recordName: 'a.b.apps',
        hostname: 'a.b.apps.genki-test.digdir.cloud',
      },
    ],
    [
      'a record name that does not match the hostname',
      {
        zone: 'genki-test.digdir.cloud',
        recordName: 'skatt.apps',
        hostname: 'api.genki-test.digdir.cloud',
      },
    ],
    ['a name in genki’s zone without its record', { hostname: 'api.genki-test.digdir.cloud' }],
    ['a name the template binds', { hostname: 'login.apps.genki-test.digdir.cloud' }],
    [
      'a template name handed out as a platform name',
      {
        hostname: 'login.apps.genki-test.digdir.cloud',
        zone: 'genki-test.digdir.cloud',
        recordName: 'login.apps',
      },
    ],
    [
      'a platform name marked apex',
      {
        hostname: 'skatt.apps.genki-test.digdir.cloud',
        zone: 'genki-test.digdir.cloud',
        recordName: 'skatt.apps',
        apex: true,
      },
    ],
    ['a wildcard', { hostname: '*.example.no' }],
  ])('refuses %s and writes nothing to Azure', async (_, extra) => {
    const w = world([bind('add', extra)]);
    await w.run();
    expect(w.calls).toEqual([]);
    expect(w.results[0]?.result).toMatchObject({ step: 'add', ok: false });
  });

  it('skips a malformed work item and reports nothing for it', async () => {
    const w = world([{ id: 'x', hostname: 'a.example.no', action: 'bind' } as unknown as WorkItem]);
    const summary = await w.run();
    expect(summary.failed).toBe(1);
    expect(w.calls).toEqual([]);
    expect(w.results).toEqual([]);
  });

  it('sends the API token only to the API and the Azure token only to Azure', async () => {
    const w = world([bind('add')]);
    await w.run();
    expect(new Set(w.tokens)).toEqual(new Set(['api:Bearer api-token', 'arm:Bearer arm-token']));
  });
});

describe('the managed identity token', () => {
  it('asks the identity endpoint for the resource with the binder’s client id, once a run', async () => {
    const asked: string[] = [];
    const tokens = managedIdentityToken(
      {
        IDENTITY_ENDPOINT: 'http://localhost:42356/msi/token',
        IDENTITY_HEADER: 'header',
        AZURE_CLIENT_ID: 'binder-client',
      },
      (async (url: URL, init: RequestInit) => {
        asked.push(
          `${url.toString()} ${(init.headers as Record<string, string>)['x-identity-header']}`,
        );
        return Response.json({ access_token: 'token' });
      }) as unknown as typeof fetch,
    );
    expect(await tokens(armResource)).toBe('token');
    await tokens(armResource);
    expect(asked).toEqual([
      'http://localhost:42356/msi/token?api-version=2019-08-01&resource=https%3A%2F%2Fmanagement.azure.com%2F&client_id=binder-client header',
    ]);
  });
});
