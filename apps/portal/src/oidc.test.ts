import { describe, expect, it, vi } from 'vitest';
import { ansattporten, codeChallenge, type AnsattportenOptions } from './oidc';

const issuer = 'http://localhost:8080/mock/ansattporten';
const resource = 'urn:altinn:resource:digdir-genai-platform';

const discovery = {
  issuer,
  authorization_endpoint: `${issuer}/authorize`,
  token_endpoint: `${issuer}/token`,
};

const jwt = (claims: Record<string, unknown>) =>
  `e30.${btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims))))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')}.sig`;

const memoryStorage = () => {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: (key: string, value: string) => void items.set(key, value),
    removeItem: (key: string) => void items.delete(key),
  };
};

const accessToken = jwt({
  exp: 4_000_000_000,
  authorization_details: [
    {
      type: 'ansattporten:altinn:resource',
      resource,
      authorized_parties: [
        {
          orgno: { authority: 'iso6523-actorid-upis', ID: '0192:405003309' },
          name: 'Testdepartementet',
          actions: ['read', 'write'],
          resource: 'digdir-genai-platform',
          unit_type: 'ORGL',
        },
      ],
    },
  ],
});

const renewedToken = jwt({
  exp: 4_000_003_600,
  authorization_details: [
    {
      type: 'ansattporten:altinn:resource',
      resource,
      authorized_parties: [
        { orgno: { ID: '0192:405003309' }, name: 'Testdepartementet', actions: ['read'] },
      ],
    },
  ],
});
let refreshable = 'refresh-1';

const setup = (overrides: Partial<AnsattportenOptions> = {}, start = 'http://localhost:5175/') => {
  const storage = memoryStorage();
  const requests: { url: string; init?: RequestInit | undefined }[] = [];
  const navigated: string[] = [];
  const replaced: string[] = [];
  let location = new URL(start);
  let nonce = '';
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/.well-known/openid-configuration')) return Response.json(discovery);
    if (url.endsWith('/token')) {
      const form = new URLSearchParams(String(init?.body));
      if (form.get('grant_type') === 'refresh_token')
        return form.get('refresh_token') === refreshable
          ? Response.json({
              access_token: renewedToken,
              refresh_token: 'refresh-2',
              token_type: 'Bearer',
            })
          : Response.json({ error: 'invalid_grant' }, { status: 400 });
      return Response.json({
        access_token: accessToken,
        id_token: jwt({ name: 'Ingrid Berg', nonce }),
        refresh_token: 'refresh-1',
        token_type: 'Bearer',
      });
    }
    return new Response('not found', { status: 404 });
  };
  const client = ansattporten({
    issuer,
    clientId: 'local-portal',
    redirectUri: 'http://localhost:5175/callback',
    audience: 'digdir:genai',
    altinnResource: resource,
    fetch,
    storage,
    location: () => location,
    navigate: (url) => navigated.push(url),
    replace: (url) => replaced.push(url),
    endpoint: (url) => url.replace(/^http:\/\/localhost:8080\//, '/api/'),
    ...overrides,
  });
  const returnFromAnsattporten = (params: Record<string, string>) => {
    const pending = JSON.parse(storage.getItem('local-portal.login') ?? '{}') as {
      state: string;
      nonce: string;
    };
    nonce = pending.nonce;
    location = new URL('http://localhost:5175/callback');
    for (const [k, v] of Object.entries({ state: pending.state, iss: issuer, ...params }))
      location.searchParams.set(k, v);
  };
  return { client, storage, requests, navigated, replaced, returnFromAnsattporten };
};

describe('login through Ansattporten', () => {
  it('redirects to the authorize endpoint with PKCE and the Altinn resource', async () => {
    const { client, storage, navigated, requests } = setup();

    void client.login();
    await vi.waitFor(() => expect(navigated).toHaveLength(1));

    expect(requests[0]?.url).toBe('/api/mock/ansattporten/.well-known/openid-configuration');
    const url = new URL(navigated[0] ?? '');
    expect(`${url.origin}${url.pathname}`).toBe(`${issuer}/authorize`);
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('local-portal');
    expect(q.get('redirect_uri')).toBe('http://localhost:5175/callback');
    expect(q.get('scope')).toBe('openid profile');
    expect(q.get('resource')).toBe('digdir:genai');
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(JSON.parse(q.get('authorization_details') ?? '')).toEqual([
      { type: 'ansattporten:altinn:resource', resource },
    ]);
    const pending = JSON.parse(storage.getItem('local-portal.login') ?? '{}') as {
      state: string;
      verifier: string;
    };
    expect(q.get('state')).toBe(pending.state);
    expect(q.get('code_challenge')).toBe(await codeChallenge(pending.verifier));
    expect(pending.verifier).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it('exchanges the code with the verifier and keeps the person and organisations', async () => {
    const { client, storage, requests, navigated, replaced, returnFromAnsattporten } = setup();
    void client.login();
    await vi.waitFor(() => expect(navigated).toHaveLength(1));
    const { verifier } = JSON.parse(storage.getItem('local-portal.login') ?? '{}') as {
      verifier: string;
    };
    returnFromAnsattporten({ code: 'abc' });

    expect(client.callbackPending()).toBe(true);
    const session = await client.login();

    const token = requests.find((r) => r.url === '/api/mock/ansattporten/token');
    const body = new URLSearchParams(String(token?.init?.body));
    expect(token?.init?.method).toBe('POST');
    expect(Object.fromEntries(body)).toEqual({
      grant_type: 'authorization_code',
      code: 'abc',
      redirect_uri: 'http://localhost:5175/callback',
      client_id: 'local-portal',
      code_verifier: verifier,
    });
    expect(session).toEqual({
      name: 'Ingrid Berg',
      organisations: [
        { orgNumber: '405003309', name: 'Testdepartementet', actions: ['read', 'write'] },
      ],
      token: accessToken,
    });
    expect(client.current()).toEqual(session);
    expect(replaced).toEqual(['/']);
    expect(storage.getItem('local-portal.login')).toBeNull();
  });

  it('renews the session silently with the refresh token the identity provider issued', async () => {
    refreshable = 'refresh-1';
    const { client, requests, navigated, returnFromAnsattporten } = setup();
    void client.login();
    await vi.waitFor(() => expect(navigated).toHaveLength(1));
    returnFromAnsattporten({ code: 'abc' });
    await client.login();
    expect(client.expiresAt()).toBe(4_000_000_000_000);

    const renewed = await client.refresh();

    const refresh = requests.filter((r) => r.url.endsWith('/token')).at(-1);
    expect(Object.fromEntries(new URLSearchParams(String(refresh?.init?.body)))).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'refresh-1',
      client_id: 'local-portal',
    });
    expect(renewed).toMatchObject({ name: 'Ingrid Berg', token: renewedToken });
    expect(client.current()?.token).toBe(renewedToken);
    expect(client.expiresAt()).toBe(4_000_003_600_000);
    refreshable = 'refresh-2';
    expect((await client.refresh())?.token).toBe(renewedToken);
  });

  it('keeps the session until it expires when the refresh token is refused', async () => {
    refreshable = 'none';
    const { client, navigated, returnFromAnsattporten } = setup();
    void client.login();
    await vi.waitFor(() => expect(navigated).toHaveLength(1));
    returnFromAnsattporten({ code: 'abc' });
    await client.login();

    expect(await client.refresh()).toBeUndefined();
    expect(client.current()?.token).toBe(accessToken);
  });

  it('returns to the page the login started from', async () => {
    const { client, navigated, replaced, returnFromAnsattporten } = setup(
      {},
      'http://localhost:5175/#/datasets?org=1',
    );
    void client.login();
    await vi.waitFor(() => expect(navigated).toHaveLength(1));
    returnFromAnsattporten({ code: 'abc' });
    await client.login().catch(() => undefined);
    expect(replaced).toEqual(['/#/datasets?org=1']);
  });

  it('refuses a callback whose state does not match', async () => {
    const { client, navigated, returnFromAnsattporten } = setup();
    void client.login();
    await vi.waitFor(() => expect(navigated).toHaveLength(1));
    returnFromAnsattporten({ code: 'abc', state: 'forged' });

    await expect(client.login()).rejects.toThrow(/state/);
    expect(client.current()).toBeUndefined();
  });

  it('reports an error returned by Ansattporten', async () => {
    const { client, navigated, returnFromAnsattporten } = setup();
    void client.login();
    await vi.waitFor(() => expect(navigated).toHaveLength(1));
    returnFromAnsattporten({ error: 'access_denied', error_description: 'ingen virksomhet' });

    await expect(client.login()).rejects.toThrow('ingen virksomhet');
  });

  it('logs out by forgetting the session', async () => {
    const { client, navigated, returnFromAnsattporten } = setup();
    void client.login();
    await vi.waitFor(() => expect(navigated).toHaveLength(1));
    returnFromAnsattporten({ code: 'abc' });
    await client.login();

    await client.logout();

    expect(client.current()).toBeUndefined();
  });

  it('falls back to the dev login when the discovery document is unreachable', async () => {
    const fallbackSession = { name: 'Kari Testansatt', organisations: [], token: 'dev' };
    let loggedIn = false;
    const { client, navigated } = setup({
      fetch: () => Promise.reject(new TypeError('Failed to fetch')),
      fallback: {
        current: () => (loggedIn ? fallbackSession : undefined),
        login: async () => {
          loggedIn = true;
          return fallbackSession;
        },
        logout: async () => {
          loggedIn = false;
        },
      },
    });

    await expect(client.login()).resolves.toBe(fallbackSession);
    expect(navigated).toEqual([]);
    expect(client.current()).toBe(fallbackSession);
    await client.logout();
    expect(client.current()).toBeUndefined();
  });
});
