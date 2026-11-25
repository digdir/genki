import react from '@vitejs/plugin-react';
import { bffProxy, ownLocalhost } from '../../scripts/vite-bff';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), ownLocalhost('workspace')],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5176,
    proxy: bffProxy(
      `http://localhost:${process.env.GENAI_API_PORT ?? 8080}`,
      process.env.GENAI_PROXY_KEY,
    ),
  },
});
