import { beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '@genai/contracts';
import { createLocalJWKSet } from 'jose';
import {
  apiKeyDigest,
  channelOf,
  checkClient,
  confinedPolicy,
  createAuthenticator,
  createMockAnsattporten,
  createSigningKey,
  createTokenVerifier,
  InMemoryApiKeys,
  InMemoryClients,
  keyGrantPolicy,
  LEGACY_KEY_ISSUER,
  oidcAudienceOf,
  originAllowed,
  verifyApiKey,
  type ClientDefinition,
  type RegisteredClient,
  type SigningKey,
  type StoredClient,
} from './index.js';

const ISSUER = 'http://ansattporten.test';
const PLATFORM = 'digdir:genai';
const RESOURCE = 'urn:altinn:resource:digdir-genai-platform';
const DIGDIR = '991825827';
const NAV = '889640782';

const ka = (overrides: Partial<ClientDefinition['spec']> = {}): Record<string, unknown> => ({
  apiVersion: 'genai/v1',
  kind: 'Client',
  metadata: { tenant: DIGDIR, id: 'ka-web', name: 'Kunnskapsassistenten' },
  spec: {
    service: 'kunnskapsassistenten',
    kind: 'browser',
    url: 'http://localhost:5177',
    channels: ['mcp', 'conversations'],
    allowedOrigins: ['http://localhost:5177'],
    oidc: { clientId: 'ka-local', redirectUris: ['http://localhost:5177/callback'] },
    ...overrides,
  },
});

const stored = (definition: unknown): StoredClient => {
  const checked = checkClient(definition, []);
  if (!checked.ok) throw new Error(JSON.stringify(checked.errors));
  return { definition: checked.definition, version: 1, updatedAt: '', updatedBy: 'test' };
};

describe('client definitions', () => {
  it('accepts a browser client with origins and an OIDC registration', () => {
    const checked = checkClient(ka(), []);
    expect(checked.ok).toBe(true);
    if (checked.ok) expect(oidcAudienceOf(checked.definition)).toBe('ka-local');
  });

  it('requires OIDC and origins for browser clients', () => {
    const checked = checkClient(ka({ oidc: undefined, allowedOrigins: [] }), []);
    expect(checked.ok ? [] : checked.errors.map((e) => e.path)).toEqual([
      'spec.oidc',
      'spec.allowedOrigins',
    ]);
  });

  it('lets a server client go without OIDC or origins', () => {
    expect(checkClient(ka({ kind: 'server', oidc: undefined, allowedOrigins: [] }), []).ok).toBe(
      true,
    );
  });

  it('refuses origins with paths, plain http outside localhost and unknown channels', () => {
    const checked = checkClient(
      ka({
        allowedOrigins: ['https://app.example.no/path', 'http://app.example.no'],
        channels: ['mcp', 'telepathy' as never],
      }),
      [],
    );
    expect(checked.ok ? [] : checked.errors.map((e) => e.path)).toEqual([
      'spec.channels.1',
      'spec.allowedOrigins.0',
      'spec.allowedOrigins.1',
    ]);
  });

  it('refuses an OIDC client id another client has registered', () => {
    const other = stored({ ...ka(), metadata: { tenant: NAV, id: 'nav-web' } });
    const checked = checkClient(ka(), [other]);
    expect(checked.ok ? [] : checked.errors).toEqual([
      { path: 'spec.oidc.clientId', message: 'client id ka-local is registered already' },
    ]);
    expect(checkClient(ka(), [stored(ka())]).ok).toBe(true);
  });

  it('maps request paths to channels', () => {
    expect(channelOf('/api/mcp')).toBe('mcp');
    expect(channelOf('/v1/chat/completions')).toBe('openai');
    expect(channelOf('/api/tools/call/search')).toBe('rest');
    expect(channelOf('/api/conversations/abc')).toBe('conversations');
    expect(channelOf('/tasks/t1/feedback')).toBe('feedback');
    expect(channelOf('/api/facets')).toBe('facets');
    expect(channelOf('/tenants/991825827/overview')).toBeUndefined();
  });

  it('allows an origin only when a client lists it', async () => {
    const clients = new InMemoryClients();
    await clients.save(stored(ka()));
    const all = await clients.list();
    expect(originAllowed(all, 'http://localhost:5177')).toBe(true);
    expect(originAllowed(all, 'http://localhost:5178')).toBe(false);
  });
});

describe('tokens issued to tenant-registered clients', () => {
  let key: SigningKey;
  let mock: ReturnType<typeof createMockAnsattporten>;
  const registered: RegisteredClient = {
    clientId: 'ka-local',
    audience: 'ka-local',
    tenant: DIGDIR,
    service: 'kunnskapsassistenten',
    client: 'ka-web',
  };

  beforeAll(async () => {
    key = await createSigningKey('mock-clients');
    mock = createMockAnsattporten({
      issuer: ISSUER,
      key,
      testData: {
        persons: [
          {
            pid: '01017012345',
            name: 'Kari Testansatt',
            parties: [{ orgno: DIGDIR, name: 'Digdir', resources: { [RESOURCE]: ['read'] } }],
          },
          {
            pid: '04047012345',
            name: 'Erik Larsen',
            parties: [{ orgno: NAV, name: 'NAV', resources: { [RESOURCE]: ['read'] } }],
          },
        ],
        clients: [
          {
            clientId: 'local-portal',
            redirectUris: ['http://localhost:5175/callback'],
            audience: PLATFORM,
          },
        ],
      },
    });
    mock.clients.register({
      clientId: 'ka-local',
      redirectUris: ['http://localhost:5177/callback'],
      audience: 'ka-local',
      audiences: [PLATFORM],
    });
  });

  const verifier = (clients: RegisteredClient[] = [registered]) =>
    createTokenVerifier({
      issuers: [
        {
          kind: 'ansattporten',
          issuer: ISSUER,
          audience: PLATFORM,
          keys: createLocalJWKSet({ keys: [key.publicJwk] }),
          registeredClients: {
            byClientId: async (id) => clients.find((c) => c.clientId === id),
          },
        },
      ],
    });

  it('trusts the registered audience and confines the person to the client service', async () => {
    const tokens = await mock.testTokens('01017012345', 'ka-local', [RESOURCE]);
    const { principal } = await verifier().verify(tokens.access_token);
    expect(principal).toMatchObject({
      kind: 'employee',
      tenant: DIGDIR,
      client: 'ka-local',
      confinedTo: { tenant: DIGDIR, service: 'kunnskapsassistenten', client: 'ka-web' },
    });
  });

  it('refuses the client audience once the registration is gone', async () => {
    const tokens = await mock.testTokens('01017012345', 'ka-local', [RESOURCE]);
    await expect(verifier([]).verify(tokens.access_token)).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('refuses a token whose client id does not own the audience', async () => {
    const tokens = await mock.testTokens('01017012345', 'ka-local', [RESOURCE]);
    const other = { ...registered, clientId: 'someone-else' };
    await expect(verifier([other]).verify(tokens.access_token)).rejects.toMatchObject({
      code: 'invalid_token',
    });
  });

  it('refuses a person without rights for the client tenant', async () => {
    const tokens = await mock.testTokens('04047012345', 'ka-local', [RESOURCE]);
    await expect(verifier().verify(tokens.access_token)).rejects.toMatchObject({
      code: 'not_authorized_for_org',
    });
  });

  it('still trusts the platform audience for platform clients, unconfined', async () => {
    const tokens = await mock.testTokens('01017012345', 'local-portal', [RESOURCE]);
    const { principal } = await verifier().verify(tokens.access_token);
    expect(principal.confinedTo).toBeUndefined();
  });

  it('keeps a confined login from switching organisation', async () => {
    const tokens = await mock.testTokens('01017012345', 'ka-local', [RESOURCE]);
    const auth = createAuthenticator({ verifier: verifier() });
    const result = await auth.check(
      new Request('http://api.test/api/mcp', {
        headers: { authorization: `Bearer ${tokens.access_token}`, 'genai-acting-for': NAV },
      }),
    );
    expect(result).toMatchObject({ ok: false, status: 403 });
  });
});

describe('service-scoped API keys', () => {
  const base = {
    name: 'KA backend',
    tenant: DIGDIR,
    scopes: ['query' as const],
    datasets: [],
  };

  it('confines a key bound to a service, and records when it was used', async () => {
    const keys = new InMemoryApiKeys();
    keys.add({
      ...base,
      id: 'k1',
      digest: apiKeyDigest('gp_one'),
      agents: [],
      service: 'kunnskapsassistenten',
      clientId: 'ka-web',
      allowedOverrides: ['retrieve-top-k'],
    });
    const at = new Date('2026-10-07T10:00:00Z');
    const verified = await verifyApiKey(keys, 'gp_one', at);
    expect(verified.principal.confinedTo).toEqual({
      tenant: DIGDIR,
      service: 'kunnskapsassistenten',
      client: 'ka-web',
    });
    expect(verified.grants.allowedOverrides).toEqual(['retrieve-top-k']);
    expect((await keys.findByDigest(apiKeyDigest('gp_one')))?.lastUsedAt).toBe(at.toISOString());
  });

  it('reads a service binding stored as a grant, and hides the grant', async () => {
    const keys = new InMemoryApiKeys();
    keys.add({ ...base, id: 'k2', digest: apiKeyDigest('gp_two'), agents: ['service:nynorsk'] });
    const verified = await verifyApiKey(keys, 'gp_two');
    expect(verified.principal.confinedTo).toEqual({ tenant: DIGDIR, service: 'nynorsk' });
    expect(verified.grants.agents).toEqual([]);
  });

  it('leaves tenant keys unconfined', async () => {
    const keys = new InMemoryApiKeys();
    keys.add({ ...base, id: 'k3', digest: apiKeyDigest('gp_three'), agents: [] });
    expect((await verifyApiKey(keys, 'gp_three')).principal.confinedTo).toBeUndefined();
  });
});

describe('confined policy', () => {
  const allowAll = confinedPolicy({ decide: async () => ({ allow: true }) });
  const confined: Principal = {
    kind: 'agency-system',
    issuer: 'urn:genai:legacy-api-key',
    subject: 'k1',
    tenant: DIGDIR,
    confinedTo: { tenant: DIGDIR, service: 'kunnskapsassistenten' },
  };
  const capability = (id: string) => ({ kind: 'capability', id, tenant: id.split('/')[0] ?? '' });

  it('lets a confined principal invoke only its own service', async () => {
    expect(
      await allowAll.decide(
        confined,
        'invoke',
        capability(`${DIGDIR}/kunnskapsassistenten/default`),
      ),
    ).toEqual({ allow: true });
    expect(
      (await allowAll.decide(confined, 'invoke', capability(`${DIGDIR}/nynorsk/default`))).allow,
    ).toBe(false);
    expect(
      (await allowAll.decide(confined, 'invoke', capability(`${NAV}/kunnskapsassistenten/default`)))
        .allow,
    ).toBe(false);
  });

  it('refuses a confined principal acting for another tenant', async () => {
    expect(
      (
        await allowAll.decide(
          { ...confined, tenant: NAV },
          'invoke',
          capability(`${DIGDIR}/kunnskapsassistenten/default`),
        )
      ).allow,
    ).toBe(false);
  });

  it('passes unconfined principals to the inner policy', async () => {
    const free: Principal = { ...confined };
    delete free.confinedTo;
    expect((await allowAll.decide(free, 'invoke', capability(`${NAV}/x/default`))).allow).toBe(
      true,
    );
  });
});

describe('key grant policy', () => {
  const allowAll = keyGrantPolicy({ decide: async () => ({ allow: true }) }, (ref) => [
    ref.id,
    `${ref.id.split('/')[1]}__default`,
  ]);
  const key = (scopes: string[]): Principal => ({
    kind: 'agency-system',
    issuer: LEGACY_KEY_ISSUER,
    subject: 'k1',
    tenant: DIGDIR,
    scopes: ['legacy:query', ...scopes],
  });
  const capability = (id: string) => ({ kind: 'capability', id, tenant: DIGDIR });

  it('refuses a key the services it is not granted', async () => {
    const scoped = key(['grant:agent:ki-veilederen__default']);
    expect(
      (await allowAll.decide(scoped, 'invoke', capability(`${DIGDIR}/ki-veilederen/default`)))
        .allow,
    ).toBe(true);
    expect(
      (await allowAll.decide(scoped, 'invoke', capability(`${DIGDIR}/klarsprak/default`))).allow,
    ).toBe(false);
  });

  it('refuses a key with no grants every service', async () => {
    expect(
      (await allowAll.decide(key([]), 'invoke', capability(`${DIGDIR}/klarsprak/default`))).allow,
    ).toBe(false);
  });

  it('leaves people and other actions to the inner policy', async () => {
    const person: Principal = { kind: 'employee', issuer: 'test', subject: 'kari', tenant: DIGDIR };
    expect(
      (await allowAll.decide(person, 'invoke', capability(`${DIGDIR}/klarsprak/default`))).allow,
    ).toBe(true);
    expect(
      (await allowAll.decide(key([]), 'read', { kind: 'task', id: 't1', tenant: DIGDIR })).allow,
    ).toBe(true);
  });
});
