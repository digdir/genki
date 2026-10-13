import type { ClientSpec, ClientView, ServiceKeyView } from './types';

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

const invalid = (path: string, message: string) =>
  reply({ title: 'Invalid request', status: 400, errors: [{ path, message }] }, 400);

export const exampleClients: ClientView[] = [
  {
    definition: {
      apiVersion: 'genai/v1',
      kind: 'Client',
      metadata: { tenant: '999888777', id: 'intranettet', name: 'Intranettet' },
      spec: {
        service: 'rapportassistenten',
        kind: 'browser',
        url: 'https://intranett.testetaten.example.no',
        channels: ['openai', 'conversations', 'feedback'],
        allowedOrigins: ['https://intranett.testetaten.example.no'],
        oidc: {
          clientId: 'testetaten-intranett',
          redirectUris: ['https://intranett.testetaten.example.no/ki/callback'],
        },
      },
    },
    version: 2,
    updatedAt: '2026-10-02T13:10:00Z',
    updatedBy: 'employee:ansattporten:kari',
    deliveries: [],
  },
];

const mockKey = 'gp_mocktjeneste_4b1d9e2a7c3f';

export const clientMock = (initial: ClientView[] = exampleClients) => {
  let clients = structuredClone(initial);
  let keys: ServiceKeyView[] = [];

  return (path: string, url: URL, init: RequestInit | undefined, needsReason: () => boolean) => {
    const method = init?.method ?? 'GET';
    const body = () => JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    const list = /^\/tenants\/([^/]+)\/clients$/.exec(path);
    if (list && method === 'GET') {
      const service = url.searchParams.get('service');
      return reply({
        clients: clients.filter(
          (c) =>
            c.definition.metadata.tenant === list[1] &&
            (!service || c.definition.spec.service === service),
        ),
        endpoints: {
          mcp: ['POST /api/mcp'],
          openai: ['GET /v1/models', 'POST /v1/chat/completions'],
          rest: ['GET /api/tools/openapi.json', 'POST /api/tools/call/{tool}'],
          conversations: ['GET /api/conversations', 'POST /api/conversations'],
          feedback: ['POST /api/feedback'],
          facets: ['GET /api/facets', 'GET /api/datasets'],
        },
        oidc: {
          issuer: 'https://test.ansattporten.no',
          audience: 'digdir:genai',
          altinnResource: 'urn:altinn:resource:digdir-genai-platform',
        },
      });
    }
    const one = /^\/tenants\/([^/]+)\/clients\/([^/]+)$/.exec(path);
    if (one && method === 'PUT') {
      if (needsReason()) return invalid('change-reason', 'a reason is required');
      const input = body() as { metadata?: { name?: string }; spec?: ClientSpec };
      const spec = input.spec;
      if (!spec) return invalid('spec', 'a spec is required');
      if (spec.kind === 'browser' && !spec.oidc)
        return invalid(
          'spec.oidc',
          'a browser client logs users in, so it needs an OIDC registration',
        );
      if (spec.kind === 'browser' && spec.allowedOrigins.length === 0)
        return invalid('spec.allowedOrigins', 'a browser client needs at least one allowed origin');
      const [, tenant = '', id = ''] = one;
      const before = clients.find(
        (c) => c.definition.metadata.tenant === tenant && c.definition.metadata.id === id,
      );
      const saved: ClientView = {
        definition: {
          apiVersion: 'genai/v1',
          kind: 'Client',
          metadata: { tenant, id, ...(input.metadata?.name ? { name: input.metadata.name } : {}) },
          spec,
        },
        version: (before?.version ?? 0) + 1,
        updatedAt: '2026-10-07T12:00:00Z',
        updatedBy: 'employee:ansattporten:kari',
        deliveries: before?.deliveries ?? [],
      };
      clients = [...clients.filter((c) => c !== before), saved];
      return reply(saved);
    }
    if (one && method === 'DELETE') {
      if (needsReason()) return invalid('change-reason', 'a reason is required');
      clients = clients.filter((c) => c.definition.metadata.id !== one[2]);
      return reply({ id: one[2] });
    }
    const test = /^\/tenants\/([^/]+)\/clients\/([^/]+)\/webhook\/test$/.exec(path);
    if (test && method === 'POST')
      return reply({ id: 'd1', event: 'ping', at: '2026-10-07T12:00:00Z', ok: true, status: 200 });
    const serviceKeys = /^\/tenants\/([^/]+)\/services\/([^/]+)\/api-keys$/.exec(path);
    if (serviceKeys && method === 'GET')
      return reply({ keys: keys.filter((k) => k.service === serviceKeys[2]) });
    if (serviceKeys && method === 'POST') {
      if (needsReason()) return invalid('change-reason', 'a reason is required');
      const input = body() as { name?: string; client?: string; allowedOverrides?: string[] };
      if (!input.name) return invalid('name', 'a name is required');
      const apiKey: ServiceKeyView = {
        id: `skey-${keys.length + 1}`,
        name: input.name,
        prefix: mockKey.slice(0, 7),
        lastFour: mockKey.slice(-4),
        scopes: ['query'],
        datasets: [],
        agents: [],
        createdAt: '2026-10-07T12:00:00Z',
        expiresAt: null,
        revokedAt: null,
        service: serviceKeys[2] ?? null,
        client: input.client ?? null,
        lastUsedAt: null,
        rotatedFrom: null,
        allowedOverrides: input.allowedOverrides ?? [],
      };
      keys = [apiKey, ...keys];
      return reply({ key: mockKey, apiKey }, 201);
    }
    const rotate = /^\/tenants\/[^/]+\/api-keys\/([^/]+)\/rotate$/.exec(path);
    if (rotate && method === 'POST') {
      const old = keys.find((k) => k.id === rotate[1] && !k.revokedAt);
      if (!old) return invalid('id', 'no active key with that id');
      const chosen = (body() as { allowedOverrides?: string[] }).allowedOverrides;
      const apiKey = {
        ...old,
        id: `${old.id}-r`,
        rotatedFrom: old.id,
        lastUsedAt: null,
        allowedOverrides: chosen ?? old.allowedOverrides,
      };
      keys = [apiKey, ...keys.map((k) => (k === old ? { ...k, revokedAt: apiKey.createdAt } : k))];
      return reply({ key: `${mockKey}r`, apiKey }, 201);
    }
    const revoke = /^\/tenants\/[^/]+\/api-keys\/([^/]+)\/revoke$/.exec(path);
    const revoked = revoke && keys.find((k) => k.id === revoke[1]);
    if (revoked && method === 'POST') {
      if (needsReason()) return invalid('change-reason', 'a reason is required');
      const after = { ...revoked, revokedAt: '2026-10-07T12:00:00Z' };
      keys = keys.map((k) => (k === revoked ? after : k));
      return reply(after);
    }
    return undefined;
  };
};
