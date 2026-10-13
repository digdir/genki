import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';

const atlasPath = fileURLToPath(
  new URL('../../docs/architecture/system-atlas.html', import.meta.url),
);

const systemAtlas = (): Plugin => ({
  name: 'system-atlas',
  configureServer(server) {
    server.middlewares.use('/system-atlas.html', (_req, res) => {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      res.end(readFileSync(atlasPath));
    });
  },
  generateBundle() {
    this.emitFile({
      type: 'asset',
      fileName: 'system-atlas.html',
      source: readFileSync(atlasPath),
    });
  },
});

export default defineConfig({
  plugins: [react(), systemAtlas()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5174,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.GENAI_API_PORT ?? 8080}`,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
