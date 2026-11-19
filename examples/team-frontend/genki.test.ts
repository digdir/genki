import { describe, expect, it } from 'vitest';
import {
  ApiError,
  codeChallenge,
  currentSession,
  finishLogin,
  genki,
  loginUrl,
  type Config,
  type Deps,
} from './genki.js';

const config: Config = {
  genkiUrl: 'http://localhost:8080',
  apiBase: '/genki',
  issuer: 'http://localhost:8080/mock/ansattporten',
  clientId: 'team-frontend',
  redirectUri: 'http://localhost:5195/callback',
  postLogoutRedirectUri: 'http://localhost:5195/',
  altinnResource: 'urn:altinn:resource:digdir-genai-platform',
  service: 'demo',
};

const now = () => Date.parse('2026-11-19T10:00:00Z');

const memory = () => {
  const items = new Map<string, string>();
  return {
    getItem: (k: string) => items.get(k) ?? null,
    setItem: (k: string, v: string) => void items.set(k, v),
    removeItem: (k: string) => void items.delete(k),
  };
};

const pendingLogin = (deps: Deps) =>
  JSON.parse(deps.storage.getItem('team-frontend.login') ?? '{}') as {
    state: string;
    verifier: string;
  };

const discovery = {
  authorization_endpoint: 'http://localhost:8080/mock/ansattporten/authorize',
  token_endpoint: 'http://localhost:8080/mock/ansattporten/token',
};

const jwt = (claims: Record<string, unknown>) =>
  `e30.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;

interface Call {
  url: string;
  init: RequestInit | undefined;
}

const fake = (answer: (url: string, init?: RequestInit) => Response) => {
  const calls: Call[] = [];
  const deps: Deps = {
    storage: memory(),
    now,
    fetch: async (input, init) => {
      const url = String(input);
      calls.push({ url, init });
      return answer(url, init);
    },
  };
  return { deps, calls };
};

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const sse = (frames: unknown[], headers: Record<string, string> = {}) =>
  new Response(
    [...frames.map((f) => `data: ${JSON.stringify(f)}\n\n`), 'data: [DONE]\n\n'].join(''),
    { headers: { 'content-type': 'text/event-stream', ...headers } },
  );

describe('login', () => {
  it('asks for the code flow with PKCE S256 and the Altinn resource', async () => {
    const { deps, calls } = fake(() => json(discovery));
    const url = new URL(await loginUrl(config, deps));
    const pending = pendingLogin(deps);
    expect(calls[0]?.url).toBe('/genki/mock/ansattporten/.well-known/openid-configuration');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toBe(await codeChallenge(pending.verifier));
    expect(url.searchParams.get('state')).toBe(pending.state);
    expect(JSON.parse(url.searchParams.get('authorization_details') ?? '')).toEqual([
      { type: 'ansattporten:altinn:resource', resource: config.altinnResource },
    ]);
  });

  it('refuses a callback whose state is not the one it sent', async () => {
    const { deps, calls } = fake(() => json(discovery));
    await loginUrl(config, deps);
    const callback = new URL('http://localhost:5195/callback?code=c1&state=forged');
    await expect(finishLogin(config, deps, callback)).rejects.toBeInstanceOf(ApiError);
    expect(calls.some((c) => c.url.endsWith('/token'))).toBe(false);
  });

  it('exchanges the code with its verifier and keeps the session in the given storage', async () => {
    let nonce = '';
    const { deps, calls } = fake((url) =>
      url.endsWith('/token')
        ? json({ access_token: 'at', id_token: jwt({ nonce, name: 'Kari' }), expires_in: 300 })
        : json(discovery),
    );
    const sent = new URL(await loginUrl(config, deps));
    nonce = sent.searchParams.get('nonce') ?? '';
    const pending = pendingLogin(deps);
    const callback = new URL(`http://localhost:5195/callback?code=c1&state=${pending.state}`);
    await finishLogin(config, deps, callback);
    const token = calls.find((c) => c.url === '/genki/mock/ansattporten/token');
    expect(new URLSearchParams(String(token?.init?.body)).get('code_verifier')).toBe(
      pending.verifier,
    );
    expect(currentSession(config, deps)).toMatchObject({ accessToken: 'at', name: 'Kari' });
  });

  it('refuses tokens whose nonce is not the one it sent', async () => {
    const { deps } = fake((url) =>
      url.endsWith('/token')
        ? json({ access_token: 'at', id_token: jwt({ nonce: 'other' }) })
        : json(discovery),
    );
    await loginUrl(config, deps);
    const pending = pendingLogin(deps);
    const callback = new URL(`http://localhost:5195/callback?code=c1&state=${pending.state}`);
    await expect(finishLogin(config, deps, callback)).rejects.toMatchObject({
      code: 'login_nonce',
    });
    expect(currentSession(config, deps)).toBeUndefined();
  });
});

describe('calling genki', () => {
  it('sends no request without a signed-in person', async () => {
    const { deps, calls } = fake(() => json({}));
    await expect(genki(config, deps, () => undefined).services()).rejects.toMatchObject({
      status: 401,
    });
    expect(calls).toHaveLength(0);
  });

  it('lists only the default entry of the configured service, skipping paused rows and aliases', async () => {
    const { deps, calls } = fake(() =>
      json({
        data: [
          { id: 'demo__default', _service: 'demo', _service_title: 'Demo', _default: true },
          { id: 'demo__mini', _service: 'demo', _default: false },
          { id: 'demo', _service: 'demo', _default: true, _alias_of: 'demo__default' },
          { id: 'other__default', _service: 'other', _default: true },
          { id: 'paused__default', _service: 'demo', _default: true, status: 'paused' },
        ],
      }),
    );
    const services = await genki(config, deps, () => 'at').services();
    expect(services).toEqual([{ id: 'demo__default', service: 'demo', title: 'Demo' }]);
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer at');
  });

  it('streams an answer, drops retracted text and returns its sources, thread and task', async () => {
    const { deps, calls } = fake(() =>
      sse(
        [
          { conversation_id: 'c-1', choices: [{ delta: { role: 'assistant' } }] },
          { choices: [{ delta: { content: 'Utkast' } }] },
          { choices: [{ delta: {} }], retract: true },
          { choices: [{ delta: { content: 'Svar [1]' } }] },
          { choices: [{ delta: {} }], sources: [{ index: 1, title: 'Kilde', excerpts: [] }] },
          { choices: [{ delta: {}, finish_reason: 'stop' }] },
        ],
        { 'genai-task': 't-1' },
      ),
    );
    const events: string[] = [];
    const answer = await genki(config, deps, () => 'at').ask(
      { model: 'demo__default', question: 'Hei' },
      (e) => events.push(e.type),
    );
    expect(answer).toEqual({
      text: 'Svar [1]',
      sources: [{ index: 1, title: 'Kilde', excerpts: [] }],
      conversationId: 'c-1',
      taskId: 't-1',
    });
    expect(events).toEqual(['conversation', 'text', 'retract', 'text', 'sources']);
    expect(JSON.parse(String(calls[0]?.init?.body))).toMatchObject({
      genai_conversation: true,
      stream: true,
      genai_stream: 'live',
    });
  });

  it('continues a thread by its id instead of starting a new one', async () => {
    const { deps, calls } = fake(() => sse([]));
    await genki(config, deps, () => 'at').ask({
      model: 'demo__default',
      question: 'Og så?',
      conversationId: 'c-1',
    });
    const body = JSON.parse(String(calls[0]?.init?.body));
    expect(body.conversation_id).toBe('c-1');
    expect(body.genai_conversation).toBeUndefined();
  });

  it('fails when the stream ends with an error frame', async () => {
    const { deps } = fake(() =>
      sse([
        {
          choices: [{ delta: {}, finish_reason: 'error' }],
          error: { message: 'boom', code: 'x' },
        },
      ]),
    );
    await expect(
      genki(config, deps, () => 'at').ask({ model: 'demo__default', question: 'Hei' }),
    ).rejects.toMatchObject({ code: 'x', message: 'boom' });
  });

  it('reports genki refusals with their status and code', async () => {
    const { deps } = fake(() => json({ error: { message: 'no access', code: 'forbidden' } }, 403));
    await expect(genki(config, deps, () => 'at').threads()).rejects.toMatchObject({
      status: 403,
      code: 'forbidden',
    });
  });

  it('forgets the stored session when genki refuses the token, so the page asks for a new login', async () => {
    const { deps } = fake(() => json({ error: { message: 'no', code: 'unauthorized' } }, 401));
    deps.storage.setItem(
      'team-frontend.session',
      JSON.stringify({ accessToken: 'at', expiresAt: now() + 60_000 }),
    );
    const platform = genki(config, deps, () => currentSession(config, deps)?.accessToken);
    await expect(platform.threads()).rejects.toMatchObject({ status: 401 });
    expect(currentSession(config, deps)).toBeUndefined();
  });

  it('asks genki and the login in the language the page uses', async () => {
    const english = { ...config, language: 'en' as const };
    const { deps, calls } = fake((url) =>
      url.includes('openid') ? json(discovery) : json({ data: [] }),
    );
    const login = new URL(await loginUrl(english, deps));
    await genki(english, deps, () => 'at').services();
    expect(login.searchParams.get('ui_locales')).toBe('en');
    expect(new Headers(calls.at(-1)?.init?.headers).get('accept-language')).toBe('en');
  });

  it('writes its own messages in the language the page uses', async () => {
    const { deps } = fake(() => json({}));
    await expect(
      genki({ ...config, language: 'en' }, deps, () => undefined).threads(),
    ).rejects.toThrow('Log in first.');
    await expect(genki(config, deps, () => undefined).threads()).rejects.toThrow('Logg inn først.');
  });
});
