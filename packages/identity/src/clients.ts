import type { Confinement } from '@genai/contracts';
import { z } from 'zod';

export const clientChannels = [
  'mcp',
  'openai',
  'rest',
  'conversations',
  'feedback',
  'facets',
] as const;
export type ClientChannel = (typeof clientChannels)[number];

export const webhookEvents = ['task.completed', 'feedback.received'] as const;
export type WebhookEvent = (typeof webhookEvents)[number];

const localHost = /^(localhost|127\.0\.0\.1|\[::1\])$/;

const webUrl = z.url().refine(
  (value) => {
    const url = new URL(value);
    return url.protocol === 'https:' || (url.protocol === 'http:' && localHost.test(url.hostname));
  },
  { message: 'must use https, or http on localhost' },
);

const origin = z.string().refine(
  (value) => {
    try {
      const url = new URL(value);
      return (
        url.origin === value &&
        (url.protocol === 'https:' || (url.protocol === 'http:' && localHost.test(url.hostname)))
      );
    } catch {
      return false;
    }
  },
  { message: 'must be an origin like https://app.example.no, without a path' },
);

const slug = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,62}$/, 'must be lowercase letters, digits and dashes');

export const clientDefinition = z
  .strictObject({
    apiVersion: z.literal('genai/v1'),
    kind: z.literal('Client'),
    metadata: z.strictObject({
      tenant: z.string().regex(/^\d{9}$/, 'must be a nine-digit organisation number'),
      id: slug,
      name: z.string().min(1).optional(),
    }),
    spec: z.strictObject({
      service: slug,
      kind: z.enum(['server', 'browser']),
      url: webUrl.optional(),
      channels: z.array(z.enum(clientChannels)).min(1),
      allowedOrigins: z.array(origin).default([]),
      oidc: z
        .strictObject({
          clientId: z
            .string()
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/, 'must be a client id from Ansattporten'),
          audience: z.string().min(1).optional(),
          redirectUris: z.array(webUrl).min(1),
          postLogoutRedirectUris: z.array(webUrl).default([]),
        })
        .optional(),
      webhook: z
        .strictObject({
          url: webUrl,
          events: z.array(z.enum(webhookEvents)).min(1),
          secret: slug,
        })
        .optional(),
    }),
  })
  .superRefine((client, ctx) => {
    if (client.spec.kind !== 'browser') return;
    if (!client.spec.oidc)
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'oidc'],
        message: 'a browser client logs users in, so it needs an OIDC registration',
      });
    if (client.spec.allowedOrigins.length === 0)
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'allowedOrigins'],
        message: 'a browser client needs at least one allowed origin',
      });
  });

export type ClientDefinition = z.output<typeof clientDefinition>;

export interface StoredClient {
  definition: ClientDefinition;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface ClientStore {
  list(tenant?: string): Promise<StoredClient[]>;
  get(tenant: string, id: string): Promise<StoredClient | undefined>;
  save(client: StoredClient): Promise<void>;
  remove(tenant: string, id: string): Promise<boolean>;
}

const clientKey = (tenant: string, id: string) => `${tenant}/${id}`;

export class InMemoryClients implements ClientStore {
  readonly #clients = new Map<string, StoredClient>();

  async list(tenant?: string) {
    return [...this.#clients.values()]
      .filter((c) => tenant === undefined || c.definition.metadata.tenant === tenant)
      .map((c) => structuredClone(c));
  }

  async get(tenant: string, id: string) {
    const found = this.#clients.get(clientKey(tenant, id));
    return found && structuredClone(found);
  }

  async save(client: StoredClient) {
    const { tenant, id } = client.definition.metadata;
    this.#clients.set(clientKey(tenant, id), structuredClone(client));
  }

  async remove(tenant: string, id: string) {
    return this.#clients.delete(clientKey(tenant, id));
  }
}

export interface ClientIssue {
  path: string;
  message: string;
}

export type CheckedClient =
  { ok: true; definition: ClientDefinition } | { ok: false; errors: ClientIssue[] };

export const checkClient = (
  input: unknown,
  others: StoredClient[],
  reservedClientIds: string[] = [],
): CheckedClient => {
  const parsed = clientDefinition.safeParse(input);
  if (!parsed.success)
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({
        path: i.path.map(String).join('.'),
        message: i.message,
      })),
    };
  const definition = parsed.data;
  const { tenant, id } = definition.metadata;
  const clientId = definition.spec.oidc?.clientId;
  const taken = clientId
    ? others.find(
        (o) =>
          o.definition.spec.oidc?.clientId === clientId &&
          clientKey(o.definition.metadata.tenant, o.definition.metadata.id) !==
            clientKey(tenant, id),
      )
    : undefined;
  if (clientId && reservedClientIds.includes(clientId))
    return {
      ok: false,
      errors: [{ path: 'spec.oidc.clientId', message: `client id ${clientId} is reserved` }],
    };
  return taken
    ? {
        ok: false,
        errors: [
          { path: 'spec.oidc.clientId', message: `client id ${clientId} is registered already` },
        ],
      }
    : { ok: true, definition };
};

export const oidcAudienceOf = (definition: ClientDefinition) =>
  definition.spec.oidc?.audience ?? definition.spec.oidc?.clientId;

export const confinementOf = (definition: ClientDefinition): Confinement => ({
  tenant: definition.metadata.tenant,
  service: definition.spec.service,
  client: definition.metadata.id,
});

export const channelOf = (pathname: string): ClientChannel | undefined => {
  const path = pathname;
  if (path === '/api/mcp') return 'mcp';
  if (path.startsWith('/v1/')) return 'openai';
  if (path.startsWith('/api/tools/')) return 'rest';
  if (path === '/api/conversations' || path.startsWith('/api/conversations/'))
    return 'conversations';
  if (path === '/api/feedback' || /^\/tasks\/[^/]+\/feedback$/.test(path)) return 'feedback';
  if (path === '/api/facets' || path === '/api/datasets' || path.startsWith('/api/datasets/'))
    return 'facets';
  return undefined;
};

export const originAllowed = (clients: StoredClient[], origin: string) =>
  clients.some((c) => c.definition.spec.allowedOrigins.includes(origin));

export interface WebhookDelivery {
  id: string;
  tenant: string;
  client: string;
  event: WebhookEvent | 'ping';
  at: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface WebhookDeliveryStore {
  record(delivery: WebhookDelivery): Promise<void>;
  recent(tenant: string, client: string, limit: number): Promise<WebhookDelivery[]>;
}

export class InMemoryWebhookDeliveries implements WebhookDeliveryStore {
  readonly #deliveries = new Map<string, WebhookDelivery[]>();

  constructor(private readonly keep = 50) {}

  async record(delivery: WebhookDelivery) {
    const key = clientKey(delivery.tenant, delivery.client);
    this.#deliveries.set(
      key,
      [structuredClone(delivery), ...(this.#deliveries.get(key) ?? [])].slice(0, this.keep),
    );
  }

  async recent(tenant: string, client: string, limit: number) {
    return (this.#deliveries.get(clientKey(tenant, client)) ?? [])
      .slice(0, limit)
      .map((d) => structuredClone(d));
  }
}
