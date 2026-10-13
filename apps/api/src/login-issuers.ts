import {
  createMockAnsattporten,
  createSigningKey,
  remoteJwks,
  type IdentityTestDataInput,
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
}

export const loginIssuers = async ({
  env,
  port,
  audience,
  testData,
  registeredClients,
}: LoginIssuerOptions) => {
  const trusted: TrustedIssuer[] = [];
  if (env.ANSATTPORTEN_ISSUER) {
    trusted.push({
      kind: 'ansattporten',
      issuer: env.ANSATTPORTEN_ISSUER,
      audience,
      keys: remoteJwks(env.ANSATTPORTEN_JWKS_URI ?? `${env.ANSATTPORTEN_ISSUER}/jwks.json`),
      registeredClients,
    });
  }
  if (env.MASKINPORTEN_ISSUER && env.MASKINPORTEN_JWKS_URI) {
    trusted.push({
      kind: 'maskinporten',
      issuer: env.MASKINPORTEN_ISSUER,
      audience,
      keys: remoteJwks(env.MASKINPORTEN_JWKS_URI),
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
  });
  return { trusted, mock };
};
