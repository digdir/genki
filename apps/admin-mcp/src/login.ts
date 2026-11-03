import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { isLoopback, type TokenSource } from './client.js';

export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

export interface LoginOptions {
  issuer: string;
  clientId: string;
  audience: string;
  altinnResource: string;
  redirectUri: string;
  open: (url: string) => void;
  fetch?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
}

const base64url = (bytes: Buffer) => bytes.toString('base64url');
const randomString = () => base64url(randomBytes(32));
export const codeChallenge = (verifier: string) =>
  base64url(createHash('sha256').update(verifier).digest());

const discover = async (options: LoginOptions) => {
  const send = options.fetch ?? fetch;
  const issuer = options.issuer.replace(/\/+$/, '');
  const response = await send(`${issuer}/.well-known/openid-configuration`);
  if (!response.ok) throw new Error(`login discovery answered ${response.status}`);
  const discovery = (await response.json()) as Discovery;
  const origin = new URL(issuer).origin;
  for (const endpoint of [discovery.authorization_endpoint, discovery.token_endpoint])
    if (new URL(endpoint).origin !== origin)
      throw new Error(`the login provider points outside ${origin}: ${endpoint}`);
  return discovery;
};

const tokensFrom = (body: TokenResponse, now: number, previous?: Tokens): Tokens => {
  if (typeof body?.access_token !== 'string' || !body.access_token)
    throw new Error('the token endpoint gave no access token');
  const refreshToken = body.refresh_token ?? previous?.refreshToken;
  return {
    accessToken: body.access_token,
    ...(refreshToken ? { refreshToken } : {}),
    expiresAt: now + (body.expires_in ?? 300) * 1000,
  };
};

const exchange = async (
  options: LoginOptions,
  endpoint: string,
  form: Record<string, string>,
  previous?: Tokens,
) => {
  const send = options.fetch ?? fetch;
  const response = await send(endpoint, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ ...form, client_id: options.clientId }).toString(),
  });
  if (!response.ok) throw new Error(`the token endpoint answered ${response.status}`);
  return tokensFrom(
    (await response.json()) as TokenResponse,
    (options.now ?? Date.now)(),
    previous,
  );
};

const page = (text: string) =>
  `<!doctype html><meta charset="utf-8"><title>genki</title><p>${text}</p>`;

export const browserLogin = async (options: LoginOptions): Promise<Tokens> => {
  const discovery = await discover(options);
  const state = randomString();
  const verifier = randomString();
  const redirectUri = options.redirectUri;
  const callback = new URL(redirectUri);
  if (callback.protocol !== 'http:' || !isLoopback(redirectUri))
    throw new Error(`the login callback must be http on this machine: ${redirectUri}`);
  const port = Number(callback.port || 80);
  const hosts =
    callback.hostname === 'localhost'
      ? ['127.0.0.1', '::1']
      : [callback.hostname.replace(/^\[|\]$/g, '')];

  const authorize = new URL(discovery.authorization_endpoint);
  const query = authorize.searchParams;
  query.set('response_type', 'code');
  query.set('client_id', options.clientId);
  query.set('redirect_uri', redirectUri);
  query.set('scope', 'openid profile');
  query.set('state', state);
  query.set('code_challenge', codeChallenge(verifier));
  query.set('code_challenge_method', 'S256');
  query.set('resource', options.audience);
  query.set(
    'authorization_details',
    JSON.stringify([{ type: 'ansattporten:altinn:resource', resource: options.altinnResource }]),
  );

  const code = await new Promise<string>((resolve, reject) => {
    const handler = (request: IncomingMessage, response: ServerResponse) => {
      const url = new URL(request.url ?? '/', redirectUri);
      const reply = (status: number, text: string) =>
        response
          .writeHead(status, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'referrer-policy': 'no-referrer',
          })
          .end(page(text));
      if (url.pathname !== callback.pathname || url.searchParams.get('state') !== state) {
        reply(404, 'Denne siden hører ikke til en innlogging som pågår.');
        return;
      }
      const stop = () => {
        clearTimeout(timer);
        close();
      };
      const error = url.searchParams.get('error');
      const received = url.searchParams.get('code');
      if (error || !received) {
        reply(400, 'Innloggingen ble avbrutt.');
        stop();
        reject(new Error(`login failed: ${error ?? 'no code'}`));
        return;
      }
      reply(200, 'Du er logget inn i genki. Du kan lukke denne fanen.');
      stop();
      resolve(received);
    };
    const servers = hosts.map(() => createServer(handler));
    const close = () => {
      for (const server of servers) server.close();
    };
    const timer = setTimeout(() => {
      close();
      reject(new Error('login timed out'));
    }, options.timeoutMs ?? 300_000);
    timer.unref();
    let listening = 0;
    servers.forEach((server, i) => {
      server.on('error', (error: NodeJS.ErrnoException) => {
        if (hosts[i] === '::1' && error.code === 'EADDRNOTAVAIL') {
          listening += 1;
          if (listening === servers.length) options.open(authorize.toString());
          return;
        }
        clearTimeout(timer);
        close();
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(
                `port ${port} is busy: stop what runs there (for example the console's dev server on 5174), or set ADMIN_MCP_REDIRECT_URI to another callback registered for the client`,
              )
            : error,
        );
      });
      server.listen(port, hosts[i], () => {
        listening += 1;
        if (listening === servers.length) options.open(authorize.toString());
      });
    });
  });

  return exchange(options, discovery.token_endpoint, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
};

export const refreshTokens = async (options: LoginOptions, previous: Tokens) => {
  if (!previous.refreshToken) return undefined;
  try {
    const discovery = await discover(options);
    return await exchange(
      options,
      discovery.token_endpoint,
      { grant_type: 'refresh_token', refresh_token: previous.refreshToken },
      previous,
    );
  } catch {
    return undefined;
  }
};

export const sessionToken = (options: LoginOptions): TokenSource => {
  let current: Tokens | undefined;
  let pending: Promise<Tokens> | undefined;
  const now = options.now ?? Date.now;
  const fresh = async () => {
    if (current && current.expiresAt - now() > 60_000) return current;
    const renewed = current && (await refreshTokens(options, current));
    return renewed ?? browserLogin(options);
  };
  return {
    get: async () => {
      pending ??= fresh().finally(() => {
        pending = undefined;
      });
      current = await pending;
      return current.accessToken;
    },
    invalidate: () => {
      if (current) current = { ...current, expiresAt: 0 };
    },
  };
};

export const devLoginSource = (apiBase: string, send: typeof fetch = fetch): TokenSource => {
  if (!isLoopback(apiBase))
    throw new Error('GENKI_DEV_LOGIN works only against a local API (localhost or 127.0.0.1)');
  let token: Promise<string> | undefined;
  const login = async () => {
    const response = await send(`${apiBase.replace(/\/+$/, '')}/mock/dev-login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ as: 'employee' }),
    });
    if (!response.ok)
      throw new Error(
        `dev login answered ${response.status}; it exists only on a local API in development mode`,
      );
    const body = (await response.json()) as { token?: string };
    if (!body.token) throw new Error('dev login gave no token');
    return body.token;
  };
  return {
    get: () => {
      token ??= login().catch((error: unknown) => {
        token = undefined;
        throw error;
      });
      return token;
    },
    invalidate: () => {
      token = undefined;
    },
  };
};
