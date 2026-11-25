import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { bffProxy, ownLocalhost } from '../../scripts/vite-bff';
import { defaultClientConditions, defineConfig, type Plugin } from 'vite';
import { atlasScriptFile, separateAtlasScript } from './src/atlas-page';

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
    const page = separateAtlasScript(readFileSync(atlasPath, 'utf8'));
    this.emitFile({ type: 'asset', fileName: 'system-atlas.html', source: page.html });
    this.emitFile({ type: 'asset', fileName: atlasScriptFile, source: page.script });
  },
});

export default defineConfig({
  plugins: [react(), ownLocalhost('console'), systemAtlas()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5174,
    proxy: bffProxy(
      `http://localhost:${process.env.GENAI_API_PORT ?? 8080}`,
      process.env.GENAI_PROXY_KEY,
    ),
  },
});
