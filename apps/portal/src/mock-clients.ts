import type { AuditRow } from './api';
import type { ClientSpec, ClientView, HostnameView, ServiceKeyView } from './types';

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

const at = (now: Date, hours: number, minutes: number) => {
  const d = new Date(now);
  d.setHours(hours, minutes, 0, 0);
  return d.toISOString();
};

const exampleTeamsBot = (now = new Date()): ClientView => ({
  definition: {
    apiVersion: 'genai/v1',
    kind: 'Client',
    metadata: { tenant: '999888777', id: 'teams-bot', name: 'Teams-bot' },
    spec: {
      service: 'rapportassistenten',
      kind: 'server',
      channels: ['rest', 'feedback'],
      allowedOrigins: [],
      webhook: {
        url: 'https://teams-bot.testetaten.example.no/genki',
        secret: 'teams-bot-webhook',
        events: ['task.completed'],
      },
    },
  },
  version: 1,
  updatedAt: '2026-10-20T09:00:00Z',
  updatedBy: 'employee:ansattporten:ola',
  deliveries: [
    { id: 'd-teams-1', event: 'task.completed', at: at(now, 14, 5), ok: true, status: 200 },
  ],
});

const serviceKey = (key: Partial<ServiceKeyView> & Pick<ServiceKeyView, 'id' | 'name'>) => ({
  prefix: 'gp_mock',
  lastFour: '3f2a',
  scopes: ['query'],
  datasets: [],
  agents: [],
  createdAt: null,
  expiresAt: null,
  revokedAt: null,
  service: 'rapportassistenten',
  client: null,
  lastUsedAt: null,
  rotatedFrom: null,
  allowedOverrides: [],
  ...key,
});

export const exampleServiceKeys = (now = new Date()): ServiceKeyView[] => [
  serviceKey({
    id: 'saksbehandling',
    name: 'Saksbehandling',
    environments: ['prod'],
    allowedOverrides: ['answers.writtenStandard'],
    createdAt: '2026-11-01T09:00:00Z',
    createdBy: 'employee:ansattporten:ola',
    createdByName: 'Ola Hansen',
    rotatedFrom: 'skey-saksbehandling',
    lastUsedAt: at(now, 13, 51),
  }),
  serviceKey({
    id: 'skey-saksbehandling',
    name: 'Saksbehandling',
    environments: ['prod'],
    allowedOverrides: ['answers.writtenStandard'],
    createdAt: '2026-10-14T08:00:00Z',
    createdBy: 'employee:ansattporten:ola',
    createdByName: 'Ola Hansen',
    revokedAt: '2026-11-01T09:00:00Z',
  }),
  serviceKey({
    id: 'skey-intranett',
    name: 'Intranett-chat',
    client: 'intranettet',
    environments: ['prod', 'test'],
    createdAt: '2026-10-02T11:00:00Z',
    createdBy: 'employee:ansattporten:kari',
    createdByName: 'Kari Nordmann',
    lastUsedAt: at(now, 14, 7),
  }),
  serviceKey({
    id: 'skey-intranett-server',
    name: 'Intranett-server, gammel',
    allowedOverrides: ['answers.writtenStandard', 'retrieval.retrieveTopK'],
    createdAt: '2026-08-20T10:00:00Z',
    createdBy: 'employee:ansattporten:kari',
    createdByName: 'Kari Nordmann',
    lastUsedAt: '2026-09-15T12:00:00Z',
  }),
  serviceKey({
    id: 'skey-pilot-hr',
    name: 'Pilot HR',
    environments: ['test'],
    createdAt: '2026-06-02T10:00:00Z',
    createdBy: 'employee:ansattporten:ola',
    createdByName: 'Ola Hansen',
    lastUsedAt: '2026-09-29T14:00:00Z',
    revokedAt: '2026-09-30T08:00:00Z',
  }),
];

export const exampleKeyAudit: AuditRow[] = [
  {
    task: 'audit-key-pilot-hr',
    tenant: '999888777',
    action: 'platform.apikeys.revoke',
    actor: 'employee:ansattporten:ola',
    actorName: 'Ola Hansen',
    at: '2026-09-30T08:00:00Z',
    outcome: 'applied',
    target: 'api-key:999888777/skey-pilot-hr',
    reason: 'Piloten er over',
  },
];

const example = import.meta.env.MODE !== 'test';

export const clientMock = (
  initial: ClientView[] = example ? [...exampleClients, exampleTeamsBot()] : exampleClients,
  initialKeys: ServiceKeyView[] = example ? exampleServiceKeys() : [],
) => {
  let clients = structuredClone(initial);
  let keys: ServiceKeyView[] = structuredClone(initialKeys);
  let hostnames: HostnameView[] = [];
  const hostnameOf = (
    client: string,
    hostname: string,
    fields: Partial<HostnameView>,
  ): HostnameView => ({
    id: `claim-${hostnames.length + 1}`,
    hostname,
    client,
    environment: 'prod',
    redirectTo: null,
    apex: false,
    assigned: false,
    managed: false,
    state: 'pending-dns',
    failure: null,
    records: [],
    checkedAt: null,
    createdAt: '2026-10-07T12:00:00Z',
    ...fields,
  });

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
          openai: [
            'GET /v1/models',
            'GET /v1/sessions',
            'POST /v1/chat/completions',
            'POST /v1/tasks/{task}/cancel',
            'GET /v1/tasks/{task}/media/{id}',
          ],
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
      if (spec.kind === 'browser' && spec.allowedOrigins.length === 0 && !spec.hosted)
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
    const ofService = /^\/tenants\/([^/]+)\/services\/([^/]+)\/(hostnames|address)$/.exec(path);
    if (ofService) {
      const [, tenant = '', service = ''] = ofService;
      const hosted = () =>
        clients.find(
          (c) =>
            c.definition.metadata.tenant === tenant &&
            c.definition.spec.service === service &&
            c.definition.spec.hosted,
        );
      if (ofService[3] === 'hostnames' && method === 'GET') {
        const client = hosted()?.definition.metadata.id ?? null;
        return reply({
          client,
          hostnames: hostnames.filter((h) => h.client === client),
          assigns: true,
        });
      }
      if (ofService[3] === 'address' && method === 'POST') {
        if (needsReason()) return invalid('change-reason', 'a reason is required');
        const id = hosted()?.definition.metadata.id ?? `${service}-host`;
        if (!hosted())
          clients.push({
            definition: {
              apiVersion: 'genai/v1',
              kind: 'Client',
              metadata: { tenant, id },
              spec: {
                service,
                kind: 'browser',
                channels: ['openai'],
                allowedOrigins: [],
                hosted: true,
                hostnames: [],
              },
            },
            version: 1,
            updatedAt: '2026-10-07T12:00:00Z',
            updatedBy: 'platform:hostnames',
            deliveries: [],
          });
        const claim = hostnameOf(id, `${service}.apps.genki-test.digdir.cloud`, {
          assigned: true,
          state: 'binding',
        });
        hostnames.push(claim);
        return reply(claim, 201);
      }
    }
    const claims = /^\/tenants\/([^/]+)\/clients\/([^/]+)\/hostnames(?:\/([^/]+))?$/.exec(path);
    if (claims && method === 'POST') {
      if (needsReason()) return invalid('change-reason', 'a reason is required');
      const hostname = String(body().hostname ?? '').toLowerCase();
      if (hostname.endsWith('digdir.cloud'))
        return invalid('hostname', `hostname_not_allowed: ${hostname} is under a reserved domain`);
      const claim = hostnameOf(claims[2] ?? '', hostname, {
        records: [
          { type: 'TXT', name: `_genki-challenge.${hostname}`, value: 'eksempel-token' },
          { type: 'TXT', name: `asuid.${hostname}`, value: 'EKSEMPEL0123456789' },
          { type: 'CNAME', name: hostname, value: 'genki-assistant.example.azurecontainerapps.io' },
        ],
      });
      hostnames.push(claim);
      return reply(claim, 201);
    }
    if (claims && method === 'DELETE') {
      if (needsReason()) return invalid('change-reason', 'a reason is required');
      const found = hostnames.find(
        (h) => h.client === claims[2] && h.hostname === decodeURIComponent(claims[3] ?? ''),
      );
      if (!found) return invalid('id', 'no such hostname');
      hostnames = hostnames.filter((h) => h !== found);
      return reply({ ...found, state: 'removed' });
    }
    const test = /^\/tenants\/([^/]+)\/clients\/([^/]+)\/webhook\/test$/.exec(path);
    if (test && method === 'POST')
      return reply({ id: 'd1', event: 'ping', at: '2026-10-07T12:00:00Z', ok: true, status: 200 });
    const serviceKeys = /^\/tenants\/([^/]+)\/services\/([^/]+)\/api-keys$/.exec(path);
    if (serviceKeys && method === 'GET')
      return reply({ keys: keys.filter((k) => k.service === serviceKeys[2]) });
    if (serviceKeys && method === 'POST') {
      if (needsReason()) return invalid('change-reason', 'a reason is required');
      const input = body() as {
        name?: string;
        client?: string;
        allowedOverrides?: string[];
        environments?: string[];
      };
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
        environments: input.environments ?? [],
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
        createdAt: new Date().toISOString(),
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
