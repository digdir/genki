import { Hono } from 'hono';
import { createLocalJWKSet, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { createSigningKey, PLATFORM_RIGHTS, trustedEntraScope } from '@genai/identity';
import { envSecrets, InMemoryHostnameClaims, type HostnameClaim } from '@genai/kernel';
import { tenantAccess } from './access.js';
import { actorNames } from './actor-names.js';
import { createAdmin } from './admin.js';
import type { WorkloadTrust } from './binder-token.js';
import { createPlatform } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { defaultReservedLabels } from './hostname-claims.js';
import { defaultReservedDomains } from './hosts.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { bootPlatform, digdir, fakeModels, files, other, testService } from './testkit.js';

const zone = 'genki-test.digdir.cloud';
const binderId = '0f8fad5b-d9cb-469f-a165-70867728950e';
const entraTenant = '72f988bf-86f1-41af-91ab-2d7cd011db47';
const audience = 'api://genki-hostname-binder';
const start = Date.parse('2026-11-25T10:00:00Z');

const resource = 'urn:altinn:resource:digdir-genai-platform';
const people: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, resource, actions: ['use-services'] }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift', tenant: digdir },
  nina: {
    kind: 'operator',
    issuer: 'test',
    subject: 'nina',
    tenant: digdir,
    scopes: [trustedEntraScope],
    authorizedFor: [{ org: digdir, resource, actions: [...PLATFORM_RIGHTS] }],
  },
  'nina-other': {
    kind: 'operator',
    issuer: 'test',
    subject: 'nina',
    tenant: other,
    scopes: [trustedEntraScope],
    authorizedFor: [{ org: other, resource, actions: ['manage-services', 'use-services'] }],
  },
  gjest: {
    kind: 'employee',
    issuer: 'test',
    subject: 'gjest',
    tenant: digdir,
    confinedTo: { tenant: digdir, service: 'klarsprak', client: 'klarsprak-host' },
  },
};

const layout = {
  version: 1,
  zones: { primary: [{ block: 'threads' }], main: [{ block: 'chat' }], secondary: [] },
  profile: { assistantName: 'Klarspråkassistenten' },
};

const service = (id: string, tenant = digdir, withInterface = true) => {
  const d = testService(id, tenant);
  return {
    ...d,
    spec: { ...d.spec, ...(withInterface ? { interface: { layout } } : {}) },
  };
};

const hostedClient = (svc: string, hostnames: { hostname: string }[] = []) => ({
  metadata: { name: 'Vert' },
  spec: {
    service: svc,
    kind: 'browser',
    channels: ['openai'],
    allowedOrigins: [],
    hosted: true,
    hostnames,
  },
});

const boot = async (
  options: {
    lockdown?: boolean;
    zone?: string | null;
    isOperator?: (principal: Principal) => boolean;
  } = {},
) => {
  let clock = start;
  const key = await createSigningKey();
  const binder: WorkloadTrust = {
    principalId: binderId,
    tenantId: entraTenant,
    audience,
    keys: createLocalJWKSet({ keys: [key.publicJwk] }),
    now: () => new Date(clock),
  };
  const token = (
    claims: Record<string, unknown> = {},
    aud = audience,
    issuer = `https://sts.windows.net/${entraTenant}/`,
  ) =>
    new SignJWT({ tid: entraTenant, oid: binderId, ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(issuer)
      .setAudience(aud)
      .setIssuedAt(Math.floor(clock / 1000))
      .setExpirationTime(Math.floor(clock / 1000) + 3600)
      .sign(key.privateKey);
  const claims = new InMemoryHostnameClaims();
  const configEntries = new InMemoryConfigEntryStore();
  const platform = await createPlatform({
    catalogs: {
      models: fakeModels,
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    policy: { decide: async () => ({ allow: true }) },
    configurables: { store: configEntries },
    apiKeys: new InMemoryTenantApiKeys(),
    now: () => clock,
    hosting: {
      hostnames: new Map([[`kunnskap.apps.${zone}`, digdir]]),
      reservedDomains: [...defaultReservedDomains, 'intern.example.no'],
    },
    hostnames: {
      claims,
      ...(options.zone === null ? {} : { zone: options.zone ?? zone }),
      target: {
        fqdn: 'genki-assistant.example.azurecontainerapps.io',
        verificationId: 'ABCDEF0123456789ABCDEF0123456789',
        staticIp: '20.1.2.3',
      },
      limit: 200,
      reservedLabels: [...defaultReservedLabels, 'kunnskap'],
    },
    binder,
    platformLogin: { clientId: 'genki-login', audience: 'digdir:genai' },
    ...(options.lockdown ? { lockdown: { configuredKeys: new Set<string>() } } : {}),
    ...(options.isOperator ? { isOperator: options.isOperator } : {}),
    authenticate: async (request) => {
      const person = people[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''];
      return person && { principal: person };
    },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
    names: actorNames(configEntries),
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (
    path: string,
    init: {
      method?: string;
      as?: string;
      body?: unknown;
      bearer?: string;
      origin?: string;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'change-reason': 'Ny adresse for tjenesten',
        ...(init.as ? { authorization: `Bearer ${init.as}` } : {}),
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
        ...(init.origin ? { origin: init.origin } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const publish = (definition: unknown, by = 'employee:test:kari') =>
    platform.definitions.publish(definition, by, 'Publiserer tjenesten', files);
  const saveClient = (id: string, body: unknown, as = 'kari', tenant = digdir) =>
    call(`/tenants/${tenant}/clients/${id}`, { method: 'PUT', as, body });
  const claim = (client: string, body: unknown, as = 'kari', tenant = digdir) =>
    call(`/tenants/${tenant}/clients/${client}/hostnames`, { method: 'POST', as, body });
  const work = async () =>
    (
      (await (await call('/internal/hostnames/work', { bearer: await token() })).json()) as {
        items: {
          id: string;
          hostname: string;
          action: string;
          step: string;
          zone?: string;
          recordName?: string;
        }[];
      }
    ).items;
  const report = async (id: string, body: unknown) =>
    call(`/internal/hostnames/${id}/result`, { method: 'POST', bearer: await token(), body });
  const bindAll = async (hostname: string) => {
    for (const step of ['add', 'certificate', 'enable']) {
      const item = (await work()).find((i) => i.hostname === hostname);
      if (!item) throw new Error(`no work for ${hostname}`);
      expect((await report(item.id, { step, ok: true })).status).toBe(200);
    }
  };
  const verify = async (hostname: string) => {
    const found = (await claims.list(digdir)).find(
      (c) => c.hostname === hostname && c.state === 'pending-dns',
    );
    if (!found) throw new Error(`no pending claim for ${hostname}`);
    return claims.update({ ...found, state: 'binding', version: found.version + 1 });
  };
  return {
    call,
    publish,
    saveClient,
    claim,
    work,
    report,
    bindAll,
    verify,
    token,
    claims,
    audit: () => admin.audit(digdir),
    admin,
    tick: (ms: number) => {
      clock += ms;
    },
  };
};

const errorsOf = async (res: Response) =>
  ((await res.json()) as { errors: { path: string; message: string }[] }).errors;

const kunnskapHosted = async (t: Awaited<ReturnType<typeof boot>>) => {
  expect((await t.publish(service('klarsprak', digdir, false))).ok).toBe(true);
  expect(
    (
      await t.saveClient(
        'klarsprak-host',
        hostedClient('klarsprak', [{ hostname: `kunnskap.apps.${zone}` }]),
      )
    ).status,
  ).toBe(200);
  expect((await t.publish(service('klarsprak'))).ok).toBe(true);
};

describe('a service owner claims a hostname', () => {
  it.each([
    [`ka.apps.${zone}`],
    ['genki.digdir.cloud'],
    ['app.azurecontainerapps.io'],
    ['noe.intern.example.no'],
    ['127.0.0.1'],
    ['*.example.no'],
    [`${'a'.repeat(60)}.${'b'.repeat(60)}.${'c'.repeat(60)}.${'d'.repeat(60)}.example.no`],
    [`kunnskap.apps.${zone}`],
  ])('refuses %s with hostname_not_allowed', async (hostname) => {
    const t = await boot();
    await kunnskapHosted(t);

    const res = await t.claim('klarsprak-host', { hostname, environment: 'prod' });

    expect(res.status).toBe(400);
    expect((await errorsOf(res))[0]?.message).toMatch(/^hostname_not_allowed/);
  });

  it('answers a token of its own and the three records to create', async () => {
    const t = await boot();
    await kunnskapHosted(t);

    const first = await t.claim('klarsprak-host', {
      hostname: 'KA.example.no',
      environment: 'prod',
    });
    const second = await t.claim('klarsprak-host', {
      hostname: 'qa.example.no',
      environment: 'prod',
    });

    expect(first.status).toBe(201);
    const view = (await first.json()) as {
      hostname: string;
      state: string;
      records: { type: string; name: string; value: string }[];
    };
    expect(view.hostname).toBe('ka.example.no');
    expect(view.state).toBe('pending-dns');
    expect(view.records.map((r) => [r.type, r.name])).toEqual([
      ['TXT', '_genki-challenge.ka.example.no'],
      ['TXT', 'asuid.ka.example.no'],
      ['CNAME', 'ka.example.no'],
    ]);
    expect(view.records[0]?.value).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const other = (await second.json()) as { records: { value: string }[] };
    expect(other.records[0]?.value).not.toBe(view.records[0]?.value);
  });

  it('gives an apex name an A record to the host’s static address', async () => {
    const t = await boot();
    await kunnskapHosted(t);

    const res = await t.claim('klarsprak-host', {
      hostname: 'kunnskap.example.no',
      environment: 'prod',
      apex: true,
    });

    const view = (await res.json()) as { records: { type: string; value: string }[] };
    expect(view.records.at(-1)).toEqual({
      type: 'A',
      name: 'kunnskap.example.no',
      value: '20.1.2.3',
    });
  });

  it('needs manage-services, and keeps every other organisation out', async () => {
    const t = await boot();
    await kunnskapHosted(t);

    expect(
      (await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' }, 'erik'))
        .status,
    ).toBe(403);
    expect(
      (await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' }, 'ola'))
        .status,
    ).toBe(404);
    expect(
      (
        await t.claim(
          'klarsprak-host',
          { hostname: 'ka.example.no', environment: 'prod' },
          'ola',
          other,
        )
      ).status,
    ).toBe(404);
    expect(
      (await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames`, { as: 'ola' })).status,
    ).toBe(404);
  });

  it('a claim on a name another tenant holds looks like any unverified claim', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    expect((await t.publish(service('ola-tjeneste', other))).ok).toBe(true);
    expect(
      (await t.saveClient('ola-host', hostedClient('ola-tjeneste'), 'ola', other)).status,
    ).toBe(200);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');

    const res = await t.claim(
      'ola-host',
      { hostname: 'ka.example.no', environment: 'prod' },
      'ola',
      other,
    );

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ hostname: 'ka.example.no', state: 'pending-dns' });
  });

  it('a hostname is not served before its binding is done, and is once it is', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });

    expect((await t.call('/v1/hosts/ka.example.no')).status).toBe(404);
    await t.verify('ka.example.no');
    expect((await t.call('/v1/hosts/ka.example.no')).status).toBe(404);
    await t.bindAll('ka.example.no');

    const res = await t.call('/v1/hosts/ka.example.no');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      hostname: 'ka.example.no',
      service: 'klarsprak',
      environment: 'prod',
    });
  });

  it('admits a signed-in page from a claimed hostname only while the claim is active', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    const from = (origin: string) => t.call('/v1/models', { as: 'gjest', origin });

    await t.verify('ka.example.no');
    const binding = (await from('https://ka.example.no')).status;
    await t.bindAll('ka.example.no');
    const active = (await from('https://ka.example.no')).status;
    const elsewhere = (await from('https://ka.example.no.evil.example')).status;
    await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames/ka.example.no`, {
      method: 'DELETE',
      as: 'kari',
    });
    const removed = (await from('https://ka.example.no')).status;

    expect([binding, active, elsewhere, removed]).toEqual([401, 200, 401, 401]);
  });

  it('a removed hostname stops being served at once and is unbound', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');

    const removed = await t.call(
      `/tenants/${digdir}/clients/klarsprak-host/hostnames/ka.example.no`,
      {
        method: 'DELETE',
        as: 'kari',
      },
    );

    expect(removed.status).toBe(200);
    expect((await t.call('/v1/hosts/ka.example.no')).status).toBe(404);
    const item = (await t.work()).find((i) => i.hostname === 'ka.example.no');
    expect(item).toMatchObject({ action: 'remove', step: 'unbind' });
    expect((await t.report(item?.id ?? '', { step: 'unbind', ok: true })).status).toBe(200);
    expect((await t.work()).some((i) => i.hostname === 'ka.example.no')).toBe(false);
    const listed = (await (
      await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames`, { as: 'kari' })
    ).json()) as { hostnames: { hostname: string }[] };
    expect(listed.hostnames.map((h) => h.hostname)).toEqual([`kunnskap.apps.${zone}`]);
  });

  it('a lapsed hostname is not served', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');
    const active = (await t.claims.list(digdir)).find(
      (c) => c.hostname === 'ka.example.no',
    ) as HostnameClaim;

    await t.claims.update({ ...active, state: 'lapsed', version: active.version + 1 });

    expect((await t.call('/v1/hosts/ka.example.no')).status).toBe(404);
  });

  it('an owner claims a lapsed hostname again without removing it first', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');
    const active = (await t.claims.list(digdir)).find(
      (c) => c.hostname === 'ka.example.no',
    ) as HostnameClaim;
    await t.claims.update({ ...active, state: 'lapsed', version: active.version + 1 });

    const again = await t.claim('klarsprak-host', {
      hostname: 'ka.example.no',
      environment: 'prod',
    });

    expect(again.status).toBe(201);
  });

  it('refuses a name under the zone genki assigns names in, whatever that zone is', async () => {
    const t = await boot({ zone: 'genki.example.org' });
    await kunnskapHosted(t);

    const res = await t.claim('klarsprak-host', {
      hostname: 'ka.apps.genki.example.org',
      environment: 'prod',
    });

    expect(res.status).toBe(400);
    expect((await errorsOf(res))[0]?.message).toMatch(/^hostname_not_allowed/);
  });

  it('a binding that keeps failing for 48 hours after add is unbound, then ends failed with the step', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    const id = (await t.work())[0]?.id ?? '';
    await t.report(id, { step: 'add', ok: true });

    await t.report(id, { step: 'certificate', ok: false, message: 'Azure answered 409 Conflict' });
    t.tick(48 * 3600_000);
    await t.report(id, { step: 'certificate', ok: false, message: 'Azure answered 409 Conflict' });
    const unbinding = await t.work();
    await t.report(id, { step: 'unbind', ok: true });

    expect(unbinding).toEqual([expect.objectContaining({ id, action: 'remove', step: 'unbind' })]);
    expect(await t.work()).toEqual([]);
    const listed = (await (
      await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames`, { as: 'kari' })
    ).json()) as { hostnames: Record<string, unknown>[] };
    const view = listed.hostnames.find((h) => h.hostname === 'ka.example.no');
    expect(view).toMatchObject({ state: 'failed', failure: 'bind_failed: certificate' });
    expect(view).not.toHaveProperty('message');
  });

  it('a binding that fails 48 hours at add ends failed with nothing to unbind', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    const id = (await t.work())[0]?.id ?? '';

    await t.report(id, { step: 'add', ok: false });
    t.tick(48 * 3600_000);
    await t.report(id, { step: 'add', ok: false });

    expect(await t.work()).toEqual([]);
    expect((await t.claims.find(id))?.failure).toBe('bind_failed: add');
  });

  it('the owner removing a lapsed hostname has it unbound, since it is still bound in Azure', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');
    const active = (await t.claims.list(digdir)).find(
      (c) => c.hostname === 'ka.example.no',
    ) as HostnameClaim;
    await t.claims.update({ ...active, state: 'lapsed', version: active.version + 1 });

    await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames/ka.example.no`, {
      method: 'DELETE',
      as: 'kari',
    });

    expect(await t.work()).toEqual([
      expect.objectContaining({ hostname: 'ka.example.no', action: 'remove', step: 'unbind' }),
    ]);
  });

  it('removing a lapsed hostname another claim holds by then leaves it to the holder', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');
    const active = (await t.claims.list(digdir)).find(
      (c) => c.hostname === 'ka.example.no',
    ) as HostnameClaim;
    await t.claims.update({ ...active, state: 'lapsed', version: active.version + 1 });
    await t.claims.create({ ...active, id: 'annen', tenant: other, state: 'active', version: 1 });

    const res = await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames/ka.example.no`, {
      method: 'DELETE',
      as: 'kari',
    });

    expect(res.status).toBe(200);
    expect((await t.claims.find(active.id))?.state).toBe('removed');
    expect(await t.work()).toEqual([]);
  });

  it('an unbind that keeps failing keeps the name held and in the work, never failed', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');
    await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames/ka.example.no`, {
      method: 'DELETE',
      as: 'kari',
    });
    const id = (await t.work())[0]?.id ?? '';

    await t.report(id, { step: 'unbind', ok: false, message: 'Conflict' });
    t.tick(72 * 3600_000);
    await t.report(id, { step: 'unbind', ok: false, message: 'Conflict' });

    expect(await t.work()).toEqual([expect.objectContaining({ id, action: 'remove' })]);
  });

  it('refuses a result for a step the claim is not at', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    const id = (await t.work())[0]?.id ?? '';

    expect((await t.report(id, { step: 'enable', ok: true })).status).toBe(409);
  });

  it('a redirect hostname answers where to go once both names are active, and starts no login', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.claim('klarsprak-host', { hostname: 'qa.example.no', redirectTo: 'ka.example.no' });
    await t.verify('qa.example.no');
    await t.bindAll('qa.example.no');
    expect((await t.call('/v1/hosts/qa.example.no')).status).toBe(404);
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');

    const res = await t.call('/v1/hosts/qa.example.no');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ hostname: 'qa.example.no', redirectTo: 'ka.example.no' });
    expect((await t.call('/v1/hosts/qa.example.no/pages/om')).status).toBe(404);
  });

  it('refuses a redirect to a hostname the client does not have', async () => {
    const t = await boot();
    await kunnskapHosted(t);

    const res = await t.claim('klarsprak-host', {
      hostname: 'qa.example.no',
      redirectTo: 'annen.example.no',
    });

    expect(res.status).toBe(400);
    expect((await errorsOf(res))[0]?.path).toBe('redirectTo');
  });

  it('holds at most five claims waiting for DNS per organisation', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    expect((await t.publish(service('nynorsk'))).ok).toBe(true);
    expect((await t.saveClient('nynorsk-host', hostedClient('nynorsk'))).status).toBe(200);
    for (const name of ['a', 'b', 'c'])
      expect(
        (await t.claim('klarsprak-host', { hostname: `${name}.example.no`, environment: 'prod' }))
          .status,
      ).toBe(201);
    for (const name of ['d', 'e'])
      expect(
        (await t.claim('nynorsk-host', { hostname: `${name}.example.no`, environment: 'prod' }))
          .status,
      ).toBe(201);

    const res = await t.claim('nynorsk-host', { hostname: 'f.example.no', environment: 'prod' });

    expect(res.status).toBe(400);
    expect((await errorsOf(res))[0]?.message).toMatch(/^hostname_limit/);
  });

  it('removing the Client removes its hostnames', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.claim('klarsprak-host', { hostname: 'qa.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');

    expect(
      (await t.call(`/tenants/${digdir}/clients/klarsprak-host`, { method: 'DELETE', as: 'kari' }))
        .status,
    ).toBe(200);

    expect((await t.call('/v1/hosts/ka.example.no')).status).toBe(404);
    expect((await t.claims.list(digdir)).map((c) => [c.hostname, c.state]).sort()).toEqual([
      ['ka.example.no', 'removing'],
      ['qa.example.no', 'removed'],
    ]);
  });

  it('an operator taking hosting off the Client removes its hostnames', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');
    const withLogin = hostedClient('klarsprak', [{ hostname: `kunnskap.apps.${zone}` }]);
    await t.saveClient('klarsprak-host', {
      ...withLogin,
      spec: {
        ...withLogin.spec,
        allowedOrigins: ['https://intranett.example.no'],
        oidc: { clientId: 'klarsprak-web', redirectUris: ['https://intranett.example.no/cb'] },
      },
    });

    const res = await t.call(`/tenants/${digdir}/clients/klarsprak-host/hosted`, {
      method: 'PUT',
      as: 'drift',
      body: { hosted: false },
    });

    expect(res.status).toBe(200);
    expect((await t.claims.list(digdir)).map((c) => c.state)).toEqual(['removing']);
  });
});

describe('the internal hostname routes', () => {
  it('refuse every principal but the binder with the same 404', async () => {
    const t = await boot();
    const wrong = [
      undefined,
      'kari',
      await t.token({ oid: '11111111-2222-3333-4444-555555555555' }),
      await t.token({ scp: 'user_impersonation' }),
      await t.token({ tid: '11111111-2222-3333-4444-555555555555' }),
      await t.token({}, 'api://annen'),
    ];
    for (const bearer of wrong) {
      const res = await t.call('/internal/hostnames/work', bearer ? { bearer } : {});
      expect(res.status).toBe(404);
      const posted = await t.call('/internal/hostnames/x/result', {
        method: 'POST',
        ...(bearer ? { bearer } : {}),
        body: { step: 'add', ok: true },
      });
      expect(posted.status).toBe(404);
    }
    expect((await t.call('/internal/hostnames/work', { bearer: await t.token() })).status).toBe(
      200,
    );
  });

  it('accept the binder’s v2 token and refuse one from another issuer', async () => {
    const t = await boot();
    const v2 = await t.token({}, audience, `https://login.microsoftonline.com/${entraTenant}/v2.0`);
    const foreign = await t.token({}, audience, 'https://sts.windows.net/annen-tenant/');

    expect((await t.call('/internal/hostnames/work', { bearer: v2 })).status).toBe(200);
    expect((await t.call('/internal/hostnames/work', { bearer: foreign })).status).toBe(404);
  });

  it('refuse an expired binder token', async () => {
    const t = await boot();
    const old = await t.token();
    t.tick(2 * 3600_000);

    expect((await t.call('/internal/hostnames/work', { bearer: old })).status).toBe(404);
  });
});

describe('a published service gets an address', () => {
  it('at its first publish with an interface: a hosted Client and a name under apps. to bind', async () => {
    const t = await boot();

    expect((await t.publish(service('klarsprak'))).ok).toBe(true);

    const items = await t.work();
    expect(items).toEqual([
      expect.objectContaining({
        hostname: `klarsprak.apps.${zone}`,
        action: 'bind',
        step: 'add',
        zone,
        recordName: 'klarsprak.apps',
      }),
    ]);
    const listed = (await (
      await t.call(`/tenants/${digdir}/services/klarsprak/hostnames`, { as: 'kari' })
    ).json()) as { client: string; hostnames: { hostname: string; state: string; records: [] }[] };
    expect(listed.client).toBe('klarsprak-host');
    expect(listed.hostnames).toEqual([
      expect.objectContaining({
        hostname: `klarsprak.apps.${zone}`,
        state: 'binding',
        records: [],
      }),
    ]);
    await t.bindAll(`klarsprak.apps.${zone}`);
    const host = await t.call(`/v1/hosts/klarsprak.apps.${zone}`);
    expect(host.status).toBe(200);
    expect(await host.json()).toMatchObject({ login: { clientId: 'genki-login' } });
  });

  it('only once, and not again after its owner removed it', async () => {
    const t = await boot();
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    const id = (await t.work())[0]?.id ?? '';
    await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames/klarsprak.apps.${zone}`, {
      method: 'DELETE',
      as: 'kari',
    });
    await t.report(id, { step: 'unbind', ok: true });

    expect((await t.publish(service('klarsprak'))).ok).toBe(true);

    expect(await t.work()).toEqual([]);
  });

  it('not for a service without an assistant interface', async () => {
    const t = await boot();

    expect((await t.publish(service('klarsprak', digdir, false))).ok).toBe(true);

    expect(await t.work()).toEqual([]);
  });

  it('never takes a reserved label, and takes the next free name when its own is held', async () => {
    const t = await boot();
    const at = new Date(start).toISOString();
    await t.claims.create({
      id: 'holder',
      tenant: other,
      client: 'ola-host',
      service: 'noe',
      hostname: `klarsprak.apps.${zone}`,
      apex: false,
      assigned: true,
      token: 't',
      state: 'active',
      step: 'done',
      stateSince: at,
      createdAt: at,
      createdBy: 'test',
      updatedAt: at,
      version: 1,
    });

    expect((await t.publish(service('kunnskap'))).ok).toBe(true);
    expect((await t.publish(service('login', other))).ok).toBe(true);
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);

    expect((await t.work()).map((i) => i.hostname).sort()).toEqual([
      `klarsprak-2.apps.${zone}`,
      `kunnskap-2.apps.${zone}`,
      `login-2.apps.${zone}`,
    ]);
  });

  it('on demand through the portal’s route, once the automatic one is gone', async () => {
    const t = await boot();
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    const id = (await t.work())[0]?.id ?? '';
    await t.call(`/tenants/${digdir}/clients/klarsprak-host/hostnames/klarsprak.apps.${zone}`, {
      method: 'DELETE',
      as: 'kari',
    });
    await t.report(id, { step: 'unbind', ok: true });

    const res = await t.call(`/tenants/${digdir}/services/klarsprak/address`, {
      method: 'POST',
      as: 'kari',
    });

    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({
      hostname: `klarsprak.apps.${zone}`,
      state: 'binding',
    });
  });

  it('not when the platform has no zone to assign names in', async () => {
    const t = await boot({ zone: null });
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    expect(await t.work()).toEqual([]);

    const res = await t.call(`/tenants/${digdir}/services/klarsprak/address`, {
      method: 'POST',
      as: 'kari',
    });

    expect(res.status).toBe(400);
    expect((await errorsOf(res))[0]?.message).toMatch(/^no_zone/);
  });

  it('in lockdown only when an operator publishes, since a hosted Client admits service groups', async () => {
    const t = await boot({ lockdown: true });

    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    expect(await t.work()).toEqual([]);
    const refused = await t.call(`/tenants/${digdir}/services/klarsprak/address`, {
      method: 'POST',
      as: 'kari',
    });
    expect(refused.status).toBe(403);

    expect((await t.publish(service('nynorsk'), 'operator:test:drift')).ok).toBe(true);
    expect((await t.work()).map((i) => i.hostname)).toEqual([`nynorsk.apps.${zone}`]);
  });

  it('counts a platform operator holding every right in their own organisation as an operator there', async () => {
    const t = await boot({
      lockdown: true,
      isOperator: (p) => p.kind === 'employee' && (p.scopes ?? []).includes(trustedEntraScope),
    });

    const acting = tenantAccess(people.nina as Principal, digdir, new Request('http://test'));
    const published = await t.admin.publish(acting as Principal, {
      definition: service('nynorsk'),
      files,
      reason: 'Publiserer tjenesten',
    });
    expect(published.ok).toBe(true);
    expect((await t.work()).map((i) => i.hostname)).toEqual([`nynorsk.apps.${zone}`]);

    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    const given = await t.call(`/tenants/${digdir}/services/klarsprak/address`, {
      method: 'POST',
      as: 'nina',
    });
    expect(given.status).toBe(201);
    expect(await given.json()).toMatchObject({ hostname: `klarsprak.apps.${zone}` });
  });

  it('still refuses an address to an organisation member who is no platform operator', async () => {
    const t = await boot({
      lockdown: true,
      isOperator: (p) => p.kind === 'employee' && (p.scopes ?? []).includes(trustedEntraScope),
    });
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);

    const refused = await t.call(`/tenants/${digdir}/services/klarsprak/address`, {
      method: 'POST',
      as: 'kari',
    });

    expect(refused.status).toBe(403);
  });

  it('counts a platform operator with only some rights in another organisation as no operator there', async () => {
    const t = await boot({
      lockdown: true,
      isOperator: (p) => p.kind === 'employee' && (p.scopes ?? []).includes(trustedEntraScope),
    });
    expect((await t.publish(service('klarsprak', other))).ok).toBe(true);

    const refused = await t.call(`/tenants/${other}/services/klarsprak/address`, {
      method: 'POST',
      as: 'nina-other',
    });

    expect(refused.status).toBe(403);
  });

  const archive = (t: Awaited<ReturnType<typeof boot>>, id: string) =>
    t.call(`/tenants/${digdir}/services/${id}/lifecycle`, {
      method: 'PUT',
      as: 'kari',
      body: { state: 'archived' },
    });
  const clientIds = async (t: Awaited<ReturnType<typeof boot>>) =>
    (
      (await (await t.call(`/tenants/${digdir}/clients`, { as: 'kari' })).json()) as {
        clients: { definition: { metadata: { id: string } } }[];
      }
    ).clients.map((c) => c.definition.metadata.id);
  const deleteForGood = (t: Awaited<ReturnType<typeof boot>>, id: string) =>
    t.call(`/tenants/${digdir}/services/${id}`, {
      method: 'DELETE',
      as: 'kari',
      headers: { 'change-reason': 'Tjenesten trengs ikke lenger' },
    });

  it('deleting a service for good also removes the address genki made for it', async () => {
    const t = await boot();
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    await t.bindAll(`klarsprak.apps.${zone}`);
    await archive(t, 'klarsprak');

    const res = await deleteForGood(t, 'klarsprak');

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      address: { client: 'klarsprak-host', hostnames: [`klarsprak.apps.${zone}`] },
    });
    expect(await clientIds(t)).toEqual([]);
    expect(await t.work()).toEqual([
      expect.objectContaining({ hostname: `klarsprak.apps.${zone}`, action: 'remove' }),
    ]);
    const audit = await t.audit();
    for (const [action, target] of [
      ['platform.clients.remove', `client:${digdir}/klarsprak-host`],
      ['platform.service.delete', `service:${digdir}/klarsprak`],
    ])
      expect(audit.find((a) => a.action === action)).toMatchObject({
        outcome: 'applied',
        target,
        reason: 'Tjenesten trengs ikke lenger',
      });
  });

  it('a frontend someone made still blocks deleting for good, and keeps the address', async () => {
    const t = await boot();
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    await t.bindAll(`klarsprak.apps.${zone}`);
    const own = await t.saveClient('egen-app', {
      metadata: { name: 'Egen app' },
      spec: {
        service: 'klarsprak',
        kind: 'browser',
        channels: ['openai'],
        allowedOrigins: ['https://app.example.no'],
        oidc: { clientId: 'egen-app', redirectUris: ['https://app.example.no/callback'] },
      },
    });
    expect(own.status).toBe(200);
    await archive(t, 'klarsprak');

    const res = await deleteForGood(t, 'klarsprak');

    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({
      type: 'urn:genai:problem:service-in-use',
      errors: [{ path: 'frontends', id: 'egen-app', message: expect.stringContaining('Egen app') }],
    });
    expect(await clientIds(t)).toEqual(['egen-app', 'klarsprak-host']);
    expect(await t.work()).toEqual([]);
  });

  it('a hosted frontend someone made blocks deleting for good even when genki put its address on it', async () => {
    const t = await boot();
    expect((await t.publish(service('klarsprak', digdir, false))).ok).toBe(true);
    expect((await t.saveClient('klarsprak-host', hostedClient('klarsprak'))).status).toBe(200);
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    expect(await t.work()).toEqual([
      expect.objectContaining({ hostname: `klarsprak.apps.${zone}`, action: 'bind' }),
    ]);
    await archive(t, 'klarsprak');

    const res = await deleteForGood(t, 'klarsprak');

    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({
      errors: [{ path: 'frontends', id: 'klarsprak-host' }],
    });
  });

  it('the address Client counts as a frontend once its owner set it up differently', async () => {
    const t = await boot();
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    const changed = await t.saveClient('klarsprak-host', {
      metadata: { name: 'Klarspråk' },
      spec: {
        service: 'klarsprak',
        kind: 'browser',
        channels: ['openai', 'conversations', 'feedback', 'facets'],
        allowedOrigins: [],
        hosted: true,
        hostnames: [],
        url: 'https://klarsprak.example.no',
      },
    });
    expect(changed.status).toBe(200);
    await archive(t, 'klarsprak');

    const res = await deleteForGood(t, 'klarsprak');

    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({
      errors: [{ path: 'frontends', id: 'klarsprak-host' }],
    });
  });

  it('an address frontend with a domain its owner added blocks deleting for good and keeps the domain', async () => {
    const t = await boot();
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    await t.bindAll(`klarsprak.apps.${zone}`);
    const added = await t.claim('klarsprak-host', {
      hostname: 'ka.example.no',
      environment: 'prod',
    });
    expect(added.status).toBe(201);
    await t.verify('ka.example.no');
    await t.bindAll('ka.example.no');
    await archive(t, 'klarsprak');

    const res = await deleteForGood(t, 'klarsprak');

    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({
      errors: [{ path: 'frontends', id: 'klarsprak-host' }],
    });
    expect(await clientIds(t)).toEqual(['klarsprak-host']);
    expect((await t.claims.list(digdir)).map((c) => [c.hostname, c.state])).toEqual(
      expect.arrayContaining([['ka.example.no', 'active']]),
    );
    expect(await t.work()).toEqual([]);
  });

  it('a hosted frontend set up like genki would, under a name of its own, still blocks deleting for good', async () => {
    const t = await boot();
    expect((await t.publish(service('klarsprak', digdir, false))).ok).toBe(true);
    const own = await t.saveClient('egen-vert', {
      metadata: { name: 'Egen vert' },
      spec: {
        service: 'klarsprak',
        kind: 'browser',
        channels: ['openai', 'conversations', 'feedback', 'facets'],
        allowedOrigins: [],
        hosted: true,
        hostnames: [],
      },
    });
    expect(own.status).toBe(200);
    expect((await t.publish(service('klarsprak'))).ok).toBe(true);
    expect((await t.claims.list(digdir)).map((c) => [c.client, c.assigned])).toEqual([
      ['egen-vert', true],
    ]);
    await archive(t, 'klarsprak');

    const res = await deleteForGood(t, 'klarsprak');

    expect(res.status).toBe(409);
    expect((await res.json()) as unknown).toMatchObject({
      errors: [{ path: 'frontends', id: 'egen-vert' }],
    });
  });

  it('removing a service environment removes the hostnames claimed for it', async () => {
    const t = await boot();
    await kunnskapHosted(t);
    await t.call(`/tenants/${digdir}/services/klarsprak/environments`, {
      method: 'POST',
      as: 'kari',
      body: { name: 'test' },
    });
    await t.saveClient('klarsprak-host', {
      ...hostedClient('klarsprak', [{ hostname: `kunnskap.apps.${zone}` }]),
      spec: {
        ...hostedClient('klarsprak', [{ hostname: `kunnskap.apps.${zone}` }]).spec,
        environments: ['prod', 'test'],
      },
    });
    const claimed = await t.claim('klarsprak-host', {
      hostname: 'test.example.no',
      environment: 'test',
    });
    expect(claimed.status).toBe(201);
    await t.claim('klarsprak-host', { hostname: 'ka.example.no', environment: 'prod' });

    const res = await t.call(`/tenants/${digdir}/services/klarsprak/environments/test`, {
      method: 'DELETE',
      as: 'kari',
    });

    expect(res.status).toBe(200);
    expect((await t.claims.list(digdir)).map((c) => [c.hostname, c.state]).sort()).toEqual([
      ['ka.example.no', 'pending-dns'],
      ['test.example.no', 'removed'],
    ]);
  });

  it('records the address in the audit log', async () => {
    const t = await boot();

    expect((await t.publish(service('klarsprak'))).ok).toBe(true);

    expect((await t.audit()).map((a) => [a.action, a.actor, a.outcome])).toContainEqual([
      'platform.service.address',
      'platform:hostnames',
      'applied',
    ]);
  });
});

describe('the binder through the whole app', () => {
  const locked = async () => {
    const key = await createSigningKey();
    const claims = new InMemoryHostnameClaims();
    const booted = await bootPlatform({
      lockdown: true,
      appLockdown: true,
      people: { kari: people.kari as Principal, drift: people.drift as Principal },
      hostnames: { claims, zone, target: {}, limit: 200, reservedLabels: defaultReservedLabels },
      binder: {
        principalId: binderId,
        tenantId: entraTenant,
        audience,
        keys: createLocalJWKSet({ keys: [key.publicJwk] }),
      },
    });
    const at = new Date().toISOString();
    await claims.create({
      id: 'krav-1',
      tenant: digdir,
      client: 'klarsprak-host',
      service: 'klarsprak',
      hostname: 'ka.example.no',
      environment: 'prod',
      apex: false,
      assigned: false,
      token: 'token-0123456789',
      state: 'binding',
      step: 'add',
      stateSince: at,
      createdAt: at,
      createdBy: 'test',
      updatedAt: at,
      version: 1,
    });
    const binderToken = await new SignJWT({ tid: entraTenant, oid: binderId })
      .setProtectedHeader({ alg: 'RS256', kid: key.kid })
      .setIssuer(`https://sts.windows.net/${entraTenant}/`)
      .setAudience(audience)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(key.privateKey);
    const post = (bearer: string) =>
      booted.app.request('/internal/hostnames/krav-1/result', {
        method: 'POST',
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        body: JSON.stringify({ step: 'add', ok: true }),
      });
    return { claims, binderToken, post };
  };

  it('lets the binder report a result in lockdown, with no change reason', async () => {
    const { claims, binderToken, post } = await locked();

    const res = await post(binderToken);

    expect(res.status).toBe(200);
    expect((await claims.find('krav-1'))?.step).toBe('certificate');
  });

  it('answers a signed-in person or operator on the result route with 404, not 400, 401 or 403', async () => {
    const { claims, post } = await locked();

    const statuses = [(await post('kari')).status, (await post('drift')).status];

    expect(statuses).toEqual([404, 404]);
    expect((await claims.find('krav-1'))?.step).toBe('add');
  });
});

describe('reserved labels', () => {
  it('keeps the retired workspace label reserved, so no tenant can claim it', () => {
    expect(defaultReservedLabels).toContain('workspace');
  });
});
