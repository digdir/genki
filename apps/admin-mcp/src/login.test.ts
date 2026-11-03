import { createServer } from 'node:http';
import { describe, expect, it } from 'vitest';
import { genkiClient, requireSafeUrl } from './client.js';
import {
  browserLogin,
  codeChallenge,
  devLoginSource,
  sessionToken,
  type LoginOptions,
} from './login.js';

const issuer = 'https://ansattporten.example';

const fakeProvider = (endpoints = issuer) => {
  const exchanges: URLSearchParams[] = [];
  let refreshes = 0;
  const fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith('/.well-known/openid-configuration'))
      return Response.json({
        authorization_endpoint: `${endpoints}/authorize`,
        token_endpoint: `${endpoints}/token`,
      });
    const form = new URLSearchParams(String(init?.body));
    exchanges.push(form);
    if (form.get('grant_type') === 'refresh_token') {
      refreshes += 1;
      return Response.json({ access_token: `refreshed-${refreshes}`, expires_in: 600 });
    }
    return Response.json({ access_token: 'person-token', refresh_token: 'r1', expires_in: 600 });
  }) as typeof globalThis.fetch;
  return { fetch, exchanges };
};

let port = 18765;

const options = (
  provider: ReturnType<typeof fakeProvider>,
  browser: (authorize: URL) => Promise<void> | void,
  extra: Partial<LoginOptions> = {},
): LoginOptions => {
  port += 1;
  return {
    issuer,
    clientId: 'genki-admin-mcp',
    audience: 'digdir:genai',
    altinnResource: 'urn:altinn:resource:digdir-genai-platform-test',
    redirectUri: `http://127.0.0.1:${port}/callback`,
    fetch: provider.fetch,
    timeoutMs: 5_000,
    open: (url) => {
      void browser(new URL(url));
    },
    ...extra,
  };
};

const callbackFor = (authorize: URL, params: Record<string, string>) => {
  const callback = new URL(authorize.searchParams.get('redirect_uri') ?? '');
  for (const [k, v] of Object.entries(params)) callback.searchParams.set(k, v);
  return callback.toString();
};

const approve = async (authorize: URL) => {
  await fetch(
    callbackFor(authorize, { code: 'the-code', state: authorize.searchParams.get('state') ?? '' }),
  );
};

describe('logging in through the browser', () => {
  it('asks for genki with PKCE and a 127.0.0.1 callback, and exchanges the code with the verifier', async () => {
    const provider = fakeProvider();
    let asked: URL | undefined;

    const tokens = await browserLogin(
      options(provider, (authorize) => {
        asked = authorize;
        return approve(authorize);
      }),
    );

    const query = asked?.searchParams;
    expect(query?.get('redirect_uri')).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
    expect(query?.get('resource')).toBe('digdir:genai');
    expect(query?.get('code_challenge_method')).toBe('S256');
    expect(query?.get('authorization_details')).toContain('digdir-genai-platform-test');
    const exchange = provider.exchanges[0];
    expect(exchange?.get('code')).toBe('the-code');
    expect(codeChallenge(exchange?.get('code_verifier') ?? '')).toBe(query?.get('code_challenge'));
    expect(tokens).toMatchObject({ accessToken: 'person-token', refreshToken: 'r1' });
  });

  it('listens on both loopback addresses when the registered callback says localhost', async () => {
    const provider = fakeProvider();
    port += 1;
    const own = port;
    const redirectUri = `http://localhost:${own}/callback`;

    const tokens = await browserLogin({
      ...options(provider, async (authorize) => {
        expect(authorize.searchParams.get('redirect_uri')).toBe(redirectUri);
        await fetch(
          `http://127.0.0.1:${own}/callback?code=the-code&state=${authorize.searchParams.get('state') ?? ''}`,
        );
      }),
      redirectUri,
    });

    expect(tokens.accessToken).toBe('person-token');
  });

  it('refuses a token response without an access token', async () => {
    const provider = fakeProvider();
    const empty = {
      ...provider,
      fetch: (async (url: string, init?: RequestInit) =>
        url.endsWith('/token')
          ? Response.json({ token_type: 'Bearer' })
          : provider.fetch(url, init)) as typeof fetch,
    };

    await expect(browserLogin(options(empty, approve))).rejects.toThrow('no access token');
  });

  it('refuses a callback that is not on this machine', async () => {
    await expect(
      browserLogin({ ...options(fakeProvider(), approve), redirectUri: 'https://evil.example/cb' }),
    ).rejects.toThrow(/this machine/);
  });

  it('ignores callbacks from another login and keeps waiting for its own', async () => {
    const provider = fakeProvider();

    const tokens = await browserLogin(
      options(provider, async (authorize) => {
        const stray = await fetch(callbackFor(authorize, { error: 'access_denied', state: 'x' }));
        expect(stray.status).toBe(404);
        await approve(authorize);
      }),
    );

    expect(tokens.accessToken).toBe('person-token');
    expect(provider.exchanges).toHaveLength(1);
  });

  it('refuses a login provider whose endpoints point to another host', async () => {
    const provider = fakeProvider('https://elsewhere.example');

    await expect(browserLogin(options(provider, approve))).rejects.toThrow(/points outside/);
  });

  it('says so when the callback port is busy', async () => {
    const provider = fakeProvider();
    const settings = options(provider, approve);
    const squatter = createServer().listen(Number(new URL(settings.redirectUri).port), '127.0.0.1');
    await new Promise((resolve) => squatter.once('listening', resolve));

    await expect(browserLogin(settings)).rejects.toThrow(/port \d+ is busy/);
    squatter.close();
  });

  it('keeps the token in memory, renews it with the refresh token, and logs in once for parallel calls', async () => {
    const provider = fakeProvider();
    let clock = 0;
    let logins = 0;
    const token = sessionToken(
      options(
        provider,
        (authorize) => {
          logins += 1;
          return approve(authorize);
        },
        { now: () => clock },
      ),
    );

    const [first, second] = await Promise.all([token.get(), token.get()]);
    clock = 10 * 60_000;
    const later = await token.get();
    token.invalidate?.();
    const renewed = await token.get();

    expect([first, second]).toEqual(['person-token', 'person-token']);
    expect(later).toBe('refreshed-1');
    expect(renewed).toBe('refreshed-2');
    expect(logins).toBe(1);
  });
});

describe('where tokens may go', () => {
  it('sends tokens only over https, except to this machine', () => {
    expect(requireSafeUrl('GENKI_API_BASE', 'https://api.genki-test.digdir.cloud/')).toBe(
      'https://api.genki-test.digdir.cloud',
    );
    expect(requireSafeUrl('GENKI_API_BASE', 'http://localhost:8080')).toBe('http://localhost:8080');
    expect(() => requireSafeUrl('GENKI_API_BASE', 'http://genki.example')).toThrow(/https/);
  });

  it('uses the development login only against a local API', () => {
    expect(() => devLoginSource('https://api.genki-test.digdir.cloud')).toThrow(/local API/);
  });

  it('gets a fresh token and retries once when the API says the token is no longer valid', async () => {
    let tokens = 0;
    let calls = 0;
    const client = genkiClient({
      apiBase: 'https://api.genki.test',
      tenant: '991825827',
      token: {
        get: async () => `t${tokens}`,
        invalidate: () => {
          tokens += 1;
        },
      },
      fetch: (async (_url: string, init?: RequestInit) => {
        calls += 1;
        const auth = new Headers(init?.headers).get('authorization');
        return auth === 'Bearer t1'
          ? Response.json({ ok: true })
          : new Response('{}', { status: 401 });
      }) as typeof fetch,
    });

    expect(await client.request('GET', '/me')).toEqual({ ok: true });
    expect(calls).toBe(2);
  });
});
