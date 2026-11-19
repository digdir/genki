import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { actorNames } from './actor-names.js';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { InMemoryConfigEntryStore } from './config-store.js';
import { defaultReservedDomains, hostNotFoundType } from './hosts.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { digdir, fakeModels, files, other, principals, testService } from './testkit.js';

const layout = (secondary: { block: string }[] = []) => ({
  version: 1,
  zones: { primary: [{ block: 'threads' }], main: [{ block: 'chat' }], secondary },
  profile: { assistantName: 'Klarspråkassistenten' },
});

const shown = {
  layout: layout(),
  menu: [
    { label: 'Om', page: 'om' },
    { label: { nb: 'Hjelp', en: 'Help' }, href: 'https://example.no/hjelp' },
  ],
  pages: [{ id: 'om', title: 'Om tjenesten', body: '# Om\n\nHei.' }],
};

const service = (id: string, iface?: unknown, tenant = digdir) => {
  const d = testService(id, tenant);
  return { ...d, spec: { ...d.spec, ...(iface ? { interface: iface } : {}) } };
};

const client = (spec: Record<string, unknown> = {}) => ({
  metadata: { name: 'Klarspråk' },
  spec: {
    service: 'klarsprak',
    kind: 'browser',
    channels: ['openai'],
    allowedOrigins: [],
    oidc: { clientId: 'klarsprak-host', redirectUris: ['https://ka.example.no/callback'] },
    hosted: true,
    hostnames: [{ hostname: 'ka.example.no' }],
    ...spec,
  },
});

const boot = async (options: { lockdown?: boolean } = {}) => {
  const keys = new InMemoryTenantApiKeys();
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
    apiKeys: keys,
    hosting: {
      hostnames: new Map([
        ['ka.example.no', digdir],
        ['nynorsk.example.no', digdir],
        ['ola.example.no', other],
        ['kunnskap.apps.genki-test.digdir.cloud', digdir],
        ['portal.genki-test.digdir.cloud', digdir],
        ['a.kunnskap.apps.genki-test.digdir.cloud', digdir],
      ]),
      reservedDomains: defaultReservedDomains,
    },
    ...(options.lockdown ? { lockdown: { configuredKeys: new Set<string>() } } : {}),
    authenticate: async (request) => {
      const person =
        principals[request.headers.get('authorization')?.replace(/^Bearer /, '') ?? ''];
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
    init: { method?: string; as?: string; body?: unknown; headers?: Record<string, string> } = {},
  ) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'change-reason': 'Tar i bruk genkis vert',
        ...(init.as ? { authorization: `Bearer ${init.as}` } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const publish = async (definition: unknown) =>
    platform.definitions.publish(definition, 'test', 'test', files);
  const saveClient = (id: string, body: unknown, as = 'kari', tenant = digdir) =>
    call(`/tenants/${tenant}/clients/${id}`, { method: 'PUT', as, body });
  return { admin, call, publish, saveClient };
};

const errorsOf = async (res: Response) =>
  ((await res.json()) as { errors: { path: string; message: string }[] }).errors;

describe('the assistant host', () => {
  it('shows a hosted service by its hostname, with its menu and pages, to anyone', async () => {
    const { call, publish, saveClient } = await boot();
    expect((await publish(service('klarsprak', shown))).ok).toBe(true);
    expect((await saveClient('klarsprak-host', client())).status).toBe(200);

    const res = await call('/v1/hosts/KA.example.no');

    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60');
    expect(await res.json()).toMatchObject({
      hostname: 'ka.example.no',
      tenant: digdir,
      service: 'klarsprak',
      environment: 'prod',
      name: 'Klarspråkassistenten',
      login: { clientId: 'klarsprak-host' },
      menu: shown.menu,
      pages: [{ id: 'om', title: 'Om tjenesten' }],
    });
    const page = await call('/v1/hosts/ka.example.no/pages/om');
    expect(await page.json()).toEqual(shown.pages[0]);
    expect((await call('/v1/hosts/ka.example.no/pages/finnes-ikke')).status).toBe(404);
  });

  it('tells anyone only what the page needs before login, and no layout, page body, registration id or version', async () => {
    const { call, publish, saveClient } = await boot();
    expect((await publish(service('klarsprak', shown))).ok).toBe(true);
    expect((await saveClient('klarsprak-host', client())).status).toBe(200);

    const res = await call('/v1/hosts/ka.example.no');

    expect(await res.json()).toEqual({
      hostname: 'ka.example.no',
      tenant: digdir,
      service: 'klarsprak',
      environment: 'prod',
      name: 'Klarspråkassistenten',
      login: { issuer: null, clientId: 'klarsprak-host' },
      theme: null,
      menu: shown.menu,
      pages: [{ id: 'om', title: 'Om tjenesten' }],
    });
  });

  it('answers the same 404 for every hostname that is not active', async () => {
    const { call, publish, saveClient } = await boot();
    expect((await publish(service('klarsprak', shown))).ok).toBe(true);
    expect((await publish(service('nynorsk'))).ok).toBe(true);
    expect((await saveClient('klarsprak-host', client())).status).toBe(200);
    const bare = client({
      service: 'nynorsk',
      oidc: { clientId: 'nynorsk-host', redirectUris: ['https://nynorsk.example.no/callback'] },
      hostnames: [{ hostname: 'nynorsk.example.no' }],
    });
    expect((await saveClient('nynorsk-host', bare)).status).toBe(200);

    for (const name of [
      'ukjent.example.no',
      'nynorsk.example.no',
      'ola.example.no',
      'genki.digdir.cloud',
      '127.0.0.1',
      'ka.example.no/pages/finnes-ikke',
    ]) {
      const res = await call(`/v1/hosts/${name}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({
        type: hostNotFoundType,
        title: 'Ingen tjeneste på dette vertsnavnet',
        status: 404,
      });
    }
  });

  it('a hostname without a published environment shows nothing', async () => {
    const { call, publish, saveClient } = await boot();
    expect((await publish(service('klarsprak', shown))).ok).toBe(true);
    const onTest = client({
      environments: ['prod', 'test'],
      hostnames: [{ hostname: 'ka.example.no', environment: 'test' }],
    });
    expect((await saveClient('klarsprak-host', onTest)).status).toBe(200);

    expect((await call('/v1/hosts/ka.example.no')).status).toBe(404);
  });

  it('reads the hostname from the path, never from a forged Host header', async () => {
    const { call, publish, saveClient } = await boot();
    expect((await publish(service('klarsprak', shown))).ok).toBe(true);
    expect((await saveClient('klarsprak-host', client())).status).toBe(200);

    const forged = await call('/v1/hosts/ukjent.example.no', {
      headers: { host: 'ka.example.no', 'x-forwarded-host': 'ka.example.no' },
    });

    expect(forged.status).toBe(404);
  });

  it('a tenant cannot claim a hostname opened to another tenant', async () => {
    const { call, publish, saveClient } = await boot();
    expect((await publish(service('klarsprak', shown, other))).ok).toBe(true);

    const res = await saveClient('klarsprak-host', client(), 'ola', other);

    expect(res.status).toBe(400);
    expect((await errorsOf(res))[0]?.message).toMatch(/^hostname_not_allowed/);
    expect((await call('/v1/hosts/ka.example.no')).status).toBe(404);
  });
});

describe('names genki assigns in its own zone', () => {
  it('a service may take one label under apps. in genki’s zone once opened to it, and no other name there', async () => {
    const { publish, saveClient } = await boot();
    expect((await publish(service('klarsprak', shown))).ok).toBe(true);
    const save = (hostname: string) =>
      saveClient('klarsprak-host', client({ hostnames: [{ hostname }] }));

    expect((await save('kunnskap.apps.genki-test.digdir.cloud')).status).toBe(200);
    for (const refused of [
      'portal.genki-test.digdir.cloud',
      'a.kunnskap.apps.genki-test.digdir.cloud',
    ]) {
      const res = await save(refused);
      expect(res.status, refused).toBe(400);
      expect((await errorsOf(res))[0]?.message).toMatch(/^hostname_not_allowed/);
    }
  });
});

describe('a service’s interface (/v1/models/{id}/interface)', () => {
  it('a person of the tenant reads the interface the service runs, and no one else does', async () => {
    const { call, publish } = await boot();
    expect((await publish(service('klarsprak', shown))).ok).toBe(true);
    expect((await publish(service('nynorsk'))).ok).toBe(true);

    const own = await call('/v1/models/klarsprak__default/interface', { as: 'kari' });
    expect(own.status).toBe(200);
    expect(own.headers.get('cache-control')).toBe('private, no-store');
    expect(await own.json()).toEqual(shown);

    const otherTenant = await call('/v1/models/klarsprak__default/interface', { as: 'ola' });
    expect(otherTenant.status).toBe(404);
    expect(await otherTenant.json()).toMatchObject({ error: { code: 'model_not_found' } });
    const unknown = await call('/v1/models/finnes-ikke__default/interface', { as: 'kari' });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toMatchObject({ error: { code: 'model_not_found' } });
    expect((await call('/v1/models/klarsprak__default/interface')).status).toBe(401);
    const bare = await call('/v1/models/nynorsk__default/interface', { as: 'kari' });
    expect(bare.status).toBe(404);
    expect(await bare.json()).toMatchObject({ error: { code: 'interface_not_found' } });
  });
});

describe('the interface catalogue', () => {
  it('refuses a block the catalogue does not know', async () => {
    const { publish } = await boot();

    const published = await publish(service('klarsprak', { layout: layout([{ block: 'map' }]) }));

    expect(published.ok ? [] : published.errors).toEqual([
      {
        path: 'spec.interface.layout.zones.secondary[0].block',
        message: 'unknown interface block map',
      },
    ]);
  });

  it('reports a refused block together with a missing dataset', async () => {
    const { publish } = await boot();
    const searching = service('klarsprak', { layout: layout([{ block: 'map' }]) });

    const published = await publish({
      ...searching,
      spec: {
        ...searching.spec,
        strategy: { id: 'rag-single-shot', version: 1, config: { generate: true } },
        knowledge: { datasets: [] },
      },
    });

    expect(published.ok ? [] : published.errors.map((e) => e.path)).toEqual([
      'spec.interface.layout.zones.secondary[0].block',
      'spec.strategy',
    ]);
  });

  it('keeps a host’s own x- block until genki’s host draws the service, and then refuses it', async () => {
    const { publish, saveClient } = await boot();
    const own = service('klarsprak', { layout: layout([{ block: 'x-ka-glossary' }]) });
    expect((await publish(own)).ok).toBe(true);

    const hosting = await saveClient('klarsprak-host', client());
    expect(hosting.status).toBe(400);
    expect((await errorsOf(hosting))[0]?.path).toBe('spec.hosted');

    expect((await publish(service('klarsprak', shown))).ok).toBe(true);
    expect((await saveClient('klarsprak-host', client())).status).toBe(200);
    expect((await publish(own)).ok).toBe(false);
  });
});

describe('hosted clients in lockdown', () => {
  const ready = async () => {
    const booted = await boot({ lockdown: true });
    expect((await booted.publish(service('klarsprak', shown))).ok).toBe(true);
    const opened = await booted.admin.openSupportSession(
      principals.operator as Principal,
      digdir,
      'tar i bruk vert',
      30,
    );
    const session = opened.ok ? (opened.value as { id: string }).id : '';
    const markHosted = (id: string, as = 'operator') =>
      booted.call(`/tenants/${digdir}/clients/${id}/hosted`, {
        method: 'PUT',
        as,
        headers: { 'support-session': session },
        body: { hosted: true, hostnames: [{ hostname: 'ka.example.no' }] },
      });
    return { ...booted, markHosted };
  };

  it('in lockdown only a platform operator can mark a client hosted, and it is audited', async () => {
    const { admin, call, saveClient, markHosted } = await ready();
    const plain = client({
      hosted: undefined,
      hostnames: undefined,
      allowedOrigins: ['https://ka.example.no'],
    });
    expect((await saveClient('klarsprak-host', plain)).status).toBe(200);

    expect((await saveClient('klarsprak-host', client())).status).toBe(403);
    const asTenant = await markHosted('klarsprak-host', 'kari');
    expect(asTenant.status).toBe(403);

    const asOperator = await markHosted('klarsprak-host', 'operator');
    expect(asOperator.status).toBe(200);
    expect(await asOperator.json()).toMatchObject({
      definition: { spec: { hosted: true, allowedOrigins: ['https://ka.example.no'] } },
    });
    expect(
      (await admin.audit(digdir))
        .filter((a) => a.action === 'platform.client.hosted')
        .map(({ outcome, target, reason }) => ({ outcome, target, reason })),
    ).toEqual([
      {
        outcome: 'rejected',
        target: `client:${digdir}/klarsprak-host`,
        reason: 'Tar i bruk genkis vert',
      },
      {
        outcome: 'applied',
        target: `client:${digdir}/klarsprak-host`,
        reason: 'Tar i bruk genkis vert',
      },
    ]);
    expect((await call('/v1/hosts/ka.example.no')).status).toBe(200);
  });

  it('in lockdown the tenant keeps editing a hosted client but cannot unhost it or move its client id', async () => {
    const { saveClient, markHosted } = await ready();
    expect(
      (
        await saveClient(
          'klarsprak-host',
          client({
            hosted: undefined,
            hostnames: undefined,
            allowedOrigins: ['https://ka.example.no'],
          }),
        )
      ).status,
    ).toBe(200);
    const hosted = await markHosted('klarsprak-host', 'operator');
    expect(hosted.status).toBe(200);

    expect(
      (await saveClient('klarsprak-host', client({ channels: ['openai', 'mcp'] }))).status,
    ).toBe(200);
    const moved = client({
      oidc: { clientId: 'annen-klient', redirectUris: ['https://ka.example.no/callback'] },
    });
    expect((await saveClient('klarsprak-host', moved)).status).toBe(403);
    const unhosted = client({
      hosted: undefined,
      hostnames: undefined,
      allowedOrigins: ['https://ka.example.no'],
    });
    expect((await saveClient('klarsprak-host', unhosted)).status).toBe(403);
  });

  it('marking a client hosted needs the client to exist', async () => {
    const { markHosted } = await ready();
    const res = await markHosted('finnes-ikke', 'operator');
    expect(res.status).toBe(404);
  });
});
