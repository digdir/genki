import { text, type Language } from './i18n.js';

export interface Config {
  genkiUrl: string;
  apiBase: string;
  issuer: string;
  clientId: string;
  redirectUri: string;
  postLogoutRedirectUri: string;
  altinnResource: string;
  service?: string;
  language?: Language;
}

export interface Session {
  accessToken: string;
  idToken?: string;
  expiresAt: number;
  name?: string;
}

export interface Excerpt {
  chunk_id: string;
  text: string;
  heading?: string;
  page?: number;
  url?: string;
}

export interface Source {
  index?: number;
  title: string;
  url?: string;
  document_id?: string;
  excerpts: Excerpt[];
}

export interface Service {
  id: string;
  service: string;
  title: string;
  description?: string;
}

export interface Answer {
  text: string;
  sources: Source[];
  conversationId?: string;
  taskId?: string;
}

export type AnswerEvent =
  | { type: 'conversation'; conversationId: string }
  | { type: 'text'; text: string }
  | { type: 'retract' }
  | { type: 'sources'; sources: Source[] };

export interface Thread {
  id: string;
  topic: string;
  serviceId: string;
  created: number;
}

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  sources?: Source[];
  task?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

interface Store {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface Deps {
  fetch: typeof fetch;
  storage: Store;
  now?: () => number;
}

interface Discovery {
  authorization_endpoint: string;
  token_endpoint: string;
  end_session_endpoint?: string;
}

interface PendingLogin {
  state: string;
  nonce: string;
  verifier: string;
}

const sessionKey = (config: Config) => `${config.clientId}.session`;
const loginKey = (config: Config) => `${config.clientId}.login`;

const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '');

const randomString = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const codeChallenge = async (verifier: string) =>
  base64url(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))),
  );

export const decodeJwt = (token: string): Record<string, unknown> => {
  const part = (token.split('.')[1] ?? '').replaceAll('-', '+').replaceAll('_', '/');
  const bytes = Uint8Array.from(atob(part), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
};

export const viaProxy = (config: Config, url: string) =>
  url.startsWith(`${config.genkiUrl}/`)
    ? `${config.apiBase}${url.slice(config.genkiUrl.length)}`
    : url;

const discover = async (config: Config, deps: Deps): Promise<Discovery> => {
  const response = await deps.fetch(
    viaProxy(config, `${config.issuer}/.well-known/openid-configuration`),
  );
  if (!response.ok)
    throw new ApiError(response.status, undefined, text(config.language, 'loginUnavailable'));
  return (await response.json()) as Discovery;
};

export const loginUrl = async (config: Config, deps: Deps): Promise<string> => {
  const discovery = await discover(config, deps);
  const pending: PendingLogin = {
    state: randomString(),
    nonce: randomString(),
    verifier: randomString(),
  };
  deps.storage.setItem(loginKey(config), JSON.stringify(pending));
  const url = new URL(discovery.authorization_endpoint);
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    scope: 'openid profile',
    state: pending.state,
    nonce: pending.nonce,
    code_challenge: await codeChallenge(pending.verifier),
    code_challenge_method: 'S256',
    authorization_details: JSON.stringify([
      { type: 'ansattporten:altinn:resource', resource: config.altinnResource },
    ]),
    ui_locales: config.language ?? 'nb',
  }).toString();
  return url.toString();
};

export const finishLogin = async (config: Config, deps: Deps, callback: URL): Promise<Session> => {
  const pending = JSON.parse(
    deps.storage.getItem(loginKey(config)) ?? 'null',
  ) as PendingLogin | null;
  deps.storage.removeItem(loginKey(config));
  const code = callback.searchParams.get('code');
  if (!pending || !code || callback.searchParams.get('state') !== pending.state)
    throw new ApiError(400, 'login_state', text(config.language, 'loginFailed'));
  const discovery = await discover(config, deps);
  const response = await deps.fetch(viaProxy(config, discovery.token_endpoint), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirectUri,
      client_id: config.clientId,
      code_verifier: pending.verifier,
    }),
  });
  if (!response.ok)
    throw new ApiError(response.status, 'token', text(config.language, 'loginRefused'));
  const tokens = (await response.json()) as {
    access_token: string;
    id_token?: string;
    expires_in?: number;
  };
  const claims = tokens.id_token ? decodeJwt(tokens.id_token) : {};
  if (tokens.id_token && claims.nonce !== pending.nonce)
    throw new ApiError(400, 'login_nonce', text(config.language, 'loginFailed'));
  const now = deps.now?.() ?? Date.now();
  const session: Session = {
    accessToken: tokens.access_token,
    expiresAt: now + (tokens.expires_in ?? 300) * 1000,
    ...(tokens.id_token ? { idToken: tokens.id_token } : {}),
    ...(typeof claims.name === 'string' ? { name: claims.name } : {}),
  };
  deps.storage.setItem(sessionKey(config), JSON.stringify(session));
  return session;
};

export const currentSession = (config: Config, deps: Deps): Session | undefined => {
  const session = JSON.parse(deps.storage.getItem(sessionKey(config)) ?? 'null') as Session | null;
  if (!session || session.expiresAt <= (deps.now?.() ?? Date.now())) return undefined;
  return session;
};

export const forgetSession = (config: Config, deps: Deps) =>
  deps.storage.removeItem(sessionKey(config));

export const logoutUrl = async (config: Config, deps: Deps): Promise<string> => {
  const session = JSON.parse(deps.storage.getItem(sessionKey(config)) ?? 'null') as Session | null;
  deps.storage.removeItem(sessionKey(config));
  const discovery = await discover(config, deps);
  if (!discovery.end_session_endpoint) return config.postLogoutRedirectUri;
  const url = new URL(discovery.end_session_endpoint);
  url.search = new URLSearchParams({
    client_id: config.clientId,
    post_logout_redirect_uri: config.postLogoutRedirectUri,
    ...(session?.idToken ? { id_token_hint: session.idToken } : {}),
  }).toString();
  return url.toString();
};

export const citedIndexes = (text: string) => [
  ...new Set([...text.matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]))),
];

export const sourceFor = (sources: Source[], index: number) =>
  sources.find((s) => s.index === index);

const failure = async (config: Config, response: Response) => {
  const body = (await response.json().catch(() => ({}))) as {
    error?: { message?: string; code?: string } | string;
    code?: string;
    detail?: string;
    title?: string;
  };
  const nested = typeof body.error === 'object' ? body.error : undefined;
  return new ApiError(
    response.status,
    nested?.code ?? body.code,
    nested?.message ??
      body.detail ??
      body.title ??
      `${text(config.language, 'genkiFailed')} ${response.status}`,
  );
};

async function* dataFrames(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n', '\n');
    for (let end = buffer.indexOf('\n\n'); end >= 0; end = buffer.indexOf('\n\n')) {
      const data = buffer
        .slice(0, end)
        .split('\n')
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(end + 2);
      if (data) yield data;
    }
  }
}

export const genki = (config: Config, deps: Deps, token: () => string | undefined) => {
  const call = async (path: string, init: RequestInit = {}) => {
    const bearer = token();
    if (!bearer) throw new ApiError(401, 'signed_out', text(config.language, 'signedOut'));
    const response = await deps.fetch(`${config.apiBase}${path}`, {
      ...init,
      headers: {
        accept: 'application/json',
        'accept-language': config.language ?? 'nb',
        authorization: `Bearer ${bearer}`,
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (response.status === 401) forgetSession(config, deps);
    if (!response.ok) throw await failure(config, response);
    return response;
  };

  return {
    services: async (): Promise<Service[]> => {
      const { data } = (await (await call('/v1/models')).json()) as {
        data: (Service & {
          _default?: boolean;
          _service?: string;
          _service_title?: string;
          _alias_of?: string;
          status?: string;
        })[];
      };
      return data
        .filter((m) => m._default && !m._alias_of && m.status !== 'paused')
        .filter((m) => !config.service || m._service === config.service)
        .map((m) => ({
          id: m.id,
          service: m._service ?? m.id,
          title: m._service_title ?? m.title ?? m.id,
          ...(m.description ? { description: m.description } : {}),
        }));
    },

    ask: async (
      request: { model: string; question: string; conversationId?: string },
      onEvent: (event: AnswerEvent) => void = () => undefined,
    ): Promise<Answer> => {
      const response = await call('/v1/chat/completions', {
        method: 'POST',
        headers: { accept: 'text/event-stream' },
        body: JSON.stringify({
          model: request.model,
          messages: [{ role: 'user', content: request.question }],
          stream: true,
          genai_stream: 'live',
          ...(request.conversationId
            ? { conversation_id: request.conversationId }
            : { genai_conversation: true }),
        }),
      });
      const answer: Answer = { text: '', sources: [] };
      const taskId = response.headers.get('genai-task');
      if (taskId) answer.taskId = taskId;
      if (!response.body) return answer;
      for await (const data of dataFrames(response.body)) {
        if (data === '[DONE]') break;
        const frame = JSON.parse(data) as {
          conversation_id?: string;
          retract?: boolean;
          sources?: Source[];
          error?: { message?: string; code?: string };
          choices?: { delta?: { content?: string }; finish_reason?: string | null }[];
        };
        if (frame.conversation_id && !answer.conversationId) {
          answer.conversationId = frame.conversation_id;
          onEvent({ type: 'conversation', conversationId: frame.conversation_id });
        }
        if (frame.retract) {
          answer.text = '';
          onEvent({ type: 'retract' });
        }
        const content = frame.choices?.[0]?.delta?.content;
        if (content) {
          answer.text += content;
          onEvent({ type: 'text', text: content });
        }
        if (Array.isArray(frame.sources)) {
          answer.sources = frame.sources;
          onEvent({ type: 'sources', sources: frame.sources });
        }
        if (frame.choices?.[0]?.finish_reason === 'error')
          throw new ApiError(
            500,
            frame.error?.code,
            frame.error?.message ?? text(config.language, 'answerFailed'),
          );
      }
      return answer;
    },

    threads: async (): Promise<Thread[]> =>
      ((await (await call('/api/conversations')).json()) as { conversations: Thread[] })
        .conversations,

    thread: async (id: string): Promise<ThreadMessage[]> =>
      (
        (await (await call(`/api/conversations/${encodeURIComponent(id)}`)).json()) as {
          messages: ThreadMessage[];
        }
      ).messages,

    feedback: async (task: string, rating: 'up' | 'down') => {
      await call('/api/feedback', { method: 'POST', body: JSON.stringify({ task, rating }) });
    },
  };
};
