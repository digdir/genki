import { promisify } from 'node:util';
import { gzip } from 'node:zlib';
import type { Context, MiddlewareHandler } from 'hono';

const gzipAsync = promisify(gzip);

const policy = (formAction: boolean) =>
  [
    "default-src 'self'",
    "base-uri 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    ...(formAction ? ["form-action 'self'"] : []),
    "script-src 'self'",
    "script-src-attr 'none'",
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://altinncdn.no",
    "font-src 'self' data: https://cdn.jsdelivr.net https://altinncdn.no",
    "img-src 'self' data: blob:",
    "connect-src 'self'",
    "media-src 'self'",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
  ].join('; ');

export const contentSecurityPolicy = policy(true);
export const loginPagePolicy = policy(false);

const securedOverHttps = (c: Context) =>
  c.req.header('x-forwarded-proto')?.split(',')[0]?.trim() === 'https' ||
  new URL(c.req.url).protocol === 'https:';

const withHeaders = (c: Context, headers: Record<string, string>) => {
  try {
    for (const [name, value] of Object.entries(headers)) c.res.headers.set(name, value);
  } catch {
    const copy = new Headers(c.res.headers);
    for (const [name, value] of Object.entries(headers)) copy.set(name, value);
    const { body, status, statusText } = c.res;
    c.res = undefined;
    c.res = new Response(body, { status, statusText, headers: copy });
  }
};

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  withHeaders(c, {
    'Content-Security-Policy': c.req.path.startsWith('/mock/')
      ? loginPagePolicy
      : contentSecurityPolicy,
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    ...(securedOverHttps(c)
      ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' }
      : {}),
  });
};

const compressible =
  /^\s*(?:text\/(?!event-stream)[\w.+-]+|application\/(?![\w.+-]*ndjson)(?:[\w.+-]*json|javascript|xml|[\w.+-]*\+xml)|image\/svg\+xml)/i;

const acceptsGzip = (header: string | undefined) =>
  (header ?? '').split(',').some((part) => {
    const [coding, ...params] = part.trim().toLowerCase().split(';');
    if (coding !== 'gzip' && coding !== '*') return false;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith('q='));
    return q === undefined || Number(q.slice(2)) > 0;
  });

export const gzipResponses =
  (threshold = 1024): MiddlewareHandler =>
  async (c, next) => {
    await next();
    const res = c.res;
    if (!res.body || c.req.method === 'HEAD' || [204, 206, 304].includes(res.status)) return;
    if (res.headers.has('content-encoding') || res.headers.has('transfer-encoding')) return;
    if (!compressible.test(res.headers.get('content-type') ?? '')) return;
    if (/(?:^|,)\s*no-transform\s*(?:,|$)/i.test(res.headers.get('cache-control') ?? '')) return;
    const vary = res.headers.get('vary');
    const varied =
      vary === null
        ? 'Accept-Encoding'
        : /accept-encoding|\*/i.test(vary)
          ? vary
          : `${vary}, Accept-Encoding`;
    const declared = res.headers.get('content-length');
    if (declared !== null && Number(declared) < threshold) return;
    const raw = new Uint8Array(await res.clone().arrayBuffer());
    if (raw.byteLength < threshold) return;
    if (!acceptsGzip(c.req.header('accept-encoding'))) {
      withHeaders(c, { Vary: varied });
      return;
    }
    const headers = new Headers(res.headers);
    headers.set('Content-Encoding', 'gzip');
    headers.set('Vary', varied);
    headers.delete('Content-Length');
    const etag = headers.get('ETag');
    if (etag && !etag.startsWith('W/')) headers.set('ETag', `W/${etag}`);
    const { status, statusText } = res;
    c.res = undefined;
    c.res = new Response(new Uint8Array(await gzipAsync(raw)), { status, statusText, headers });
  };

export const apiNotFoundBody = { error: 'API endpoint not found' } as const;

export const isHeadlessRagApiPath = (path: string) =>
  path.startsWith('/api/') || path.startsWith('/v1/');
