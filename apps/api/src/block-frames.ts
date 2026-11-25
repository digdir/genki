import { blockFilePaths, type BlockDefinition, type DefinitionStore } from '@genai/definitions';
import { Hono, type Context } from 'hono';
import { sha256Of } from './block-bundles.js';
import { blockRuntime, blockRuntimePath } from './block-frame-runtime.js';
import { editionPath } from './block-origin.js';

export interface BlockFramesOptions {
  origin: string;
  store: Pick<DefinitionStore, 'get'>;
  frameAncestors: readonly string[];
}

const sha = /^[a-f0-9]{64}$/;
const positive = /^[1-9][0-9]{0,8}$/;

const forever = 'public, max-age=31536000, immutable';

const permissionsOff = [
  'accelerometer',
  'autoplay',
  'camera',
  'clipboard-read',
  'clipboard-write',
  'display-capture',
  'fullscreen',
  'geolocation',
  'gyroscope',
  'magnetometer',
  'microphone',
  'midi',
  'payment',
  'publickey-credentials-get',
  'screen-wake-lock',
  'serial',
  'usb',
  'xr-spatial-tracking',
]
  .map((feature) => `${feature}=()`)
  .join(', ');

const escapeHtml = (text: string) =>
  text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch,
  );

const notFound = () =>
  new Response('Not found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'x-content-type-options': 'nosniff' },
  });

const scriptHeaders = (cache: string) => ({
  'content-type': 'text/javascript; charset=utf-8',
  'x-content-type-options': 'nosniff',
  'cross-origin-resource-policy': 'cross-origin',
  'referrer-policy': 'no-referrer',
  'cache-control': cache,
});

/** The block origin: frames, bundles and the runtime of code blocks, and nothing of the API. */
export const createBlockFrames = ({ origin, store, frameAncestors }: BlockFramesOptions) => {
  const app = new Hono();
  const host = new URL(origin).host;
  const runtimeUrl = `${origin}${blockRuntimePath}`;

  app.use('*', async (c, next) => {
    if ((c.req.header('host') ?? '').toLowerCase() !== host) return notFound();
    if (c.req.method !== 'GET' && c.req.method !== 'HEAD') return notFound();
    await next();
    c.res.headers.delete('set-cookie');
  });

  const edition = async (c: Context, hash: string) => {
    const { publisher = '', id = '', version = '' } = c.req.param();
    if (!positive.test(version) || !sha.test(hash)) return undefined;
    const found = await store.get('Block', publisher, id, Number(version));
    const spec = (found?.definition as BlockDefinition | undefined)?.spec;
    const bundle = found?.files[blockFilePaths.bundle];
    if (
      !found ||
      found.version !== Number(version) ||
      spec?.tier !== 'code' ||
      spec.code?.sha256 !== hash ||
      bundle === undefined ||
      sha256Of(bundle) !== hash
    )
      return undefined;
    return { publisher, id, version: found.version, spec, bundle };
  };

  app.get(blockRuntimePath, () => new Response(blockRuntime, { headers: scriptHeaders(forever) }));

  app.get('/bundle/:publisher/:id/:version/:file', async (c) => {
    const file = c.req.param('file');
    const found = file.endsWith('.js') ? await edition(c, file.slice(0, -3)) : undefined;
    if (!found) return notFound();
    return new Response(found.bundle, { headers: scriptHeaders(forever) });
  });

  app.get('/frame/:publisher/:id/:version/:sha256', async (c) => {
    const hash = c.req.param('sha256');
    const found = await edition(c, hash);
    if (!found) return notFound();
    const bundleUrl = `${origin}/bundle/${editionPath(found)}/${hash}.js`;
    const title = found.spec.title.nb ?? found.id;
    const csp = [
      "default-src 'none'",
      `script-src ${runtimeUrl} ${bundleUrl}`,
      "style-src 'unsafe-inline'",
      'img-src data:',
      "font-src 'none'",
      "connect-src 'none'",
      "webrtc 'block'",
      "media-src 'none'",
      "object-src 'none'",
      "frame-src 'none'",
      "worker-src 'none'",
      "manifest-src 'none'",
      "form-action 'none'",
      "base-uri 'none'",
      `frame-ancestors ${frameAncestors.length > 0 ? frameAncestors.join(' ') : "'none'"}`,
      'sandbox allow-scripts',
    ].join('; ');
    const page =
      `<!doctype html><html lang="nb"><meta charset="utf-8"><title>${escapeHtml(title)}</title>` +
      `<body><script src="${escapeHtml(runtimeUrl)}"></script>` +
      `<script src="${escapeHtml(bundleUrl)}"></script>`;
    return new Response(page, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': csp,
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'cross-origin-resource-policy': 'cross-origin',
        'permissions-policy': permissionsOff,
        'cache-control': 'no-cache',
      },
    });
  });

  app.notFound(() => notFound());
  return app;
};
