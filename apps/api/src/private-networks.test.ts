import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { envSecrets } from '@genai/kernel';
import type { AssistantProposal } from '@genai/strategy-builder';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { storeProposal, type CatalogProposal } from './proposals.js';

const digdir = '991825827';
const other = '999888777';

const principals: Record<string, Principal> = {
  kari: { kind: 'employee', issuer: 'test', subject: 'kari', tenant: digdir },
  ola: { kind: 'employee', issuer: 'test', subject: 'ola', tenant: other },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const names: Record<string, string[]> = {
  'fagsystem.intern': ['10.20.0.5'],
  'metadata.intern': ['169.254.169.254'],
};

const boot = async () => {
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (plugins) => new InMemoryDefinitionStore(plugins),
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const principal = principals[request.headers.get('authorization')?.slice(7) ?? ''];
      return principal ? { principal } : undefined;
    },
    egress: { lookup: async (host) => names[host] ?? [] },
  });
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (path: string, as: string, init: { method?: string; body?: unknown } = {}) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        'change-reason': 'Fagsystemet ligger i virksomhetens nett',
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const allow = (tenant: string, entries: string[]) =>
    call(`/operator/tenants/${tenant}/private-networks`, 'drift', {
      method: 'PUT',
      body: { entries },
    });
  const reach = async (tenant: string, as: string, host: string) =>
    (await (
      await call(`/tenants/${tenant}/connectors/network?host=${encodeURIComponent(host)}`, as)
    ).json()) as { network: string; allowed: boolean; message?: string };
  return { admin, call, allow, reach };
};

const proposal = (host: string): AssistantProposal => ({
  id: 'forslag',
  level: 2,
  kind: 'connector',
  title: 'Saker fra fagsystemet',
  detail: 'Leser saker',
  validation: { ok: true },
  requiresApproval: true,
  appliedToDraft: false,
  mapping: [{ table: 'saker', becomes: 'document', fields: ['tittel'] }],
  source: {
    engine: 'postgres',
    host,
    database: 'fagsystem',
    table: 'saker',
    fields: { id: 'id', title: 'tittel', text: ['sammendrag'] },
    filter: [],
  },
  permissions: [{ type: 'data', value: 'saker', note: 'Bare lesing' }],
  tests: [],
});

describe('private networks for agency databases', () => {
  it('refuses a private database host by default and names Digdir as the one who can open it', async () => {
    const { admin, call, reach } = await boot();
    expect(await reach(digdir, 'kari', 'fagsystem.intern')).toMatchObject({
      network: 'private',
      allowed: false,
      message: expect.stringContaining('Digdir'),
    });
    const stored = (await storeProposal(
      admin,
      principals.kari as Principal,
      digdir,
      { id: 'saksinnsyn', name: 'Saksinnsyn' },
      proposal('fagsystem.intern'),
    )) as CatalogProposal;
    const refused = await call(`/tenants/${digdir}/proposals/${stored.id}/approve`, 'kari', {
      body: { reason: 'Koblingen er gjennomgått', connection: { user: 'leser', password: 'x' } },
    });
    expect(refused.status).toBe(422);
    expect(await refused.json()).toMatchObject({
      title: 'Databasen ligger på et privat nettverk',
      errors: [{ path: 'connection.host', message: expect.stringContaining('Digdir') }],
    });
  });

  it('allows the host once a Digdir operator adds its range, with a reason and an audit entry', async () => {
    const { admin, call, allow, reach } = await boot();
    const saved = await allow(digdir, ['10.20.0.0/16']);
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ tenant: digdir, entries: ['10.20.0.0/16'] });
    expect(await reach(digdir, 'kari', 'fagsystem.intern')).toEqual({
      host: 'fagsystem.intern',
      network: 'private',
      allowed: true,
    });
    expect(await (await call(`/tenants/${digdir}/private-networks`, 'kari')).json()).toMatchObject({
      entries: ['10.20.0.0/16'],
      changedBy: expect.stringContaining('drift'),
      reason: 'Fagsystemet ligger i virksomhetens nett',
    });
    const events = await admin.events(saved.headers.get('genai-task') ?? '');
    expect(events.find((e) => e.type === 'x.platform.change')?.data).toMatchObject({
      action: 'platform.private-networks.save',
      before: { entries: [] },
      after: { entries: ['10.20.0.0/16'] },
    });
  });

  it('never allows loopback, link-local metadata or broad ranges', async () => {
    const { allow, reach } = await boot();
    for (const entries of [['127.0.0.0/8'], ['169.254.169.254'], ['0.0.0.0/0'], ['localhost']])
      expect((await allow(digdir, entries)).status).toBe(400);
    expect((await allow(digdir, ['10.0.0.0/8', 'metadata.intern'])).status).toBe(200);
    for (const host of ['127.0.0.1', '169.254.169.254', 'metadata.intern'])
      expect(await reach(digdir, 'kari', host)).toMatchObject({
        network: 'blocked',
        allowed: false,
        message: expect.stringContaining('alltid stengt'),
      });
  });

  it('keeps one tenant opening apart from another and lets only operators change it', async () => {
    const { call, allow, reach } = await boot();
    await allow(digdir, ['10.20.0.0/16']);
    expect(await reach(other, 'ola', 'fagsystem.intern')).toMatchObject({ allowed: false });
    expect(await (await call(`/tenants/${other}/private-networks`, 'ola')).json()).toMatchObject({
      entries: [],
    });
    expect((await call(`/tenants/${digdir}/private-networks`, 'ola')).status).toBe(404);
    expect(
      (
        await call(`/operator/tenants/${digdir}/private-networks`, 'kari', {
          method: 'PUT',
          body: { entries: ['10.0.0.0/8'] },
        })
      ).status,
    ).toBe(403);
    expect((await call(`/operator/tenants/${digdir}/private-networks`, 'kari')).status).toBe(403);
  });
});
