import react from '@vitejs/plugin-react';
import { defaultClientConditions, defineConfig } from 'vite';

// Published with GitHub Pages at https://digdir.github.io/genki/, so every asset path starts there.
export default defineConfig({
  base: '/genki/',
  plugins: [react()],
  resolve: { conditions: ['source', ...defaultClientConditions] },
  build: { chunkSizeWarningLimit: 1000 },
  server: { port: 5180, open: false },
});
