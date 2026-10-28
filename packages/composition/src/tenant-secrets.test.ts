import { credentialFor, SecretHostError } from '@genai/kernel';
import { describe, expect, it } from 'vitest';
import { InMemoryTenantSecrets, TenantSecretVault } from './tenant-secrets.js';

const tenant = '991825827';
const platformOnly = { resolve: async (ref: string) => `platform:${ref}` };

const keyOf = async (secret: string, baseURL: string) => {
  const vault = new TenantSecretVault(new InMemoryTenantSecrets());
  await vault.set(tenant, 'search-token', 'hemmelig', ['https://search.example.no']);
  await vault.set(tenant, 'unbound', 'uten-adresse');
  const credential = credentialFor(
    { kind: 'api-key', secret },
    vault.resolver(platformOnly),
    {},
    baseURL,
  );
  if (credential.kind !== 'api-key') throw new Error('expected an api-key credential');
  return credential.key();
};

describe('catalog endpoint secrets', () => {
  it('resolve only for an endpoint on a host the secret is set for', async () => {
    const ref = `secret://tenant-${tenant}/search-token`;
    await expect(keyOf(ref, 'https://search.example.no/collections')).resolves.toBe('hemmelig');
    await expect(keyOf(ref, 'https://other.example.no')).rejects.toBeInstanceOf(SecretHostError);
  });

  it('refuse a tenant secret that is not set for any host', async () => {
    await expect(
      keyOf(`secret://tenant-${tenant}/unbound`, 'https://search.example.no'),
    ).rejects.toBeInstanceOf(SecretHostError);
  });

  it('leave platform secrets to the operator who configured them', async () => {
    await expect(keyOf('secret://platform/search', 'https://search.example.no')).resolves.toBe(
      'platform:secret://platform/search',
    );
  });
});
