import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { '/api': { target: 'http://127.0.0.1:3030', changeOrigin: false } },
  },
  // Source maps ship with the bundle: the a11y and diff panels are far easier to debug from a
  // real stack trace than from a minified one.
  build: { outDir: 'dist', emptyOutDir: true, sourcemap: true },
});
