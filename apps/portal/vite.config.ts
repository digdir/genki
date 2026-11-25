import react from '@vitejs/plugin-react';
import { bffProxy, ownLocalhost } from '../../scripts/vite-bff';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), ownLocalhost('portal')],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: {
    cssCodeSplit: false,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'styles', test: /\.css$/ }] } },
    },
  },
  server: {
    port: 5173,
    proxy: bffProxy(
      `http://localhost:${process.env.GENAI_API_PORT ?? 8080}`,
      process.env.GENAI_PROXY_KEY,
    ),
  },
});
