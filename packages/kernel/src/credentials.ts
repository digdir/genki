import type { SecretResolver } from './secrets.js';

export type Credential =
  | { kind: 'api-key'; header?: string; key: () => Promise<string> }
  | { kind: 'bearer'; token: () => Promise<string> };

export type EndpointAuth =
  | { kind: 'api-key'; secret: string; header?: string | undefined }
  | { kind: 'bearer'; secret: string }
  | { kind: 'token-provider'; provider: string };

export type TokenProviders = Record<string, () => Promise<string>>;

export const credentialFor = (
  auth: EndpointAuth,
  secrets: SecretResolver,
  tokenProviders: TokenProviders = {},
): Credential => {
  if (auth.kind === 'api-key') {
    return {
      kind: 'api-key',
      key: () => secrets.resolve(auth.secret),
      ...(auth.header ? { header: auth.header } : {}),
    };
  }
  if (auth.kind === 'bearer') return { kind: 'bearer', token: () => secrets.resolve(auth.secret) };
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
