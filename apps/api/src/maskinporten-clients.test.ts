import { beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { createSigningKey, createTokenVerifier, toOrgNo, type SigningKey } from '@genai/identity';
import { createLocalJWKSet, SignJWT } from 'jose';
import type { MaskinportenClientView } from './maskinporten-clients.js';
import { bootPlatform, digdir, other, readJson as json } from './testkit.js';

const MP = 'https://maskinporten.test/';
let key: SigningKey;

beforeAll(async () => {
  key = await createSigningKey('mp');
});

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

const tokenFor = async (clientId: string, org = digdir) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ client_id: clientId, consumer: toOrgNo(org), scope: 'digdir:genai.invoke' })
    .setProtectedHeader({ alg: 'RS256', kid: key.kid })
    .setIssuer(MP)
    .setAudience('digdir:genai')
    .setIssuedAt(now)
    .setExpirationTime(now + 60)
    .sign(key.privateKey);
};

const boot = async () => {
  const booted = await bootPlatform({
    people,
    services: ['veileder', 'klarsprak'],
    maskinportenIssuers: [MP],
    verifier: createTokenVerifier({
      issuers: [
        {
          kind: 'maskinporten',
          issuer: MP,
          audience: 'digdir:genai',
          keys: createLocalJWKSet({ keys: [key.publicJwk] }),
        },
      ],
    }),
  });
  const register = (body: unknown, as = 'kari', headers: Record<string, string> = {}) =>
    booted.send(`/tenants/${digdir}/maskinporten-clients`, as, {
      body,
      reason: 'Saksbehandlingssystemet skal kalle veilederen',
      headers,
    });
  const asClient = async (clientId: string, path: string, body?: unknown, headers = {}) =>
    booted.send(path, await tokenFor(clientId), {
      ...(body === undefined ? {} : { body }),
      headers,
    });
  const mcp = (clientId: string, method: string, params: Record<string, unknown> = {}) =>
    asClient(
      clientId,
      '/api/mcp',
      { jsonrpc: '2.0', id: 1, method, params },
      {
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': method,
        ...(typeof params.name === 'string' ? { 'Mcp-Name': params.name } : {}),
      },
    );
  return { ...booted, register, asClient, mcp };
};

const modelIds = async (response: Response) =>
  (await json<{ data: { id: string }[] }>(response)).data.map((m) => m.id).sort();

describe('Maskinporten clients per tenant', () => {
  it('registers a client for chosen services, lists it and audits the change', async () => {
    const { register, send, admin } = await boot();

    const created = await register({
      clientId: 'sak-123',
      name: 'Saksbehandling',
      services: ['veileder'],
    });
    const listed = await json<{ data: MaskinportenClientView[] }>(
      await send(`/tenants/${digdir}/maskinporten-clients`, 'kari'),
    );

    expect(created.status).toBe(201);
    expect(await created.json()).toMatchObject({
      clientId: 'sak-123',
      name: 'Saksbehandling',
      services: ['veileder'],
      tenant: digdir,
      createdBy: 'employee:test:kari',
    });
    expect(listed.data.map((c) => c.clientId)).toEqual(['sak-123']);
    expect(await admin.audit(digdir)).toContainEqual(
      expect.objectContaining({ action: 'platform.maskinporten-client.save', outcome: 'applied' }),
    );
  });

  it('gives a registered client only its services on /v1, REST and MCP', async () => {
    const { register, asClient, mcp } = await boot();
    await register({ clientId: 'sak-123', name: 'Saksbehandling', services: ['veileder'] });

    const models = await modelIds(await asClient('sak-123', '/v1/models'));
    const tools = await json<{ result: { tools: { name: string }[] } }>(
      await mcp('sak-123', 'tools/list'),
    );
    const openapi = await json<{ paths: Record<string, unknown> }>(
      await asClient('sak-123', '/api/tools/openapi.json'),
    );
    const refused = await asClient('sak-123', '/api/tools/call/klarsprak__default', {
      query: 'Skriv dette enklere',
    });
    const chat = await asClient('sak-123', '/v1/chat/completions', {
      model: 'klarsprak__default',
      messages: [{ role: 'user', content: 'hei' }],
    });

    expect(models).toEqual(['veileder__default']);
    expect(tools.result.tools.map((t) => t.name)).toEqual(['veileder__default']);
    expect(Object.keys(openapi.paths)).toEqual(['/api/tools/call/veileder__default']);
    expect(refused.status).toBe(403);
    expect(chat.status).toBe(403);
  });

  it('gives a client registered for all services every service of the tenant', async () => {
    const { register, asClient } = await boot();
    await register({ clientId: 'alt', name: 'Alt', services: ['*'] });

    expect(await modelIds(await asClient('alt', '/v1/models'))).toEqual([
      'klarsprak__default',
      'veileder__default',
    ]);
  });

  it('refuses an unregistered client of the organisation with client-not-registered', async () => {
    const { asClient, mcp } = await boot();

    for (const response of [
      await asClient('ukjent', '/v1/models'),
      await mcp('ukjent', 'tools/list'),
      await asClient('ukjent', '/api/tools/call/veileder__default', { query: 'hei' }),
    ]) {
      expect(response.status).toBe(403);
      expect(response.headers.get('content-type')).toContain('application/problem+json');
      expect(await response.json()).toMatchObject({
        type: 'urn:genai:problem:client-not-registered',
      });
    }
  });

  it('does not let another organisation use a client id registered by this one', async () => {
    const { register, send } = await boot();
    await register({ clientId: 'sak-123', name: 'Saksbehandling', services: ['*'] });

    const response = await send('/v1/models', await tokenFor('sak-123', other));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      type: 'urn:genai:problem:client-not-registered',
    });
  });

  it('cuts a client off once it is removed', async () => {
    const { register, send, asClient } = await boot();
    await register({ clientId: 'sak-123', name: 'Saksbehandling', services: ['veileder'] });

    const removed = await send(`/tenants/${digdir}/maskinporten-clients/sak-123`, 'kari', {
      method: 'DELETE',
      reason: 'Systemet er faset ut',
    });

    expect(removed.status).toBe(204);
    expect((await asClient('sak-123', '/v1/models')).status).toBe(403);
    expect(
      (
        await send(`/tenants/${digdir}/maskinporten-clients/sak-123`, 'kari', {
          method: 'DELETE',
          reason: 'En gang til',
        })
      ).status,
    ).toBe(404);
  });

  it('needs Administrere tjenester, a reason, known services, and refuses other tenants', async () => {
    const { register, send } = await boot();
    const body = { clientId: 'sak-123', name: 'Saksbehandling', services: ['veileder'] };

    expect((await register(body, 'bruker')).status).toBe(403);
    expect((await register(body, 'ola')).status).toBe(404);
    expect((await register({ ...body, services: ['finnes-ikke'] })).status).toBe(400);
    expect((await register({ ...body, services: ['*', 'veileder'] })).status).toBe(400);
    expect((await send(`/tenants/${digdir}/maskinporten-clients`, 'kari', { body })).status).toBe(
      400,
    );
  });

  it('lets an operator in a support session remove a client but never register one', async () => {
    const { register, send, admin } = await boot();
    await register({ clientId: 'sak-123', name: 'Saksbehandling', services: ['veileder'] });
    const session = await admin.openSupportSession(
      people.drift as Principal,
      digdir,
      'Hjelper virksomheten',
      30,
    );
    const support = { 'support-session': session.ok ? session.value.id : '' };

    const created = await register(
      { clientId: 'drift-1', name: 'Drift', services: ['*'] },
      'drift',
      support,
    );
    const removed = await send(`/tenants/${digdir}/maskinporten-clients/sak-123`, 'drift', {
      method: 'DELETE',
      reason: 'Klienten er kompromittert',
      headers: support,
    });

    expect(created.status).toBe(403);
    expect(removed.status).toBe(204);
  });
});
