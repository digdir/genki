import { gunzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { contentSecurityPolicy } from './hardening.js';

const app = createApp('test');
app.get('/big', (c) => c.json({ text: 'x'.repeat(4000) }));
app.get('/small', (c) => c.json({ text: 'x'.repeat(100) }));
app.get('/stream', () => {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${'y'.repeat(4000)}\n\n`));
      controller.close();
    },
  });
  return new Response(body, { headers: { 'content-type': 'text/event-stream; charset=utf-8' } });
});
app.get('/mock/ansattporten/login', (c) =>
  c.html('<form method="post" action="authorize"></form>'),
);

const gzipped = { 'accept-encoding': 'gzip, deflate, br' };

describe('security headers as headless-rag sends them', () => {
  it('sends CSP, X-Frame-Options, nosniff, Referrer-Policy and Permissions-Policy on every response', async () => {
    for (const path of ['/health', '/api/nothing-here', '/stream']) {
      const res = await app.request(path);
      expect(res.headers.get('content-security-policy')).toBe(contentSecurityPolicy);
      expect(res.headers.get('x-frame-options')).toBe('DENY');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('referrer-policy')).toBe('no-referrer');
      expect(res.headers.get('permissions-policy')).toContain('camera=()');
    }
  });

  it('keeps headless-rag CSP directives that forbid framing, plugins and inline script', () => {
    for (const directive of [
      "default-src 'self'",
      "frame-ancestors 'none'",
      "object-src 'none'",
      "script-src-attr 'none'",
      "form-action 'self'",
    ])
      expect(contentSecurityPolicy).toContain(directive);
  });

  it('sends HSTS only for requests that arrived over HTTPS', async () => {
    expect((await app.request('/health')).headers.get('strict-transport-security')).toBeNull();
    const secure = await app.request('/health', { headers: { 'x-forwarded-proto': 'https' } });
    expect(secure.headers.get('strict-transport-security')).toBe(
      'max-age=31536000; includeSubDomains',
    );
  });

  it('lets the mock login form redirect back to the portal by leaving out form-action', async () => {
    const res = await app.request('/mock/ansattporten/login');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain('form-action');
  });
});

describe('gzip as headless-rag compresses', () => {
  it('compresses a response over 1 KB when the client accepts gzip', async () => {
    const res = await app.request('/big', { headers: gzipped });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    expect(res.headers.get('vary')).toContain('Accept-Encoding');
    const body = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8')) as {
      text: string;
    };
    expect(body.text).toHaveLength(4000);
  });

  it('leaves a response under 1 KB uncompressed', async () => {
    const res = await app.request('/small', { headers: gzipped });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(((await res.json()) as { text: string }).text).toHaveLength(100);
  });

  it('never compresses server-sent events', async () => {
    const res = await app.request('/stream', { headers: gzipped });
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toContain('data: yyy');
  });

  it('does not compress for a client that does not accept gzip', async () => {
    const res = await app.request('/big', { headers: { 'accept-encoding': 'gzip;q=0' } });
    expect(res.headers.get('content-encoding')).toBeNull();
  });
});

describe('headless-rag health and not-found answers', () => {
  it('answers /up with ok, alongside /health', async () => {
    const res = await app.request('/up');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect((await app.request('/health')).status).toBe(200);
  });

  it('answers an unknown /v1 path with the bare headless-rag body', async () => {
    const res = await app.request('/v1/no-such-endpoint');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ error: 'API endpoint not found' });
  });

  it('answers an unknown /api path with a problem that keeps the headless-rag error text', async () => {
    const res = await app.request('/api/no-such-endpoint');
    const norwegian = await app.request('/api/no-such-endpoint', {
      headers: { 'accept-language': 'nb' },
    });
    expect(await norwegian.json()).toMatchObject({ error: 'API endpoint not found' });
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
    expect(await res.json()).toEqual({
      type: 'about:blank',
      title: 'Fant ikke',
      status: 404,
      error: 'API endpoint not found',
    });
  });

  it('keeps a problem document for unknown platform paths', async () => {
    const res = await app.request('/tenants-nothing');
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/problem+json');
  });
});
