import { isIP } from 'node:net';
import type { JSONSchema } from '@genai/contracts';
import { z } from 'zod';
import { isPrivateAddress } from './ranges.js';
import { assertTenantSecret, tenantSecretPattern } from './secrets.js';

const slug = z.string().regex(/^[a-z0-9][a-z0-9-]{0,62}$/);

export const connectionProtocols = ['mcp', 'a2a', 'openapi'] as const;
export type ConnectionProtocol = (typeof connectionProtocols)[number];

const httpsUrl = z.url({ protocol: /^https$/ });
const secretRef = z.string().regex(tenantSecretPattern);

export const connectionInput = z.strictObject({
  id: slug,
  tenant: z.string().regex(/^\d{9}$/),
  name: z.string().min(1),
  protocol: z.enum(connectionProtocols).optional(),
  endpoint: httpsUrl,
  version: z.string().regex(/^\d+(?:\.\d+){0,2}$/),
  allow: z
    .array(
      z.strictObject({
        host: z.string().min(1),
        port: z.number().int().min(1).max(65535).optional(),
      }),
    )
    .min(1),
  auth: z
    .discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('bearer'), secret: secretRef }),
      z.strictObject({
        kind: z.literal('header'),
        header: z.string().regex(/^[A-Za-z0-9-]+$/),
        secret: secretRef,
      }),
      z.strictObject({
        kind: z.literal('oauth-client-credentials'),
        tokenUrl: httpsUrl,
        clientId: z.string().min(1).max(200),
        scope: z.string().max(500).optional(),
        secret: secretRef,
      }),
    ])
    .optional(),
  timeoutMs: z.number().int().min(100).max(60_000).optional(),
  maxResponseBytes: z
    .number()
    .int()
    .min(1024)
    .max(10 * 1024 * 1024)
    .optional(),
  document: z.string().max(2_000_000).optional(),
  documentUrl: httpsUrl.optional(),
  operations: z.array(z.string().min(1).max(200)).max(200).optional(),
  writes: z.boolean().optional(),
});

export type Connection = z.infer<typeof connectionInput>;

export interface PinnedTool {
  remoteName: string;
  name: string;
  description: string;
  input: JSONSchema;
  call?: Record<string, unknown>;
}

export const protocolOf = (connection: Connection): ConnectionProtocol =>
  connection.protocol ?? 'mcp';

const onAllowlist = (connection: Connection, target: string) => {
  const url = new URL(target);
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const port = url.port ? Number(url.port) : 443;
  return connection.allow.some((a) => a.host.toLowerCase() === host && (a.port ?? 443) === port);
};

export interface ConnectionState {
  connection: Connection;
  tools: PinnedTool[];
  pending: PinnedTool[];
}

export class RegistrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RegistrationError';
  }
}

export const validateConnection = (input: unknown): Connection => {
  const parsed = connectionInput.safeParse(input);
  if (!parsed.success)
    throw new RegistrationError(
      parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`).join('; '),
    );
  const connection = parsed.data;
  if (!onAllowlist(connection, connection.endpoint))
    throw new RegistrationError('the endpoint must be on the allowlist');
  if (connection.documentUrl && !onAllowlist(connection, connection.documentUrl))
    throw new RegistrationError('the document address must be on the allowlist');
  if (
    connection.auth?.kind === 'oauth-client-credentials' &&
    !onAllowlist(connection, connection.auth.tokenUrl)
  )
    throw new RegistrationError('the token address must be on the allowlist');
  const protocol = protocolOf(connection);
  if (protocol === 'openapi' && !connection.document && !connection.documentUrl)
    throw new RegistrationError('an OpenAPI connection needs a document or a document address');
  if (
    protocol !== 'openapi' &&
    (connection.document ||
      connection.documentUrl ||
      connection.operations ||
      connection.writes !== undefined)
  )
    throw new RegistrationError('document, operations and writes are only for OpenAPI connections');
  for (const entry of connection.allow) {
    const allowed = entry.host.replace(/^\[|\]$/g, '');
    if (isIP(allowed) && isPrivateAddress(allowed))
      throw new RegistrationError(`${entry.host} is a private address`);
    if (/^(localhost|.*\.localhost|.*\.internal|.*\.local)$/i.test(allowed))
      throw new RegistrationError(`${entry.host} is not a public host`);
  }
  if (connection.auth) {
    try {
      assertTenantSecret(connection.auth.secret, connection.tenant);
    } catch (error) {
      throw new RegistrationError((error as Error).message);
    }
  }
  return connection;
};

export interface ConnectionRegistry {
  register(input: unknown): Promise<Connection>;
  get(tenant: string, id: string): Promise<ConnectionState | undefined>;
  list(tenant: string): Promise<ConnectionState[]>;
  save(state: ConnectionState): Promise<void>;
}

export class InMemoryConnections implements ConnectionRegistry {
  readonly #states = new Map<string, ConnectionState>();

  #key(tenant: string, id: string) {
    return `${tenant}/${id}`;
  }

  async register(input: unknown): Promise<Connection> {
    const connection = validateConnection(input);
    const key = this.#key(connection.tenant, connection.id);
    if (this.#states.has(key)) throw new RegistrationError(`connection ${connection.id} exists`);
    this.#states.set(key, { connection, tools: [], pending: [] });
    return structuredClone(connection);
  }

  async get(tenant: string, id: string) {
    const state = this.#states.get(this.#key(tenant, id));
    return state && structuredClone(state);
  }

  async list(tenant: string) {
    return [...this.#states.values()]
      .filter((s) => s.connection.tenant === tenant)
      .map((s) => structuredClone(s));
  }

  async save(state: ConnectionState) {
    this.#states.set(
      this.#key(state.connection.tenant, state.connection.id),
      structuredClone(state),
    );
  }
}
