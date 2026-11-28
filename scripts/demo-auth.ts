import { z } from 'zod';
import { secretFromKeyVault, vaultToken } from './demo-elevenlabs.ts';

export type RecorderAuth = () => Promise<Record<string, string>>;

export const keyAuth =
  (key: string): RecorderAuth =>
  async () => ({ 'x-recorder-key': key });

export const identityTokenUrl = (endpoint: string, resource: string, clientId?: string) => {
  const url = new URL(endpoint);
  url.searchParams.set('resource', resource);
  url.searchParams.set('api-version', '2019-08-01');
  if (clientId) url.searchParams.set('client_id', clientId);
  return url;
};

const identityAnswer = z.object({
  access_token: z.string().min(1).max(8192),
  expires_on: z.coerce.number().optional(),
});

export const identityAuth = (
  audience: string,
  env: NodeJS.ProcessEnv,
  send: typeof fetch = fetch,
  now: () => number = Date.now,
): RecorderAuth => {
  let held: { token: string; until: number } | undefined;
  return async () => {
    if (!held || held.until <= now()) {
      const res = await send(
        identityTokenUrl(env.IDENTITY_ENDPOINT ?? '', audience, env.AZURE_CLIENT_ID),
        {
          headers: { 'x-identity-header': env.IDENTITY_HEADER ?? '' },
          signal: AbortSignal.timeout(30_000),
        },
      );
      if (!res.ok) throw new Error(`The managed identity answered ${res.status}`);
      const answer = identityAnswer.parse(await res.json());
      held = {
        token: answer.access_token,
        until: (answer.expires_on ?? 0) * 1000 - 5 * 60_000,
      };
    }
    return { authorization: `Bearer ${held.token}` };
  };
};

export const recorderAuthOf = (
  env: NodeJS.ProcessEnv,
  send: typeof fetch = fetch,
): RecorderAuth | undefined => {
  if (env.DEMO_RECORDER_KEY) return keyAuth(env.DEMO_RECORDER_KEY);
  if (env.DEMO_RECORDER_AUDIENCE && env.IDENTITY_ENDPOINT)
    return identityAuth(env.DEMO_RECORDER_AUDIENCE, env, send);
  return undefined;
};

export const signInKeyOf = (
  env: NodeJS.ProcessEnv,
  token: () => Promise<string> = () => vaultToken(env),
  send: typeof fetch = fetch,
) => {
  let key: Promise<string> | undefined;
  return async () => {
    if (env.DEMO_API_KEY) return env.DEMO_API_KEY;
    const reference = env.DEMO_API_KEY_SECRET;
    if (!reference) return undefined;
    return (key ??= secretFromKeyVault(reference, token, send, {
      setting: 'DEMO_API_KEY_SECRET',
      what: 'the sign-in key',
    }).catch((error: unknown) => {
      key = undefined;
      throw error;
    }));
  };
};
