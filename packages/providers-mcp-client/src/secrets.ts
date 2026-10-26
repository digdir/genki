import type { SecretResolver } from '@genai/kernel';
import { EgressError } from './egress.js';
import type { Connection } from './registry.js';

export const tenantSecretPattern = /^secret:\/\/tenant\/(\d{9})\/([a-z0-9][a-z0-9._-]*)$/;

export const secretTenant = (ref: string) => tenantSecretPattern.exec(ref)?.[1];

export class SecretNamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretNamespaceError';
  }
}

export class SecretBindingError extends EgressError {
  constructor(readonly outside: string[]) {
    super('not_allowed', `the secret is not set for ${outside.join(', ') || 'this address'}`);
    this.name = 'SecretBindingError';
  }
}

export const assertTenantSecret = (ref: string, tenant: string) => {
  const owner = secretTenant(ref);
  if (!owner) throw new SecretNamespaceError('a tool secret is secret://tenant/<orgnr>/<name>');
  if (owner !== tenant)
    throw new SecretNamespaceError(`the secret belongs to another tenant than ${tenant}`);
};

export const originOf = (address: string) => new URL(address).origin;

export const secretTargets = (connection: Connection): string[] =>
  connection.auth
    ? [
        connection.endpoint,
        ...(connection.documentUrl ? [connection.documentUrl] : []),
        ...(connection.auth.kind === 'oauth-client-credentials' ? [connection.auth.tokenUrl] : []),
      ]
    : [];

export class TenantSecrets {
  constructor(private readonly resolver: SecretResolver) {}

  async outside(tenant: string, ref: string, targets: readonly string[]): Promise<string[]> {
    assertTenantSecret(ref, tenant);
    const hosts = (await this.resolver.hostsFor?.(ref)) ?? [];
    return [...new Set(targets.map(originOf))].filter((origin) => !hosts.includes(origin));
  }

  async resolveFor(tenant: string, ref: string, targets: readonly string[]): Promise<string> {
    if (targets.length === 0) throw new SecretBindingError([]);
    const outside = await this.outside(tenant, ref, targets);
    if (outside.length > 0) throw new SecretBindingError(outside);
    return this.resolver.resolve(ref);
  }
}
