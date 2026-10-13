import type { SecretResolver } from '@genai/kernel';

export const tenantSecretPattern = /^secret:\/\/tenant\/(\d{9})\/([a-z0-9][a-z0-9._-]*)$/;

export const secretTenant = (ref: string) => tenantSecretPattern.exec(ref)?.[1];

export class SecretNamespaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretNamespaceError';
  }
}

export const assertTenantSecret = (ref: string, tenant: string) => {
  const owner = secretTenant(ref);
  if (!owner) throw new SecretNamespaceError('a tool secret is secret://tenant/<orgnr>/<name>');
  if (owner !== tenant)
    throw new SecretNamespaceError(`the secret belongs to another tenant than ${tenant}`);
};

export class TenantSecrets {
  constructor(private readonly resolver: SecretResolver) {}

  async resolveFor(tenant: string, ref: string): Promise<string> {
    assertTenantSecret(ref, tenant);
    return this.resolver.resolve(ref);
  }
}
