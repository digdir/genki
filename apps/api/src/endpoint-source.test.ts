import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { endpointNotAllowedType } from './endpoint-source.js';

const vaultValue = 'hemmelig-nokkel-123';
const digdir = '991825827';
const other = '999888777';
const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  erik: {
    kind: 'employee',
    issuer: 'test',
    subject: 'erik',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services', 'manage-datasets'] }],
  },
};

const addresses: Record<string, string[]> = {
  'sok.testetaten.example.no': ['203.0.113.10'],
  'intern.testetaten.example.no': ['10.0.0.7'],
};

const boot = async () => {
  const resolved: Record<string, string[]> = { ...addresses };
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    egress: { lookup: async (host) => resolved[host] ?? [] },
    configurables: { scheduleIntervalMs: 0 },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const create = (as: string, body: Record<string, unknown>, tenant = digdir) =>
    app.request(`/tenants/${tenant}/datasets`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': 'Kobler til søket på intranettet',
      },
      body: JSON.stringify({ id: 'intranett', name: 'Intranett', residency: 'norway', ...body }),
    });
  return { platform, admin, app, create, resolved };
};

const withKey = {
  url: 'https://sok.testetaten.example.no/api/sok',
  auth: { kind: 'api-key', header: 'x-api-key', apiKey: vaultValue },
};

describe('a dataset searched live at an organisation endpoint', () => {
  it('connects an open endpoint as an http-search connection and shows the dataset as an endpoint source', async () => {
    const { app, create, platform } = await boot();

    const created = await create('kari', {
      endpointSource: { url: 'https://sok.testetaten.example.no/api/sok', auth: { kind: 'none' } },
    });

    expect(created.status).toBe(201);
    expect(
      platform.catalog.get('knowledge-endpoint', `${digdir}/endpoint-intranett`)?.spec,
    ).toEqual({
      engine: 'http-search',
      baseURL: 'https://sok.testetaten.example.no',
      options: { searchPath: '/api/sok' },
    });
    const detail = (await (
      await app.request(`/tenants/${digdir}/datasets/intranett`, {
        headers: { authorization: 'Bearer kari' },
      })
    ).json()) as { source: string; state: string };
    expect(detail).toMatchObject({ source: 'endpoint', state: 'external' });
  });

  it('keeps an API key in the vault bound to the endpoint host, and never returns or audits it', async () => {
    const { create, platform, admin } = await boot();

    const created = await create('kari', { endpointSource: withKey });
    const text = await created.text();

    expect(created.status).toBe(201);
    expect(text).not.toContain(vaultValue);
    expect(await platform.vault.hosts(digdir, 'endpoint-intranett-key')).toEqual([
      'https://sok.testetaten.example.no',
    ]);
    expect(
      platform.catalog.get('knowledge-endpoint', `${digdir}/endpoint-intranett`)?.spec.auth,
    ).toMatchObject({ kind: 'api-key', header: 'x-api-key' });
    expect(JSON.stringify(await admin.audit(digdir))).not.toContain(vaultValue);
  });

  it.each([
    ['plain http', 'http://sok.testetaten.example.no/sok'],
    ['an IP address', 'https://203.0.113.10/sok'],
    ['a loopback address', 'https://127.0.0.1/sok'],
    ['localhost', 'https://localhost/sok'],
    ['a reserved name', 'https://sok.internal/sok'],
    ['a host that resolves to a private address', 'https://intern.testetaten.example.no/sok'],
    ['a host that does not resolve', 'https://borte.testetaten.example.no/sok'],
    ['a user name and password', 'https://a:b@sok.testetaten.example.no/sok'],
  ])('refuses %s and creates nothing', async (_what, url) => {
    const { create, platform } = await boot();

    const refused = await create('kari', {
      endpointSource: { url, auth: { kind: 'api-key', apiKey: vaultValue } },
    });

    expect([400, 422]).toContain(refused.status);
    if (refused.status === 422)
      expect(((await refused.json()) as { type: string }).type).toBe(endpointNotAllowedType);
    expect(await platform.vault.names(digdir)).toEqual([]);
    expect(platform.catalog.get('knowledge-endpoint', `${digdir}/endpoint-intranett`)).toBe(
      undefined,
    );
    expect(platform.catalog.get('dataset', `${digdir}/intranett`)).toBe(undefined);
  });

  it('needs the right to set secrets as well as manage-datasets for an API key, and keeps nothing when refused', async () => {
    const { create, platform } = await boot();

    const refused = await create('erik', { endpointSource: withKey });
    const open = await create('erik', {
      endpointSource: { url: withKey.url, auth: { kind: 'none' } },
    });

    expect(refused.status).toBe(403);
    expect(await platform.vault.names(digdir)).toEqual([]);
    expect(open.status).toBe(201);
  });

  it('creates nothing when the dataset itself is invalid', async () => {
    const { create, platform } = await boot();

    const refused = await create('kari', { residency: 'mars', endpointSource: withKey });

    expect(refused.status).toBe(400);
    expect(await platform.vault.names(digdir)).toEqual([]);
    expect(platform.catalog.get('knowledge-endpoint', `${digdir}/endpoint-intranett`)).toBe(
      undefined,
    );
  });

  it('never overwrites a secret of the same name, which could move its host binding', async () => {
    const { create, platform } = await boot();
    await platform.vault.set(digdir, 'endpoint-intranett-key', 'gammel', [
      'https://annet.example.no',
    ]);

    const refused = await create('kari', { endpointSource: withKey });

    expect(refused.status).toBe(409);
    expect(await platform.vault.hosts(digdir, 'endpoint-intranett-key')).toEqual([
      'https://annet.example.no',
    ]);
  });

  it('removes the connection and its key through the audited secret delete when the dataset cannot be saved', async () => {
    const { create, platform, admin } = await boot();
    const publish = platform.catalog.publish.bind(platform.catalog);
    vi.spyOn(platform.catalog, 'publish').mockImplementation(async (input) =>
      input.kind === 'dataset'
        ? { ok: false, errors: [{ path: 'spec', message: 'refused' }] }
        : publish(input),
    );

    const refused = await create('kari', { endpointSource: withKey });

    expect(refused.status).not.toBe(201);
    expect(await platform.vault.names(digdir)).toEqual([]);
    expect(platform.catalog.get('knowledge-endpoint', `${digdir}/endpoint-intranett`)).toBe(
      undefined,
    );
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({ action: 'platform.secrets.delete' }),
    );
  });

  it('removes the key through the audited secret delete when the connection cannot be saved', async () => {
    const { create, platform, admin } = await boot();
    vi.spyOn(platform.catalog, 'publish').mockResolvedValue({
      ok: false,
      errors: [{ path: 'spec', message: 'refused' }],
    });

    const refused = await create('kari', { endpointSource: withKey });

    expect(refused.status).not.toBe(201);
    expect(await platform.vault.names(digdir)).toEqual([]);
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({ action: 'platform.secrets.delete' }),
    );
  });

  it('deleting the dataset removes its connection and key, so the same id can be created again', async () => {
    const { app, create, platform } = await boot();
    expect((await create('kari', { endpointSource: withKey })).status).toBe(201);

    const deleted = await app.request(`/tenants/${digdir}/datasets/intranett`, {
      method: 'DELETE',
      headers: { authorization: 'Bearer kari', 'change-reason': 'Intranettsøket er lagt ned' },
    });

    expect(deleted.status).toBe(200);
    expect(((await deleted.json()) as { removed: unknown }).removed).toMatchObject({
      endpoint: 'endpoint-intranett',
      secret: 'endpoint-intranett-key',
    });
    expect(platform.catalog.get('knowledge-endpoint', `${digdir}/endpoint-intranett`)).toBe(
      undefined,
    );
    expect(await platform.vault.names(digdir)).toEqual([]);
    expect((await create('kari', { endpointSource: withKey })).status).toBe(201);
  });

  it("never connects an endpoint in another organisation's catalogue", async () => {
    const { create, platform } = await boot();

    const refused = await create('ola', { endpointSource: withKey });

    expect(refused.status).toBe(404);
    expect(await platform.vault.names(digdir)).toEqual([]);
  });

  it('checks the address again on every search, so a host that later resolves to a private address is never called', async () => {
    const { app, create, resolved } = await boot();
    await create('kari', {
      endpointSource: { url: 'https://sok.testetaten.example.no/api/sok', auth: { kind: 'none' } },
    });
    resolved['sok.testetaten.example.no'] = ['10.0.0.7'];

    const searched = await app.request(`/tenants/${digdir}/datasets/intranett/search`, {
      method: 'POST',
      headers: { authorization: 'Bearer kari', 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'ferie' }),
    });

    expect(searched.status).toBe(502);
    expect(await searched.text()).not.toContain('10.0.0.7');
  });
});
