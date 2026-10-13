import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { InMemoryDefinitionStore, SettingsRegistry } from '@genai/definitions';
import { createAuthenticator } from '@genai/identity';
import { envSecrets } from '@genai/kernel';
import { createAdmin } from './admin.js';
import { createPlatform } from './composition.js';
import { InMemoryTenantApiKeys } from './routes/portal-routes.js';
import { digdir, files, klarsprak, other, plugins, principals } from './testkit.js';
import { SIGNATURE_HEADER, verifyWebhookSignature } from './webhooks.js';

const ka = (spec: Record<string, unknown> = {}) => ({
  metadata: { name: 'Klarspråk-appen' },
  spec: {
    service: 'klarsprak',
    kind: 'browser',
    url: 'http://localhost:5177',
    channels: ['openai', 'mcp'],
    allowedOrigins: ['http://localhost:5177'],
    oidc: { clientId: 'klarsprak-web', redirectUris: ['http://localhost:5177/callback'] },
    ...spec,
  },
});

const boot = async () => {
  const keys = new InMemoryTenantApiKeys();
  const keyAuth = createAuthenticator({ apiKeys: keys });
  const hooks: { url: string; headers: Record<string, string>; body: string }[] = [];
  const platform = await createPlatform({
    catalogs: {
      models: { endpoints: {}, models: [] },
      knowledge: { endpoints: {}, datasets: [] },
      rerank: { endpoints: {}, rerankers: [] },
    },
    secrets: envSecrets({}),
    definitions: (p) => new InMemoryDefinitionStore({ ...p, models: plugins.models }),
    policy: { decide: async () => ({ allow: true }) },
    apiKeys: keys,
    reservedClientIds: ['local-portal'],
    webhookSend: async (url, init) => {
      hooks.push({ url, headers: init.headers, body: init.body });
      return { status: 200 };
    },
    authenticate: async (request) => {
      const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
      const person = principals[bearer];
      if (person) return { principal: person };
      const found = await keyAuth.authenticate(request);
      return (
        found && {
          principal: found.principal,
          ...(found.principal.confinedTo ? { externalUsers: true } : {}),
        }
      );
    },
  });
  for (const id of ['klarsprak', 'nynorsk'])
    expect((await platform.definitions.publish(klarsprak({ id }), 'test', 'test', files)).ok).toBe(
      true,
    );
  const admin = createAdmin({
    store: platform.definitions,
    plugins: platform.plugins,
    settings: new SettingsRegistry([]),
    extensions: platform.extensions,
  });
  const app = new Hono();
  platform.mount(app, admin);
  const call = (
    path: string,
    init: {
      method?: string;
      as?: string;
      key?: string;
      body?: unknown;
      headers?: Record<string, string>;
    } = {},
  ) =>
    app.request(path, {
      method: init.method ?? 'GET',
      headers: {
        'content-type': 'application/json',
        'change-reason': 'Kobler til egen frontend',
        ...(init.as ? { authorization: `Bearer ${init.as}` } : {}),
        ...(init.key ? { 'x-api-key': init.key } : {}),
        ...init.headers,
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
  return { platform, admin, call, hooks };
};

const json = async <T = Record<string, unknown>>(res: Response) => (await res.json()) as T;

describe('clients for a service', () => {
  it('registers, lists, changes and removes a client, with validation', async () => {
    const { call } = await boot();
    const saved = await call(`/tenants/${digdir}/clients/klarsprak-web`, {
      method: 'PUT',
      as: 'kari',
      body: ka(),
    });
    expect(saved.status).toBe(200);
    expect(await json(saved)).toMatchObject({ version: 1, definition: { kind: 'Client' } });

    const listed = await json<{ clients: unknown[]; endpoints: Record<string, string[]> }>(
      await call(`/tenants/${digdir}/clients?service=klarsprak`, { as: 'kari' }),
    );
    expect(listed.clients).toHaveLength(1);
    expect(listed.endpoints.mcp).toEqual(['POST /api/mcp']);

    const invalid = await call(`/tenants/${digdir}/clients/klarsprak-web`, {
      method: 'PUT',
      as: 'kari',
      body: ka({ oidc: undefined }),
    });
    expect(invalid.status).toBe(400);
    const unknown = await call(`/tenants/${digdir}/clients/x`, {
      method: 'PUT',
      as: 'kari',
      body: ka({ service: 'finnes-ikke', oidc: undefined, kind: 'server' }),
    });
    expect((await json<{ errors: { path: string }[] }>(unknown)).errors[0]?.path).toBe(
      'spec.service',
    );
    const reserved = await call(`/tenants/${digdir}/clients/y`, {
      method: 'PUT',
      as: 'kari',
      body: ka({ oidc: { clientId: 'local-portal', redirectUris: ['http://localhost:5177/cb'] } }),
    });
    expect(reserved.status).toBe(400);
    expect(
      (await call(`/tenants/${digdir}/clients/z`, { method: 'PUT', as: 'ola', body: ka() })).status,
    ).toBe(404);
    expect(
      (await call(`/tenants/${digdir}/clients/klarsprak-web`, { method: 'DELETE', as: 'kari' }))
        .status,
    ).toBe(200);
  });

  it('answers CORS preflights only for origins a client allows', async () => {
    const { call } = await boot();
    await call(`/tenants/${digdir}/clients/klarsprak-web`, {
      method: 'PUT',
      as: 'kari',
      body: ka(),
    });
    const allowed = await call('/api/mcp', {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:5177', 'access-control-request-method': 'POST' },
    });
    expect(allowed.status).toBe(204);
    expect(allowed.headers.get('access-control-allow-origin')).toBe('http://localhost:5177');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('authorization');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('genai-acting-for');
    expect(allowed.headers.get('access-control-allow-headers')).toContain('genai-version');

    const stranger = await call('/api/mcp', {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(stranger.headers.get('access-control-allow-origin')).toBeNull();

    const real = await call('/v1/models', {
      as: 'kari',
      headers: { origin: 'http://localhost:5177' },
    });
    expect(real.status).toBe(200);
    expect(real.headers.get('access-control-allow-origin')).toBe('http://localhost:5177');

    const admin = await call(`/tenants/${digdir}/overview`, {
      as: 'kari',
      headers: { origin: 'http://localhost:5177' },
    });
    expect(admin.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('operator access to tenant frontends', () => {
  it('needs a support session, in which an operator may also change a client', async () => {
    const { admin, call } = await boot();
    const operator = principals.operator as Principal;
    const opened = await admin.openSupportSession(operator, digdir, 'feilsøking', 30);
    const session = opened.ok ? (opened.value as { id: string }).id : '';
    const inSession = { 'support-session': session };

    expect((await call(`/tenants/${digdir}/clients`, { as: 'operator' })).status).toBe(404);
    expect(
      (await call(`/tenants/${digdir}/clients`, { as: 'operator', headers: inSession })).status,
    ).toBe(200);
    expect(
      (
        await call(`/tenants/${digdir}/clients/klarsprak-web`, {
          method: 'PUT',
          as: 'operator',
          headers: inSession,
          body: ka(),
        })
      ).status,
    ).toBeLessThan(300);
  });

  it('never lets an operator create or rotate a service key, even in a support session', async () => {
    const { admin, call } = await boot();
    const operator = principals.operator as Principal;
    const opened = await admin.openSupportSession(operator, digdir, 'feilsøking', 30);
    const inSession = {
      'support-session': opened.ok ? (opened.value as { id: string }).id : '',
      'change-reason': 'Feilsøking',
    };

    const created = await call(`/tenants/${digdir}/services/klarsprak/api-keys`, {
      method: 'POST',
      as: 'operator',
      headers: inSession,
      body: { name: 'Bakdør' },
    });
    const own = await json<{ apiKey: { id: string } }>(
      await call(`/tenants/${digdir}/services/klarsprak/api-keys`, {
        method: 'POST',
        as: 'kari',
        body: { name: 'Backend' },
      }),
    );
    const rotated = await call(`/tenants/${digdir}/api-keys/${own.apiKey.id}/rotate`, {
      method: 'POST',
      as: 'operator',
      headers: inSession,
    });

    expect(created.status).toBe(403);
    expect(rotated.status).toBe(403);
  });
});

describe('change reasons on frontend routes', () => {
  it('decodes a URI-encoded reason before it is audited', async () => {
    const { call, admin } = await boot();
    const reason = 'Endring – «test» ’ æøå';
    const saved = await call(`/tenants/${digdir}/clients/klarsprak-web`, {
      method: 'PUT',
      as: 'kari',
      body: ka(),
      headers: { 'change-reason': encodeURIComponent(reason) },
    });

    expect(saved.status).toBe(200);
    const task = saved.headers.get('genai-task') ?? '';
    const events = await admin.events(task);
    expect(events.find((e) => e.type === 'x.platform.change')?.data).toMatchObject({ reason });
  });
});

describe('service-scoped API keys', () => {
  const models = async (call: Awaited<ReturnType<typeof boot>>['call'], key: string) =>
    (await json<{ data: { id: string }[] }>(await call('/v1/models', { key }))).data.map(
      (m) => m.id,
    );

  it('reaches only its service, only channel routes, and shows when it was used', async () => {
    const { call } = await boot();
    const created = await call(`/tenants/${digdir}/services/klarsprak/api-keys`, {
      method: 'POST',
      as: 'kari',
      body: { name: 'Backend' },
    });
    expect(created.status).toBe(201);
    const { key, apiKey } = await json<{ key: string; apiKey: { service: string } }>(created);
    expect(apiKey.service).toBe('klarsprak');

    expect(await models(call, key)).toEqual(['klarsprak__default']);
    expect((await call(`/tenants/${digdir}/overview`, { key })).status).toBe(401);
    expect((await call(`/tenants/${digdir}/services/klarsprak/api-keys`, { key })).status).toBe(
      401,
    );

    const listed = await json<{ keys: { lastUsedAt: string | null }[] }>(
      await call(`/tenants/${digdir}/services/klarsprak/api-keys`, { as: 'kari' }),
    );
    expect(listed.keys).toHaveLength(1);
    expect(listed.keys[0]?.lastUsedAt).not.toBeNull();
  });

  it('keeps tenant keys reaching every service', async () => {
    const { call } = await boot();
    const { key } = await json<{ key: string }>(
      await call(`/tenants/${digdir}/api-keys`, {
        method: 'POST',
        as: 'kari',
        body: { name: 'Gammel' },
      }),
    );
    expect((await models(call, key)).sort()).toEqual(['klarsprak__default', 'nynorsk__default']);
  });

  it('limits a key bound to a client to that client channels', async () => {
    const { call } = await boot();
    await call(`/tenants/${digdir}/clients/klarsprak-web`, {
      method: 'PUT',
      as: 'kari',
      body: ka({ kind: 'server', oidc: undefined, channels: ['mcp'] }),
    });
    const { key } = await json<{ key: string }>(
      await call(`/tenants/${digdir}/services/klarsprak/api-keys`, {
        method: 'POST',
        as: 'kari',
        body: { name: 'BFF', client: 'klarsprak-web' },
      }),
    );
    expect((await call('/v1/models', { key })).status).toBe(401);
    const wrong = await call(`/tenants/${digdir}/services/nynorsk/api-keys`, {
      method: 'POST',
      as: 'kari',
      body: { name: 'Feil', client: 'klarsprak-web' },
    });
    expect(wrong.status).toBe(400);
  });

  it('rotates a key: the old one stops, the new one keeps the binding', async () => {
    const { call } = await boot();
    const first = await json<{ key: string; apiKey: { id: string } }>(
      await call(`/tenants/${digdir}/services/klarsprak/api-keys`, {
        method: 'POST',
        as: 'kari',
        body: { name: 'Backend' },
      }),
    );
    const rotated = await call(`/tenants/${digdir}/api-keys/${first.apiKey.id}/rotate`, {
      method: 'POST',
      as: 'kari',
    });
    expect(rotated.status).toBe(201);
    const second = await json<{ key: string; apiKey: { service: string; rotatedFrom: string } }>(
      rotated,
    );
    expect(second.apiKey).toMatchObject({ service: 'klarsprak', rotatedFrom: first.apiKey.id });
    expect((await call('/v1/models', { key: first.key })).status).toBe(401);
    expect(await models(call, second.key)).toEqual(['klarsprak__default']);
    expect(
      (
        await call(`/tenants/${other}/api-keys/${first.apiKey.id}/rotate`, {
          method: 'POST',
          as: 'ola',
        })
      ).status,
    ).toBe(404);
  });
});

describe('allowed overrides on service keys', () => {
  it('stores the chosen overrides, drops invalid ones, and replaces them on rotation', async () => {
    const { call } = await boot();
    const created = await json<{ apiKey: { id: string; allowedOverrides: string[] } }>(
      await call(`/tenants/${digdir}/services/klarsprak/api-keys`, {
        method: 'POST',
        as: 'kari',
        body: { name: 'Backend', allowedOverrides: ['retrieval.*', 'not a key!'] },
      }),
    );
    expect(created.apiKey.allowedOverrides).toEqual(['retrieval.*']);

    const kept = await json<{ apiKey: { id: string; allowedOverrides: string[] } }>(
      await call(`/tenants/${digdir}/api-keys/${created.apiKey.id}/rotate`, {
        method: 'POST',
        as: 'kari',
      }),
    );
    expect(kept.apiKey.allowedOverrides).toEqual(['retrieval.*']);

    const replaced = await json<{ apiKey: { id: string; allowedOverrides: string[] } }>(
      await call(`/tenants/${digdir}/api-keys/${kept.apiKey.id}/rotate`, {
        method: 'POST',
        as: 'kari',
        body: { allowedOverrides: ['answer.language'] },
      }),
    );
    expect(replaced.apiKey.allowedOverrides).toEqual(['answer.language']);
    const listed = await json<{ keys: { id: string; allowedOverrides: string[] }[] }>(
      await call(`/tenants/${digdir}/services/klarsprak/api-keys`, { as: 'kari' }),
    );
    expect(listed.keys.find((k) => k.id === replaced.apiKey.id)?.allowedOverrides).toEqual([
      'answer.language',
    ]);
  });
});

describe('client webhooks through the API', () => {
  it('sends a signed test delivery with the secret from the tenant secrets', async () => {
    const { call, platform, hooks } = await boot();
    platform.vault.set(digdir, 'klarsprak-hook', 'whsec-verdi');
    await call(`/tenants/${digdir}/clients/klarsprak-web`, {
      method: 'PUT',
      as: 'kari',
      body: ka({
        webhook: {
          url: 'https://hooks.example.no/ka',
          events: ['task.completed'],
          secret: 'klarsprak-hook',
        },
      }),
    });
    const res = await call(`/tenants/${digdir}/clients/klarsprak-web/webhook/test`, {
      method: 'POST',
      as: 'kari',
    });
    expect(await json(res)).toMatchObject({ ok: true, event: 'ping' });
    const [hook] = hooks;
    expect(
      verifyWebhookSignature(
        'whsec-verdi',
        hook?.headers[SIGNATURE_HEADER] ?? '',
        hook?.body ?? '',
      ),
    ).toBe(true);
  });

  it('audits a webhook test with its change reason, and sends nothing without one', async () => {
    const { call, admin, hooks, platform } = await boot();
    platform.vault.set(digdir, 'klarsprak-hook', 'whsec-verdi');
    const saved = await call(`/tenants/${digdir}/clients/klarsprak-web`, {
      method: 'PUT',
      as: 'kari',
      body: ka({
        webhook: {
          url: 'https://hooks.example.no/ka',
          events: ['task.completed'],
          secret: 'klarsprak-hook',
        },
      }),
    });
    expect(saved.status).toBe(200);
    const path = `/tenants/${digdir}/clients/klarsprak-web/webhook/test`;

    const silent = await call(path, {
      method: 'POST',
      as: 'kari',
      headers: { 'change-reason': '' },
    });
    const sent = await call(path, { method: 'POST', as: 'kari' });

    expect(silent.status).toBe(400);
    expect(sent.status).toBe(200);
    expect(hooks).toHaveLength(1);
    const entry = (await admin.audit(digdir)).find(
      (a) => a.action === 'platform.clients.webhook-test',
    );
    expect(entry).toMatchObject({
      outcome: 'applied',
      target: `client:${digdir}/klarsprak-web`,
      reason: 'Kobler til egen frontend',
      task: sent.headers.get('genai-task'),
    });
  });
});

describe('missing clients and keys', () => {
  it('answers 404 for an unknown client delete, an unknown key revoke or rotate, and a revoked key rotate', async () => {
    const { call } = await boot();
    const created = await json<{ apiKey: { id: string } }>(
      await call(`/tenants/${digdir}/services/klarsprak/api-keys`, {
        method: 'POST',
        as: 'kari',
        body: { name: 'Backend' },
      }),
    );
    const revoke = (id: string) =>
      call(`/tenants/${digdir}/api-keys/${id}/revoke`, { method: 'POST', as: 'kari', body: {} });
    const rotate = (id: string) =>
      call(`/tenants/${digdir}/api-keys/${id}/rotate`, { method: 'POST', as: 'kari', body: {} });

    const removed = await call(`/tenants/${digdir}/clients/finnes-ikke`, {
      method: 'DELETE',
      as: 'kari',
    });
    const unknownRevoke = await revoke('finnes-ikke');
    const unknownRotate = await rotate('finnes-ikke');
    expect((await revoke(created.apiKey.id)).status).toBe(200);
    const revokedRotate = await rotate(created.apiKey.id);

    expect([
      removed.status,
      unknownRevoke.status,
      unknownRotate.status,
      revokedRotate.status,
    ]).toEqual([404, 404, 404, 404]);
  });
});

export type { Principal };
