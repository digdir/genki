import type { MiddlewareHandler } from 'hono';
import { t } from './i18n/index.js';

export const keepsOwnErrorShape = (path: string) =>
  path === '/v1' ||
  path.startsWith('/v1/') ||
  path === '/a2a' ||
  path.startsWith('/a2a/') ||
  path === '/api/mcp';

const statusTitles = {
  400: 'problems.status400',
  401: 'problems.status401',
  403: 'problems.status403',
  404: 'problems.status404',
  405: 'problems.status405',
  409: 'problems.status409',
  413: 'problems.status413',
  415: 'problems.status415',
  422: 'problems.status422',
  429: 'problems.status429',
  502: 'problems.status502',
  503: 'problems.status503',
  504: 'problems.status504',
} as const;

const statusTitle = (status: number) =>
  t(
    statusTitles[status as keyof typeof statusTitles] ??
      (status >= 500 ? 'problems.status500' : 'problems.status400'),
  );

const text = (value: unknown) => (typeof value === 'string' && value.trim() ? value : undefined);

export const titleOf = (body: Record<string, unknown>, status: number) => {
  const error = body.error as { message?: unknown } | string | undefined;
  return (
    text(body.title) ??
    text(error) ??
    (error && typeof error === 'object' ? text(error.message) : undefined) ??
    text(body.message) ??
    statusTitle(status)
  );
};

const isProblem = (body: Record<string, unknown>) =>
  typeof body.type === 'string' &&
  typeof body.title === 'string' &&
  typeof body.status === 'number';

export const problemResponses: MiddlewareHandler = async (c, next) => {
  await next();
  const res = c.res;
  if (res.status < 400 || keepsOwnErrorShape(c.req.path)) return;
  const type = res.headers.get('content-type') ?? '';
  if (/application\/problem\+json/.test(type)) return;
  const body = /application\/json/.test(type)
    ? ((await res
        .clone()
        .json()
        .catch(() => undefined)) as unknown)
    : undefined;
  if (body !== undefined && (typeof body !== 'object' || body === null || Array.isArray(body)))
    return;
  const fields = (body ?? {}) as Record<string, unknown>;
  if ('jsonrpc' in fields) return;
  const headers = new Headers(res.headers);
  headers.set('content-type', 'application/problem+json');
  headers.delete('content-length');
  const problem = isProblem(fields)
    ? fields
    : {
        ...fields,
        type: text(fields.type) ?? 'about:blank',
        title: titleOf(fields, res.status),
        status: res.status,
      };
  c.res = undefined;
  c.res = new Response(JSON.stringify(problem), { status: res.status, headers });
};
