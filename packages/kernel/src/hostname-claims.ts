export const hostnameClaimStates = [
  'pending-dns',
  'binding',
  'active',
  'failed',
  'lapsed',
  'removing',
  'removed',
] as const;
export type HostnameClaimState = (typeof hostnameClaimStates)[number];

export const heldClaimStates: readonly HostnameClaimState[] = ['binding', 'active', 'removing'];

export const binderSteps = ['add', 'certificate', 'enable', 'unbind', 'done'] as const;
export type BinderStep = (typeof binderSteps)[number];

export interface DnsCheck {
  at: string;
  challenge: boolean;
  asuid: boolean;
  target: boolean;
}

export interface HostnameClaim {
  id: string;
  tenant: string;
  client: string;
  service: string;
  hostname: string;
  environment?: string;
  redirectTo?: string;
  apex: boolean;
  assigned: boolean;
  zone?: string;
  recordName?: string;
  token: string;
  state: HostnameClaimState;
  step: BinderStep;
  failure?: string;
  message?: string;
  certificateId?: string;
  check?: DnsCheck;
  missingSince?: string;
  stateSince: string;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  version: number;
}

export type ClaimWrite = 'ok' | 'stale' | 'taken';

export interface HostnameClaimStore {
  create(claim: HostnameClaim): Promise<'ok' | 'taken'>;
  get(tenant: string, id: string): Promise<HostnameClaim | undefined>;
  list(tenant: string): Promise<HostnameClaim[]>;
  find(id: string): Promise<HostnameClaim | undefined>;
  inStates(states: readonly HostnameClaimState[], limit: number): Promise<HostnameClaim[]>;
  holder(hostname: string): Promise<HostnameClaim | undefined>;
  update(next: HostnameClaim): Promise<ClaimWrite>;
}

export interface HostTarget {
  fqdn?: string;
  verificationId?: string;
  staticIp?: string;
}

const targetLabel = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const isTargetName = (value: string) =>
  value.length <= 253 &&
  value.split('.').length >= 2 &&
  value.split('.').every((l) => targetLabel.test(l));

export const hostTargetFrom = (env: Record<string, string | undefined>): HostTarget => {
  const fqdn = env.GENAI_ASSISTANT_HOST_FQDN?.trim().toLowerCase();
  const verificationId = env.GENAI_ASSISTANT_HOST_VERIFICATION_ID?.trim();
  const staticIp = env.GENAI_ASSISTANT_HOST_STATIC_IP?.trim();
  return {
    ...(fqdn && isTargetName(fqdn) ? { fqdn } : {}),
    ...(verificationId && /^[A-Za-z0-9]{16,128}$/.test(verificationId) ? { verificationId } : {}),
    ...(staticIp && /^\d{1,3}(?:\.\d{1,3}){3}$/.test(staticIp) ? { staticIp } : {}),
  };
};

export const bindingRetryMs = 48 * 3600_000;
export const pendingExpiryMs = 7 * 24 * 3600_000;
export const lapseAfterMs = 7 * 24 * 3600_000;
export const removeLapsedAfterMs = 30 * 24 * 3600_000;

const held = (state: HostnameClaimState) => heldClaimStates.includes(state);

export class InMemoryHostnameClaims implements HostnameClaimStore {
  readonly #claims = new Map<string, HostnameClaim>();

  #taken(claim: HostnameClaim) {
    return (
      held(claim.state) &&
      [...this.#claims.values()].some(
        (c) => c.id !== claim.id && c.hostname === claim.hostname && held(c.state),
      )
    );
  }

  async create(claim: HostnameClaim) {
    if (this.#claims.has(claim.id)) throw new Error(`claim ${claim.id} exists`);
    if (this.#taken(claim)) return 'taken' as const;
    this.#claims.set(claim.id, structuredClone(claim));
    return 'ok' as const;
  }

  async get(tenant: string, id: string) {
    const found = this.#claims.get(id);
    return found?.tenant === tenant ? structuredClone(found) : undefined;
  }

  async list(tenant: string) {
    return [...this.#claims.values()]
      .filter((c) => c.tenant === tenant)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
      .map((c) => structuredClone(c));
  }

  async find(id: string) {
    const found = this.#claims.get(id);
    return found && structuredClone(found);
  }

  async inStates(states: readonly HostnameClaimState[], limit: number) {
    return [...this.#claims.values()]
      .filter((c) => states.includes(c.state))
      .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((c) => structuredClone(c));
  }

  async holder(hostname: string) {
    const found = [...this.#claims.values()].find((c) => c.hostname === hostname && held(c.state));
    return found && structuredClone(found);
  }

  async update(next: HostnameClaim) {
    const current = this.#claims.get(next.id);
    if (!current || current.tenant !== next.tenant || current.version !== next.version - 1)
      return 'stale' as const;
    if (this.#taken(next)) return 'taken' as const;
    this.#claims.set(next.id, structuredClone(next));
    return 'ok' as const;
  }
}
