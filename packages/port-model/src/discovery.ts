import type { DiscoveredDeployment } from './adapter.js';

export interface SeenDeployment extends DiscoveredDeployment {
  firstSeenAt: string;
  lastSeenAt: string;
}

export const listingErrorKinds = [
  'unauthorized',
  'not-found',
  'rate-limited',
  'provider-error',
  'timeout',
  'unreachable',
  'misconfigured',
  'error',
] as const;
export type ListingErrorKind = (typeof listingErrorKinds)[number];

export interface DiscoveryListing {
  connection: string;
  source: string;
  deployments: SeenDeployment[];
  target?: string;
  listedAt?: string;
  failedAt?: string;
  errorKind?: ListingErrorKind;
}

export interface DiscoveredModelStore {
  load(): Promise<DiscoveryListing[]>;
  /** Replaces one listing with what `change` makes of the stored one, with no other writer in between. */
  update(
    connection: string,
    source: string,
    change: (current: DiscoveryListing | undefined) => DiscoveryListing,
  ): Promise<DiscoveryListing>;
  /** True for the one caller that claims `name` when its last claim is at least `everyMs` before `at`. */
  claim(name: string, at: Date, everyMs: number): Promise<boolean>;
}

export const defaultDiscoveryGraceMs = 24 * 60 * 60 * 1000;

export const listingKey = (source: string, connection: string) => `${source}:${connection}`;

export const emptyListing = (connection: string, source: string): DiscoveryListing => ({
  connection,
  source,
  deployments: [],
});

export const listingTarget = (baseURL: string) => {
  const url = new URL(baseURL);
  return `${url.origin}${url.pathname}`;
};

const sameTarget = (current: DiscoveryListing | undefined, target: string | undefined) =>
  current && (current.target === undefined || current.target === target) ? current : undefined;

export const listedNow = (
  stored: DiscoveryListing | undefined,
  key: { connection: string; source: string },
  found: DiscoveredDeployment[],
  at: Date,
  graceMs: number,
  target?: string,
): DiscoveryListing => {
  const current = sameTarget(stored, target);
  const stamp = at.toISOString();
  const before = new Map((current?.deployments ?? []).map((d) => [d.deployment, d]));
  const seen = new Map<string, SeenDeployment>();
  for (const deployment of found)
    if (!seen.has(deployment.deployment))
      seen.set(deployment.deployment, {
        ...deployment,
        firstSeenAt: before.get(deployment.deployment)?.firstSeenAt ?? stamp,
        lastSeenAt: stamp,
      });
  const kept = [...before.values()].filter(
    (d) => !seen.has(d.deployment) && at.getTime() - Date.parse(d.lastSeenAt) < graceMs,
  );
  return {
    ...(current ?? emptyListing(key.connection, key.source)),
    ...key,
    deployments: [...seen.values(), ...kept].sort((a, b) =>
      a.deployment.localeCompare(b.deployment),
    ),
    ...(target ? { target } : {}),
    listedAt: stamp,
  };
};

export const failedNow = (
  stored: DiscoveryListing | undefined,
  key: { connection: string; source: string },
  kind: ListingErrorKind,
  at: Date,
  target?: string,
): DiscoveryListing => ({
  ...(sameTarget(stored, target) ?? {
    ...emptyListing(key.connection, key.source),
    ...(target ? { target } : {}),
  }),
  failedAt: at.toISOString(),
  errorKind: kind,
});

export class ListingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ListingError';
  }
}

export class ListingMisconfigured extends Error {
  override name = 'ListingMisconfigured';
}

export const listingErrorKind = (error: unknown): ListingErrorKind => {
  if (error instanceof ListingMisconfigured) return 'misconfigured';
  const status = error instanceof ListingError ? error.status : undefined;
  if (status === 401 || status === 403) return 'unauthorized';
  if (status === 404) return 'not-found';
  if (status === 429) return 'rate-limited';
  if (status !== undefined && status >= 500) return 'provider-error';
  if (error instanceof ListingError) return 'error';
  const name = error instanceof Error ? error.name : '';
  if (name === 'TimeoutError' || name === 'AbortError') return 'timeout';
  if (error instanceof TypeError) return 'unreachable';
  return 'error';
};

export const inMemoryDiscoveredModels = (): DiscoveredModelStore => {
  const listings = new Map<string, DiscoveryListing>();
  const claims = new Map<string, number>();
  return {
    load: async () => structuredClone([...listings.values()]),
    update: async (connection, source, change) => {
      const key = listingKey(source, connection);
      const current = listings.get(key);
      const next = change(current ? structuredClone(current) : undefined);
      listings.set(key, structuredClone(next));
      return structuredClone(next);
    },
    claim: async (name, at, everyMs) => {
      const last = claims.get(name);
      if (last !== undefined && at.getTime() - last < everyMs) return false;
      claims.set(name, at.getTime());
      return true;
    },
  };
};
