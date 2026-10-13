import type { SecretResolver } from '@genai/kernel';
import { tenantSecretPattern } from '@genai/providers-mcp-client';

export interface TenantSecretStore {
  set(tenant: string, name: string, value: string): Promise<void>;
  get(tenant: string, name: string): Promise<string | undefined>;
  list(tenant: string): Promise<string[]>;
  delete(tenant: string, name: string): Promise<void>;
}

export class InMemoryTenantSecrets implements TenantSecretStore {
  readonly #values = new Map<string, string>();

  async set(tenant: string, name: string, value: string) {
    this.#values.set(`${tenant}/${name}`, value);
  }

  async get(tenant: string, name: string) {
    return this.#values.get(`${tenant}/${name}`);
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

  async set(tenant: string, name: string, value: string): Promise<string> {
    await this.store.set(tenant, name, value);
    return TenantSecretVault.ref(tenant, name);
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
          /^secret:\/\/tenant-(\d{9})\/([a-z0-9][a-z0-9._-]*)$/.exec(ref) ??
          /^secret:\/\/(platform)\/([a-z0-9][a-z0-9._-]*)$/.exec(ref);
        const found = match ? await this.store.get(match[1] ?? '', match[2] ?? '') : undefined;
        return found ?? fallback.resolve(ref);
      },
    };
  }
}
