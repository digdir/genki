import { readFileSync } from 'node:fs';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

const api = `http://localhost:${process.env.GENAI_API_PORT ?? 8080}`;
const proxyKey = process.env.GENAI_PROXY_KEY;
const hostname = process.env.VITE_GENKI_HOST;
const bff =
  proxyKey && hostname ? { 'genai-proxy-key': proxyKey, 'x-forwarded-host': hostname } : undefined;
// A *.localhost name the browser asked for wins, so one dev server also serves the login host.
const forwardHost = {
  configure: (proxy: { on: (event: 'proxyReq', handler: ProxyReq) => void }) =>
    proxy.on('proxyReq', (request, incoming) => {
      const asked = (incoming.headers.host ?? '').split(':')[0] ?? '';
      if (asked.endsWith('.localhost')) request.setHeader('x-forwarded-host', asked);
    }),
};
type ProxyReq = (
  request: { setHeader: (name: string, value: string) => void },
  incoming: { headers: { host?: string } },
) => void;
const cert = process.env.ASSISTANT_TLS_CERT;
const key = process.env.ASSISTANT_TLS_KEY;

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5179,
    ...(cert && key ? { https: { cert: readFileSync(cert), key: readFileSync(key) } } : {}),
    proxy: {
      '/api': {
        target: api,
        rewrite: (p) => p.replace(/^\/api/, ''),
        ...(bff ? { headers: bff, ...forwardHost } : {}),
      },
      // As nginx does in the apps image: /auth/ goes to the API's BFF with the hostname and the proxy key.
      ...(bff
        ? {
            '/auth/': {
              target: api,
              rewrite: (p: string) => `/bff${p}`,
              headers: bff,
              ...forwardHost,
            },
          }
        : {}),
    },
  },
});
