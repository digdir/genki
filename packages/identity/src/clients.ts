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

export const environmentNamePattern = /^[a-z][a-z0-9-]{0,31}$/;

export const environmentName = z
  .string()
  .regex(environmentNamePattern, 'must be a lowercase environment name such as prod or test');

const dnsLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A DNS name in lowercase: no wildcard, no IP address, no port, at most 253 characters. */
export const isHostname = (value: string) => {
  if (value.length > 253) return false;
  const labels = value.split('.');
  const top = labels.at(-1) ?? '';
  return labels.length >= 2 && labels.every((l) => dnsLabel.test(l)) && /^[a-z]{2,63}$/.test(top);
};

export const hostname = z
  .string()
  .refine(isHostname, 'must be a lowercase hostname such as ka.example.no');

export const maxHostnames = 4;

export const hostedOrigin = (name: string) => `https://${name}`;

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
      environments: z.array(environmentName).max(8).optional(),
      kind: z.enum(['server', 'browser']),
      url: webUrl.optional(),
      channels: z.array(z.enum(clientChannels)).min(1),
      allowedOrigins: z.array(origin).default([]),
      oidc: z
        .strictObject({
          clientId: z
            .string({
              error: (issue) =>
                issue.input === undefined
                  ? 'a client id from Ansattporten; a hosted client that leaves out oidc logs in through genki’s platform login, whose resource it takes, so it sets no audience of its own'
                  : undefined,
            })
            .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/, 'must be a client id from Ansattporten'),
          audience: z.string().min(1).optional(),
          redirectUris: z.array(webUrl).min(1),
          postLogoutRedirectUris: z.array(webUrl).default([]),
          secret: slug.optional(),
        })
        .optional(),
      webhook: z
        .strictObject({
          url: webUrl,
          events: z.array(z.enum(webhookEvents)).min(1),
          secret: slug,
        })
        .optional(),
      hosted: z.boolean().optional(),
      hostnames: z
        .array(z.strictObject({ hostname, environment: environmentName.default('prod') }))
        .max(maxHostnames)
        .optional(),
    }),
  })
  .superRefine((client, ctx) => {
    const names = client.spec.hostnames ?? [];
    if (client.spec.hosted) {
      if (client.spec.kind !== 'browser')
        ctx.addIssue({
          code: 'custom',
          path: ['spec', 'hosted'],
          message: 'only a browser client is hosted, since people log in to it',
        });
      if (names.length === 0)
        ctx.addIssue({
          code: 'custom',
          path: ['spec', 'hostnames'],
          message: 'a hosted client needs at least one hostname',
        });
    } else if (names.length > 0)
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'hostnames'],
        message: 'only a hosted client has hostnames',
      });
    if (client.spec.oidc?.secret && !client.spec.hosted)
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'oidc', 'secret'],
        message: 'only a hosted client has a client secret, which genki logs in with',
      });
    if (new Set(names.map((n) => n.hostname)).size !== names.length)
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'hostnames'],
        message: 'a hostname is listed twice',
      });
    const environments = client.spec.environments;
    names.forEach((n, i) => {
      if (environments?.length ? !environments.includes(n.environment) : n.environment !== 'prod')
        ctx.addIssue({
          code: 'custom',
          path: ['spec', 'hostnames', i, 'environment'],
          message: `the client may not use the environment ${n.environment}`,
        });
    });
    if (client.spec.kind !== 'browser') return;
    if (!client.spec.oidc && !client.spec.hosted)
      ctx.addIssue({
        code: 'custom',
        path: ['spec', 'oidc'],
        message:
          'a browser client logs users in, so it needs an OIDC registration unless it is hosted and logs in through genki’s platform login',
      });
    if (client.spec.allowedOrigins.length === 0 && names.length === 0)
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
  const definition = withHostedOrigins(parsed.data);
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

/** A hosted client's origins are its hostnames' origins, kept in step with them. */
const withHostedOrigins = (definition: ClientDefinition): ClientDefinition => {
  if (!definition.spec.hosted) return definition;
  const own = (definition.spec.hostnames ?? []).map((n) => hostedOrigin(n.hostname));
  return { ...definition, spec: { ...definition.spec, allowedOrigins: own } };
};

/** A hosted Client without its own `oidc` logs in through genki's platform login client (ADR 0061). */
export const usesPlatformLogin = (definition: ClientDefinition) =>
  definition.spec.hosted === true && definition.spec.oidc === undefined;

export const oidcAudienceOf = (definition: ClientDefinition) =>
  definition.spec.oidc?.audience ?? definition.spec.oidc?.clientId;

export const confinementOf = (definition: ClientDefinition): Confinement => ({
  tenant: definition.metadata.tenant,
  service: definition.spec.service,
  client: definition.metadata.id,
  ...(definition.spec.environments?.length
    ? { environments: [...new Set(definition.spec.environments)] }
    : {}),
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
