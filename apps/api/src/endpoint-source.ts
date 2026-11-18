import { isIP } from 'node:net';
import { z } from 'zod';

export const endpointNotAllowedType = 'urn:genai:problem:endpoint-not-allowed';
export const endpointSourceEngine = 'http-search';

export const endpointSource = z.strictObject({
  url: z
    .url({ protocol: /^https$/ })
    .max(2000)
    .describe('The search address; POST with {query, limit, filters?} answers {hits, found?}'),
  auth: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('none') }),
    z.strictObject({
      kind: z.literal('api-key'),
      header: z
        .string()
        .regex(/^[A-Za-z0-9-]{1,64}$/)
        .optional()
        .describe('The header that carries the key; default authorization as a bearer token'),
      apiKey: z.string().min(1).max(4096).describe('Write-only: kept in the vault, never shown'),
    }),
  ]),
});
export type EndpointSource = z.infer<typeof endpointSource>;

export type HostNetwork = 'public' | 'private' | 'blocked' | 'unknown';

export interface EndpointSourceDeps {
  network(host: string): Promise<{ network: HostNetwork; allowed: boolean }>;
  setSecret(tenant: string, name: string, value: string, hosts: readonly string[]): Promise<void>;
  deleteSecret(tenant: string, name: string): Promise<void>;
  secretNames(tenant: string): Promise<string[]>;
}

const reservedNames = /(^|\.)(localhost|local|internal|localdomain|home\.arpa)$/i;

/** Why genki will not call the address, or undefined when it is a public https host. */
export const endpointRefusal = async (
  raw: string,
  network: EndpointSourceDeps['network'],
): Promise<string | undefined> => {
  const url = new URL(raw);
  if (url.protocol !== 'https:') return 'only https addresses';
  if (url.username || url.password) return 'no user name or password in the address';
  if (url.hash || url.search) return 'no query or fragment in the address';
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) return 'a host name, not an IP address';
  if (reservedNames.test(host) || !host.includes('.')) return `${host} is not a public host name`;
  const found = await network(host).catch(() => ({ network: 'unknown' as const, allowed: false }));
  if (found.network !== 'public') return `${host} does not resolve to a public address`;
  return undefined;
};

export const endpointSourceId = (dataset: string) => `endpoint-${dataset}`.slice(0, 63);

export const endpointSourceSecret = (dataset: string) => `endpoint-${dataset}-key`.slice(0, 63);

/** The tenant's knowledge connection for the source, with the key named by its vault reference. */
export const endpointSourceConnection = (
  tenant: string,
  dataset: string,
  source: EndpointSource,
) => {
  const url = new URL(source.url);
  return {
    engine: endpointSourceEngine,
    baseURL: url.origin,
    options: { searchPath: url.pathname === '/' ? '/search' : url.pathname },
    ...(source.auth.kind === 'api-key'
      ? {
          auth: {
            kind: 'api-key',
            secret: `secret://tenant/${tenant}/${endpointSourceSecret(dataset)}`,
            ...(source.auth.header ? { header: source.auth.header } : {}),
          },
        }
      : {}),
  };
};
