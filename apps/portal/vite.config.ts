import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.GENAI_API_PORT ?? 8080}`,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
    },
  },
});
