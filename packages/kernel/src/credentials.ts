import type { SecretResolver } from './secrets.js';

export type Credential =
  | { kind: 'api-key'; header?: string; key: () => Promise<string> }
  | { kind: 'bearer'; token: () => Promise<string> };

export type EndpointAuth =
  | { kind: 'api-key'; secret: string; header?: string | undefined }
  | { kind: 'bearer'; secret: string }
  | { kind: 'token-provider'; provider: string };

export type TokenProviders = Record<string, () => Promise<string>>;

export class SecretHostError extends Error {
  constructor(readonly origin: string) {
    super(`the secret is not set for ${origin}`);
    this.name = 'SecretHostError';
  }
}

const boundSecret = async (secrets: SecretResolver, ref: string, target?: string) => {
  const hosts = target ? await secrets.hostsFor?.(ref) : undefined;
  if (hosts && target) {
    const origin = new URL(target).origin;
    if (!hosts.includes(origin)) throw new SecretHostError(origin);
  }
  return secrets.resolve(ref);
};

export const credentialFor = (
  auth: EndpointAuth,
  secrets: SecretResolver,
  tokenProviders: TokenProviders = {},
  target?: string,
): Credential => {
  if (auth.kind === 'api-key') {
    return {
      kind: 'api-key',
      key: () => boundSecret(secrets, auth.secret, target),
      ...(auth.header ? { header: auth.header } : {}),
    };
  }
  if (auth.kind === 'bearer')
    return { kind: 'bearer', token: () => boundSecret(secrets, auth.secret, target) };
  const provider = tokenProviders[auth.provider];
  if (!provider) throw new Error(`unknown token provider ${auth.provider}`);
  return { kind: 'bearer', token: provider };
};

export const authHeaders = async (
  credential: Credential,
  nativeKeyHeader: string,
): Promise<Record<string, string>> => {
  if (credential.kind === 'bearer') return { authorization: `Bearer ${await credential.token()}` };
  const header = (credential.header ?? nativeKeyHeader).toLowerCase();
  const key = await credential.key();
  return header === 'authorization' ? { authorization: `Bearer ${key}` } : { [header]: key };
};

export const authenticatedFetch =
  (
    credential: Credential,
    nativeKeyHeader: string,
    sdkAuthHeaders: string[],
    base: typeof fetch = fetch,
  ): typeof fetch =>
  async (input, init) => {
    const headers = new Headers(init?.headers);
    for (const name of sdkAuthHeaders) headers.delete(name);
    for (const [name, value] of Object.entries(await authHeaders(credential, nativeKeyHeader)))
      headers.set(name, value);
    return base(input, { ...init, headers });
  };
