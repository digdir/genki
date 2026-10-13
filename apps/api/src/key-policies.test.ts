import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, platformSettings, SettingsRegistry } from '@genai/definitions';
import { apiKeyDigest, createAuthenticator } from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createApp } from './app.js';
import { callerFrom, createPlatform } from './composition.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { digdir, files, other, readJson as json, testService } from './testkit.js';

const people: Record<string, Principal> = {
  kari: {
    kind: 'employee',
    issuer: 'test',
    subject: 'kari',
    tenant: digdir,
    authorizedFor: [{ org: digdir }],
  },
  bruker: {
    kind: 'employee',
    issuer: 'test',
    subject: 'bruker',
    tenant: digdir,
    authorizedFor: [{ org: digdir, actions: ['use-services'] }],
  },
  ola: {
    kind: 'employee',
    issuer: 'test',
    subject: 'ola',
    tenant: other,
    authorizedFor: [{ org: other }],
  },
  drift: { kind: 'operator', issuer: 'test', subject: 'drift' },
};

const reason = 'Arkivsystemet skal bare nå to tjenester';

const boot = async () => {
  const keys = new InMemoryTenantApiKeys();
  const base = {
    tenant: digdir,
    scopes: ['query' as const],
    datasets: [],
    agents: [],
  };
  await keys.add({
    ...base,
    id: 'gammel',
    name: 'Gammel nøkkel',
    digest: apiKeyDigest('gp_gammel'),
  });
  await keys.add({
    ...base,
    id: 'ny',
    name: 'Ny nøkkel',
    service: 'klarsprak',
    digest: apiKeyDigest('gp_ny'),
  });
  const authenticator = createAuthenticator({ apiKeys: keys });
  const settings = new SettingsRegistry(platformSettings);
  const platform = await createPlatform({
    catalogs: {
      models: {
        endpoints: {
          fake: {
            protocol: 'openai-chat',
            baseURL: 'https://modell.example.no/v1',
            auth: { kind: 'api-key', secret: 'secret://env/fake-key' },
          },
        },
        models: [{ id: 'fake/gpt', endpoint: 'fake', deployment: 'gpt', residency: 'norway' }],
      },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    settings,
    prices: {},
    secrets: envSecrets({ FAKE_KEY: 'k' }),
    definitions: (p) => new InMemoryDefinitionStore(p),
    apiKeys: keys,
    policy: { decide: async () => ({ allow: true }) },
    authenticate: async (request) => {
      const person = people[request.headers.get('authorization')?.slice(7) ?? ''];
      if (person) return { principal: person };
      const found = await authenticator.authenticate(request);
      return found && callerFrom(found);
    },
  });
  for (const id of ['klarsprak', 'veileder'])
    await platform.definitions.publish(testService(id), 'test', 'test', files);
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings,
    extensions: platform.extensions,
  });
  const app = createApp('test', {
    platform: {
      store: platform.definitions,
      plugins: platform.plugins,
      settings,
      admin,
      auth: { authenticate: async () => undefined },
      tenantGate: platform.tenantGate,
    },
  });
  platform.mount(app, admin);
  const send = (
    path: string,
    as: string,
    init: { method?: string; body?: unknown; reason?: string; language?: string } = {},
  ) =>
    app.request(path, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: {
        authorization: `Bearer ${as}`,
        'content-type': 'application/json',
        ...(init.reason ? { 'change-reason': init.reason } : {}),
        ...(init.language ? { 'accept-language': init.language } : {}),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  const tools = async (key: string) => {
    const res = await app.request('/api/mcp', {
      method: 'POST',
      headers: {
        'x-api-key': `gp_${key}`,
        'content-type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/list',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    return body.result.tools.map((t) => t.name).sort();
  };
  const policies = `/tenants/${digdir}/api-key-policies`;
  const create = (body: unknown, as = 'kari') => send(policies, as, { body, reason });
  return { send, create, tools, admin, policies };
};

type View = {
  id: string;
  name: string;
  scopes: string[];
  datasets: string[];
  agents: string[];
  modes: string[];
  allowedConfigKeys: string[];
  keyIds: string[];
};

describe('access policies for API keys', () => {
  it('creates, lists, updates and deletes a policy, and audits each change', async () => {
    const { send, create, policies, admin } = await boot();

    const created = await create({
      name: 'Bare klarspråk',
      scopes: ['query'],
      agents: ['klarsprak__default'],
      modes: ['builtin/agent-rag-graph-faithful'],
      allowedConfigKeys: ['runtime:default'],
    });
    const made = await json<View>(created);
    const updated = await send(`${policies}/${made.id}`, 'kari', {
      method: 'PUT',
      body: {
        name: 'Klarspråk og veileder',
        scopes: ['query'],
        agents: ['klarsprak__default', 'veileder__default'],
      },
      reason,
    });
    const listed = await json<{ data: View[] }>(await send(policies, 'kari'));
    const removed = await send(`${policies}/${made.id}`, 'kari', { method: 'DELETE', reason });
    const after = await json<{ data: View[] }>(await send(policies, 'kari'));

    expect(created.status).toBe(201);
    expect(made).toMatchObject({
      name: 'Bare klarspråk',
      scopes: ['query'],
      agents: ['klarsprak__default'],
      modes: ['builtin/agent-rag-graph-faithful'],
      allowedConfigKeys: ['runtime:default'],
      keyIds: [],
    });
    expect(updated.status).toBe(200);
    expect(listed.data).toEqual([
      expect.objectContaining({
        id: made.id,
        name: 'Klarspråk og veileder',
        agents: ['klarsprak__default', 'veileder__default'],
        modes: [],
      }),
    ]);
    expect(removed.status).toBe(204);
    expect(after.data).toEqual([]);
    const actions = (await admin.audit(digdir)).map((a) => a.action);
    expect(actions).toEqual(
      expect.arrayContaining(['platform.keypolicy.save', 'platform.keypolicy.delete']),
    );
  });

  it('requires a change reason on every change', async () => {
    const { send, policies } = await boot();

    const res = await send(policies, 'kari', { body: { name: 'Uten grunn' } });

    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ errors: [{ path: 'change-reason' }] });
  });

  it('refuses a user without manage-services, another tenant and an operator without a support session', async () => {
    const { send, create, policies } = await boot();
    await create({ name: 'Intern' });

    expect((await send(policies, 'bruker')).status).toBe(403);
    expect((await send(policies, 'bruker', { body: { name: 'x' }, reason })).status).toBe(403);
    expect((await send(policies, 'ola')).status).toBe(404);
    expect((await send(policies, 'drift')).status).toBe(404);
  });

  it('keeps one tenant policies out of reach of another', async () => {
    const { send, create } = await boot();
    const made = await json<View>(await create({ name: 'Intern' }));

    const otherList = await json<{ data: View[] }>(
      await send(`/tenants/${other}/api-key-policies`, 'ola'),
    );
    const otherDelete = await send(`/tenants/${other}/api-key-policies/${made.id}`, 'ola', {
      method: 'DELETE',
      reason,
    });

    expect(otherList.data ?? []).toEqual([]);
    expect([403, 404]).toContain(otherDelete.status);
  });

  it('rejects a name that is missing, a scope that does not exist and a config key without a root', async () => {
    const { create } = await boot();

    const noName = await create({ name: ' ' });
    const scope = await create({ name: 'x', scopes: ['root'] });
    const configKey = await create({ name: 'x', allowedConfigKeys: ['default'] });
    const list = await create({ name: 'x', datasets: ['a b'] });

    for (const res of [noName, scope, configKey, list]) expect(res.status).toBe(400);
    expect(await json<{ errors: { path: string }[] }>(noName)).toMatchObject({
      errors: [{ path: 'name' }],
    });
    expect(await json<{ errors: { path: string }[] }>(scope)).toMatchObject({
      errors: [{ path: 'scopes' }],
    });
    expect(await json<{ errors: { path: string }[] }>(configKey)).toMatchObject({
      errors: [{ path: 'allowedConfigKeys' }],
    });
    expect(await json<{ errors: { path: string }[] }>(list)).toMatchObject({
      errors: [{ path: 'datasets' }],
    });
  });

  it('answers 404 when updating or deleting a policy that does not exist', async () => {
    const { send, policies } = await boot();

    const put = await send(`${policies}/finnes-ikke`, 'kari', {
      method: 'PUT',
      body: { name: 'x' },
      reason,
    });
    const del = await send(`${policies}/finnes-ikke`, 'kari', { method: 'DELETE', reason });

    expect([put.status, del.status]).toEqual([404, 404]);
  });

  it('grants the union once a policy is attached, follows edits to the policy and stops on detach', async () => {
    const { send, create, tools, policies } = await boot();
    const made = await json<View>(
      await create({ name: 'Bare klarspråk', agents: ['klarsprak__default'] }),
    );
    const keyPolicy = `/tenants/${digdir}/api-keys/gammel/policy`;

    const before = await tools('gammel');
    const attached = await send(keyPolicy, 'kari', {
      method: 'PUT',
      body: { policyId: made.id },
      reason,
    });
    const narrowed = await tools('gammel');
    await send(`${policies}/${made.id}`, 'kari', {
      method: 'PUT',
      body: { name: 'Begge', agents: ['klarsprak__default', 'veileder__default'] },
      reason,
    });
    const widened = await tools('gammel');
    const detached = await send(keyPolicy, 'kari', { method: 'DELETE', reason });
    const free = await tools('gammel');

    expect(before).toEqual([]);
    expect(attached.status).toBe(200);
    expect(narrowed).toEqual(['klarsprak__default']);
    expect(widened).toEqual(['klarsprak__default', 'veileder__default']);
    expect(detached.status).toBe(200);
    expect(free).toEqual(before);
  });

  it('shows the policy of a key in the key list and lists the keys a policy governs', async () => {
    const { send, create, policies } = await boot();
    const made = await json<View>(await create({ name: 'Intern' }));
    await send(`/tenants/${digdir}/api-keys/gammel/policy`, 'kari', {
      method: 'PUT',
      body: { policyId: made.id },
      reason,
    });

    const access = await json<{ keys: { id: string; policy: string | null }[] }>(
      await send(`/tenants/${digdir}/access`, 'kari'),
    );
    const listed = await json<{ data: View[] }>(await send(policies, 'kari'));

    expect(access.keys.find((k) => k.id === 'gammel')?.policy).toBe(made.id);
    expect(access.keys.find((k) => k.id === 'ny')?.policy).toBeNull();
    expect(listed.data[0]?.keyIds).toEqual(['gammel']);
  });

  it('refuses to attach a policy to a key bound to one service, to an unknown key (404) or to an unknown policy (400)', async () => {
    const { send, create } = await boot();
    const made = await json<View>(await create({ name: 'Intern' }));
    const attach = (key: string, policyId: string) =>
      send(`/tenants/${digdir}/api-keys/${key}/policy`, 'kari', {
        method: 'PUT',
        body: { policyId },
        reason,
      });

    const boundKey = await attach('ny', made.id);
    const noKey = await attach('finnes-ikke', made.id);
    const noPolicy = await attach('gammel', 'finnes-ikke');

    expect(boundKey.status).toBe(400);
    expect(noKey.status).toBe(404);
    expect(noPolicy.status).toBe(400);
  });

  it('refuses to delete a policy that keys still use and says how many', async () => {
    const { send, create, policies } = await boot();
    const made = await json<View>(await create({ name: 'Intern' }));
    await send(`/tenants/${digdir}/api-keys/gammel/policy`, 'kari', {
      method: 'PUT',
      body: { policyId: made.id },
      reason,
    });

    const res = await send(`${policies}/${made.id}`, 'kari', {
      method: 'DELETE',
      reason,
      language: 'en',
    });

    expect(res.status).toBe(409);
    expect(JSON.stringify(await res.json())).toContain('used by 1 key');
  });

  it('answers in the language of the request', async () => {
    const { send, policies } = await boot();

    const en = await json<{ errors: { message: string }[] }>(
      await send(policies, 'kari', { body: { name: '' }, reason, language: 'en' }),
    );
    const nb = await json<{ errors: { message: string }[] }>(
      await send(policies, 'kari', { body: { name: '' }, reason, language: 'nb' }),
    );

    expect(en.errors[0]?.message).toMatch(/name/i);
    expect(nb.errors[0]?.message).toMatch(/navn/i);
    expect(en.errors[0]?.message).not.toBe(nb.errors[0]?.message);
  });
});
