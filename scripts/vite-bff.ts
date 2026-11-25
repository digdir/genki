// The portal, workspace and console in dev: /auth/ and /api/ go to the API's BFF the way nginx sends them.
import type { Plugin, ProxyOptions } from 'vite';

interface Incoming {
  headers: { host?: string };
  url?: string;
}
type ProxyReq = (
  request: { setHeader: (name: string, value: string) => void },
  incoming: Incoming,
) => void;

export const hostnameOf = (host: string | undefined) =>
  (host ?? '').replace(/:\d+$/, '').toLowerCase();

export const bffProxy = (
  api: string,
  proxyKey: string | undefined,
): Record<string, ProxyOptions> => {
  const forwarded = proxyKey
    ? {
        headers: { 'genai-proxy-key': proxyKey },
        configure: (proxy: { on: (event: 'proxyReq', handler: ProxyReq) => void }) =>
          proxy.on('proxyReq', (request, incoming) =>
            request.setHeader('x-forwarded-host', hostnameOf(incoming.headers.host)),
          ),
      }
    : {};
  return {
    '/api': { target: api, rewrite: (p) => p.replace(/^\/api/, ''), ...forwarded },
    ...(proxyKey ? { '/auth/': { target: api, rewrite: (p) => `/bff${p}`, ...forwarded } } : {}),
  };
};

/** Sends a page asked for on plain `localhost` to the app's own `<app>.localhost`, where its session cookie lives. */
export const ownLocalhost = (app: string): Plugin => ({
  name: 'own-localhost',
  configureServer(server) {
    server.middlewares.use((req: Incoming, res, next) => {
      const url = req.url ?? '/';
      if (hostnameOf(req.headers.host) !== 'localhost' || url.startsWith('/auth/')) return next();
      const port = /:(\d+)$/.exec(req.headers.host ?? '')?.[1];
      res.statusCode = 302;
      res.setHeader('location', `http://${app}.localhost${port ? `:${port}` : ''}${url}`);
      res.end();
    });
  },
});
