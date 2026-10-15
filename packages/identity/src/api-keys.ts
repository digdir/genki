import { createHash } from 'node:crypto';
import type { Confinement, Principal } from '@genai/contracts';
import { admittedCredentialScope, INTERNAL_GRANT_PREFIX } from './claims.js';
import { AuthenticationError, type VerifiedIdentity } from './verify.js';

export const LEGACY_KEY_ISSUER = 'urn:genai:legacy-api-key';

export type LegacyKeyScope = 'query' | 'ingest' | 'admin';

export interface StoredApiKey {
  id: string;
  name: string;
  digest: string;
  tenant?: string;
  scopes: LegacyKeyScope[];
  datasets: string[];
  agents: string[];
  clientId?: string;
  service?: string;
  allowedOverrides?: string[];
  callsPerMinute?: number;
  skillGraphs?: string[];
  allowedConfigKeys?: string[];
  policy?: KeyPolicy;
  admittedInLockdown?: boolean;
  lastUsedAt?: string;
  revokedAt?: string;
  expiresAt?: string;
}

export interface KeyPolicy {
  id: string;
  scopes?: LegacyKeyScope[];
  datasets?: string[];
  agents?: string[];
  skillGraphs?: string[];
  allowedConfigKeys?: string[];
}

export type ConfigRoot = 'platform' | 'runtime' | 'dataset';

export const configKeyGrant = (root: ConfigRoot, key: string) => `${root}:${key}`;

export const ALL_GRANT = '*';

export const SERVICE_GRANT = 'service:';

export const boundService = (key: Pick<StoredApiKey, 'service' | 'agents'>) =>
  key.service ?? key.agents.find((a) => a.startsWith(SERVICE_GRANT))?.slice(SERVICE_GRANT.length);

export interface ApiKeyStore {
  findByDigest(digest: string): Promise<StoredApiKey | undefined>;
  touch?(id: string, at: Date): Promise<void>;
}

export class InMemoryApiKeys implements ApiKeyStore {
  readonly #keys = new Map<string, StoredApiKey>();

  add(key: StoredApiKey): void {
    this.#keys.set(key.digest, structuredClone(key));
  }

  async findByDigest(digest: string) {
    const found = this.#keys.get(digest);
    return found && structuredClone(found);
  }

  async touch(id: string, at: Date) {
    for (const key of this.#keys.values()) if (key.id === id) key.lastUsedAt = at.toISOString();
  }
}

export const apiKeyDigest = (key: string) => createHash('sha256').update(key, 'utf8').digest('hex');

export interface LegacyCredential {
  digest: string;
  prefix?: string;
  lastFour?: string;
}

export const legacyCredential = (stored: {
  digest?: string;
  plaintext?: string;
  prefix?: string;
  lastFour?: string;
}): LegacyCredential | undefined => {
  const plaintext = stored.plaintext || undefined;
  const given = stored.digest?.trim().toLowerCase();
  const digest =
    given && /^[0-9a-f]{64}$/.test(given) ? given : plaintext && apiKeyDigest(plaintext);
  if (!digest) return undefined;
  const prefix = stored.prefix || plaintext?.slice(0, 8);
  const lastFour = stored.lastFour || plaintext?.slice(-4);
  return { digest, ...(prefix ? { prefix } : {}), ...(lastFour ? { lastFour } : {}) };
};

export const OVERRIDE_SCOPE = 'settings:override:';

export const overrideScope = (setting: string) => `${OVERRIDE_SCOPE}${setting}`;

export interface KeyGrants {
  keyId: string;
  scopes: LegacyKeyScope[];
  datasets: string[];
  agents: string[];
  callsPerMinute?: number;
  allowedOverrides?: string[];
  skillGraphs: string[];
  allowedConfigKeys: string[];
}

const AGENT_GRANT_SCOPE = 'grant:agent:';
const DATASET_GRANT_SCOPE = 'grant:dataset:';
const SKILL_GRAPH_GRANT_SCOPE = 'grant:skill-graph:';
const CONFIG_KEY_GRANT_SCOPE = 'grant:config-key:';
export const CLIENT_GRANT_SCOPE = 'grant:client';
export const UNREGISTERED_CLIENT_SCOPE = 'grant:client-unregistered';

export interface KeyIdentity extends VerifiedIdentity {
  grants: KeyGrants;
}

export const verifyApiKey = async (
  store: ApiKeyStore,
  key: string,
  now: Date = new Date(),
): Promise<KeyIdentity> => {
  if (key.length === 0 || key.length > 512)
    throw new AuthenticationError('invalid_token', 'invalid API key');
  const stored = await store.findByDigest(apiKeyDigest(key));
  if (!stored) throw new AuthenticationError('invalid_token', 'invalid API key');
  if (stored.revokedAt) throw new AuthenticationError('invalid_token', 'the API key is revoked');
  if (stored.expiresAt && Date.parse(stored.expiresAt) <= now.getTime())
    throw new AuthenticationError('invalid_token', 'the API key has expired');
  if (!stored.tenant || !/^\d{9}$/.test(stored.tenant))
    throw new AuthenticationError('invalid_token', 'the API key has no tenant');
  await store.touch?.(stored.id, now).catch(() => undefined);
  const union = <T>(fromPolicy: T[] = [], own: T[] = []) => [...new Set([...fromPolicy, ...own])];
  const policy = stored.policy;
  const scopes = union(policy?.scopes, stored.scopes);
  const datasets = union(policy?.datasets, stored.datasets);
  const granted = union(policy?.agents, stored.agents);
  const skillGraphs = union(policy?.skillGraphs, stored.skillGraphs);
  const allowedConfigKeys = union(policy?.allowedConfigKeys, stored.allowedConfigKeys);
  const service = boundService({ ...stored, agents: granted });
  const agents = granted.filter((a) => !a.startsWith(SERVICE_GRANT));
  const everything = service !== undefined;
  const confinedTo: Confinement | undefined = service
    ? { tenant: stored.tenant, service, ...(stored.clientId ? { client: stored.clientId } : {}) }
    : undefined;
  return {
    principal: {
      kind: 'agency-system',
      issuer: LEGACY_KEY_ISSUER,
      subject: stored.id,
      tenant: stored.tenant,
      scopes: [
        ...scopes.map((s) => `legacy:${s}`),
        ...(stored.allowedOverrides ?? []).map(overrideScope),
        ...(everything ? [ALL_GRANT] : agents).map((a) => `${AGENT_GRANT_SCOPE}${a}`),
        ...(everything ? [ALL_GRANT] : datasets).map((d) => `${DATASET_GRANT_SCOPE}${d}`),
        ...skillGraphs.map((g) => `${SKILL_GRAPH_GRANT_SCOPE}${g}`),
        ...allowedConfigKeys.map((k) => `${CONFIG_KEY_GRANT_SCOPE}${k}`),
        ...(stored.admittedInLockdown ? [admittedCredentialScope] : []),
      ],
      ...(stored.clientId ? { client: stored.clientId } : {}),
      ...(confinedTo ? { confinedTo } : {}),
    },
    grants: {
      keyId: stored.id,
      scopes,
      datasets,
      agents,
      skillGraphs,
      allowedConfigKeys,
      ...(stored.callsPerMinute ? { callsPerMinute: stored.callsPerMinute } : {}),
      ...(stored.allowedOverrides ? { allowedOverrides: [...stored.allowedOverrides] } : {}),
    },
  };
};

export const keyAllows = (
  grants: KeyGrants,
  request: { scope: LegacyKeyScope; dataset?: string; agent?: string },
): boolean => {
  if (!grants.scopes.includes(request.scope)) return false;
  const granted = (list: string[], value: string) =>
    list.includes(ALL_GRANT) || list.includes(value);
  if (request.dataset !== undefined && !granted(grants.datasets, request.dataset)) return false;
  if (request.agent !== undefined && !granted(grants.agents, request.agent)) return false;
  return request.dataset !== undefined || request.agent !== undefined;
};

export const isApiKeyPrincipal = (principal: Principal) => principal.issuer === LEGACY_KEY_ISSUER;

export const isGrantedClient = (principal: Principal) =>
  principal.scopes?.includes(CLIENT_GRANT_SCOPE) ?? false;

export const isUnregisteredClient = (principal: Principal) =>
  principal.scopes?.includes(UNREGISTERED_CLIENT_SCOPE) ?? false;

export const clientGrants = (
  principal: Principal,
  services: string[] | undefined,
  admittedInLockdown = false,
): Principal => {
  const own = (principal.scopes ?? []).filter(
    (s) => !s.startsWith(INTERNAL_GRANT_PREFIX) && !s.startsWith('legacy:'),
  );
  if (!services)
    return { ...principal, scopes: [...own, CLIENT_GRANT_SCOPE, UNREGISTERED_CLIENT_SCOPE] };
  return {
    ...principal,
    scopes: [
      ...own,
      'legacy:query',
      CLIENT_GRANT_SCOPE,
      ...services.map((s) => `${AGENT_GRANT_SCOPE}${s}`),
      ...(admittedInLockdown ? [admittedCredentialScope] : []),
    ],
  };
};

export const grantsOf = (principal: Principal): KeyGrants | undefined => {
  if (!isApiKeyPrincipal(principal) && !isGrantedClient(principal)) return undefined;
  const scopes = principal.scopes ?? [];
  const after = (prefix: string) =>
    scopes.filter((s) => s.startsWith(prefix)).map((s) => s.slice(prefix.length));
  return {
    keyId: principal.subject,
    scopes: after('legacy:') as LegacyKeyScope[],
    agents: after(AGENT_GRANT_SCOPE),
    datasets: after(DATASET_GRANT_SCOPE),
    skillGraphs: after(SKILL_GRAPH_GRANT_SCOPE),
    allowedConfigKeys: after(CONFIG_KEY_GRANT_SCOPE),
  };
};

export const isBoundToServices = (principal: Principal): boolean => {
  if (principal.confinedTo?.service !== undefined) return true;
  const agents = grantsOf(principal)?.agents ?? [];
  return agents.length > 0 && agents.every((a) => /^[a-z0-9][a-z0-9-]*$/.test(a));
};

const shortMode = (mode: string) => mode.slice(mode.lastIndexOf('/') + 1);

export const capabilityModes = (capabilityId: string, names: string[]) => [
  ...new Set([
    ...names.flatMap((n) => (n.includes('__') ? [n.slice(n.indexOf('__') + 2)] : [])),
    ...(capabilityId.split('/')[2] ? [capabilityId.split('/')[2] as string] : []),
  ]),
];

export const keyReachesMode = (principal: Principal, modes: string[]): boolean => {
  const granted = grantsOf(principal)?.skillGraphs ?? [];
  if (granted.length === 0) return true;
  return modes.some((m) => granted.some((g) => shortMode(g) === shortMode(m)));
};

export const configKeyAllows = (
  principal: Principal,
  root: ConfigRoot,
  keys: string[],
): boolean => {
  const granted = (grantsOf(principal)?.allowedConfigKeys ?? []).filter((k) =>
    k.startsWith(`${root}:`),
  );
  if (granted.length === 0) return true;
  return keys.some((k) => granted.includes(configKeyGrant(root, k)));
};

export const keyReaches = (
  principal: Principal,
  scope: LegacyKeyScope,
  target: { agents?: string[]; datasets?: string[] },
): boolean => {
  const grants = grantsOf(principal);
  if (!grants) return true;
  const any = (names: string[] | undefined, field: 'agent' | 'dataset') =>
    names === undefined || names.some((name) => keyAllows(grants, { scope, [field]: name }));
  return (
    grants.scopes.includes(scope) && any(target.agents, 'agent') && any(target.datasets, 'dataset')
  );
};
