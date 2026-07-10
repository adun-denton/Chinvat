import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Dev server proxies the hub's API + WebSocket so the SPA runs on :5173
// while the hub runs on :7777. In production the hub serves dist/ itself.
export default defineConfig({
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:7777',
      '/ws': { target: 'ws://127.0.0.1:7777', ws: true },
    },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
