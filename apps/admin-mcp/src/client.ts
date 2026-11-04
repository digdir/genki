export interface Problem {
  type?: string;
  title?: string;
  detail?: string;
  status?: number;
  code?: string;
  runId?: string;
  errors?: { path?: string; message: string }[];
}

export class GenkiError extends Error {
  constructor(
    readonly status: number,
    readonly problem: Problem | undefined,
  ) {
    super(describeProblem(status, problem));
  }
}

export const describeProblem = (status: number, problem: Problem | undefined) => {
  const errors = (problem?.errors ?? []).map((e) =>
    e.path ? `${e.path}: ${e.message}` : e.message,
  );
  const head = problem?.detail ?? problem?.title ?? 'The request failed';
  const extra = [problem?.code, problem?.runId && `run ${problem.runId}`].filter(Boolean);
  return `${head}${errors.length ? `\n${errors.map((e) => `- ${e}`).join('\n')}` : ''} (HTTP ${status}${extra.length ? `, ${extra.join(', ')}` : ''})`;
};

const loopback = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

export const isLoopback = (url: string) => loopback.has(new URL(url).hostname);

export const requireSafeUrl = (name: string, url: string) => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`${name} is not a URL: ${url}`);
  }
  if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(url)))
    throw new Error(`${name} must use https unless it is on this machine: ${url}`);
  return url.replace(/\/+$/, '');
};

export const segment = (value: string) => {
  if (!/^[A-Za-z0-9][A-Za-z0-9._@:-]*$/.test(value) || value.includes('..'))
    throw new Error(`"${value}" is not a valid id`);
  return encodeURIComponent(value);
};

export interface RequestOptions {
  body?: unknown;
  reason?: string;
  query?: Record<string, string | number | undefined>;
}

export interface TokenSource {
  get(): Promise<string>;
  invalidate?(): void;
}

export interface GenkiClient {
  tenant: string;
  portal?: string;
  request<T = unknown>(method: string, path: string, options?: RequestOptions): Promise<T>;
}

export interface ClientOptions {
  apiBase: string;
  tenant: string;
  token: TokenSource;
  portal?: string;
  fetch?: typeof fetch;
}

export const genkiClient = (options: ClientOptions): GenkiClient => {
  const send = options.fetch ?? fetch;
  const base = options.apiBase.replace(/\/+$/, '');
  const call = async (method: string, path: string, init: RequestOptions) => {
    if (!path.startsWith('/')) throw new Error(`refusing a path outside the API: ${path}`);
    const query = Object.entries(init.query ?? {}).flatMap(([k, v]) =>
      v === undefined ? [] : [[k, String(v)] as [string, string]],
    );
    return send(
      `${base}${path}${query.length ? `?${new URLSearchParams(query).toString()}` : ''}`,
      {
        method,
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${await options.token.get()}`,
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(init.reason ? { 'change-reason': encodeURIComponent(init.reason) } : {}),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      },
    );
  };
  return {
    tenant: options.tenant,
    ...(options.portal ? { portal: options.portal } : {}),
    request: async <T>(method: string, path: string, init: RequestOptions = {}) => {
      let response = await call(method, path, init);
      if (response.status === 401 && options.token.invalidate) {
        options.token.invalidate();
        response = await call(method, path, init);
      }
      const text = await response.text();
      let data: unknown;
      try {
        data = text ? JSON.parse(text) : undefined;
      } catch {
        data = text;
      }
      if (!response.ok)
        throw new GenkiError(
          response.status,
          typeof data === 'object' ? (data as Problem) : { detail: String(data ?? '') },
        );
      return data as T;
    },
  };
};

export const tenantPath = (tenant: string) => `/tenants/${segment(tenant)}`;
