import { describe, expect, it } from 'vitest';
import { credentialFor, FederatedSignInError, type SecretResolver } from '@genai/kernel';
import { federatedAppTokens } from './federated.js';

const app = {
  clientId: '334f8fa1-437e-4b84-bceb-f320fb60f3ed',
  tenant: '11111111-2222-3333-4444-555555555555',
  scope: 'api://aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/.default',
};
const assertion = 'mi-assertion-not-a-real-token';
const start = Date.parse('2026-10-07T10:00:00Z');

const exchangeWith = (answer: () => Response) => {
  const calls: { url: string; body: URLSearchParams; headers: Headers }[] = [];
  const audiences: string[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({
      url: String(input),
      body: new URLSearchParams(String(init?.body)),
      headers: new Headers(init?.headers),
    });
    return answer();
  };
  return { calls, audiences, fetch };
};

const granted = (token: string, expiresIn = 3600) =>
  Response.json({ token_type: 'Bearer', access_token: token, expires_in: expiresIn });

describe('federated app sign-in', () => {
  it('exchanges the managed identity token at the resource tenant for a token with the scope', async () => {
    const seen = exchangeWith(() => granted('gateway-token'));
    const tokens = federatedAppTokens({
      assertion: async (scope) => {
        seen.audiences.push(scope);
        return { token: assertion };
      },
      fetch: seen.fetch,
      now: () => start,
    });

    expect(await tokens(app)()).toBe('gateway-token');
    expect(seen.audiences).toEqual(['api://AzureADTokenExchange/.default']);
    const [call] = seen.calls;
    expect(call?.url).toBe(`https://login.microsoftonline.com/${app.tenant}/oauth2/v2.0/token`);
    expect(call?.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(Object.fromEntries(call?.body ?? [])).toEqual({
      client_id: app.clientId,
      scope: app.scope,
      grant_type: 'client_credentials',
      client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer',
      client_assertion: assertion,
    });
  });

  it('reuses a token until five minutes before it expires', async () => {
    let now = start;
    let issued = 0;
    const seen = exchangeWith(() => granted(`token-${++issued}`));
    const token = federatedAppTokens({
      assertion: async () => ({ token: assertion }),
      fetch: seen.fetch,
      now: () => now,
    })(app);

    const first = await token();
    now = start + 54 * 60_000;
    const later = await token();
    now = start + 56 * 60_000;
    const renewed = await token();

    expect([first, later, renewed]).toEqual(['token-1', 'token-1', 'token-2']);
    expect(seen.calls).toHaveLength(2);
  });

  it('makes one exchange for calls that arrive while one is running', async () => {
    const seen = exchangeWith(() => granted('gateway-token'));
    const token = federatedAppTokens({
      assertion: async () => ({ token: assertion }),
      fetch: seen.fetch,
      now: () => start,
    })(app);

    await Promise.all([token(), token(), token()]);

    expect(seen.calls).toHaveLength(1);
  });

  it('a refused exchange names the app and the Entra error, never the assertion', async () => {
    const seen = exchangeWith(() =>
      Response.json(
        {
          error: 'invalid_client',
          error_description: `AADSTS700213: No matching federated identity record for ${assertion}`,
          error_codes: [700213],
        },
        { status: 401 },
      ),
    );
    const token = federatedAppTokens({
      assertion: async () => ({ token: assertion }),
      fetch: seen.fetch,
      now: () => start,
    })(app);

    const error = await token().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FederatedSignInError);
    expect((error as Error).message).toBe(
      `Entra ID refused the token exchange for app ${app.clientId} in tenant ${app.tenant}: invalid_client (AADSTS700213)`,
    );
    expect(JSON.stringify(error)).not.toContain(assertion);
    expect(String((error as Error).stack)).not.toContain(assertion);
  });

  it('tries the exchange again after a failure instead of keeping the failure', async () => {
    let refuse = true;
    const seen = exchangeWith(() =>
      refuse ? Response.json({ error: 'temporarily_unavailable' }, { status: 503 }) : granted('ok'),
    );
    const token = federatedAppTokens({
      assertion: async () => ({ token: assertion }),
      fetch: seen.fetch,
      now: () => start,
    })(app);

    await expect(token()).rejects.toThrow('temporarily_unavailable');
    refuse = false;

    expect(await token()).toBe('ok');
  });

  it('refuses a tenant that is not a GUID before any request is made', () => {
    const seen = exchangeWith(() => granted('never'));
    const tokens = federatedAppTokens({
      assertion: async () => ({ token: assertion }),
      fetch: seen.fetch,
    });

    expect(() => tokens({ ...app, tenant: 'evil.example/x?' })).toThrow(FederatedSignInError);
    expect(seen.calls).toHaveLength(0);
  });

  it('a federated-app connection sends its token as a bearer credential', async () => {
    const seen = exchangeWith(() => granted('gateway-token'));
    const tokens = federatedAppTokens({
      assertion: async () => ({ token: assertion }),
      fetch: seen.fetch,
      now: () => start,
    });
    const secrets: SecretResolver = { resolve: () => Promise.reject(new Error('no secrets')) };

    const credential = credentialFor(
      { kind: 'federated-app', ...app },
      secrets,
      {},
      'https://api.aivar.no/v1',
      tokens,
    );

    expect(credential.kind).toBe('bearer');
    expect(credential.kind === 'bearer' && (await credential.token())).toBe('gateway-token');
  });

  it('a federated-app connection without app sign-in set up fails with a clear error', async () => {
    const secrets: SecretResolver = { resolve: () => Promise.reject(new Error('no secrets')) };
    const credential = credentialFor({ kind: 'federated-app', ...app }, secrets);

    await expect(credential.kind === 'bearer' ? credential.token() : undefined).rejects.toThrow(
      'federated app sign-in is not set up in this process',
    );
  });
});
