import { describe, expect, it } from 'vitest';
import { createApp } from '../app.js';

const app = createApp('test');

const fetchText = async (path: string) => {
  const res = await app.request(path);
  return { res, body: await res.text() };
};

describe('GET /reference', () => {
  it('serves the page as html, the module as javascript and the stylesheet as css', async () => {
    const page = await fetchText('/reference');
    const script = await fetchText('/reference/app.js');
    const styles = await fetchText('/reference/app.css');
    expect([page.res.status, script.res.status, styles.res.status]).toEqual([200, 200, 200]);
    expect(page.res.headers.get('content-type')).toMatch(/^text\/html/);
    expect(script.res.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(styles.res.headers.get('content-type')).toMatch(/^text\/css/);
    expect(page.body).toContain('<script type="module" src="reference/app.js"></script>');
    expect(page.body).toContain('<link rel="stylesheet" href="reference/app.css" />');
    expect(script.body).toContain("new URL('../openapi.json', import.meta.url)");
  });

  it('works under the api content security policy: no inline script, handler or style', async () => {
    const { res, body } = await fetchText('/reference');
    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("script-src-attr 'none'");
    const scripts = [...body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    expect(scripts.length).toBeGreaterThan(0);
    for (const [, attrs, inner] of scripts) {
      expect(attrs).toMatch(/\ssrc="reference\/[^"]+"/);
      expect((inner ?? '').trim()).toBe('');
    }
    expect(body).not.toMatch(/\son[a-z]+\s*=/i);
    expect(body).not.toMatch(/\sstyle\s*=/i);
    expect(body).not.toMatch(/<style\b/i);
    expect(body).not.toMatch(/javascript:/i);
  });

  it('builds the page with the dom, never with eval, inline handlers or html strings', async () => {
    const { body } = await fetchText('/reference/app.js');
    expect(body).not.toMatch(/\beval\s*\(|new Function|innerHTML|outerHTML|insertAdjacentHTML/);
    expect(body).not.toMatch(/setAttribute\(\s*['"](on|style)/);
  });

  it('is listed in the openapi document under platform', async () => {
    const doc = (await (await app.request('/openapi.json')).json()) as {
      paths: Record<string, { get?: { tags?: string[] } }>;
    };
    for (const path of ['/reference', '/reference/app.js', '/reference/app.css'])
      expect(doc.paths[path]?.get?.tags).toEqual(['Platform']);
  });
});
