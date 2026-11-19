import type { SecretResolver } from '@genai/kernel';
import { tenantSecretPattern } from '@genai/providers-mcp-client';

export interface TenantSecretStore {
  set(tenant: string, name: string, value: string, hosts?: readonly string[]): Promise<void>;
  get(tenant: string, name: string): Promise<string | undefined>;
  hosts(tenant: string, name: string): Promise<string[] | undefined>;
  setHosts(tenant: string, name: string, hosts: readonly string[]): Promise<boolean>;
  list(tenant: string): Promise<string[]>;
  delete(tenant: string, name: string): Promise<void>;
}

const catalogSecretPattern = /^secret:\/\/tenant-(\d{9})\/([a-z0-9][a-z0-9._-]*)$/;

export const maxSecretHosts = 20;

export const tenantSecretNamePattern = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const maxTenantSecretBytes = 16_384;
export const maxTenantSecrets = 200;

export const secretBytes = (value: string) => Buffer.byteLength(value, 'utf8');

const storedSecretNamePattern = /^[a-z0-9][a-z0-9._-]{0,254}$/;
const secretOwnerPattern = /^(?:\d{9}|platform)$/;

export type SecretHostsResult = { ok: true; hosts: string[] } | { ok: false; invalid: string };

export const secretHosts = (input: unknown): SecretHostsResult => {
  if (!Array.isArray(input) || input.length === 0 || input.length > maxSecretHosts)
    return { ok: false, invalid: '' };
  const hosts = new Set<string>();
  for (const entry of input) {
    if (typeof entry !== 'string' || entry.length > 300) return { ok: false, invalid: '' };
    const text = entry.trim();
    const address = text.includes('://') ? text : `https://${text}`;
    if (!URL.canParse(address)) return { ok: false, invalid: text };
    const url = new URL(address);
    if (
      (url.protocol !== 'https:' && url.protocol !== 'http:') ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return { ok: false, invalid: text };
    hosts.add(url.origin);
  }
  return { ok: true, hosts: [...hosts].sort() };
};

export const sameHosts = (a: readonly string[] | undefined, b: readonly string[] | undefined) =>
  (a ?? []).length === (b ?? []).length && (a ?? []).every((host) => (b ?? []).includes(host));

export class InMemoryTenantSecrets implements TenantSecretStore {
  readonly #values = new Map<string, { value: string; hosts?: string[] }>();

  async set(tenant: string, name: string, value: string, hosts?: readonly string[]) {
    const key = `${tenant}/${name}`;
    const kept = hosts ? [...hosts] : this.#values.get(key)?.hosts;
    this.#values.set(key, { value, ...(kept ? { hosts: kept } : {}) });
  }

  async get(tenant: string, name: string) {
    return this.#values.get(`${tenant}/${name}`)?.value;
  }

  async hosts(tenant: string, name: string) {
    const hosts = this.#values.get(`${tenant}/${name}`)?.hosts;
    return hosts && [...hosts];
  }

  async setHosts(tenant: string, name: string, hosts: readonly string[]) {
    const found = this.#values.get(`${tenant}/${name}`);
    if (!found) return false;
    found.hosts = [...hosts];
    return true;
  }

  async delete(tenant: string, name: string) {
    this.#values.delete(`${tenant}/${name}`);
  }

  async list(tenant: string) {
    const prefix = `${tenant}/`;
    return [...this.#values.keys()]
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length))
      .sort();
  }
}

export class TenantSecretVault {
  constructor(private readonly store: TenantSecretStore = new InMemoryTenantSecrets()) {}

  static ref(tenant: string, name: string) {
    return `secret://tenant/${tenant}/${name}`;
  }

  async set(
    tenant: string,
    name: string,
    value: string,
    hosts?: readonly string[],
  ): Promise<string> {
    if (!secretOwnerPattern.test(tenant)) throw new Error('invalid secret owner');
    if (!storedSecretNamePattern.test(name)) throw new Error('invalid secret name');
    if (secretBytes(value) > maxTenantSecretBytes) throw new Error('secret value too large');
    await this.store.set(tenant, name, value, hosts);
    return TenantSecretVault.ref(tenant, name);
  }

  hosts(tenant: string, name: string): Promise<string[] | undefined> {
    return this.store.hosts(tenant, name);
  }

  setHosts(tenant: string, name: string, hosts: readonly string[]): Promise<boolean> {
    return this.store.setHosts(tenant, name, hosts);
  }

  names(tenant: string): Promise<string[]> {
    return this.store.list(tenant);
  }

  delete(tenant: string, name: string): Promise<void> {
    return this.store.delete(tenant, name);
  }

  resolver(fallback: SecretResolver): SecretResolver {
    return {
      resolve: async (ref) => {
        const match =
          tenantSecretPattern.exec(ref) ??
          catalogSecretPattern.exec(ref) ??
          /^secret:\/\/(platform)\/([a-z0-9][a-z0-9._-]*)$/.exec(ref);
        const found = match ? await this.store.get(match[1] ?? '', match[2] ?? '') : undefined;
        return found ?? fallback.resolve(ref);
      },
      hostsFor: async (ref) => {
        const match = tenantSecretPattern.exec(ref) ?? catalogSecretPattern.exec(ref);
        if (!match) return fallback.hostsFor?.(ref);
        return (await this.store.hosts(match[1] ?? '', match[2] ?? '')) ?? [];
      },
    };
  }
}
