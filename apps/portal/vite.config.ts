import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: {
    cssCodeSplit: false,
    rolldownOptions: {
      output: { codeSplitting: { groups: [{ name: 'styles', test: /\.css$/ }] } },
    },
  },
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
