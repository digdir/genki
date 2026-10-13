import {
  cachedAltinnAuthorization,
  createMockAltinnPdp,
  httpAltinnAuthorization,
  maskinportenTokens,
  type AltinnAuthorization,
  type IdentityTestDataInput,
} from '@genai/identity';
import type { JWK } from 'jose';
import { isDevMode } from './boot-guard.js';

export type AltinnPdpChoice =
  | {
      kind: 'mock';
      authorization: AltinnAuthorization;
      app: ReturnType<typeof createMockAltinnPdp>['app'];
    }
  | { kind: 'altinn'; authorization: AltinnAuthorization; baseURL: string };

export const altinnPdpSettings = [
  'ALTINN_PDP_URL',
  'ALTINN_SUBSCRIPTION_KEY',
  'ALTINN_PDP_MASKINPORTEN_CLIENT_ID',
  'ALTINN_PDP_MASKINPORTEN_KEY',
  'MASKINPORTEN_ISSUER',
] as const;

const privateKeyOf = (raw: string): JWK => {
  let key: JWK | undefined;
  try {
    key = JSON.parse(raw) as JWK;
  } catch {
    key = undefined;
  }
  if (!key?.kty || !key.d)
    throw new Error('ALTINN_PDP_MASKINPORTEN_KEY must be a private JWK in JSON');
  return key;
};

export const altinnPdpFrom = (
  env: Record<string, string | undefined>,
  testData: IdentityTestDataInput,
  fetchFn: typeof fetch = fetch,
): AltinnPdpChoice => {
  if (!env.ALTINN_PDP_URL) {
    if (!isDevMode(env))
      throw new Error(
        'ALTINN_PDP_URL is not set; the mock Altinn rights run only with GENAI_DEV_MODE=true',
      );
    const mock = createMockAltinnPdp(testData);
    return { kind: 'mock', authorization: mock.authorization, app: mock.app };
  }
  const missing = altinnPdpSettings.filter((name) => !env[name]);
  if (missing.length > 0)
    throw new Error(`ALTINN_PDP_URL is set, but these are missing: ${missing.join(', ')}`);
  const baseURL = env.ALTINN_PDP_URL.replace(/\/+$/, '');
  if (!baseURL.startsWith('https://')) throw new Error('ALTINN_PDP_URL must use HTTPS');
  const tokens = maskinportenTokens({
    issuer: env.MASKINPORTEN_ISSUER as string,
    ...(env.MASKINPORTEN_TOKEN_URL ? { tokenEndpoint: env.MASKINPORTEN_TOKEN_URL } : {}),
    clientId: env.ALTINN_PDP_MASKINPORTEN_CLIENT_ID as string,
    scope: env.ALTINN_PDP_MASKINPORTEN_SCOPE ?? 'altinn:authorization/authorize',
    privateKey: privateKeyOf(env.ALTINN_PDP_MASKINPORTEN_KEY as string),
    fetch: fetchFn,
  });
  const subscriptionKey = env.ALTINN_SUBSCRIPTION_KEY as string;
  return {
    kind: 'altinn',
    baseURL,
    authorization: cachedAltinnAuthorization(
      httpAltinnAuthorization({
        baseURL,
        fetch: fetchFn,
        headers: async () => ({
          authorization: `Bearer ${await tokens.token()}`,
          'ocp-apim-subscription-key': subscriptionKey,
        }),
      }),
    ),
  };
};
