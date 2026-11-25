import {
  InMemoryDefinitionStore,
  type PluginSchemas,
  type PublishedVersion,
} from '@genai/definitions';
import { describe, expect, it } from 'vitest';
import { sha256Of } from './block-bundles.js';
import { bundleText, codeBlock } from './block-code.test-utils.js';
import { blockRuntimePath } from './block-frame-runtime.js';
import { createBlockFrames } from './block-frames.js';
import {
  blockFrameUrl,
  blockOriginFrom,
  blockPortFrom,
  frameAncestorsFrom,
} from './block-origin.js';
import { digdir } from './testkit.js';

const plugins: PluginSchemas = {
  strategies: new Map(),
  tools: new Map(),
  guardrails: new Map(),
  blocks: new Set(),
  models: new Map(),
};

const origin = 'https://blocks.example.test';
const host = 'blocks.example.test';
const hash = sha256Of(bundleText);
const ancestors = ['https://klarsprak.example.no', 'https://portal.genki.digdir.cloud'];

const setup = async (title = 'Figur') => {
  const store = new InMemoryDefinitionStore(plugins);
  const saved = await store.publish(
    codeBlock(digdir, bundleText, { title: { nb: title } }),
    'employee:test:kari',
    'første utgave',
    { 'block/bundle.js': bundleText },
  );
  if (!saved.ok) throw new Error(JSON.stringify(saved.errors));
  const app = createBlockFrames({ origin, store, frameAncestors: ancestors });
  const get = (path: string, headers: Record<string, string> = {}) =>
    app.request(`${origin}${path}`, { headers: { host, ...headers } });
  return { store, get };
};

const framePath = (sha = hash, version = 1) => `/frame/${digdir}/figur/${version}/${sha}`;
const bundlePath = (sha = hash) => `/bundle/${digdir}/figur/1/${sha}.js`;

describe('the block origin', () => {
  it('serves a frame only for a saved edition whose sha256 matches the address', async () => {
    const { get } = await setup();

    expect((await get(framePath())).status).toBe(200);
    expect((await get(framePath('0'.repeat(64)))).status).toBe(404);
    expect((await get(framePath(hash, 2))).status).toBe(404);
    expect((await get(`/frame/${digdir}/annen/1/${hash}`)).status).toBe(404);
    expect((await get(framePath('../../etc'))).status).toBe(404);
    expect((await get(bundlePath('0'.repeat(64)))).status).toBe(404);
  });

  it('refuses a bundle whose stored bytes no longer match the hash in its address', async () => {
    const { store } = await setup();
    const found = (await store.get('Block', digdir, 'figur', 1)) as PublishedVersion;
    const tampered = {
      get: async () => ({ ...found, files: { 'block/bundle.js': `${bundleText}fetch('x')` } }),
    };
    const app = createBlockFrames({ origin, store: tampered, frameAncestors: ancestors });

    for (const path of [framePath(), bundlePath()])
      expect((await app.request(`${origin}${path}`, { headers: { host } })).status).toBe(404);
  });

  it('serves the frame with a CSP that allows no network and sandboxes its scripts', async () => {
    const { get } = await setup();

    const csp = (await get(framePath())).headers.get('content-security-policy') ?? '';
    const directives = Object.fromEntries(
      csp.split('; ').map((d) => [d.split(' ')[0], d.split(' ').slice(1).join(' ')]),
    );

    expect(directives).toMatchObject({
      'default-src': "'none'",
      'script-src': `${origin}${blockRuntimePath} ${origin}${bundlePath()}`,
      'connect-src': "'none'",
      webrtc: "'block'",
      'img-src': 'data:',
      'font-src': "'none'",
      'frame-src': "'none'",
      'worker-src': "'none'",
      'form-action': "'none'",
      'base-uri': "'none'",
      sandbox: 'allow-scripts',
    });
    expect(csp).not.toMatch(
      /allow-same-origin|allow-top-navigation|allow-popups|allow-forms|allow-modals/,
    );
  });

  it('switches off every powerful feature in the frame and sends no referrer', async () => {
    const { get } = await setup();
    const response = await get(framePath());

    expect(response.headers.get('permissions-policy')).toContain('camera=()');
    expect(response.headers.get('permissions-policy')).toContain('geolocation=()');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('lets only the service hostnames and the portal frame a block', async () => {
    const { get } = await setup();
    const csp = (await get(framePath())).headers.get('content-security-policy') ?? '';

    expect(csp).toContain(`frame-ancestors ${ancestors.join(' ')};`);
    expect(
      frameAncestorsFrom(
        { GENAI_BLOCK_FRAME_ANCESTORS: 'https://portal.genki.digdir.cloud' },
        {
          hostnames: new Map([['klarsprak.example.no', digdir]]),
          reservedDomains: [],
          assistantHostname: 'assistant.genki.digdir.cloud',
        },
      ),
    ).toEqual([
      'https://klarsprak.example.no',
      'https://assistant.genki.digdir.cloud',
      'https://*.apps.genki.digdir.cloud',
      'https://portal.genki.digdir.cloud',
    ]);
  });

  it("lets only the assigned names in genki's own zone frame a block, not the other environment's", () => {
    const rules = (assistantHostname?: string) => ({
      hostnames: new Map(),
      reservedDomains: [],
      ...(assistantHostname ? { assistantHostname } : {}),
    });

    expect(frameAncestorsFrom({}, rules('assistant.genki-test.digdir.cloud'))).toEqual([
      'https://assistant.genki-test.digdir.cloud',
      'https://*.apps.genki-test.digdir.cloud',
    ]);
    expect(frameAncestorsFrom({}, rules())).toEqual([
      'https://*.apps.genki.digdir.cloud',
      'https://*.apps.genki-test.digdir.cloud',
    ]);
  });

  it('refuses a page allowed to frame blocks that is not an https origin, outside dev mode', () => {
    const rules = { hostnames: new Map(), reservedDomains: [] };

    for (const value of ['http://portal.example.test', 'https://portal.example.test/x'])
      expect(() => frameAncestorsFrom({ GENAI_BLOCK_FRAME_ANCESTORS: value }, rules)).toThrow();
  });

  it('lets a local page frame a block only in dev mode', () => {
    const rules = { hostnames: new Map(), reservedDomains: [] };

    expect(frameAncestorsFrom({ GENAI_DEV_MODE: 'true' }, rules)).toContain('http://localhost:*');
    expect(frameAncestorsFrom({}, rules)).not.toContain('http://localhost:*');
  });

  it('answers only on the host of the block origin', async () => {
    const { get } = await setup();

    expect((await get(framePath(), { host: 'api.genki.digdir.cloud' })).status).toBe(404);
    expect((await get(blockRuntimePath, { host: 'localhost:8080' })).status).toBe(404);
    expect((await get(blockRuntimePath)).status).toBe(200);
  });

  it('serves nothing of the API and takes no writes', async () => {
    const { get } = await setup();
    const app = createBlockFrames({
      origin,
      store: { get: async () => undefined },
      frameAncestors: [],
    });

    expect((await get('/tenants/991825827/blocks')).status).toBe(404);
    expect((await get('/v1/models')).status).toBe(404);
    expect(
      (await app.request(`${origin}${blockRuntimePath}`, { method: 'POST', headers: { host } }))
        .status,
    ).toBe(404);
  });

  it('sets no cookie on the block origin and ignores any it is sent', async () => {
    const { get } = await setup();

    const plain = await get(framePath());
    const withCookie = await get(framePath(), { cookie: '__Host-genki=stjålet' });

    expect(plain.headers.get('set-cookie')).toBeNull();
    expect(withCookie.headers.get('set-cookie')).toBeNull();
    expect(await withCookie.text()).toBe(await plain.text());
  });

  it('serves the bundle as JavaScript that cannot be sniffed as anything else', async () => {
    const { get } = await setup();

    for (const path of [bundlePath(), blockRuntimePath]) {
      const response = await get(path);
      expect(response.headers.get('content-type')).toBe('text/javascript; charset=utf-8');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
      expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
    }
    expect(await (await get(bundlePath())).text()).toBe(bundleText);
  });

  it('caches a bundle for good, since its address holds the hash, and revalidates the frame, whose ancestors follow the settings', async () => {
    const { get } = await setup();

    expect((await get(bundlePath())).headers.get('cache-control')).toBe(
      'public, max-age=31536000, immutable',
    );
    expect((await get(framePath())).headers.get('cache-control')).toBe('no-cache');
  });

  it("writes the block's title into the frame page as text", async () => {
    const { get } = await setup('</title><script>alert(1)</script>');

    const page = await (await get(framePath())).text();

    expect(page).toContain('&lt;/title&gt;&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(page.match(/<script/g)).toHaveLength(2);
  });
});

describe('the block origin setting', () => {
  it('keeps code blocks off without a block origin', () => {
    expect(blockOriginFrom({})).toBeUndefined();
    expect(
      blockFrameUrl(undefined)({ publisher: digdir, id: 'figur', version: 1, sha256: hash }),
    ).toBeUndefined();
  });

  it('refuses a block origin that is not https, outside dev mode on localhost', () => {
    expect(blockOriginFrom({ GENAI_BLOCK_ORIGIN: 'https://blocks.example.test' })).toBe(origin);
    expect(
      blockOriginFrom({ GENAI_BLOCK_ORIGIN: 'http://localhost:8090', GENAI_DEV_MODE: 'true' }),
    ).toBe('http://localhost:8090');
    expect(() => blockOriginFrom({ GENAI_BLOCK_ORIGIN: 'http://localhost:8090' })).toThrow();
    expect(() => blockOriginFrom({ GENAI_BLOCK_ORIGIN: 'http://blocks.example.test' })).toThrow();
    expect(() =>
      blockOriginFrom({ GENAI_BLOCK_ORIGIN: 'https://blocks.example.test/x' }),
    ).toThrow();
  });

  it("refuses a block origin on the same site as genki or under a service's hostname", () => {
    for (const value of [
      'https://blocks.digdir.cloud',
      'https://digdir.cloud',
      'https://blocks.genki.digdir.cloud',
      'https://blocks.apps.genki-test.digdir.cloud',
      'https://figur.klarsprak.example.no',
    ])
      expect(() =>
        blockOriginFrom({
          GENAI_BLOCK_ORIGIN: value,
          GENAI_HOSTED_HOSTNAMES: `klarsprak.example.no=${digdir}`,
        }),
      ).toThrow();
  });

  it('refuses a block port that is not a port number', () => {
    expect(blockPortFrom({})).toBe(8090);
    for (const value of ['0', '70000', 'blokk', '80.5'])
      expect(() => blockPortFrom({ GENAI_BLOCK_PORT: value })).toThrow();
  });
});
