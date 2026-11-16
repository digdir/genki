import {
  federatedScopePattern,
  FederatedSignInError,
  guidPattern,
  type FederatedApp,
  type FederatedTokens,
} from '@genai/kernel';
import { z } from 'zod';

export const tokenExchangeAudience = 'api://AzureADTokenExchange/.default';

export type AssertionSource = (scope: string) => Promise<{ token: string } | null>;

export interface FederatedAppTokenOptions {
  assertion: AssertionSource;
  fetch?: typeof fetch;
  now?: () => number;
  authority?: string;
  timeoutMs?: number;
}

const refreshBeforeMs = 5 * 60_000;

const granted = z.object({
  access_token: z.string().min(1),
  expires_in: z.coerce.number().int().positive(),
});

const refused = z.object({
  error: z
    .string()
    .regex(/^[a-z_]{1,64}$/)
    .optional(),
  error_codes: z.array(z.number().int().nonnegative()).max(5).optional(),
});

const describeRefusal = (status: number, body: unknown) => {
  const found = refused.safeParse(body);
  const error = found.data?.error;
  const codes = (found.data?.error_codes ?? []).map((c) => `AADSTS${c}`).join(', ');
  return [error ?? `status ${status}`, codes ? `(${codes})` : ''].filter(Boolean).join(' ');
};

const checked = (app: FederatedApp) => {
  if (!guidPattern.test(app.clientId) || !guidPattern.test(app.tenant))
    throw new FederatedSignInError('the app client id and the tenant must be GUIDs');
  if (!federatedScopePattern.test(app.scope))
    throw new FederatedSignInError('the scope must end in /.default');
  return app;
};

/** Tokens for a multi-tenant app, got by exchanging a managed identity token as a client assertion. */
export const federatedAppTokens = (options: FederatedAppTokenOptions): FederatedTokens => {
  const fetchFn = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const authority = options.authority ?? 'https://login.microsoftonline.com';
  const timeoutMs = options.timeoutMs ?? 15_000;
  const cache = new Map<string, { token: string; expiresAt: number }>();
  const pending = new Map<string, Promise<string>>();

  const assertion = async () => {
    let token;
    try {
      token = await options.assertion(tokenExchangeAudience);
    } catch (error) {
      throw new FederatedSignInError(
        `no managed identity token for the exchange: ${error instanceof Error ? error.message : 'unknown error'}`,
      );
    }
    if (!token?.token) throw new FederatedSignInError('no managed identity token for the exchange');
    return token.token;
  };

  const exchange = async (app: FederatedApp, key: string) => {
    const signedBy = `app ${app.clientId} in tenant ${app.tenant}`;
    const body = new URLSearchParams({
      client_id: app.clientId,
      scope: app.scope,
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: await assertion(),
    });
    let response: Response;
    try {
      response = await fetchFn(`${authority}/${app.tenant}/oauth2/v2.0/token`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      throw new FederatedSignInError(
        `Entra ID did not answer the token exchange for ${signedBy}: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    const answer: unknown = await response.json().catch(() => undefined);
    if (!response.ok)
      throw new FederatedSignInError(
        `Entra ID refused the token exchange for ${signedBy}: ${describeRefusal(response.status, answer)}`,
      );
    const parsed = granted.safeParse(answer);
    if (!parsed.success)
      throw new FederatedSignInError(
        `Entra ID answered the exchange for ${signedBy} without a token`,
      );
    cache.set(key, {
      token: parsed.data.access_token,
      expiresAt: now() + parsed.data.expires_in * 1000,
    });
    return parsed.data.access_token;
  };

  return (given) => {
    const app = checked(given);
    const key = [app.clientId, app.tenant, app.scope].join('\u0000');
    return async () => {
      const current = cache.get(key);
      if (current && current.expiresAt - refreshBeforeMs > now()) return current.token;
      let running = pending.get(key);
      if (!running) {
        running = exchange(app, key).finally(() => pending.delete(key));
        pending.set(key, running);
      }
      return running;
    };
  };
};
