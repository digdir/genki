import {
  createMockAnsattporten,
  createSigningKey,
  remoteJwks,
  type IdentityTestDataInput,
  type TrustedEntra,
  type TrustedIssuer,
} from '@genai/identity';
import { createLocalJWKSet } from 'jose';
import { isDevMode } from './boot-guard.js';

type Env = Record<string, string | undefined>;
type RegisteredClients = NonNullable<
  Extract<TrustedIssuer, { kind: 'ansattporten' }>['registeredClients']
>;

export interface LoginIssuerOptions {
  env: Env;
  port: number;
  audience: string;
  testData: IdentityTestDataInput;
  registeredClients: RegisteredClients;
  trustedEntra?: TrustedEntra;
  fetch?: typeof fetch;
  onKeysNotFetched?: (fields: {
    issuer: string;
    uri: string;
    status?: number;
    error?: string;
  }) => void;
}

const watchedFetch =
  (
    fields: { issuer: string; uri: string },
    fetchFn: typeof fetch,
    report: LoginIssuerOptions['onKeysNotFetched'],
  ): typeof fetch =>
  async (input, init) => {
    try {
      const response = await fetchFn(input, init);
      if (!response.ok) report?.({ ...fields, status: response.status });
      return response;
    } catch (error) {
      report?.({ ...fields, error: String(error) });
      throw error;
    }
  };

export const loginIssuers = async ({
  env,
  port,
  audience,
  testData,
  registeredClients,
  trustedEntra,
  fetch: fetchFn = fetch,
  onKeysNotFetched,
}: LoginIssuerOptions) => {
  const keysOf = (issuer: string, uri: string) =>
    remoteJwks(uri, watchedFetch({ issuer, uri }, fetchFn, onKeysNotFetched));
  const trusted: TrustedIssuer[] = [];
  if (env.ANSATTPORTEN_ISSUER) {
    trusted.push({
      kind: 'ansattporten',
      issuer: env.ANSATTPORTEN_ISSUER,
      audience,
      keys: keysOf(
        env.ANSATTPORTEN_ISSUER,
        env.ANSATTPORTEN_JWKS_URI ?? `${env.ANSATTPORTEN_ISSUER}/jwks.json`,
      ),
      registeredClients,
      ...(trustedEntra ? { trustedEntra } : {}),
    });
  }
  if (env.MASKINPORTEN_ISSUER && env.MASKINPORTEN_JWKS_URI) {
    trusted.push({
      kind: 'maskinporten',
      issuer: env.MASKINPORTEN_ISSUER,
      audience,
      keys: keysOf(env.MASKINPORTEN_ISSUER, env.MASKINPORTEN_JWKS_URI),
      ...(env.MASKINPORTEN_REQUIRED_SCOPE
        ? { requiredScopes: env.MASKINPORTEN_REQUIRED_SCOPE.split(/[ ,]+/).filter(Boolean) }
        : {}),
    });
  }
  if (trusted.length > 0 || !isDevMode(env)) return { trusted };
  const key = await createSigningKey();
  const issuer = `http://localhost:${port}/mock/ansattporten`;
  const mock = createMockAnsattporten({ issuer, key, testData });
  trusted.push({
    kind: 'ansattporten',
    issuer,
    audience,
    keys: createLocalJWKSet({ keys: [key.publicJwk] }),
    registeredClients,
    ...(trustedEntra ? { trustedEntra } : {}),
  });
  return { trusted, mock, mockIssuer: issuer };
};
